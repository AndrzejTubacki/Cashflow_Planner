import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { createSqliteBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createCashflowProjectionStateService } from "../../src/server/cashflow-projection-state-service.js";
import { createCashflowPredictionService } from "../../src/server/cashflow-prediction-service.js";
import { createCashflowProjectionEngineService } from "../../src/server/cashflow-projection-engine-service.js";
import { notificationEnabled, notificationPriority } from "../../src/server/cashflow-notification-service.js";

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

test("money inputs and generated ledger amounts are stored rounded to cents", async () => withHarness(async harness => {
  await configureManualFx(harness, {
    future_periods: 2,
    fx_buffer_percent: 0
  });

  const income = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Precision income",
      currency: "PLN",
      amount: "100,005",
      type: "income",
      date: "2026-05-20"
    }
  });
  assert.equal(income.amount, 100.01);

  let snapshot = await harness.api("/api");
  let pending = snapshot.pendingTransactions.find(tx => tx.source_one_off_id === income.id);
  assert.ok(pending);
  assert.equal(pending.amount, 100.01);
  assert.equal(pending.requested_amount, 100.01);
  assert.equal(pending.funded_amount, 100.01);
  assert.equal(pending.ledger_amount, 100.01);

  await harness.api(`/api/pending/${encodeURIComponent(pending.id)}/confirm`, {
    method: "POST",
    body: {
      amount: "100,005",
      confirmed_date: "2026-05-20"
    }
  });

  snapshot = await harness.api("/api");
  const confirmed = snapshot.confirmedTransactions.find(tx => tx.source_one_off_id === income.id);
  assert.ok(confirmed);
  assert.equal(confirmed.amount, 100.01);
  assert.equal(confirmed.ledger_amount, 100.01);
  assert.equal(confirmed.running_balance, 100.01);

  const expense = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Precision expense",
      currency: "PLN",
      amount: "33,335",
      type: "expense",
      date: "2026-06-01"
    }
  });
  assert.equal(expense.amount, 33.34);

  snapshot = await harness.api("/api");
  const future = snapshot.futureTransactions.find(tx => tx.source_one_off_id === expense.id);
  assert.ok(future);
  assert.equal(future.amount, 33.34);
  assert.equal(future.requested_amount, 33.34);
  assert.equal(future.funded_amount, 33.34);
  assert.equal(future.ledger_amount, 33.34);
  assert.equal(future.running_balance, 66.67);
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

