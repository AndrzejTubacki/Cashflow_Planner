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

test("confirmed ledger pagination can read rows through the budget-store facade", async () => {
  const calls = [];
  const service = createCashflowLedgerService({
    budgetStore: {
      async listConfirmedTransactions(budgetId, options) {
        calls.push({ budgetId, options });
        return [
          {
            id: "ignored-type",
            currency: "PLN",
            created_at: "2026-01-01T00:00:00Z",
            date: "2026-01-01",
            ledger_currency: "PLN",
            source_goal_id: "goal-1",
            type: "income"
          },
          {
            id: "older",
            currency: "PLN",
            created_at: "2026-01-02T00:00:00Z",
            date: "2026-01-02",
            ledger_currency: "PLN",
            source_goal_id: "goal-1",
            type: "expense"
          },
          {
            id: "newer",
            currency: "PLN",
            created_at: "2026-01-03T00:00:00Z",
            date: "2026-01-03",
            ledger_currency: "PLN",
            source_goal_id: "goal-1",
            type: "expense"
          },
          {
            id: "other-source",
            currency: "PLN",
            created_at: "2026-01-04T00:00:00Z",
            date: "2026-01-04",
            ledger_currency: "PLN",
            source_goal_id: "goal-2",
            type: "expense"
          }
        ];
      }
    },
    listLedgerYears: () => {
      throw new Error("ledger years should not be read directly");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async pagination");
    },
    openPlanningDb: () => {
      throw new Error("settings should not be opened for async pagination");
    }
  });

  const page = await service.listConfirmedTransactionsPageAsync("household", {
    limit: 1,
    offset: 0,
    sourceId: "goal-1",
    sourceType: "goal",
    type: "expense",
    year: "2026"
  });

  assert.deepEqual(calls, [{
    budgetId: "household",
    options: { ledgerYear: 2026 }
  }]);
  assert.equal(page.total, 2);
  assert.deepEqual(page.rows.map(row => row.id), ["newer"]);
  assert.equal(page.filters.sourceType, "goal");
});

test("confirmed ledger aggregate can read all years through the budget-store facade", async () => {
  const calls = [];
  const rowsByYear = new Map([
    [2025, [{
      id: "older",
      created_at: "2025-01-01T00:00:00Z",
      date: "2025-01-10",
      type: "income"
    }]],
    [2026, [{
      id: "newer",
      created_at: "2026-01-01T00:00:00Z",
      date: "2026-01-10",
      type: "income"
    }, {
      id: "middle",
      created_at: "2026-01-01T00:00:00Z",
      date: "2025-06-10",
      type: "expense"
    }]]
  ]);
  const service = createCashflowLedgerService({
    budgetStore: {
      async listLedgerYears(budgetId) {
        calls.push({ budgetId, method: "listLedgerYears" });
        return [2026, 2025];
      },
      async listConfirmedTransactions(budgetId, options) {
        calls.push({ budgetId, method: "listConfirmedTransactions", options });
        return rowsByYear.get(Number(options.ledgerYear)) || [];
      }
    },
    listLedgerYears: () => {
      throw new Error("ledger years should not be read directly");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async aggregate");
    },
    openPlanningDb: () => {
      throw new Error("settings should not be opened for async aggregate");
    }
  });

  const rows = await service.loadAllConfirmedTransactionsAsync("household");

  assert.deepEqual(rows.map(row => row.id), ["older", "middle", "newer"]);
  assert.deepEqual(calls, [
    { budgetId: "household", method: "listLedgerYears" },
    { budgetId: "household", method: "listConfirmedTransactions", options: { ledgerYear: 2026 } },
    { budgetId: "household", method: "listConfirmedTransactions", options: { ledgerYear: 2025 } }
  ]);
});

