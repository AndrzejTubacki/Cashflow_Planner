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

async function configure(harness) {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      future_periods: 2,
      fx_provider: "manual",
      manual_fx_rates: {},
      fx_buffer_percent: 0
    }
  });
}

function insertPendingWithSource(harness, row) {
  const db = harness.openPlanningDb();

  try {
    db.prepare(`
      INSERT INTO pending_transactions (
        id, name, currency, amount, type, date,
        source_recurring_expense_id, source_recurring_income_id,
        source_one_off_id, source_flex_id, source_goal_id,
        fx_rate, buffered_fx_rate, status, funded_amount, requested_amount,
        ledger_amount, occurrence_key, created_at, updated_at
      ) VALUES (?, ?, 'PLN', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'pending', ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      row.id,
      row.name,
      row.amount,
      row.type,
      row.date,
      row.sourceRecurringExpenseId || null,
      row.sourceRecurringIncomeId || null,
      row.sourceOneOffId || null,
      row.sourceFlexId || null,
      row.sourceGoalId || null,
      row.amount,
      row.amount,
      row.amount,
      row.occurrenceKey
    );
  } finally {
    db.close();
  }
}

function backupCount(harness) {
  const db = harness.openPlanningDb();
  try {
    return db.prepare("SELECT COUNT(*) AS count FROM backup_metadata").get().count;
  } finally {
    db.close();
  }
}

async function seedConfirmedIncome(harness) {
  insertPendingWithSource(harness, {
    id: "pend-seed-income",
    name: "Seed income",
    amount: 1000,
    type: "income",
    date: "2026-01-01",
    occurrenceKey: "seed-income"
  });

  await harness.api("/api/pending/pend-seed-income/confirm", {
    method: "POST",
    body: {
      amount: 1000,
      confirmed_date: "2026-01-01"
    }
  });
}

test("flex min_amount greater than max_amount is rejected on create and update", async () => withHarness(async harness => {
  await configure(harness);

  const createResult = await harness.request("/api/flex", {
    method: "POST",
    body: {
      name: "Invalid flex",
      currency: "PLN",
      amount: 100,
      priority: 1,
      active: 1,
      allow_split: 1,
      min_amount: 80,
      max_amount: 50
    }
  });

  assert.equal(createResult.response.status, 400);
  assert.match(createResult.body.error, /min amount/i);

  const flex = await harness.api("/api/flex", {
    method: "POST",
    body: {
      name: "Valid flex",
      currency: "PLN",
      amount: 100,
      priority: 1,
      active: 1,
      allow_split: 1,
      min_amount: 10,
      max_amount: 50
    }
  });

  const updateResult = await harness.request(`/api/flex/${encodeURIComponent(flex.id)}`, {
    method: "PUT",
    body: {
      allow_split: 1,
      min_amount: 90,
      max_amount: 50
    }
  });

  assert.equal(updateResult.response.status, 400);
  assert.match(updateResult.body.error, /min amount/i);
}));

test("planning-only mutations do not create safety backups", async () => withHarness(async harness => {
  await configure(harness);
  const before = backupCount(harness);
  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Planning-only",
      currency: "PLN",
      amount: 10,
      type: "expense",
      date: "2026-06-01"
    }
  });
  await harness.api(`/api/one-off/${encodeURIComponent(oneOff.id)}`, {
    method: "PUT",
    body: { amount: 20 }
  });
  await harness.api(`/api/one-off/${encodeURIComponent(oneOff.id)}`, {
    method: "DELETE"
  });
  assert.equal(backupCount(harness), before);
}));

test("confirmed goal and flex sources cannot be deleted while confirmed one-offs can be edited or uncoupled", async () => withHarness(async harness => {
  await configure(harness);
  await seedConfirmedIncome(harness);

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Confirmed one-off source",
      currency: "PLN",
      amount: 50,
      type: "expense",
      date: "2026-01-02"
    }
  });
  const goal = await harness.api("/api/goals", {
    method: "POST",
    body: {
      name: "Confirmed goal source",
      currency: "PLN",
      amount: 50,
      due_date: "2026-01-03",
      priority: 1,
      active: 1
    }
  });
  const flex = await harness.api("/api/flex", {
    method: "POST",
    body: {
      name: "Confirmed flex source",
      currency: "PLN",
      amount: 50,
      priority: 1,
      active: 1,
      allow_split: 0
    }
  });

  insertPendingWithSource(harness, {
    id: "pend-oneoff-confirmed",
    name: "Confirmed one-off source",
    amount: 50,
    type: "expense",
    date: "2026-01-02",
    sourceOneOffId: oneOff.id,
    occurrenceKey: "confirmed-oneoff"
  });
  insertPendingWithSource(harness, {
    id: "pend-goal-confirmed",
    name: "Confirmed goal source",
    amount: 50,
    type: "goal_allocation",
    date: "2026-01-03",
    sourceGoalId: goal.id,
    occurrenceKey: "confirmed-goal"
  });
  insertPendingWithSource(harness, {
    id: "pend-flex-confirmed",
    name: "Confirmed flex source",
    amount: 50,
    type: "expense",
    date: "2026-01-04",
    sourceFlexId: flex.id,
    occurrenceKey: "confirmed-flex"
  });

  for (const id of ["pend-oneoff-confirmed", "pend-goal-confirmed", "pend-flex-confirmed"]) {
    await harness.api(`/api/pending/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      body: {
        amount: 50,
        confirmed_date: id.includes("oneoff") ? "2026-01-02" : id.includes("goal") ? "2026-01-03" : "2026-01-04"
      }
    });
  }

  const lowerAmount = await harness.request(`/api/one-off/${encodeURIComponent(oneOff.id)}`, {
    method: "PUT",
    body: {
      name: "Too low",
      currency: "PLN",
      amount: 40,
      type: "expense",
      date: "2026-01-02"
    }
  });
  const changeCurrency = await harness.request(`/api/one-off/${encodeURIComponent(oneOff.id)}`, {
    method: "PUT",
    body: {
      currency: "EUR",
      amount: 60
    }
  });
  const increaseAmount = await harness.request(`/api/one-off/${encodeURIComponent(oneOff.id)}`, {
    method: "PUT",
    body: {
      name: "Confirmed one-off source updated",
      currency: "PLN",
      amount: 60,
      type: "expense",
      date: "2026-01-05"
    }
  });
  const deleteOneOff = await harness.request(`/api/one-off/${encodeURIComponent(oneOff.id)}`, { method: "DELETE" });
  const deleteGoal = await harness.request(`/api/goals/${encodeURIComponent(goal.id)}`, { method: "DELETE" });
  const deleteFlex = await harness.request(`/api/flex/${encodeURIComponent(flex.id)}`, { method: "DELETE" });

  assert.equal(lowerAmount.response.status, 400);
  assert.match(lowerAmount.body.error, /already confirmed amount/i);
  assert.equal(changeCurrency.response.status, 400);
  assert.match(changeCurrency.body.error, /currency/i);
  assert.equal(increaseAmount.response.status, 200);
  assert.equal(increaseAmount.body.amount, 60);
  assert.equal(deleteOneOff.response.status, 200);
  {
    const ledgerDb = harness.openLedgerDb("2026");
    try {
      const row = ledgerDb.prepare("SELECT source_one_off_id FROM confirmed_transactions WHERE name = ?").get("Confirmed one-off source");
      assert.equal(row.source_one_off_id, null);
    } finally {
      ledgerDb.close();
    }
  }
  assert.equal(deleteGoal.response.status, 400);
  assert.match(deleteGoal.body.error, /confirmed goal/i);
  assert.equal(deleteFlex.response.status, 400);
  assert.match(deleteFlex.body.error, /confirmed flex/i);
}));