test("budget-period surplus funds flex before it rolls into a later period", async () => withHarness(async harness => {
  await configureManualFx(harness, {
    future_periods: 4,
    fx_buffer_percent: 0
  });

  const salary = await harness.api("/api/recurring-incomes", {
    method: "POST",
    body: {
      name: "Salary",
      currency: "PLN",
      amount: 100,
      prediction_strategy: "fixed",
      active: 1,
      period_setting: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 25,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "First salary period expense",
      currency: "PLN",
      amount: 60,
      type: "expense",
      date: "2026-05-26"
    }
  });

  const flex = await harness.api("/api/flex", {
    method: "POST",
    body: {
      name: "Use period leftover",
      currency: "PLN",
      amount: 40,
      priority: 1,
      active: 1,
      allow_split: 0
    }
  });

  const snapshot = await harness.api("/api");
  assert.equal(snapshot.settings.budget_period_income_id, salary.id);

  const flexRow = snapshot.futureTransactions.find(tx =>
    tx.source_flex_id === flex.id &&
    tx.period === "2026-05-25"
  );
  assert.ok(flexRow);
  assert.equal(flexRow.status, "funded");
  assert.equal(flexRow.funded_amount, 40);

  const periodRows = snapshot.futureTransactions
    .filter(tx => tx.period === "2026-05-25")
    .sort((a, b) =>
      String(a.date).localeCompare(String(b.date)) ||
      String(a.created_at || "").localeCompare(String(b.created_at || "")) ||
      String(a.id).localeCompare(String(b.id))
    );
  assert.equal(periodRows.at(-1).running_balance, 0);
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

test("manually moved future rows are not cleared by negative pending protection", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 2, fx_buffer_percent: 0 });
  await seedConfirmedIncome(harness, 100);

  await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Future paycheck",
      currency: "PLN",
      amount: 1000,
      type: "income",
      date: "2026-05-25"
    }
  });

  const expense = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Future chair",
      currency: "PLN",
      amount: 702,
      type: "expense",
      date: "2026-05-26"
    }
  });

  let snapshot = await harness.api("/api");
  const future = snapshot.futureTransactions.find(tx => tx.source_one_off_id === expense.id);
  assert.ok(future);
  assert.equal(future.amount, 702);

  await harness.api(`/api/future/${encodeURIComponent(future.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: future.occurrence_key }
  });

  snapshot = await harness.api("/api");
  const pending = snapshot.pendingTransactions.find(tx => tx.source_one_off_id === expense.id);
  assert.ok(pending);
  assert.equal(pending.amount, 702);
  assert.equal(pending.pending_origin, "manual");
  assert.equal(snapshot.futureTransactions.some(tx => tx.source_one_off_id === expense.id), false);
  assert.equal(harness.events.some(event => event.kind === "cashflow_pending_cleared_negative_opening_balance"), false);
}));

test("unconfirmed backdated one-offs regenerate into pending", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 3, fx_buffer_percent: 0 });
  await seedConfirmedIncome(harness, 1000);

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Backdated chair",
      currency: "PLN",
      amount: 120,
      type: "expense",
      date: "2026-05-19"
    }
  });

  let snapshot = await harness.api("/api");
  let pending = snapshot.pendingTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(pending);
  assert.equal(pending.date, "2026-05-19");
  assert.equal(pending.amount, 120);
  assert.equal(pending.occurrence_key, `one_off:${oneOff.id}:expense:2026-05-19`);
  assert.equal(snapshot.futureTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);

  await harness.api("/api/run-jobs", { method: "POST", body: {} });
  snapshot = await harness.api("/api");
  pending = snapshot.pendingTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(pending);
  assert.equal(pending.amount, 120);
  assert.equal(snapshot.futureTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);
}));

test("12-month recurring expenses use same-name unlinked confirmed history", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 3, fx_buffer_percent: 0 });
  insertPendingRow(harness, {
    id: "prediction-history-income",
    name: "Prediction history income",
    amount: 10000,
    type: "income",
    date: "2026-05-18",
    occurrenceKey: "prediction-history-income"
  });
  await harness.api("/api/pending/prediction-history-income/confirm", {
    method: "POST",
    body: {
      amount: 10000,
      confirmed_date: "2026-05-18"
    }
  });

  const historical = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Mieszkanie",
      currency: "PLN",
      amount: 1980.74,
      type: "expense",
      date: "2026-05-19"
    }
  });

  let snapshot = await harness.api("/api");
  let pending = snapshot.pendingTransactions.find(tx => tx.source_one_off_id === historical.id);
  assert.ok(pending);
  await harness.api(`/api/pending/${encodeURIComponent(pending.id)}/confirm`, {
    method: "POST",
    body: {
      amount: 1980.74,
      confirmed_date: "2026-05-19"
    }
  });

  const recurring = await harness.api("/api/recurring-expenses", {
    method: "POST",
    body: {
      name: "Mieszkanie",
      currency: "PLN",
      amount: 2000,
      prediction_strategy: "12month_max",
      prediction_substitute_missing: "none",
      necessary: 1,
      active: 1,
      repeat_every_months: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 15,
      anchor_business_day_adjustment: "none"
    }
  });

  await harness.api("/api/run-jobs", { method: "POST", body: {} });
  snapshot = await harness.api("/api");

  const future = snapshot.futureTransactions.find(tx =>
    tx.source_recurring_expense_id === recurring.id &&
    tx.date === "2026-07-15"
  );
  assert.ok(future);
  assert.equal(future.amount, 1980.74);
  assert.equal(future.requested_amount, 1980.74);
}), { today: "2026-06-26" });

test("partially confirmed one-offs project unique due-aware remainders", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 3, fx_buffer_percent: 0 });
  await seedConfirmedIncome(harness, 1000);

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Installment expense",
      currency: "PLN",
      amount: 300,
      type: "expense",
      date: "2026-06-01"
    }
  });

  async function confirmProjected(amount, date = "2026-06-01") {
    const before = await harness.api("/api");
    const projected = [
      ...before.futureTransactions,
      ...before.pendingTransactions
    ].find(tx => tx.source_one_off_id === oneOff.id);
    assert.ok(projected);

    let pending = projected;
    if (before.futureTransactions.some(tx => tx.id === projected.id)) {
      const moved = await harness.api(`/api/future/${encodeURIComponent(projected.id)}/move-to-pending`, {
        method: "POST",
        body: { occurrenceKey: projected.occurrence_key }
      });
      pending = moved.pendingTransactions.find(tx => tx.occurrence_key === projected.occurrence_key);
    }

    await harness.api(`/api/pending/${encodeURIComponent(pending.id)}/confirm`, {
      method: "POST",
      body: {
        amount,
        confirmed_date: date
      }
    });
  }

  await confirmProjected(100);
  let snapshot = await harness.api("/api");
  let remainder = snapshot.futureTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.equal(remainder.amount, 200);
  assert.equal(remainder.requested_amount, 200);
  assert.equal(remainder.occurrence_key, `one_off_remainder:${oneOff.id}:2`);

  await confirmProjected(50);
  snapshot = await harness.api("/api");
  remainder = snapshot.futureTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.equal(remainder.amount, 150);
  assert.equal(remainder.occurrence_key, `one_off_remainder:${oneOff.id}:3`);

  await harness.api(`/api/one-off/${encodeURIComponent(oneOff.id)}`, {
    method: "PUT",
    body: {
      name: oneOff.name,
      currency: oneOff.currency,
      amount: 400,
      type: oneOff.type,
      date: "2026-05-19"
    }
  });

  snapshot = await harness.api("/api");
  remainder = snapshot.pendingTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.equal(remainder.amount, 250);
  assert.equal(remainder.date, "2026-05-19");
  assert.equal(remainder.occurrence_key, `one_off_remainder:${oneOff.id}:3`);
  assert.equal(snapshot.futureTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);

  await harness.api("/api/settings", {
    method: "PUT",
    body: { future_periods: 3 }
  });
  snapshot = await harness.api("/api");
  assert.equal(snapshot.pendingTransactions.filter(tx => tx.source_one_off_id === oneOff.id).length, 1);
  assert.equal(snapshot.pendingTransactions.find(tx => tx.source_one_off_id === oneOff.id).amount, 250);

  await harness.api(`/api/one-off/${encodeURIComponent(oneOff.id)}`, {
    method: "PUT",
    body: {
      name: oneOff.name,
      currency: oneOff.currency,
      amount: 400,
      type: oneOff.type,
      date: "2026-06-04"
    }
  });
  snapshot = await harness.api("/api");
  remainder = snapshot.futureTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.equal(snapshot.pendingTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);
  assert.equal(remainder.amount, 250);
  assert.equal(remainder.date, "2026-06-04");
  assert.equal(remainder.occurrence_key, `one_off_remainder:${oneOff.id}:3`);

  await confirmProjected(250, "2026-05-20");
  snapshot = await harness.api("/api");
  assert.equal(snapshot.pendingTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);
  assert.equal(snapshot.futureTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);
}));

test("editing a pending one-off revises its target and does not regenerate the old difference", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 3, fx_buffer_percent: 0 });
  await seedConfirmedIncome(harness, 1000);

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Fotel",
      currency: "PLN",
      amount: "482,97",
      type: "expense",
      date: "2026-06-01"
    }
  });
  assert.equal(oneOff.amount, 482.97);

  let snapshot = await harness.api("/api");
  const future = snapshot.futureTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(future);
  const moved = await harness.api(`/api/future/${encodeURIComponent(future.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: future.occurrence_key }
  });
  const pending = moved.pendingTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(pending);

  await harness.api(`/api/pending/${encodeURIComponent(pending.id)}`, {
    method: "PUT",
    body: {
      name: "Fotel",
      amount: "480,00",
      date: pending.date
    }
  });

  snapshot = await harness.api("/api");
  assert.equal(snapshot.oneOffs.find(tx => tx.id === oneOff.id).amount, 480);
  assert.equal(snapshot.pendingTransactions.find(tx => tx.id === pending.id).requested_amount, 480);

  await harness.api(`/api/pending/${encodeURIComponent(pending.id)}/confirm`, {
    method: "POST",
    body: { confirmed_date: "2026-06-01" }
  });

  snapshot = await harness.api("/api");
  assert.equal(snapshot.confirmedTransactions.find(tx => tx.source_one_off_id === oneOff.id).amount, 480);
  assert.equal(snapshot.pendingTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);
  assert.equal(snapshot.futureTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);
}));

