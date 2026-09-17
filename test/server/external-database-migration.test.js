import assert from "node:assert/strict";

import Database from "better-sqlite3";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSqliteBudgetStorageExport
} from "../../scripts/export-sqlite-budget-storage.mjs";
import { createSqliteGlobalMetadataExport } from "../../scripts/export-sqlite-global-metadata.mjs";
import { importGlobalMetadataToPostgresCli } from "../../scripts/import-global-metadata-to-postgres.mjs";
import {
  postgresSchemaSql,
  printPostgresSchemaCli
} from "../../scripts/print-postgres-schema.mjs";
import {
  verifyPostgresMigration
} from "../../scripts/verify-postgres-migration.mjs";
import { migrateSqliteToPostgres } from "../../scripts/migrate-sqlite-to-postgres.mjs";
import { importBudgetStorageCli } from "../../scripts/import-budget-storage-to-postgres.mjs";
import { createPostgresGlobalDbService } from "../../src/server/cashflow-postgres-global-db-service.js";
import { createPostgresBudgetDbService } from "../../src/server/cashflow-postgres-budget-db-service.js";
import { createPostgresGlobalRepository } from "../../src/server/cashflow-postgres-global-repository.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { createSqliteGlobalStore } from "../../src/server/cashflow-sqlite-global-store.js";
import {
  createGlobalStoreExport
} from "../../src/server/cashflow-global-store-export.js";
import {
  applyGlobalStoreImportPlan,
  createGlobalStoreImportPlan
} from "../../src/server/cashflow-global-store-import-plan.js";
import { createPostgresLockService } from "../../src/server/cashflow-postgres-lock-service.js";
import {
  createPostgresBudgetStore,
  createSqliteBudgetStore
} from "../../src/server/cashflow-budget-store.js";
import {
  createBudgetStoreExport
} from "../../src/server/cashflow-budget-store-export.js";
import {
  applyBudgetStoreImportPlan,
  createBudgetStoreImportPlan
} from "../../src/server/cashflow-budget-store-import-plan.js";
import {
  BUDGET_STORE_SNAPSHOT_FORMAT,
  BUDGET_STORE_SNAPSHOT_VERSION,
  createBudgetStoreSnapshot,
  restoreBudgetStoreSnapshot
} from "../../src/server/cashflow-budget-store-snapshot.js";
import {
  CASHFLOW_STORAGE_SNAPSHOT_FORMAT,
  createCashflowStorageSnapshot,
  restoreCashflowStorageSnapshot
} from "../../src/server/cashflow-storage-snapshot.js";
import {
  createPostgresBudgetStorageSchemaSql,
  POSTGRES_BUDGET_COLUMNS,
  POSTGRES_BUDGET_LEDGER_TABLES,
  POSTGRES_BUDGET_PLANNING_TABLES,
  POSTGRES_BUDGET_TABLES,
  POSTGRES_LEDGER_SCHEMA_VERSION,
  POSTGRES_PLANNING_SCHEMA_VERSION
} from "../../src/server/cashflow-postgres-budget-schema.js";
import {
  importSqliteBudgetStorageToPostgres,
  normalizeSqliteBudgetStorageExport,
  SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
  SQLITE_BUDGET_STORAGE_EXPORT_VERSION
} from "../../src/server/cashflow-postgres-budget-import.js";
import {
  importSqliteGlobalMetadataToPostgres,
  normalizeSqliteGlobalMetadataExport
} from "../../src/server/cashflow-postgres-global-import.js";
import {
  createPostgresGlobalSchemaSql,
  POSTGRES_GLOBAL_COLUMNS,
  POSTGRES_COORDINATION_TABLES,
  POSTGRES_GLOBAL_SCHEMA_VERSION,
  POSTGRES_GLOBAL_TABLES
} from "../../src/server/cashflow-postgres-global-schema.js";
import {
  GLOBAL_SCHEMA_VERSION,
  initializeGlobalSchema
} from "../../src/server/cashflow-global-schema.js";
import { createSqliteGlobalRepository } from "../../src/server/cashflow-global-repository.js";
import {
  LEDGER_SCHEMA_VERSION,
  LEDGER_TABLE_NAMES,
  initializeLedgerSchema,
  initializePlanningSchema,
  PLANNING_SCHEMA_VERSION,
  PLANNING_TABLE_NAMES
} from "../../src/server/cashflow-schema.js";

async function withTempDirs(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "cashflow-external-db-test-"));
  const dataDir = path.join(root, "data");
  const outputDir = path.join(root, "exports");
  fs.mkdirSync(dataDir, { recursive: true });

  try {
    return await fn({ dataDir, outputDir, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createGlobalSource(dataDir) {
  const db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
  try {
    initializeGlobalSchema(db, { storageProfileIds: ["household"] });
    db.prepare(`
      INSERT INTO accounts (
        id, email, display_name, status, created_at, updated_at
      )
      VALUES (
        'alice', 'alice@example.com', 'Alice', 'active',
        '2026-01-03T04:00:00Z', '2026-01-03T04:00:00Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO auth_sessions (
        id, account_id, token_hash, csrf_token_hash, selected_budget_id,
        auth_method, created_at, last_seen_at, idle_expires_at,
        absolute_expires_at
      )
      VALUES (
        'session_private', 'alice', 'secret-token-hash', 'secret-csrf-hash',
        'household', 'none', '2026-01-03T04:00:00Z',
        '2026-01-03T04:01:00Z', '2026-01-03T05:00:00Z',
        '2026-01-04T04:00:00Z'
      )
    `).run();
  } finally {
    db.close();
  }
}

function createBudgetStorageSource(dataDir) {
  const budgetDir = path.join(dataDir, "household");
  fs.mkdirSync(budgetDir, { recursive: true });

  const planning = new Database(path.join(budgetDir, "planning.sqlite"));
  try {
    initializePlanningSchema(planning);
    planning.prepare(`
      INSERT INTO one_off_transactions (
        id, name, currency, amount, type, date, created_at, updated_at
      )
      VALUES (
        'oneoff_desk', 'Desk', 'PLN', 120, 'expense', '2026-01-20',
        '2026-01-03T04:00:00Z', '2026-01-03T04:00:00Z'
      )
    `).run();
    planning.prepare(`
      INSERT INTO pending_transactions (
        id, name, currency, amount, type, date, ledger_currency, status,
        pending_origin, created_at, updated_at
      )
      VALUES (
        'pending_income', 'Pending income', 'PLN', 300, 'income',
        '2026-01-04', 'PLN', 'pending', 'manual',
        '2026-01-03T04:00:00Z', '2026-01-03T04:00:00Z'
      )
    `).run();
  } finally {
    planning.close();
  }

  const ledger = new Database(path.join(budgetDir, "ledger_2026.sqlite"));
  try {
    initializeLedgerSchema(ledger);
    ledger.prepare(`
      INSERT INTO confirmed_transactions (
        id, name, currency, amount, type, date, confirmed_date, fx_rate,
        buffered_fx_rate, ledger_currency, running_balance_pln, ledger_amount,
        occurrence_key, created_at, updated_at
      )
      VALUES (
        'confirmed_income', 'Confirmed income', 'PLN', 500, 'income',
        '2026-01-05', '2026-01-05', 1, 1, 'PLN', 500, 500,
        'manual:confirmed_income:income:2026-01-05',
        '2026-01-05T04:00:00Z', '2026-01-05T04:00:00Z'
      )
    `).run();
  } finally {
    ledger.close();
  }
}

function fakePgModule({
  budgetLedgerVersion = POSTGRES_LEDGER_SCHEMA_VERSION,
  budgetPlanningVersion = POSTGRES_PLANNING_SCHEMA_VERSION,
  failOnSchema = false,
  failOnSql = "",
  queryHandler = null,
  readinessVersion = POSTGRES_GLOBAL_SCHEMA_VERSION
} = {}) {
  const queries = [];
  const releases = [];
  const clients = [];

  class Pool {
    constructor(options) {
      this.options = options;
    }

    async connect() {
      const client = {
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (failOnSchema && String(sql).includes("CREATE TABLE IF NOT EXISTS users")) {
            throw new Error("schema failed");
          }
          if (failOnSql && String(sql).includes(failOnSql)) {
            throw new Error("configured query failure");
          }
          if (typeof queryHandler === "function") {
            const handled = await queryHandler(sql, params);
            if (handled !== undefined) return handled;
          }
          if (String(sql).includes("SELECT version FROM cashflow_global_schema_version")) {
            return { rows: [{ version: readinessVersion }] };
          }
          if (String(sql).includes("SELECT planning_version, ledger_version FROM cashflow_budget_schema_version")) {
            return {
              rows: [{
                ledger_version: budgetLedgerVersion,
                planning_version: budgetPlanningVersion
              }]
            };
          }
          return { rows: [] };
        },
        release() {
          releases.push(true);
        }
      };
      clients.push(client);
      return client;
    }

    async end() {
      this.ended = true;
    }
  }

  return {
    module: { Pool },
    clients,
    queries,
    releases
  };
}

function fakePostgresClient(responses = [], handler = null) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (handler) return await handler(sql, params, queries.length);
      return responses.shift() || { rows: [] };
    }
  };
}

function repositorySurface(value) {
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "backend") continue;
    if (typeof child === "function") {
      result[key] = "function";
    } else if (child && typeof child === "object") {
      result[key] = repositorySurface(child);
    }
  }
  return result;
}

