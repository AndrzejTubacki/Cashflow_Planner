import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createCashflowTestHarness, ledgerDbPath } from "../helpers/cashflow-test-harness.js";
import { OPERATIONAL_SETTINGS_COLUMNS } from "../../src/server/cashflow-settings-validation.js";
import { badRequest } from "../../src/server/cashflow-user-utils.js";

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

test("default replace and sample imports preserve target operational settings", async () => withHarness(async harness => {
  const exported = await harness.api("/api/export/full?includeOperationalSettings=1");
  exported.planning.settings[0].future_periods = 3;
  exported.planning.settings[0].ntfy_url = "https://ntfy.example.com/source";
  exported.planning.settings[0].auto_backup_enabled = 0;
  exported.planning.settings[0].backup_retention_count = 3;

  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      ntfy_url: "https://ntfy.example.com/target",
      auto_backup_enabled: 1,
      backup_interval_minutes: 120,
      backup_retention_count: 7,
      notification_delivery_time: "09:15",
      notify_goal_impossible: 0,
      notify_income_missing: 0,
      ntfy_priority_goal_impossible: "urgent",
      ntfy_priority_income_missing: "low",
      necessary_underfunded_repeat_days: 4
    }
  });
  const target = await harness.api("/api");
  const expectedOperational = Object.fromEntries(
    [...OPERATIONAL_SETTINGS_COLUMNS].map(field => [field, target.settings[field]])
  );

  const replaced = await harness.api("/api/import/full", {
    method: "POST",
    body: { mode: "replace", export: exported }
  });
  assert.equal(replaced.settings.future_periods, 3);
  assert.deepEqual(
    Object.fromEntries([...OPERATIONAL_SETTINGS_COLUMNS].map(field => [field, replaced.settings[field]])),
    expectedOperational
  );

  const sample = await harness.api("/api/import/sample", { method: "POST", body: {} });
  assert.deepEqual(
    Object.fromEntries([...OPERATIONAL_SETTINGS_COLUMNS].map(field => [field, sample.settings[field]])),
    expectedOperational
  );
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

test("full import accepts older rows that omit current schema-default fields", async () => withHarness(async harness => {
  const sample = await harness.api("/api/export/sample");
  delete sample.planning.fx_rates_cache[0].quote_currency;
  delete sample.planning.recurring_expenses[0].prediction_substitute_missing;
  delete sample.planning.recurring_expenses[0].prediction_min_recorded_months;
  delete sample.planning.recurring_expenses[0].necessary;
  delete sample.planning.recurring_expenses[0].active;
  delete sample.planning.flex_transactions[0].active;
  delete sample.planning.flex_transactions[0].allow_split;
  delete sample.planning.goals[0].active;
  delete sample.ledgers["2026"][0].ledger_currency;

  const imported = await harness.api("/api/import/full", {
    method: "POST",
    body: { mode: "replace", export: sample }
  });

  assert.equal(imported.recurringExpenses[0].prediction_substitute_missing, "none");
  assert.equal(imported.recurringExpenses[0].prediction_min_recorded_months, 6);
  assert.equal(imported.recurringExpenses[0].necessary, 0);
  assert.equal(imported.recurringExpenses[0].active, 1);
  assert.equal(imported.flexTransactions[0].active, 1);
  assert.equal(imported.flexTransactions[0].allow_split, 0);
  assert.equal(imported.goals[0].active, 1);
  assert.equal(imported.confirmedTransactions[0].ledger_currency, "PLN");
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

test("full merge conflicts do not create imported ledger files before the safety backup", async () => withHarness(async harness => {
  const existing = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Existing conflict",
      currency: "PLN",
      amount: 25,
      type: "expense",
      date: "2026-06-03"
    }
  });
  const sample = await harness.api("/api/export/sample");
  sample.planning.one_off_transactions[0].id = existing.id;
  const newLedgerPath = ledgerDbPath(harness.dataDir, harness.userId, "2026");
  const beforeBackups = backupCount(harness);

  assert.equal(fs.existsSync(newLedgerPath), false);
  const conflict = await harness.request("/api/import/full", {
    method: "POST",
    body: {
      mode: "merge",
      export: sample
    }
  });

  assert.equal(conflict.response.status, 409);
  assert.equal(backupCount(harness), beforeBackups);
  assert.equal(fs.existsSync(newLedgerPath), false);
}));

