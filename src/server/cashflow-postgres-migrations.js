import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactDatabaseError } from "./cashflow-database-update-mode.js";
import { POSTGRES_LEDGER_SCHEMA_VERSION, POSTGRES_PLANNING_SCHEMA_VERSION } from "./cashflow-postgres-budget-schema.js";
import { POSTGRES_GLOBAL_SCHEMA_VERSION } from "./cashflow-postgres-global-schema.js";

export const CASHFLOW_POSTGRES_MIGRATION_LOCK_KEY = 73190199;
export const DEFAULT_POSTGRES_MIGRATION_BACKUP_KEEP = 3;
const MIGRATION_NAME = /^postgres-v(\d+)\.(\d+)\.(\d+)(?:-r([1-9]\d*))?\.sql$/;
const MIGRATION_BACKUP_SCHEMA = /^cashflow_premigration_g(?:\d+|unknown)_p(?:\d+|unknown)_l(?:\d+|unknown)_\d{8}t\d{9}z$/;

function versionParts(name) {
  const match = String(name).match(MIGRATION_NAME);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] || 1)] : null;
}

export function orderPostgresMigrationNames(names = []) {
  return names.filter(name => versionParts(name)).sort((left, right) => {
    const a = versionParts(left);
    const b = versionParts(right);
    for (let index = 0; index < 4; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return left.localeCompare(right);
  });
}

export function loadPostgresMigrationScripts(migrationsDir) {
  return orderPostgresMigrationNames(fs.readdirSync(migrationsDir)).map(name => {
    const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
    return { name, sql, checksum: crypto.createHash("sha256").update(sql).digest("hex") };
  });
}

async function tableExists(client, name) {
  const result = await client.query("SELECT to_regclass($1) AS relation", [name]);
  return Boolean(result.rows?.[0]?.relation);
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, [tableName, columnName]);
  return Boolean(result.rowCount);
}

async function migrationAlreadyApplied(client, migration) {
  if (migration.name === "postgres-v1.0.1.sql") {
    const basicObjectsExist = await tableExists(client, "cashflow_backup_artifacts")
      && await tableExists(client, "cashflow_auth_rate_limits")
      && await tableExists(client, "idx_cashflow_auth_rate_limits_reset_at")
      && await columnExists(client, "recurring_expenses", "anchor_income_id");
    if (!basicObjectsExist) return false;
    const constraints = await client.query(`
      SELECT
        (SELECT confdeltype FROM pg_constraint
          WHERE conrelid = 'settings'::regclass AND conname = 'settings_budget_period_income_fk') AS settings_delete_action,
        (SELECT count(*)::integer FROM pg_constraint
          WHERE contype = 'f' AND NOT condeferrable
            AND conrelid::regclass::text = ANY($1::text[])) AS nondeferrable_global_fks
    `, [[
      "account_global_roles", "budgets", "budget_memberships", "budget_invitations",
      "auth_identities", "password_credentials", "password_reset_tokens", "auth_sessions",
      "auth_oauth_states", "security_audit_log"
    ]]);
    return constraints.rows?.[0]?.settings_delete_action === "a"
      && Number(constraints.rows?.[0]?.nondeferrable_global_fks) === 0;
  }
  if (migration.name === "postgres-v1.1.0.sql") {
    const version = await client.query("SELECT version FROM cashflow_global_schema_version WHERE id = 1");
    return Number(version.rows?.[0]?.version) >= 6 && await columnExists(client, "accounts", "avatar");
  }
  if (migration.name === "postgres-v1.1.0-r2.sql") {
    const version = await client.query("SELECT version FROM cashflow_global_schema_version WHERE id = 1");
    return Number(version.rows?.[0]?.version) >= 7
      && await columnExists(client, "global_options", "ntfy_allowed_private_hosts");
  }
  if (migration.name === "postgres-v1.1.5.sql") {
    if (!await tableExists(client, "cashflow_budget_schema_version")) return false;
    const version = await client.query("SELECT planning_version FROM cashflow_budget_schema_version WHERE id = 1");
    return Number(version.rows?.[0]?.planning_version) >= 21
      && await columnExists(client, "recurring_expenses", "end_month_year")
      && await columnExists(client, "recurring_incomes", "end_month_year");
  }
  return false;
}

