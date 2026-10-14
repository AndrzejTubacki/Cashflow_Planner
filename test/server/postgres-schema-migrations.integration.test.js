import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { createDatabaseUpdateMiddleware } from "../../src/server/cashflow-database-update-mode.js";
import {
  createPostgresMigrationBackup,
  runPostgresMigrations
} from "../../src/server/cashflow-postgres-migrations.js";
import { createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

const gated = { skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests" };
const repoRoot = path.resolve(import.meta.dirname, "../..");
const migrationsDir = path.join(repoRoot, "scripts", "migrations");

async function preparePreviousSchema(databaseUrl, pool) {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try {
    await global.initialize();
    await budget.initialize();
    await pool.query("ALTER TABLE accounts DROP COLUMN avatar");
    await pool.query("UPDATE cashflow_global_schema_version SET version = 5 WHERE id = 1");
  } finally {
    await Promise.all([global.close(), budget.close()]);
  }
}

function quoteIdentifier(identifier) {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

async function schemaTableCounts(pool, schemaName) {
  const tables = (await pool.query(`SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = $1 AND table_type = 'BASE TABLE'
    ORDER BY table_name`, [schemaName])).rows.map(row => row.table_name);
  const counts = {};
  for (const table of tables) {
    counts[table] = (await pool.query(`SELECT count(*)::bigint AS count FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(table)}`)).rows[0].count;
  }
  return counts;
}

async function backupSchemaNames(pool) {
  return (await pool.query(`SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'cashflow_premigration\\_%' ESCAPE '\\'
    ORDER BY nspname`)).rows.map(row => row.nspname);
}

test("a previous Postgres schema is migrated to current", gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await preparePreviousSchema(databaseUrl, pool);
    const beforeCounts = await schemaTableCounts(pool, "public");
    const manual = await runPostgresMigrations({ databaseUrl, migrationsDir, autoMigrate: false });
    assert.equal(manual.current, false);
    assert.deepEqual(manual.pending, ["postgres-v1.1.0.sql"]);
    assert.equal((await pool.query("SELECT version FROM cashflow_global_schema_version WHERE id = 1")).rows[0].version, 5);
    const result = await runPostgresMigrations({ databaseUrl, migrationsDir });
    assert.equal(result.current, true);
    assert.deepEqual(result.applied, ["postgres-v1.1.0.sql"]);
    assert.match(result.backupSchema, /^cashflow_premigration_/);
    assert.deepEqual(await backupSchemaNames(pool), [result.backupSchema]);
    assert.deepEqual(await schemaTableCounts(pool, result.backupSchema), beforeCounts);
    const backupRecord = (await pool.query("SELECT table_count, row_counts FROM cashflow_schema_backups WHERE schema_name = $1", [result.backupSchema])).rows[0];
    assert.equal(backupRecord.table_count, Object.keys(beforeCounts).length);
    assert.deepEqual(backupRecord.row_counts, beforeCounts);
    assert.equal((await pool.query("SELECT version FROM cashflow_global_schema_version WHERE id = 1")).rows[0].version, 6);
    assert.deepEqual(
      (await pool.query("SELECT name FROM cashflow_schema_migrations ORDER BY name")).rows.map(row => row.name),
      ["postgres-v1.0.1.sql", "postgres-v1.1.0.sql"]
    );
  });
});

test("a current Postgres schema does not create a migration backup", gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try {
      await global.initialize();
      await budget.initialize();
    } finally {
      await Promise.all([global.close(), budget.close()]);
    }
    const result = await runPostgresMigrations({ databaseUrl, migrationsDir });
    assert.equal(result.current, true);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(await backupSchemaNames(pool), []);
    assert.equal((await pool.query("SELECT to_regclass('cashflow_schema_backups') AS relation")).rows[0].relation, null);
  });
});

test("a failed Postgres migration backup prevents migration and explains update-needed recovery", gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await preparePreviousSchema(databaseUrl, pool);
    let failure;
    try {
      await runPostgresMigrations({
        databaseUrl,
        migrationsDir,
        createMigrationBackup: async () => { throw new Error("injected CREATE privilege failure"); }
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.equal(failure.databaseMigrationBackupFailed, true);
    assert.deepEqual(failure.pendingMigrations, ["postgres-v1.1.0.sql"]);
    const state = { required: true, error: failure, pending: failure.pendingMigrations };
    let status;
    let body;
    const response = {
      status(value) { status = value; return this; },
      type() { return this; },
      send(value) { body = value; }
    };
    await createDatabaseUpdateMiddleware({ state })({ path: "/", headers: {} }, response, () => {});
    assert.equal(status, 503);
    assert.match(body, /automatic pre-migration backup failed/i);
    assert.match(body, /CASHFLOW_DB_MIGRATION_BACKUP=false npm run db:migrate/);
    assert.equal((await pool.query("SELECT version FROM cashflow_global_schema_version WHERE id = 1")).rows[0].version, 5);
    assert.deepEqual(await backupSchemaNames(pool), []);
  });
});

