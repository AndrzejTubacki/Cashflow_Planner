import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  classifyPostgresMigrations,
  loadPostgresMigrationScripts,
  runPostgresMigrations,
  orderPostgresMigrationNames,
  parsePostgresMigrationBackupSettings,
  postgresMigrationBackupSchemaName,
  selectPostgresMigrationBackupSchemasForRetention
} from "../../src/server/cashflow-postgres-migrations.js";
import {
  databaseUpdateNoticeHtml,
  databaseUpdateReadinessResponse,
  redactDatabaseError,
  resolveDatabaseUpdateReadiness
} from "../../src/server/cashflow-database-update-mode.js";

test("Postgres migration files are ordered by semantic version and numeric revision", () => {
  assert.deepEqual(orderPostgresMigrationNames([
    "postgres-v1.2.0.sql", "postgres-v1.1.5.sql", "postgres-v1.1.0-r2.sql",
    "postgres-v1.0.1.sql", "postgres-v1.1.0.sql"
  ]), [
    "postgres-v1.0.1.sql", "postgres-v1.1.0.sql", "postgres-v1.1.0-r2.sql",
    "postgres-v1.1.5.sql", "postgres-v1.2.0.sql"
  ]);
});

test("Postgres migration ordering rejects malformed revision names", () => {
  assert.deepEqual(orderPostgresMigrationNames([
    "postgres-v1.1.0-r0.sql", "postgres-v1.1.0-r.sql", "postgres-v1.1.0-r2-extra.sql",
    "postgres-v1.1.0-r02.sql", "postgres-v1.1.sql", "notes.txt"
  ]), []);
});

test("the already-applied postgres-v1.1.0 migration checksum stays immutable", () => {
  const sql = fs.readFileSync(path.resolve("scripts/migrations/postgres-v1.1.0.sql"));
  assert.equal(
    crypto.createHash("sha256").update(sql).digest("hex"),
    "c562640ea47fe20558d6b9f5dc31230fe49e0428757a4669661bd3e05b77a4b4"
  );
});

test("the already-applied postgres-v1.1.0-r2 migration checksum stays immutable", () => {
  const sql = fs.readFileSync(path.resolve("scripts/migrations/postgres-v1.1.0-r2.sql"));
  assert.equal(
    crypto.createHash("sha256").update(sql).digest("hex"),
    "5d2f65710b6579b0f5e9bf7992cbf254e1ad5e858dbe758bf2214a817df47528"
  );
});

test("recorded and schema-detected migrations are not pending", () => {
  const scripts = [
    { name: "postgres-v1.0.1.sql", checksum: "a" },
    { name: "postgres-v1.1.0.sql", checksum: "b" },
    { name: "postgres-v1.2.0.sql", checksum: "c" }
  ];
  const result = classifyPostgresMigrations({
    scripts,
    recorded: new Map([["postgres-v1.0.1.sql", "a"]]),
    satisfiedNames: new Set(["postgres-v1.1.0.sql"])
  });
  assert.deepEqual(result.reconciled.map(item => item.name), ["postgres-v1.1.0.sql"]);
  assert.deepEqual(result.pending.map(item => item.name), ["postgres-v1.2.0.sql"]);
});

test("Postgres pre-migration backup schema names are safe and versioned", () => {
  assert.equal(
    postgresMigrationBackupSchemaName(
      { globalVersion: 5, planningVersion: 6, ledgerVersion: 6 },
      new Date("2026-10-14T08:09:10.123Z")
    ),
    "cashflow_premigration_g5_p6_l6_20261014t080910123z"
  );
  assert.match(
    postgresMigrationBackupSchemaName({}, new Date("2026-10-14T08:09:10.123Z")),
    /^[a-z0-9_]+$/
  );
});

