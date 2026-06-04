import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

async function withHarness(fn, options = {}) {
  const harness = await createCashflowTestHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

async function createConfirmedLedgerScenario(harness) {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      future_periods: 2,
      fx_provider: "manual",
      manual_fx_rates: {},
      fx_buffer_percent: 0
    }
  });

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Portable income",
      currency: "PLN",
      amount: 1000,
      type: "income",
      date: "2026-06-01"
    }
  });

  const snapshot = await harness.api("/api");
  const future = snapshot.futureTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(future);

  const moved = await harness.api(`/api/future/${encodeURIComponent(future.id)}/move-to-pending`, {
    method: "POST",
    body: {
      occurrenceKey: future.occurrence_key
    }
  });
  const pending = moved.pendingTransactions.find(tx => tx.occurrence_key === future.occurrence_key);
  assert.ok(pending);

  await harness.api(`/api/pending/${encodeURIComponent(pending.id)}/confirm`, {
    method: "POST",
    body: {
      amount: 1000,
      confirmed_date: "2026-06-01"
    }
  });

  return {
    oneOff,
    pending
  };
}

function backupCount(harness) {
  const db = harness.openPlanningDb();
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM backup_metadata WHERE success = 1").get().count;
  } finally {
    db.close();
  }
}

function insertLedgerCurrencyEvent(harness, id) {
  const db = harness.openPlanningDb();
  try {
    db.prepare(`
      INSERT INTO ledger_currency_events (
        id, old_currency, new_currency, old_balance, converted_opening_balance,
        fx_rate, rate_date, source, details, created_at
      ) VALUES (?, 'PLN', 'USD', 100, 25, 0.25, '2026-06-01', 'test', '{}', datetime('now'))
    `).run(id);
  } finally {
    db.close();
  }
}

function ledgerCurrencyEventIds(harness) {
  const db = harness.openPlanningDb();
  try {
    return db.prepare("SELECT id FROM ledger_currency_events ORDER BY id").all().map(row => row.id);
  } finally {
    db.close();
  }
}

test("full export includes functional planning data and confirmed ledger rows", async () => withHarness(async harness => {
  const { oneOff } = await createConfirmedLedgerScenario(harness);
  const exported = await harness.api("/api/export/full");

  assert.equal(exported.format, "cashflow-full-export");
  assert.equal(exported.version, 1);
  assert.equal(exported.planning.one_off_transactions.some(row => row.id === oneOff.id), true);
  assert.equal(Array.isArray(exported.planning.future_transactions), false);
  assert.equal(Array.isArray(exported.planning.backup_metadata), false);
  assert.equal(exported.ledgers["2026"].some(row => row.source_one_off_id === oneOff.id), true);
}));

test("full export omits operational settings by default and includes them by opt-in", async () => withHarness(async harness => {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      ntfy_url: "https://ntfy.example.com/cashflow-test",
      auto_backup_enabled: 1,
      backup_interval_minutes: 30,
      notify_income_missing: 0
    }
  });

  const defaultExport = await harness.api("/api/export/full");
  const defaultSettings = defaultExport.planning.settings[0];
  assert.equal(defaultExport.operationalSettingsIncluded, false);
  assert.equal(Object.prototype.hasOwnProperty.call(defaultSettings, "ntfy_url"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(defaultSettings, "auto_backup_enabled"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(defaultSettings, "notify_income_missing"), false);

  const optInExport = await harness.api("/api/export/full?includeOperationalSettings=1");
  const optInSettings = optInExport.planning.settings[0];
  assert.equal(optInExport.operationalSettingsIncluded, true);
  assert.equal(optInSettings.ntfy_url, "https://ntfy.example.com/cashflow-test");
  assert.equal(optInSettings.auto_backup_enabled, 1);
  assert.equal(optInSettings.notify_income_missing, 0);
}));