test("budget period income setting is cleared when selected income is disabled or deleted", async () => withHarness(async harness => {
  await configure(harness);

  const income = await harness.api("/api/recurring-incomes", {
    method: "POST",
    body: {
      name: "Period salary",
      currency: "PLN",
      amount: 1000,
      prediction_strategy: "fixed",
      active: 1,
      period_setting: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 1,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  let snapshot = await harness.api("/api");
  assert.equal(snapshot.settings.budget_period_income_id, income.id);

  await harness.api(`/api/recurring-incomes/${encodeURIComponent(income.id)}`, {
    method: "PUT",
    body: {
      ...income,
      active: 0,
      period_setting: 1
    }
  });

  snapshot = await harness.api("/api");
  assert.equal(snapshot.settings.budget_period_income_id, null);

  const secondIncome = await harness.api("/api/recurring-incomes", {
    method: "POST",
    body: {
      name: "Second salary",
      currency: "PLN",
      amount: 1000,
      prediction_strategy: "fixed",
      active: 1,
      period_setting: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 1,
      anchor_business_day_adjustment: "none",
      repeat_every_months: 1
    }
  });

  await harness.api(`/api/recurring-incomes/${encodeURIComponent(secondIncome.id)}`, { method: "DELETE" });

  snapshot = await harness.api("/api");
  assert.equal(snapshot.settings.budget_period_income_id, null);
  assert.ok(snapshot.periodSummaries.every(period => /^\d{4}-\d{2}$/.test(period.period)));
}));

test("deleting non-confirmed one-off goal and flex removes generated future and pending rows", async () => withHarness(async harness => {
  await configure(harness);

  await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Funding income",
      currency: "PLN",
      amount: 1000,
      type: "income",
      date: "2026-06-01"
    }
  });
  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Delete one-off",
      currency: "PLN",
      amount: 50,
      type: "expense",
      date: "2026-06-02"
    }
  });
  const goal = await harness.api("/api/goals", {
    method: "POST",
    body: {
      name: "Delete goal",
      currency: "PLN",
      amount: 50,
      due_date: "2026-06-03",
      priority: 1,
      active: 1
    }
  });
  const flex = await harness.api("/api/flex", {
    method: "POST",
    body: {
      name: "Delete flex",
      currency: "PLN",
      amount: 50,
      priority: 1,
      active: 1,
      allow_split: 0
    }
  });

  let snapshot = await harness.api("/api");
  const oneOffFuture = snapshot.futureTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(oneOffFuture);
  await harness.api(`/api/future/${encodeURIComponent(oneOffFuture.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: oneOffFuture.occurrence_key }
  });

  await harness.api(`/api/one-off/${encodeURIComponent(oneOff.id)}`, { method: "DELETE" });
  await harness.api(`/api/goals/${encodeURIComponent(goal.id)}`, { method: "DELETE" });
  await harness.api(`/api/flex/${encodeURIComponent(flex.id)}`, { method: "DELETE" });

  snapshot = await harness.api("/api");
  assert.equal(snapshot.futureTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);
  assert.equal(snapshot.pendingTransactions.some(tx => tx.source_one_off_id === oneOff.id), false);
  assert.equal(snapshot.futureTransactions.some(tx => tx.source_goal_id === goal.id), false);
  assert.equal(snapshot.pendingTransactions.some(tx => tx.source_goal_id === goal.id), false);
  assert.equal(snapshot.futureTransactions.some(tx => tx.source_flex_id === flex.id), false);
  assert.equal(snapshot.pendingTransactions.some(tx => tx.source_flex_id === flex.id), false);
}));

test("deleting recurring expenses removes generated rows and preserves confirmed history", async () => withHarness(async harness => {
  await configure(harness);
  await seedConfirmedIncome(harness);

  async function createExpense(name, day) {
    return harness.api("/api/recurring-expenses", {
      method: "POST",
      body: {
        name,
        currency: "PLN",
        amount: 50,
        prediction_strategy: "fixed",
        necessary: 1,
        active: 1,
        priority: 1,
        anchor_type: "day_of_month",
        anchor_day_of_month: day,
        anchor_business_day_adjustment: "none",
        repeat_every_months: 1
      }
    });
  }

  const futureSource = await createExpense("Delete future recurring", 21);
  let snapshot = await harness.api("/api");
  assert.ok(snapshot.futureTransactions.some(tx => tx.source_recurring_expense_id === futureSource.id));
  await harness.api(`/api/recurring-expenses/${encodeURIComponent(futureSource.id)}`, { method: "DELETE" });

  const pendingSource = await createExpense("Delete pending recurring", 22);
  snapshot = await harness.api("/api");
  const pendingFuture = snapshot.futureTransactions.find(tx => tx.source_recurring_expense_id === pendingSource.id);
  assert.ok(pendingFuture);
  await harness.api(`/api/future/${encodeURIComponent(pendingFuture.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: pendingFuture.occurrence_key }
  });
  await harness.api(`/api/recurring-expenses/${encodeURIComponent(pendingSource.id)}`, { method: "DELETE" });

  const confirmedSource = await createExpense("Delete confirmed recurring", 23);
  snapshot = await harness.api("/api");
  const confirmedFuture = snapshot.futureTransactions.find(tx => tx.source_recurring_expense_id === confirmedSource.id);
  assert.ok(confirmedFuture);
  const moved = await harness.api(`/api/future/${encodeURIComponent(confirmedFuture.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: confirmedFuture.occurrence_key }
  });
  const pending = moved.pendingTransactions.find(tx => tx.occurrence_key === confirmedFuture.occurrence_key);
  await harness.api(`/api/pending/${encodeURIComponent(pending.id)}/confirm`, {
    method: "POST",
    body: {
      amount: 50,
      confirmed_date: "2026-05-23"
    }
  });
  await harness.api(`/api/recurring-expenses/${encodeURIComponent(confirmedSource.id)}`, { method: "DELETE" });

  snapshot = await harness.api("/api");
  for (const source of [futureSource, pendingSource, confirmedSource]) {
    assert.equal(snapshot.recurringExpenses.some(row => row.id === source.id), false);
    assert.equal(snapshot.futureTransactions.some(tx => tx.source_recurring_expense_id === source.id), false);
    assert.equal(snapshot.pendingTransactions.some(tx => tx.source_recurring_expense_id === source.id), false);
  }

  const ledgerDb = harness.openLedgerDb("2026");
  try {
    const historical = ledgerDb.prepare(`
      SELECT source_recurring_expense_id
      FROM confirmed_transactions
      WHERE source_recurring_expense_id = ?
    `).get(confirmedSource.id);
    assert.equal(historical.source_recurring_expense_id, confirmedSource.id);
  } finally {
    ledgerDb.close();
  }
}));

test("deleting recurring income preserves confirmed historical source IDs", async () => withHarness(async harness => {
  await configure(harness);
  const income = await harness.api("/api/recurring-incomes", {
    method: "POST",
    body: {
      name: "Historical recurring income",
      currency: "PLN",
      amount: 100,
      prediction_strategy: "fixed",
      active: 1,
      repeat_every_months: 1,
      anchor_type: "day_of_month",
      anchor_day_of_month: 1
    }
  });

  insertPendingWithSource(harness, {
    id: "confirmed-recurring-income",
    name: income.name,
    amount: 100,
    type: "income",
    date: "2026-05-20",
    sourceRecurringIncomeId: income.id,
    occurrenceKey: "confirmed-recurring-income"
  });
  await harness.api("/api/pending/confirmed-recurring-income/confirm", {
    method: "POST",
    body: { amount: 100, confirmed_date: "2026-05-20" }
  });

  const deleted = await harness.request(`/api/recurring-incomes/${encodeURIComponent(income.id)}`, {
    method: "DELETE"
  });
  assert.equal(deleted.response.status, 200);

  const snapshot = await harness.api("/api");
  assert.equal(snapshot.recurringIncomes.some(row => row.id === income.id), false);
  const history = snapshot.confirmedTransactions.find(row => row.id === "confirmed-recurring-income");
  assert.equal(history.source_recurring_income_id, income.id);
}));

test("failed confirmed one-off deletion restores planning source and ledger attribution", async () => {
  let failDelete = false;
  await withHarness(async harness => {
    await configure(harness);
    await seedConfirmedIncome(harness);
    const oneOff = await harness.api("/api/one-off", {
      method: "POST",
      body: {
        name: "Rollback one-off delete",
        currency: "PLN",
        amount: 50,
        type: "expense",
        date: "2026-01-02"
      }
    });
    insertPendingWithSource(harness, {
      id: "confirmed-rollback-oneoff",
      name: oneOff.name,
      amount: 50,
      type: "expense",
      date: "2026-01-02",
      sourceOneOffId: oneOff.id,
      occurrenceKey: "confirmed-rollback-oneoff"
    });
    await harness.api("/api/pending/confirmed-rollback-oneoff/confirm", {
      method: "POST",
      body: { amount: 50, confirmed_date: "2026-01-02" }
    });

    failDelete = true;
    const failed = await harness.request(`/api/one-off/${encodeURIComponent(oneOff.id)}`, {
      method: "DELETE"
    });
    assert.equal(failed.response.status, 500);

    const snapshot = await harness.api("/api");
    assert.equal(snapshot.oneOffs.some(row => row.id === oneOff.id), true);
    assert.equal(
      snapshot.confirmedTransactions.find(row => row.id === "confirmed-rollback-oneoff").source_one_off_id,
      oneOff.id
    );
    assert.ok(harness.events.some(event =>
      event.kind === "cashflow_recoverable_mutation_rolled_back"
      && event.details.operation === "delete_confirmed_one_off"
    ));
  }, {
    recoverableMutationHook: ({ operation }) => {
      if (failDelete && operation === "delete_confirmed_one_off") {
        throw new Error("forced one-off delete failure");
      }
    }
  });
});
