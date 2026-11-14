import assert from "node:assert/strict";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

// A browser session can select a budget different from its login/default budget.
// Such a PostgreSQL budget has no SQLite directory; selection must use the async
// metadata/membership resolver, including its denial of ungranted budgets.
test("Postgres browser header selects a second budget without SQLite storage", {
  skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests"
}, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    let harness;
    try {
      await global.initialize(); await budget.initialize();
      harness = await createCashflowTestHarness({ userId: "selected-owner", initializeUser: false,
        databaseConfig: { backend: "postgres", supported: true, external: true, databaseUrlConfigured: true } });
      await harness.api("/api/users", { method: "POST", skipUserHeader: true,
        body: { userId: "selected-owner", displayName: "Synthetic owner" } });
      const other = (await harness.api("/api/budgets", { method: "POST", useSession: true,
        body: { displayName: "Second budget" } })).budget.id;
      const headers = { "x-cashflow-budget-id": other };
      const setup = await harness.request("/api/setup", { method: "POST", useSession: true, headers,
        body: { currency: "EUR", opening_balance: 25, income_enabled: false } });
      assert.equal(setup.response.status, 200, JSON.stringify(setup.body));
      assert.equal((await budget.listPlanningRows(other, "settings"))[0].ledger_currency, "EUR");
      assert.equal((await budget.listPlanningRows("selected-owner", "settings"))[0].setup_completed, false);
      assert.equal((await harness.request("/api", { useSession: true, headers })).response.status, 200);
      assert.notEqual((await harness.request("/api", { useSession: true,
        headers: { "x-cashflow-budget-id": "missing-budget" } })).response.status, 200);
    } finally {
      await harness?.cleanup(); await budget.close(); await global.close();
    }
  });
});