test("full replace import restores exported data and creates a safety backup", async () => withHarness(async harness => {
  const { oneOff } = await createConfirmedLedgerScenario(harness);
  const exported = await harness.api("/api/export/full");
  const beforeBackups = backupCount(harness);

  const extra = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Temporary extra",
      currency: "PLN",
      amount: 25,
      type: "expense",
      date: "2026-06-15"
    }
  });

  const imported = await harness.api("/api/import/full", {
    method: "POST",
    body: {
      mode: "replace",
      export: exported
    }
  });

  assert.equal(imported.import.ok, true);
  assert.equal(imported.import.mode, "replace");
  assert.equal(backupCount(harness), beforeBackups + 1);
  assert.equal(imported.oneOffs.some(row => row.id === oneOff.id), true);
  assert.equal(imported.oneOffs.some(row => row.id === extra.id), false);
  assert.equal(imported.confirmedTransactions.some(row => row.source_one_off_id === oneOff.id), true);
}));

test("full replace import rolls back after invalid imported data", async () => withHarness(async harness => {
  const { oneOff } = await createConfirmedLedgerScenario(harness);
  insertLedgerCurrencyEvent(harness, "event-before-failed-import");
  const exported = await harness.api("/api/export/full");
  exported.planning.ledger_currency_events = [];
  exported.planning.recurring_expenses.push({
    id: "bad-recurring",
    name: "Bad recurring",
    currency: "PLN",
    amount: 10,
    prediction_strategy: "fixed",
    prediction_substitute_missing: "none",
    prediction_min_recorded_months: 6,
    necessary: 1,
    active: 1,
    repeat_every_months: 1,
    start_month_year: "2026-01",
    anchor_type: "day_of_month",
    anchor_day_of_month: 1,
    anchor_offset_days: 0,
    anchor_business_day_adjustment: "none",
    anchor_holiday_country: "PL",
    planned_transaction_id: "missing-plan",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z"
  });

  const result = await harness.request("/api/import/full", {
    method: "POST",
    body: {
      mode: "replace",
      export: exported
    }
  });

  assert.equal(result.response.status, 400, JSON.stringify(result.body));
  const snapshot = await harness.api("/api");
  assert.equal(snapshot.oneOffs.some(row => row.id === oneOff.id), true);
  assert.equal(snapshot.confirmedTransactions.some(row => row.source_one_off_id === oneOff.id), true);
  assert.deepEqual(ledgerCurrencyEventIds(harness), ["event-before-failed-import"]);
}));

test("full import ignores operational settings by default and restores them by opt-in", async () => withHarness(async harness => {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      ntfy_url: "https://ntfy.example.com/exported",
      auto_backup_enabled: 1,
      notify_income_missing: 0
    }
  });
  const exported = await harness.api("/api/export/full?includeOperationalSettings=1");

  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      ntfy_url: "",
      auto_backup_enabled: 0,
      notify_income_missing: 1
    }
  });

  const defaultImport = await harness.api("/api/import/full", {
    method: "POST",
    body: {
      mode: "replace",
      export: exported
    }
  });
  assert.equal(defaultImport.settings.ntfy_url, null);
  assert.equal(defaultImport.settings.auto_backup_enabled, 0);
  assert.equal(defaultImport.settings.notify_income_missing, 1);

  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      ntfy_url: "",
      auto_backup_enabled: 0,
      notify_income_missing: 1
    }
  });

  const optInImport = await harness.api("/api/import/full", {
    method: "POST",
    body: {
      mode: "replace",
      export: exported,
      includeOperationalSettings: true
    }
  });
  assert.equal(optInImport.settings.ntfy_url, "https://ntfy.example.com/exported");
  assert.equal(optInImport.settings.auto_backup_enabled, 1);
  assert.equal(optInImport.settings.notify_income_missing, 0);
}));

