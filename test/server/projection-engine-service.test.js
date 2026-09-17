import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProjectionGenerationPlanToBudgetStore,
  buildFutureProjectionSummaryFromRows,
  buildProjectionFundingState,
  buildProjectionInputRowsFromPlanningTables,
  computeGoalAndFlexTargetLedgerAmounts,
  computeProjectionPlan,
  loadProjectionFundingStateFromBudgetStore,
  loadProjectionInputRowsFromBudgetStore,
  makeProjectionConverter
} from "../../src/server/cashflow-projection-engine-service.js";
import { makeOccurrenceKey } from "../../src/server/cashflow-occurrence-utils.js";

test("projection input helper mirrors active planning joins and ordering", () => {
  const rows = buildProjectionInputRowsFromPlanningTables({
    settings: {
      budget_period_income_id: "income-period"
    },
    tables: {
      flex_transactions: [
        { id: "flex-missing-plan", active: 1, planned_transaction_id: "missing", created_at: "2026-01-01" },
        { id: "flex-b", active: true, planned_transaction_id: "plan-flex-b", created_at: "2026-01-02" },
        { id: "flex-a", active: 1, planned_transaction_id: "plan-flex-a", created_at: "2026-01-03" }
      ],
      goals: [
        { id: "goal-b", active: 1, planned_transaction_id: "plan-goal-b", created_at: "2026-01-02" },
        { id: "goal-a", active: 1, planned_transaction_id: "plan-goal-a", created_at: "2026-01-03" },
        { id: "goal-inactive", active: 0, planned_transaction_id: "plan-goal-inactive", created_at: "2026-01-01" }
      ],
      one_off_transactions: [
        { id: "oneoff-b", date: "2026-02-01", created_at: "2026-01-02" },
        { id: "oneoff-a", date: "2026-01-31", created_at: "2026-01-03" }
      ],
      pending_transactions: [
        { source_recurring_income_id: "other", type: "income", date: "2026-02-01", occurrence_key: "other-key" },
        { source_recurring_income_id: "income-period", type: "expense", date: "2026-02-01", occurrence_key: "expense-key" },
        { source_recurring_income_id: "income-period", type: "income", date: "2026-01-29", occurrence_key: "period-key" }
      ],
      planned_transactions: [
        { id: "plan-expense-b", operating_priority: 2 },
        { id: "plan-expense-a", operating_priority: 1 },
        { id: "plan-flex-b", operating_priority: 3 },
        { id: "plan-flex-a", operating_priority: 2 },
        { id: "plan-goal-b", goal_priority: 2 },
        { id: "plan-goal-a", goal_priority: 1 }
      ],
      projection_snapshots: [
        { id: "older", snapshot_timestamp: "2026-01-01T00:00:00.000Z" },
        { id: "newer", snapshot_timestamp: "2026-01-02T00:00:00.000Z" }
      ],
      recurring_expenses: [
        { id: "expense-b", active: 1, planned_transaction_id: "plan-expense-b", created_at: "2026-01-02" },
        { id: "expense-inactive", active: 0, planned_transaction_id: "plan-expense-a", created_at: "2026-01-01" },
        { id: "expense-a", active: true, planned_transaction_id: "plan-expense-a", created_at: "2026-01-03" }
      ],
      recurring_incomes: [
        { id: "income-b", active: 1, anchor_day_of_month: 15, created_at: "2026-01-02" },
        { id: "income-a", active: true, anchor_day_of_month: 1, created_at: "2026-01-03" },
        { id: "income-inactive", active: 0, anchor_day_of_month: 1, created_at: "2026-01-01" }
      ]
    }
  });

  assert.deepEqual(rows.recurringExpenses.map(row => [row.id, row.priority]), [
    ["expense-a", 1],
    ["expense-b", 2]
  ]);
  assert.deepEqual(rows.recurringIncomes.map(row => row.id), ["income-a", "income-b"]);
  assert.deepEqual(rows.flexes.map(row => [row.id, row.priority]), [
    ["flex-a", 2],
    ["flex-b", 3]
  ]);
  assert.deepEqual(rows.goals.map(row => [row.id, row.priority]), [
    ["goal-a", 1],
    ["goal-b", 2]
  ]);
  assert.deepEqual(rows.oneOffs.map(row => row.id), ["oneoff-a", "oneoff-b"]);
  assert.deepEqual(rows.pendingPeriodIncomeRows, [{
    source_recurring_income_id: "income-period",
    type: "income",
    date: "2026-01-29",
    occurrence_key: "period-key"
  }]);
  assert.equal(rows.previousSnapshot.id, "newer");
});

