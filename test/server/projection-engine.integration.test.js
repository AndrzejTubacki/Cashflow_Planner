import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

async function withHarness(fn) {
  const harness = await createCashflowTestHarness();
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

async function configureManualFx(harness, extra = {}) {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      future_periods: 4,
      fx_buffer_percent: 10,
      fx_provider: "manual",
      fx_used_currencies: ["EUR"],
      manual_fx_rates: { EUR: 4 },
      ...extra
    }
  });
}

test("projection buffers only foreign-currency transactions", async () => withHarness(async harness => {
  await configureManualFx(harness);

  const income = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "PLN income",
      currency: "PLN",
      amount: 1000,
      type: "income",
      date: "2026-06-01"
    }
  });

  const plnExpense = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "PLN expense",
      currency: "PLN",
      amount: 100,
      type: "expense",
      date: "2026-06-02"
    }
  });

  const eurExpense = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "EUR expense",
      currency: "EUR",
      amount: 10,
      type: "expense",
      date: "2026-06-03"
    }
  });

  const snapshot = await harness.api("/api");
  const bySource = new Map(snapshot.futureTransactions.map(tx => [tx.source_one_off_id, tx]));

  assert.equal(bySource.get(income.id).ledger_amount, 1000);
  assert.equal(bySource.get(plnExpense.id).ledger_amount, 100);
  assert.equal(bySource.get(plnExpense.id).buffered_fx_rate, 1);
  assert.equal(bySource.get(eurExpense.id).ledger_amount, 44);
  assert.equal(bySource.get(eurExpense.id).fx_rate, 4);
  assert.equal(bySource.get(eurExpense.id).buffered_fx_rate, 4.4);
}));