test("full replace import validates opted-in operational settings before creating a backup", async () => withHarness(async harness => {
  const exported = await harness.api("/api/export/full?includeOperationalSettings=1");
  exported.planning.settings[0].backup_location = "/outside/allowed/backup-root";
  exported.planning.settings[0].notification_delivery_time = "25:00";
  const beforeBackups = backupCount(harness);

  const rejected = await harness.request("/api/import/full", {
    method: "POST",
    body: {
      mode: "replace",
      export: exported,
      includeOperationalSettings: true
    }
  });

  assert.equal(rejected.response.status, 400);
  assert.ok(rejected.body.details.some(detail => detail.field === "backup_location"));
  assert.equal(backupCount(harness), beforeBackups);

  const ignored = await harness.api("/api/import/full", {
    method: "POST",
    body: {
      mode: "replace",
      export: exported,
      includeOperationalSettings: false
    }
  });
  assert.equal(ignored.import.ok, true);
  assert.equal(ignored.settings.backup_location, null);
  assert.equal(ignored.settings.notification_delivery_time, "08:00");
}));

test("full replace import validates functional settings before creating a backup", async () => withHarness(async harness => {
  const exported = await harness.api("/api/export/full?includeOperationalSettings=1");
  const beforeBackups = backupCount(harness);
  const invalidSettings = [
    ["ledger_currency", "XXX"],
    ["locale", "xx"],
    ["timezone", "Not/A_Timezone"],
    ["holiday_country", "XX"],
    ["future_periods", 0],
    ["minimum_reserve_enabled", "yes"],
    ["minimum_reserve_amount", -1],
    ["fx_buffer_percent", 101],
    ["fx_provider", "unsupported-provider"],
    ["fx_used_currencies", null],
    ["manual_fx_rates", null],
    ["auto_backup_enabled", "yes"],
    ["backup_interval_minutes", 0],
    ["backup_retention_count", 0],
    ["backup_location", "relative/path"],
    ["ntfy_url", "ftp://example.com/topic"],
    ["notification_delivery_time", "25:00"],
    ["notify_income_missing", "yes"],
    ["ntfy_priority_income_missing", "extreme"],
    ["necessary_underfunded_repeat_days", 0]
  ];

  for (const [field, value] of invalidSettings) {
    const candidate = structuredClone(exported);
    candidate.planning.settings[0][field] = value;
    const rejected = await harness.request("/api/import/full", {
      method: "POST",
      body: {
        mode: "replace",
        export: candidate,
        includeOperationalSettings: true
      }
    });

    assert.equal(rejected.response.status, 400, field);
    assert.ok(rejected.body.details.some(detail => detail.field === field), JSON.stringify(rejected.body));
  }

  assert.equal(backupCount(harness), beforeBackups);
}));

test("full import accepts older exports missing recent settings fields", async () => withHarness(async harness => {
  await createConfirmedLedgerScenario(harness);
  const exported = await harness.api("/api/export/full");

  for (const key of [
    "setup_completed",
    "setup_completed_at",
    "holiday_country",
    "minimum_reserve_enabled",
    "minimum_reserve_amount"
  ]) {
    delete exported.planning.settings[0][key];
  }

  const imported = await harness.api("/api/import/full", {
    method: "POST",
    body: {
      mode: "replace",
      export: exported
    }
  });

  assert.equal(imported.settings.setup_completed, 1);
  assert.equal(typeof imported.settings.setup_completed_at, "string");
  assert.equal(imported.settings.holiday_country, "PL");
  assert.equal(imported.settings.minimum_reserve_enabled, 0);
  assert.equal(imported.settings.minimum_reserve_amount, 0);
}));

