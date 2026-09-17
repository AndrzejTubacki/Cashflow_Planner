import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowProjectionCoordinatorService } from "../../src/server/cashflow-projection-coordinator-service.js";

test("projection coordinator pending helpers use the budget-store transaction surface", async () => {
  let pendingRows = [
    { id: "pending-a" },
    { id: "pending-b" }
  ];
  let transactionCount = 0;

  const budgetStore = {
    backend: "postgres",
    async listPlanningRows(budgetId, tableName) {
      assert.equal(budgetId, "budget-1");
      assert.equal(tableName, "pending_transactions");
      return pendingRows;
    },
    async transaction(work) {
      transactionCount += 1;
      return await work({
        async listPlanningRows(budgetId, tableName) {
          assert.equal(budgetId, "budget-1");
          assert.equal(tableName, "pending_transactions");
          return pendingRows;
        },
        async deletePlanningRowsById(budgetId, tableName, ids) {
          assert.equal(budgetId, "budget-1");
          assert.equal(tableName, "pending_transactions");
          assert.deepEqual(ids, ["pending-a", "pending-b"]);
          pendingRows = [];
          return { deleted: 2 };
        }
      });
    }
  };

  const service = createCashflowProjectionCoordinatorService({
    budgetStore,
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for budget-store pending helpers");
    }
  });

  assert.equal(await service.countPendingTransactions("budget-1"), 2);
  assert.equal(await service.clearPendingTransactions("budget-1"), 2);
  assert.equal(transactionCount, 1);
  assert.equal(await service.countPendingTransactions("budget-1"), 0);
});

test("projection failure recorder uses budget-store rows without opening SQLite", async () => {
  const inserted = [];
  let transactionCount = 0;

  const budgetStore = {
    async listPlanningRows(budgetId, tableName) {
      assert.equal(budgetId, "budget-1");
      assert.equal(tableName, "settings");
      return [{ ledger_currency: "EUR" }];
    },
    async transaction(work) {
      transactionCount += 1;
      return await work({
        listPlanningRows: this.listPlanningRows,
        async insertPlanningRows(budgetId, tableName, rows) {
          assert.equal(budgetId, "budget-1");
          inserted.push({ tableName, rows });
          return { inserted: rows.length };
        }
      });
    }
  };

  const service = createCashflowProjectionCoordinatorService({
    budgetStore,
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for budget-store projection failure recording");
    }
  });

  await service.recordProjectionFailureAsync(
    "budget-1",
    new Error("Projection broke"),
    { EUR: { PLN: 4.2 } }
  );

  assert.equal(transactionCount, 1);
  assert.equal(inserted.length, 2);
  assert.equal(inserted[0].tableName, "projection_snapshots");
  assert.equal(inserted[0].rows[0].ledger_currency, "EUR");
  assert.equal(inserted[0].rows[0].generation_succeeded, false);
  assert.equal(inserted[0].rows[0].warning_count, 1);
  assert.equal(inserted[0].rows[0].fx_rates_used, JSON.stringify({ EUR: { PLN: 4.2 } }));
  assert.equal(inserted[1].tableName, "event_log");
  assert.equal(inserted[1].rows[0].action, "projection_failed");
  assert.equal(inserted[1].rows[0].entity_id, "budget-1");
  assert.match(JSON.parse(inserted[1].rows[0].details).message, /Projection broke/);
});

test("route projection regeneration can clear negative pending through budget-store helpers", async () => {
  let pendingRows = [{
    id: "pending-a",
    type: "expense",
    ledger_amount: 150,
    ledger_currency: "PLN",
    pending_origin: "projection"
  }];
  const deletedIds = [];
  const events = [];
  let transactionCount = 0;
  let projectionRuns = 0;
  let transactionWriter = null;

  const writer = {
    async listPlanningRows(budgetId, tableName) {
      assert.equal(budgetId, "budget-1");
      if (tableName === "settings") return [{ ledger_currency: "PLN", timezone: "UTC" }];
      if (tableName === "pending_transactions") return pendingRows;
      throw new Error(`Unexpected table ${tableName}`);
    },
    async deletePlanningRowsById(budgetId, tableName, ids) {
      assert.equal(budgetId, "budget-1");
      assert.equal(tableName, "pending_transactions");
      deletedIds.push(...ids);
      pendingRows = pendingRows.filter(row => !ids.includes(row.id));
      return { deleted: ids.length };
    }
  };

  const budgetStore = {
    listPlanningRows: writer.listPlanningRows,
    deletePlanningRowsById: writer.deletePlanningRowsById,
    async transaction(work) {
      transactionCount += 1;
      transactionWriter = writer;
      return await work(writer);
    }
  };

  const service = createCashflowProjectionCoordinatorService({
    budgetStore,
    confirmedBalanceAsOfAsync: async (budgetId, cutoffDate, settings, store) => {
      assert.equal(budgetId, "budget-1");
      assert.equal(cutoffDate.length, 10);
      assert.equal(settings.ledger_currency, "PLN");
      assert.equal(store, transactionWriter);
      return 100;
    },
    pendingNetBalanceAsync: async (budgetId, settings, store) => {
      assert.equal(budgetId, "budget-1");
      assert.equal(settings.ledger_currency, "PLN");
      assert.equal(store, transactionWriter);
      return -150;
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async negative-pending cleanup");
    },
    regenerateProjections: budgetId => {
      assert.equal(budgetId, "budget-1");
      projectionRuns += 1;
    },
    logServerEvent: (kind, payload) => events.push({ kind, payload })
  });

  const result = await service.regenerateProjectionsWithFxRefresh("budget-1", {
    refreshFxFirst: false,
    skipProjectionLock: true
  });

  assert.equal(result.projection_ok, true);
  assert.deepEqual(deletedIds, ["pending-a"]);
  assert.equal(transactionCount, 1);
  assert.equal(projectionRuns, 1);
  assert.equal(events[0].kind, "cashflow_pending_cleared_negative_opening_balance");
  assert.equal(events[0].payload.deletedPendingCount, 1);
});

