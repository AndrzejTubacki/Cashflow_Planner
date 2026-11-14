import { calculateSnapshot } from "../../src/engine/snapshot.js";

// Synthetic data only. No personal budget snapshots are used by engine tests.
export function completeSnapshot() {
  const request = projectionRequest();
  for (const name of ["planned_transactions", "recurring_expenses", "recurring_incomes", "flex_transactions",
    "goals", "pending_transactions", "future_transactions", "projection_snapshots"]) request.tables[name] = [];
  Object.assign(request, { predictionRows: [], confirmedRowsAfterToday: [], handledOccurrenceKeys: [],
    oneOffProgress: [], confirmedFunding: { source_goal_id: [], source_flex_id: [] }, fxSnapshot: null });
  return { snapshotVersion: 1, budgetId: "app-budget", revision: 0, request };
}

export function projectionRequest(overrides = {}) {
  return {
    protocolVersion: 1,
    today: "2026-06-01",
    generationTimestamp: "2026-06-01T00:00:00.000Z",
    idSeed: "fixture-1",
    openingBalance: 500,
    settings: { ledger_currency: "PLN", future_periods: 3 },
    tables: {
      one_off_transactions: [{ id: "one-1", name: "Rent", type: "expense", currency: "PLN", amount: 300, date: "2026-06-10" }]
    },
    ...overrides
  };
}

export function partialRequest() {
  return projectionRequest({
    openingBalance: 30,
    settings: { ledger_currency: "PLN", future_periods: 2,
      notify_necessary_underfunded: 1, notify_funding_shortfall: 1 },
    tables: {
      planned_transactions: [{ id: "plan-1", operating_priority: 1 }],
      recurring_expenses: [{ id: "expense-1", planned_transaction_id: "plan-1", active: 1,
        name: "Rent", currency: "PLN", amount: 100, necessary: 1, anchor_type: "day_of_month",
        anchor_day_of_month: 5, priority: 1, created_at: "2026-01-01" }]
    }
  });
}

export function reserveRequest() {
  return projectionRequest({
    openingBalance: 150,
    settings: { ledger_currency: "PLN", future_periods: 2 },
    tables: {
      planned_transactions: [{ id: "goal-plan", goal_priority: 1 }],
      goals: [{ id: "goal-1", planned_transaction_id: "goal-plan", active: 1,
        name: "Trip", currency: "PLN", amount: 150, due_date: "2026-06-20", created_at: "2026-01-01" }],
      one_off_transactions: [{ id: "bill-1", name: "July bill", type: "expense", currency: "PLN",
        amount: 100, date: "2026-07-10" }]
    }
  });
}

export function engineFixtures() {
  const history = partialRequest();
  history.tables.recurring_expenses[0].prediction_strategy = "12month_max";
  history.predictionRows = [{ id: "history-1", type: "expense", source_recurring_expense_id: "expense-1",
    amount: 120, currency: "PLN", date: "2026-05-05", created_at: "2026-05-05T00:00:00.000Z" }];
  const pending = projectionRequest({
    openingBalance: 500, handledOccurrenceKeys: ["one_off:one-1:expense:2026-06-10"],
    oneOffProgress: [["one-1:expense:PLN", { sourceId: "one-1", type: "expense", currency: "PLN",
      confirmedAmount: 100, confirmedCount: 1 }]],
    confirmedRowsAfterToday: [{ id: "confirmed-1", type: "expense", amount: 100, ledger_amount: 100,
      currency: "PLN", ledger_currency: "PLN", date: "2026-06-10", source_one_off_id: "one-1" }]
  });
  pending.tables.pending_transactions = [{ id: "pending-1", name: "Rent", type: "expense", amount: 200,
    ledger_amount: 200, currency: "PLN", ledger_currency: "PLN", source_one_off_id: "one-1",
    date: "2026-06-10", occurrence_key: "one_off:one-1:expense:2026-06-10" }];
  const fx = projectionRequest({ fxSnapshot: { "eur/pln": { rate: 4, source: "manual" } },
    settings: { ledger_currency: "PLN", future_periods: 3, fx_buffer_percent: 10,
      minimum_reserve_enabled: 1, minimum_reserve_amount: 50.005 } });
  fx.tables.one_off_transactions[0].currency = "EUR";
  fx.tables.one_off_transactions[0].amount = 50;
  const anchored = projectionRequest({ settings: { ledger_currency: "PLN", future_periods: 3,
    budget_period_income_id: "salary" } });
  anchored.tables.recurring_incomes = [{ id: "salary", active: 1, name: "Salary", amount: 1000,
    currency: "PLN", anchor_type: "day_of_month", anchor_day_of_month: 10, created_at: "2026-01-01" }];
  anchored.predictionRows = [{ id: "salary-history", source_recurring_income_id: "salary", type: "income",
    currency: "PLN", amount: 1000, date: "2026-05-12", occurrence_key: "recurring_income:salary:income:2026-05-10" }];
  const funded = reserveRequest();
  funded.confirmedFunding = { source_goal_id: [["goal-1", 25]], source_flex_id: [] };
  // Expense following an income's date plus offset (standalone income anchors).
  const incomeAnchor = projectionRequest();
  incomeAnchor.tables.recurring_incomes = [{ id: "pay", active: 1, name: "Pay", amount: 900, currency: "PLN",
    anchor_type: "day_of_month", anchor_day_of_month: 20, created_at: "2026-01-01" }];
  incomeAnchor.tables.planned_transactions = [{ id: "rent-plan", operating_priority: 1 }];
  incomeAnchor.tables.recurring_expenses = [{ id: "rent", active: 1, necessary: 1, name: "Rent", amount: 200, currency: "PLN",
    anchor_type: "day_of_month", anchor_day_of_month: 1, anchor_income_id: "pay", anchor_offset_days: 2,
    planned_transaction_id: "rent-plan", created_at: "2026-01-01" }];
  // Split flex with a minimum and no maximum (uncapped).
  const uncapped = projectionRequest();
  uncapped.tables.planned_transactions = [{ id: "flex-plan", operating_priority: 1 }];
  uncapped.tables.flex_transactions = [{ id: "flex", active: 1, name: "Leisure", amount: 150, currency: "PLN", allow_split: 1,
    min_amount: 40, max_amount: null, planned_transaction_id: "flex-plan", created_at: "2026-01-01" }];
  return [projectionRequest(), partialRequest(), reserveRequest(), history, pending, fx, anchored, funded, incomeAnchor, uncapped];
}