test("full merge import appends rows and rejects ID conflicts", async () => {
  let exported;
  let sourceOneOffId;
  await withHarness(async source => {
    const sourceOneOff = await source.api("/api/one-off", {
      method: "POST",
      body: {
        name: "Merge source",
        currency: "PLN",
        amount: 50,
        type: "expense",
        date: "2026-06-02"
      }
    });
    sourceOneOffId = sourceOneOff.id;
    exported = await source.api("/api/export/full");
  }, { userId: "source" });

  await withHarness(async target => {
    const targetOneOff = await target.api("/api/one-off", {
      method: "POST",
      body: {
        name: "Merge target",
        currency: "PLN",
        amount: 75,
        type: "income",
        date: "2026-06-03"
      }
    });
    const beforeBackups = backupCount(target);

    const merged = await target.api("/api/import/full", {
      method: "POST",
      body: {
        mode: "merge",
        export: exported
      }
    });

    assert.equal(typeof merged.import.safetyBackup, "string");
    assert.equal(backupCount(target), beforeBackups + 1);
    assert.equal(merged.oneOffs.some(row => row.id === sourceOneOffId), true);
    assert.equal(merged.oneOffs.some(row => row.id === targetOneOff.id), true);

    const conflict = await target.request("/api/import/full", {
      method: "POST",
      body: {
        mode: "merge",
        export: exported
      }
    });

    assert.equal(conflict.response.status, 409);
    assert.ok(conflict.body.conflicts.some(row => row.table === "one_off_transactions" && row.id === sourceOneOffId));
  }, { userId: "target" });
});

test("full merge import rolls back planning rows after later import failure", async () => {
  let exported;
  let rollbackOneOffId;
  await withHarness(async source => {
    const rollbackOneOff = await source.api("/api/one-off", {
      method: "POST",
      body: {
        name: "Rollback source",
        currency: "PLN",
        amount: 50,
        type: "expense",
        date: "2026-06-02"
      }
    });
    rollbackOneOffId = rollbackOneOff.id;
    exported = await source.api("/api/export/full");
    exported.ledgers["2026"] = [{
      id: "portable-bad-ledger",
      name: "Bad ledger row",
      currency: "PLN",
      amount: 1,
      type: "transfer",
      date: "2026-06-02",
      confirmed_date: "2026-06-02",
      fx_rate: 1,
      buffered_fx_rate: 1,
      ledger_currency: "PLN",
      running_balance_pln: 1,
      ledger_amount: 1,
      source_recurring_expense_id: null,
      source_recurring_income_id: null,
      source_one_off_id: null,
      source_flex_id: null,
      source_goal_id: null,
      occurrence_key: "bad-ledger-row",
      created_at: "2026-06-02T00:00:00.000Z",
      updated_at: "2026-06-02T00:00:00.000Z"
    }];
  }, { userId: "source" });

  await withHarness(async target => {
    const existingOneOff = await target.api("/api/one-off", {
      method: "POST",
      body: {
        name: "Existing target",
        currency: "PLN",
        amount: 25,
        type: "income",
        date: "2026-06-03"
      }
    });
    const beforeBackups = backupCount(target);

    const failed = await target.request("/api/import/full", {
      method: "POST",
      body: {
        mode: "merge",
        export: exported
      }
    });

    assert.equal(failed.response.status, 500);
    assert.equal(backupCount(target), beforeBackups + 1);
    const snapshot = await target.api("/api");
    assert.equal(snapshot.oneOffs.some(row => row.id === existingOneOff.id), true);
    assert.equal(snapshot.oneOffs.some(row => row.id === rollbackOneOffId), false);
  }, { userId: "target" });
});

test("CSV one-off import appends and replaces unconfirmed one-offs", async () => withHarness(async harness => {
  const appended = await harness.api("/api/import/one-offs-csv", {
    method: "POST",
    body: {
      mode: "append",
      csv: "name,type,amount,currency,date\nCSV income,income,100,PLN,2026-06-10\nCSV expense,expense,40,EUR,2026-06-11"
    }
  });

  assert.equal(appended.import.imported, 2);
  assert.equal(appended.oneOffs.some(row => row.name === "CSV income"), true);
  assert.equal(appended.oneOffs.some(row => row.currency === "EUR"), true);

  const replaced = await harness.api("/api/import/one-offs-csv", {
    method: "POST",
    body: {
      mode: "replace",
      csv: "name,type,amount,currency,date\nCSV replacement,expense,12,PLN,2026-06-12"
    }
  });

  assert.equal(replaced.import.imported, 1);
  assert.equal(replaced.oneOffs.some(row => row.name === "CSV replacement"), true);
  assert.equal(replaced.oneOffs.some(row => row.name === "CSV income"), false);
}));