test("full merge detects confirmed IDs that already exist in another ledger year", async () => withHarness(async harness => {
  await createConfirmedLedgerScenario(harness);
  const exported = await harness.api("/api/export/full");
  const existingRow = exported.ledgers["2026"][0];
  delete exported.ledgers["2026"];
  exported.ledgers["2027"] = [{
    ...existingRow,
    date: "2027-06-01",
    confirmed_date: "2027-06-01"
  }];
  const newLedgerPath = ledgerDbPath(harness.dataDir, harness.userId, "2027");

  assert.equal(fs.existsSync(newLedgerPath), false);
  const conflict = await harness.request("/api/import/full", {
    method: "POST",
    body: {
      mode: "merge",
      export: exported
    }
  });

  assert.equal(conflict.response.status, 409);
  assert.ok(conflict.body.conflicts.some(item =>
    item.table === "ledger_2027.confirmed_transactions"
      && item.id === existingRow.id
  ));
  assert.equal(fs.existsSync(newLedgerPath), false);
}));

test("full merge ignores target settings validation but rejects occurrence-key conflicts", async () => {
  let sourceExport;
  await withHarness(async source => {
    await createConfirmedLedgerScenario(source);
    sourceExport = await source.api("/api/export/full");
  }, { userId: "merge-source" });

  await withHarness(async target => {
    const income = await target.api("/api/recurring-incomes", {
      method: "POST",
      body: {
        name: "Target period income",
        currency: "PLN",
        amount: 1000,
        prediction_strategy: "fixed",
        active: 1,
        period_setting: 1,
        anchor_type: "day_of_month",
        anchor_day_of_month: 1,
        anchor_business_day_adjustment: "none",
        repeat_every_months: 1
      }
    });
    assert.equal((await target.api("/api")).settings.budget_period_income_id, income.id);

    const merged = await target.api("/api/import/full", {
      method: "POST",
      body: { mode: "merge", export: sourceExport }
    });
    assert.equal(merged.settings.budget_period_income_id, income.id);

    const duplicateOccurrence = structuredClone(sourceExport);
    for (const row of duplicateOccurrence.planning.one_off_transactions) {
      row.id = `duplicate-${row.id}`;
    }
    for (const row of Object.values(duplicateOccurrence.ledgers).flat()) {
      row.id = `duplicate-${row.id}`;
      row.source_one_off_id = null;
    }
    const conflict = await target.request("/api/import/full", {
      method: "POST",
      body: { mode: "merge", export: duplicateOccurrence }
    });
    assert.equal(conflict.response.status, 409);
    assert.ok(conflict.body.conflicts.some(item =>
      item.table === "occurrence_keys" && item.reason === "already_exists"
    ));
  }, { userId: "merge-target" });
});

test("full merge import rejects invalid ledger rows before backup or mutation", async () => {
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

    assert.equal(failed.response.status, 400);
    assert.equal(backupCount(target), beforeBackups);
    const snapshot = await target.api("/api");
    assert.equal(snapshot.oneOffs.some(row => row.id === existingOneOff.id), true);
    assert.equal(snapshot.oneOffs.some(row => row.id === rollbackOneOffId), false);
  }, { userId: "target" });
});