test("Postgres migration backup settings validate values and use safe defaults", () => {
  const errors = [];
  assert.deepEqual(parsePostgresMigrationBackupSettings({}), { enabled: true, keep: 3 });
  assert.deepEqual(parsePostgresMigrationBackupSettings({
    CASHFLOW_DB_MIGRATION_BACKUP: "false",
    CASHFLOW_DB_MIGRATION_BACKUP_KEEP: "0"
  }), { enabled: false, keep: 0 });
  assert.deepEqual(parsePostgresMigrationBackupSettings({
    CASHFLOW_DB_MIGRATION_BACKUP: "sometimes",
    CASHFLOW_DB_MIGRATION_BACKUP_KEEP: "-1"
  }, { logError: (...args) => errors.push(args) }), { enabled: true, keep: 3 });
  assert.equal(errors.length, 2);
  assert.equal(errors.every(([kind]) => kind === "cashflow_postgres_migration_backup_setting_invalid"), true);
});

test("Postgres migration backup retention removes only the oldest recorded backup schemas", () => {
  const records = [
    { schemaName: "cashflow_premigration_g4_p6_l6_20261012t080910123z", createdAt: "2026-10-12T08:09:10.123Z" },
    { schemaName: "cashflow_premigration_g5_p6_l6_20261014t080910123z", createdAt: "2026-10-14T08:09:10.123Z" },
    { schemaName: "public", createdAt: "2026-10-01T00:00:00.000Z" },
    { schemaName: "cashflow_premigration_g4_p6_l6_20261013t080910123z", createdAt: "2026-10-13T08:09:10.123Z" }
  ];
  assert.deepEqual(selectPostgresMigrationBackupSchemasForRetention(records, 2), [
    "cashflow_premigration_g4_p6_l6_20261012t080910123z"
  ]);
});

test("database update notice redacts secrets and lists generic operator commands", () => {
  const secret = "postgres://admin:hunter2@db.example/cashflow";
  const html = databaseUpdateNoticeHtml({
    error: new Error(`permission denied at ${secret}; password=hunter2`),
    pending: ["postgres-v1.1.0.sql"]
  });
  assert.doesNotMatch(html, /hunter2|admin:/);
  assert.match(html, /postgres-v1\.1\.0\.sql/);
  assert.match(html, /npm run db:migrate/);
  assert.match(html, /docker exec &lt;container&gt;/);
  assert.match(html, /kubectl exec deploy\//);
  assert.equal(redactDatabaseError(`connect ${secret}`), "connect [database URL removed]");
});

test("database update notice explains how to continue after an automatic backup failure", () => {
  const error = new Error("Automatic Postgres pre-migration backup failed: permission denied");
  error.databaseMigrationBackupFailed = true;
  const html = databaseUpdateNoticeHtml({ error, pending: ["postgres-v1.1.0.sql"] });
  assert.match(html, /automatic pre-migration backup failed/i);
  assert.match(html, /CASHFLOW_DB_MIGRATION_BACKUP=false npm run db:migrate/);
  assert.doesNotMatch(html, /psql &quot;\$CASHFLOW_DATABASE_URL&quot;/);
});

test("database update readiness accepts both modes and defaults invalid values", () => {
  const errors = [];
  assert.equal(resolveDatabaseUpdateReadiness("ready"), "ready");
  assert.equal(resolveDatabaseUpdateReadiness("not_ready"), "not_ready");
  assert.equal(resolveDatabaseUpdateReadiness("surprise", { logError: (...args) => errors.push(args) }), "ready");
  assert.equal(errors[0][0], "cashflow_db_update_readiness_invalid");
  assert.equal(databaseUpdateReadinessResponse("ready").status, 200);
  assert.deepEqual(databaseUpdateReadinessResponse("ready").body.databaseUpdateRequired, true);
  assert.equal(databaseUpdateReadinessResponse("not_ready").status, 503);
});

test("the already-applied postgres-v1.0.1.sql migration checksum stays immutable", () => {
  const sql = fs.readFileSync(path.resolve("scripts/migrations/postgres-v1.0.1.sql"));
  assert.equal(crypto.createHash("sha256").update(sql).digest("hex"),
    "807e0e91052ef3e6d9354f531160e47fddfffb61e11c2a15444ea2a868183b64");
});

test("the already-applied postgres-v1.1.5.sql migration checksum stays immutable", () => {
  const sql = fs.readFileSync(path.resolve("scripts/migrations/postgres-v1.1.5.sql"));
  assert.equal(crypto.createHash("sha256").update(sql).digest("hex"),
    "0fac692f6e9b78c40ea6cc96d685347a6ddf7bdcac73809ad91e1822a35ae069");
});

test('release migration files contain the four production scripts followed by v1.2.0', () => {
  assert.deepEqual(loadPostgresMigrationScripts(path.resolve('scripts/migrations')).map(row => row.name), [
    'postgres-v1.0.1.sql', 'postgres-v1.1.0.sql', 'postgres-v1.1.0-r2.sql', 'postgres-v1.1.5.sql', 'postgres-v1.2.0.sql'
  ]);
});

// Catalog responses model unrecorded schemas; no migration SQL should run during inspection.
async function inspectCatalog({ missing = null, globalVersion = 8, planningVersion = 22,
  cancellationConstraints = 2 } = {}) {
  const client = {
    release() {},
    async query(sql, parameters = []) {
      if (sql.includes('pg_advisory_')) return { rows: [] };
      if (sql.includes('to_regclass')) return { rows: [{ relation:
        parameters[0] === 'cashflow_schema_migrations' || parameters[0] === missing ? null : parameters[0] }] };
      if (sql.includes('information_schema.columns')) {
        return { rowCount: parameters.join('.') === missing ? 0 : 1 };
      }
      if (sql.includes('settings_delete_action')) return { rows: [{ settings_delete_action: 'a', nondeferrable_global_fks: 0 }] };
      if (sql.includes('pg_constraint')) return { rows: [{ n: cancellationConstraints }] };
      if (sql.includes('SELECT version FROM cashflow_global_schema_version')) return { rows: [{ version: globalVersion }] };
      if (sql.includes('FROM cashflow_budget_schema_version')) return { rows: [{ planning_version: planningVersion, ledger_version: 5 }] };
      assert.fail(`Unexpected catalog query: ${sql}`);
    }
  };
  return runPostgresMigrations({ pool: { connect: async () => client },
    migrationsDir: path.resolve('scripts/migrations'), autoMigrate: false });
}

test('unrecorded current Postgres schemas detect v1.1.5 and the combined v1.2.0 without migrating', async () => {
  const result = await inspectCatalog();
  assert.equal(result.current, true);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.reconciled.map(row => row.name), [
    'postgres-v1.0.1.sql', 'postgres-v1.1.0.sql', 'postgres-v1.1.0-r2.sql', 'postgres-v1.1.5.sql', 'postgres-v1.2.0.sql'
  ]);
});