test("CSV one-off import rejects invalid rows", async () => withHarness(async harness => {
  const invalidInputs = [
    {
      csv: "name,type,amount,currency\nMissing date,expense,1,PLN",
      field: "date",
      reason: "missing_column"
    },
    {
      csv: "name,type,amount,currency,date,extra\nExtra,expense,1,PLN,2026-06-10,x",
      field: "extra",
      reason: "unexpected_column"
    },
    {
      csv: "name,type,amount,currency,date\nBad type,transfer,1,PLN,2026-06-10",
      field: "type",
      reason: "must_be_income_or_expense"
    },
    {
      csv: "name,type,amount,currency,date\nBlank amount,expense,,PLN,2026-06-10",
      field: "amount",
      reason: "required"
    },
    {
      csv: "name,type,amount,currency,date\nBad amount,expense,-1,PLN,2026-06-10",
      field: "amount",
      reason: "must_be_non_negative"
    },
    {
      csv: "name,type,amount,currency,date\nBad currency,expense,1,XXX,2026-06-10",
      field: "currency",
      reason: "unsupported_currency"
    },
    {
      csv: "name,type,amount,currency,date\nBad date,expense,1,PLN,2026-02-31",
      field: "date",
      reason: "invalid_date"
    },
    {
      csv: "name,type,amount,currency,date\nWrong columns,expense,1,PLN",
      field: null,
      reason: "column_count_mismatch"
    },
    {
      csv: "name,type,amount,currency,date\n\"Bad quote,expense,1,PLN,2026-06-10",
      field: null,
      reason: "unterminated_quote"
    }
  ];

  for (const { csv, field, reason } of invalidInputs) {
    const result = await harness.request("/api/import/one-offs-csv", {
      method: "POST",
      body: {
        mode: "append",
        csv
      }
    });

    assert.equal(result.response.status, 400);
    assert.ok(Array.isArray(result.body.details));
    assert.ok(result.body.details.some(detail => detail.field === field && detail.reason === reason), JSON.stringify(result.body));
  }
}));

test("confirmed ledger CSV export includes headers and confirmed rows", async () => withHarness(async harness => {
  await createConfirmedLedgerScenario(harness);

  const result = await harness.request("/api/export/confirmed-ledger.csv");

  assert.equal(result.response.status, 200);
  assert.match(result.body, /^ledger_year,id,name,type,date,confirmed_date,currency,amount,ledger_currency,ledger_amount,fx_rate,buffered_fx_rate,running_balance,/);
  assert.match(result.body, /Portable income/);
}));

test("sample dataset can be downloaded and loaded", async () => withHarness(async harness => {
  await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Will be replaced",
      currency: "PLN",
      amount: 5,
      type: "expense",
      date: "2026-06-20"
    }
  });

  const sample = await harness.api("/api/export/sample");
  assert.equal(sample.format, "cashflow-full-export");
  assert.equal(sample.sample, true);
  assert.equal(sample.planning.settings[0].setup_completed, 1);
  assert.equal(sample.planning.one_off_transactions.some(row => row.name === "Sample laptop"), true);

  const loaded = await harness.api("/api/import/sample", {
    method: "POST",
    body: {}
  });
  const validation = await harness.api("/api/validate", { method: "POST", body: {} });

  assert.equal(loaded.import.ok, true);
  assert.equal(loaded.settings.setup_completed, 1);
  assert.equal(loaded.oneOffs.some(row => row.name === "Sample laptop"), true);
  assert.equal(loaded.oneOffs.some(row => row.name === "Will be replaced"), false);
  assert.equal(validation.ok, true);
}));