async function currentSchemaState(client) {
  const globalExists = await tableExists(client, "cashflow_global_schema_version");
  const budgetExists = await tableExists(client, "cashflow_budget_schema_version");
  let globalVersion = null;
  let planningVersion = null;
  let ledgerVersion = null;
  if (globalExists) {
    const result = await client.query("SELECT version FROM cashflow_global_schema_version WHERE id = 1");
    globalVersion = Number(result.rows?.[0]?.version);
  }
  if (budgetExists) {
    const result = await client.query("SELECT planning_version, ledger_version FROM cashflow_budget_schema_version WHERE id = 1");
    planningVersion = Number(result.rows?.[0]?.planning_version);
    ledgerVersion = Number(result.rows?.[0]?.ledger_version);
  }
  return { globalVersion, planningVersion, ledgerVersion };
}

function schemaIsCurrent(state) {
  return state.globalVersion === POSTGRES_GLOBAL_SCHEMA_VERSION
    && state.planningVersion === POSTGRES_PLANNING_SCHEMA_VERSION
    && state.ledgerVersion === POSTGRES_LEDGER_SCHEMA_VERSION;
}

async function recordedMigrations(client) {
  if (!await tableExists(client, "cashflow_schema_migrations")) return new Map();
  const result = await client.query("SELECT name, checksum FROM cashflow_schema_migrations");
  return new Map((result.rows || []).map(row => [row.name, row.checksum]));
}

export function classifyPostgresMigrations({ scripts = [], recorded = new Map(), satisfiedNames = new Set() } = {}) {
  const pending = [];
  const reconciled = [];
  for (const migration of scripts) {
    const checksum = recorded.get(migration.name);
    if (checksum && checksum !== migration.checksum) throw new Error(`Recorded migration checksum does not match ${migration.name}`);
    if (checksum) continue;
    if (satisfiedNames.has(migration.name)) reconciled.push(migration);
    else pending.push(migration);
  }
  return { pending, reconciled };
}

export function parsePostgresMigrationBackupSettings(env = process.env, { logError = () => {} } = {}) {
  const rawEnabled = String(env.CASHFLOW_DB_MIGRATION_BACKUP ?? "").trim().toLowerCase();
  let enabled = true;
  if (rawEnabled && rawEnabled !== "true" && rawEnabled !== "false") {
    logError("cashflow_postgres_migration_backup_setting_invalid", {
      setting: "CASHFLOW_DB_MIGRATION_BACKUP", value: rawEnabled, fallback: true
    });
  } else if (rawEnabled === "false") {
    enabled = false;
  }

  const rawKeep = String(env.CASHFLOW_DB_MIGRATION_BACKUP_KEEP ?? "").trim();
  let keep = DEFAULT_POSTGRES_MIGRATION_BACKUP_KEEP;
  if (rawKeep) {
    const parsed = Number(rawKeep);
    if (Number.isInteger(parsed) && parsed >= 0) keep = parsed;
    else {
      logError("cashflow_postgres_migration_backup_setting_invalid", {
        setting: "CASHFLOW_DB_MIGRATION_BACKUP_KEEP", value: rawKeep,
        fallback: DEFAULT_POSTGRES_MIGRATION_BACKUP_KEEP
      });
    }
  }
  return { enabled, keep };
}

function versionLabel(value) {
  return Number.isInteger(value) && value >= 0 ? String(value) : "unknown";
}

export function postgresMigrationBackupSchemaName(state = {}, now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:.]/g, "").toLowerCase();
  return `cashflow_premigration_g${versionLabel(state.globalVersion)}_p${versionLabel(state.planningVersion)}_l${versionLabel(state.ledgerVersion)}_${timestamp}`;
}

export function selectPostgresMigrationBackupSchemasForRetention(records = [], keep = DEFAULT_POSTGRES_MIGRATION_BACKUP_KEEP) {
  const retainedCount = Number.isInteger(keep) && keep >= 0 ? keep : DEFAULT_POSTGRES_MIGRATION_BACKUP_KEEP;
  return records
    .filter(record => MIGRATION_BACKUP_SCHEMA.test(String(record.schemaName || record.schema_name || "")))
    .sort((left, right) => {
      const timeDifference = Date.parse(right.createdAt || right.created_at || 0) - Date.parse(left.createdAt || left.created_at || 0);
      if (timeDifference) return timeDifference;
      return String(right.schemaName || right.schema_name).localeCompare(String(left.schemaName || left.schema_name));
    })
    .slice(retainedCount)
    .map(record => String(record.schemaName || record.schema_name));
}

