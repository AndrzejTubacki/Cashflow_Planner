import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowSnapshotService } from "../../src/server/cashflow-snapshot-service.js";

test("snapshot can read planning and ledger rows through async facades", async () => {
  const calls = [];
  const planningRows = {
    settings: [{
      id: 1,
      future_periods: 1,
      ledger_currency: "PLN",
      locale: "en",
      timezone: "UTC"
    }],
    planned_transactions: [
      { id: "goal-plan", goal_priority: 2, operating_priority: 0 },
      { id: "flex-plan", goal_priority: 0, operating_priority: 1 },
      { id: "expense-plan", goal_priority: 0, operating_priority: 3 }
    ],
    recurring_incomes: [{
      id: "income-1",
      active: 1,
      amount: 1000,
      anchor_day_of_month: 1,
      currency: "PLN",
      name: "Salary",
      repeat_every_months: 1
    }],
    recurring_expenses: [{
      id: "expense-1",
      active: 1,
      amount: 100,
      currency: "PLN",
      name: "Rent",
      planned_transaction_id: "expense-plan",
      prediction_strategy: "fixed"
    }],
    pending_transactions: [{
      id: "pending-goal",
      amount: 10,
      date: "2026-01-05",
      created_at: "2026-01-05T00:00:00Z",
      currency: "PLN",
      ledger_amount: 10,
      ledger_currency: "PLN",
      name: "Goal pending",
      source_goal_id: "goal-1",
      status: "funded",
      type: "expense"
    }],
    future_transactions: [{
      id: "future-goal",
      amount: 15,
      date: "2026-01-10",
      period: "2026-01",
      created_at: "2026-01-10T00:00:00Z",
      currency: "PLN",
      ledger_amount: 15,
      ledger_currency: "PLN",
      name: "Goal future",
      source_goal_id: "goal-1",
      status: "funded",
      type: "expense"
    }],
    one_off_transactions: [{
      id: "oneoff-1",
      amount: 20,
      created_at: "2026-01-02T00:00:00Z",
      currency: "PLN",
      date: "2026-01-02",
      name: "One-off",
      type: "expense"
    }],
    goals: [{
      id: "goal-1",
      amount: 100,
      currency: "PLN",
      name: "Goal",
      planned_transaction_id: "goal-plan"
    }],
    flex_transactions: [{
      id: "flex-1",
      amount: 50,
      currency: "PLN",
      name: "Flex",
      planned_transaction_id: "flex-plan"
    }],
    event_log: [{
      id: "event-1",
      action: "goal_impossible",
      details: "Not enough balance",
      entity_id: "goal-1",
      timestamp: "2026-01-11T00:00:00Z"
    }],
    projection_snapshots: [{
      id: "snapshot-1",
      snapshot_timestamp: "2026-01-12T00:00:00Z"
    }]
  };
  const confirmedRows = [{
    id: "confirmed-goal",
    amount: 20,
    buffered_fx_rate: 1,
    created_at: "2026-01-03T00:00:00Z",
    currency: "PLN",
    date: "2026-01-03",
    ledger_amount: 20,
    ledger_currency: "PLN",
    running_balance_pln: 80,
    source_goal_id: "goal-1",
    type: "expense"
  }];
  const service = createCashflowSnapshotService({
    budgetStore: {
      async listPlanningRows(budgetId, tableName) {
        calls.push({ budgetId, tableName });
        return planningRows[tableName] || [];
      }
    },
    buildBudgetPeriods: () => [{
      id: "period-1",
      start: "2026-01-01",
      end: "2026-01-31"
    }],
    buildPeriodSummariesFromDefinitions: (_settings, _incomes, futureRows, options) => [{
      futureCount: futureRows.length,
      pendingCount: options.pendingTransactions.length
    }],
    confirmedFundingTotalsAsync: async () => ({
      source_flex_id: new Map(),
      source_goal_id: new Map([["goal-1", 20]])
    }),
    getCachedFxSnapshotAsync: async () => ({
      pln: {
        currency: "PLN",
        rate: 1,
        effectiveDate: "2026-01-01",
        source: "static"
      },
      "pln/pln": {
        currency: "PLN",
        baseCurrency: "PLN",
        quoteCurrency: "PLN",
        rate: 1,
        effectiveDate: "2026-01-01",
        source: "same-currency"
      }
    }),
    getCachedFxSnapshot: () => {
      throw new Error("sync FX snapshot should not be used");
    },
    listAvailableLocales: () => [{ id: "en", label: "English" }],
    loadAllConfirmedTransactionsAsync: async () => confirmedRows,
    loadAllConfirmedTransactions: () => {
      throw new Error("sync confirmed ledger reader should not be used");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async snapshot");
    },
    predictedAmountForRecurringExpense: () => {
      throw new Error("sync recurring prediction should not be used");
    },
    predictedAmountForRecurringExpenseAsync: async (_userId, expense) => expense.amount,
    safeGetCurrentFxSnapshot: () => {
      throw new Error("sync safe FX snapshot should not be used");
    },
    safeGetCurrentFxSnapshotAsync: async () => null,
    sumConfirmedFunding: () => {
      throw new Error("sync confirmed funding should not be used");
    }
  });

  const snapshot = await service.getSnapshotAsync("household");

  assert.equal(snapshot.settings.ledger_currency, "PLN");
  assert.equal(snapshot.recurringExpenses[0].priority, 3);
  assert.equal(snapshot.goals[0].priority, 2);
  assert.equal(snapshot.goals[0].already_funded, 20);
  assert.equal(snapshot.goals[0].future_allocated, 15);
  assert.equal(snapshot.goals[0].pending_allocated, 10);
  assert.equal(snapshot.goals[0].remaining, 55);
  assert.equal(snapshot.goals[0].warning, "Not enough balance");
  assert.equal(snapshot.latestProjectionSnapshot.id, "snapshot-1");
  assert.equal(snapshot.periodSummaries[0].futureCount, 1);
  assert.deepEqual(calls.map(call => call.tableName), [
    "settings",
    "recurring_incomes",
    "pending_transactions",
    "recurring_expenses",
    "planned_transactions",
    "future_transactions",
    "one_off_transactions",
    "goals",
    "flex_transactions",
    "event_log",
    "projection_snapshots"
  ]);
});