test("projection input loader reads needed planning tables through budget store", async () => {
  const calls = [];
  const data = {
    settings: [{
      id: 1,
      budget_period_income_id: "income-period",
      ledger_currency: "PLN"
    }],
    planned_transactions: [
      { id: "plan-expense", operating_priority: 1 }
    ],
    recurring_expenses: [
      { id: "expense", active: 1, planned_transaction_id: "plan-expense", created_at: "2026-01-01" }
    ],
    recurring_incomes: [
      { id: "income-period", active: 1, anchor_day_of_month: 1, created_at: "2026-01-01" }
    ],
    flex_transactions: [],
    goals: [],
    one_off_transactions: [],
    pending_transactions: [
      { source_recurring_income_id: "income-period", type: "income", date: "2026-01-29", occurrence_key: "period-key" }
    ],
    projection_snapshots: [
      { id: "snapshot", snapshot_timestamp: "2026-01-02T00:00:00.000Z" }
    ]
  };

  const loaded = await loadProjectionInputRowsFromBudgetStore({
    budgetId: "household",
    budgetStore: {
      async listPlanningRows(budgetId, tableName) {
        calls.push({ budgetId, tableName });
        return data[tableName] || [];
      }
    }
  });

  assert.equal(loaded.settings.ledger_currency, "PLN");
  assert.deepEqual(loaded.recurringExpenses.map(row => [row.id, row.priority]), [["expense", 1]]);
  assert.deepEqual(loaded.recurringIncomes.map(row => row.id), ["income-period"]);
  assert.deepEqual(loaded.pendingPeriodIncomeRows.map(row => row.occurrence_key), ["period-key"]);
  assert.equal(loaded.previousSnapshot.id, "snapshot");
  assert.deepEqual(calls.map(call => call.tableName).sort(), [
    "flex_transactions",
    "goals",
    "one_off_transactions",
    "pending_transactions",
    "planned_transactions",
    "projection_snapshots",
    "recurring_expenses",
    "recurring_incomes",
    "settings"
  ]);
});

test("projection funding state is built from backend-neutral row sets", () => {
  const state = buildProjectionFundingState({
    ledgerCurrency: "EUR",
    goals: [
      { id: "goal-funded" },
      { id: "goal-open" }
    ],
    flexes: [
      { id: "flex-a" }
    ],
    goalTargetLedger: new Map([
      ["goal-funded", 100],
      ["goal-open", 100]
    ]),
    flexTargetLedger: new Map([
      ["flex-a", 80]
    ]),
    confirmedFunding: {
      source_goal_id: new Map([
        ["goal-funded", 40],
        ["goal-open", 10]
      ]),
      source_flex_id: new Map([
        ["flex-a", 20]
      ])
    },
    pendingRows: [
      {
        id: "pending-goal-funded",
        ledger_amount: 30,
        ledger_currency: "EUR",
        source_goal_id: "goal-funded",
        type: "expense"
      },
      {
        id: "pending-flex",
        ledger_amount: 15,
        ledger_currency: "EUR",
        source_flex_id: "flex-a",
        type: "expense"
      },
      {
        id: "pending-wrong-currency",
        ledger_amount: 999,
        ledger_currency: "PLN",
        source_goal_id: "goal-funded",
        type: "expense"
      },
      {
        id: "pending-income",
        ledger_amount: 999,
        ledger_currency: "EUR",
        source_goal_id: "goal-funded",
        type: "income"
      }
    ],
    futureRows: [
      {
        id: "future-goal-funded",
        ledger_amount: 30,
        ledger_currency: "EUR",
        source_goal_id: "goal-funded"
      },
      {
        id: "future-goal-open",
        ledger_amount: 20,
        ledger_currency: "EUR",
        source_goal_id: "goal-open"
      },
      {
        id: "future-wrong-currency",
        ledger_amount: 999,
        ledger_currency: "PLN",
        source_goal_id: "goal-funded"
      }
    ]
  });

  assert.equal(state.confirmedGoalFunding.get("goal-funded"), 40);
  assert.equal(state.pendingGoalFunding.get("goal-funded"), 30);
  assert.equal(state.confirmedFlexFunding.get("flex-a"), 20);
  assert.equal(state.pendingFlexFunding.get("flex-a"), 15);
  assert.equal(state.generatedFlexFunding.get("flex-a"), 0);
  assert.deepEqual([...state.previouslyFullyFundedGoals], ["goal-funded"]);
});