test("full import rejects malformed rows before backup or writes", async () => withHarness(async harness => {
  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Validation baseline",
      currency: "PLN",
      amount: 10,
      type: "expense",
      date: "2026-06-15"
    }
  });
  const exported = await harness.api("/api/export/full");
  const beforeBackups = backupCount(harness);
  const cases = [
    ["unknown field", candidate => { candidate.planning.one_off_transactions[0].unexpected = true; }, "unknown_field"],
    ["missing required", candidate => { delete candidate.planning.one_off_transactions[0].name; }, "required"],
    ["invalid id", candidate => { candidate.planning.one_off_transactions[0].id = "../bad"; }, "invalid_id"],
    ["whitespace id", candidate => { candidate.planning.one_off_transactions[0].id = ` ${candidate.planning.one_off_transactions[0].id} `; }, "invalid_id"],
    ["duplicate id", candidate => { candidate.planning.one_off_transactions.push({ ...candidate.planning.one_off_transactions[0] }); }, "duplicate_id"],
    ["invalid enum", candidate => { candidate.planning.one_off_transactions[0].type = "transfer"; }, "unsupported_value"],
    ["negative amount", candidate => { candidate.planning.one_off_transactions[0].amount = -1; }, "below_minimum"],
    ["bad timestamp", candidate => { candidate.planning.one_off_transactions[0].updated_at = "not-a-time"; }, "invalid_timestamp"],
    ["impossible timestamp", candidate => { candidate.planning.one_off_transactions[0].updated_at = "2026-02-31T00:00:00.000Z"; }, "invalid_timestamp"],
    ["missing planned owner", candidate => { candidate.planning.planned_transactions.push({
      id: "orphan-plan",
      type: "goal",
      operating_priority: null,
      goal_priority: 1,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z"
    }); }, "planned_transaction_has_no_owner"]
  ];

  for (const [label, mutate, reason] of cases) {
    const candidate = structuredClone(exported);
    mutate(candidate);
    const rejected = await harness.request("/api/import/full", {
      method: "POST",
      body: { mode: "replace", export: candidate }
    });
    assert.equal(rejected.response.status, 400, label);
    assert.ok(rejected.body.details.some(item => item.reason === reason), `${label}: ${JSON.stringify(rejected.body)}`);
  }

  assert.equal(backupCount(harness), beforeBackups);
  const snapshot = await harness.api("/api");
  assert.equal(snapshot.oneOffs.some(row => row.id === oneOff.id), true);
}));

test("full import rounds imported money columns before insertion", async () => withHarness(async harness => {
  const sample = await harness.api("/api/export/sample");
  sample.planning.one_off_transactions[0].amount = 123.456;
  sample.planning.pending_transactions.push({
    id: "sample-import-pending",
    name: "Imported pending",
    currency: "PLN",
    amount: 10.005,
    type: "expense",
    date: "2026-07-15",
    source_recurring_expense_id: null,
    source_recurring_income_id: null,
    source_one_off_id: "sample-oneoff-laptop",
    source_flex_id: null,
    source_goal_id: null,
    fx_rate: 1,
    buffered_fx_rate: 1,
    ledger_currency: "PLN",
    status: "pending",
    funded_amount: 10.005,
    requested_amount: 10.005,
    ledger_amount: 10.005,
    running_balance: null,
    pending_origin: "manual",
    note: null,
    occurrence_key: "sample-import-pending",
    created_at: sample.planning.one_off_transactions[0].created_at,
    updated_at: sample.planning.one_off_transactions[0].updated_at
  });
  sample.ledgers["2026"][0].amount = 7000.005;
  sample.ledgers["2026"][0].ledger_amount = 7000.005;
  sample.ledgers["2026"][0].running_balance_pln = 7000.005;

  const imported = await harness.api("/api/import/full", {
    method: "POST",
    body: {
      mode: "replace",
      export: sample
    }
  });

  assert.equal(imported.oneOffs.find(row => row.id === "sample-oneoff-laptop").amount, 123.46);
  assert.equal(imported.pendingTransactions.find(row => row.id === "sample-import-pending").amount, 10.01);
  assert.equal(imported.pendingTransactions.find(row => row.id === "sample-import-pending").ledger_amount, 10.01);
  assert.equal(imported.confirmedTransactions.find(row => row.id === "sample-ledger-salary-2026-01").amount, 7000.01);
  assert.equal(imported.confirmedTransactions.find(row => row.id === "sample-ledger-salary-2026-01").ledger_amount, 7000.01);
  assert.equal(imported.confirmedTransactions.find(row => row.id === "sample-ledger-salary-2026-01").running_balance, 7000.01);
}));

