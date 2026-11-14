import assert from "node:assert/strict";
import crypto from "node:crypto";
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
import { createDeviceStore } from '../../src/server/cashflow-device-store.js';
import { createStandaloneTransferJournal } from '../../src/server/cashflow-standalone-transfer-journal.js';
import { GLOBAL_SCHEMA_VERSION } from '../../src/server/cashflow-global-schema.js';
import { PLANNING_SCHEMA_VERSION } from '../../src/server/cashflow-schema.js';
import { STANDALONE_TRANSFER_TABLE_COLUMNS } from '../../src/server/cashflow-standalone-transfer-schema.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

const gated = { skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests" };
const repoRoot = path.resolve(import.meta.dirname, "../..");
const migrationsDir = path.join(repoRoot, "scripts", "migrations");

test('planning version 21 gains origin storage atomically without changing prior financial state', gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try { await global.initialize(); await budget.initialize(); }
    finally { await global.close(); await budget.close(); }
    await pool.query('DROP TABLE cashflow_ledger_origins');
    await pool.query('ALTER TABLE cashflow_ledger_audit_state DROP COLUMN origin_version');
    await pool.query('UPDATE cashflow_budget_schema_version SET planning_version = 21 WHERE id = 1');
    await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ('origin-migration','origin-migration','Synthetic',now(),now())");
    await pool.query("INSERT INTO one_off_transactions (budget_id,id,name,currency,amount,type,date,created_at,updated_at) VALUES ('origin-migration','kept','Retained','PLN',10,'expense','2026-06-10',now(),now())");
    await pool.query("INSERT INTO cashflow_ledger_audit_state (budget_id,last_sequence,baseline_complete) VALUES ('origin-migration',0,1)");
    const prior = (await pool.query("SELECT * FROM cashflow_ledger_audit_state WHERE budget_id='origin-migration'")).rows[0];
    const pending = await runPostgresMigrations({ databaseUrl, migrationsDir, autoMigrate: false });
    assert.deepEqual(pending.pending, ["postgres-v1.2.0.sql"]);
    const sql = fs.readFileSync(path.join(migrationsDir, 'postgres-v1.2.0.sql'), 'utf8');
    const client = await pool.connect();
    try {
      await assert.rejects(client.query(sql.replace('COMMIT;', 'SELECT 1/0; COMMIT;')), /division by zero/);
      await client.query('ROLLBACK');
      assert.equal((await client.query('SELECT planning_version FROM cashflow_budget_schema_version WHERE id=1')).rows[0].planning_version, 21);
      assert.equal((await client.query("SELECT to_regclass('cashflow_ledger_origins') AS relation")).rows[0].relation, null);
      assert.deepEqual((await client.query("SELECT * FROM cashflow_ledger_audit_state WHERE budget_id='origin-migration'")).rows[0], prior);
      await client.query('UPDATE cashflow_budget_schema_version SET planning_version=20 WHERE id=1');
      await assert.rejects(client.query(sql), /requires global schema 7 or 8 and planning schema 21 or 22/);
      await client.query('ROLLBACK');
      await client.query('UPDATE cashflow_budget_schema_version SET planning_version=21 WHERE id=1');
    } finally { client.release(); }
    const migrated = await runPostgresMigrations({ databaseUrl, migrationsDir });
    assert.deepEqual(migrated.applied, ["postgres-v1.2.0.sql"]);
    assert.equal((await pool.query('SELECT planning_version FROM cashflow_budget_schema_version WHERE id=1')).rows[0].planning_version, PLANNING_SCHEMA_VERSION);
    assert.deepEqual((await pool.query("SELECT * FROM cashflow_ledger_audit_state WHERE budget_id='origin-migration'")).rows[0], { ...prior, origin_version: 0 });
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM cashflow_ledger_origins')).rows[0].n, 0);
    assert.equal((await pool.query("SELECT amount FROM one_off_transactions WHERE id='kept' AND budget_id='origin-migration'")).rows[0].amount, 10);
    await assert.rejects(pool.query("INSERT INTO cashflow_ledger_origins VALUES ('missing','{}','synthetic')"), /foreign key/);
    assert.deepEqual((await runPostgresMigrations({ databaseUrl, migrationsDir })).applied, []);
  });
});

