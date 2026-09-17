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