test("full import validates table-specific values and relationships before backup", async () => withHarness(async harness => {
  const sample = await harness.api("/api/export/sample");
  const beforeBackups = backupCount(harness);
  const timestamp = "2026-06-01T00:00:00.000Z";
  const pendingRow = {
    id: "validation-pending",
    name: "Validation pending",
    currency: "PLN",
    amount: 10,
    type: "expense",
    date: "2026-06-15",
    created_at: timestamp,
    updated_at: timestamp
  };
  const cases = [
    ["duplicate FX key", candidate => {
      candidate.planning.fx_rates_cache.push({ ...candidate.planning.fx_rates_cache[0] });
    }, "duplicate_pair_date"],
    ["invalid FX JSON", candidate => {
      candidate.planning.fx_rates_cache[0].raw_json = "{";
    }, "invalid_json"],
    ["non-string FX JSON", candidate => {
      candidate.planning.fx_rates_cache[0].raw_json = 1;
    }, "must_be_json_string"],
    ["null default currency", candidate => {
      candidate.planning.fx_rates_cache[0].quote_currency = null;
    }, "unsupported_currency"],
    ["invalid boolean", candidate => {
      candidate.planning.flex_transactions[0].active = 2;
    }, "must_be_boolean_or_zero_or_one"],
    ["invalid month", candidate => {
      candidate.planning.recurring_expenses[0].start_month_year = "2026-13";
    }, "invalid_month"],
    ["missing pending source", candidate => {
      candidate.planning.pending_transactions.push({
        ...pendingRow,
        source_one_off_id: "missing-one-off"
      });
    }, "source_not_found"],
    ["pending source type mismatch", candidate => {
      candidate.planning.pending_transactions.push({
        ...pendingRow,
        type: "income",
        source_goal_id: candidate.planning.goals[0].id
      });
    }, "source_type_mismatch"],
    ["multiple pending sources", candidate => {
      candidate.planning.pending_transactions.push({
        ...pendingRow,
        source_one_off_id: candidate.planning.one_off_transactions[0].id,
        source_goal_id: candidate.planning.goals[0].id
      });
    }, "multiple_sources"],
    ["negative pending funding", candidate => {
      candidate.planning.pending_transactions.push({
        ...pendingRow,
        funded_amount: -1
      });
    }, "below_minimum"],
    ["non-string pending note", candidate => {
      candidate.planning.pending_transactions.push({
        ...pendingRow,
        note: { invalid: true }
      });
    }, "must_be_string"],
    ["pending-confirmed occurrence collision", candidate => {
      candidate.planning.pending_transactions.push({
        ...pendingRow,
        occurrence_key: candidate.ledgers["2026"][0].occurrence_key
      });
    }, "duplicate_occurrence_key"],
    ["pending-confirmed id collision", candidate => {
      candidate.planning.pending_transactions.push({
        ...pendingRow,
        id: candidate.ledgers["2026"][0].id
      });
    }, "duplicate_id"],
    ["invalid budget period income", candidate => {
      candidate.planning.settings[0].budget_period_income_id = "missing-period-income";
    }, "invalid_period_setting_income"],
    ["malformed budget period income id", candidate => {
      candidate.planning.settings[0].budget_period_income_id = 0;
    }, "invalid_id"],
    ["negative confirmed ledger amount", candidate => {
      candidate.ledgers["2026"][0].ledger_amount = -1;
    }, "below_minimum"]
  ];

  for (const [label, mutate, reason] of cases) {
    const candidate = structuredClone(sample);
    mutate(candidate);
    const rejected = await harness.request("/api/import/full", {
      method: "POST",
      body: { mode: "replace", export: candidate }
    });
    assert.equal(rejected.response.status, 400, label);
    assert.ok(rejected.body.details.some(item => item.reason === reason), `${label}: ${JSON.stringify(rejected.body)}`);
  }

  assert.equal(backupCount(harness), beforeBackups);
}));