test('combined Postgres detection requires every new table, column, and cancellation constraints', async () => {
  for (const missing of ['app_device_instance', 'app_device_pairings', 'app_devices', 'app_device_tokens',
    'cashflow_sync_heads', 'cashflow_sync_operations', 'cashflow_ledger_summary_cache',
    'cashflow_ledger_audit_state', 'cashflow_ledger_originals', 'cashflow_ledger_corrections',
    'cashflow_ledger_origins', 'cashflow_standalone_transfers', 'global_options.device_access_minutes',
    'global_options.device_renewal_idle_days', 'global_options.device_absolute_days',
    'global_options.backup_max_retention_count', 'global_options.backup_max_age_days',
    'cashflow_sync_heads.retained_after', 'cashflow_sync_operations.payload_pruned',
    'settings.notification_channels', 'notification_queue.sent_channels',
    'cashflow_ledger_audit_state.origin_version', 'budgets.revision']) {
    const result = await inspectCatalog({ missing });
    assert.equal(result.current, false, missing);
    assert.deepEqual(result.pending, ['postgres-v1.2.0.sql'], missing);
  }
  for (const catalog of [{ globalVersion: 7 }, { planningVersion: 21 },
    { cancellationConstraints: 1 }]) {
    const result = await inspectCatalog(catalog);
    assert.equal(result.current, false);
    assert.deepEqual(result.pending, ['postgres-v1.2.0.sql']);
  }
});

test('main end-month migration detection checks both columns independently of v1.2.0 detection', async () => {
  for (const table of ['recurring_expenses', 'recurring_incomes']) {
    const result = await inspectCatalog({ missing: `${table}.end_month_year` });
    assert.deepEqual(result.pending, ['postgres-v1.1.5.sql']);
    assert.ok(result.reconciled.some(row => row.name === 'postgres-v1.2.0.sql'));
  }
});