test("projection funding state loader reads through the budget-store facade", async () => {
  const calls = [];
  const budgetStore = {
    async listLedgerYears(budgetId) {
      calls.push(["years", budgetId]);
      return [2025, 2026];
    },
    async listConfirmedTransactions(budgetId, options = {}) {
      calls.push(["confirmed", budgetId, options.ledgerYear]);
      return options.ledgerYear === 2026
        ? [{
            id: "confirmed-goal",
            ledger_amount: 45,
            ledger_currency: "EUR",
            source_goal_id: "goal-a",
            type: "expense"
          }]
        : [{
            id: "confirmed-old-currency",
            ledger_amount: 999,
            ledger_currency: "PLN",
            source_goal_id: "goal-a",
            type: "expense"
          }];
    },
    async listPlanningRows(budgetId, tableName) {
      calls.push(["planning", budgetId, tableName]);
      if (tableName === "pending_transactions") {
        return [{
          id: "pending-flex",
          ledger_amount: 15,
          ledger_currency: "EUR",
          source_flex_id: "flex-a",
          type: "expense"
        }];
      }
      if (tableName === "future_transactions") {
        return [{
          id: "future-goal",
          ledger_amount: 55,
          ledger_currency: "EUR",
          source_goal_id: "goal-a",
          type: "goal_allocation"
        }];
      }
      return [];
    }
  };

  const state = await loadProjectionFundingStateFromBudgetStore({
    budgetId: "household",
    budgetStore,
    ledgerCurrency: "EUR",
    goals: [{ id: "goal-a" }],
    flexes: [{ id: "flex-a" }],
    goalTargetLedger: new Map([["goal-a", 100]]),
    flexTargetLedger: new Map([["flex-a", 50]])
  });

  assert.equal(state.confirmedGoalFunding.get("goal-a"), 45);
  assert.equal(state.pendingFlexFunding.get("flex-a"), 15);
  assert.deepEqual([...state.previouslyFullyFundedGoals], ["goal-a"]);
  assert.deepEqual(calls, [
    ["planning", "household", "pending_transactions"],
    ["planning", "household", "future_transactions"],
    ["years", "household"],
    ["confirmed", "household", 2025],
    ["confirmed", "household", 2026]
  ]);
});

test("future projection summary is calculated from generated row sets", () => {
  assert.deepEqual(buildFutureProjectionSummaryFromRows([
    { ledger_amount: 100, status: "funded", type: "income" },
    { ledger_amount: 40.125, status: "funded", type: "expense" },
    { ledger_amount: 5, status: "partial", type: "expense" },
    { ledger_amount: 6, status: "underfunded", type: "goal_allocation" }
  ]), {
    totalProjectedExpenses: 51.13,
    totalProjectedIncome: 100,
    warningCount: 2
  });
});

