import test from "node:test";
import assert from "node:assert";
import { createCashflowBackgroundJobs } from "../../src/server/cashflow-background-jobs.js";

test("failing background job does not block sibling jobs for the same user", async () => {
  const calls = [];
  const events = [];
  
  const jobs = createCashflowBackgroundJobs({
    listCashflowUserIdsAsync: async () => ["budget-1"],
    logError: () => {},
    logServerEvent: (kind, details) => events.push({ kind, details }),
    maybeRunAutomaticBackup: () => null,
    moveDueFutureTransactionsToPending: userId => {
      calls.push(["midnight", userId]);
      throw new Error("Simulated midnight job failure");
    },
    now: () => new Date("2026-06-03T08:05:00.000Z"),
    queueDailyPendingSummary: () => 0,
    queueMissingIncomeNotifications: () => 0,
    refreshNbpFxCacheForAllUsers: async () => [],
    refreshNbpFxCacheForUser: async userId => {
      calls.push(["fx", userId]);
      return { updated_count: 1 };
    },
    sendQueuedNotifications: async userId => {
      calls.push(["notify", userId]);
      return 0;
    },
    cleanupOperationalData: () => {},
    compactLedgerHistory: async () => null,
    getSettings: () => ({}),
    openPlanningDb: () => null
  });

  const result = await jobs.tickPerUserJobs();
  
  assert.equal(result.skipped, false);
  assert.deepEqual(calls, [
    ["midnight", "budget-1"],
    ["fx", "budget-1"],
    ["notify", "budget-1"]
  ], "fx and notify jobs should still run even if midnight throws");
});
