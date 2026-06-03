import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

async function withHarness(fn, options = {}) {
  const harness = await createCashflowTestHarness(options);
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

function insertPendingRow(harness, row) {
  const db = harness.openPlanningDb();
  try {
    db.prepare(`
      INSERT INTO pending_transactions (
        id, name, currency, amount, type, date,
        fx_rate, buffered_fx_rate, ledger_currency, status,
        funded_amount, requested_amount, ledger_amount,
        occurrence_key, created_at, updated_at
      ) VALUES (?, ?, 'PLN', ?, ?, ?, 1, 1, 'PLN', 'pending', ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      row.id,
      row.name,
      row.amount,
      row.type,
      row.date,
      row.amount,
      row.amount,
      row.amount,
      row.occurrenceKey || row.id
    );
  } finally {
    db.close();
  }
}

function insertOldLedgerAllocationRows(harness, { goalId, flexId }) {
  const db = harness.openPlanningDb();
  try {
    db.prepare(`
      INSERT INTO pending_transactions (
        id, name, currency, amount, type, date,
        source_goal_id, fx_rate, buffered_fx_rate, ledger_currency, status,
        funded_amount, requested_amount, ledger_amount, occurrence_key, created_at, updated_at
      ) VALUES ('old-ledger-goal-pending', 'Old goal', 'EUR', 100, 'goal_allocation', '2026-05-21',
        ?, 1, 1, 'EUR', 'pending', 100, 100, 100, 'old-goal', datetime('now'), datetime('now'))
    `).run(goalId);

    db.prepare(`
      INSERT INTO future_transactions (
        id, name, currency, amount, type, date, period,
        source_flex_id, fx_rate, buffered_fx_rate, ledger_currency, status,
        funded_amount, requested_amount, ledger_amount, occurrence_key, generation_timestamp, created_at
      ) VALUES ('old-ledger-flex-future', 'Old flex', 'EUR', 100, 'expense', '2026-05-22', '2026-05',
        ?, 1, 1, 'EUR', 'funded', 100, 100, 100, 'old-flex', datetime('now'), datetime('now'))
    `).run(flexId);
  } finally {
    db.close();
  }
}

async function seedConfirmedIncome(harness, amount = 100) {
  insertPendingRow(harness, {
    id: `pending-income-${amount}`,
    name: `Income ${amount}`,
    amount,
    type: "income",
    date: "2026-05-20",
    occurrenceKey: `income-${amount}`
  });

  await harness.api(`/api/pending/${encodeURIComponent(`pending-income-${amount}`)}/confirm`, {
    method: "POST",
    body: {
      amount,
      confirmed_date: "2026-05-20"
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

test("minimum reserve protects balance from necessary expenses and flex", async () => withHarness(async harness => {
  await configureManualFx(harness, {
    future_periods: 2,
    fx_buffer_percent: 0,
    minimum_reserve_enabled: 1,
    minimum_reserve_amount: 500
  });

  await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Reserve income",
      currency: "PLN",
      amount: 1000,
      type: "income",
      date: "2026-05-20"
    }
  });

  const expense = await harness.api("/api/recurring-expenses", {
    method: "POST",
    body: {
      name: "Reserve rent",
      currency: "PLN",
      amount: 800,
      prediction_strategy: "fixed",
      necessary: 1,
      active: 1,
      priority: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 21,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  const flex = await harness.api("/api/flex", {
    method: "POST",
    body: {
      name: "Reserve flex",
      currency: "PLN",
      amount: 600,
      active: 1,
      allow_split: 0,
      priority: 2
    }
  });

  const snapshot = await harness.api("/api");
  const expenseRow = snapshot.futureTransactions.find(tx => tx.source_recurring_expense_id === expense.id);

  assert.equal(expenseRow.status, "partial");
  assert.equal(expenseRow.funded_amount, 500);
  assert.equal(snapshot.futureTransactions.some(tx => tx.source_flex_id === flex.id), false);
}));

test("disabled reserve preserves existing allocation behavior", async () => withHarness(async harness => {
  await configureManualFx(harness, {
    future_periods: 2,
    fx_buffer_percent: 0,
    minimum_reserve_enabled: 0,
    minimum_reserve_amount: 500
  });

  await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "No reserve income",
      currency: "PLN",
      amount: 1000,
      type: "income",
      date: "2026-05-20"
    }
  });

  const expense = await harness.api("/api/recurring-expenses", {
    method: "POST",
    body: {
      name: "No reserve rent",
      currency: "PLN",
      amount: 800,
      prediction_strategy: "fixed",
      necessary: 1,
      active: 1,
      priority: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 21,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  const snapshot = await harness.api("/api");
  const expenseRow = snapshot.futureTransactions.find(tx => tx.source_recurring_expense_id === expense.id);

  assert.equal(expenseRow.status, "funded");
  assert.equal(expenseRow.funded_amount, 800);
}));

test("pending rows that would make opening balance negative are cleared before regeneration", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 2, fx_buffer_percent: 0 });
  await seedConfirmedIncome(harness, 100);

  insertPendingRow(harness, {
    id: "pending-too-large-expense",
    name: "Too large pending expense",
    amount: 150,
    type: "expense",
    date: "2026-05-21",
    occurrenceKey: "too-large-pending"
  });

  await harness.api("/api/settings", {
    method: "PUT",
    body: { future_periods: 2 }
  });

  const snapshot = await harness.api("/api");
  assert.equal(snapshot.pendingTransactions.length, 0);
  assert.ok(harness.events.some(event => event.kind === "cashflow_pending_cleared_negative_opening_balance"));
}));

test("goal and flex summaries ignore old-ledger pending and future allocations", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 2, fx_buffer_percent: 0 });

  const goal = await harness.api("/api/goals", {
    method: "POST",
    body: {
      name: "Ledger goal",
      currency: "PLN",
      amount: 500,
      due_date: "2026-06-01",
      priority: 1,
      active: 1
    }
  });

  const flex = await harness.api("/api/flex", {
    method: "POST",
    body: {
      name: "Ledger flex",
      currency: "PLN",
      amount: 500,
      priority: 1,
      active: 1,
      allow_split: 1,
      min_amount: 0
    }
  });

  insertOldLedgerAllocationRows(harness, { goalId: goal.id, flexId: flex.id });

  const snapshot = await harness.api("/api");
  const goalSummary = snapshot.goals.find(row => row.id === goal.id);
  const flexSummary = snapshot.flexTransactions.find(row => row.id === flex.id);

  assert.equal(goalSummary.pending_allocated_ledger, 0);
  assert.equal(goalSummary.future_allocated_ledger, 0);
  assert.equal(flexSummary.pending_allocated_ledger, 0);
  assert.equal(flexSummary.future_allocated_ledger, 0);
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

  assert.deepEqual(incomeRows.map(tx => tx.date), ["2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31"]);
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

test("confirmed period-setting income balance funds the next generated period", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 3, fx_buffer_percent: 0 });

  const income = await harness.api("/api/recurring-incomes", {
    method: "POST",
    body: {
      name: "BBMF",
      currency: "EUR",
      amount: 100,
      prediction_strategy: "fixed",
      active: 1,
      repeat_every_months: 1,
      anchor_type: "month_end",
      anchor_offset_days: -2,
      anchor_business_day_adjustment: "previous",
      anchor_holiday_country: "DE",
      period_setting: 1
    }
  });

  let snapshot = await harness.api("/api");
  const futureIncome = snapshot.futureTransactions.find(tx =>
    tx.source_recurring_income_id === income.id &&
    tx.date === "2026-05-29"
  );
  assert.ok(futureIncome);

  const moved = await harness.api(`/api/future/${encodeURIComponent(futureIncome.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: futureIncome.occurrence_key }
  });
  const pending = moved.pendingTransactions.find(tx => tx.occurrence_key === futureIncome.occurrence_key);
  assert.ok(pending);

  await harness.api(`/api/pending/${encodeURIComponent(pending.id)}`, {
    method: "PUT",
    body: { date: "2026-05-28" }
  });

  await harness.api(`/api/pending/${encodeURIComponent(pending.id)}/confirm`, {
    method: "POST",
    body: {
      amount: 100,
      confirmed_date: "2026-05-28"
    }
  });

  const disney = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Disney",
      currency: "PLN",
      amount: 60,
      type: "expense",
      date: "2026-05-29"
    }
  });

  const ram = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "RAM",
      currency: "PLN",
      amount: 300,
      type: "expense",
      date: "2026-05-30"
    }
  });

  await harness.api("/api/run-jobs", { method: "POST", body: {} });
  snapshot = await harness.api("/api");

  const rowsBySource = new Map(snapshot.futureTransactions.map(tx => [tx.source_one_off_id, tx]));
  const disneyFuture = rowsBySource.get(disney.id);
  const ramFuture = rowsBySource.get(ram.id);

  assert.ok(disneyFuture);
  assert.ok(ramFuture);
  assert.equal(disneyFuture.period, "2026-05-29");
  assert.equal(ramFuture.period, "2026-05-29");
  assert.equal(disneyFuture.status, "funded");
  assert.equal(ramFuture.status, "funded");
  assert.equal(disneyFuture.ledger_amount, 60);
  assert.equal(ramFuture.ledger_amount, 300);
  assert.equal(disneyFuture.running_balance, 340);
  assert.equal(ramFuture.running_balance, 40);
  assert.equal(
    snapshot.futureTransactions.some(tx => tx.occurrence_key === futureIncome.occurrence_key),
    false
  );
}), { today: "2026-05-28" });