test('global version 7 gains transfer metadata only after an atomic migration, with late DDL rollback', gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try { await global.initialize(); await budget.initialize(); }
    finally { await global.close(); await budget.close(); }
    await pool.query('DROP TABLE cashflow_standalone_transfers');
    await pool.query('UPDATE cashflow_global_schema_version SET version = 7 WHERE id = 1');
    await pool.query("INSERT INTO accounts (id, display_name, created_at, updated_at) VALUES ('kept', 'Retained account', now(), now())");
    const pending = await runPostgresMigrations({ databaseUrl, migrationsDir, autoMigrate: false });
    assert.deepEqual(pending.pending, ["postgres-v1.2.0.sql"]);
    // Event triggers need a superuser (the owned disposable container is one; a
    // contributor's own test database may not be): fail after the actual CREATE
    // TABLE, so this verifies rollback rather than just a pre-migration guard.
    const { rows: [{ rolsuper: superuser }] } = await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if (superuser) {
      await pool.query(`CREATE FUNCTION cashflow_test_transfer_ddl_failure() RETURNS event_trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands()
            WHERE command_tag = 'CREATE TABLE' AND object_identity = 'public.cashflow_standalone_transfers') THEN
            RAISE EXCEPTION 'injected transfer schema failure';
          END IF;
        END;
      $$;
      CREATE EVENT TRIGGER cashflow_test_transfer_ddl_failure ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
        EXECUTE FUNCTION cashflow_test_transfer_ddl_failure()`);
      try { await assert.rejects(() => runPostgresMigrations({ databaseUrl, migrationsDir }), /injected transfer schema failure/); }
      finally {
        await pool.query('DROP EVENT TRIGGER cashflow_test_transfer_ddl_failure');
        await pool.query('DROP FUNCTION cashflow_test_transfer_ddl_failure()');
      }
      assert.equal((await pool.query('SELECT version FROM cashflow_global_schema_version WHERE id = 1')).rows[0].version, 7);
      assert.equal((await pool.query("SELECT to_regclass('public.cashflow_standalone_transfers') AS relation")).rows[0].relation, null);
      assert.equal((await pool.query("SELECT display_name FROM accounts WHERE id = 'kept'")).rows[0].display_name, 'Retained account');
    }
    const migrated = await runPostgresMigrations({ databaseUrl, migrationsDir });
    assert.deepEqual(migrated.applied, ["postgres-v1.2.0.sql"]);
    assert.equal((await pool.query('SELECT version FROM cashflow_global_schema_version WHERE id = 1')).rows[0].version, GLOBAL_SCHEMA_VERSION);
    const columns = (await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cashflow_standalone_transfers' ORDER BY ordinal_position`)).rows.map(row => row.column_name);
    assert.deepEqual(columns, STANDALONE_TRANSFER_TABLE_COLUMNS.cashflow_standalone_transfers);
  });
});

