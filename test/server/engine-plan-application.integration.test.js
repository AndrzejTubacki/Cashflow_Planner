import assert from "node:assert/strict";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { createSqliteBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { applyProjectionGenerationPlanToBudgetStore } from "../../src/server/cashflow-projection-engine-service.js";
import { prepareSnapshot } from "../../src/engine/prepare-snapshot.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";

test("app-prepared projection applies atomically to real SQLite planning storage", async () => {
  const harness = await createCashflowTestHarness({ userId: "app-plan", today: "2026-06-01" });
  try {
    const service = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
    const store = createSqliteBudgetStore(service);
    await harness.api("/api/one-off", { method: "POST", body: {
      name: "Future bill", currency: "PLN", amount: 30, type: "expense", date: "2026-06-10"
    } });
    const names = ["planned_transactions", "recurring_expenses", "recurring_incomes", "flex_transactions",
      "goals", "one_off_transactions", "pending_transactions", "future_transactions", "projection_snapshots"];
    const tables = Object.fromEntries(await Promise.all(names.map(async name => [name, await store.listPlanningRows(harness.userId, name)])));
    const settings = (await store.listPlanningRows(harness.userId, "settings"))[0];
    const snapshot = prepareSnapshot({ budgetId: harness.userId, revision: 0, tables, settings,
      confirmedRows: [], fxSnapshot: null, today: harness.today,
      generationTimestamp: "2026-06-01T00:00:00.000Z", idSeed: "sqlite-apply-test" });
    const { plan } = calculateSnapshot(snapshot);
    const before = await store.listPlanningRows(harness.userId, "future_transactions");
    const originalSources = await store.listPlanningRows(harness.userId, "one_off_transactions");
    // A composed projection must not independently commit its caller's source
    // edit. A caught nested SQL failure must also leave that caller usable.
    await assert.rejects(() => store.planningTransaction(harness.userId, async writer => {
      await writer.updatePlanningRowsById(harness.userId, "one_off_transactions", [{
        id: originalSources[0].id, name: "Uncommitted source edit"
      }]);
      assert.equal((await writer.listPlanningRows(harness.userId, "one_off_transactions"))[0].name, "Uncommitted source edit");
      await applyProjectionGenerationPlanToBudgetStore({ budgetId: harness.userId, budgetStore: writer, plan });
      throw new Error("late source boundary failure");
    }), /late source boundary failure/);
    assert.deepEqual(await store.listPlanningRows(harness.userId, "one_off_transactions"), originalSources);
    assert.deepEqual(await store.listPlanningRows(harness.userId, "future_transactions"), before);
    await store.planningTransaction(harness.userId, async writer => {
      await assert.rejects(() => writer.planningTransaction(harness.userId, nested =>
        nested.insertPlanningRows(harness.userId, "one_off_transactions", [originalSources[0]])), /UNIQUE constraint/);
      assert.deepEqual(await writer.listPlanningRows(harness.userId, "one_off_transactions"), originalSources);
      await assert.rejects(() => writer.planningTransaction("other-budget", async () => {}), /another budget/);
    });
    const db = service.openPlanningDb(harness.userId);
    db.exec(`CREATE TRIGGER fail_projection BEFORE INSERT ON projection_snapshots
      BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END;`);
    db.close();
    await assert.rejects(() => applyProjectionGenerationPlanToBudgetStore({ budgetId: harness.userId, budgetStore: store, plan }), /injected projection failure/);
    assert.deepEqual(await store.listPlanningRows(harness.userId, "future_transactions"), before);
    const control = service.openPlanningDb(harness.userId);
    control.exec("DROP TRIGGER fail_projection"); control.close();
    await assert.rejects(() => applyProjectionGenerationPlanToBudgetStore({ budgetId: harness.userId, budgetStore: store, plan,
      afterWrite: async writer => {
        assert.equal((await writer.listPlanningRows(harness.userId, "future_transactions")).length, plan.futureRows.length);
        throw new Error("injected balance failure");
      } }), /injected balance failure/);
    assert.deepEqual(await store.listPlanningRows(harness.userId, "future_transactions"), before);
    const applied = await applyProjectionGenerationPlanToBudgetStore({ budgetId: harness.userId, budgetStore: store, plan });
    assert.equal(applied.ok, true);
    const after = await store.listPlanningRows(harness.userId, "future_transactions");
    assert.equal(after.length, plan.futureRows.length);
    assert.deepEqual(after.map(row => row.id), plan.futureRows.map(row => row.id));
    // Exercise the synchronous runtime adapter through a real mutation. A late
    // projection failure must roll back generated rows, not erase the old plan.
    const beforeRuntime = await store.listPlanningRows(harness.userId, "future_transactions");
    const runtimeDb = service.openPlanningDb(harness.userId);
    runtimeDb.exec(`CREATE TRIGGER fail_projection BEFORE INSERT ON projection_snapshots
      BEGIN SELECT RAISE(ABORT, 'injected sync projection failure'); END;`);
    runtimeDb.close();
    const mutation = await harness.request("/api/one-off", { method: "POST", body: {
      name: "Another future bill", currency: "PLN", amount: 10, type: "expense", date: "2026-06-11"
    } });
    assert.equal(mutation.response.status, 500);
    assert.match(mutation.body.error, /injected sync projection failure/);
    assert.deepEqual(await store.listPlanningRows(harness.userId, "future_transactions"), beforeRuntime);
    assert.deepEqual(await store.listPlanningRows(harness.userId, "one_off_transactions"), originalSources);
    const failedEdit = await harness.request(`/api/one-off/${encodeURIComponent(originalSources[0].id)}`, {
      method: "PUT", body: { name: "Rejected edit", amount: 99 }
    });
    assert.equal(failedEdit.response.status, 500);
    assert.deepEqual(await store.listPlanningRows(harness.userId, "one_off_transactions"), originalSources);
    assert.deepEqual(await store.listPlanningRows(harness.userId, "future_transactions"), beforeRuntime);
    const failedDelete = await harness.request(`/api/one-off/${encodeURIComponent(originalSources[0].id)}`, { method: "DELETE" });
    assert.equal(failedDelete.response.status, 500);
    assert.deepEqual(await store.listPlanningRows(harness.userId, "one_off_transactions"), originalSources);
    assert.deepEqual(await store.listPlanningRows(harness.userId, "future_transactions"), beforeRuntime);
    const cleanup = service.openPlanningDb(harness.userId);
    cleanup.exec("DROP TRIGGER fail_projection"); cleanup.close();
    await assert.rejects(() => store.planningTransaction(harness.userId,
      writer => writer.listPlanningRows("other-budget", "settings")), /another budget/);
  } finally { await harness.cleanup(); }
});

test("SQLite planner families roll back sources, priorities and settings on late projection failure", async () => {
  const harness = await createCashflowTestHarness({ userId: "atomic-families", today: "2026-06-01" });
  try {
    const store = createSqliteBudgetStore(createCashflowDbService(createCashflowStoragePaths(harness.dataDir)));
    const tracked = ["recurring_incomes", "recurring_expenses", "goals", "flex_transactions", "planned_transactions",
      "settings", "pending_transactions", "future_transactions", "projection_snapshots"];
    const capture = async () => Object.fromEntries(await Promise.all(tracked.map(async table =>
      [table, await store.listPlanningRows(harness.userId, table)])));
    const trigger = enabled => {
      const db = harness.openPlanningDb();
      try {
        db.exec(enabled ? `CREATE TRIGGER reject_atomic_projection BEFORE INSERT ON projection_snapshots
          BEGIN SELECT RAISE(ABORT, 'late planner failure'); END;` : "DROP TRIGGER reject_atomic_projection");
      } finally { db.close(); }
    };
    for (const [route, fields] of [
      ["recurring-incomes", { anchor_type: "day_of_month", anchor_day_of_month: 15, period_setting: true }],
      ["recurring-expenses", { anchor_type: "day_of_month", anchor_day_of_month: 16, necessary: true }],
      ["goals", { due_date: "2026-06-10" }], ["flex", {}]
    ]) {
      const input = { name: `Atomic ${route}`, currency: "PLN", amount: 10, active: true, ...fields };
      const beforeCreate = await capture();
      trigger(true);
      const failedCreate = await harness.request(`/api/${route}`, { method: "POST", body: input });
      assert.equal(failedCreate.response.status, 500, route);
      assert.match(failedCreate.body.error, /late planner failure/);
      assert.deepEqual(await capture(), beforeCreate, `${route} create`);
      trigger(false);
      const source = await harness.api(`/api/${route}`, { method: "POST", body: input });
      const beforeEdit = await capture();
      trigger(true);
      for (const [method, body] of [["PUT", { name: "Rejected" }], ["DELETE", undefined]]) {
        const failed = await harness.request(`/api/${route}/${source.id}`, { method, ...(body ? { body } : {}) });
        assert.equal(failed.response.status, 500, `${route} ${method}`);
        assert.match(failed.body.error, /late planner failure/);
        assert.deepEqual(await capture(), beforeEdit, `${route} ${method}`);
      }
      trigger(false);
      assert.equal((await harness.api(`/api/${route}/${source.id}`, { method: "PUT", body: { name: "Accepted" } })).name, "Accepted");
      assert.equal((await harness.api(`/api/${route}/${source.id}`, { method: "DELETE" })).ok, true);
    }
    // Settings and FX policy must be read through the same SQLite connection;
    // the new manual rate is not visible to a separately opened reader yet.
    const source = await harness.api("/api/one-off", { method: "POST", body: {
      name: "Euro bill", amount: 10, currency: "EUR", type: "expense", date: "2026-06-10"
    } });
    const beforeSettings = await capture();
    trigger(true);
    const rejectedSettings = await harness.request("/api/settings", { method: "PUT",
      body: { fx_provider: "manual", manual_fx_rates: { EUR: 7 }, future_periods: 3 } });
    assert.equal(rejectedSettings.response.status, 500);
    assert.deepEqual(await capture(), beforeSettings);
    trigger(false);
    const acceptedSettings = await harness.api("/api/settings", { method: "PUT",
      body: { fx_provider: "manual", manual_fx_rates: { EUR: 7 }, future_periods: 3 } });
    assert.equal(acceptedSettings._projection.projection_ok, true);
    const generated = await store.listPlanningRows(harness.userId, "future_transactions");
    assert.equal(generated.find(row => row.source_one_off_id === source.id).fx_rate, 7);
    const future = generated.find(row => row.source_one_off_id === source.id);
    const beforeTransition = await capture();
    trigger(true);
    const rejectedMove = await harness.request(`/api/future/${future.id}/move-to-pending`, { method: "POST",
      body: { occurrenceKey: future.occurrence_key } });
    assert.equal(rejectedMove.response.status, 500);
    assert.deepEqual(await capture(), beforeTransition);
    trigger(false);
    const moved = await harness.api(`/api/future/${future.id}/move-to-pending`, { method: "POST",
      body: { occurrenceKey: future.occurrence_key } });
    assert.equal(moved.move.moved, true);
  } finally { await harness.cleanup(); }
});