test("legacy one-off remainder can be dismissed without reappearing on regeneration", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 3, fx_buffer_percent: 0 });
  await seedConfirmedIncome(harness, 1000);

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Fotel",
      currency: "PLN",
      amount: 482.97,
      type: "expense",
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
      amount: 480,
      confirmed_date: "2026-06-01"
    }
  });

  await harness.api(`/api/one-off/${encodeURIComponent(oneOff.id)}`, {
    method: "PUT",
    body: {
      name: "Fotel",
      currency: "PLN",
      amount: 482.97,
      type: "expense",
      date: "2026-05-19"
    }
  });

  let afterPartial = await harness.api("/api");
  const remainder = afterPartial.pendingTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(remainder);
  assert.equal(Math.round(remainder.amount * 100), 297);
  assert.equal(remainder.occurrence_key, `one_off_remainder:${oneOff.id}:2`);

  await harness.api(`/api/pending/${encodeURIComponent(remainder.id)}`, {
    method: "DELETE"
  });

  await harness.api("/api/run-jobs", { method: "POST", body: {} });
  afterPartial = await harness.api("/api");

  assert.equal(afterPartial.oneOffs.find(tx => tx.id === oneOff.id).amount, 480);
  assert.equal(afterPartial.pendingTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);
  assert.equal(afterPartial.futureTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);
}));

