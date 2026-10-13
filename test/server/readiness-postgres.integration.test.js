import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCashflowModule } from "../../src/cashflow.js";
import { createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createPostgresBudgetDbService } from "../../src/server/cashflow-postgres-budget-db-service.js";
import { createPostgresGlobalDbService } from "../../src/server/cashflow-postgres-global-db-service.js";
import {
  POSTGRES_LEDGER_SCHEMA_VERSION,
  POSTGRES_PLANNING_SCHEMA_VERSION
} from "../../src/server/cashflow-postgres-budget-schema.js";
import {
  postgresRuntimeTestsEnabled,
  withDisposablePostgresDb
} from "../helpers/postgres-test-db.js";

const SKIP_REASON = "set CASHFLOW_ENABLE_POSTGRES_TESTS=1 and CASHFLOW_DATABASE_URL to run disposable Postgres tests";
const repoRoot = path.resolve(import.meta.dirname, "../..");
const localeDir = path.join(repoRoot, "public", "app", "cashflow", "locales");

function postgresDatabaseConfig() {
  return {
    backend: "postgres",
    databaseUrlConfigured: true,
    external: true,
    supported: true
  };
}

async function withTempDataDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "cashflow-readiness-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedBudgetRow(globalDb, budgetId) {
  await globalDb.withClient(client => client.query(
    `
      INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at)
      VALUES ($1, $1, 'Test budget', now(), now())
    `,
    [budgetId]
  ));
}

async function seedSettingsRow(budgetDb, budgetId) {
  await budgetDb.withClient(client => client.query(
    "INSERT INTO settings (budget_id, updated_at) VALUES ($1, now())",
    [budgetId]
  ));
}

test("Postgres budget-store readiness forwards the requested budget ID to the database service", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes("cashflow_budget_schema_version")) {
        return {
          rows: [{
            ledger_version: POSTGRES_LEDGER_SCHEMA_VERSION,
            planning_version: POSTGRES_PLANNING_SCHEMA_VERSION
          }]
        };
      }
      if (sql.includes("FROM settings")) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  class FakePool {
    async connect() { return client; }
    async end() {}
  }
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://unused/readiness",
    pgModule: { Pool: FakePool }
  });
  try {
    await assert.rejects(
      () => store.checkReadiness("local"),
      error => error.code === "CASHFLOW_POSTGRES_BUDGET_NOT_FOUND"
    );
    assert.deepEqual(
      queries.find(query => query.sql.includes("FROM settings"))?.params,
      ["local"]
    );
  } finally {
    await store.close();
  }
});

test(
  "postgres checkReadiness(budgetId) verifies the specific budget's settings row, not just schema version",
  { skip: postgresRuntimeTestsEnabled() ? false : SKIP_REASON },
  async () => {
    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      const globalDb = await createPostgresGlobalDbService({ databaseUrl });
      const budgetDb = await createPostgresBudgetDbService({ databaseUrl });
      try {
        await globalDb.initializeGlobalSchema();
        await budgetDb.initializeBudgetSchema();
        await seedBudgetRow(globalDb, "local");

        // Schema is valid, but budget "local" has no settings row yet: must fail
        // with a distinguishable "not found" code, not silently report ok.
        await assert.rejects(
          () => budgetDb.checkReadiness("local"),
          error => error.code === "CASHFLOW_POSTGRES_BUDGET_NOT_FOUND"
        );

        // The schema-only check (no budgetId) is unaffected by per-budget existence.
        const schemaOnly = await budgetDb.checkReadiness();
        assert.equal(schemaOnly.ok, true);

        await seedSettingsRow(budgetDb, "local");

        const ready = await budgetDb.checkReadiness("local");
        assert.equal(ready.ok, true);
        assert.equal(ready.budgetId, "local");
        assert.equal(typeof ready.planningSchemaVersion, "number");
      } finally {
        await globalDb.close();
        await budgetDb.close();
      }
    });
  }
);

test(
  "cashflow.readinessCheck() is backend-aware for the default budget on postgres",
  { skip: postgresRuntimeTestsEnabled() ? false : SKIP_REASON },
  async () => {
    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      await withTempDataDir(async dataDir => {
        const globalDb = await createPostgresGlobalDbService({ databaseUrl });
        const budgetDb = await createPostgresBudgetDbService({ databaseUrl });
        await globalDb.initializeGlobalSchema();
        await budgetDb.initializeBudgetSchema();
        await seedBudgetRow(globalDb, "local");
        await globalDb.close();
        await budgetDb.close();

        const cashflow = await createCashflowModule({
          appVersion: "0.0.0-test",
          dataDir,
          databaseConfig: postgresDatabaseConfig(),
          env: { CASHFLOW_DATABASE_URL: databaseUrl },
          localeDir,
          getCurrentFxSnapshot: () => null,
          logError: () => {},
          logServerEvent: () => {},
          appendApiLogLine: () => {}
        });

        try {
          // Before the fix, this branch used fs.existsSync() on a SQLite planning-file
          // path that never exists in postgres mode, so defaultBudgetPresent was always
          // false regardless of real state, and budgetStore.checkReadiness() was never
          // reached at all. Confirm it now correctly reports "missing".
          const before = await cashflow.readinessCheck({ checkDefaultBudget: true });
          assert.equal(before.databaseBackend, "postgres");
          assert.equal(before.defaultBudgetChecked, true);
          assert.equal(before.defaultBudgetPresent, false);
          assert.equal(before.defaultBudgetSchemaVersion, null);
  
          const budgetDb2 = await createPostgresBudgetDbService({ databaseUrl });
          try {
            await seedSettingsRow(budgetDb2, "local");
          } finally {
            await budgetDb2.close();
          }
  
          // This is the case the old code could never detect on postgres: a budget
          // that genuinely exists must now be reported as present.
          const after = await cashflow.readinessCheck({ checkDefaultBudget: true });
          assert.equal(after.defaultBudgetPresent, true);
          assert.equal(typeof after.defaultBudgetSchemaVersion, "number");
        } finally {
          await cashflow.close();
        }
      });
    });
  }
);