test("Postgres migration backup retention keeps the newest configured count", gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await preparePreviousSchema(databaseUrl, pool);
    const client = await pool.connect();
    try {
      const state = { globalVersion: 5, planningVersion: 6, ledgerVersion: 6 };
      await createPostgresMigrationBackup({ client, state, now: new Date("2026-10-12T00:00:00.000Z") });
      await createPostgresMigrationBackup({ client, state, now: new Date("2026-10-13T00:00:00.000Z") });
    } finally {
      client.release();
    }
    const result = await runPostgresMigrations({
      databaseUrl, migrationsDir,
      env: { CASHFLOW_DB_MIGRATION_BACKUP_KEEP: "2" }
    });
    const names = await backupSchemaNames(pool);
    assert.equal(names.length, 2);
    assert.equal(names.includes("cashflow_premigration_g5_p6_l6_20261012t000000000z"), false);
    assert.equal(names.includes(result.backupSchema), true);
    assert.equal((await pool.query("SELECT count(*) FROM cashflow_schema_backups")).rows[0].count, "2");
  });
});

test("CASHFLOW_DB_MIGRATION_BACKUP=false skips the Postgres backup", gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await preparePreviousSchema(databaseUrl, pool);
    const result = await runPostgresMigrations({
      databaseUrl, migrationsDir,
      env: { CASHFLOW_DB_MIGRATION_BACKUP: "false" }
    });
    assert.equal(result.current, true);
    assert.equal(result.backupSchema, null);
    assert.deepEqual(await backupSchemaNames(pool), []);
    assert.equal((await pool.query("SELECT to_regclass('cashflow_schema_backups') AS relation")).rows[0].relation, null);
  });
});

test("concurrent Postgres migration runners apply each migration once", gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await preparePreviousSchema(databaseUrl, pool);
    const events = [];
    const results = await Promise.all(["one", "two"].map(() => runPostgresMigrations({
      databaseUrl,
      migrationsDir,
      logServerEvent: (kind, details) => events.push({ kind, details })
    })));
    assert.equal(results.every(result => result.current), true);
    assert.equal(events.filter(event => event.kind === "cashflow_postgres_migration_applied" && event.details.migration === "postgres-v1.1.0.sql").length, 1);
    assert.equal((await pool.query("SELECT count(*) FROM cashflow_schema_migrations WHERE name = 'postgres-v1.1.0.sql'")).rows[0].count, "1");
  });
});

test("failed migration serves update mode and clears after an operator fixes the schema", gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await preparePreviousSchema(databaseUrl, pool);
    const temp = await mkdtemp(path.join(tmpdir(), "cashflow-failing-migration-"));
    const realSql = fs.readFileSync(path.join(migrationsDir, "postgres-v1.1.0.sql"), "utf8");
    fs.writeFileSync(path.join(temp, "postgres-v1.1.0.sql"), `BEGIN; SELECT cashflow_deliberate_failure(); COMMIT;\n${realSql}`);
    let failure;
    try {
      await runPostgresMigrations({ databaseUrl, migrationsDir: temp });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    const state = { required: true, error: failure, pending: failure.pendingMigrations };
    const app = express();
    app.get("/healthz", (req, res) => res.json({ ok: true, app: "cashflow" }));
    app.use(createDatabaseUpdateMiddleware({
      state,
      recheck: async () => {
        const result = await runPostgresMigrations({ databaseUrl, migrationsDir, autoMigrate: false });
        if (!result.current) return false;
        state.required = false;
        return true;
      }
    }));
    app.use((req, res) => res.send("normal app"));
    const server = await new Promise(resolve => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const page = await fetch(`${base}/beta/settings`);
      assert.equal(page.status, 503);
      assert.match(await page.text(), /Database update needed/);
      const api = await fetch(`${base}/api`);
      assert.equal(api.status, 503);
      assert.equal((await api.json()).code, "CASHFLOW_DATABASE_UPDATE_REQUIRED");
      assert.equal((await fetch(`${base}/healthz`)).status, 200);

      await runPostgresMigrations({ databaseUrl, migrationsDir });
      const recovered = await fetch(`${base}/`);
      assert.equal(recovered.status, 200);
      assert.equal(await recovered.text(), "normal app");
    } finally {
      await new Promise(resolve => server.close(resolve));
      await rm(temp, { recursive: true, force: true });
    }
  });
});