test("recurring transactions generate one occurrence per eligible period", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 4, fx_buffer_percent: 0 });

  const income = await harness.api("/api/recurring-incomes", {
    method: "POST",
    body: {
      name: "Monthly salary",
      currency: "PLN",
      amount: 1000,
      prediction_strategy: "fixed",
      active: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 1,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  const expense = await harness.api("/api/recurring-expenses", {
    method: "POST",
    body: {
      name: "Monthly rent",
      currency: "PLN",
      amount: 100,
      prediction_strategy: "fixed",
      necessary: 1,
      active: 1,
      priority: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 2,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  const snapshot = await harness.api("/api");
  const incomeRows = snapshot.futureTransactions.filter(tx => tx.source_recurring_income_id === income.id);
  const expenseRows = snapshot.futureTransactions.filter(tx => tx.source_recurring_expense_id === expense.id);

  assert.equal(incomeRows.length, 3);
  assert.equal(expenseRows.length, 3);
  assert.equal(new Set(incomeRows.map(tx => tx.occurrence_key)).size, incomeRows.length);
  assert.equal(new Set(expenseRows.map(tx => tx.occurrence_key)).size, expenseRows.length);
  assert.deepEqual(incomeRows.map(tx => tx.date), ["2026-06-01", "2026-07-01", "2026-08-01"]);
  assert.deepEqual(expenseRows.map(tx => tx.date), ["2026-06-02", "2026-07-02", "2026-08-02"]);
}));

test("projection schedules recurring edge-case anchors once on expected dates", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 4, fx_buffer_percent: 0 });

  const income = await harness.api("/api/recurring-incomes", {
    method: "POST",
    body: {
      name: "Month-end income",
      currency: "PLN",
      amount: 1000,
      prediction_strategy: "fixed",
      active: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 31,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  const expense = await harness.api("/api/recurring-expenses", {
    method: "POST",
    body: {
      name: "Previous business month-end bill",
      currency: "PLN",
      amount: 100,
      prediction_strategy: "fixed",
      necessary: 1,
      active: 1,
      priority: 1,
      anchor_type: "month_end",
      anchor_offset_days: 0,
      anchor_business_day_adjustment: "previous",
      anchor_holiday_country: "PL",
      repeat_every_months: 1
    }
  });

  const snapshot = await harness.api("/api");
  const incomeRows = snapshot.futureTransactions.filter(tx => tx.source_recurring_income_id === income.id);
  const expenseRows = snapshot.futureTransactions.filter(tx => tx.source_recurring_expense_id === expense.id);

  assert.deepEqual(incomeRows.map(tx => tx.date), ["2026-06-30", "2026-07-31", "2026-08-31"]);
  assert.deepEqual(expenseRows.map(tx => tx.date), ["2026-05-29", "2026-06-30", "2026-07-31", "2026-08-31"]);
  assert.equal(new Set(incomeRows.map(tx => tx.occurrence_key)).size, incomeRows.length);
  assert.equal(new Set(expenseRows.map(tx => tx.occurrence_key)).size, expenseRows.length);
}));

test("confirmed source transactions are not regenerated after projection rebuild", async () => withHarness(async harness => {
  await configureManualFx(harness, { fx_buffer_percent: 0 });

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Confirmable income",
      currency: "PLN",
      amount: 500,
      type: "income",
      date: "2026-06-01"
    }
  });

  let snapshot = await harness.api("/api");
  const future = snapshot.futureTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(future);

  const moved = await harness.api(`/api/future/${encodeURIComponent(future.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: future.occurrence_key }
  });
  const pending = moved.pendingTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(pending);

  await harness.api(`/api/pending/${encodeURIComponent(pending.id)}/confirm`, {
    method: "POST",
    body: {
      amount: 500,
      confirmed_date: pending.date
    }
  });

  await harness.api("/api/run-jobs", { method: "POST", body: {} });
  snapshot = await harness.api("/api");

  assert.equal(snapshot.futureTransactions.filter(tx => tx.source_one_off_id === oneOff.id).length, 0);
  assert.equal(snapshot.pendingTransactions.filter(tx => tx.source_one_off_id === oneOff.id).length, 0);
  assert.equal(snapshot.confirmedTransactions.filter(tx => tx.source_one_off_id === oneOff.id).length, 1);
}));

test("projection allocates goals before same-priority discretionary operating items deterministically", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 2, fx_buffer_percent: 0 });

  await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Opening income",
      currency: "PLN",
      amount: 1000,
      type: "income",
      date: "2026-06-01"
    }
  });

  const necessary = await harness.api("/api/recurring-expenses", {
    method: "POST",
    body: {
      name: "Necessary bill",
      currency: "PLN",
      amount: 100,
      prediction_strategy: "fixed",
      necessary: 1,
      active: 1,
      priority: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 2,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  const goal = await harness.api("/api/goals", {
    method: "POST",
    body: {
      name: "Goal first",
      currency: "PLN",
      amount: 300,
      due_date: "2026-06-20",
      priority: 1,
      active: 1
    }
  });

  const flexA = await harness.api("/api/flex", {
    method: "POST",
    body: {
      id: "flex-a",
      name: "Flex A",
      currency: "PLN",
      amount: 100,
      priority: 2,
      active: 1,
      allow_split: 0
    }
  });

  const flexB = await harness.api("/api/flex", {
    method: "POST",
    body: {
      id: "flex-b",
      name: "Flex B",
      currency: "PLN",
      amount: 100,
      priority: 2,
      active: 1,
      allow_split: 0
    }
  });

  let db = harness.openPlanningDb();
  try {
    db.prepare(`
      UPDATE planned_transactions
      SET operating_priority = 2,
          created_at = '2026-01-01T00:00:00.000Z'
      WHERE id IN (
        SELECT planned_transaction_id
        FROM flex_transactions
        WHERE id IN ('flex-a', 'flex-b')
      )
    `).run();
    db.prepare(`
      UPDATE flex_transactions
      SET created_at = '2026-01-01T00:00:00.000Z'
      WHERE id IN ('flex-a', 'flex-b')
    `).run();
  } finally {
    db.close();
  }

  await harness.api("/api/run-jobs", { method: "POST", body: {} });

  db = harness.openPlanningDb();
  const firstPeriodRows = db.prepare(`
    SELECT rowid, *
    FROM future_transactions
    WHERE period = '2026-06'
    ORDER BY rowid ASC
  `).all();
  db.close();

  const sourceOrder = firstPeriodRows.map(tx => {
    if (tx.type === "income") return "income";
    if (tx.source_recurring_expense_id === necessary.id) return "necessary";
    if (tx.source_goal_id === goal.id) return "goal";
    if (tx.source_flex_id === flexA.id) return "flexA";
    if (tx.source_flex_id === flexB.id) return "flexB";
    return "other";
  });

  assert.deepEqual(sourceOrder, ["income", "necessary", "goal", "flexA", "flexB"]);
}));
