import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { initializeLedgerSchema } from "../../src/server/cashflow-schema.js";

async function withHarness(fn, options = {}) {
  const harness = await createCashflowTestHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

function ensureLedgerSchema(db) {
  const exists = db.prepare(`
    SELECT 1 AS exists_flag
    FROM sqlite_master
    WHERE type IN ('table', 'view') AND name = 'confirmed_transactions'
    UNION ALL
    SELECT 1 AS exists_flag
    FROM sqlite_temp_master
    WHERE type IN ('table', 'view') AND name = 'confirmed_transactions'
  `).get();
  if (!exists) initializeLedgerSchema(db);
}

function insertConfirmed(harness, year, row) {
  const db = harness.openLedgerDb(year);
  try {
    ensureLedgerSchema(db);
    db.prepare(`
      INSERT INTO confirmed_transactions (
        id, name, currency, amount, type, date, confirmed_date,
        fx_rate, buffered_fx_rate, ledger_currency, running_balance_pln,
        ledger_amount, source_goal_id, occurrence_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.name,
      row.currency || "PLN",
      row.amount,
      row.type,
      row.date,
      row.confirmedDate,
      row.ledgerCurrency || row.currency || "PLN",
      row.runningBalance ?? 0,
      row.ledgerAmount ?? row.amount,
      row.sourceGoalId || null,
      row.occurrenceKey || row.id,
      row.createdAt || `${row.confirmedDate}T00:00:00.000Z`,
      row.updatedAt || `${row.confirmedDate}T00:00:00.000Z`
    );
  } finally {
    db.close();
  }
}

function confirmedRows(harness, year) {
  const db = harness.openLedgerDb(year);
  try {
    ensureLedgerSchema(db);
    return db.prepare(`
      SELECT *
      FROM confirmed_transactions
      ORDER BY confirmed_date, created_at, id
    `).all();
  } finally {
    db.close();
  }
}

function backupCount(harness) {
  const db = harness.openPlanningDb();
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM backup_metadata WHERE success = 1").get().count;
  } finally {
    db.close();
  }
}

test("ledger schema and full import reject absent confirmation dates before compaction", async () => withHarness(async harness => {
  assert.throws(() => insertConfirmed(harness, "2024", {
    id: "null-date", name: "Invalid historical row", amount: 100,
    type: "income", date: "2024-01-10", confirmedDate: null
  }), /NOT NULL constraint failed/);

  for (const missing of [false, true]) {
    const sample = await harness.api("/api/export/sample");
    delete sample.checksum;
    const [year] = Object.keys(sample.ledgers);
    const row = sample.ledgers[year][0];
    if (missing) delete row.confirmed_date;
    else row.confirmed_date = null;
    const result = await harness.request("/api/import/full", {
      method: "POST", body: { mode: "replace", export: sample }
    });
    assert.equal(result.response.status, 400);
    assert.ok(result.body.details.some(detail => detail.field === "confirmed_date"));
  }
  assert.equal(confirmedRows(harness, "2024").length, 0);
  assert.equal(backupCount(harness), 0);
}, { userId: "review_ledger" }));

test("ledger history compaction is disabled by default", async () => withHarness(async harness => {
  insertConfirmed(harness, "2024", {
    id: "old-income",
    name: "Old income",
    amount: 100,
    type: "income",
    date: "2024-01-10",
    confirmedDate: "2024-01-10"
  });

  const result = await harness.cashflow.compactLedgerHistory(harness.userId);

  assert.equal(result.enabled, false);
  assert.equal(result.compactedRows, 0);
  assert.equal(confirmedRows(harness, "2024").length, 1);
  assert.equal(backupCount(harness), 0);
}));

test("ledger history summaries retain original confirmed rows and source links", async () => withHarness(async harness => {
  insertConfirmed(harness, "2024", {
    id: "old-income",
    name: "Old income",
    amount: 1000,
    type: "income",
    date: "2024-01-10",
    confirmedDate: "2024-01-10"
  });
  insertConfirmed(harness, "2024", {
    id: "old-goal",
    name: "Old goal funding",
    amount: 250,
    type: "expense",
    date: "2024-02-10",
    confirmedDate: "2024-02-10",
    sourceGoalId: "deleted-goal"
  });
  insertConfirmed(harness, "2026", {
    id: "recent-expense",
    name: "Recent expense",
    amount: 100,
    type: "expense",
    date: "2026-04-01",
    confirmedDate: "2026-04-01",
    runningBalance: 650
  });

  const result = await harness.cashflow.compactLedgerHistory(harness.userId, { months: 12 });

  assert.equal(result.cutoffDate, "2025-05-20");
  assert.equal(result.compactedRows, 2);
  assert.equal(result.createdRows, 1);
  assert.equal(result.detailsRetained, true);
  assert.equal(confirmedRows(harness, "2024").length, 2);
  assert.equal(confirmedRows(harness, "2024")[1].source_goal_id, "deleted-goal");
  assert.equal(confirmedRows(harness, "2025").length, 0);
  assert.deepEqual(result.summaries, [{ ledgerCurrency: "PLN", count: 2,
    incomeTotal: 1000, expenseTotal: 250, netAmount: 750 }]);

  const recent = confirmedRows(harness, "2026");
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, "recent-expense");
  assert.equal(recent[0].running_balance_pln, 650);
  assert.equal(backupCount(harness), 1);

  const repeated = await harness.cashflow.compactLedgerHistory(harness.userId, {
    months: 12,
    today: "2026-05-21"
  });
  assert.equal(repeated.needsCompaction, false);
  assert.equal(repeated.compactedRows, 0);
  assert.equal(confirmedRows(harness, "2025").length, 0);
  assert.equal(backupCount(harness), 1);
}));

test("ledger history summaries retain normalized legacy dates without double-counting", async () => withHarness(async harness => {
  // A pre-merge ledger_2024.sqlite whose table predates the NOT NULL
  // constraint; the merge runs again once the marker is cleared.
  const planning = harness.openPlanningDb();
  try {
    planning.prepare("DELETE FROM ledger_merge_state").run();
  } finally {
    planning.close();
  }
  const legacy = new Database(path.join(harness.dataDir, harness.userId, "ledger_2024.sqlite"));
  try {
    legacy.exec(`
      CREATE TABLE confirmed_transactions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        currency TEXT NOT NULL,
        amount REAL NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
        date TEXT NOT NULL,
        confirmed_date TEXT,
        fx_rate REAL,
        buffered_fx_rate REAL,
        ledger_currency TEXT NOT NULL DEFAULT 'PLN',
        running_balance_pln REAL NOT NULL,
        ledger_amount REAL,
        source_recurring_expense_id TEXT,
        source_recurring_income_id TEXT,
        source_one_off_id TEXT,
        source_flex_id TEXT,
        source_goal_id TEXT,
        occurrence_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO confirmed_transactions (id, name, currency, amount, type, date, confirmed_date, fx_rate,
        buffered_fx_rate, ledger_currency, running_balance_pln, ledger_amount, created_at, updated_at)
      VALUES ('legacy-null-date', 'Legacy income', 'PLN', 100, 'income', '2024-01-10', NULL, 1, 1, 'PLN', 0, 100,
        '2024-01-10T00:00:00.000Z', '2024-01-10T00:00:00.000Z');
    `);
  } finally {
    legacy.close();
  }
  assert.equal(confirmedRows(harness, "2024")[0].confirmed_date, "2024-01-10");

  const result = await harness.cashflow.compactLedgerHistory(harness.userId, { months: 12, today: "2026-05-21" });
  
  assert.equal(result.compactedRows, 1);
  assert.equal(result.createdRows, 1);
  
  assert.equal(confirmedRows(harness, "2024").length, 1);
  assert.equal(confirmedRows(harness, "2025").length, 0);
  assert.equal(result.summaries[0].netAmount, 100);
}));

// Changed facts and corrupt caches must be rebuilt without touching originals.
test("history summaries rebuild changed facts and corrupt metadata, with atomic failures", async () => withHarness(async harness => {
  insertConfirmed(harness, "2024", { id: "retained", name: "Retained", amount: 100,
    type: "income", date: "2024-01-10", confirmedDate: "2024-01-10" });
  await harness.cashflow.compactLedgerHistory(harness.userId, { months: 12 });
  const db = harness.openPlanningDb();
  try {
    db.prepare("UPDATE ledger_transactions SET amount = 150, ledger_amount = 150 WHERE id = 'retained'").run();
  } finally { db.close(); }
  const changed = await harness.cashflow.compactLedgerHistory(harness.userId, { months: 12 });
  assert.equal(changed.summaries[0].netAmount, 150);
  const corrupt = harness.openPlanningDb();
  try { corrupt.prepare("UPDATE cashflow_ledger_summary_cache SET cache_json = 'broken'").run(); }
  finally { corrupt.close(); }
  const repaired = await harness.cashflow.compactLedgerHistory(harness.userId, { months: 12 });
  assert.equal(repaired.summaries[0].netAmount, 150);
  assert.equal(confirmedRows(harness, "2024")[0].id, "retained");
  const failing = harness.openPlanningDb();
  try {
    failing.prepare("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, 'summary-failure-epoch', 0) ON CONFLICT (budget_id) DO NOTHING").run(harness.userId);
    failing.exec("UPDATE cashflow_ledger_summary_cache SET cache_json = 'broken'; CREATE TRIGGER fail_summary BEFORE UPDATE ON cashflow_ledger_summary_cache BEGIN SELECT RAISE(ABORT, 'Injected summary write failure'); END;");
  } finally { failing.close(); }
  await assert.rejects(harness.cashflow.compactLedgerHistory(harness.userId, { months: 12 }), /Injected summary write failure/);
  assert.equal(confirmedRows(harness, "2024")[0].amount, 150);
  const afterFailure = harness.openPlanningDb();
  try {
    assert.equal(afterFailure.prepare("SELECT epoch FROM cashflow_sync_heads WHERE budget_id = ?").get(harness.userId).epoch, 'summary-failure-epoch');
    assert.equal(afterFailure.prepare("SELECT cache_json FROM cashflow_ledger_summary_cache").get().cache_json, 'broken');
  } finally { afterFailure.close(); }
}));
