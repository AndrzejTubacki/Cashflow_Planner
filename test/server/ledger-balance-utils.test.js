import assert from "node:assert/strict";
import test from "node:test";

import {
  confirmedRowsWithRunningBalances,
  latestBalanceFromConfirmedRows,
  sortConfirmedRowsForBalance,
  storedOrComputedConfirmedLedgerAmount,
  wouldConfirmedRowsGoNegative
} from "../../src/server/cashflow-ledger-balance-utils.js";
import {
  applyLedgerRunningBalancePlan,
  createLedgerRunningBalancePlan
} from "../../src/server/cashflow-ledger-balance-plan.js";

test("confirmed ledger balance helper sorts rows and computes rounded ledger balances", () => {
  const rows = [
    {
      id: "b",
      amount: 50,
      buffered_fx_rate: 1,
      created_at: "2026-01-01T11:00:00.000Z",
      date: "2026-01-01",
      type: "expense"
    },
    {
      id: "a",
      amount: 100.005,
      buffered_fx_rate: 1,
      created_at: "2026-01-01T10:00:00.000Z",
      date: "2026-01-01",
      type: "income"
    },
    {
      id: "c",
      amount: 10,
      buffered_fx_rate: 4.123,
      created_at: "2026-01-02T10:00:00.000Z",
      date: "2026-01-02",
      type: "income"
    }
  ];

  assert.deepEqual(sortConfirmedRowsForBalance(rows).map(row => row.id), ["a", "b", "c"]);
  assert.deepEqual(
    confirmedRowsWithRunningBalances(rows).map(row => ({
      id: row.id,
      ledgerAmount: row.ledger_amount,
      runningBalance: row.running_balance_pln
    })),
    [
      { id: "a", ledgerAmount: 100.01, runningBalance: 100.01 },
      { id: "b", ledgerAmount: 50, runningBalance: 50.01 },
      { id: "c", ledgerAmount: 41.23, runningBalance: 91.24 }
    ]
  );
});

test("confirmed ledger balance helper preserves stored amount fallback semantics", () => {
  assert.equal(
    storedOrComputedConfirmedLedgerAmount({
      amount: 10,
      buffered_fx_rate: 99,
      ledger_amount: 12.345
    }),
    12.35
  );
  assert.equal(
    storedOrComputedConfirmedLedgerAmount({
      amount: 10,
      buffered_fx_rate: 2
    }),
    20
  );
});

test("confirmed ledger balance helper detects negative and latest balances", () => {
  const rows = [
    {
      id: "income",
      amount: 100,
      buffered_fx_rate: 1,
      created_at: "2026-01-01T10:00:00.000Z",
      date: "2026-01-01",
      type: "income"
    },
    {
      id: "expense",
      amount: 120,
      buffered_fx_rate: 1,
      created_at: "2026-01-02T10:00:00.000Z",
      date: "2026-01-02",
      type: "expense"
    }
  ];

  assert.equal(wouldConfirmedRowsGoNegative(rows), true);
  assert.equal(wouldConfirmedRowsGoNegative(rows, { openingBalance: 25 }), false);
  assert.equal(latestBalanceFromConfirmedRows(rows, { openingBalance: 25 }), 5);
  assert.equal(latestBalanceFromConfirmedRows([{
    ...rows[1],
    running_balance_pln: 77.777
  }]), 77.78);
});

test("ledger running balance plan reads through a budget store without mutating storage", async () => {
  const calls = [];
  const budgetStore = {
    async listPlanningRows(budgetId, tableName) {
      calls.push(["planning", budgetId, tableName]);
      return [{ ledger_currency: "EUR" }];
    },
    async listConfirmedTransactions(budgetId) {
      calls.push(["ledger", budgetId]);
      return [
        {
          id: "pln-row",
          amount: 100,
          buffered_fx_rate: 1,
          created_at: "2026-01-01T09:00:00.000Z",
          date: "2026-01-01",
          ledger_currency: "PLN",
          ledger_year: 2026,
          type: "income"
        },
        {
          id: "eur-income",
          amount: 200,
          buffered_fx_rate: 1,
          created_at: "2026-01-01T10:00:00.000Z",
          date: "2026-01-01",
          ledger_currency: "EUR",
          ledger_year: 2026,
          type: "income"
        },
        {
          id: "eur-expense",
          amount: 50,
          buffered_fx_rate: 1,
          created_at: "2026-01-02T10:00:00.000Z",
          date: "2026-01-02",
          ledger_currency: "EUR",
          ledger_year: 2026,
          type: "expense"
        }
      ];
    }
  };

  const plan = await createLedgerRunningBalancePlan({
    budgetId: "household",
    budgetStore
  });

  assert.deepEqual(calls, [
    ["planning", "household", "settings"],
    ["ledger", "household"]
  ]);
  assert.deepEqual(plan, {
    budgetId: "household",
    ledgerCurrency: "EUR",
    latestBalance: 150,
    updates: [
      {
        id: "eur-income",
        ledgerAmount: 200,
        ledgerYear: 2026,
        runningBalance: 200
      },
      {
        id: "eur-expense",
        ledgerAmount: 50,
        ledgerYear: 2026,
        runningBalance: 150
      }
    ]
  });
});

test("ledger running balance plan applies through a budget store writer", async () => {
  const calls = [];
  const budgetStore = {
    async updateConfirmedLedgerBalances(budgetId, updates) {
      calls.push({ budgetId, updates });
      return { updated: updates.length };
    }
  };
  const plan = {
    budgetId: "household",
    latestBalance: 25,
    ledgerCurrency: "PLN",
    updates: [
      {
        id: "a",
        ledgerAmount: 50,
        ledgerYear: 2026,
        runningBalance: 50
      },
      {
        id: "b",
        ledgerAmount: 25,
        ledgerYear: 2026,
        runningBalance: 25
      }
    ]
  };

  const result = await applyLedgerRunningBalancePlan({
    budgetStore,
    plan
  });

  assert.deepEqual(calls, [{
    budgetId: "household",
    updates: plan.updates
  }]);
  assert.deepEqual(result, {
    budgetId: "household",
    latestBalance: 25,
    ledgerCurrency: "PLN",
    ok: true,
    updated: 2
  });
});