async function preparePreviousSchema(databaseUrl, pool) {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try {
    await global.initialize();
    await budget.initialize();
    await pool.query('DROP TABLE cashflow_standalone_transfers');
    await pool.query("ALTER TABLE accounts DROP COLUMN avatar");
    await pool.query("ALTER TABLE global_options DROP COLUMN ntfy_allowed_private_hosts");
    await pool.query("ALTER TABLE global_options DROP COLUMN device_access_minutes, DROP COLUMN device_renewal_idle_days, DROP COLUMN device_absolute_days");
    await pool.query("UPDATE cashflow_global_schema_version SET version = 5 WHERE id = 1");
    await pool.query("DROP TABLE cashflow_sync_operations, cashflow_sync_heads");
    await pool.query("ALTER TABLE recurring_expenses DROP COLUMN end_month_year; ALTER TABLE recurring_incomes DROP COLUMN end_month_year");
    await pool.query("UPDATE cashflow_budget_schema_version SET planning_version = 20 WHERE id = 1");
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
    assert.deepEqual(manual.pending, ["postgres-v1.1.0.sql", "postgres-v1.1.0-r2.sql", "postgres-v1.1.5.sql", "postgres-v1.2.0.sql"]);
    assert.equal((await pool.query("SELECT version FROM cashflow_global_schema_version WHERE id = 1")).rows[0].version, 5);
    const result = await runPostgresMigrations({ databaseUrl, migrationsDir });
    assert.equal(result.current, true);
    assert.deepEqual(result.applied, ["postgres-v1.1.0.sql", "postgres-v1.1.0-r2.sql", "postgres-v1.1.5.sql", "postgres-v1.2.0.sql"]);
    assert.match(result.backupSchema, /^cashflow_premigration_/);
    assert.deepEqual(await backupSchemaNames(pool), [result.backupSchema]);
    assert.deepEqual(await schemaTableCounts(pool, result.backupSchema), beforeCounts);
    const backupRecord = (await pool.query("SELECT table_count, row_counts FROM cashflow_schema_backups WHERE schema_name = $1", [result.backupSchema])).rows[0];
    assert.equal(backupRecord.table_count, Object.keys(beforeCounts).length);
    assert.deepEqual(backupRecord.row_counts, beforeCounts);
    assert.equal((await pool.query("SELECT version FROM cashflow_global_schema_version WHERE id = 1")).rows[0].version, GLOBAL_SCHEMA_VERSION);
    assert.deepEqual((await pool.query(`SELECT device_access_minutes, device_renewal_idle_days,
      device_absolute_days FROM global_options WHERE id = 1`)).rows[0], {
      device_access_minutes: 15, device_renewal_idle_days: 90, device_absolute_days: 365
    });
    assert.deepEqual(
      (await pool.query("SELECT name FROM cashflow_schema_migrations ORDER BY name")).rows.map(row => row.name),
      ["postgres-v1.0.1.sql", "postgres-v1.1.0-r2.sql", "postgres-v1.1.0.sql", "postgres-v1.1.5.sql", "postgres-v1.2.0.sql"]
    );
  });
});