test("partial income and foreign-currency one-offs project remaining original amounts", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 3, fx_buffer_percent: 0 });
  await seedConfirmedIncome(harness, 1000);

  async function confirmFirstInstallment(oneOff, amount) {
    const snapshot = await harness.api("/api");
    const future = snapshot.futureTransactions.find(tx => tx.source_one_off_id === oneOff.id);
    const moved = await harness.api(`/api/future/${encodeURIComponent(future.id)}/move-to-pending`, {
      method: "POST",
      body: { occurrenceKey: future.occurrence_key }
    });
    const pending = moved.pendingTransactions.find(tx => tx.occurrence_key === future.occurrence_key);
    await harness.api(`/api/pending/${encodeURIComponent(pending.id)}/confirm`, {
      method: "POST",
      body: {
        amount,
        confirmed_date: future.date
      }
    });
  }

  const income = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Partial bonus",
      currency: "PLN",
      amount: 100,
      type: "income",
      date: "2026-06-02"
    }
  });
  const eurExpense = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Partial EUR expense",
      currency: "EUR",
      amount: 20,
      type: "expense",
      date: "2026-06-03"
    }
  });

  await confirmFirstInstallment(income, 40);
  await confirmFirstInstallment(eurExpense, 5);

  const snapshot = await harness.api("/api");
  const incomeRemainder = snapshot.futureTransactions.find(tx => tx.source_one_off_id === income.id);
  const expenseRemainder = snapshot.futureTransactions.find(tx => tx.source_one_off_id === eurExpense.id);

  assert.equal(incomeRemainder.amount, 60);
  assert.equal(incomeRemainder.type, "income");
  assert.equal(expenseRemainder.amount, 15);
  assert.equal(expenseRemainder.fx_rate, 4);
  assert.equal(expenseRemainder.ledger_amount, 60);
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
  assert.equal(disneyFuture.period, "2026-05-28");
  assert.equal(ramFuture.period, "2026-05-28");
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