test("async mutation projection status uses budget-store cleanup and runtime lock", async () => {
  let pendingRows = [{
    id: "pending-a",
    type: "expense",
    ledger_amount: 150,
    ledger_currency: "PLN",
    pending_origin: "projection"
  }];
  const lockNames = [];
  let projectionRuns = 0;

  const writer = {
    async listPlanningRows(_budgetId, tableName) {
      if (tableName === "settings") return [{ ledger_currency: "PLN", timezone: "UTC" }];
      if (tableName === "pending_transactions") return pendingRows;
      throw new Error(`Unexpected table ${tableName}`);
    },
    async deletePlanningRowsById(_budgetId, tableName, ids) {
      assert.equal(tableName, "pending_transactions");
      pendingRows = pendingRows.filter(row => !ids.includes(row.id));
      return { deleted: ids.length };
    }
  };

  const service = createCashflowProjectionCoordinatorService({
    budgetStore: {
      listPlanningRows: writer.listPlanningRows,
      deletePlanningRowsById: writer.deletePlanningRowsById,
      async transaction(work) {
        return await work(writer);
      }
    },
    confirmedBalanceAsOfAsync: async () => 100,
    pendingNetBalanceAsync: async () => -150,
    lockService: {
      async withLock(lockName, work) {
        lockNames.push(lockName);
        return {
          acquired: true,
          result: await work()
        };
      }
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async projection status");
    },
    regenerateProjections: budgetId => {
      assert.equal(budgetId, "budget-1");
      projectionRuns += 1;
    },
    logCashflowError: () => {},
    logServerEvent: () => {}
  });

  const result = await service.regenerateProjectionsAfterMutationAsync("budget-1");

  assert.equal(result.projection_ok, true);
  assert.equal(projectionRuns, 1);
  assert.deepEqual(pendingRows, []);
  assert.equal(lockNames.length, 1);
  assert.match(lockNames[0], /projection/);
});

test("async mutation projection failure uses async FX snapshots before recording diagnostics", async () => {
  const inserted = [];
  let cachedSnapshotCalls = 0;

  const writer = {
    async listPlanningRows(_budgetId, tableName) {
      if (tableName === "settings") return [{ ledger_currency: "PLN", timezone: "UTC" }];
      if (tableName === "pending_transactions") return [];
      throw new Error(`Unexpected table ${tableName}`);
    },
    async insertPlanningRows(_budgetId, tableName, rows) {
      inserted.push({ tableName, rows });
      return { inserted: rows.length };
    }
  };

  const service = createCashflowProjectionCoordinatorService({
    budgetStore: {
      listPlanningRows: writer.listPlanningRows,
      async transaction(work) {
        return await work(writer);
      }
    },
    getCachedFxSnapshot: () => {
      throw new Error("sync cached FX snapshot should not be used");
    },
    getCachedFxSnapshotAsync: async budgetId => {
      assert.equal(budgetId, "budget-1");
      cachedSnapshotCalls += 1;
      return { eur: { rate: 4.2 } };
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async projection failure status");
    },
    regenerateProjections: () => {
      throw new Error("Projection failed");
    },
    safeGetCurrentFxSnapshot: () => {
      throw new Error("sync safe FX snapshot should not be used");
    },
    safeGetCurrentFxSnapshotAsync: async budgetId => {
      assert.equal(budgetId, "budget-1");
      return null;
    },
    logCashflowError: () => {},
    logServerEvent: () => {}
  });

  const result = await service.regenerateProjectionsAfterMutationAsync("budget-1");

  assert.equal(result.projection_ok, false);
  assert.equal(result.projection_error, "Projection failed");
  assert.equal(cachedSnapshotCalls, 1);
  assert.equal(inserted[0].tableName, "projection_snapshots");
  assert.equal(inserted[0].rows[0].fx_rates_used, JSON.stringify({ eur: { rate: 4.2 } }));
  assert.equal(inserted[1].tableName, "event_log");
});