test("a version 6 Postgres schema with v1.1.0 recorded applies additive revisions", gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try {
      await global.initialize();
      await budget.initialize();
    } finally {
      await Promise.all([global.close(), budget.close()]);
    }
    await pool.query("ALTER TABLE global_options DROP COLUMN ntfy_allowed_private_hosts");
    await pool.query("UPDATE cashflow_global_schema_version SET version = 6 WHERE id = 1");
    await pool.query("ALTER TABLE global_options DROP COLUMN device_access_minutes, DROP COLUMN device_renewal_idle_days, DROP COLUMN device_absolute_days");
    await pool.query(`CREATE TABLE cashflow_schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const v110 = fs.readFileSync(path.join(migrationsDir, "postgres-v1.1.0.sql"));
    const checksum = crypto.createHash("sha256").update(v110).digest("hex");
    await pool.query("INSERT INTO cashflow_schema_migrations (name, checksum) VALUES ($1, $2)", [
      "postgres-v1.1.0.sql", checksum
    ]);

    const result = await runPostgresMigrations({ databaseUrl, migrationsDir });
    assert.deepEqual(result.applied, ["postgres-v1.1.0-r2.sql", "postgres-v1.2.0.sql"]);
    assert.equal((await pool.query("SELECT version FROM cashflow_global_schema_version WHERE id = 1")).rows[0].version, GLOBAL_SCHEMA_VERSION);
    assert.equal((await pool.query(`SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'global_options'
        AND column_name = 'ntfy_allowed_private_hosts'`)).rows[0].data_type, "jsonb");
  });
});

async function prepareMainSchema(databaseUrl, pool) {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try { await global.initialize(); await budget.initialize(); }
  finally { await global.close(); await budget.close(); }
  // Strip the unreleased additions, then actually apply all four production scripts.
  await pool.query(`DROP TABLE app_device_tokens, app_devices, app_device_pairings, app_device_instance,
    cashflow_sync_operations, cashflow_sync_heads, cashflow_ledger_origins, cashflow_ledger_corrections,
    cashflow_ledger_originals, cashflow_ledger_audit_state, cashflow_ledger_summary_cache, cashflow_standalone_transfers;
    ALTER TABLE global_options DROP COLUMN device_access_minutes, DROP COLUMN device_renewal_idle_days,
      DROP COLUMN device_absolute_days, DROP COLUMN ntfy_allowed_private_hosts;
    ALTER TABLE accounts DROP COLUMN avatar;
    ALTER TABLE budgets DROP COLUMN revision;
    ALTER TABLE settings DROP COLUMN notification_channels;
    ALTER TABLE notification_queue DROP COLUMN sent_channels;
    ALTER TABLE recurring_expenses DROP COLUMN end_month_year;
    ALTER TABLE recurring_incomes DROP COLUMN end_month_year;
    UPDATE cashflow_global_schema_version SET version = 5 WHERE id = 1;
    UPDATE cashflow_budget_schema_version SET planning_version = 20 WHERE id = 1;
    CREATE TABLE cashflow_schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  for (const name of ['postgres-v1.0.1.sql', 'postgres-v1.1.0.sql', 'postgres-v1.1.0-r2.sql', 'postgres-v1.1.5.sql']) {
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    await pool.query(sql);
    await pool.query('INSERT INTO cashflow_schema_migrations (name, checksum) VALUES ($1, $2)',
      [name, crypto.createHash('sha256').update(sql).digest('hex')]);
  }
}

test('production global 7 / planning 21 applies only v1.2.0 and keeps financial data and end months', gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await prepareMainSchema(databaseUrl, pool);
    assert.equal((await pool.query('SELECT version FROM cashflow_global_schema_version WHERE id=1')).rows[0].version, 7);
    assert.equal((await pool.query('SELECT planning_version FROM cashflow_budget_schema_version WHERE id=1')).rows[0].planning_version, 21);
    await pool.query(`INSERT INTO accounts (id,display_name,created_at,updated_at) VALUES ('main-owner','Main owner',now(),now());
      INSERT INTO budgets (id,storage_key,display_name,created_by_account_id,created_at,updated_at)
        VALUES ('main-budget','main-owner','Main budget','main-owner',now(),now());
      INSERT INTO budget_memberships (budget_id,account_id,role,created_at,updated_at)
        VALUES ('main-budget','main-owner','owner',now(),now());
      INSERT INTO recurring_incomes (budget_id,id,name,currency,amount,prediction_strategy,repeat_every_months,
        start_month_year,end_month_year,anchor_type,anchor_day_of_month,created_at,updated_at)
        VALUES ('main-budget','salary','Salary','PLN',1000,'fixed',1,'2025-01','2027-12','day_of_month',1,now(),now());
      INSERT INTO confirmed_transactions (budget_id,id,name,currency,amount,type,date,confirmed_date,ledger_currency,
        running_balance_pln,ledger_amount,ledger_year,created_at,updated_at)
        VALUES ('main-budget','kept','Kept','PLN',50,'income','2018-01-01','2018-01-01','PLN',50,50,2018,now(),now())`);
    const original = (await pool.query('SELECT * FROM confirmed_transactions')).rows;
    const income = (await pool.query('SELECT * FROM recurring_incomes')).rows;
    assert.deepEqual((await runPostgresMigrations({ databaseUrl, migrationsDir, autoMigrate: false })).pending, ['postgres-v1.2.0.sql']);
    const migrated = await runPostgresMigrations({ databaseUrl, migrationsDir });
    assert.deepEqual(migrated.applied, ['postgres-v1.2.0.sql']);
    assert.equal(migrated.current, true);
    assert.deepEqual(migrated.schema, { globalVersion: 8, planningVersion: 22, ledgerVersion: 5 });
    assert.deepEqual((await pool.query('SELECT * FROM confirmed_transactions')).rows, original);
    assert.deepEqual((await pool.query('SELECT * FROM recurring_incomes')).rows, income);
    assert.equal((await pool.query("SELECT revision FROM budgets WHERE id='main-budget'")).rows[0].revision, 1);
    for (const table of ['cashflow_ledger_originals', 'cashflow_ledger_corrections', 'cashflow_ledger_origins']) {
      assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n, 0);
    }
    const recorded = (await pool.query('SELECT name, checksum FROM cashflow_schema_migrations ORDER BY name')).rows;
    assert.ok(recorded.some(row => row.name === 'postgres-v1.2.0.sql'));
    const repeated = await runPostgresMigrations({ databaseUrl, migrationsDir });
    assert.deepEqual(repeated.applied, []);
    assert.equal(repeated.backupSchema, undefined);
    assert.deepEqual((await pool.query('SELECT name, checksum FROM cashflow_schema_migrations ORDER BY name')).rows, recorded);
    // Direct SQL is idempotent as well as the runner's recorded-history path.
    await pool.query(fs.readFileSync(path.join(migrationsDir, 'postgres-v1.2.0.sql'), 'utf8'));
    assert.deepEqual((await pool.query('SELECT * FROM confirmed_transactions')).rows, original);
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
    assert.deepEqual(result.schema, { globalVersion: 8, planningVersion: 22, ledgerVersion: 5 });
    assert.deepEqual(result.reconciled.map(row => row.name), [
      'postgres-v1.0.1.sql', 'postgres-v1.1.0.sql', 'postgres-v1.1.0-r2.sql', 'postgres-v1.1.5.sql', 'postgres-v1.2.0.sql'
    ]);
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
    assert.deepEqual(failure.pendingMigrations, ["postgres-v1.1.0.sql", "postgres-v1.1.0-r2.sql", "postgres-v1.1.5.sql", "postgres-v1.2.0.sql"]);
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
    assert.equal(events.filter(event => event.kind === "cashflow_postgres_migration_applied" && event.details.migration === "postgres-v1.1.0-r2.sql").length, 1);
    assert.equal((await pool.query("SELECT count(*) FROM cashflow_schema_migrations WHERE name = 'postgres-v1.1.0.sql'")).rows[0].count, "1");
    assert.equal((await pool.query("SELECT count(*) FROM cashflow_schema_migrations WHERE name = 'postgres-v1.1.0-r2.sql'")).rows[0].count, "1");
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
      const page = await fetch(`${base}/settings`);
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

// Verify the exact additive audit migration on an actual previous schema,
// including transaction rollback, unchanged ledger facts and safe retry.
test("planning 21 gains empty audit storage atomically and refuses out-of-order migration", gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try {
      await global.initialize();
      await budget.initialize();
      await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ('audit-migration','audit-migration','Synthetic',now(),now())");
      await budget.insertConfirmedTransactions('audit-migration', [{ id: 'kept-payment', name: 'Retained', amount: 50,
        currency: 'PLN', type: 'income', date: '2018-01-01', confirmed_date: '2018-01-01', ledger_year: 2018,
        ledger_currency: 'PLN', fx_rate: 1, buffered_fx_rate: 1, ledger_amount: 50, running_balance_pln: 50,
        occurrence_key: 'manual:kept-payment', created_at: '2018-01-01T00:00:00Z', updated_at: '2018-01-01T00:00:00Z' }]);
      const original = await budget.listConfirmedTransactions('audit-migration');
      await pool.query('DROP TABLE cashflow_ledger_origins, cashflow_ledger_corrections, cashflow_ledger_originals, cashflow_ledger_audit_state');
      await pool.query('UPDATE cashflow_budget_schema_version SET planning_version=21 WHERE id=1');
      const sql = fs.readFileSync(path.join(migrationsDir, 'postgres-v1.2.0.sql'), 'utf8');
      const client = await pool.connect();
      try {
        await assert.rejects(client.query(sql.replace('COMMIT;', 'SELECT 1/0; COMMIT;')), /division by zero/);
        await client.query('ROLLBACK');
        assert.equal((await client.query('SELECT planning_version FROM cashflow_budget_schema_version WHERE id=1')).rows[0].planning_version, 21);
        assert.equal((await client.query("SELECT to_regclass('cashflow_ledger_audit_state') AS name")).rows[0].name, null);
        assert.deepEqual(await budget.listConfirmedTransactions('audit-migration'), original);
        await client.query('UPDATE cashflow_budget_schema_version SET planning_version=20 WHERE id=1');
        await assert.rejects(client.query(sql), /requires global schema 7 or 8 and planning schema 21 or 22/);
        await client.query('ROLLBACK');
        await client.query('UPDATE cashflow_budget_schema_version SET planning_version=21 WHERE id=1');
      } finally { client.release(); }
      const result = await runPostgresMigrations({ databaseUrl, migrationsDir });
      assert.deepEqual(result.applied, ["postgres-v1.2.0.sql"]);
      assert.equal(result.current, true);
      for (const table of ['cashflow_ledger_audit_state', 'cashflow_ledger_originals', 'cashflow_ledger_corrections']) {
        assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n, 0);
      }
      assert.deepEqual(await budget.listConfirmedTransactions('audit-migration'), original);
      const repeated = await runPostgresMigrations({ databaseUrl, migrationsDir });
      assert.deepEqual(repeated.applied, []);
    } finally { await Promise.all([budget.close(), global.close()]); }
  });
});