async function formattedSql(client, template, parameters) {
  const result = await client.query("SELECT format($1, VARIADIC $2::text[]) AS sql", [template, parameters.map(String)]);
  return result.rows[0].sql;
}

async function ensureBackupRegistry(client, sourceSchema) {
  const sql = await formattedSql(client, `CREATE TABLE IF NOT EXISTS %I.cashflow_schema_backups (
    schema_name TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL,
    from_global_version INTEGER,
    from_planning_version INTEGER,
    from_ledger_version INTEGER,
    to_global_version INTEGER NOT NULL,
    to_planning_version INTEGER NOT NULL,
    to_ledger_version INTEGER NOT NULL,
    table_count INTEGER NOT NULL,
    row_counts JSONB NOT NULL
  )`, [sourceSchema]);
  await client.query(sql);
}

export async function createPostgresMigrationBackup({ client, state, now = new Date() }) {
  const schemaName = postgresMigrationBackupSchemaName(state, now);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    const schemaResult = await client.query("SELECT current_schema() AS name");
    const sourceSchema = schemaResult.rows[0]?.name;
    if (!sourceSchema) throw new Error("Postgres search_path has no current schema");
    // Discover first so the initial backup describes exactly the schema that existed before this feature created its registry.
    const tablesResult = await client.query(`SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`, [sourceSchema]);
    const tables = tablesResult.rows.map(row => row.table_name);
    await ensureBackupRegistry(client, sourceSchema);
    await client.query(await formattedSql(client, "CREATE SCHEMA %I", [schemaName]));
    const rowCounts = {};
    for (const tableName of tables) {
      await client.query(await formattedSql(client, "CREATE TABLE %I.%I AS TABLE %I.%I", [schemaName, tableName, sourceSchema, tableName]));
      const count = await client.query(await formattedSql(client, "SELECT count(*)::bigint AS count FROM %I.%I", [schemaName, tableName]));
      rowCounts[tableName] = String(count.rows[0].count);
    }
    const insertSql = await formattedSql(client, `INSERT INTO %I.cashflow_schema_backups (
      schema_name, created_at, from_global_version, from_planning_version, from_ledger_version,
      to_global_version, to_planning_version, to_ledger_version, table_count, row_counts
    ) VALUES ($1, $2, $3::integer, $4::integer, $5::integer, $6::integer, $7::integer, $8::integer, $9::integer, $10::jsonb)`, [sourceSchema]);
    await client.query(insertSql, [
      schemaName, now,
      Number.isInteger(state.globalVersion) ? state.globalVersion : null,
      Number.isInteger(state.planningVersion) ? state.planningVersion : null,
      Number.isInteger(state.ledgerVersion) ? state.ledgerVersion : null,
      POSTGRES_GLOBAL_SCHEMA_VERSION, POSTGRES_PLANNING_SCHEMA_VERSION, POSTGRES_LEDGER_SCHEMA_VERSION,
      tables.length, JSON.stringify(rowCounts)
    ]);
    await client.query("COMMIT");
    return { schemaName, createdAt: now.toISOString(), tableCount: tables.length, rowCounts };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function prunePostgresMigrationBackups(client, keep) {
  if (!await tableExists(client, "cashflow_schema_backups")) return [];
  const sourceSchema = (await client.query("SELECT current_schema() AS name")).rows[0]?.name;
  const selectSql = await formattedSql(client, "SELECT schema_name, created_at FROM %I.cashflow_schema_backups", [sourceSchema]);
  const records = (await client.query(selectSql)).rows;
  const remove = selectPostgresMigrationBackupSchemasForRetention(records, keep);
  if (remove.length === 0) return [];
  await client.query("BEGIN");
  try {
    const deleteSql = await formattedSql(client, "DELETE FROM %I.cashflow_schema_backups WHERE schema_name = $1", [sourceSchema]);
    for (const schemaName of remove) {
      await client.query(await formattedSql(client, "DROP SCHEMA IF EXISTS %I CASCADE", [schemaName]));
      await client.query(deleteSql, [schemaName]);
    }
    await client.query("COMMIT");
    return remove;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function inspectWithClient(client, scripts) {
  const recorded = await recordedMigrations(client);
  const satisfiedNames = new Set();
  for (const migration of scripts) {
    if (!recorded.has(migration.name) && await migrationAlreadyApplied(client, migration)) satisfiedNames.add(migration.name);
  }
  const { pending, reconciled } = classifyPostgresMigrations({ scripts, recorded, satisfiedNames });
  const schema = await currentSchemaState(client);
  return { current: schemaIsCurrent(schema) && pending.length === 0, pending, reconciled, schema };
}

async function loadPg(pgModule) {
  return pgModule || await import("pg");
}

function poolClass(pgModule) {
  return pgModule.Pool || pgModule.default?.Pool;
}

export async function runPostgresMigrations({ databaseUrl, migrationsDir, autoMigrate = true,
  logError = () => {}, logServerEvent = () => {}, pgModule = null, pool = null,
  env = process.env, createMigrationBackup = createPostgresMigrationBackup }) {
  const scripts = loadPostgresMigrationScripts(migrationsDir);
  const backupSettings = parsePostgresMigrationBackupSettings(env, { logError });
  const ownedPool = pool || new (poolClass(await loadPg(pgModule)))({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000 });
  let client;
  try {
    client = await ownedPool.connect();
  } catch (error) {
    error.pendingMigrations = scripts.map(item => item.name);
    logError("cashflow_postgres_migration_failed", { migration: null, error: redactDatabaseError(error) });
    if (!pool) await ownedPool.end().catch(() => {});
    throw error;
  }
  let locked = false;
  let knownPending = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [CASHFLOW_POSTGRES_MIGRATION_LOCK_KEY]);
    locked = true;
    let inspection = await inspectWithClient(client, scripts);
    knownPending = inspection.pending.map(item => item.name);
    if (!autoMigrate || inspection.pending.length === 0) {
      return { ...inspection, applied: [], pending: inspection.pending.map(item => item.name) };
    }
    let backup = null;
    if (backupSettings.enabled) {
      try {
        backup = await createMigrationBackup({ client, state: inspection.schema });
        logServerEvent("cashflow_postgres_migration_backup_created", {
          schemaName: backup.schemaName,
          fromVersion: inspection.schema,
          toVersion: {
            globalVersion: POSTGRES_GLOBAL_SCHEMA_VERSION,
            planningVersion: POSTGRES_PLANNING_SCHEMA_VERSION,
            ledgerVersion: POSTGRES_LEDGER_SCHEMA_VERSION
          },
          tableCount: backup.tableCount,
          rowCounts: backup.rowCounts
        });
      } catch (cause) {
        const error = new Error(`Automatic Postgres pre-migration backup failed: ${redactDatabaseError(cause)}`, { cause });
        error.databaseMigrationBackupFailed = true;
        error.pendingMigrations = inspection.pending.map(item => item.name);
        logError("cashflow_postgres_migration_backup_failed", {
          error: redactDatabaseError(cause), pending: error.pendingMigrations
        });
        throw error;
      }
    }
    await client.query(`CREATE TABLE IF NOT EXISTS cashflow_schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    for (const migration of inspection.reconciled) {
      await client.query("INSERT INTO cashflow_schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [migration.name, migration.checksum]);
    }
    const applied = [];
    for (const migration of inspection.pending) {
      try {
        // Each file owns its transaction boundary; future scripts may deliberately contain non-transactional statements.
        await client.query(migration.sql);
        await client.query("INSERT INTO cashflow_schema_migrations (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [migration.name, migration.checksum]);
        applied.push(migration.name);
        logServerEvent("cashflow_postgres_migration_applied", { migration: migration.name });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        error.pendingMigrations = inspection.pending.map(item => item.name);
        throw error;
      }
    }
    inspection = await inspectWithClient(client, scripts);
    if (inspection.current) {
      try {
        const removed = await prunePostgresMigrationBackups(client, backupSettings.keep);
        if (removed.length > 0) logServerEvent("cashflow_postgres_migration_backup_retention_completed", { removed });
      } catch (error) {
        logError("cashflow_postgres_migration_backup_retention_failed", { error: redactDatabaseError(error) });
      }
    }
    return { ...inspection, applied, pending: inspection.pending.map(item => item.name), backupSchema: backup?.schemaName || null };
  } catch (error) {
    if (!error.pendingMigrations) error.pendingMigrations = knownPending;
    logError("cashflow_postgres_migration_failed", {
      migration: knownPending[0] || null,
      error: redactDatabaseError(error)
    });
    throw error;
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [CASHFLOW_POSTGRES_MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
    if (!pool) await ownedPool.end();
  }
}
