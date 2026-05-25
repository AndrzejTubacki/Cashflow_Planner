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
        source_one_off_id, source_flex_id, source_goal_id,
        fx_rate, buffered_fx_rate, status, funded_amount, requested_amount,
        ledger_amount, occurrence_key, created_at, updated_at
      ) VALUES (?, ?, 'PLN', ?, ?, ?, ?, ?, ?, 1, 1, 'pending', ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      row.id,
      row.name,
      row.amount,
      row.type,
      row.date,
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

  assert.equal(createResult.response.status, 500);
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

  assert.equal(updateResult.response.status, 500);
  assert.match(updateResult.body.error, /min amount/i);
}));

test("confirmed goal flex and one-off sources cannot be deleted", async () => withHarness(async harness => {
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

  const deleteOneOff = await harness.request(`/api/one-off/${encodeURIComponent(oneOff.id)}`, { method: "DELETE" });
  const deleteGoal = await harness.request(`/api/goals/${encodeURIComponent(goal.id)}`, { method: "DELETE" });
  const deleteFlex = await harness.request(`/api/flex/${encodeURIComponent(flex.id)}`, { method: "DELETE" });

  assert.equal(deleteOneOff.response.status, 500);
  assert.match(deleteOneOff.body.error, /confirmed one-off/i);
  assert.equal(deleteGoal.response.status, 500);
  assert.match(deleteGoal.body.error, /confirmed goal/i);
  assert.equal(deleteFlex.response.status, 500);
  assert.match(deleteFlex.body.error, /confirmed flex/i);
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