// Coverage for the postgres branch: `regenerateProjections` must never be
// called once a Postgres-shaped budget store and `regenerateProjectionsAsync`
// are both present — every projection-status entry point should route to the
// async engine instead, matching how `canUseAsyncProjectionEngine()` gates it.

function throwIfCalled(name) {
  return () => {
    throw new Error(`${name} should not be called on the Postgres projection path`);
  };
}

// `clearPendingIfItCausesNegativeOpeningBalanceAsync` (called by every
// projection-status entry point below) falls back to the sync SQLite path
// unless the budget store exposes both `listPlanningRows` and
// `deletePlanningRowsById` alongside async balance helpers, so every mock
// budget store here needs at least these two no-op-shaped methods.
function postgresBudgetStoreStub() {
  return {
    backend: "postgres",
    async listPlanningRows(_budgetId, tableName) {
      if (tableName === "settings") return [{ ledger_currency: "PLN", timezone: "UTC" }];
      if (tableName === "pending_transactions") return [];
      throw new Error(`Unexpected table ${tableName}`);
    },
    async deletePlanningRowsById() {
      return { deleted: 0 };
    }
  };
}

test("regenerateProjectionsWithFxRefresh uses the async projection engine for a Postgres budget store", async () => {
  let asyncRuns = 0;

  const service = createCashflowProjectionCoordinatorService({
    budgetStore: postgresBudgetStoreStub(),
    openPlanningDb: throwIfCalled("openPlanningDb"),
    regenerateProjections: throwIfCalled("regenerateProjections"),
    regenerateProjectionsAsync: async budgetId => {
      assert.equal(budgetId, "budget-1");
      asyncRuns += 1;
    },
    confirmedBalanceAsOfAsync: async () => 0,
    pendingNetBalanceAsync: async () => 0,
    logServerEvent: () => {}
  });

  const result = await service.regenerateProjectionsWithFxRefresh("budget-1", {
    refreshFxFirst: false,
    skipProjectionLock: true
  });

  assert.equal(result.projection_ok, true);
  assert.equal(asyncRuns, 1);
});

test("regenerateProjectionsAfterMutationAsync uses the async projection engine for a Postgres budget store", async () => {
  let asyncRuns = 0;

  const service = createCashflowProjectionCoordinatorService({
    budgetStore: postgresBudgetStoreStub(),
    confirmedBalanceAsOfAsync: async () => 0,
    pendingNetBalanceAsync: async () => 0,
    openPlanningDb: throwIfCalled("openPlanningDb"),
    regenerateProjections: throwIfCalled("regenerateProjections"),
    regenerateProjectionsAsync: async budgetId => {
      assert.equal(budgetId, "budget-1");
      asyncRuns += 1;
    },
    logCashflowError: () => {},
    logServerEvent: () => {}
  });

  const result = await service.regenerateProjectionsAfterMutationAsync("budget-1");

  assert.equal(result.projection_ok, true);
  assert.equal(asyncRuns, 1);
});

test("withProjectionStatus routes through the async projection engine and attaches its result for a Postgres budget store", async () => {
  let asyncRuns = 0;

  const service = createCashflowProjectionCoordinatorService({
    budgetStore: postgresBudgetStoreStub(),
    confirmedBalanceAsOfAsync: async () => 0,
    pendingNetBalanceAsync: async () => 0,
    openPlanningDb: throwIfCalled("openPlanningDb"),
    regenerateProjections: throwIfCalled("regenerateProjections"),
    regenerateProjectionsAsync: async budgetId => {
      assert.equal(budgetId, "budget-1");
      asyncRuns += 1;
    },
    logCashflowError: () => {},
    logServerEvent: () => {}
  });

  const withResult = await service.withProjectionStatus("budget-1", { id: "row-1" });
  assert.equal(withResult.id, "row-1");
  assert.equal(withResult._projection.projection_ok, true);

  const preserveResult = await service.withProjectionStatus("budget-1", { id: "row-2" }, { preservePending: true });
  assert.equal(preserveResult.id, "row-2");
  assert.equal(preserveResult._projection.projection_ok, true);

  assert.equal(asyncRuns, 2);
});

test("withProjectionStatus still returns synchronously for the default SQLite budget store (no backend/postgres flag)", () => {
  let syncRuns = 0;

  const service = createCashflowProjectionCoordinatorService({
    openPlanningDb: throwIfCalled("openPlanningDb"),
    regenerateProjections: budgetId => {
      assert.equal(budgetId, "budget-1");
      syncRuns += 1;
    },
    regenerateProjectionsAsync: throwIfCalled("regenerateProjectionsAsync"),
    logCashflowError: () => {},
    logServerEvent: () => {}
  });

  // Deliberately not awaited: the SQLite path must keep returning a plain
  // object synchronously, not a Promise, so existing non-async callers of
  // planner mutation functions are not broken by this change.
  const result = service.withProjectionStatus("budget-1", { id: "row-1" });

  assert.equal(result.id, "row-1");
  assert.equal(result._projection.projection_ok, true);
  assert.equal(syncRuns, 1);
});