test("full import validates ledger relationships and occurrence uniqueness before backup", async () => withHarness(async harness => {
  await createConfirmedLedgerScenario(harness);
  const exported = await harness.api("/api/export/full");
  const beforeBackups = backupCount(harness);
  const cases = [
    ["ledger year mismatch", candidate => {
      candidate.ledgers["2025"] = candidate.ledgers["2026"];
      delete candidate.ledgers["2026"];
    }, "ledger_year_mismatch"],
    ["multiple historical sources", candidate => {
      candidate.ledgers["2026"][0].source_goal_id = "historical-goal";
      candidate.ledgers["2026"][0].source_one_off_id = "historical-oneoff";
    }, "multiple_sources"],
    ["duplicate occurrence", candidate => {
      candidate.ledgers["2026"].push({
        ...candidate.ledgers["2026"][0],
        id: "duplicate-occurrence-ledger"
      });
    }, "duplicate_occurrence_key"]
  ];

  for (const [label, mutate, reason] of cases) {
    const candidate = structuredClone(exported);
    mutate(candidate);
    const rejected = await harness.request("/api/import/full", {
      method: "POST",
      body: { mode: "replace", export: candidate }
    });
    assert.equal(rejected.response.status, 400, label);
    assert.ok(rejected.body.details.some(item => item.reason === reason), `${label}: ${JSON.stringify(rejected.body)}`);
  }
  assert.equal(backupCount(harness), beforeBackups);

  const historical = structuredClone(exported);
  historical.ledgers["2026"][0].source_one_off_id = "deleted-historical-source";
  const accepted = await harness.api("/api/import/full", {
    method: "POST",
    body: { mode: "replace", export: historical }
  });
  assert.equal(accepted.confirmedTransactions[0].source_one_off_id, "deleted-historical-source");
}));

test("full import inserts each row using its own compatible columns", async () => withHarness(async harness => {
  const exported = await harness.api("/api/export/full");
  exported.planning.fx_rates_cache = [
    {
      base_currency: "EUR",
      quote_currency: "PLN",
      currency: "EUR",
      rate_date: "2026-06-01",
      rate: 4.2,
      effective_date: null,
      source: "manual",
      updated_at: "2026-06-01T00:00:00.000Z"
    },
    {
      base_currency: "USD",
      quote_currency: "PLN",
      currency: "USD",
      rate_date: "2026-06-01",
      rate: 3.9,
      effective_date: "2026-06-01",
      source: "manual",
      raw_json: "{\"second\":true}",
      updated_at: "2026-06-01T00:00:00.000Z"
    }
  ];

  await harness.api("/api/import/full", {
    method: "POST",
    body: { mode: "replace", export: exported }
  });
  const db = harness.openPlanningDb();
  try {
    assert.equal(
      db.prepare("SELECT raw_json FROM fx_rates_cache WHERE base_currency = 'USD'").get().raw_json,
      "{\"second\":true}"
    );
  } finally {
    db.close();
  }
}));

test("import rollback preserves original validation details and reports rollback failure distinctly", async () => {
  let exported;
  await withHarness(async source => {
    exported = await source.api("/api/export/full");
  }, { userId: "rollback-source" });

  let failRollback = false;
  await withHarness(async target => {
    const original = await target.request("/api/import/full", {
      method: "POST",
      body: { mode: "replace", export: exported }
    });
    assert.equal(original.response.status, 400);
    assert.ok(original.body.details.some(item => item.field === "forced"));

    failRollback = true;
    const rollbackFailed = await target.request("/api/import/full", {
      method: "POST",
      body: { mode: "replace", export: exported }
    });
    assert.equal(rollbackFailed.response.status, 500);
    assert.equal(rollbackFailed.body.details.phase, "rollback_failed");
    assert.equal(typeof rollbackFailed.body.details.safetyBackup, "string");
    assert.match(rollbackFailed.body.details.originalError, /forced import failure/);
    assert.match(rollbackFailed.body.details.rollbackError, /forced rollback failure/);
  }, {
    userId: "rollback-target",
    portabilityMutationHook: ({ phase }) => {
      if (phase === "after_replace_planning") {
        throw badRequest("forced import failure", [{ field: "forced", reason: "test" }]);
      }
      if (failRollback && phase === "before_replace_rollback") {
        throw new Error("forced rollback failure");
      }
    }
  });
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
      csv: "name,type,amount,currency,date\nCSV replacement,expense,\"12,345\",PLN,2026-06-12"
    }
  });

  assert.equal(replaced.import.imported, 1);
  assert.equal(replaced.oneOffs.some(row => row.name === "CSV replacement"), true);
  assert.equal(replaced.oneOffs.find(row => row.name === "CSV replacement").amount, 12.35);
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
