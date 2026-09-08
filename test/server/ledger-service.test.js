import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCashflowLedgerService } from "../../src/server/cashflow-ledger-service.js";

async function withLedgerDbs(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "cashflow-ledger-test-"));
  try {
    const dbPaths = new Map();
    for (const year of ["2025", "2026"]) {
      const dbPath = path.join(dir, `ledger_${year}.sqlite`);
      dbPaths.set(year, dbPath);
      const db = new Database(dbPath);
      try {
        db.exec(`
          CREATE TABLE confirmed_transactions (
            id TEXT PRIMARY KEY,
            amount REAL NOT NULL,
            type TEXT NOT NULL,
            fx_rate REAL,
            buffered_fx_rate REAL,
            ledger_currency TEXT NOT NULL,
            ledger_amount REAL,
            source_flex_id TEXT,
            source_goal_id TEXT
          );
        `);
      } finally {
        db.close();
      }
    }

    return await fn(dbPaths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function insertConfirmed(dbPath, row) {
  const db = new Database(dbPath);
  try {
    db.prepare(`
      INSERT INTO confirmed_transactions (
        id, amount, type, fx_rate, buffered_fx_rate, ledger_currency,
        ledger_amount, source_flex_id, source_goal_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.amount,
      row.type,
      row.fxRate ?? 1,
      row.bufferedFxRate ?? 1,
      row.ledgerCurrency || "PLN",
      row.ledgerAmount ?? null,
      row.sourceFlexId || null,
      row.sourceGoalId || null
    );
  } finally {
    db.close();
  }
}

test("confirmed funding totals scan each ledger year once", async () => withLedgerDbs(async dbPaths => {
  insertConfirmed(dbPaths.get("2025"), {
    id: "goal-explicit",
    amount: 10,
    type: "expense",
    ledgerAmount: 10,
    sourceGoalId: "goal-1"
  });
  insertConfirmed(dbPaths.get("2026"), {
    id: "goal-derived",
    amount: 5,
    type: "expense",
    bufferedFxRate: 2,
    sourceGoalId: "goal-1"
  });
  insertConfirmed(dbPaths.get("2026"), {
    id: "flex-explicit",
    amount: 7,
    type: "expense",
    ledgerAmount: 7,
    sourceFlexId: "flex-1"
  });
  insertConfirmed(dbPaths.get("2026"), {
    id: "old-ledger-ignored",
    amount: 100,
    type: "expense",
    ledgerAmount: 100,
    ledgerCurrency: "EUR",
    sourceGoalId: "goal-1"
  });
  insertConfirmed(dbPaths.get("2026"), {
    id: "income-ignored",
    amount: 100,
    type: "income",
    ledgerAmount: 100,
    sourceGoalId: "goal-1"
  });

  let ledgerOpenCount = 0;
  const service = createCashflowLedgerService({
    listLedgerYears: () => ["2025", "2026"],
    openLedgerDb: (_userId, year) => {
      ledgerOpenCount += 1;
      return new Database(dbPaths.get(String(year)));
    },
    openPlanningDb: () => {
      throw new Error("settings should be supplied by caller");
    }
  });

  const totals = service.confirmedFundingTotals("local", "PLN", { ledger_currency: "PLN" });

  assert.equal(ledgerOpenCount, 2);
  assert.equal(totals.source_goal_id.get("goal-1"), 20);
  assert.equal(totals.source_flex_id.get("flex-1"), 7);
}));