test("confirmed funding totals can read through the budget-store facade", async () => {
  const service = createCashflowLedgerService({
    budgetStore: {
      async listLedgerYears() {
        return [2026];
      },
      async listConfirmedTransactions() {
        return [
          {
            id: "goal-explicit",
            amount: 10,
            buffered_fx_rate: 1,
            ledger_amount: 10,
            ledger_currency: "PLN",
            source_goal_id: "goal-1",
            type: "expense"
          },
          {
            id: "goal-derived",
            amount: 5,
            buffered_fx_rate: 2,
            ledger_currency: "PLN",
            source_goal_id: "goal-1",
            type: "expense"
          },
          {
            id: "flex-explicit",
            amount: 7,
            buffered_fx_rate: 1,
            ledger_amount: 7,
            ledger_currency: "PLN",
            source_flex_id: "flex-1",
            type: "expense"
          },
          {
            id: "old-ledger-ignored",
            amount: 100,
            buffered_fx_rate: 1,
            ledger_amount: 100,
            ledger_currency: "EUR",
            source_goal_id: "goal-1",
            type: "expense"
          },
          {
            id: "income-ignored",
            amount: 100,
            buffered_fx_rate: 1,
            ledger_amount: 100,
            ledger_currency: "PLN",
            source_goal_id: "goal-1",
            type: "income"
          }
        ];
      }
    },
    listLedgerYears: () => {
      throw new Error("ledger years should not be read directly");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async funding totals");
    },
    openPlanningDb: () => {
      throw new Error("settings should be supplied by caller");
    }
  });

  const totals = await service.confirmedFundingTotalsAsync("household", "PLN", { ledger_currency: "PLN" });
  const sum = await service.sumConfirmedFundingAsync(
    "household",
    "source_goal_id",
    "goal-1",
    "PLN",
    { ledger_currency: "PLN" }
  );

  assert.equal(totals.source_goal_id.get("goal-1"), 20);
  assert.equal(totals.source_flex_id.get("flex-1"), 7);
  assert.equal(sum, 20);
});

test("confirmed ledger existence and newest date can read through the budget-store facade", async () => {
  const service = createCashflowLedgerService({
    budgetStore: {
      async listLedgerYears() {
        return [2025, 2026];
      },
      async listConfirmedTransactions(_budgetId, { ledgerYear }) {
        if (Number(ledgerYear) === 2025) return [];
        return [
          { id: "older", date: "2026-01-10", created_at: "2026-01-10T00:00:00Z" },
          { id: "newer", date: "2026-02-05", created_at: "2026-02-05T00:00:00Z" }
        ];
      }
    },
    listLedgerYears: () => {
      throw new Error("ledger years should not be read directly");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async ledger probes");
    },
    openPlanningDb: () => {
      throw new Error("settings should not be opened for async ledger probes");
    }
  });

  assert.equal(await service.hasAnyConfirmedTransactionsAsync("household"), true);
  assert.equal(await service.newestConfirmedTransactionDateAsync("household"), "2026-02-05");
});

test("ledger running-balance recalculation can write through the budget-store facade", async () => {
  let applied = null;
  const service = createCashflowLedgerService({
    budgetStore: {
      async listConfirmedTransactions() {
        return [
          {
            id: "income",
            amount: 100,
            buffered_fx_rate: 1,
            created_at: "2026-01-01T00:00:00Z",
            date: "2026-01-01",
            ledger_currency: "PLN",
            ledger_year: 2026,
            type: "income"
          },
          {
            id: "expense",
            amount: 30,
            buffered_fx_rate: 1,
            created_at: "2026-01-02T00:00:00Z",
            date: "2026-01-02",
            ledger_currency: "PLN",
            ledger_year: 2026,
            type: "expense"
          }
        ];
      },
      async updateConfirmedLedgerBalances(budgetId, updates) {
        applied = { budgetId, updates };
        return { updated: updates.length };
      }
    },
    listLedgerYears: () => {
      throw new Error("ledger years should not be read directly");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async balance recalculation");
    },
    openPlanningDb: () => {
      throw new Error("settings should be supplied by caller");
    }
  });

  const result = await service.recalculateLedgerRunningBalanceAsync("household", {
    ledgerCurrency: "PLN"
  });

  assert.equal(result.ok, true);
  assert.equal(result.updated, 2);
  assert.equal(applied.budgetId, "household");
  assert.deepEqual(applied.updates.map(update => ({
    id: update.id,
    ledgerAmount: update.ledgerAmount,
    runningBalance: update.runningBalance
  })), [
    { id: "income", ledgerAmount: 100, runningBalance: 100 },
    { id: "expense", ledgerAmount: 30, runningBalance: 70 }
  ]);
});

test("confirmed ledger balance and negative-insert checks can read through the budget-store facade", async () => {
  const service = createCashflowLedgerService({
    budgetStore: {
      async listConfirmedTransactions() {
        return [
          {
            id: "income",
            amount: 100,
            buffered_fx_rate: 1,
            created_at: "2026-01-01T00:00:00Z",
            date: "2026-01-01",
            ledger_currency: "PLN",
            running_balance_pln: 100,
            type: "income"
          },
          {
            id: "old-ledger",
            amount: 500,
            buffered_fx_rate: 1,
            created_at: "2026-01-01T00:00:00Z",
            date: "2026-01-01",
            ledger_currency: "EUR",
            running_balance_pln: 500,
            type: "income"
          }
        ];
      }
    },
    listLedgerYears: () => {
      throw new Error("ledger years should not be read directly");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async balance checks");
    },
    openPlanningDb: () => {
      throw new Error("settings should be supplied by caller");
    }
  });

  assert.equal(await service.latestConfirmedBalanceAsync("household", { ledgerCurrency: "PLN" }), 100);
  assert.equal(await service.wouldLedgerGoNegativeAfterInsertAsync("household", {
    id: "too-much",
    amount: 125,
    buffered_fx_rate: 1,
    created_at: "2026-01-02T00:00:00Z",
    date: "2026-01-02",
    type: "expense"
  }, { ledgerCurrency: "PLN" }), true);
  assert.equal(await service.wouldLedgerGoNegativeAfterInsertAsync("household", {
    id: "ok",
    amount: 75,
    buffered_fx_rate: 1,
    created_at: "2026-01-02T00:00:00Z",
    date: "2026-01-02",
    type: "expense"
  }, { ledgerCurrency: "PLN" }), false);
});