function budgetStoreSurface(value) {
  const ignored = new Set(["backend", "initialize", "transaction", "withClient"]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !ignored.has(key) && typeof child === "function")
      .map(([key]) => [key, "function"])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function globalStoreSurface(value) {
  const ignored = new Set(["backend", "globalDbPath"]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !ignored.has(key) && typeof child === "function")
      .map(([key]) => [key, "function"])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

test("Postgres global schema DDL covers every current global table and invariants", () => {
  const sql = createPostgresGlobalSchemaSql();

  assert.equal(POSTGRES_GLOBAL_SCHEMA_VERSION, GLOBAL_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(POSTGRES_GLOBAL_COLUMNS), POSTGRES_GLOBAL_TABLES);
  assert.match(sql, /^BEGIN;\n/);
  assert.match(sql, /\nCOMMIT;\n$/);
  assert.match(sql, /cashflow_global_schema_version/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS cashflow_runtime_locks/);
  assert.match(sql, /idx_cashflow_runtime_locks_expires_at/);
  assert.match(sql, /idx_accounts_email_lower/);
  assert.match(sql, /prevent_last_system_admin_delete/);
  assert.match(sql, /prevent_budget_owner_demotion/);
  assert.doesNotMatch(sql, /datetime\('now'\)/);
  assert.deepEqual(POSTGRES_COORDINATION_TABLES, ["cashflow_runtime_locks"]);

  for (const tableName of POSTGRES_GLOBAL_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}\\b`));
  }
});

test("Postgres budget storage schema DDL covers planning and ledger tables with budget boundaries", () => {
  const sql = createPostgresBudgetStorageSchemaSql();

  assert.equal(POSTGRES_PLANNING_SCHEMA_VERSION, PLANNING_SCHEMA_VERSION);
  assert.equal(POSTGRES_LEDGER_SCHEMA_VERSION, LEDGER_SCHEMA_VERSION);
  assert.deepEqual(POSTGRES_BUDGET_PLANNING_TABLES, PLANNING_TABLE_NAMES);
  assert.deepEqual(POSTGRES_BUDGET_LEDGER_TABLES, LEDGER_TABLE_NAMES);
  assert.deepEqual(Object.keys(POSTGRES_BUDGET_COLUMNS), POSTGRES_BUDGET_TABLES);
  assert.match(sql, /^BEGIN;\n/);
  assert.match(sql, /\nCOMMIT;\n$/);
  assert.match(sql, /cashflow_budget_schema_version/);
  assert.match(sql, /ledger_year INTEGER NOT NULL/);
  assert.match(sql, /CHECK \(ledger_year = EXTRACT\(YEAR FROM confirmed_date\)::INTEGER\)/);
  assert.match(sql, /idx_pending_budget_occurrence_key/);
  assert.match(sql, /idx_notification_budget_dedupe/);

  for (const tableName of POSTGRES_BUDGET_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}\\b`));
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName}[\\s\\S]*budget_id TEXT NOT NULL`));
    assert.ok(
      POSTGRES_BUDGET_COLUMNS[tableName].includes("budget_id"),
      `${tableName} must expose budget_id in migration columns`
    );
  }
});

test("Postgres budget db service initializes schema transactionally and checks readiness", async () => {
  const fakePg = fakePgModule();
  const events = [];
  const service = await createPostgresBudgetDbService({
    databaseUrl: "postgres://example.invalid/cashflow",
    logServerEvent: (kind, details) => events.push({ kind, details }),
    pgModule: fakePg.module
  });

  await service.initializeBudgetSchema();
  const initQueries = fakePg.queries.map(entry => entry.sql);
  assert.equal(initQueries[0], "BEGIN");
  assert.match(initQueries[1], /CREATE TABLE IF NOT EXISTS settings/);
  assert.equal(initQueries[2], "COMMIT");
  assert.equal(fakePg.releases.length, 1);
  assert.equal(events[0].kind, "cashflow_postgres_budget_schema_ready");
  assert.equal(events[0].details.planningVersion, POSTGRES_PLANNING_SCHEMA_VERSION);
  assert.equal(events[0].details.ledgerVersion, POSTGRES_LEDGER_SCHEMA_VERSION);

  const ready = await service.checkReadiness();
  assert.deepEqual(ready, {
    ok: true,
    backend: "postgres",
    ledgerSchemaVersion: POSTGRES_LEDGER_SCHEMA_VERSION,
    planningSchemaVersion: POSTGRES_PLANNING_SCHEMA_VERSION
  });
  assert.equal(fakePg.releases.length, 2);

  await service.close();
});

test("Postgres budget db service rolls back failed schema initialization", async () => {
  const fakePg = fakePgModule({ failOnSql: "CREATE TABLE IF NOT EXISTS settings" });
  const errors = [];
  const service = await createPostgresBudgetDbService({
    databaseUrl: "postgres://example.invalid/cashflow",
    logError: (kind, details) => errors.push({ kind, details }),
    pgModule: fakePg.module
  });

  await assert.rejects(
    () => service.initializeBudgetSchema(),
    /configured query failure/
  );
  assert.deepEqual(fakePg.queries.map(entry => entry.sql), [
    "BEGIN",
    createPostgresBudgetStorageSchemaSql({ includeTransaction: false }),
    "ROLLBACK"
  ]);
  assert.equal(fakePg.releases.length, 1);
  assert.equal(errors.some(entry => entry.kind === "cashflow_postgres_budget_schema_failed"), true);
});

test("Postgres budget db service rejects missing URLs and mismatched schema versions", async () => {
  await assert.rejects(
    () => createPostgresBudgetDbService({ pgModule: fakePgModule().module }),
    /CASHFLOW_DATABASE_URL is required/
  );

  const service = await createPostgresBudgetDbService({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePgModule({ budgetPlanningVersion: POSTGRES_PLANNING_SCHEMA_VERSION - 1 }).module
  });

  await assert.rejects(
    () => service.checkReadiness(),
    /Postgres budget schema version mismatch/
  );
});

test("SQLite budget store facade reads readiness and row counts without changing storage", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const store = createSqliteBudgetStore({
      listLedgerYears: budgetId => {
        assert.equal(budgetId, "household");
        return [2026];
      },
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true, readonly: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true, readonly: true }
      )
    });

    assert.deepEqual(await store.checkReadiness("household"), {
      ok: true,
      backend: "sqlite",
      budgetId: "household",
      ledgerYears: [2026],
      planningSchemaVersion: PLANNING_SCHEMA_VERSION
    });
    assert.equal(await store.countRows("household", "one_off_transactions"), 1);
    assert.equal(await store.countRows("household", "pending_transactions"), 1);
    assert.equal(await store.countRows("household", "confirmed_transactions"), 1);
    assert.deepEqual(
      (await store.listPlanningRows("household", "one_off_transactions")).map(row => ({
        budget_id: row.budget_id,
        id: row.id,
        name: row.name
      })),
      [{
        budget_id: "household",
        id: "oneoff_desk",
        name: "Desk"
      }]
    );
    assert.deepEqual(
      (await store.listConfirmedTransactions("household")).map(row => ({
        budget_id: row.budget_id,
        id: row.id,
        ledger_year: row.ledger_year,
        name: row.name
      })),
      [{
        budget_id: "household",
        id: "confirmed_income",
        ledger_year: 2026,
        name: "Confirmed income"
      }]
    );
    await assert.rejects(
      () => store.countRows("household", "not_a_table"),
      /Unsupported budget table/
    );
    await assert.rejects(
      () => store.listPlanningRows("household", "confirmed_transactions"),
      /Unsupported planning table/
    );
  });
});

test("SQLite budget store facade applies confirmed-ledger balance updates", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const store = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true, readonly: true }
      )
    });

    assert.deepEqual(
      await store.updateConfirmedLedgerBalances("household", [{
        id: "confirmed_income",
        ledgerAmount: 500.005,
        ledgerYear: 2026,
        runningBalance: 123.456
      }]),
      { updated: 1 }
    );

    const ledger = new Database(
      path.join(dataDir, "household", "ledger_2026.sqlite"),
      { fileMustExist: true, readonly: true }
    );
    try {
      assert.deepEqual(
        ledger.prepare(`
          SELECT ledger_amount, running_balance_pln
          FROM confirmed_transactions
          WHERE id = 'confirmed_income'
        `).get(),
        {
          ledger_amount: 500.01,
          running_balance_pln: 123.46
        }
      );
    } finally {
      ledger.close();
    }

    await assert.rejects(
      () => store.updateConfirmedLedgerBalances("household", [{
        id: "confirmed_income",
        ledgerYear: "not-a-year",
        runningBalance: 1,
        ledgerAmount: 1
      }]),
      /ledgerYear is required/
    );
  });
});

test("SQLite budget store facade inserts confirmed ledger rows for one ledger year", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const store = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true, readonly: true }
      )
    });

    assert.deepEqual(
      await store.insertConfirmedTransactions("household", [{
        amount: 75.555,
        buffered_fx_rate: 1,
        confirmed_date: "2026-01-08",
        created_at: "2026-01-08T04:00:00Z",
        currency: "PLN",
        date: "2026-01-08",
        fx_rate: 1,
        id: "confirmed_expense",
        ledger_amount: 75.555,
        ledger_currency: "PLN",
        ledger_year: 2026,
        name: "Confirmed expense",
        occurrence_key: "manual:confirmed_expense:expense:2026-01-08",
        running_balance_pln: 424.445,
        type: "expense",
        updated_at: "2026-01-08T04:00:00Z"
      }]),
      { inserted: 1 }
    );

    const inserted = (await store.listConfirmedTransactions("household"))
      .find(row => row.id === "confirmed_expense");
    assert.equal(inserted.amount, 75.56);
    assert.equal(inserted.ledger_amount, 75.56);
    assert.equal(inserted.running_balance_pln, 424.45);
    assert.equal(inserted.ledger_year, 2026);

    assert.deepEqual(
      await store.updateConfirmedTransactionsById("household", 2026, [{
        amount: 80.004,
        id: "confirmed_expense",
        name: "Updated expense",
        running_balance_pln: 419.996
      }]),
      { updated: 1 }
    );
    const updated = (await store.listConfirmedTransactions("household"))
      .find(row => row.id === "confirmed_expense");
    assert.equal(updated.name, "Updated expense");
    assert.equal(updated.amount, 80);
    assert.equal(updated.running_balance_pln, 420);

    assert.deepEqual(
      await store.deleteConfirmedTransactionsById("household", 2026, ["confirmed_expense"]),
      { deleted: 1 }
    );
    assert.equal(
      (await store.listConfirmedTransactions("household"))
        .some(row => row.id === "confirmed_expense"),
      false
    );

    await assert.rejects(
      () => store.insertConfirmedTransactions("household", [
        {
          amount: 1,
          confirmed_date: "2026-01-08",
          created_at: "2026-01-08T04:00:00Z",
          currency: "PLN",
          date: "2026-01-08",
          id: "same_year",
          ledger_year: 2026,
          name: "Same year",
          running_balance_pln: 1,
          type: "income",
          updated_at: "2026-01-08T04:00:00Z"
        },
        {
          amount: 1,
          confirmed_date: "2027-01-08",
          created_at: "2027-01-08T04:00:00Z",
          currency: "PLN",
          date: "2027-01-08",
          id: "other_year",
          ledger_year: 2027,
          name: "Other year",
          running_balance_pln: 1,
          type: "income",
          updated_at: "2027-01-08T04:00:00Z"
        }
      ]),
      /one ledger year/
    );
    await assert.rejects(
      () => store.updateConfirmedTransactionsById("household", 2026, [{
        confirmed_date: "2027-01-08",
        id: "confirmed_income"
      }]),
      /confirmed_date must match/
    );
  });
});

test("SQLite budget store facade inserts planning rows through a backend-neutral shape", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const store = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true }
      )
    });

    assert.deepEqual(
      await store.insertPlanningRows("household", "one_off_transactions", [{
        amount: 42.25,
        created_at: "2026-01-03T04:00:00Z",
        currency: "PLN",
        date: "2026-01-12",
        id: "oneoff_chair",
        name: "Chair",
        type: "expense",
        updated_at: "2026-01-03T04:00:00Z"
      }]),
      { inserted: 1 }
    );

    assert.deepEqual(
      (await store.listPlanningRows("household", "one_off_transactions"))
        .map(row => ({ budget_id: row.budget_id, id: row.id, name: row.name })),
      [
        { budget_id: "household", id: "oneoff_chair", name: "Chair" },
        { budget_id: "household", id: "oneoff_desk", name: "Desk" }
      ]
    );

    assert.deepEqual(
      await store.updatePlanningRowsById("household", "one_off_transactions", [{
        id: "oneoff_chair",
        name: "Seat"
      }]),
      { updated: 1 }
    );
    assert.deepEqual(
      (await store.listPlanningRows("household", "one_off_transactions"))
        .find(row => row.id === "oneoff_chair")?.name,
      "Seat"
    );

    assert.deepEqual(
      await store.deletePlanningRowsById("household", "one_off_transactions", ["oneoff_chair"]),
      { deleted: 1 }
    );
    assert.deepEqual(
      (await store.listPlanningRows("household", "one_off_transactions"))
        .map(row => row.id),
      ["oneoff_desk"]
    );

    await assert.rejects(
      () => store.insertPlanningRows("household", "confirmed_transactions", []),
      /Unsupported planning table/
    );
    await assert.rejects(
      () => store.insertPlanningRows("household", "one_off_transactions", [{
        budget_id: "other",
        id: "bad"
      }]),
      /budget_id does not match/
    );
    await assert.rejects(
      () => store.deletePlanningRowsById("household", "settings", ["1"]),
      /does not support id-based writes/
    );
  });
});

test("SQLite budget store facade exposes projection-specific planning helpers", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const store = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true }
      )
    });

    await store.insertPlanningRows("household", "future_transactions", [
      {
        amount: 300,
        created_at: "2026-01-03T04:00:00Z",
        currency: "PLN",
        date: "2026-01-20",
        funded_amount: 300,
        generation_timestamp: "2026-01-03T04:00:00Z",
        id: "future_income",
        ledger_amount: 300,
        ledger_currency: "PLN",
        name: "Future income",
        period: "2026-01",
        requested_amount: 300,
        status: "funded",
        type: "income"
      },
      {
        amount: 120,
        created_at: "2026-01-03T04:00:00Z",
        currency: "PLN",
        date: "2026-01-21",
        funded_amount: 100,
        generation_timestamp: "2026-01-03T04:00:00Z",
        id: "future_oneoff",
        ledger_amount: 100,
        ledger_currency: "PLN",
        name: "Future one-off",
        occurrence_key: "oneoff:desk",
        period: "2026-01",
        requested_amount: 120,
        source_one_off_id: "oneoff_desk",
        status: "partial",
        type: "expense"
      }
    ]);
    await store.insertPlanningRows("household", "pending_transactions", [
      {
        amount: 2,
        created_at: "2026-01-03T04:00:00Z",
        currency: "PLN",
        date: "2026-01-22",
        id: "pending_remainder_old",
        ledger_currency: "PLN",
        name: "Old remainder",
        occurrence_key: "oneoff_remainder:oneoff_desk:1",
        pending_origin: "projection",
        source_one_off_id: "oneoff_desk",
        status: "pending",
        type: "expense",
        updated_at: "2026-01-03T04:00:00Z"
      },
      {
        amount: 5,
        created_at: "2026-01-03T04:00:00Z",
        currency: "PLN",
        date: "2026-01-23",
        id: "pending_remainder_keep",
        ledger_currency: "PLN",
        name: "Kept remainder",
        occurrence_key: "oneoff_remainder:oneoff_desk:2",
        pending_origin: "projection",
        source_one_off_id: "oneoff_desk",
        status: "pending",
        type: "expense",
        updated_at: "2026-01-03T04:00:00Z"
      }
    ]);
    await store.insertPlanningRows("household", "event_log", [
      {
        action: "funding_shortfall",
        details: "{}",
        entity_id: "oneoff_desk",
        entity_type: "one_off",
        id: "event_projection",
        timestamp: "2026-01-03T04:00:00Z"
      },
      {
        action: "manual_note",
        details: "{}",
        entity_id: "oneoff_desk",
        entity_type: "one_off",
        id: "event_keep",
        timestamp: "2026-01-03T04:00:00Z"
      }
    ]);

    assert.equal(await store.pendingTransactionExistsByOccurrenceKey("household", "oneoff_remainder:oneoff_desk:1"), true);
    assert.equal(
      await store.sumFutureLedgerAmountBySource("household", "source_one_off_id", "oneoff_desk", "PLN"),
      100
    );
    assert.deepEqual(
      await store.futureProjectionSummary("household"),
      {
        totalProjectedExpenses: 100,
        totalProjectedIncome: 300,
        warningCount: 1
      }
    );
    assert.deepEqual(
      await store.deletePendingOneOffRemainders("household", "oneoff_desk", {
        keepOccurrenceKey: "oneoff_remainder:oneoff_desk:2",
        keepDate: "2026-01-23"
      }),
      { deleted: 1 }
    );
    assert.equal(await store.pendingTransactionExistsByOccurrenceKey("household", "oneoff_remainder:oneoff_desk:1"), false);
    assert.equal(await store.pendingTransactionExistsByOccurrenceKey("household", "oneoff_remainder:oneoff_desk:2"), true);
    assert.deepEqual(
      await store.deletePendingTransactionsByOccurrenceKeys("household", ["oneoff_remainder:oneoff_desk:2"]),
      { deleted: 1 }
    );
    assert.deepEqual(
      await store.deleteProjectionEventLogs("household", ["funding_shortfall"]),
      { deleted: 1 }
    );
    assert.deepEqual(
      (await store.listPlanningRows("household", "event_log")).map(row => row.id),
      ["event_keep"]
    );
  });
});

test("SQLite budget store facade replaces planning tables and ledger years transactionally", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const store = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true }
      )
    });

    assert.deepEqual(
      await store.replacePlanningRows("household", "one_off_transactions", [{
        amount: 18.5,
        created_at: "2026-01-04T04:00:00Z",
        currency: "PLN",
        date: "2026-01-14",
        id: "oneoff_lamp",
        name: "Lamp",
        type: "expense",
        updated_at: "2026-01-04T04:00:00Z"
      }]),
      { inserted: 1, replaced: true }
    );
    assert.deepEqual(
      (await store.listPlanningRows("household", "one_off_transactions"))
        .map(row => row.id),
      ["oneoff_lamp"]
    );

    assert.deepEqual(
      await store.replaceConfirmedTransactionsForYear("household", 2026, [{
        amount: 75.555,
        buffered_fx_rate: 1,
        confirmed_date: "2026-01-08",
        created_at: "2026-01-08T04:00:00Z",
        currency: "PLN",
        date: "2026-01-08",
        fx_rate: 1,
        id: "confirmed_expense",
        ledger_amount: 75.555,
        ledger_currency: "PLN",
        ledger_year: 2026,
        name: "Confirmed expense",
        occurrence_key: "manual:confirmed_expense:expense:2026-01-08",
        running_balance_pln: 424.445,
        type: "expense",
        updated_at: "2026-01-08T04:00:00Z"
      }]),
      { inserted: 1, ledgerYear: 2026, replaced: true }
    );
    assert.deepEqual(
      (await store.listConfirmedTransactions("household"))
        .map(row => ({
          id: row.id,
          ledger_amount: row.ledger_amount,
          running_balance_pln: row.running_balance_pln
        })),
      [{
        id: "confirmed_expense",
        ledger_amount: 75.56,
        running_balance_pln: 424.45
      }]
    );

    await assert.rejects(
      () => store.replaceConfirmedTransactionsForYear("household", 2026, [{
        amount: 1,
        confirmed_date: "2027-01-08",
        created_at: "2027-01-08T04:00:00Z",
        currency: "PLN",
        date: "2027-01-08",
        id: "wrong_year",
        ledger_year: 2027,
        name: "Wrong year",
        running_balance_pln: 1,
        type: "income",
        updated_at: "2027-01-08T04:00:00Z"
      }]),
      /replacement ledger year/
    );
  });
});

test("Postgres budget store facade exposes readiness, ledger years, and safe row counts", async () => {
  const fakePg = fakePgModule({
    queryHandler: async (sql, params) => {
      if (String(sql).includes("SELECT COUNT(*) AS count")) {
        assert.deepEqual(params, ["household"]);
        assert.match(String(sql), /FROM "pending_transactions" WHERE budget_id = \$1/);
        return { rows: [{ count: "7" }] };
      }
      if (String(sql).includes("SELECT DISTINCT ledger_year")) {
        assert.deepEqual(params, ["household"]);
        return {
          rows: [
            { ledger_year: 2025 },
            { ledger_year: 2026 }
          ]
        };
      }
      if (String(sql).includes("FROM confirmed_transactions") && String(sql).includes("ORDER BY date ASC")) {
        assert.deepEqual(params, ["household"]);
        return {
          rows: [{
            budget_id: "household",
            id: "confirmed_income",
            ledger_year: 2026,
            name: "Confirmed income"
          }]
        };
      }
      if (String(sql).includes('FROM "one_off_transactions"')) {
        assert.deepEqual(params, ["household"]);
        return {
          rows: [{
            budget_id: "household",
            id: "oneoff_desk",
            name: "Desk"
          }]
        };
      }
      return undefined;
    }
  });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  assert.deepEqual(await store.checkReadiness("household"), {
    ok: true,
    backend: "postgres",
    budgetId: "household",
    ledgerSchemaVersion: POSTGRES_LEDGER_SCHEMA_VERSION,
    planningSchemaVersion: POSTGRES_PLANNING_SCHEMA_VERSION
  });
  assert.equal(await store.countRows("household", "pending_transactions"), 7);
  assert.deepEqual(await store.listPlanningRows("household", "one_off_transactions"), [{
    budget_id: "household",
    id: "oneoff_desk",
    name: "Desk"
  }]);
  assert.deepEqual(await store.listLedgerYears("household"), [2025, 2026]);
  assert.deepEqual(await store.listConfirmedTransactions("household"), [{
    budget_id: "household",
    id: "confirmed_income",
    ledger_year: 2026,
    name: "Confirmed income"
  }]);
  await assert.rejects(
    () => store.countRows("household", "not_a_table"),
    /Unsupported budget table/
  );
  await assert.rejects(
    () => store.listPlanningRows("household", "confirmed_transactions"),
    /Unsupported planning table/
  );

  await store.close();
});

test("Postgres budget store facade mirrors the SQLite runtime-neutral surface", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const sqlite = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true }
      )
    });
    const postgres = await createPostgresBudgetStore({
      databaseUrl: "postgres://example.invalid/cashflow",
      pgModule: fakePgModule().module
    });

    assert.equal(postgres.backend, "postgres");
    assert.deepEqual(budgetStoreSurface(postgres), budgetStoreSurface(sqlite));

    await postgres.close();
  });
});

test("Postgres budget store transaction binds multiple budget writes to one client", async () => {
  const fakePg = fakePgModule({
    queryHandler: async (sql, params) => {
      if (String(sql).includes('INSERT INTO "one_off_transactions"')) {
        assert.deepEqual(params, [
          "household",
          "oneoff_chair",
          "Chair",
          "PLN",
          42.25,
          "expense",
          "2026-01-12",
          "2026-01-03T04:00:00Z",
          "2026-01-03T04:00:00Z"
        ]);
        return { rowCount: 1, rows: [] };
      }
      if (String(sql).includes("INSERT INTO confirmed_transactions")) {
        assert.deepEqual(params, [
          "household",
          2026,
          "confirmed_expense",
          "Confirmed expense",
          "PLN",
          75.56,
          "expense",
          "2026-01-08",
          "2026-01-08",
          1,
          1,
          "PLN",
          424.45,
          75.56,
          "manual:confirmed_expense:expense:2026-01-08",
          "2026-01-08T04:00:00Z",
          "2026-01-08T04:00:00Z"
        ]);
        return { rowCount: 1, rows: [] };
      }
      return undefined;
    }
  });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  const result = await store.transaction(async repo => ({
    confirmed: await repo.insertConfirmedTransactions("household", [{
      amount: 75.555,
      buffered_fx_rate: 1,
      confirmed_date: "2026-01-08",
      created_at: "2026-01-08T04:00:00Z",
      currency: "PLN",
      date: "2026-01-08",
      fx_rate: 1,
      id: "confirmed_expense",
      ledger_amount: 75.555,
      ledger_currency: "PLN",
      ledger_year: 2026,
      name: "Confirmed expense",
      occurrence_key: "manual:confirmed_expense:expense:2026-01-08",
      running_balance_pln: 424.445,
      type: "expense",
      updated_at: "2026-01-08T04:00:00Z"
    }]),
    planning: await repo.insertPlanningRows("household", "one_off_transactions", [{
      amount: 42.25,
      created_at: "2026-01-03T04:00:00Z",
      currency: "PLN",
      date: "2026-01-12",
      id: "oneoff_chair",
      name: "Chair",
      type: "expense",
      updated_at: "2026-01-03T04:00:00Z"
    }])
  }));

  assert.deepEqual(result, {
    confirmed: { inserted: 1 },
    planning: { inserted: 1 }
  });
  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "COMMIT"
      ? entry.sql
      : String(entry.sql).includes('INSERT INTO "one_off_transactions"') ? "INSERT_PLANNING"
        : String(entry.sql).includes("INSERT INTO confirmed_transactions") ? "INSERT_LEDGER"
          : "OTHER"
    ),
    ["BEGIN", "INSERT_LEDGER", "INSERT_PLANNING", "COMMIT"]
  );
  assert.equal(fakePg.releases.length, 1);

  await store.close();
});

test("Postgres budget store transaction rolls back all bound budget writes on failure", async () => {
  const fakePg = fakePgModule({ failOnSql: 'INSERT INTO "one_off_transactions"' });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  await assert.rejects(
    () => store.transaction(async repo => {
      await repo.insertPlanningRows("household", "one_off_transactions", [{
        amount: 42.25,
        created_at: "2026-01-03T04:00:00Z",
        currency: "PLN",
        date: "2026-01-12",
        id: "oneoff_chair",
        name: "Chair",
        type: "expense",
        updated_at: "2026-01-03T04:00:00Z"
      }]);
      return "unreachable";
    }),
    /configured query failure/
  );
  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "ROLLBACK"
      ? entry.sql
      : String(entry.sql).includes('INSERT INTO "one_off_transactions"') ? "INSERT_PLANNING" : "OTHER"
    ),
    ["BEGIN", "INSERT_PLANNING", "ROLLBACK"]
  );
  assert.equal(fakePg.releases.length, 1);

  await store.close();
});

test("Postgres budget store facade inserts planning rows transactionally", async () => {
  const fakePg = fakePgModule({
    queryHandler: async (sql, params) => {
      if (String(sql).includes('INSERT INTO "one_off_transactions"')) {
        assert.deepEqual(params, [
          "household",
          "oneoff_chair",
          "Chair",
          "PLN",
          42.25,
          "expense",
          "2026-01-12",
          "2026-01-03T04:00:00Z",
          "2026-01-03T04:00:00Z"
        ]);
        return { rowCount: 1, rows: [] };
      }
      return undefined;
    }
  });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  assert.deepEqual(
    await store.insertPlanningRows("household", "one_off_transactions", [{
      amount: 42.25,
      created_at: "2026-01-03T04:00:00Z",
      currency: "PLN",
      date: "2026-01-12",
      id: "oneoff_chair",
      name: "Chair",
      type: "expense",
      updated_at: "2026-01-03T04:00:00Z"
    }]),
    { inserted: 1 }
  );
  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "COMMIT"
      ? entry.sql
      : String(entry.sql).includes('INSERT INTO "one_off_transactions"') ? "INSERT" : "OTHER"
    ),
    ["BEGIN", "INSERT", "COMMIT"]
  );

  await store.close();
});

test("Postgres budget store facade rolls back failed planning-row inserts", async () => {
  const fakePg = fakePgModule({ failOnSql: 'INSERT INTO "one_off_transactions"' });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  await assert.rejects(
    () => store.insertPlanningRows("household", "one_off_transactions", [{
      amount: 42.25,
      created_at: "2026-01-03T04:00:00Z",
      currency: "PLN",
      date: "2026-01-12",
      id: "oneoff_chair",
      name: "Chair",
      type: "expense",
      updated_at: "2026-01-03T04:00:00Z"
    }]),
    /configured query failure/
  );
  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "ROLLBACK"
      ? entry.sql
      : String(entry.sql).includes('INSERT INTO "one_off_transactions"') ? "INSERT" : "OTHER"
    ),
    ["BEGIN", "INSERT", "ROLLBACK"]
  );

  await store.close();
});

test("Postgres budget store facade updates and deletes planning rows transactionally", async () => {
  const fakePg = fakePgModule({
    queryHandler: async (sql, params) => {
      if (String(sql).includes('UPDATE "one_off_transactions"')) {
        assert.deepEqual(params, [
          "household",
          "oneoff_chair",
          "Seat",
          55
        ]);
        return { rowCount: 1, rows: [] };
      }
      if (String(sql).includes('DELETE FROM "one_off_transactions"')) {
        assert.deepEqual(params, ["household", ["oneoff_chair"]]);
        return { rowCount: 1, rows: [] };
      }
      return undefined;
    }
  });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  assert.deepEqual(
    await store.updatePlanningRowsById("household", "one_off_transactions", [{
      id: "oneoff_chair",
      name: "Seat",
      amount: 55
    }]),
    { updated: 1 }
  );
  assert.deepEqual(
    await store.deletePlanningRowsById("household", "one_off_transactions", ["oneoff_chair"]),
    { deleted: 1 }
  );
  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "COMMIT"
      ? entry.sql
      : String(entry.sql).includes('UPDATE "one_off_transactions"') ? "UPDATE"
        : String(entry.sql).includes('DELETE FROM "one_off_transactions"') ? "DELETE"
          : "OTHER"
    ),
    ["BEGIN", "UPDATE", "COMMIT", "BEGIN", "DELETE", "COMMIT"]
  );

  await store.close();
});

test("Postgres budget store facade exposes projection-specific planning helpers", async () => {
  const fakePg = fakePgModule({
    queryHandler: async (sql, params) => {
      const text = String(sql);
      if (text.includes("FROM pending_transactions") && text.includes("LIMIT 1")) {
        assert.deepEqual(params, ["household", "oneoff_remainder:oneoff_desk:1"]);
        return { rows: [{ "?column?": 1 }] };
      }
      if (text.includes("SUM(ledger_amount)") && text.includes('"source_one_off_id"')) {
        assert.deepEqual(params, ["household", "oneoff_desk", "PLN"]);
        return { rows: [{ value: "100.25" }] };
      }
      if (text.includes("total_projected_income")) {
        assert.deepEqual(params, ["household"]);
        return {
          rows: [{
            total_projected_expenses: "40.50",
            total_projected_income: "300",
            warning_count: "2"
          }]
        };
      }
      if (text.includes("DELETE FROM pending_transactions") && text.includes("source_one_off_id")) {
        assert.deepEqual(params, [
          "household",
          "oneoff_desk",
          "oneoff_remainder:oneoff_desk:2",
          "2026-01-23"
        ]);
        return { rowCount: 3, rows: [] };
      }
      if (text.includes("DELETE FROM pending_transactions") && text.includes("occurrence_key = ANY")) {
        assert.deepEqual(params, ["household", ["oneoff_remainder:oneoff_desk:2"]]);
        return { rowCount: 1, rows: [] };
      }
      if (text.includes("DELETE FROM event_log")) {
        assert.deepEqual(params, ["household", ["funding_shortfall"]]);
        return { rowCount: 2, rows: [] };
      }
      return undefined;
    }
  });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  assert.equal(
    await store.pendingTransactionExistsByOccurrenceKey("household", "oneoff_remainder:oneoff_desk:1"),
    true
  );
  assert.equal(
    await store.sumFutureLedgerAmountBySource("household", "source_one_off_id", "oneoff_desk", "PLN"),
    100.25
  );
  assert.deepEqual(
    await store.futureProjectionSummary("household"),
    {
      totalProjectedExpenses: 40.5,
      totalProjectedIncome: 300,
      warningCount: 2
    }
  );
  assert.deepEqual(
    await store.deletePendingOneOffRemainders("household", "oneoff_desk", {
      keepOccurrenceKey: "oneoff_remainder:oneoff_desk:2",
      keepDate: "2026-01-23"
    }),
    { deleted: 3 }
  );
  assert.deepEqual(
    await store.deletePendingTransactionsByOccurrenceKeys("household", ["oneoff_remainder:oneoff_desk:2"]),
    { deleted: 1 }
  );
  assert.deepEqual(
    await store.deleteProjectionEventLogs("household", ["funding_shortfall"]),
    { deleted: 2 }
  );
  await assert.rejects(
    () => store.sumFutureLedgerAmountBySource("household", "ledger_amount; DROP TABLE future_transactions", "x", "PLN"),
    /Unsupported future source column/
  );

  await store.close();
});

test("Postgres budget store facade replaces planning tables and ledger years transactionally", async () => {
  const fakePg = fakePgModule({
    queryHandler: async (sql, params) => {
      if (String(sql).includes('DELETE FROM "one_off_transactions"')) {
        assert.deepEqual(params, ["household"]);
        return { rowCount: 2, rows: [] };
      }
      if (String(sql).includes('INSERT INTO "one_off_transactions"')) {
        assert.deepEqual(params, [
          "household",
          "oneoff_lamp",
          "Lamp",
          "PLN",
          18.5,
          "expense",
          "2026-01-14",
          "2026-01-04T04:00:00Z",
          "2026-01-04T04:00:00Z"
        ]);
        return { rowCount: 1, rows: [] };
      }
      if (String(sql).includes("DELETE FROM confirmed_transactions")) {
        assert.deepEqual(params, ["household", 2026]);
        return { rowCount: 3, rows: [] };
      }
      if (String(sql).includes("INSERT INTO confirmed_transactions")) {
        assert.deepEqual(params, [
          "household",
          2026,
          "confirmed_expense",
          "Confirmed expense",
          "PLN",
          75.56,
          "expense",
          "2026-01-08",
          "2026-01-08",
          1,
          1,
          "PLN",
          424.45,
          75.56,
          "manual:confirmed_expense:expense:2026-01-08",
          "2026-01-08T04:00:00Z",
          "2026-01-08T04:00:00Z"
        ]);
        return { rowCount: 1, rows: [] };
      }
      return undefined;
    }
  });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  assert.deepEqual(
    await store.replacePlanningRows("household", "one_off_transactions", [{
      amount: 18.5,
      created_at: "2026-01-04T04:00:00Z",
      currency: "PLN",
      date: "2026-01-14",
      id: "oneoff_lamp",
      name: "Lamp",
      type: "expense",
      updated_at: "2026-01-04T04:00:00Z"
    }]),
    { inserted: 1, replaced: true }
  );
  assert.deepEqual(
    await store.replaceConfirmedTransactionsForYear("household", 2026, [{
      amount: 75.555,
      buffered_fx_rate: 1,
      confirmed_date: "2026-01-08",
      created_at: "2026-01-08T04:00:00Z",
      currency: "PLN",
      date: "2026-01-08",
      fx_rate: 1,
      id: "confirmed_expense",
      ledger_amount: 75.555,
      ledger_currency: "PLN",
      ledger_year: 2026,
      name: "Confirmed expense",
      occurrence_key: "manual:confirmed_expense:expense:2026-01-08",
      running_balance_pln: 424.445,
      type: "expense",
      updated_at: "2026-01-08T04:00:00Z"
    }]),
    { inserted: 1, ledgerYear: 2026, replaced: true }
  );
  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "COMMIT"
      ? entry.sql
      : String(entry.sql).includes('DELETE FROM "one_off_transactions"') ? "DELETE_PLANNING"
        : String(entry.sql).includes('INSERT INTO "one_off_transactions"') ? "INSERT_PLANNING"
          : String(entry.sql).includes("DELETE FROM confirmed_transactions") ? "DELETE_LEDGER"
            : String(entry.sql).includes("INSERT INTO confirmed_transactions") ? "INSERT_LEDGER"
              : "OTHER"
    ),
    [
      "BEGIN",
      "DELETE_PLANNING",
      "INSERT_PLANNING",
      "COMMIT",
      "BEGIN",
      "DELETE_LEDGER",
      "INSERT_LEDGER",
      "COMMIT"
    ]
  );

  await store.close();
});

test("Postgres budget store facade applies confirmed-ledger balance updates transactionally", async () => {
  const fakePg = fakePgModule({
    queryHandler: async (sql, params) => {
      if (String(sql).includes("UPDATE confirmed_transactions")) {
        assert.deepEqual(params, [
          "household",
          2026,
          "confirmed_income",
          123.46,
          500.01
        ]);
        return { rowCount: 1, rows: [] };
      }
      return undefined;
    }
  });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  assert.deepEqual(
    await store.updateConfirmedLedgerBalances("household", [{
      id: "confirmed_income",
      ledger_amount: 500.005,
      ledger_year: 2026,
      running_balance_pln: 123.456
    }]),
    { updated: 1 }
  );
  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "COMMIT"
      ? entry.sql
      : String(entry.sql).includes("UPDATE confirmed_transactions") ? "UPDATE" : "OTHER"
    ),
    ["BEGIN", "UPDATE", "COMMIT"]
  );

  await store.close();
});

test("Postgres budget store facade inserts confirmed ledger rows transactionally", async () => {
  const fakePg = fakePgModule({
    queryHandler: async (sql, params) => {
      if (String(sql).includes("INSERT INTO confirmed_transactions")) {
        assert.deepEqual(params, [
          "household",
          2026,
          "confirmed_expense",
          "Confirmed expense",
          "PLN",
          75.56,
          "expense",
          "2026-01-08",
          "2026-01-08",
          1,
          1,
          "PLN",
          424.45,
          75.56,
          "manual:confirmed_expense:expense:2026-01-08",
          "2026-01-08T04:00:00Z",
          "2026-01-08T04:00:00Z"
        ]);
        return { rowCount: 1, rows: [] };
      }
      return undefined;
    }
  });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  assert.deepEqual(
    await store.insertConfirmedTransactions("household", [{
      amount: 75.555,
      buffered_fx_rate: 1,
      confirmed_date: "2026-01-08",
      created_at: "2026-01-08T04:00:00Z",
      currency: "PLN",
      date: "2026-01-08",
      fx_rate: 1,
      id: "confirmed_expense",
      ledger_amount: 75.555,
      ledger_currency: "PLN",
      ledger_year: 2026,
      name: "Confirmed expense",
      occurrence_key: "manual:confirmed_expense:expense:2026-01-08",
      running_balance_pln: 424.445,
      type: "expense",
      updated_at: "2026-01-08T04:00:00Z"
    }]),
    { inserted: 1 }
  );
  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "COMMIT"
      ? entry.sql
      : String(entry.sql).includes("INSERT INTO confirmed_transactions") ? "INSERT" : "OTHER"
    ),
    ["BEGIN", "INSERT", "COMMIT"]
  );

  await store.close();
});

test("Postgres budget store facade rolls back failed confirmed ledger inserts", async () => {
  const fakePg = fakePgModule({ failOnSql: "INSERT INTO confirmed_transactions" });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  await assert.rejects(
    () => store.insertConfirmedTransactions("household", [{
      amount: 75.55,
      confirmed_date: "2026-01-08",
      created_at: "2026-01-08T04:00:00Z",
      currency: "PLN",
      date: "2026-01-08",
      id: "confirmed_expense",
      ledger_year: 2026,
      name: "Confirmed expense",
      running_balance_pln: 424.45,
      type: "expense",
      updated_at: "2026-01-08T04:00:00Z"
    }]),
    /configured query failure/
  );
  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "ROLLBACK"
      ? entry.sql
      : String(entry.sql).includes("INSERT INTO confirmed_transactions") ? "INSERT" : "OTHER"
    ),
    ["BEGIN", "INSERT", "ROLLBACK"]
  );

  await store.close();
});

test("Postgres budget store facade updates and deletes confirmed ledger rows transactionally", async () => {
  const fakePg = fakePgModule({
    queryHandler: async (sql, params) => {
      if (String(sql).includes("UPDATE confirmed_transactions")) {
        assert.deepEqual(params, [
          "household",
          2026,
          "confirmed_expense",
          80,
          "Updated expense"
        ]);
        return { rowCount: 1, rows: [] };
      }
      if (String(sql).includes("DELETE FROM confirmed_transactions")) {
        assert.deepEqual(params, ["household", 2026, ["confirmed_expense"]]);
        return { rowCount: 1, rows: [] };
      }
      return undefined;
    }
  });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  assert.deepEqual(
    await store.updateConfirmedTransactionsById("household", 2026, [{
      amount: 80.004,
      id: "confirmed_expense",
      name: "Updated expense"
    }]),
    { updated: 1 }
  );
  assert.deepEqual(
    await store.deleteConfirmedTransactionsById("household", 2026, ["confirmed_expense"]),
    { deleted: 1 }
  );
  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "COMMIT"
      ? entry.sql
      : String(entry.sql).includes("UPDATE confirmed_transactions") ? "UPDATE"
        : String(entry.sql).includes("DELETE FROM confirmed_transactions") ? "DELETE"
          : "OTHER"
    ),
    ["BEGIN", "UPDATE", "COMMIT", "BEGIN", "DELETE", "COMMIT"]
  );

  await store.close();
});

test("Postgres budget store facade rolls back failed confirmed-ledger balance updates", async () => {
  const fakePg = fakePgModule({ failOnSql: "UPDATE confirmed_transactions" });
  const store = await createPostgresBudgetStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  await assert.rejects(
    () => store.updateConfirmedLedgerBalances("household", [{
      id: "confirmed_income",
      ledgerAmount: 500,
      ledgerYear: 2026,
      runningBalance: 123
    }]),
    /configured query failure/
  );
  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "ROLLBACK"
      ? entry.sql
      : String(entry.sql).includes("UPDATE confirmed_transactions") ? "UPDATE" : "OTHER"
    ),
    ["BEGIN", "UPDATE", "ROLLBACK"]
  );

  await store.close();
});

test("budget store export produces a Postgres-shaped artifact from the facade", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const store = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true, readonly: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true, readonly: true }
      )
    });

    const exported = await createBudgetStoreExport({
      budgetIds: ["household"],
      budgetStore: store,
      now: new Date("2026-01-03T04:05:06Z")
    });
    assert.equal(exported.format, SQLITE_BUDGET_STORAGE_EXPORT_FORMAT);
    assert.equal(exported.sourceBackend, "sqlite");
    assert.equal(exported.targetBackend, "postgres");
    assert.equal(exported.exportedAt, "2026-01-03T04:05:06.000Z");
    assert.equal(exported.rowCounts.settings, 1);
    assert.equal(exported.rowCounts.one_off_transactions, 1);
    assert.equal(exported.rowCounts.confirmed_transactions, 1);
    assert.deepEqual(exported.budgetSources[0].ledgerYears, [2026]);
    assert.equal(exported.tables.one_off_transactions[0].budget_id, "household");
    assert.equal(exported.tables.confirmed_transactions[0].ledger_year, 2026);

    const normalized = normalizeSqliteBudgetStorageExport(exported);
    assert.equal(normalized.rowCounts.confirmed_transactions, 1);
  });
});

test("budget store snapshot restores by replacing every planning table and relevant ledger year", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const sourceStore = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true, readonly: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true, readonly: true }
      )
    });
    const snapshot = await createBudgetStoreSnapshot({
      budgetIds: ["household"],
      budgetStore: sourceStore,
      now: new Date("2026-01-03T04:05:06Z"),
      reason: "test"
    });

    assert.equal(snapshot.format, BUDGET_STORE_SNAPSHOT_FORMAT);
    assert.equal(snapshot.containsSensitiveData, true);
    assert.equal(snapshot.createdAt, "2026-01-03T04:05:06.000Z");
    assert.deepEqual(snapshot.budgetIds, ["household"]);

    const calls = [];
    const writer = {
      async listLedgerYears(budgetId) {
        assert.equal(budgetId, "household");
        return [2025, 2026];
      },
      async replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows) {
        calls.push({
          budgetId,
          ledgerYear,
          rows: rows.length,
          tableName: "confirmed_transactions",
          type: "ledger"
        });
        return { inserted: rows.length, ledgerYear, replaced: true };
      },
      async replacePlanningRows(budgetId, tableName, rows) {
        calls.push({
          budgetId,
          ledgerYear: null,
          rows: rows.length,
          tableName,
          type: "planning"
        });
        return { inserted: rows.length, replaced: true };
      }
    };
    const batchSummaries = [];
    const result = await restoreBudgetStoreSnapshot({
      budgetStore: writer,
      onBatch: summary => batchSummaries.push(summary),
      snapshot
    });

    assert.equal(result.ok, true);
    assert.equal(result.budgetCount, 1);
    assert.equal(result.budgetIds[0], "household");
    assert.equal(
      calls.filter(call => call.type === "planning").length,
      POSTGRES_BUDGET_PLANNING_TABLES.length
    );
    assert.equal(
      calls.some(call => call.tableName === "recurring_expenses" && call.rows === 0),
      true
    );
    assert.deepEqual(
      calls.filter(call => call.type === "ledger"),
      [
        { budgetId: "household", ledgerYear: 2025, rows: 0, tableName: "confirmed_transactions", type: "ledger" },
        { budgetId: "household", ledgerYear: 2026, rows: 1, tableName: "confirmed_transactions", type: "ledger" }
      ]
    );
    assert.deepEqual(batchSummaries, calls);
    assert.doesNotMatch(JSON.stringify(result), /Desk/);
    assert.doesNotMatch(JSON.stringify(result), /Confirmed income/);
  });
});

test("budget store snapshot restore uses store transactions when available", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const sourceStore = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true, readonly: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true, readonly: true }
      )
    });
    const snapshot = await createBudgetStoreSnapshot({
      budgetIds: ["household"],
      budgetStore: sourceStore,
      now: new Date("2026-01-03T04:05:06Z"),
      reason: "transaction-test"
    });
    const calls = [];
    const repo = {
      async listLedgerYears(budgetId) {
        calls.push(["repo-years", budgetId]);
        return [2025, 2026];
      },
      async replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows) {
        calls.push(["repo-ledger", budgetId, ledgerYear, rows.length]);
        return { inserted: rows.length, ledgerYear, replaced: true };
      },
      async replacePlanningRows(budgetId, tableName, rows) {
        calls.push(["repo-planning", budgetId, tableName, rows.length]);
        return { inserted: rows.length, replaced: true };
      }
    };
    const writer = {
      async replaceConfirmedTransactionsForYear() {
        throw new Error("outer ledger writer should not be used inside transaction");
      },
      async replacePlanningRows() {
        throw new Error("outer planning writer should not be used inside transaction");
      },
      async transaction(fn) {
        calls.push(["begin"]);
        try {
          const result = await fn(repo);
          calls.push(["commit"]);
          return result;
        } catch (error) {
          calls.push(["rollback"]);
          throw error;
        }
      }
    };

    const result = await restoreBudgetStoreSnapshot({
      budgetStore: writer,
      snapshot
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls[0], ["begin"]);
    assert.equal(
      calls.filter(call => call[0] === "repo-planning").length,
      POSTGRES_BUDGET_PLANNING_TABLES.length
    );
    assert.deepEqual(calls.filter(call => call[0] === "repo-ledger"), [
      ["repo-ledger", "household", 2025, 0],
      ["repo-ledger", "household", 2026, 1]
    ]);
    assert.deepEqual(calls.at(-1), ["commit"]);
  });
});

test("budget store snapshot restore rolls back store transactions on failure", async () => {
  const snapshot = {
    budgetCount: 1,
    budgetIds: ["household"],
    containsSensitiveData: true,
    createdAt: "2026-01-03T04:05:06.000Z",
    format: BUDGET_STORE_SNAPSHOT_FORMAT,
    payload: {
      containsSensitiveData: true,
      exportedAt: "2026-01-03T04:05:06.000Z",
      format: SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
      sourceBackend: "sqlite",
      tables: {
        confirmed_transactions: [],
        settings: [{ budget_id: "household", id: 1 }]
      },
      targetBackend: "postgres",
      version: SQLITE_BUDGET_STORAGE_EXPORT_VERSION
    },
    reason: "rollback-test",
    version: BUDGET_STORE_SNAPSHOT_VERSION
  };
  const calls = [];
  const writer = {
    async replaceConfirmedTransactionsForYear() {
      throw new Error("outer ledger writer should not be used inside transaction");
    },
    async replacePlanningRows() {
      throw new Error("outer planning writer should not be used inside transaction");
    },
    async transaction(fn) {
      calls.push("begin");
      try {
        const result = await fn({
          async replaceConfirmedTransactionsForYear() {
            throw new Error("repo ledger writer should not be used");
          },
          async replacePlanningRows(_budgetId, tableName) {
            calls.push(tableName);
            throw new Error("configured snapshot failure");
          }
        });
        calls.push("commit");
        return result;
      } catch (error) {
        calls.push("rollback");
        throw error;
      }
    }
  };

  await assert.rejects(
    () => restoreBudgetStoreSnapshot({
      budgetStore: writer,
      snapshot
    }),
    /configured snapshot failure/
  );
  assert.deepEqual(calls, ["begin", "settings", "rollback"]);
});

test("combined storage snapshot restores global metadata before budget rows without leaking values", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const globalStore = createSqliteGlobalStore({
      dataDir,
      listCashflowUserIds: () => ["household"]
    });
    const budgetStore = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true, readonly: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true, readonly: true }
      )
    });
    const snapshot = await createCashflowStorageSnapshot({
      budgetIds: ["household"],
      budgetStore,
      globalStore,
      now: new Date("2026-01-03T04:05:06Z"),
      reason: "combined-test"
    });

    assert.equal(snapshot.format, CASHFLOW_STORAGE_SNAPSHOT_FORMAT);
    assert.equal(snapshot.containsSensitiveData, true);
    assert.deepEqual(snapshot.budgetIds, ["household"]);
    assert.equal(snapshot.global.rowCounts.auth_sessions, 1);
    assert.equal(snapshot.budget.budgetCount, 1);

    const calls = [];
    const targetGlobalStore = {
      async replaceAllRows(tables) {
        calls.push({
          rows: Object.values(tables).reduce((sum, rows) => sum + rows.length, 0),
          scope: "global",
          tableName: "all",
          type: "replace"
        });
        return {
          inserted: Object.fromEntries(
            POSTGRES_GLOBAL_TABLES.map(tableName => [
              tableName,
              (tables[tableName] || []).length
            ])
          ),
          replaced: true
        };
      }
    };
    const targetBudgetStore = {
      async listLedgerYears(budgetId) {
        assert.equal(budgetId, "household");
        return [2025, 2026];
      },
      async replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows) {
        calls.push({
          budgetId,
          ledgerYear,
          rows: rows.length,
          scope: "budget",
          tableName: "confirmed_transactions",
          type: "ledger"
        });
        return {
          inserted: rows.length,
          ledgerYear,
          replaced: true
        };
      },
      async replacePlanningRows(budgetId, tableName, rows) {
        calls.push({
          budgetId,
          ledgerYear: null,
          rows: rows.length,
          scope: "budget",
          tableName,
          type: "planning"
        });
        return {
          inserted: rows.length,
          replaced: true
        };
      }
    };
    const batches = [];
    const result = await restoreCashflowStorageSnapshot({
      budgetStore: targetBudgetStore,
      globalStore: targetGlobalStore,
      onBatch: summary => batches.push(summary),
      snapshot
    });

    assert.equal(result.ok, true);
    assert.equal(result.global.rowCounts.auth_sessions, 1);
    assert.equal(result.budget.writeBatchCount, POSTGRES_BUDGET_PLANNING_TABLES.length + 2);
    assert.equal(calls[0].scope, "global");
    assert.equal(calls.some(call => call.scope === "budget" && call.tableName === "settings"), true);
    assert.equal(batches.some(batch => batch.scope === "global"), true);
    assert.equal(batches.some(batch => batch.scope === "budget"), true);
    assert.doesNotMatch(JSON.stringify(result), /secret-token-hash/);
    assert.doesNotMatch(JSON.stringify(result), /alice@example.com/);
    assert.doesNotMatch(JSON.stringify(result), /Confirmed income/);
  });
});

test("budget store import plan groups normalized export rows into deterministic backend batches", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const store = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true, readonly: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true, readonly: true }
      )
    });

    const exported = await createBudgetStoreExport({
      budgetIds: ["household"],
      budgetStore: store,
      now: new Date("2026-01-03T04:05:06Z")
    });
    const plan = createBudgetStoreImportPlan(exported);

    assert.equal(plan.format, SQLITE_BUDGET_STORAGE_EXPORT_FORMAT);
    assert.equal(plan.budgetCount, 1);
    assert.deepEqual(plan.budgetIds, ["household"]);
    assert.equal(plan.rowCounts.one_off_transactions, 1);
    assert.equal(plan.rowCounts.pending_transactions, 1);
    assert.equal(plan.rowCounts.confirmed_transactions, 1);
    assert.deepEqual(
      plan.writeBatches.map(batch => ({
        budgetId: batch.budgetId,
        ledgerYear: batch.ledgerYear || null,
        rows: batch.rows.length,
        tableName: batch.tableName,
        type: batch.type
      })),
      [
        { budgetId: "household", ledgerYear: null, rows: 1, tableName: "settings", type: "planning" },
        { budgetId: "household", ledgerYear: null, rows: 1, tableName: "one_off_transactions", type: "planning" },
        { budgetId: "household", ledgerYear: null, rows: 1, tableName: "pending_transactions", type: "planning" },
        { budgetId: "household", ledgerYear: 2026, rows: 1, tableName: "confirmed_transactions", type: "ledger" }
      ]
    );
    assert.equal(plan.budgetPlans[0].planningTables.one_off_transactions[0].id, "oneoff_desk");
    assert.equal(plan.budgetPlans[0].confirmedLedgers["2026"][0].id, "confirmed_income");

    assert.throws(
      () => createBudgetStoreImportPlan({
        ...exported,
        tables: {
          ...exported.tables,
          extra_table: []
        }
      }),
      /Invalid budget storage export/
    );
  });
});

test("budget store import plan can be applied through a backend-neutral writer", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const sourceStore = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true, readonly: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true, readonly: true }
      )
    });
    const exported = await createBudgetStoreExport({
      budgetIds: ["household"],
      budgetStore: sourceStore,
      now: new Date("2026-01-03T04:05:06Z")
    });
    const plan = createBudgetStoreImportPlan(exported);
    const calls = [];
    const batchSummaries = [];
    const writer = {
      async insertConfirmedTransactions(budgetId, rows) {
        calls.push({
          budgetId,
          ids: rows.map(row => row.id),
          rows: rows.length,
          tableName: "confirmed_transactions",
          type: "ledger"
        });
        return { inserted: rows.length };
      },
      async insertPlanningRows(budgetId, tableName, rows) {
        calls.push({
          budgetId,
          ids: rows.map(row => row.id).filter(value => value !== undefined),
          rows: rows.length,
          tableName,
          type: "planning"
        });
        return { inserted: rows.length };
      }
    };

    const result = await applyBudgetStoreImportPlan({
      budgetStore: writer,
      onBatch: summary => batchSummaries.push(summary),
      plan
    });

    assert.equal(result.ok, true);
    assert.equal(result.budgetCount, 1);
    assert.equal(result.writeBatchCount, 4);
    assert.deepEqual(batchSummaries, [
      { budgetId: "household", ledgerYear: null, rows: 1, tableName: "settings", type: "planning" },
      { budgetId: "household", ledgerYear: null, rows: 1, tableName: "one_off_transactions", type: "planning" },
      { budgetId: "household", ledgerYear: null, rows: 1, tableName: "pending_transactions", type: "planning" },
      { budgetId: "household", ledgerYear: 2026, rows: 1, tableName: "confirmed_transactions", type: "ledger" }
    ]);
    assert.deepEqual(
      calls.map(call => ({
        budgetId: call.budgetId,
        rows: call.rows,
        tableName: call.tableName,
        type: call.type
      })),
      batchSummaries.map(({ ledgerYear, ...summary }) => summary)
    );

    const json = JSON.stringify(result);
    assert.doesNotMatch(json, /Desk/);
    assert.doesNotMatch(json, /Pending income/);
    assert.doesNotMatch(json, /Confirmed income/);
  });
});

test("budget store import plan uses a store transaction when available", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const sourceStore = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true, readonly: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true, readonly: true }
      )
    });
    const exported = await createBudgetStoreExport({
      budgetIds: ["household"],
      budgetStore: sourceStore,
      now: new Date("2026-01-03T04:05:06Z")
    });
    const plan = createBudgetStoreImportPlan(exported);
    const calls = [];
    const repo = {
      async insertConfirmedTransactions(budgetId, rows) {
        calls.push(["repo-ledger", budgetId, rows.length]);
        return { inserted: rows.length };
      },
      async insertPlanningRows(budgetId, tableName, rows) {
        calls.push(["repo-planning", budgetId, tableName, rows.length]);
        return { inserted: rows.length };
      }
    };
    const writer = {
      async insertConfirmedTransactions() {
        throw new Error("outer ledger writer should not be used inside transaction");
      },
      async insertPlanningRows() {
        throw new Error("outer planning writer should not be used inside transaction");
      },
      async transaction(fn) {
        calls.push(["begin"]);
        try {
          const result = await fn(repo);
          calls.push(["commit"]);
          return result;
        } catch (error) {
          calls.push(["rollback"]);
          throw error;
        }
      }
    };

    const result = await applyBudgetStoreImportPlan({
      budgetStore: writer,
      plan
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      ["begin"],
      ["repo-planning", "household", "settings", 1],
      ["repo-planning", "household", "one_off_transactions", 1],
      ["repo-planning", "household", "pending_transactions", 1],
      ["repo-ledger", "household", 1],
      ["commit"]
    ]);
  });
});

test("budget store import plan rolls back the store transaction on batch failure", async () => {
  const plan = {
    budgetCount: 1,
    budgetIds: ["household"],
    rowCounts: {},
    writeBatches: [{
      budgetId: "household",
      rows: [{ budget_id: "household", id: "oneoff_bad" }],
      tableName: "one_off_transactions",
      type: "planning"
    }]
  };
  const calls = [];
  const writer = {
    async insertConfirmedTransactions() {
      throw new Error("outer ledger writer should not be used inside transaction");
    },
    async insertPlanningRows() {
      throw new Error("outer planning writer should not be used inside transaction");
    },
    async transaction(fn) {
      calls.push("begin");
      try {
        const result = await fn({
          async insertConfirmedTransactions() {
            throw new Error("repo ledger writer should not be used");
          },
          async insertPlanningRows() {
            calls.push("repo-planning");
            throw new Error("configured batch failure");
          }
        });
        calls.push("commit");
        return result;
      } catch (error) {
        calls.push("rollback");
        throw error;
      }
    }
  };

  await assert.rejects(
    () => applyBudgetStoreImportPlan({
      budgetStore: writer,
      plan
    }),
    /configured batch failure/
  );
  assert.deepEqual(calls, ["begin", "repo-planning", "rollback"]);
});

test("budget store import plan replace mode uses backend-neutral replacement writers", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const sourceStore = createSqliteBudgetStore({
      listLedgerYears: () => [2026],
      openLedgerDb: (budgetId, year) => new Database(
        path.join(dataDir, budgetId, `ledger_${year}.sqlite`),
        { fileMustExist: true, readonly: true }
      ),
      openPlanningDb: budgetId => new Database(
        path.join(dataDir, budgetId, "planning.sqlite"),
        { fileMustExist: true, readonly: true }
      )
    });
    const exported = await createBudgetStoreExport({
      budgetIds: ["household"],
      budgetStore: sourceStore,
      now: new Date("2026-01-03T04:05:06Z")
    });
    const plan = createBudgetStoreImportPlan(exported);
    const calls = [];
    const writer = {
      async insertConfirmedTransactions() {
        throw new Error("append ledger writer should not be used in replace mode");
      },
      async insertPlanningRows() {
        throw new Error("append planning writer should not be used in replace mode");
      },
      async replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows) {
        calls.push({
          budgetId,
          ledgerYear,
          rows: rows.length,
          tableName: "confirmed_transactions",
          type: "ledger"
        });
        return { inserted: rows.length, ledgerYear, replaced: true };
      },
      async replacePlanningRows(budgetId, tableName, rows) {
        calls.push({
          budgetId,
          ledgerYear: null,
          rows: rows.length,
          tableName,
          type: "planning"
        });
        return { inserted: rows.length, replaced: true };
      }
    };

    const result = await applyBudgetStoreImportPlan({
      budgetStore: writer,
      mode: "replace",
      plan
    });

    assert.equal(result.mode, "replace");
    assert.deepEqual(calls, [
      { budgetId: "household", ledgerYear: null, rows: 1, tableName: "settings", type: "planning" },
      { budgetId: "household", ledgerYear: null, rows: 1, tableName: "one_off_transactions", type: "planning" },
      { budgetId: "household", ledgerYear: null, rows: 1, tableName: "pending_transactions", type: "planning" },
      { budgetId: "household", ledgerYear: 2026, rows: 1, tableName: "confirmed_transactions", type: "ledger" }
    ]);
    assert.equal(result.appliedBatches.every(batch => batch.mode === "replace"), true);
  });
});

test("Postgres schema print command emits global and budget DDL without connecting to a database", async () => {
  await withTempDirs(async ({ outputDir }) => {
    const allSql = postgresSchemaSql({ section: "all" });
    assert.match(allSql, /-- Cashflow global metadata schema/);
    assert.match(allSql, /-- Cashflow budget planning and ledger schema/);
    assert.match(allSql, /cashflow_global_schema_version/);
    assert.match(allSql, /cashflow_budget_schema_version/);

    const budgetOnly = postgresSchemaSql({ section: "budget" });
    assert.doesNotMatch(budgetOnly, /cashflow_global_schema_version/);
    assert.match(budgetOnly, /cashflow_budget_schema_version/);

    const outputPath = path.join(outputDir, "cashflow-postgres-schema.sql");
    const result = printPostgresSchemaCli({
      section: "global",
      output: outputPath
    });

    assert.equal(result.ok, true);
    assert.equal(result.section, "global");
    assert.equal(fs.existsSync(outputPath), true);
    const written = fs.readFileSync(outputPath, "utf8");
    assert.match(written, /cashflow_global_schema_version/);
    assert.doesNotMatch(written, /cashflow_budget_schema_version/);
  });
});

test("SQLite budget storage export flattens planning and yearly ledger rows for migration", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const result = await createSqliteBudgetStorageExport({
      dataDir,
      outputDir,
      now: new Date("2026-01-03T04:05:06Z")
    });

    assert.equal(result.ok, true);
    assert.equal(result.format, SQLITE_BUDGET_STORAGE_EXPORT_FORMAT);
    assert.equal(result.containsSensitiveData, true);
    assert.equal(result.budgetCount, 1);
    assert.equal(result.targetBackend, "postgres");
    assert.equal(result.rowCounts.settings, 1);
    assert.equal(result.rowCounts.one_off_transactions, 1);
    assert.equal(result.rowCounts.pending_transactions, 1);
    assert.equal(result.rowCounts.confirmed_transactions, 1);
    assert.equal(fs.existsSync(result.exportPath), true);
    assert.equal(fs.existsSync(`${result.exportPath}.tmp`), false);

    const summaryJson = JSON.stringify(result);
    assert.doesNotMatch(summaryJson, /Desk/);
    assert.doesNotMatch(summaryJson, /Confirmed income/);

    const exported = JSON.parse(fs.readFileSync(result.exportPath, "utf8"));
    assert.equal(exported.format, SQLITE_BUDGET_STORAGE_EXPORT_FORMAT);
    assert.equal(exported.sourcePlanningSchemaVersion, PLANNING_SCHEMA_VERSION);
    assert.equal(exported.sourceLedgerSchemaVersion, LEDGER_SCHEMA_VERSION);
    assert.equal(exported.targetPlanningSchemaVersion, POSTGRES_PLANNING_SCHEMA_VERSION);
    assert.equal(exported.targetLedgerSchemaVersion, POSTGRES_LEDGER_SCHEMA_VERSION);
    assert.equal(exported.budgetSources[0].budgetId, "household");
    assert.equal(exported.budgetSources[0].storageKey, "household");
    assert.equal(exported.budgetSources[0].planningSchemaVersion, PLANNING_SCHEMA_VERSION);
    assert.deepEqual(exported.budgetSources[0].ledgerSchemaVersions, [
      { year: 2026, version: LEDGER_SCHEMA_VERSION }
    ]);
    assert.equal(exported.tables.one_off_transactions[0].budget_id, "household");
    assert.equal(exported.tables.one_off_transactions[0].name, "Desk");
    assert.equal(exported.tables.confirmed_transactions[0].budget_id, "household");
    assert.equal(exported.tables.confirmed_transactions[0].ledger_year, 2026);
    assert.equal(exported.tables.confirmed_transactions[0].name, "Confirmed income");
  });
});

test("SQLite budget storage export rejects unsafe output locations and missing budgets", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    await assert.rejects(
      () => createSqliteBudgetStorageExport({
        dataDir,
        outputDir: path.join(dataDir, "external-exports")
      }),
      /must not be inside DATA_DIR/
    );

    await assert.rejects(
      () => createSqliteBudgetStorageExport({
        budgetId: "missing",
        dataDir,
        outputDir
      }),
      /Budget not found/
    );
  });
});

test("Postgres budget storage import validates exports and applies rows transactionally", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);
    const exportedSummary = await createSqliteBudgetStorageExport({ dataDir, outputDir });
    const payload = JSON.parse(fs.readFileSync(exportedSummary.exportPath, "utf8"));

    const cliDryRun = await importBudgetStorageCli({
      dryRun: true,
      input: exportedSummary.exportPath
    });
    assert.equal(cliDryRun.ok, true);
    assert.equal(cliDryRun.writeBatchCount, 4);
    assert.deepEqual(cliDryRun.budgetIds, ["household"]);
    assert.deepEqual(cliDryRun.writeBatches.map(batch => ({
      ledgerYear: batch.ledgerYear,
      rows: batch.rows,
      tableName: batch.tableName,
      type: batch.type
    })), [
      { ledgerYear: null, rows: 1, tableName: "settings", type: "planning" },
      { ledgerYear: null, rows: 1, tableName: "one_off_transactions", type: "planning" },
      { ledgerYear: null, rows: 1, tableName: "pending_transactions", type: "planning" },
      { ledgerYear: 2026, rows: 1, tableName: "confirmed_transactions", type: "ledger" }
    ]);
    assert.doesNotMatch(JSON.stringify(cliDryRun), /Desk|Confirmed income/);

    const dryRun = await importSqliteBudgetStorageToPostgres({
      dryRun: true,
      payload
    });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.rowCounts.settings, 1);
    assert.equal(dryRun.rowCounts.confirmed_transactions, 1);

    const queries = [];
    const client = {
      async query(sql, params = []) {
        queries.push({ sql, params });
        return { rows: [] };
      }
    };

    const applied = await importSqliteBudgetStorageToPostgres({
      client,
      dryRun: false,
      payload
    });

    assert.equal(applied.ok, true);
    assert.equal(applied.dryRun, false);
    assert.equal(queries[0].sql, "BEGIN");
    assert.match(queries[1].sql, /CREATE TABLE IF NOT EXISTS settings/);
    assert.equal(queries.at(-1).sql, "COMMIT");
    assert.equal(applied.inserted.settings, 1);
    assert.equal(applied.inserted.confirmed_transactions, 1);

    const settingsInsert = queries.find(entry => String(entry.sql).includes('INSERT INTO "settings"'));
    assert.ok(settingsInsert);
    assert.ok(settingsInsert.params.includes("household"));
    assert.ok(settingsInsert.params.includes(false));
    assert.ok(settingsInsert.params.includes(true));

    const confirmedInsert = queries.find(entry => String(entry.sql).includes('INSERT INTO "confirmed_transactions"'));
    assert.ok(confirmedInsert);
    assert.ok(confirmedInsert.params.includes(2026));
  });
});

test("Postgres budget storage import rolls back apply failures", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);
    const exportedSummary = await createSqliteBudgetStorageExport({ dataDir, outputDir });
    const payload = JSON.parse(fs.readFileSync(exportedSummary.exportPath, "utf8"));
    const queries = [];
    const client = {
      async query(sql, params = []) {
        queries.push({ sql, params });
        if (String(sql).includes('INSERT INTO "pending_transactions"')) {
          throw new Error("pending import failed");
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () => importSqliteBudgetStorageToPostgres({
        client,
        dryRun: false,
        payload
      }),
      /pending import failed/
    );
    assert.equal(queries[0].sql, "BEGIN");
    assert.equal(queries.at(-1).sql, "ROLLBACK");
  });
});

test("Postgres budget storage import rejects malformed export shapes", () => {
  function rejectsWithReason(payload, reason) {
    assert.throws(
      () => normalizeSqliteBudgetStorageExport(payload),
      error => {
        assert.equal(error.status, 400);
        assert.match(JSON.stringify(error.details || []), new RegExp(reason));
        return true;
      }
    );
  }

  assert.throws(
    () => normalizeSqliteBudgetStorageExport({
      format: "wrong",
      version: 1,
      tables: {}
    }),
    /Unsupported budget storage export format/
  );

  rejectsWithReason({
    format: SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
    version: 1,
    tables: {
      extra_table: []
    }
  }, "unknown_table");

  rejectsWithReason({
    format: SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
    version: 1,
    tables: {
      settings: [{ id: 1, budget_id: "household", unexpected: true }]
    }
  }, "unknown_column");

  rejectsWithReason({
    format: SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
    version: 1,
    tables: {
      settings: [{ id: 1, budget_id: "household", setup_completed: "yes" }]
    }
  }, "must be boolean-compatible");

  rejectsWithReason({
    format: SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
    version: 1,
    tables: {
      one_off_transactions: [
        { budget_id: "household", id: "same" },
        { budget_id: "household", id: "same" }
      ]
    }
  }, "duplicate_key");
});

test("combined SQLite to Postgres migration dry-run validates global and budget artifacts", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    const result = await migrateSqliteToPostgres({
      dataDir,
      dryRun: true,
      outputDir
    });

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.applied, false);
    assert.equal(result.global.rowCounts.accounts, 2);
    assert.equal(result.budget.rowCounts.confirmed_transactions, 1);
    assert.equal(fs.existsSync(result.artifacts.globalExportPath), true);
    assert.equal(fs.existsSync(result.artifacts.budgetExportPath), true);

    const summaryJson = JSON.stringify(result);
    assert.doesNotMatch(summaryJson, /secret-token-hash/);
    assert.doesNotMatch(summaryJson, /Desk/);
    assert.doesNotMatch(summaryJson, /Confirmed income/);
  });
});

test("combined SQLite to Postgres migration apply requires a stopped-app snapshot source", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    await assert.rejects(
      () => migrateSqliteToPostgres({
        databaseUrl: "postgres://example.invalid/cashflow",
        dataDir,
        dryRun: false,
        outputDir,
        pgModule: fakePgModule().module
      }),
      /requires --source-is-snapshot/
    );
  });
});

test("combined SQLite to Postgres migration apply uses one outer transaction", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);
    const fakePg = fakePgModule();

    const result = await migrateSqliteToPostgres({
      databaseUrl: "postgres://example.invalid/cashflow",
      dataDir,
      dryRun: false,
      outputDir,
      pgModule: fakePg.module,
      sourceIsSnapshot: true
    });

    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.inserted.global.accounts, 2);
    assert.equal(result.inserted.budget.confirmed_transactions, 1);
    assert.equal(fakePg.queries[0].sql, "BEGIN");
    assert.equal(fakePg.queries.at(-1).sql, "COMMIT");
    assert.equal(fakePg.queries.filter(entry => entry.sql === "BEGIN").length, 1);
    assert.equal(fakePg.queries.filter(entry => entry.sql === "COMMIT").length, 1);
    assert.equal(fakePg.queries.filter(entry => entry.sql === "ROLLBACK").length, 0);
  });
});

test("combined SQLite to Postgres migration apply rolls back as one unit", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);
    const fakePg = fakePgModule({ failOnSql: 'INSERT INTO "pending_transactions"' });

    await assert.rejects(
      () => migrateSqliteToPostgres({
        databaseUrl: "postgres://example.invalid/cashflow",
        dataDir,
        dryRun: false,
        outputDir,
        pgModule: fakePg.module,
        sourceIsSnapshot: true
      }),
      /configured query failure/
    );
    assert.equal(fakePg.queries[0].sql, "BEGIN");
    assert.equal(fakePg.queries.at(-1).sql, "ROLLBACK");
    assert.equal(fakePg.queries.filter(entry => entry.sql === "BEGIN").length, 1);
    assert.equal(fakePg.queries.filter(entry => entry.sql === "ROLLBACK").length, 1);
  });
});

test("Postgres migration verification compares schema and row counts without exposing values", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);
    const globalSummary = createSqliteGlobalMetadataExport({ dataDir, outputDir });
    const budgetSummary = await createSqliteBudgetStorageExport({ dataDir, outputDir });
    const globalPayload = JSON.parse(fs.readFileSync(globalSummary.exportPath, "utf8"));
    const budgetPayload = JSON.parse(fs.readFileSync(budgetSummary.exportPath, "utf8"));
    const globalExport = normalizeSqliteGlobalMetadataExport(globalPayload);
    const budgetExport = normalizeSqliteBudgetStorageExport(budgetPayload);
    const budgetIds = budgetExport.budgetSources.map(source => source.budgetId).sort();

    const fakePg = fakePgModule({
      queryHandler: async (sql, params) => {
        const table = String(sql).match(/FROM "([^"]+)"/)?.[1];
        if (!table) return undefined;
        if (POSTGRES_GLOBAL_TABLES.includes(table)) {
          return { rows: [{ count: String(globalExport.rowCounts[table]) }] };
        }
        if (POSTGRES_BUDGET_TABLES.includes(table)) {
          assert.deepEqual(params, [budgetIds]);
          return { rows: [{ count: String(budgetExport.rowCounts[table]) }] };
        }
        return undefined;
      }
    });

    const result = await verifyPostgresMigration({
      budgetExportPath: budgetSummary.exportPath,
      databaseUrl: "postgres://example.invalid/cashflow",
      globalExportPath: globalSummary.exportPath,
      pgModule: fakePg.module
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.mismatches, []);
    assert.equal(result.global.rowCounts.accounts, globalExport.rowCounts.accounts);
    assert.equal(result.budget.rowCounts.confirmed_transactions, 1);
    const summaryJson = JSON.stringify(result);
    assert.doesNotMatch(summaryJson, /alice@example.com/);
    assert.doesNotMatch(summaryJson, /secret-token-hash/);
    assert.doesNotMatch(summaryJson, /Desk/);
    assert.doesNotMatch(summaryJson, /Confirmed income/);
  });
});

test("Postgres migration verification reports row-count mismatches", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);
    const globalSummary = createSqliteGlobalMetadataExport({ dataDir, outputDir });
    const budgetSummary = await createSqliteBudgetStorageExport({ dataDir, outputDir });
    const globalPayload = JSON.parse(fs.readFileSync(globalSummary.exportPath, "utf8"));
    const budgetPayload = JSON.parse(fs.readFileSync(budgetSummary.exportPath, "utf8"));
    const globalExport = normalizeSqliteGlobalMetadataExport(globalPayload);
    const budgetExport = normalizeSqliteBudgetStorageExport(budgetPayload);

    const fakePg = fakePgModule({
      queryHandler: async (sql) => {
        const table = String(sql).match(/FROM "([^"]+)"/)?.[1];
        if (!table) return undefined;
        if (POSTGRES_GLOBAL_TABLES.includes(table)) {
          return {
            rows: [{
              count: String(globalExport.rowCounts[table] + (table === "accounts" ? 1 : 0))
            }]
          };
        }
        if (POSTGRES_BUDGET_TABLES.includes(table)) {
          return { rows: [{ count: String(budgetExport.rowCounts[table]) }] };
        }
        return undefined;
      }
    });

    const result = await verifyPostgresMigration({
      budgetExportPath: budgetSummary.exportPath,
      databaseUrl: "postgres://example.invalid/cashflow",
      globalExportPath: globalSummary.exportPath,
      pgModule: fakePg.module
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, [{
      actual: globalExport.rowCounts.accounts + 1,
      expected: globalExport.rowCounts.accounts,
      scope: "global",
      table: "accounts"
    }]);
  });
});

test("Postgres lock service acquires, renews, releases, and skips unavailable locks", async () => {
  const queries = [];
  const responses = [
    { rows: [{ name: "background:daily", owner_id: "worker_a", expires_at: "2026-01-03T04:02:00.000Z" }] },
    { rows: [{ name: "background:daily", owner_id: "worker_a", expires_at: "2026-01-03T04:02:00.000Z" }] },
    { rowCount: 1 },
    { rows: [] }
  ];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return responses.shift() || { rows: [] };
    }
  };
  const service = createPostgresLockService({
    client,
    defaultTtlMs: 120000,
    now: () => new Date("2026-01-03T04:00:00Z"),
    ownerId: "worker_a"
  });

  assert.deepEqual(await service.tryAcquire("background:daily"), {
    acquired: true,
    lock: {
      name: "background:daily",
      owner_id: "worker_a",
      expires_at: "2026-01-03T04:02:00.000Z"
    }
  });
  assert.equal((await service.renew("background:daily")).renewed, true);
  assert.equal(await service.release("background:daily"), 1);
  assert.deepEqual(await service.tryAcquire("background:daily"), {
    acquired: false,
    lock: null
  });

  assert.match(queries[0].sql, /ON CONFLICT \(name\) DO UPDATE/);
  assert.match(queries[0].sql, /WHERE cashflow_runtime_locks\.expires_at <= \$3/);
  assert.deepEqual(queries[0].params, [
    "background:daily",
    "worker_a",
    "2026-01-03T04:00:00.000Z",
    "2026-01-03T04:02:00.000Z"
  ]);
});

test("Postgres lock service withLock releases after success and failure", async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (String(sql).includes("INSERT INTO cashflow_runtime_locks")) {
        return { rows: [{ name: params[0], owner_id: params[1], expires_at: params[3] }] };
      }
      if (String(sql).includes("DELETE FROM cashflow_runtime_locks")) {
        return { rowCount: 1 };
      }
      return { rows: [] };
    }
  };
  const service = createPostgresLockService({
    client,
    now: () => new Date("2026-01-03T04:00:00Z"),
    ownerId: "worker_b"
  });

  assert.deepEqual(await service.withLock("projection:all", () => "done"), {
    acquired: true,
    result: "done"
  });

  await assert.rejects(
    () => service.withLock("projection:all", () => {
      throw new Error("work failed");
    }),
    /work failed/
  );
  assert.equal(
    queries.filter(entry => String(entry.sql).includes("DELETE FROM cashflow_runtime_locks")).length,
    2
  );

  await assert.rejects(
    () => service.tryAcquire("../bad"),
    /Lock name/
  );
});

test("SQLite global metadata export writes sensitive rows without printing values in the summary", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);

    const result = createSqliteGlobalMetadataExport({
      dataDir,
      outputDir,
      now: new Date("2026-01-03T04:05:06Z")
    });

    assert.equal(result.ok, true);
    assert.equal(result.format, "cashflow-sqlite-global-metadata-export");
    assert.equal(result.containsSensitiveData, true);
    assert.equal(result.targetBackend, "postgres");
    assert.equal(result.sourceGlobalSchemaVersion, GLOBAL_SCHEMA_VERSION);
    assert.equal(result.rowCounts.accounts, 2);
    assert.equal(result.rowCounts.auth_sessions, 1);
    assert.equal(fs.existsSync(result.exportPath), true);
    assert.equal(fs.existsSync(`${result.exportPath}.tmp`), false);

    const summaryJson = JSON.stringify(result);
    assert.doesNotMatch(summaryJson, /secret-token-hash/);
    assert.doesNotMatch(summaryJson, /secret-csrf-hash/);
    assert.doesNotMatch(summaryJson, /alice@example.com/);

    const exported = JSON.parse(fs.readFileSync(result.exportPath, "utf8"));
    assert.equal(exported.containsSensitiveData, true);
    assert.equal(exported.sourceBackend, "sqlite");
    assert.equal(exported.targetGlobalSchemaVersion, POSTGRES_GLOBAL_SCHEMA_VERSION);
    assert.equal(exported.tables.auth_sessions[0].token_hash, "secret-token-hash");
    assert.equal(exported.tables.accounts.some(row => row.email === "alice@example.com"), true);
  });
});

test("SQLite global metadata export rejects output directories inside DATA_DIR", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);

    assert.throws(
      () => createSqliteGlobalMetadataExport({
        dataDir,
        outputDir: path.join(dataDir, "external-exports")
      }),
      /must not be inside DATA_DIR/
    );
  });
});

test("Postgres global db service initializes schema transactionally and checks readiness", async () => {
  const fakePg = fakePgModule();
  const events = [];
  const service = await createPostgresGlobalDbService({
    databaseUrl: "postgres://example.invalid/cashflow",
    logServerEvent: (kind, details) => events.push({ kind, details }),
    pgModule: fakePg.module
  });

  await service.initializeGlobalSchema();
  const initQueries = fakePg.queries.map(entry => entry.sql);
  assert.equal(initQueries[0], "BEGIN");
  assert.match(initQueries[1], /CREATE TABLE IF NOT EXISTS users/);
  assert.equal(initQueries[2], "COMMIT");
  assert.equal(fakePg.releases.length, 1);
  assert.equal(events[0].kind, "cashflow_postgres_global_schema_ready");

  const ready = await service.checkReadiness();
  assert.deepEqual(ready, {
    ok: true,
    backend: "postgres",
    globalSchemaVersion: POSTGRES_GLOBAL_SCHEMA_VERSION
  });
  assert.equal(fakePg.releases.length, 2);

  await service.close();
});

test("Postgres global db service rolls back failed schema initialization", async () => {
  const fakePg = fakePgModule({ failOnSchema: true });
  const errors = [];
  const service = await createPostgresGlobalDbService({
    databaseUrl: "postgres://example.invalid/cashflow",
    logError: (kind, details) => errors.push({ kind, details }),
    pgModule: fakePg.module
  });

  await assert.rejects(
    () => service.initializeGlobalSchema(),
    /schema failed/
  );
  assert.deepEqual(fakePg.queries.map(entry => entry.sql), [
    "BEGIN",
    createPostgresGlobalSchemaSql({ includeTransaction: false }),
    "ROLLBACK"
  ]);
  assert.equal(fakePg.releases.length, 1);
  assert.equal(errors.some(entry => entry.kind === "cashflow_postgres_global_schema_failed"), true);
});

test("Postgres global db service rejects missing URLs and mismatched schema versions", async () => {
  await assert.rejects(
    () => createPostgresGlobalDbService({ pgModule: fakePgModule().module }),
    /CASHFLOW_DATABASE_URL is required/
  );

  const service = await createPostgresGlobalDbService({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePgModule({ readinessVersion: POSTGRES_GLOBAL_SCHEMA_VERSION - 1 }).module
  });

  await assert.rejects(
    () => service.checkReadiness(),
    /Postgres global schema version mismatch/
  );
});

test("Postgres global repository mirrors the SQLite repository surface", () => {
  const db = new Database(":memory:");
  try {
    initializeGlobalSchema(db);
    const sqlite = createSqliteGlobalRepository(db);
    const postgres = createPostgresGlobalRepository(fakePostgresClient());

    assert.equal(postgres.backend, "postgres");
    assert.deepEqual(repositorySurface(postgres), repositorySurface(sqlite));
  } finally {
    db.close();
  }
});

test("session service uses the global repository boundary instead of direct session SQL", () => {
  const source = fs.readFileSync(
    path.resolve("src/server/cashflow-session-service.js"),
    "utf8"
  );

  assert.doesNotMatch(source, /db\.prepare\(/);
  assert.match(source, /createGlobalRepository/);
  assert.match(source, /repo\.sessions\./);
});

test("Postgres global repository parameterizes account, user, role, session, and audit writes", async () => {
  const client = fakePostgresClient([
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rows: [{
      id: "session_1",
      auth_method: "none",
      selected_budget_id: "alice_budget",
      created_at: "2026-01-03T04:00:00Z",
      last_seen_at: "2026-01-03T04:01:00Z",
      idle_expires_at: "2026-01-03T05:00:00Z",
      absolute_expires_at: "2026-01-04T04:00:00Z"
    }] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] }
  ]);
  const repo = createPostgresGlobalRepository(client, {
    generateAuditId: () => "audit_pg_test",
    now: () => new Date("2026-01-03T04:00:00Z"),
    nowMs: () => Date.parse("2026-01-03T04:02:00Z")
  });

  await repo.users.insertNew({ id: "alice", displayName: "Alice" });
  await repo.accounts.insert({
    id: "alice",
    email: "alice@example.com",
    displayName: "Alice"
  });
  await repo.roles.insertSystemAdmin({
    accountId: "alice",
    grantedByAccountId: "legacy-admin"
  });
  await repo.users.setPermissions("alice", '["admin"]');

  const sessions = await repo.sessions.listActiveForAccount("alice");
  assert.equal(sessions.length, 1);
  assert.equal(Object.hasOwn(sessions[0], "token_hash"), false);
  assert.equal(Object.hasOwn(sessions[0], "csrf_token_hash"), false);
  assert.equal(await repo.sessions.revoke("session_1", "alice"), 1);

  await repo.audit.insertSecurityEvent({
    action: "postgres_repository_test",
    actorAccountId: "alice",
    details: { changed: true },
    targetId: "alice_budget",
    targetType: "budget"
  });

  assert.match(client.queries[0].sql, /INSERT INTO users/);
  assert.deepEqual(client.queries[0].params, [
    "alice",
    "Alice",
    "2026-01-03T04:00:00.000Z"
  ]);
  assert.match(client.queries[1].sql, /INSERT INTO accounts/);
  assert.equal(client.queries[1].params[1], "alice@example.com");
  assert.match(client.queries[2].sql, /ON CONFLICT \(account_id, role\) DO NOTHING/);
  assert.match(client.queries[4].sql, /SELECT id, auth_method, selected_budget_id/);
  assert.doesNotMatch(client.queries[4].sql, /token_hash/);
  assert.doesNotMatch(client.queries[4].sql, /csrf_token_hash/);
  assert.match(client.queries[5].sql, /UPDATE auth_sessions/);
  assert.match(client.queries[6].sql, /INSERT INTO security_audit_log/);
  assert.deepEqual(client.queries[6].params.slice(0, 6), [
    "audit_pg_test",
    "alice",
    "postgres_repository_test",
    "budget",
    "alice_budget",
    "success"
  ]);
});

test("Postgres global repository covers legacy budgets and auth metadata writes", async () => {
  const client = fakePostgresClient([
    { rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] }
  ]);
  const repo = createPostgresGlobalRepository(client, {
    now: () => new Date("2026-01-03T04:00:00Z")
  });

  await repo.budgets.ensureLegacy({
    id: "legacy_budget",
    displayName: "Legacy Budget",
    storageKey: "legacy_budget"
  });
  await repo.authConfig.updateDraft({
    draftConfigJson: { mode: "internal" },
    draftMode: "internal",
    sessionAbsoluteMinutes: 10080,
    sessionIdleMinutes: 720
  });
  await repo.authProviders.upsert({
    id: "github",
    kind: "github",
    displayName: "GitHub",
    enabled: true,
    issuer: "https://github.com",
    clientId: "client-id",
    secretRef: "env:GITHUB_SECRET",
    configJson: { redirectUri: "https://example.com/callback" }
  });
  await repo.identities.upsert({
    accountId: "alice",
    providerId: "github",
    subject: "github-subject",
    email: "alice@example.com",
    emailVerified: true,
    profileJson: { source: "test" }
  });
  await repo.passwordCredentials.upsert({
    accountId: "alice",
    passwordHash: "argon2-hash"
  });
  await repo.oauthStates.insert({
    accountId: "alice",
    codeVerifier: "code-verifier",
    expiresAt: "2026-01-03T05:00:00Z",
    id: "oauth_state_test",
    nonce: "nonce",
    providerId: "github",
    purpose: "link",
    redirectUri: "https://example.com/callback",
    stateHash: "state-hash"
  });
  await repo.passwordResetTokens.insert({
    accountId: "alice",
    expiresAt: "2026-01-03T05:00:00Z",
    id: "password_token_test",
    purpose: "password_setup",
    tokenHash: "password-token-hash"
  });
  await repo.invitations.revokePendingForTargetAccount("alice");

  assert.match(client.queries[0].sql, /SELECT id FROM accounts/);
  assert.match(client.queries[1].sql, /INSERT INTO accounts/);
  assert.match(client.queries[2].sql, /INSERT INTO account_global_roles/);
  assert.match(client.queries[3].sql, /INSERT INTO budgets/);
  assert.match(client.queries[4].sql, /INSERT INTO budget_memberships/);
  assert.match(client.queries[5].sql, /UPDATE auth_config/);
  assert.equal(client.queries[5].params[3], JSON.stringify({ mode: "internal" }));
  assert.match(client.queries[6].sql, /INSERT INTO auth_providers/);
  assert.equal(client.queries[6].params[3], true);
  assert.equal(client.queries[6].params[7], JSON.stringify({ redirectUri: "https://example.com/callback" }));
  assert.match(client.queries[7].sql, /INSERT INTO auth_identities/);
  assert.equal(client.queries[7].params[6], JSON.stringify({ source: "test" }));
  assert.match(client.queries[8].sql, /INSERT INTO password_credentials/);
  assert.match(client.queries[9].sql, /INSERT INTO auth_oauth_states/);
  assert.match(client.queries[10].sql, /INSERT INTO password_reset_tokens/);
  assert.match(client.queries[11].sql, /UPDATE budget_invitations/);
});

test("Postgres global store wraps repository access and transactions", async () => {
  const fakePg = fakePgModule({
    queryHandler: async (sql, params) => {
      if (String(sql).includes('SELECT * FROM "accounts"')) {
        assert.deepEqual(params, []);
        return {
          rows: [{ id: "alice", display_name: "Alice" }]
        };
      }
      if (String(sql).includes("INSERT INTO cashflow_runtime_locks")) {
        return { rows: [{ name: params[0], owner_id: params[1], expires_at: params[3] }] };
      }
      if (String(sql).includes("DELETE FROM cashflow_runtime_locks")) {
        return { rowCount: 1 };
      }
      return undefined;
    }
  });
  const repositoryCalls = [];
  const store = await createPostgresGlobalStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module,
    repositoryFactory(client) {
      return {
        ping: async () => {
          repositoryCalls.push(client);
          await client.query("SELECT repository_ping");
          return "pong";
        }
      };
    }
  });

  await store.initialize();
  assert.deepEqual(await store.checkReadiness(), {
    ok: true,
    backend: "postgres",
    globalSchemaVersion: POSTGRES_GLOBAL_SCHEMA_VERSION
  });
  assert.deepEqual(await store.listRows("accounts"), [{
    id: "alice",
    display_name: "Alice"
  }]);
  assert.equal(await store.withRepository(repo => repo.ping()), "pong");
  assert.equal(await store.transaction(repo => repo.ping()), "pong");
  await assert.rejects(
    () => store.transaction(async repo => {
      await repo.ping();
      throw new Error("transaction failed");
    }),
    /transaction failed/
  );
  const lockService = store.createLockService({
    now: () => new Date("2026-01-03T04:00:00Z"),
    ownerId: "store_worker"
  });
  assert.deepEqual(
    await lockService.withLock("background:tick", () => "locked", { ttlMs: 60_000 }),
    { acquired: true, result: "locked" }
  );
  await store.close();

  assert.equal(repositoryCalls.length, 3);
  assert.equal(fakePg.queries.filter(entry => entry.sql === "BEGIN").length, 3);
  assert.equal(fakePg.queries.filter(entry => entry.sql === "COMMIT").length, 2);
  assert.equal(fakePg.queries.filter(entry => entry.sql === "ROLLBACK").length, 1);
  assert.equal(fakePg.queries.some(entry => String(entry.sql).includes("INSERT INTO cashflow_runtime_locks")), true);
  assert.equal(fakePg.releases.length, 7);
});

test("SQLite global store mirrors the Postgres store surface and initializes legacy budgets", async () => {
  await withTempDirs(async ({ dataDir }) => {
    const legacyBudgetDir = path.join(dataDir, "legacy_budget");
    fs.mkdirSync(legacyBudgetDir, { recursive: true });
    fs.writeFileSync(path.join(legacyBudgetDir, "planning.sqlite"), "");

    const sqlite = createSqliteGlobalStore({
      dataDir,
      listCashflowUserIds: () => ["legacy_budget"]
    });
    const postgres = await createPostgresGlobalStore({
      databaseUrl: "postgres://example.invalid/cashflow",
      pgModule: fakePgModule().module
    });

    assert.equal(sqlite.backend, "sqlite");
    assert.deepEqual(globalStoreSurface(sqlite), globalStoreSurface(postgres));
    assert.deepEqual(sqlite.checkReadiness(), {
      ok: true,
      backend: "sqlite",
      globalSchemaVersion: GLOBAL_SCHEMA_VERSION
    });

    const budgets = sqlite.withRepository(repo => repo.budgets.listActiveStorage());
    assert.equal(budgets.some(budget => budget.id === "legacy_budget"), true);

    const lockService = sqlite.createLockService({
      now: () => new Date("2026-01-03T04:00:00Z"),
      ownerId: "sqlite_store_worker"
    });
    assert.deepEqual(
      await lockService.withLock("background:tick", () => "locked", { ttlMs: 60_000 }),
      { acquired: true, result: "locked" }
    );

    await sqlite.close();
    await postgres.close();
  });
});

test("global store export produces a Postgres-shaped artifact from the neutral store surface", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);

    const store = createSqliteGlobalStore({
      dataDir,
      listCashflowUserIds: () => ["household"]
    });
    const exported = await createGlobalStoreExport({
      globalStore: store,
      now: new Date("2026-01-03T04:05:06Z")
    });
    const normalized = normalizeSqliteGlobalMetadataExport(exported);

    assert.equal(exported.format, "cashflow-sqlite-global-metadata-export");
    assert.equal(exported.exportedAt, "2026-01-03T04:05:06.000Z");
    assert.equal(exported.sourceBackend, "sqlite");
    assert.equal(exported.targetBackend, "postgres");
    assert.equal(exported.sourceGlobalSchemaVersion, GLOBAL_SCHEMA_VERSION);
    assert.equal(exported.rowCounts.accounts, 2);
    assert.equal(exported.rowCounts.auth_sessions, 1);
    assert.equal(exported.tables.auth_sessions[0].token_hash, "secret-token-hash");
    assert.equal(normalized.rowCounts.accounts, 2);

    await assert.rejects(
      () => store.listRows("not_a_table"),
      /Unsupported global metadata table/
    );
  });
});

test("global store import plan groups metadata rows into deterministic backend batches", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);

    const store = createSqliteGlobalStore({
      dataDir,
      listCashflowUserIds: () => ["household"]
    });
    const exported = await createGlobalStoreExport({
      globalStore: store,
      now: new Date("2026-01-03T04:05:06Z")
    });
    const plan = createGlobalStoreImportPlan(exported);

    assert.equal(plan.format, "cashflow-sqlite-global-metadata-export");
    assert.equal(plan.containsSensitiveData, true);
    assert.equal(plan.sourceBackend, "sqlite");
    assert.equal(plan.targetBackend, "postgres");
    assert.equal(plan.rowCounts.accounts, 2);
    assert.equal(plan.rowCounts.auth_sessions, 1);
    assert.deepEqual(
      plan.writeBatches.map(batch => ({
        rows: batch.rows.length,
        tableName: batch.tableName
      })),
      POSTGRES_GLOBAL_TABLES
        .filter(tableName => (exported.tables[tableName] || []).length)
        .map(tableName => ({
          rows: exported.tables[tableName].length,
          tableName
        }))
    );

    const summary = JSON.stringify({
      rowCounts: plan.rowCounts,
      writeBatches: plan.writeBatches.map(batch => ({
        rows: batch.rows.length,
        tableName: batch.tableName
      }))
    });
    assert.doesNotMatch(summary, /secret-token-hash/);
    assert.doesNotMatch(summary, /alice@example.com/);
  });
});

test("global store import plan can append through a backend-neutral writer", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);

    const store = createSqliteGlobalStore({
      dataDir,
      listCashflowUserIds: () => ["household"]
    });
    const exported = await createGlobalStoreExport({
      globalStore: store,
      now: new Date("2026-01-03T04:05:06Z")
    });
    const plan = createGlobalStoreImportPlan(exported);
    const calls = [];
    const batchSummaries = [];
    const writer = {
      async insertRows(tableName, rows) {
        calls.push({
          rows: rows.length,
          tableName
        });
        return {
          inserted: rows.length,
          tableName
        };
      }
    };

    const result = await applyGlobalStoreImportPlan({
      globalStore: writer,
      onBatch: summary => batchSummaries.push(summary),
      plan
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, "append");
    assert.deepEqual(calls, batchSummaries);
    assert.equal(result.writeBatchCount, plan.writeBatches.length);
    assert.equal(result.rowCounts.auth_sessions, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret-token-hash/);
    assert.doesNotMatch(JSON.stringify(result), /alice@example.com/);
  });
});

test("global store import plan replace mode uses one all-table replacement writer", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);

    const store = createSqliteGlobalStore({
      dataDir,
      listCashflowUserIds: () => ["household"]
    });
    const exported = await createGlobalStoreExport({
      globalStore: store,
      now: new Date("2026-01-03T04:05:06Z")
    });
    const plan = createGlobalStoreImportPlan(exported);
    const calls = [];
    const writer = {
      async insertRows() {
        throw new Error("append global writer should not be used in replace mode");
      },
      async replaceAllRows(tables) {
        calls.push(Object.fromEntries(
          POSTGRES_GLOBAL_TABLES.map(tableName => [
            tableName,
            (tables[tableName] || []).length
          ])
        ));
        return {
          inserted: calls[0],
          replaced: true
        };
      }
    };

    const result = await applyGlobalStoreImportPlan({
      globalStore: writer,
      mode: "replace",
      plan
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, "replace");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].accounts, 2);
    assert.equal(calls[0].auth_sessions, 1);
    assert.equal(result.appliedBatches.every(batch => batch.mode === "replace"), true);
    assert.doesNotMatch(JSON.stringify(result), /secret-token-hash/);
    assert.doesNotMatch(JSON.stringify(result), /alice@example.com/);
  });
});

test("SQLite global store can replace all global metadata rows from a neutral import plan", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createGlobalSource(dataDir);
    const source = createSqliteGlobalStore({
      dataDir,
      listCashflowUserIds: () => ["household"]
    });
    const exported = await createGlobalStoreExport({
      globalStore: source,
      now: new Date("2026-01-03T04:05:06Z")
    });
    const plan = createGlobalStoreImportPlan(exported);

    const targetDir = path.join(dataDir, "target-global-store");
    fs.mkdirSync(targetDir, { recursive: true });
    const target = createSqliteGlobalStore({
      dataDir: targetDir,
      listCashflowUserIds: () => []
    });
    target.initialize();
    target.withRepository(repo => {
      repo.accounts.insert({
        id: "temporary_user",
        displayName: "Temporary User"
      });
    });

    const result = await applyGlobalStoreImportPlan({
      globalStore: target,
      mode: "replace",
      plan
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, "replace");
    assert.equal(result.result.inserted.accounts, 2);
    assert.equal(result.result.inserted.auth_sessions, 1);
    assert.equal(
      target.withRepository(repo => Boolean(repo.accounts.get("temporary_user"))),
      false
    );
    assert.equal(
      target.withRepository(repo => Boolean(repo.accounts.get("alice"))),
      true
    );
    assert.deepEqual(await target.checkReadiness(), {
      ok: true,
      backend: "sqlite",
      globalSchemaVersion: GLOBAL_SCHEMA_VERSION
    });
  });
});

test("Postgres global store writes and replaces rows through the neutral writer surface", async () => {
  const fakePg = fakePgModule({
    queryHandler: async sql => {
      if (String(sql).includes("INSERT INTO")) {
        return { rowCount: 1, rows: [] };
      }
      if (String(sql).includes("DELETE FROM")) {
        return { rowCount: 1, rows: [] };
      }
      return undefined;
    }
  });
  const store = await createPostgresGlobalStore({
    databaseUrl: "postgres://example.invalid/cashflow",
    pgModule: fakePg.module
  });

  assert.deepEqual(
    await store.insertRows("accounts", [{
      created_at: "2026-01-03T04:00:00Z",
      display_name: "Alice",
      email: "alice@example.com",
      id: "alice",
      status: "active",
      updated_at: "2026-01-03T04:00:00Z"
    }]),
    {
      inserted: 1,
      tableName: "accounts"
    }
  );
  assert.deepEqual(
    await store.replaceRows("auth_config", [{
      active_mode: "none",
      draft_config_json: "{}",
      draft_mode: "none",
      external_config_json: "{}",
      id: 1,
      session_absolute_minutes: 10080,
      session_idle_minutes: 720,
      updated_at: "2026-01-03T04:00:00Z"
    }]),
    {
      inserted: 1,
      replaced: true,
      tableName: "auth_config"
    }
  );

  assert.deepEqual(
    fakePg.queries.map(entry => entry.sql === "BEGIN" || entry.sql === "COMMIT"
      ? entry.sql
      : String(entry.sql).includes('INSERT INTO "accounts"') ? "INSERT_ACCOUNT"
        : String(entry.sql).includes('ALTER TABLE "auth_config" DISABLE TRIGGER USER') ? "DISABLE_AUTH_CONFIG"
          : String(entry.sql).includes('DELETE FROM "auth_config"') ? "DELETE_AUTH_CONFIG"
            : String(entry.sql).includes('INSERT INTO "auth_config"') ? "INSERT_AUTH_CONFIG"
              : String(entry.sql).includes('ALTER TABLE "auth_config" ENABLE TRIGGER USER') ? "ENABLE_AUTH_CONFIG"
                : "OTHER"
    ),
    [
      "BEGIN",
      "INSERT_ACCOUNT",
      "COMMIT",
      "BEGIN",
      "DISABLE_AUTH_CONFIG",
      "DELETE_AUTH_CONFIG",
      "INSERT_AUTH_CONFIG",
      "ENABLE_AUTH_CONFIG",
      "COMMIT"
    ]
  );

  await assert.rejects(
    () => store.insertRows("not_a_table", []),
    /Unsupported global metadata table/
  );
  await store.close();
});

test("SQLite global store wraps repository mutations in SQLite transactions", async () => {
  await withTempDirs(async ({ dataDir }) => {
    const store = createSqliteGlobalStore({
      dataDir,
      listCashflowUserIds: () => []
    });

    assert.throws(
      () => store.transaction(repo => {
        repo.accounts.insert({
          id: "rollback_user",
          displayName: "Rollback User"
        });
        throw new Error("rollback requested");
      }),
      /rollback requested/
    );
    assert.equal(
      store.withRepository(repo => Boolean(repo.accounts.get("rollback_user"))),
      false
    );

    assert.equal(
      store.transaction(repo => {
        repo.accounts.insert({
          id: "committed_user",
          displayName: "Committed User"
        });
        return "committed";
      }),
      "committed"
    );
    assert.equal(
      store.withRepository(repo => Boolean(repo.accounts.get("committed_user"))),
      true
    );

    assert.throws(
      () => store.transaction(async () => "bad"),
      /must be synchronous/
    );

    await store.close();
  });
});

test("Postgres global metadata import validates exports and applies rows transactionally", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    const exportedSummary = createSqliteGlobalMetadataExport({
      dataDir,
      outputDir,
      now: new Date("2026-01-03T04:05:06Z")
    });
    const payload = JSON.parse(fs.readFileSync(exportedSummary.exportPath, "utf8"));

    const dryRun = await importSqliteGlobalMetadataToPostgres({
      dryRun: true,
      payload
    });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.rowCounts.accounts, 2);

    const cliDryRun = await importGlobalMetadataToPostgresCli({
      apply: false,
      input: exportedSummary.exportPath
    });
    assert.equal(cliDryRun.ok, true);
    assert.equal(cliDryRun.dryRun, true);
    assert.equal(cliDryRun.writeBatchCount, createGlobalStoreImportPlan(payload).writeBatches.length);
    assert.deepEqual(
      cliDryRun.writeBatches.map(batch => ({
        rows: batch.rows,
        tableName: batch.tableName
      })),
      createGlobalStoreImportPlan(payload).writeBatches.map(batch => ({
        rows: batch.rows.length,
        tableName: batch.tableName
      }))
    );
    assert.doesNotMatch(JSON.stringify(cliDryRun), /secret-token-hash/);
    assert.doesNotMatch(JSON.stringify(cliDryRun), /alice@example.com/);

    const queries = [];
    const client = {
      async query(sql, params = []) {
        queries.push({ sql, params });
        return { rows: [] };
      }
    };

    const applied = await importSqliteGlobalMetadataToPostgres({
      client,
      dryRun: false,
      payload
    });

    assert.equal(applied.ok, true);
    assert.equal(applied.dryRun, false);
    assert.equal(queries[0].sql, "BEGIN");
    assert.match(queries[1].sql, /CREATE TABLE IF NOT EXISTS users/);
    assert.equal(queries.at(-1).sql, "COMMIT");
    assert.equal(applied.inserted.accounts, 2);
    assert.equal(
      queries.some(entry => entry.sql === "DELETE FROM global_options WHERE id = 1"),
      true
    );
    assert.equal(
      queries.some(entry => entry.sql === "DELETE FROM auth_config WHERE id = 1"),
      true
    );

    const providerInsert = queries.find(entry => String(entry.sql).includes('INSERT INTO "auth_providers"'));
    assert.equal(providerInsert, undefined);
    const sessionInsert = queries.find(entry => String(entry.sql).includes('INSERT INTO "auth_sessions"'));
    assert.ok(sessionInsert);
    assert.ok(sessionInsert.params.includes("secret-token-hash"));
  });
});

test("Postgres global metadata import rolls back apply failures", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    const exportedSummary = createSqliteGlobalMetadataExport({ dataDir, outputDir });
    const payload = JSON.parse(fs.readFileSync(exportedSummary.exportPath, "utf8"));
    const queries = [];
    const client = {
      async query(sql, params = []) {
        queries.push({ sql, params });
        if (String(sql).includes('INSERT INTO "accounts"')) {
          throw new Error("insert failed");
        }
        return { rows: [] };
      }
    };

    await assert.rejects(
      () => importSqliteGlobalMetadataToPostgres({
        client,
        dryRun: false,
        payload
      }),
      /insert failed/
    );
    assert.equal(queries[0].sql, "BEGIN");
    assert.equal(queries.at(-1).sql, "ROLLBACK");
  });
});

test("Postgres global metadata import rejects malformed export shapes", () => {
  assert.throws(
    () => normalizeSqliteGlobalMetadataExport({
      format: "wrong",
      version: 1,
      tables: {}
    }),
    /Unsupported global metadata export format/
  );

  assert.throws(
    () => normalizeSqliteGlobalMetadataExport({
      format: "cashflow-sqlite-global-metadata-export",
      version: 1,
      tables: {
        extra_table: []
      }
    }),
    /unknown table extra_table/
  );

  assert.throws(
    () => normalizeSqliteGlobalMetadataExport({
      format: "cashflow-sqlite-global-metadata-export",
      version: 1,
      tables: {
        accounts: [{ id: "alice", unexpected: true }]
      }
    }),
    /unknown column unexpected/
  );

  assert.throws(
    () => normalizeSqliteGlobalMetadataExport({
      format: "cashflow-sqlite-global-metadata-export",
      version: 1,
      tables: {
        auth_providers: [{ id: "provider", enabled: "yes" }]
      }
    }),
    /enabled must be boolean-compatible/
  );
});