test("projection generation plan applies through a budget-store transaction", async () => {
  const calls = [];
  const repo = {
    async deletePendingTransactionsByOccurrenceKeys(budgetId, keys) {
      calls.push(["delete-pending", budgetId, keys]);
      return { deleted: keys.length };
    },
    async deleteProjectionEventLogs(budgetId, actions) {
      calls.push(["delete-events", budgetId, actions]);
      return { deleted: actions.length };
    },
    async insertPlanningRows(budgetId, tableName, rows) {
      calls.push(["insert-planning", budgetId, tableName, rows.length]);
      return { inserted: rows.length };
    },
    async replacePlanningRows(budgetId, tableName, rows) {
      calls.push(["replace-planning", budgetId, tableName, rows.length]);
      return { inserted: rows.length, replaced: true };
    },
    async upsertNotifications(budgetId, rows) {
      calls.push(["upsert-notifications", budgetId, rows.length]);
      return { upserted: rows.length };
    }
  };
  const writer = {
    async transaction(fn) {
      calls.push(["begin"]);
      const result = await fn(repo);
      calls.push(["commit"]);
      return result;
    }
  };

  const result = await applyProjectionGenerationPlanToBudgetStore({
    budgetId: "household",
    budgetStore: writer,
    plan: {
      deletePendingOccurrenceKeys: ["confirmed-key"],
      eventActionsToClear: ["funding_shortfall"],
      eventRows: [{ id: "event-1" }],
      futureRows: [{ id: "future-1" }, { id: "future-2" }],
      notificationRows: [{ id: "notification-1" }],
      pendingRows: [{ id: "pending-1" }],
      projectionSnapshotRows: [{ id: "snapshot-1" }]
    }
  });

  assert.deepEqual(calls, [
    ["begin"],
    ["delete-pending", "household", ["confirmed-key"]],
    ["replace-planning", "household", "future_transactions", 2],
    ["delete-events", "household", ["funding_shortfall"]],
    ["insert-planning", "household", "pending_transactions", 1],
    ["insert-planning", "household", "event_log", 1],
    ["upsert-notifications", "household", 1],
    ["insert-planning", "household", "projection_snapshots", 1],
    ["commit"]
  ]);
  assert.deepEqual(result, {
    eventRowsInserted: 1,
    futureRowsInserted: 2,
    futureSummary: {
      totalProjectedExpenses: 0,
      totalProjectedIncome: 0,
      warningCount: 0
    },
    notificationsUpserted: 1,
    ok: true,
    pendingOccurrencesDeleted: 1,
    pendingRowsInserted: 1,
    projectionEventsDeleted: 1,
    projectionSnapshotsInserted: 1
  });
});

test("projection generation plan rolls back the store transaction on failure", async () => {
  const calls = [];
  const writer = {
    async transaction(fn) {
      calls.push("begin");
      try {
        const result = await fn({
          async deletePendingTransactionsByOccurrenceKeys() {
            calls.push("delete-pending");
            return { deleted: 0 };
          },
          async deleteProjectionEventLogs() {
            calls.push("delete-events");
            throw new Error("event cleanup failed");
          },
          async insertPlanningRows() {
            calls.push("insert-planning");
            return { inserted: 0 };
          },
          async replacePlanningRows() {
            calls.push("replace-future");
            return { inserted: 0 };
          },
          async upsertNotifications() {
            calls.push("upsert-notifications");
            return { upserted: 0 };
          }
        });
        calls.push("commit");
        return result;
      } catch (error) {
        calls.push("rollback");
        throw error;
      }
    }
  };

  await assert.rejects(
    () => applyProjectionGenerationPlanToBudgetStore({
      budgetId: "household",
      budgetStore: writer,
      plan: {}
    }),
    /event cleanup failed/
  );
  assert.deepEqual(calls, ["begin", "delete-pending", "replace-future", "delete-events", "rollback"]);
});

function samePlnConverter() {
  return makeProjectionConverter({ settings: {}, fxSnapshot: null, ledgerCurrency: "PLN" });
}