test("future-dated pending period income funds its own period instead of the previous period", async () => withHarness(async harness => {
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
  assert.deepEqual(
    snapshot.periodSummaries.slice(0, 2).map(period => ({
      period: period.period,
      start: period.start_date,
      end: period.end_date
    })),
    [
      { period: "2026-05-29", start: "2026-05-29", end: "2026-06-25" },
      { period: "2026-06-26", start: "2026-06-26", end: "2026-07-28" }
    ]
  );

  const nextPeriodIncome = snapshot.futureTransactions.find(tx =>
    tx.source_recurring_income_id === income.id &&
    tx.date === "2026-06-26"
  );
  assert.ok(nextPeriodIncome);

  await harness.api(`/api/future/${encodeURIComponent(nextPeriodIncome.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: nextPeriodIncome.occurrence_key }
  });
  snapshot = await harness.api("/api");
  const pendingIncome = snapshot.pendingTransactions.find(tx => tx.occurrence_key === nextPeriodIncome.occurrence_key);
  assert.ok(pendingIncome);

  await harness.api(`/api/pending/${encodeURIComponent(pendingIncome.id)}`, {
    method: "PUT",
    body: { date: "2026-06-23" }
  });

  const flex = await harness.api("/api/flex", {
    method: "POST",
    body: {
      name: "Next period hardware",
      currency: "PLN",
      amount: 300,
      priority: 1,
      active: 1,
      allow_split: 0
    }
  });

  snapshot = await harness.api("/api");
  assert.deepEqual(
    snapshot.periodSummaries.slice(0, 2).map(period => ({
      period: period.period,
      start: period.start_date,
      end: period.end_date
    })),
    [
      { period: "2026-06-23", start: "2026-06-23", end: "2026-07-28" },
      { period: "2026-07-29", start: "2026-07-29", end: "2026-08-27" }
    ]
  );
  assert.equal(snapshot.periodSummaries[0].income, 400);
  assert.equal(snapshot.periodSummaries[0].expenses, 300);
  const flexRows = snapshot.futureTransactions.filter(tx => tx.source_flex_id === flex.id);
  assert.equal(flexRows.some(tx => tx.period === "2026-05-29"), false);
  assert.equal(flexRows.some(tx => tx.period === "2026-06-26"), false);

  const nextPeriodFlex = flexRows.find(tx => tx.period === "2026-06-23");
  assert.ok(nextPeriodFlex);
  assert.equal(nextPeriodFlex.status, "funded");
  assert.equal(nextPeriodFlex.ledger_amount, 300);

  const movedPending = snapshot.pendingTransactions.find(tx => tx.occurrence_key === nextPeriodIncome.occurrence_key);
  assert.ok(movedPending);
  await harness.api(`/api/pending/${encodeURIComponent(movedPending.id)}/confirm`, {
    method: "POST",
    body: { confirmed_date: "2026-06-23" }
  });

  await harness.api("/api/run-jobs", { method: "POST", body: {} });
  snapshot = await harness.api("/api");
  assert.equal(snapshot.periodSummaries[0].period, "2026-06-23");
  assert.equal(snapshot.periodSummaries[0].income, 400);
  assert.equal(snapshot.periodSummaries[0].expenses, 300);
  assert.equal(snapshot.futureTransactions.some(tx =>
    tx.source_recurring_income_id === income.id &&
    tx.occurrence_key === nextPeriodIncome.occurrence_key
  ), false);
  assert.ok(snapshot.futureTransactions.find(tx =>
    tx.source_flex_id === flex.id &&
    tx.period === "2026-06-23"
  ));
}, { today: "2026-06-23" }));

test("future-dated confirmed period income funds its own period instead of the current period", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 3, fx_buffer_percent: 0 });

  const income = await harness.api("/api/recurring-incomes", {
    method: "POST",
    body: {
      name: "Salary",
      currency: "PLN",
      amount: 1000,
      prediction_strategy: "fixed",
      active: 1,
      repeat_every_months: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 29,
      anchor_business_day_adjustment: "none",
      period_setting: 1
    }
  });

  let snapshot = await harness.api("/api");
  assert.deepEqual(
    snapshot.periodSummaries.slice(0, 2).map(period => ({
      period: period.period,
      start: period.start_date,
      end: period.end_date
    })),
    [
      { period: "2026-06-29", start: "2026-06-29", end: "2026-07-28" },
      { period: "2026-07-29", start: "2026-07-29", end: "2026-08-28" }
    ]
  );

  const nextIncome = snapshot.futureTransactions.find(tx =>
    tx.source_recurring_income_id === income.id &&
    tx.date === "2026-07-29"
  );
  assert.ok(nextIncome);

  await harness.api(`/api/future/${encodeURIComponent(nextIncome.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: nextIncome.occurrence_key }
  });

  const flex = await harness.api("/api/flex", {
    method: "POST",
    body: {
      name: "Use next salary",
      currency: "PLN",
      amount: 500,
      priority: 1,
      active: 1,
      allow_split: 0
    }
  });

  snapshot = await harness.api("/api");
  let flexRows = snapshot.futureTransactions.filter(tx => tx.source_flex_id === flex.id);
  assert.equal(flexRows.some(tx => tx.period === "2026-06-29"), false);
  let nextFlex = flexRows.find(tx => tx.period === "2026-07-29");
  assert.ok(nextFlex);
  assert.equal(nextFlex.status, "funded");
  assert.equal(nextFlex.ledger_amount, 500);
  let nextSummary = snapshot.periodSummaries.find(period => period.period === "2026-07-29");
  assert.ok(nextSummary);
  assert.equal(nextSummary.income, 1000);
  assert.equal(nextSummary.expenses, 500);

  const pendingIncome = snapshot.pendingTransactions.find(tx => tx.occurrence_key === nextIncome.occurrence_key);
  assert.ok(pendingIncome);
  await harness.api(`/api/pending/${encodeURIComponent(pendingIncome.id)}/confirm`, {
    method: "POST",
    body: {
      amount: 1000,
      confirmed_date: "2026-07-29"
    }
  });

  await harness.api("/api/run-jobs", { method: "POST", body: {} });
  snapshot = await harness.api("/api");
  flexRows = snapshot.futureTransactions.filter(tx => tx.source_flex_id === flex.id);
  assert.equal(flexRows.some(tx => tx.period === "2026-06-29"), false);
  nextFlex = flexRows.find(tx => tx.period === "2026-07-29");
  assert.ok(nextFlex);
  assert.equal(nextFlex.status, "funded");
  assert.equal(nextFlex.ledger_amount, 500);
  nextSummary = snapshot.periodSummaries.find(period => period.period === "2026-07-29");
  assert.ok(nextSummary);
  assert.equal(nextSummary.income, 1000);
  assert.equal(nextSummary.expenses, 500);
  assert.equal(snapshot.futureTransactions.some(tx => tx.occurrence_key === nextIncome.occurrence_key), false);
}, { today: "2026-07-28" }));

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
  let pendingIncome = snapshot.pendingTransactions.find(tx => tx.source_one_off_id === income.id);
  if (!pendingIncome) {
    const futureIncome = snapshot.futureTransactions.find(tx => tx.source_one_off_id === income.id);
    assert.ok(futureIncome);
    const movedIncome = await harness.api(`/api/future/${encodeURIComponent(futureIncome.id)}/move-to-pending`, {
      method: "POST",
      body: { occurrenceKey: futureIncome.occurrence_key }
    });
    pendingIncome = movedIncome.pendingTransactions.find(tx => tx.occurrence_key === futureIncome.occurrence_key);
  }
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
        WHERE id IN (?, ?)
      )
    `).run(flexA.id, flexB.id);
    db.prepare(`
      UPDATE flex_transactions
      SET created_at = '2026-01-01T00:00:00.000Z'
      WHERE id IN (?, ?)
    `).run(flexA.id, flexB.id);
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

function unexpectedSyncCall(name) {
  return (...args) => {
    throw new Error(`regenerateProjectionsAsync unexpectedly used a synchronous/SQLite-opening dependency: ${name}(${args.map(a => JSON.stringify(a)).join(", ")})`);
  };
}

function buildRealSqliteAsyncProjectionEngine(harness) {
  const paths = createCashflowStoragePaths(harness.dataDir);
  const dbService = createCashflowDbService({
    ledgerDbPath: paths.ledgerDbPath,
    logError: () => {},
    logServerEvent: () => {},
    planningDbPath: paths.planningDbPath,
    userDataDir: paths.userDataDir
  });
  const budgetStore = createSqliteBudgetStore({
    listLedgerYears: dbService.listLedgerYears,
    openLedgerDb: dbService.openLedgerDb,
    openPlanningDb: dbService.openPlanningDb
  });
  const projectionState = createCashflowProjectionStateService({
    budgetStore,
    latestConfirmedBalance: unexpectedSyncCall("latestConfirmedBalance"),
    listLedgerYears: unexpectedSyncCall("listLedgerYears"),
    loadAllConfirmedTransactions: unexpectedSyncCall("loadAllConfirmedTransactions"),
    openLedgerDb: unexpectedSyncCall("openLedgerDb")
  });
  const prediction = createCashflowPredictionService({
    budgetStore,
    listLedgerYears: unexpectedSyncCall("listLedgerYears"),
    openLedgerDb: unexpectedSyncCall("openLedgerDb")
  });

  return createCashflowProjectionEngineService({
    budgetStore,
    confirmedBalanceAsOfAsync: projectionState.confirmedBalanceAsOfAsync,
    confirmedOccurrenceKeys: unexpectedSyncCall("confirmedOccurrenceKeys"),
    confirmedOccurrenceKeysAsync: projectionState.confirmedOccurrenceKeysAsync,
    confirmedOneOffProgress: unexpectedSyncCall("confirmedOneOffProgress"),
    confirmedOneOffProgressAsync: projectionState.confirmedOneOffProgressAsync,
    confirmedRowsAfterDate: unexpectedSyncCall("confirmedRowsAfterDate"),
    confirmedRowsAfterDateAsync: projectionState.confirmedRowsAfterDateAsync,
    confirmedRowsForPrediction: unexpectedSyncCall("confirmedRowsForPrediction"),
    confirmedRowsForPredictionAsync: prediction.confirmedRowsForPredictionAsync,
    deletePendingOccurrence: unexpectedSyncCall("deletePendingOccurrence"),
    getCachedFxSnapshot: unexpectedSyncCall("getCachedFxSnapshot"),
    getCachedFxSnapshotAsync: async () => null,
    logServerEvent: () => {},
    notificationEnabled,
    notificationPriority,
    openPlanningDb: unexpectedSyncCall("openPlanningDb"),
    planningOpeningBalance: unexpectedSyncCall("planningOpeningBalance"),
    predictedAmountForRecurringExpense: unexpectedSyncCall("predictedAmountForRecurringExpense"),
    predictedAmountForRecurringIncome: unexpectedSyncCall("predictedAmountForRecurringIncome"),
    queueNotification: unexpectedSyncCall("queueNotification"),
    recalculatePlanningRunningBalances: unexpectedSyncCall("recalculatePlanningRunningBalances"),
    recalculatePlanningRunningBalancesAsync: projectionState.recalculatePlanningRunningBalancesAsync,
    refreshPendingOccurrence: unexpectedSyncCall("refreshPendingOccurrence"),
    safeGetCurrentFxSnapshot: unexpectedSyncCall("safeGetCurrentFxSnapshot"),
    safeGetCurrentFxSnapshotAsync: async () => null,
    sumConfirmedFunding: unexpectedSyncCall("sumConfirmedFunding"),
    sumPendingFunding: unexpectedSyncCall("sumPendingFunding")
  });
}

function normalizeFutureRowForComparison(row) {
  return {
    amount: row.amount,
    date: row.date,
    funded_amount: row.funded_amount,
    ledger_amount: row.ledger_amount,
    note: row.note,
    requested_amount: row.requested_amount,
    source_flex_id: row.source_flex_id,
    source_goal_id: row.source_goal_id,
    source_one_off_id: row.source_one_off_id,
    source_recurring_expense_id: row.source_recurring_expense_id,
    source_recurring_income_id: row.source_recurring_income_id,
    status: row.status,
    type: row.type
  };
}

function sortByOccurrenceKey(rows) {
  return [...rows].sort((a, b) => String(a.occurrence_key || "").localeCompare(String(b.occurrence_key || "")));
}

test("regenerateProjectionsAsync produces the same funding outcome as the SQLite sync engine on real data", async () => withHarness(async harness => {
  await configureManualFx(harness, { future_periods: 3, fx_buffer_percent: 0 });

  await harness.api("/api/recurring-incomes", {
    method: "POST",
    body: {
      name: "Monthly salary",
      currency: "PLN",
      amount: 1000,
      active: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 1,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  await harness.api("/api/recurring-expenses", {
    method: "POST",
    body: {
      name: "Monthly rent",
      currency: "PLN",
      amount: 400,
      necessary: 1,
      active: 1,
      priority: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 2,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  await harness.api("/api/goals", {
    method: "POST",
    body: {
      name: "Vacation",
      currency: "PLN",
      amount: 900,
      due_date: "2026-08-01",
      priority: 1,
      active: 1
    }
  });

  await harness.api("/api/flex", {
    method: "POST",
    body: {
      name: "Hobby",
      currency: "PLN",
      amount: 300,
      priority: 1,
      active: 1,
      allow_split: 1,
      min_amount: 0
    }
  });

  // At this point every planner mutation above has already triggered the
  // synchronous SQLite engine at least once through the normal route
  // handlers. Snapshot that sync-produced state before overwriting it.
  let db = harness.openPlanningDb();
  const syncFutureRows = db.prepare("SELECT * FROM future_transactions").all();
  const syncSnapshot = db.prepare(`
    SELECT *
    FROM projection_snapshots
    ORDER BY snapshot_timestamp DESC
    LIMIT 1
  `).get();
  db.close();

  assert.ok(syncFutureRows.length > 0, "sync engine should have generated future rows to compare against");

  const asyncEngine = buildRealSqliteAsyncProjectionEngine(harness);
  const applyResult = await asyncEngine.regenerateProjectionsAsync(harness.userId);
  assert.equal(applyResult.ok, true);

  db = harness.openPlanningDb();
  const asyncFutureRows = db.prepare("SELECT * FROM future_transactions").all();
  const asyncSnapshot = db.prepare(`
    SELECT *
    FROM projection_snapshots
    ORDER BY snapshot_timestamp DESC
    LIMIT 1
  `).get();
  db.close();

  assert.deepEqual(
    sortByOccurrenceKey(asyncFutureRows).map(normalizeFutureRowForComparison),
    sortByOccurrenceKey(syncFutureRows).map(normalizeFutureRowForComparison),
    "async (budget-store) engine should generate the same future rows as the sync SQLite engine"
  );

  assert.equal(asyncSnapshot.total_projected_income, syncSnapshot.total_projected_income);
  assert.equal(asyncSnapshot.total_projected_expenses, syncSnapshot.total_projected_expenses);
  assert.equal(asyncSnapshot.available_balance, syncSnapshot.available_balance);
  assert.equal(asyncSnapshot.warning_count, syncSnapshot.warning_count);
}));