// Exercise the combined migration on populated transfer storage, including detection of a
// pre-existing current schema and rollback after the new constraints are added.
test('global version 7 preserves transfer receipts and applies cancellation constraints atomically', gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try {
      await global.initialize(); await budget.initialize();
      const store = createDeviceStore(global);
      // Transfer rows reference their owning account.
      await pool.query("INSERT INTO accounts (id, display_name, created_at, updated_at) VALUES ('synthetic-migration-owner', 'Migration owner', now(), now())");
      const binding = { instanceId: crypto.randomUUID(), accountId: 'synthetic-migration-owner', deviceId: 'synthetic-device' };
      const input = () => ({ version: 1, ...binding, transferId: crypto.randomUUID(), name: 'Migration fixture', sourceJson: '{}' });
      const run = work => store.transaction(tx => work(createStandaloneTransferJournal({ ...tx,
        authorize: async () => binding, prepare: async () => {} })));
      await run(j => j.reserve(input()));
      const acceptedInput = input();
      await run(j => j.reserve(acceptedInput));
      const accepted = await run(j => j.publish(acceptedInput));
      await pool.query(`ALTER TABLE cashflow_standalone_transfers DROP CONSTRAINT cashflow_standalone_transfers_state_check;
        ALTER TABLE cashflow_standalone_transfers DROP CONSTRAINT cashflow_standalone_transfers_check;
        ALTER TABLE cashflow_standalone_transfers ADD CONSTRAINT cashflow_standalone_transfers_state_check CHECK (state IN ('reserved', 'accepted'));
        ALTER TABLE cashflow_standalone_transfers ADD CONSTRAINT cashflow_standalone_transfers_check CHECK ((state = 'reserved' AND receipt_json IS NULL) OR (state = 'accepted' AND receipt_json IS NOT NULL));
        UPDATE cashflow_global_schema_version SET version = 7 WHERE id = 1`);
      const prior = (await pool.query('SELECT * FROM cashflow_standalone_transfers ORDER BY transfer_id')).rows;
      assert.deepEqual((await runPostgresMigrations({ databaseUrl, migrationsDir, autoMigrate: false })).pending, ["postgres-v1.2.0.sql"]);
      const sql = fs.readFileSync(path.join(migrationsDir, 'postgres-v1.2.0.sql'), 'utf8');
      const client = await pool.connect();
      try {
        await assert.rejects(client.query(sql.replace('COMMIT;', 'SELECT 1/0; COMMIT;')), /division by zero/);
        await client.query('ROLLBACK');
        assert.equal((await client.query('SELECT version FROM cashflow_global_schema_version WHERE id = 1')).rows[0].version, 7);
        assert.deepEqual((await client.query('SELECT * FROM cashflow_standalone_transfers ORDER BY transfer_id')).rows, prior);
        const constraints = (await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'cashflow_standalone_transfers'::regclass")).rows;
        assert.ok(constraints.every(row => !row.definition.includes('cancelled')));
        await client.query('UPDATE cashflow_global_schema_version SET version = 6 WHERE id = 1');
        await assert.rejects(client.query(sql), /requires global schema 7 or 8 and planning schema 21 or 22/);
        await client.query('ROLLBACK');
        await client.query('UPDATE cashflow_global_schema_version SET version = 7 WHERE id = 1');
      } finally { client.release(); }
      const result = await runPostgresMigrations({ databaseUrl, migrationsDir });
      assert.equal(result.current, true);
      assert.deepEqual(result.applied, ["postgres-v1.2.0.sql"]);
      assert.deepEqual((await pool.query('SELECT * FROM cashflow_standalone_transfers ORDER BY transfer_id')).rows, prior);
      assert.deepEqual(await run(j => j.cancel(acceptedInput)), accepted);
      assert.equal((await run(j => j.cancel(input()))).state, 'cancelled');
      assert.deepEqual((await runPostgresMigrations({ databaseUrl, migrationsDir })).applied, []);
      // Remove only the runner's record to exercise constraint-based detection.
      await pool.query("DELETE FROM cashflow_schema_migrations WHERE name = 'postgres-v1.2.0.sql'");
      const detected = await runPostgresMigrations({ databaseUrl, migrationsDir, autoMigrate: false });
      assert.equal(detected.current, true);
      assert.deepEqual(detected.pending, []);
      assert.ok(detected.reconciled.some(row => row.name === 'postgres-v1.2.0.sql'));
    } finally { await global.close(); await budget.close(); }
  });
});