function emptyFundingState(overrides = {}) {
  return {
    confirmedFlexFunding: new Map(),
    confirmedGoalFunding: new Map(),
    generatedFlexFunding: new Map(),
    pendingFlexFunding: new Map(),
    pendingGoalFunding: new Map(),
    previouslyFullyFundedGoals: new Set(),
    ...overrides
  };
}

function basePlanArgs(overrides = {}) {
  let counter = 0;
  return {
    confirmedRowsAfterToday: [],
    convert: samePlnConverter(),
    flexes: [],
    flexTargetLedger: new Map(),
    fundingState: emptyFundingState(),
    fxSnapshot: null,
    generateId: prefix => `${prefix}-${++counter}`,
    generationTimestamp: "2026-06-01T00:00:00.000Z",
    goals: [],
    goalTargetLedger: new Map(),
    handledOccurrenceKeys: new Set(),
    ledgerCurrency: "PLN",
    oneOffProgress: new Map(),
    oneOffs: [],
    openingBalance: 0,
    pendingRows: [],
    periods: [{ key: "2026-06", start: "2026-06-01", end: "2026-06-30", available: 0, blocked: false }],
    predictionRows: [],
    previousSnapshot: null,
    recurringExpenses: [],
    recurringIncomes: [],
    reserveFloor: 0,
    settings: {},
    today: "2026-06-01",
    ...overrides
  };
}

test("computeGoalAndFlexTargetLedgerAmounts converts each goal/flex target into the ledger currency", () => {
  const { goalTargetLedger, flexTargetLedger } = computeGoalAndFlexTargetLedgerAmounts({
    goals: [{ id: "goal-1", amount: 100, currency: "PLN" }],
    flexes: [{ id: "flex-1", amount: 50, currency: "PLN" }],
    convert: samePlnConverter()
  });

  assert.equal(goalTargetLedger.get("goal-1"), 100);
  assert.equal(flexTargetLedger.get("flex-1"), 50);
});

test("computeProjectionPlan funds a one-off expense from the opening balance", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    openingBalance: 500,
    oneOffs: [{ id: "oneoff-1", name: "Rent", type: "expense", currency: "PLN", amount: 300, date: "2026-06-10" }]
  }));

  assert.equal(plan.futureRows.length, 1);
  assert.equal(plan.futureRows[0].status, "funded");
  assert.equal(plan.futureRows[0].ledger_amount, 300);
  assert.equal(plan.futureRows[0].source_one_off_id, "oneoff-1");
  assert.equal(plan.notificationRows.length, 0);
  assert.equal(plan.deletePendingOccurrenceKeys.length, 0);
});

test("computeProjectionPlan marks an unaffordable one-off expense underfunded and blocks the rest of the period", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    openingBalance: 100,
    oneOffs: [{ id: "oneoff-1", name: "Big bill", type: "expense", currency: "PLN", amount: 300, date: "2026-06-10" }],
    recurringExpenses: [{
      id: "exp-1",
      name: "Rent",
      currency: "PLN",
      amount: 50,
      necessary: true,
      anchor_type: "day_of_month",
      anchor_day_of_month: 5,
      priority: 1,
      created_at: "2026-01-01"
    }],
    settings: { notify_funding_shortfall: 1 }
  }));

  const oneOffRow = plan.futureRows.find(row => row.source_one_off_id === "oneoff-1");
  assert.equal(oneOffRow.status, "underfunded");
  assert.equal(oneOffRow.funded_amount, 0);

  // The period was blocked by the underfunded one-off before the necessary
  // expense was reached, so it should not appear at all.
  assert.equal(plan.futureRows.some(row => row.source_recurring_expense_id === "exp-1"), false);
  assert.ok(plan.notificationRows.some(row => row.notification_type === "funding_shortfall"));
});

