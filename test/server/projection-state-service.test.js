import assert from "node:assert/strict";
import test from "node:test";

import {
  createCashflowProjectionStateService
} from "../../src/server/cashflow-projection-state-service.js";

function mapToPlainObject(map) {
  return Object.fromEntries([...map.entries()]);
}

test("projection state async helpers read through the budget-store facade", async () => {
  const calls = [];
  const rows = {
    settings: [{
      id: 1,
      ledger_currency: "EUR",
      timezone: "UTC"
    }],
    pending_transactions: [
      {
        id: "pending_expense",
        type: "expense",
        date: "2999-01-01",
        ledger_amount: 50,
        ledger_currency: "EUR",
        created_at: "2026-01-01T10:00:00.000Z"
      },
      {
        id: "pending_pln",
        type: "income",
        date: "2999-01-01",
        ledger_amount: 999,
        ledger_currency: "PLN",
        created_at: "2026-01-01T10:01:00.000Z"
      }
    ],
    future_transactions: [{
      id: "future_income",
      type: "income",
      date: "2999-01-02",
      ledger_amount: 25,
      ledger_currency: "EUR",
      created_at: "2026-01-01T10:02:00.000Z"
    }]
  };
  const confirmedRows = [
    {
      id: "confirmed_eur_income",
      amount: 200,
      buffered_fx_rate: 1,
      created_at: "2026-01-01T09:00:00.000Z",
      currency: "EUR",
      date: "2026-01-01",
      ledger_amount: 200,
      ledger_currency: "EUR",
      ledger_year: 2026,
      occurrence_key: "explicit:confirmed-income",
      running_balance_pln: 200,
      type: "income"
    },
    {
      id: "confirmed_eur_oneoff",
      amount: 50,
      buffered_fx_rate: 1,
      created_at: "2026-01-03T09:00:00.000Z",
      currency: "EUR",
      date: "2026-01-03",
      ledger_amount: 50,
      ledger_currency: "EUR",
      ledger_year: 2026,
      running_balance_pln: 150,
      source_one_off_id: "oneoff_trip",
      type: "expense"
    },
    {
      id: "confirmed_pln_income",
      amount: 999,
      buffered_fx_rate: 1,
      created_at: "2026-01-02T09:00:00.000Z",
      currency: "PLN",
      date: "2026-01-02",
      ledger_amount: 999,
      ledger_currency: "PLN",
      ledger_year: 2026,
      running_balance_pln: 999,
      type: "income"
    }
  ];
  const budgetStore = {
    async listConfirmedTransactions(budgetId, options = {}) {
      calls.push({ budgetId, method: "listConfirmedTransactions", options });
      return confirmedRows;
    },
    async listPlanningRows(budgetId, tableName) {
      calls.push({ budgetId, method: "listPlanningRows", tableName });
      return rows[tableName] || [];
    },
    async updatePlanningRowsById(budgetId, tableName, updates) {
      calls.push({ budgetId, method: "updatePlanningRowsById", tableName, updates });
      return { updated: updates.length };
    }
  };
  const service = createCashflowProjectionStateService({
    budgetStore,
    latestConfirmedBalance: () => {
      throw new Error("SQLite latest balance should not be used by async helpers");
    },
    listLedgerYears: () => {
      throw new Error("SQLite ledger years should not be used by async helpers");
    },
    loadAllConfirmedTransactions: () => {
      throw new Error("SQLite confirmed rows should not be used by async helpers");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened by async helpers");
    }
  });

  assert.deepEqual(
    [...await service.confirmedOccurrenceKeysAsync("household")].sort(),
    [
      "explicit:confirmed-income",
      "manual:confirmed_pln_income:income:2026-01-02",
      "one_off:oneoff_trip:expense:2026-01-03"
    ]
  );
  assert.deepEqual(mapToPlainObject(await service.confirmedOneOffProgressAsync("household")), {
    "oneoff_trip:expense:EUR": {
      confirmedAmount: 50,
      confirmedCount: 1,
      currency: "EUR",
      sourceId: "oneoff_trip",
      type: "expense"
    }
  });
  assert.equal(await service.confirmedBalanceAsOfAsync("household", "2026-01-02"), 200);
  assert.deepEqual(
    (await service.confirmedRowsAfterDateAsync("household", "2026-01-02")).map(row => row.id),
    ["confirmed_eur_oneoff"]
  );
  assert.equal(await service.findConfirmedOccurrenceAsync(
    "household",
    "one_off:oneoff_trip:expense:2026-01-03"
  )?.then(row => row.id), "confirmed_eur_oneoff");
  assert.equal(await service.pendingNetBalanceAsync("household"), -50);
  assert.equal(await service.planningOpeningBalanceAsync("household"), 100);
  assert.equal(await service.planningOpeningBalanceAsync("household", { includePending: false }), 150);

  const balanceResult = await service.recalculatePlanningRunningBalancesAsync("household");
  assert.deepEqual(balanceResult.plan.updates, [
    {
      bucket: "pending",
      id: "pending_pln",
      running_balance: null
    },
    {
      bucket: "pending",
      id: "pending_expense",
      running_balance: 100
    },
    {
      bucket: "future",
      id: "future_income",
      running_balance: 125
    }
  ]);
  assert.deepEqual(
    calls
      .filter(call => call.method === "updatePlanningRowsById")
      .map(call => ({
        tableName: call.tableName,
        updates: call.updates
      })),
    [
      {
        tableName: "pending_transactions",
        updates: [
          { id: "pending_pln", running_balance: null },
          { id: "pending_expense", running_balance: 100 }
        ]
      },
      {
        tableName: "future_transactions",
        updates: [
          { id: "future_income", running_balance: 125 }
        ]
      }
    ]
  );
});
