import assert from "node:assert/strict";
import test from "node:test";

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
    WHERE type = 'table' AND name = 'confirmed_transactions'
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

test("ledger history compaction replaces old confirmed rows with balance rows per ledger currency", async () => withHarness(async harness => {
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
  assert.equal(confirmedRows(harness, "2024").length, 0);

  const compacted = confirmedRows(harness, "2025");
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].name, "Historical ledger balance before 2025-05-20 (PLN)");
  assert.equal(compacted[0].currency, "PLN");
  assert.equal(compacted[0].ledger_currency, "PLN");
  assert.equal(compacted[0].amount, 750);
  assert.equal(compacted[0].type, "income");
  assert.equal(compacted[0].ledger_amount, 750);
  assert.equal(compacted[0].running_balance_pln, 750);
  assert.equal(compacted[0].source_goal_id, null);
  assert.equal(compacted[0].occurrence_key, "ledger_history_compaction:PLN:2025-05-20");

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
  assert.equal(confirmedRows(harness, "2025").length, 1);
  assert.equal(backupCount(harness), 1);
}));

test("ledger history compaction deletes explicit IDs so legacy rows with null confirmed_date are not double-counted", async () => withHarness(async harness => {
  const db = harness.openLedgerDb("2024");
  try {
    // Create the table without the NOT NULL constraint to simulate legacy database
    db.exec(`
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
    `);
  } finally {
    db.close();
  }

  insertConfirmed(harness, "2024", {
    id: "legacy-null-date",
    name: "Legacy income",
    amount: 100,
    type: "income",
    date: "2024-01-10",
    confirmedDate: null
  });

  const result = await harness.cashflow.compactLedgerHistory(harness.userId, { months: 12, today: "2026-05-21" });
  
  assert.equal(result.compactedRows, 1);
  assert.equal(result.createdRows, 1);
  
  // The old 2024 row should be gone
  assert.equal(confirmedRows(harness, "2024").length, 0);
  
  // The total should be 100 in the new 2025 compacted row
  const compacted = confirmedRows(harness, "2025");
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].amount, 100);
}));