test("computeProjectionPlan partially funds a necessary recurring expense and queues warnings", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    openingBalance: 30,
    recurringExpenses: [{
      id: "exp-1",
      name: "Rent",
      currency: "PLN",
      amount: 100,
      necessary: true,
      anchor_type: "day_of_month",
      anchor_day_of_month: 5,
      priority: 1,
      created_at: "2026-01-01"
    }],
    settings: { notify_necessary_underfunded: 1, notify_funding_shortfall: 1 }
  }));

  const row = plan.futureRows.find(r => r.source_recurring_expense_id === "exp-1");
  assert.equal(row.status, "partial");
  assert.equal(row.funded_amount, 30);
  assert.ok(plan.notificationRows.some(n => n.notification_type === "necessary_underfunded"));
  assert.ok(plan.notificationRows.some(n => n.notification_type === "funding_shortfall"));
});

test("computeProjectionPlan records a goal_impossible event and notification when a goal cannot be funded", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    openingBalance: 0,
    goals: [{ id: "goal-1", name: "Vacation", currency: "PLN", amount: 1000, due_date: "2026-06-20", priority: 1, created_at: "2026-01-01" }],
    goalTargetLedger: new Map([["goal-1", 1000]]),
    settings: { notify_goal_impossible: 1 }
  }));

  assert.equal(plan.eventRows.length, 1);
  assert.equal(plan.eventRows[0].action, "goal_impossible");
  assert.equal(plan.eventRows[0].entity_id, "goal-1");
  assert.ok(plan.notificationRows.some(n => n.notification_type === "goal_impossible"));
});

test("computeProjectionPlan queues goal_funded once a goal's allocation reaches its target", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    openingBalance: 1000,
    goals: [{ id: "goal-1", name: "Vacation", currency: "PLN", amount: 500, due_date: "2026-06-20", priority: 1, created_at: "2026-01-01" }],
    goalTargetLedger: new Map([["goal-1", 500]]),
    settings: { notify_goal_funded: 1 }
  }));

  assert.ok(plan.futureRows.some(r => r.source_goal_id === "goal-1" && r.type === "goal_allocation"));
  assert.ok(plan.notificationRows.some(n => n.notification_type === "goal_funded"));
});

test("computeProjectionPlan does not re-notify goal_funded for an already fully funded goal", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    openingBalance: 1000,
    goals: [{ id: "goal-1", name: "Vacation", currency: "PLN", amount: 500, due_date: "2026-06-20", priority: 1, created_at: "2026-01-01" }],
    goalTargetLedger: new Map([["goal-1", 500]]),
    settings: { notify_goal_funded: 1 },
    fundingState: emptyFundingState({
      confirmedGoalFunding: new Map([["goal-1", 500]]),
      previouslyFullyFundedGoals: new Set(["goal-1"])
    })
  }));

  assert.equal(plan.notificationRows.filter(n => n.notification_type === "goal_funded").length, 0);
});

test("computeProjectionPlan funds a splittable flex transaction within its min/max bounds", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    openingBalance: 40,
    flexes: [{
      id: "flex-1", name: "Hobby", currency: "PLN", amount: 100,
      min_amount: 20, max_amount: 60, allow_split: true, priority: 1, created_at: "2026-01-01"
    }],
    flexTargetLedger: new Map([["flex-1", 100]])
  }));

  const row = plan.futureRows.find(r => r.source_flex_id === "flex-1");
  assert.ok(row);
  assert.equal(row.funded_amount, 40);
  assert.equal(row.status, "partial");
});

test("computeProjectionPlan skips a non-split flex transaction it cannot fully fund", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    openingBalance: 40,
    flexes: [{
      id: "flex-1", name: "Hobby", currency: "PLN", amount: 100,
      min_amount: 100, max_amount: 100, allow_split: false, priority: 1, created_at: "2026-01-01"
    }],
    flexTargetLedger: new Map([["flex-1", 100]])
  }));

  assert.equal(plan.futureRows.some(r => r.source_flex_id === "flex-1"), false);
});

