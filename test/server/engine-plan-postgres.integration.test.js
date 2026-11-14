import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { applyProjectionGenerationPlanToBudgetStore } from "../../src/server/cashflow-projection-engine-service.js";
import { prepareSnapshot } from "../../src/engine/prepare-snapshot.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { createAppSnapshotService } from "../../src/server/cashflow-app-snapshot-service.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

test("app-prepared PostgreSQL projection rolls back late failure and persists a successful retry",
  { skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests" }, async () => {
    await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
      const global = await createPostgresGlobalStore({ databaseUrl });
      const store = await createPostgresBudgetStore({ databaseUrl });
      const budgetId = "app-postgres";
      try {
        await global.initialize(); await store.initialize();
        await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,$1,now(),now())", [budgetId]);
        await pool.query("INSERT INTO settings (budget_id, future_periods, updated_at) VALUES ($1,3,now())", [budgetId]);
        await store.insertPlanningRows(budgetId, "one_off_transactions", [{ id: "bill", name: "Bill",
          currency: "PLN", amount: 30, type: "expense", date: "2026-06-10",
          created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" }]);
        const names = ["planned_transactions", "recurring_expenses", "recurring_incomes", "flex_transactions",
          "goals", "one_off_transactions", "pending_transactions", "future_transactions", "projection_snapshots"];
        const tables = Object.fromEntries(await Promise.all(names.map(async name => [name, await store.listPlanningRows(budgetId, name)])));
        const settings = (await store.listPlanningRows(budgetId, "settings"))[0];
        const snapshot = prepareSnapshot({ budgetId, revision: 0, settings, tables, confirmedRows: [],
          fxSnapshot: null, today: "2026-06-01", generationTimestamp: "2026-06-01T00:00:00.000Z", idSeed: "postgres-apply-test" });
        const { plan } = calculateSnapshot(snapshot);
        await pool.query(`CREATE FUNCTION cashflow_fail_projection() RETURNS trigger LANGUAGE plpgsql AS
          $$ BEGIN RAISE EXCEPTION 'injected projection failure'; END $$`);
        await pool.query("CREATE TRIGGER cashflow_fail_projection BEFORE INSERT ON projection_snapshots FOR EACH ROW EXECUTE FUNCTION cashflow_fail_projection()");
        await assert.rejects(() => applyProjectionGenerationPlanToBudgetStore({ budgetId, budgetStore: store, plan }), /injected projection failure/);
        assert.equal((await store.listPlanningRows(budgetId, "future_transactions")).length, 0);
        assert.equal((await store.listPlanningRows(budgetId, "projection_snapshots")).length, 0);
        await pool.query("DROP TRIGGER cashflow_fail_projection ON projection_snapshots");
        await pool.query("DROP FUNCTION cashflow_fail_projection()");
        await assert.rejects(() => applyProjectionGenerationPlanToBudgetStore({ budgetId, budgetStore: store, plan,
          afterWrite: async writer => {
            assert.equal((await writer.listPlanningRows(budgetId, "future_transactions")).length, plan.futureRows.length);
            throw new Error("injected balance failure");
          } }), /injected balance failure/);
        assert.equal((await store.listPlanningRows(budgetId, "future_transactions")).length, 0);
        assert.equal((await store.listPlanningRows(budgetId, "projection_snapshots")).length, 0);
        const applied = await applyProjectionGenerationPlanToBudgetStore({ budgetId, budgetStore: store, plan });
        assert.equal(applied.ok, true);
        const future = await store.listPlanningRows(budgetId, "future_transactions");
        assert.deepEqual(future.map(row => row.id), plan.futureRows.map(row => row.id));
        assert.equal(future[0].ledger_amount, 0);
        assert.equal(future[0].status, "underfunded");
        const countsBefore = await store.countRows(budgetId, "projection_snapshots");
        const getAppSnapshot = createAppSnapshotService({ budgetStore: store });
        const exported = await getAppSnapshot(budgetId);
        assert.equal(exported.budgetId, budgetId);
        assert.equal(exported.writesSupported, false);
        assert.equal(exported.consistency, "postgres-repeatable-read");
        assert.equal(exported.request.tables.one_off_transactions.length, 1);
        assert.equal(exported.request.settings.ntfy_auth_token, undefined);
        assert.doesNotThrow(() => calculateSnapshot(exported));
        assert.equal(await store.countRows(budgetId, "projection_snapshots"), countsBefore);
      } finally {
        await pool.query("DROP FUNCTION IF EXISTS cashflow_fail_projection() CASCADE");
        await store.close(); await global.close();
      }
    });
  });