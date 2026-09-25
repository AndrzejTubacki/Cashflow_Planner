import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowBudgetService } from "../../src/server/cashflow-budget-service.js";
import { createCashflowGlobalService } from "../../src/server/cashflow-global-service.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

const gated = { skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests" };

// Exercise real committed metadata, owner guards, settings FKs and cascades;
// inject only the storage failure that occurs between independent transactions.
test("failed Postgres budget initialization removes committed metadata and partial settings", gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const globalStore = await createPostgresGlobalStore({ databaseUrl });
    const budgetStore = await createPostgresBudgetStore({ databaseUrl });
    try {
      await globalStore.initialize();
      await budgetStore.initialize();
      await globalStore.transaction(async repo => {
        await repo.accounts.insert({ id: "review_owner", displayName: "Review owner" });
      });
      const globalService = createCashflowGlobalService({
        globalStore, budgetStore,
        openGlobalDb: () => { throw new Error("unexpected SQLite access"); }
      });
      const errors = [];
      const cleaned = [];
      let phase = "success";
      let attemptedId;
      let observedFailure;
      const service = createCashflowBudgetService({
        globalStore,
        logError: (kind, details) => errors.push({ kind, details }),
        // Async cleanup must be awaited, including its rejection path.
        deleteBudgetStorage: async id => {
          await Promise.resolve();
          cleaned.push(id);
          if (phase === "cleanup") throw new Error("physical cleanup unavailable");
        },
        initializeBudgetStorageAsync: async id => {
          attemptedId = id;
          if (phase === "after") await globalService.initializeBudgetStorageAsync(id);
          if (phase !== "success") {
            observedFailure = new Error(`storage failed ${phase} settings`);
            throw observedFailure;
          }
          return globalService.initializeBudgetStorageAsync(id);
        }
      });
      const existing = await service.createBudgetAsync("review_owner", { displayName: "Existing" });
      for (phase of ["before", "after", "cleanup"]) {
        await assert.rejects(service.createBudgetAsync("review_owner", { displayName: `Failed ${phase}` }),
          error => error === observedFailure);
        const id = attemptedId;
        assert.equal((await pool.query("SELECT id FROM budgets WHERE id = $1", [id])).rowCount, 0,
          "failed creation must not leave committed budget metadata");
        assert.equal((await pool.query("SELECT budget_id FROM budget_memberships WHERE budget_id = $1", [id])).rowCount, 0);
        assert.equal((await budgetStore.listPlanningRows(id, "settings")).length, 0);
        assert.ok(cleaned.includes(id));
        const audit = await pool.query("SELECT action, outcome FROM security_audit_log WHERE target_id = $1 ORDER BY created_at, id", [id]);
        assert.ok(audit.rows.some(row => row.action === "budget_create_rollback" && row.outcome === "failure"));
      }
      assert.deepEqual((await service.listBudgetsForAccountAsync("review_owner")).map(row => row.id), [existing.id]);
      assert.equal((await budgetStore.listPlanningRows(existing.id, "settings")).length, 1);
      assert.equal((await pool.query("SELECT id FROM accounts WHERE id = 'review_owner'")).rowCount, 1);
      assert.equal(errors.filter(event => event.kind === "cashflow_budget_create_failed").length, 3);
      assert.equal(errors.filter(event => event.kind === "cashflow_budget_storage_cleanup_failed").length, 1);
      phase = "success";
      const retry = await service.createBudgetAsync("review_owner", { displayName: "Retry" });
      assert.equal(retry.role, "owner");
      assert.equal((await budgetStore.listPlanningRows(retry.id, "settings")).length, 1);

      // A metadata failure must roll back by itself and never initialize storage.
      await pool.query("ALTER TABLE budgets ADD CONSTRAINT review_reject_budget CHECK (display_name <> 'Reject metadata')");
      const previousAttempt = attemptedId;
      await assert.rejects(service.createBudgetAsync("review_owner", { displayName: "Reject metadata" }),
        error => error.code === "23514");
      assert.equal(attemptedId, previousAttempt);
      assert.equal((await service.listBudgetsForAccountAsync("review_owner")).length, 2);
    } finally {
      await budgetStore.close();
      await globalStore.close();
    }
  });
});
