import assert from "node:assert/strict";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

test("single pending regeneration preserves other rows and source and can return to future or pending", async () => {
  const harness = await createCashflowTestHarness({ userId: "regenerate_test" });
  try {
    for (const date of ["2026-06-01", harness.today]) {
      const source = await harness.api("/api/one-off", { method: "POST", body: {
        name: `Synthetic income ${date}`, currency: "PLN", amount: 100, type: "income", date
      } });
      let snapshot = await harness.api("/api");
      const future = snapshot.futureTransactions.find(row => row.source_one_off_id === source.id);
      if (future) await harness.api(`/api/future/${future.id}/move-to-pending`, { method: "POST" });
      snapshot = await harness.api("/api");
      const pending = snapshot.pendingTransactions.find(row => row.source_one_off_id === source.id);
      assert.ok(pending);
      const otherIds = snapshot.pendingTransactions.filter(row => row.id !== pending.id).map(row => row.id);
      const result = await harness.api(`/api/pending/${pending.id}/regenerate`, { method: "POST" });
      assert.equal(result.removedPendingId, pending.id);
      assert.equal(result._projection.projection_ok, true);
      snapshot = await harness.api("/api");
      assert.ok(!snapshot.pendingTransactions.some(row => row.id === pending.id));
      for (const id of otherIds) assert.ok(snapshot.pendingTransactions.some(row => row.id === id));
      assert.equal(snapshot.oneOffs.find(row => row.id === source.id).amount, 100);
      const regenerated = (future ? snapshot.futureTransactions : snapshot.pendingTransactions)
        .filter(row => row.source_one_off_id === source.id);
      assert.equal(regenerated.length, 1);
      assert.equal(regenerated[0].amount, 100);
    }
    const missing = await harness.request("/api/pending/missing/regenerate", { method: "POST" });
    assert.equal(missing.response.status, 404);
  } finally {
    await harness.cleanup();
  }
});

test("regenerating a stale fulfilled goal removes the row without reducing the goal target", async () => {
  const harness = await createCashflowTestHarness({ userId: "fulfilled_regenerate_test" });
  try {
    const goal = await harness.api("/api/goals", { method: "POST", body: {
      name: "Fulfilled goal", currency: "PLN", amount: 100, active: 1, priority: 1, due_date: "2026-06-30"
    } });
    // Real storage: fulfilled target plus an obsolete pending allocation.
    const stamp = "2026-05-20T08:00:00.000Z";
    const ledger = harness.openLedgerDb("2026");
    const { initializeLedgerSchema } = await import("../../src/server/cashflow-schema.js");
    try {
      initializeLedgerSchema(ledger);
      ledger.prepare(`INSERT INTO confirmed_transactions
        (id, name, currency, amount, type, date, confirmed_date, ledger_currency,
         ledger_amount, running_balance_pln, source_goal_id, fx_rate, buffered_fx_rate, created_at, updated_at)
        VALUES ('fulfilled', 'Synthetic allocation', 'PLN', 100, 'expense', ?, ?, 'PLN', 100, 0, ?, 1, 1, ?, ?)`)
        .run(harness.today, harness.today, goal.id, stamp, stamp);
    } finally { ledger.close(); }
    const db = harness.openPlanningDb();
    try {
      db.prepare(`INSERT INTO pending_transactions
        (id, name, currency, amount, type, date, status, source_goal_id, ledger_currency,
         ledger_amount, created_at, updated_at)
        VALUES ('stale-goal', 'Synthetic stale allocation', 'PLN', 100, 'goal_allocation', ?, 'pending', ?, 'PLN', 100, ?, ?)`)
        .run(harness.today, goal.id, stamp, stamp);
    } finally { db.close(); }
    await harness.api("/api/pending/stale-goal/regenerate", { method: "POST" });
    const snapshot = await harness.api("/api");
    assert.equal(snapshot.goals.find(row => row.id === goal.id).amount, 100);
    assert.ok(snapshot.confirmedTransactions.some(row => row.id === "fulfilled"));
    assert.ok(![...snapshot.pendingTransactions, ...snapshot.futureTransactions].some(row => row.source_goal_id === goal.id));
  } finally {
    await harness.cleanup();
  }
});