test('global version 7 upgrade keeps existing accounts, roles, owners and financial rows', gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try { await global.initialize(); await budget.initialize(); }
    finally { await global.close(); await budget.close(); }
    await pool.query(`INSERT INTO accounts (id, display_name, created_at, updated_at)
      VALUES ('first', 'First account', now(), now()), ('alice', 'Alice', now(), now()), ('bob', 'Bob', now(), now());
      INSERT INTO account_global_roles (account_id, role, created_at) VALUES ('first', 'system_admin', now());
      INSERT INTO budgets (id, storage_key, display_name, created_by_account_id, created_at, updated_at)
      VALUES ('shared', 'alice', 'Shared', 'first', now(), now()),
        ('other-key', 'unknown', 'Other key', 'first', now(), now()),
        ('real-owner', 'other', 'Real owner', 'bob', now(), now());
      INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at)
      VALUES ('shared', 'first', 'owner', now(), now()), ('shared', 'alice', 'viewer', now(), now()),
        ('other-key', 'first', 'owner', now(), now()), ('real-owner', 'bob', 'owner', now(), now()),
        ('real-owner', 'first', 'viewer', now(), now());
      UPDATE cashflow_global_schema_version SET version = 7 WHERE id = 1`);
    await pool.query("INSERT INTO one_off_transactions (budget_id,id,name,currency,amount,type,date,created_at,updated_at) VALUES ('other-key','kept','Retained','PLN',10,'expense','2026-06-10',now(),now())");
    // Store initialization creates domain tables, but only the migration runner
    // creates its history table. Seed a real prior record for rollback checks.
    await pool.query(`CREATE TABLE cashflow_schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const previousName = 'postgres-v1.1.5.sql';
    const previousChecksum = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(migrationsDir, previousName))).digest('hex');
    await pool.query('INSERT INTO cashflow_schema_migrations (name, checksum) VALUES ($1, $2)',
      [previousName, previousChecksum]);
    const snapshot = async () => {
      const state = {};
      for (const table of ['accounts', 'account_global_roles', 'budgets', 'budget_memberships', 'one_off_transactions']) {
        state[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
      }
      return state;
    };
    const prior = await snapshot();
    const sql = fs.readFileSync(path.join(migrationsDir, 'postgres-v1.2.0.sql'), 'utf8');
    const client = await pool.connect();
    try {
      await assert.rejects(client.query(sql.replace('COMMIT;', 'SELECT 1/0; COMMIT;')), /division by zero/);
      await client.query('ROLLBACK');
      assert.equal((await client.query('SELECT version FROM cashflow_global_schema_version WHERE id = 1')).rows[0].version, 7);
    } finally { client.release(); }
    const result = await runPostgresMigrations({ databaseUrl, migrationsDir });
    assert.deepEqual(result.applied, ["postgres-v1.2.0.sql"]);
    assert.equal(result.current, true);
    assert.deepEqual(await snapshot(), prior);
    await assert.rejects(pool.query("DELETE FROM budget_memberships WHERE budget_id = 'shared'"), /last_budget_owner/);
    assert.deepEqual((await runPostgresMigrations({ databaseUrl, migrationsDir })).applied, []);
  });
});

test('global version 7 gains budget revision column atomically with default 1 and rollback', gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try { await global.initialize(); await budget.initialize(); }
    finally { await global.close(); await budget.close(); }

    await pool.query('ALTER TABLE budgets DROP COLUMN revision');
    await pool.query('UPDATE cashflow_global_schema_version SET version = 7 WHERE id = 1');
    await pool.query("INSERT INTO accounts (id, display_name, created_at, updated_at) VALUES ('rev-owner', 'Rev owner', now(), now())");
    await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_by_account_id, created_at, updated_at) VALUES ('rev-budget', 'rev-owner', 'Rev Budget', 'rev-owner', now(), now())");

    const pending = await runPostgresMigrations({ databaseUrl, migrationsDir, autoMigrate: false });
    assert.deepEqual(pending.pending, ["postgres-v1.2.0.sql"]);

    const sql = fs.readFileSync(path.join(migrationsDir, 'postgres-v1.2.0.sql'), 'utf8');
    const client = await pool.connect();
    try {
      await assert.rejects(client.query(sql.replace('COMMIT;', 'SELECT 1/0; COMMIT;')), /division by zero/);
      await client.query('ROLLBACK');
      assert.equal((await client.query('SELECT version FROM cashflow_global_schema_version WHERE id = 1')).rows[0].version, 7);
      const cols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'budgets' AND column_name = 'revision'");
      assert.equal(cols.rowCount, 0);

      await client.query('UPDATE cashflow_global_schema_version SET version = 6 WHERE id = 1');
      await assert.rejects(client.query(sql), /requires global schema 7 or 8 and planning schema 21 or 22/);
      await client.query('ROLLBACK');
      await client.query('UPDATE cashflow_global_schema_version SET version = 7 WHERE id = 1');
    } finally { client.release(); }

    const migrated = await runPostgresMigrations({ databaseUrl, migrationsDir });
    assert.deepEqual(migrated.applied, ["postgres-v1.2.0.sql"]);
    assert.equal((await pool.query('SELECT version FROM cashflow_global_schema_version WHERE id = 1')).rows[0].version, GLOBAL_SCHEMA_VERSION);
    const row = (await pool.query("SELECT id, display_name, revision FROM budgets WHERE id = 'rev-budget'")).rows[0];
    assert.equal(row.display_name, 'Rev Budget');
    assert.equal(row.revision, 1);
    assert.deepEqual((await runPostgresMigrations({ databaseUrl, migrationsDir })).applied, []);
  });
});

test('v1.2.0 migration adds backup policy columns and preserves existing global options', gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try { await global.initialize(); await budget.initialize(); }
    finally { await global.close(); await budget.close(); }
    await pool.query("UPDATE global_options SET locale = 'pl', fx_buffer_percent = 2.5");
    await pool.query('ALTER TABLE global_options DROP COLUMN backup_max_retention_count, DROP COLUMN backup_max_age_days');
    const pending = await runPostgresMigrations({ databaseUrl, migrationsDir, autoMigrate: false });
    assert.deepEqual(pending.pending, ['postgres-v1.2.0.sql']);
    const migrated = await runPostgresMigrations({ databaseUrl, migrationsDir });
    assert.deepEqual(migrated.applied, ['postgres-v1.2.0.sql']);
    assert.deepEqual((await pool.query('SELECT backup_max_retention_count, backup_max_age_days, locale, fx_buffer_percent FROM global_options')).rows[0],
      { backup_max_retention_count: 0, backup_max_age_days: 0, locale: 'pl', fx_buffer_percent: 2.5 });
    await assert.rejects(pool.query('UPDATE global_options SET backup_max_retention_count = -1'), /check constraint/);
    assert.deepEqual((await runPostgresMigrations({ databaseUrl, migrationsDir })).applied, []);
  });
});