/**
 * Deterministic standalone commands added for Android (actual-date, early and
 * foreign payments, rate-changing corrections, anchor fallback days, period
 * summaries). Hosts must reproduce each Node result exactly.
 */
export function localCommandFixtures({ refresh, confirm, correct }) {
  const today = "2026-06-10";
  const timing = { today, generationTimestamp: `${today}T12:00:00.000Z` };
  const base = completeSnapshot();
  base.budgetId = "local-command-parity";
  Object.assign(base.request, timing, { openingBalance: 2000, fxSnapshot: { "eur/pln": { rate: 4.3, source: "manual", effectiveDate: "2026-06-09" } } });
  base.request.settings = { ...base.request.settings, ledger_currency: "PLN", fx_buffer_percent: 2, budget_period_income_id: "pay" };
  Object.assign(base.request.tables, {
    one_off_transactions: [
      { id: "hotel", name: "Hotel", amount: 100, currency: "EUR", date: today, type: "expense" },
      { id: "trip", name: "Trip", amount: 300, currency: "PLN", date: "2026-07-01", type: "expense" }],
    recurring_incomes: [{ id: "pay", name: "Pay", amount: 900, currency: "PLN", active: 1, period_setting: 1, prediction_strategy: "fixed",
      repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 20, anchor_offset_days: 0, anchor_business_day_adjustment: "none" }],
    recurring_expenses: [{ id: "rent", name: "Rent", amount: 200, currency: "PLN", active: 1, necessary: 1, planned_transaction_id: "rent-plan",
      prediction_strategy: "12month_max", prediction_substitute_missing: "median_recorded", prediction_min_recorded_months: 6,
      repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 1, anchor_income_id: "pay", anchor_offset_days: 2,
      anchor_business_day_adjustment: "none" }],
    planned_transactions: [{ id: "rent-plan", operating_priority: 1 }]
  });
  const snapshot = refresh({ snapshot: base, ...base.request });
  const key = id => [...calculateSnapshot(snapshot).plan.pendingRows, ...calculateSnapshot(snapshot).plan.futureRows]
    .find(row => row.source_one_off_id === id).occurrence_key;
  const foreign = { snapshot, occurrenceKey: key("hotel"), ...timing, idSeed: "parity-foreign", amount: 80, actualDate: "2026-06-08", fxRate: 4.25 };
  const paid = confirm(foreign);
  const early = { snapshot: paid, occurrenceKey: key("trip"), ...timing, idSeed: "parity-early", early: true, amount: 120 };
  const correction = { snapshot: paid, confirmationId: paid.localHistory[0].id, expectedCorrectionId: null, reason: "Bank rate",
    replacement: { amount: 80, date: "2026-06-08", fx_rate: 4.4 }, ...timing, idSeed: "parity-correction" };
  correct(correction);
  const goalBase = completeSnapshot(); goalBase.budgetId = "local-goal-command-parity";
  goalBase.request.tables.one_off_transactions = [];
  goalBase.request.tables.planned_transactions = [{ id: "goal-plan", goal_priority: 1 }];
  goalBase.request.tables.goals = [{ id: "goal", name: "Goal", currency: "PLN", amount: 700,
    active: 1, planned_transaction_id: "goal-plan", due_date: "2026-06-01" }];
  const goalPlan = calculateSnapshot(goalBase).plan;
  const goalRow = [...goalPlan.pendingRows, ...goalPlan.futureRows].find(row => row.source_goal_id === "goal");
  const goalPaid = confirm({ snapshot: goalBase, ...goalBase.request, occurrenceKey: goalRow.occurrence_key, amount: 200, idSeed: "goal" });
  const lateGoal = refresh({ snapshot: goalPaid, ...timing, idSeed: "late-goal" });
  const lateInput = { snapshot: lateGoal, ...timing, confirmationId: "confirmed-goal", expectedCorrectionId: null,
    replacement: { amount: 250, date: "2026-06-08" }, reason: "Actual payment after deadline", idSeed: "late-goal" };
  const changedGoal = correct(lateInput);
  const voidInput = { ...lateInput, snapshot: changedGoal, replacement: null, expectedCorrectionId: "correction-late-goal", idSeed: "void-goal" };
  const restoreInput = { ...lateInput, snapshot: correct(voidInput), expectedCorrectionId: "correction-void-goal", idSeed: "restore-goal" };
  return [
    { method: "correctLocalConfirmationJson", input: lateInput },
    { method: "correctLocalConfirmationJson", input: voidInput },
    { method: "correctLocalConfirmationJson", input: restoreInput },
    { method: "confirmLocalOccurrenceJson", input: foreign },
    { method: "confirmLocalOccurrenceJson", input: early },
    { method: "correctLocalConfirmationJson", input: correction },
    { method: "localAnchorFallbackDaysJson", input: { snapshot: paid, incomeId: "pay" } },
    { method: "localPeriodSummariesJson", input: { snapshot: paid } }
  ];
}