test("pending funding can read planning rows through the budget-store facade", async () => {
  const service = createCashflowLedgerService({
    budgetStore: {
      async listPlanningRows(_budgetId, tableName) {
        assert.equal(tableName, "pending_transactions");
        return [
          {
            id: "stored",
            ledger_amount: 10,
            ledger_currency: "PLN",
            source_goal_id: "goal-1",
            type: "expense"
          },
          {
            id: "derived",
            amount: 5,
            buffered_fx_rate: 2,
            ledger_currency: "PLN",
            source_goal_id: "goal-1",
            type: "expense"
          },
          {
            id: "income-ignored",
            ledger_amount: 100,
            ledger_currency: "PLN",
            source_goal_id: "goal-1",
            type: "income"
          },
          {
            id: "currency-ignored",
            ledger_amount: 100,
            ledger_currency: "EUR",
            source_goal_id: "goal-1",
            type: "expense"
          }
        ];
      }
    },
    listLedgerYears: () => [],
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async pending funding");
    },
    openPlanningDb: () => {
      throw new Error("settings should be supplied by caller");
    }
  });

  const total = await service.sumPendingFundingAsync(
    "household",
    "source_goal_id",
    "goal-1",
    "PLN",
    { ledger_currency: "PLN" }
  );

  assert.equal(total, 20);
});

test("async ledger helpers read ledger currency from budget-store settings when not supplied", async () => {
  const planningTables = [];
  const service = createCashflowLedgerService({
    budgetStore: {
      async listPlanningRows(_budgetId, tableName) {
        planningTables.push(tableName);
        if (tableName === "settings") {
          return [{ id: 1, ledger_currency: "EUR" }];
        }
        if (tableName === "pending_transactions") {
          return [{
            id: "pending-eur",
            ledger_amount: 12,
            ledger_currency: "EUR",
            source_goal_id: "goal-1",
            type: "expense"
          }, {
            id: "pending-pln",
            ledger_amount: 99,
            ledger_currency: "PLN",
            source_goal_id: "goal-1",
            type: "expense"
          }];
        }
        return [];
      },
      async listConfirmedTransactions() {
        return [{
          id: "confirmed-eur",
          amount: 20,
          buffered_fx_rate: 1,
          created_at: "2026-01-02T00:00:00Z",
          date: "2026-01-02",
          ledger_amount: 20,
          ledger_currency: "EUR",
          source_goal_id: "goal-1",
          type: "expense"
        }, {
          id: "balance-eur",
          amount: 40,
          buffered_fx_rate: 1,
          created_at: "2026-01-01T00:00:00Z",
          date: "2026-01-01",
          ledger_currency: "EUR",
          running_balance_pln: 40,
          type: "income"
        }, {
          id: "confirmed-pln",
          amount: 99,
          buffered_fx_rate: 1,
          created_at: "2026-01-02T00:00:00Z",
          date: "2026-01-02",
          ledger_amount: 99,
          ledger_currency: "PLN",
          source_goal_id: "goal-1",
          type: "expense"
        }];
      }
    },
    listLedgerYears: () => {
      throw new Error("ledger years should not be read directly");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async ledger settings");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async ledger settings");
    }
  });

  assert.equal(await service.sumConfirmedFundingAsync("household", "source_goal_id", "goal-1"), 20);
  assert.equal(await service.sumPendingFundingAsync("household", "source_goal_id", "goal-1"), 12);
  assert.equal(await service.latestConfirmedBalanceAsync("household"), 20);
  assert.equal(await service.wouldLedgerGoNegativeAfterInsertAsync("household", {
    id: "expense",
    amount: 50,
    buffered_fx_rate: 1,
    created_at: "2026-01-02T00:00:00Z",
    date: "2026-01-02",
    type: "expense"
  }), true);
  assert.ok(planningTables.filter(table => table === "settings").length >= 4);
});