test("computeProjectionPlan skips regenerating an occurrence that already has a pending row", () => {
  const occurrenceKey = makeOccurrenceKey({ type: "expense", date: "2026-06-15", sourceOneOffId: "oneoff-1" });
  const plan = computeProjectionPlan(basePlanArgs({
    openingBalance: 500,
    pendingRows: [{
      id: "pending-1",
      occurrence_key: occurrenceKey,
      ledger_currency: "PLN",
      ledger_amount: 50,
      type: "expense",
      date: "2026-06-15"
    }],
    oneOffs: [{ id: "oneoff-1", name: "Rent", type: "expense", currency: "PLN", amount: 50, date: "2026-06-15" }]
  }));

  assert.equal(plan.futureRows.length, 0);
  assert.equal(plan.pendingRows.length, 0);
  assert.equal(plan.deletePendingOccurrenceKeys.length, 0);
});

test("computeProjectionPlan deletes a pending row once its occurrence is confirmed", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    handledOccurrenceKeys: new Set(["confirmed-key"]),
    pendingRows: [{
      id: "pending-1",
      occurrence_key: "confirmed-key",
      ledger_currency: "PLN",
      ledger_amount: 50,
      type: "expense",
      date: "2026-06-15"
    }]
  }));

  assert.deepEqual(plan.deletePendingOccurrenceKeys, ["confirmed-key"]);
});

test("computeProjectionPlan cleans up a stale pending remainder when a one-off has been partially confirmed", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    openingBalance: 100,
    pendingRows: [{
      id: "pending-stale",
      occurrence_key: "stale-key",
      source_one_off_id: "oneoff-1",
      ledger_currency: "PLN",
      ledger_amount: 10,
      type: "expense",
      date: "2026-05-01"
    }],
    oneOffProgress: new Map([
      ["oneoff-1:expense:PLN", { sourceId: "oneoff-1", type: "expense", currency: "PLN", confirmedAmount: 40, confirmedCount: 1 }]
    ]),
    oneOffs: [{ id: "oneoff-1", name: "Bill", type: "expense", currency: "PLN", amount: 100, date: "2026-06-10" }]
  }));

  assert.ok(plan.deletePendingOccurrenceKeys.includes("stale-key"));
  const remainderRow = plan.futureRows.find(r => r.source_one_off_id === "oneoff-1");
  assert.ok(remainderRow);
  assert.equal(remainderRow.funded_amount, 60);
  assert.equal(remainderRow.occurrence_key, "one_off_remainder:oneoff-1:2");
});

test("computeProjectionPlan clears all pending rows for a one-off once its full amount is confirmed", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    pendingRows: [{
      id: "pending-stale",
      occurrence_key: "stale-key",
      source_one_off_id: "oneoff-1",
      ledger_currency: "PLN",
      ledger_amount: 999,
      type: "expense",
      date: "2026-05-01"
    }],
    oneOffProgress: new Map([
      ["oneoff-1:expense:PLN", { sourceId: "oneoff-1", type: "expense", currency: "PLN", confirmedAmount: 100, confirmedCount: 1 }]
    ]),
    oneOffs: [{ id: "oneoff-1", name: "Bill", type: "expense", currency: "PLN", amount: 100, date: "2026-06-10" }]
  }));

  assert.ok(plan.deletePendingOccurrenceKeys.includes("stale-key"));
  assert.equal(plan.futureRows.some(r => r.source_one_off_id === "oneoff-1"), false);
});

test("computeProjectionPlan queues an fx_changed notification when projection totals shift materially", () => {
  const plan = computeProjectionPlan(basePlanArgs({
    openingBalance: 500,
    oneOffs: [{ id: "oneoff-1", name: "Rent", type: "expense", currency: "PLN", amount: 300, date: "2026-06-10" }],
    fxSnapshot: { pln: { rate: 1 } },
    previousSnapshot: {
      fx_rates_used: JSON.stringify({ pln: { rate: 2 } }),
      total_projected_income: 0,
      total_projected_expenses: 0,
      available_balance: 0,
      warning_count: 0
    },
    settings: { notify_fx_changed: 1 }
  }));

  assert.ok(plan.notificationRows.some(n => n.notification_type === "fx_changed"));
});
