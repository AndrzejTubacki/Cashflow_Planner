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
  const exported = await harness.api("/api/export/full");
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

  assert.equal(result.response.status, 500);
  const snapshot = await harness.api("/api");
  assert.equal(snapshot.oneOffs.some(row => row.id === oneOff.id), true);
  assert.equal(snapshot.confirmedTransactions.some(row => row.source_one_off_id === oneOff.id), true);
}));

test("full merge import appends rows and rejects ID conflicts", async () => {
  let exported;
  await withHarness(async source => {
    await source.api("/api/one-off", {
      method: "POST",
      body: {
        id: "portable-source-oneoff",
        name: "Merge source",
        currency: "PLN",
        amount: 50,
        type: "expense",
        date: "2026-06-02"
      }
    });
    exported = await source.api("/api/export/full");
  }, { userId: "source" });

  await withHarness(async target => {
    await target.api("/api/one-off", {
      method: "POST",
      body: {
        id: "portable-target-oneoff",
        name: "Merge target",
        currency: "PLN",
        amount: 75,
        type: "income",
        date: "2026-06-03"
      }
    });

    const merged = await target.api("/api/import/full", {
      method: "POST",
      body: {
        mode: "merge",
        export: exported
      }
    });

    assert.equal(merged.oneOffs.some(row => row.id === "portable-source-oneoff"), true);
    assert.equal(merged.oneOffs.some(row => row.id === "portable-target-oneoff"), true);

    const conflict = await target.request("/api/import/full", {
      method: "POST",
      body: {
        mode: "merge",
        export: exported
      }
    });

    assert.equal(conflict.response.status, 409);
    assert.ok(conflict.body.conflicts.some(row => row.table === "one_off_transactions" && row.id === "portable-source-oneoff"));
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
    "name,type,amount,currency\nMissing date,expense,1,PLN",
    "name,type,amount,currency,date\nBad type,transfer,1,PLN,2026-06-10",
    "name,type,amount,currency,date\nBad amount,expense,-1,PLN,2026-06-10",
    "name,type,amount,currency,date\nBad date,expense,1,PLN,not-a-date"
  ];

  for (const csv of invalidInputs) {
    const result = await harness.request("/api/import/one-offs-csv", {
      method: "POST",
      body: {
        mode: "append",
        csv
      }
    });

    assert.equal(result.response.status, 500);
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
  assert.equal(sample.planning.one_off_transactions.some(row => row.name === "Sample laptop"), true);

  const loaded = await harness.api("/api/import/sample", {
    method: "POST",
    body: {}
  });
  const validation = await harness.api("/api/validate", { method: "POST", body: {} });

  assert.equal(loaded.import.ok, true);
  assert.equal(loaded.oneOffs.some(row => row.name === "Sample laptop"), true);
  assert.equal(loaded.oneOffs.some(row => row.name === "Will be replaced"), false);
  assert.equal(validation.ok, true);
}));