test("refreshed pending occurrences are not double-counted against future funding", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 3, fx_buffer_percent: 0 });

  const income = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Opening income",
      currency: "PLN",
      amount: 1000,
      type: "income",
      date: "2026-05-20"
    }
  });

  let snapshot = await harness.api("/api");
  const futureIncome = snapshot.futureTransactions.find(tx => tx.source_one_off_id === income.id);
  assert.ok(futureIncome);

  const movedIncome = await harness.api(`/api/future/${encodeURIComponent(futureIncome.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: futureIncome.occurrence_key }
  });
  const pendingIncome = movedIncome.pendingTransactions.find(tx => tx.occurrence_key === futureIncome.occurrence_key);
  assert.ok(pendingIncome);

  await harness.api(`/api/pending/${encodeURIComponent(pendingIncome.id)}/confirm`, {
    method: "POST",
    body: {
      amount: 1000,
      confirmed_date: "2026-05-20"
    }
  });

  const reserved = await harness.api("/api/recurring-expenses", {
    method: "POST",
    body: {
      name: "Already pending",
      currency: "PLN",
      amount: 500,
      prediction_strategy: "fixed",
      necessary: 1,
      active: 1,
      priority: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 1,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  const later = await harness.api("/api/recurring-expenses", {
    method: "POST",
    body: {
      name: "Later future",
      currency: "PLN",
      amount: 400,
      prediction_strategy: "fixed",
      necessary: 1,
      active: 1,
      priority: 2,
      anchor_type: "day_of_month",
      anchor_day_of_month: 2,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  snapshot = await harness.api("/api");
  const reservedFuture = snapshot.futureTransactions.find(tx =>
    tx.source_recurring_expense_id === reserved.id &&
    tx.date === "2026-06-01"
  );
  assert.ok(reservedFuture);

  await harness.api(`/api/future/${encodeURIComponent(reservedFuture.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: reservedFuture.occurrence_key }
  });

  await harness.api("/api/run-jobs", { method: "POST", body: {} });
  snapshot = await harness.api("/api");

  const pendingReserved = snapshot.pendingTransactions.find(tx =>
    tx.source_recurring_expense_id === reserved.id &&
    tx.occurrence_key === reservedFuture.occurrence_key
  );
  const laterFuture = snapshot.futureTransactions.find(tx =>
    tx.source_recurring_expense_id === later.id &&
    tx.date === "2026-06-02"
  );

  assert.ok(pendingReserved);
  assert.ok(laterFuture);
  assert.equal(pendingReserved.ledger_amount, 500);
  assert.equal(pendingReserved.running_balance, 500);
  assert.equal(laterFuture.status, "funded");
  assert.equal(laterFuture.ledger_amount, 400);
  assert.equal(laterFuture.running_balance, 100);
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
