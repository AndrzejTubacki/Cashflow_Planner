import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyLedgerMigrations,
  applyPlanningMigrations
} from "../../src/server/cashflow-migrations.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { initializeMainPlanningSchema } from "../helpers/main-schema-fixtures.js";
import { LEDGER_AUDIT_SCHEMA, LEDGER_ORIGIN_SCHEMA } from "../../src/server/cashflow-ledger-audit-store.js";
import { occurrenceKeyFromRow } from "../../src/server/cashflow-occurrence-utils.js";
import {
  initializeLedgerSchema,
  LEDGER_COLUMNS,
  LEDGER_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION,
  initializePlanningSchema
} from "../../src/server/cashflow-schema.js";

async function withTempDb(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "cashflow-migration-test-"));
  const dbPath = path.join(dir, "test.sqlite");
  const db = new Database(dbPath);

  try {
    return await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function indexNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name));
}

test("planning v22 journal migration rolls back failures and preserves existing financial rows", () => withTempDb(db => {
  initializePlanningSchema(db);
  db.exec("DROP TABLE cashflow_sync_operations; DROP TABLE cashflow_sync_heads; PRAGMA user_version = 20;");
  db.prepare("INSERT INTO one_off_transactions (id,name,currency,amount,type,date,created_at,updated_at) VALUES ('bill','Bill','PLN',10,'expense','2026-06-10','2026-06-01','2026-06-01')").run();
  assert.throws(() => applyPlanningMigrations(db, { beforeStep(version, connection) {
    if (version === 22) {
      connection.exec("CREATE TABLE cashflow_sync_heads (budget_id TEXT PRIMARY KEY)");
      throw new Error("Injected journal migration failure");
    }
  } }), /Injected journal migration failure/);
  assert.equal(db.pragma("user_version", { simple: true }), 20);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='cashflow_sync_heads'").get().n, 0);
  assert.equal(db.prepare("SELECT amount FROM one_off_transactions WHERE id='bill'").get().amount, 10);
  applyPlanningMigrations(db);
  assert.equal(db.pragma("user_version", { simple: true }), PLANNING_SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT count(*) AS n FROM cashflow_sync_operations").get().n, 0);
  assert.equal(db.prepare("SELECT amount FROM one_off_transactions WHERE id='bill'").get().amount, 10);
}));

test("planning migration from version 8 adds locale and preserves valid settings data", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 8;

    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ledger_currency TEXT NOT NULL DEFAULT 'PLN',
      future_periods INTEGER NOT NULL DEFAULT 11,
      fx_provider TEXT NOT NULL DEFAULT 'manual',
      fx_used_currencies TEXT NOT NULL DEFAULT '["EUR"]',
      manual_fx_rates TEXT NOT NULL DEFAULT '{"EUR":4.2}',
      updated_at TEXT NOT NULL
    );

    INSERT INTO settings (
      id, ledger_currency, future_periods, fx_provider, fx_used_currencies,
      manual_fx_rates, updated_at
    ) VALUES (1, 'PLN', 7, 'manual', '["EUR"]', '{"EUR":4.2}', datetime('now'));

    CREATE TABLE one_off_transactions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO one_off_transactions (
      id, name, currency, amount, type, date, created_at, updated_at
    ) VALUES (
      'old-one-off', 'Old functional row', 'EUR', 20, 'expense', '2026-01-15',
      datetime('now'), datetime('now')
    );
  `);

  applyPlanningMigrations(db);

  const version = db.pragma("user_version", { simple: true });
  const columns = db.prepare("PRAGMA table_info(settings)").all().map(column => column.name);
  const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
  const oneOff = db.prepare("SELECT * FROM one_off_transactions WHERE id = 'old-one-off'").get();

  assert.equal(version, PLANNING_SCHEMA_VERSION);
  assert.equal(columns.includes("locale"), true);
  assert.equal(columns.includes("setup_completed"), true);
  assert.equal(columns.includes("setup_completed_at"), true);
  assert.equal(columns.includes("holiday_country"), true);
  assert.equal(columns.includes("minimum_reserve_enabled"), true);
  assert.equal(columns.includes("minimum_reserve_amount"), true);
  assert.equal(columns.includes("ledger_history_compaction_months"), true);
  assert.equal(columns.includes("notification_channel"), true);
  assert.equal(columns.includes("discord_webhook_url"), true);
  assert.equal(settings.locale, "en");
  assert.equal(settings.holiday_country, "PL");
  assert.equal(settings.minimum_reserve_enabled, 0);
  assert.equal(settings.minimum_reserve_amount, 0);
  assert.equal(settings.ledger_history_compaction_months, 0);
  assert.equal(settings.notification_channel, "ntfy");
  assert.equal(settings.discord_webhook_url, null);
  assert.equal(settings.setup_completed, 1);
  assert.equal(settings.fx_provider, "manual");
  assert.equal(settings.fx_used_currencies, '["EUR"]');
  assert.equal(settings.manual_fx_rates, '{"EUR":4.2}');
  assert.equal(settings.future_periods, 7);
  assert.equal(oneOff.name, "Old functional row");
  assert.equal(oneOff.currency, "EUR");
}));

test("planning migration rolls back every earlier step when a later step fails", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 8;

    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ledger_currency TEXT NOT NULL DEFAULT 'PLN',
      future_periods INTEGER NOT NULL DEFAULT 11,
      fx_provider TEXT NOT NULL DEFAULT 'manual',
      fx_used_currencies TEXT NOT NULL DEFAULT '[]',
      manual_fx_rates TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    INSERT INTO settings (
      id, ledger_currency, future_periods, fx_provider, fx_used_currencies,
      manual_fx_rates, updated_at
    ) VALUES (1, 'PLN', 7, 'manual', '[]', '{}', datetime('now'));
  `);

  assert.throws(
    () => applyPlanningMigrations(db, {
      beforeStep(version) {
        if (version === 10) throw new Error("forced migration failure");
      }
    }),
    /forced migration failure/
  );

  const version = db.pragma("user_version", { simple: true });
  const columns = db.prepare("PRAGMA table_info(settings)").all().map(column => column.name);
  const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();

  assert.equal(version, 8);
  assert.equal(columns.includes("locale"), false);
  assert.equal(settings.future_periods, 7);
}));

test("planning migration from version 9 adds prediction fallback fields", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 9;

    CREATE TABLE recurring_expenses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL,
      prediction_strategy TEXT NOT NULL
    );

    CREATE TABLE recurring_incomes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL,
      prediction_strategy TEXT NOT NULL
    );

    INSERT INTO recurring_expenses (
      id, name, currency, amount, prediction_strategy
    ) VALUES ('exp-1', 'Expense', 'PLN', 500, '12month_max');

    INSERT INTO recurring_incomes (
      id, name, currency, amount, prediction_strategy
    ) VALUES ('inc-1', 'Income', 'PLN', 500, '12month_min');
  `);

  applyPlanningMigrations(db);

  const version = db.pragma("user_version", { simple: true });
  const expenseColumns = db.prepare("PRAGMA table_info(recurring_expenses)").all().map(column => column.name);
  const incomeColumns = db.prepare("PRAGMA table_info(recurring_incomes)").all().map(column => column.name);
  const expense = db.prepare("SELECT * FROM recurring_expenses WHERE id = 'exp-1'").get();
  const income = db.prepare("SELECT * FROM recurring_incomes WHERE id = 'inc-1'").get();

  assert.equal(version, PLANNING_SCHEMA_VERSION);
  assert.equal(expenseColumns.includes("prediction_substitute_missing"), true);
  assert.equal(incomeColumns.includes("prediction_substitute_missing"), true);
  assert.equal(expenseColumns.includes("prediction_min_recorded_months"), true);
  assert.equal(incomeColumns.includes("prediction_min_recorded_months"), true);
  assert.equal(expense.prediction_substitute_missing, "none");
  assert.equal(income.prediction_substitute_missing, "none");
  assert.equal(expense.prediction_min_recorded_months, 6);
  assert.equal(income.prediction_min_recorded_months, 6);
}));

test("ledger migration from version 2 adds occurrence keys and preserves ledger values", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 2;

    CREATE TABLE confirmed_transactions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      confirmed_date TEXT NOT NULL,
      fx_rate REAL,
      buffered_fx_rate REAL,
      running_balance_pln REAL NOT NULL,
      ledger_amount REAL,
      source_recurring_expense_id TEXT,
      source_recurring_income_id TEXT,
      source_one_off_id TEXT,
      source_flex_id TEXT,
      source_goal_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO confirmed_transactions (
      id, name, currency, amount, type, date, confirmed_date, fx_rate,
      buffered_fx_rate, running_balance_pln, ledger_amount, source_one_off_id,
      created_at, updated_at
    ) VALUES (
      'conf-1', 'Migrated one-off', 'PLN', 25, 'expense', '2026-01-02',
      '2026-01-02', 1, 1, 75, 25, 'oneoff-1', datetime('now'), datetime('now')
    );
  `);

  applyLedgerMigrations(db, { occurrenceKeyFromRow });

  const version = db.pragma("user_version", { simple: true });
  const columns = db.prepare("PRAGMA table_info(confirmed_transactions)").all().map(column => column.name);
  const row = db.prepare("SELECT * FROM confirmed_transactions WHERE id = 'conf-1'").get();

  assert.equal(version, LEDGER_SCHEMA_VERSION);
  assert.equal(columns.includes("occurrence_key"), true);
  assert.equal(row.ledger_amount, 25);
  assert.equal(row.running_balance_pln, 75);
  assert.equal(row.occurrence_key, "one_off:oneoff-1:expense:2026-01-02");
  // The legacy ledger already required confirmation dates; migration must not
  // admit the NULL rows assumed by the compaction review finding.
  assert.throws(() => db.prepare("UPDATE confirmed_transactions SET confirmed_date = NULL WHERE id = 'conf-1'").run(),
    /NOT NULL constraint failed/);
}));

test("planning migration rounds stored money columns to cents", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 15;

    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      minimum_reserve_amount REAL NOT NULL DEFAULT 0
    );

    INSERT INTO settings (id, minimum_reserve_amount)
    VALUES (1, 100.129);

    CREATE TABLE recurring_expenses (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL
    );

    INSERT INTO recurring_expenses (id, amount)
    VALUES ('expense-1', 10.235);

    CREATE TABLE pending_transactions (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      funded_amount REAL,
      requested_amount REAL,
      ledger_amount REAL,
      running_balance REAL,
      source_recurring_expense_id TEXT,
      source_recurring_income_id TEXT,
      source_one_off_id TEXT,
      source_flex_id TEXT,
      source_goal_id TEXT
    );

    INSERT INTO pending_transactions (
      id, amount, funded_amount, requested_amount, ledger_amount, running_balance
    ) VALUES (
      'pending-1', 1.005, 2.335, 3.675, 4.995, 5.555
    );

    CREATE TABLE future_transactions (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      funded_amount REAL,
      requested_amount REAL,
      ledger_amount REAL,
      running_balance REAL,
      source_recurring_expense_id TEXT,
      source_recurring_income_id TEXT,
      source_one_off_id TEXT,
      source_flex_id TEXT,
      source_goal_id TEXT
    );

    INSERT INTO future_transactions (
      id, amount, funded_amount, requested_amount, ledger_amount, running_balance
    ) VALUES (
      'future-1', 6.105, 7.335, 8.675, 9.995, 10.555
    );
  `);

  applyPlanningMigrations(db);

  assert.equal(db.pragma("user_version", { simple: true }), PLANNING_SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT minimum_reserve_amount FROM settings WHERE id = 1").get().minimum_reserve_amount, 100.13);
  assert.equal(db.prepare("SELECT amount FROM recurring_expenses WHERE id = 'expense-1'").get().amount, 10.24);
  assert.deepEqual(
    db.prepare("SELECT amount, funded_amount, requested_amount, ledger_amount, running_balance FROM pending_transactions WHERE id = 'pending-1'").get(),
    {
      amount: 1.01,
      funded_amount: 2.34,
      requested_amount: 3.68,
      ledger_amount: 5,
      running_balance: 5.56
    }
  );
  assert.deepEqual(
    db.prepare("SELECT amount, funded_amount, requested_amount, ledger_amount, running_balance FROM future_transactions WHERE id = 'future-1'").get(),
    {
      amount: 6.11,
      funded_amount: 7.34,
      requested_amount: 8.68,
      ledger_amount: 10,
      running_balance: 10.56
    }
  );
}));

test("ledger migration rounds stored money columns to cents", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 4;

    CREATE TABLE confirmed_transactions (
      id TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      running_balance_pln REAL NOT NULL,
      ledger_amount REAL,
      source_recurring_expense_id TEXT,
      source_recurring_income_id TEXT,
      source_one_off_id TEXT,
      source_flex_id TEXT,
      source_goal_id TEXT,
      occurrence_key TEXT
    );

    INSERT INTO confirmed_transactions (
      id, amount, running_balance_pln, ledger_amount
    ) VALUES (
      'confirmed-1', 10.235, 20.675, 30.995
    );
  `);

  applyLedgerMigrations(db, { occurrenceKeyFromRow });

  assert.equal(db.pragma("user_version", { simple: true }), LEDGER_SCHEMA_VERSION);
  assert.deepEqual(
    db.prepare("SELECT amount, running_balance_pln, ledger_amount FROM confirmed_transactions WHERE id = 'confirmed-1'").get(),
    {
      amount: 10.24,
      running_balance_pln: 20.68,
      ledger_amount: 31
    }
  );
}));

test("current planning migrations create source indexes for existing databases", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 14;

    CREATE TABLE future_transactions (
      id TEXT PRIMARY KEY,
      source_recurring_expense_id TEXT,
      source_recurring_income_id TEXT,
      source_one_off_id TEXT,
      source_flex_id TEXT,
      source_goal_id TEXT
    );

    CREATE TABLE pending_transactions (
      id TEXT PRIMARY KEY,
      source_recurring_expense_id TEXT,
      source_recurring_income_id TEXT,
      source_one_off_id TEXT,
      source_flex_id TEXT,
      source_goal_id TEXT
    );
  `);

  applyPlanningMigrations(db);

  const indexes = indexNames(db);
  const pendingColumns = db.prepare("PRAGMA table_info(pending_transactions)").all().map(column => column.name);
  assert.equal(pendingColumns.includes("pending_origin"), true);

  for (const name of [
    "idx_future_source_recurring_expense",
    "idx_future_source_recurring_income",
    "idx_future_source_one_off",
    "idx_future_source_goal",
    "idx_future_source_flex",
    "idx_pending_source_recurring_expense",
    "idx_pending_source_recurring_income",
    "idx_pending_source_one_off",
    "idx_pending_source_goal",
    "idx_pending_source_flex"
  ]) {
    assert.equal(indexes.has(name), true, name);
  }
}));

test("current ledger migrations create confirmed source indexes for existing databases", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 4;

    CREATE TABLE confirmed_transactions (
      id TEXT PRIMARY KEY,
      source_recurring_expense_id TEXT,
      source_recurring_income_id TEXT,
      source_one_off_id TEXT,
      source_flex_id TEXT,
      source_goal_id TEXT,
      occurrence_key TEXT
    );
  `);

  applyLedgerMigrations(db, { occurrenceKeyFromRow });

  const indexes = indexNames(db);
  for (const name of [
    "idx_confirmed_source_recurring_expense",
    "idx_confirmed_source_recurring_income",
    "idx_confirmed_source_one_off",
    "idx_confirmed_source_goal",
    "idx_confirmed_source_flex",
    "idx_confirmed_occurrence_key"
  ]) {
    assert.equal(indexes.has(name), true, name);
  }
}));

test("planning migration extracts a URL-embedded ntfy access token into its own column", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 18;

    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ntfy_url TEXT
    );

    INSERT INTO settings (id, ntfy_url)
    VALUES (1, 'https://:tk_exampletokenexampletoken0001@ntfy.example.com/budget');
  `);

  applyPlanningMigrations(db);

  const version = db.pragma("user_version", { simple: true });
  const row = db.prepare("SELECT ntfy_url, ntfy_auth_token FROM settings WHERE id = 1").get();

  assert.equal(version, PLANNING_SCHEMA_VERSION);
  assert.equal(row.ntfy_url, "https://ntfy.example.com/budget");
  assert.equal(row.ntfy_auth_token, "tk_exampletokenexampletoken0001");
}));

test("planning migration leaves a plain ntfy URL untouched", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 18;

    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ntfy_url TEXT
    );

    INSERT INTO settings (id, ntfy_url)
    VALUES (1, 'https://ntfy.example.com/topic');
  `);

  applyPlanningMigrations(db);

  const row = db.prepare("SELECT ntfy_url, ntfy_auth_token FROM settings WHERE id = 1").get();
  assert.equal(row.ntfy_url, "https://ntfy.example.com/topic");
  assert.equal(row.ntfy_auth_token, null);
}));

test("planning migration adds ntfy_auth_token even when settings has no ntfy_url column yet", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 15;

    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1)
    );

    INSERT INTO settings (id) VALUES (1);
  `);

  applyPlanningMigrations(db);

  const version = db.pragma("user_version", { simple: true });
  const columns = db.prepare("PRAGMA table_info(settings)").all().map(column => column.name);

  assert.equal(version, PLANNING_SCHEMA_VERSION);
  assert.equal(columns.includes("ntfy_auth_token"), true);
}));

test("planning migration from version 20 adds nullable recurring end months and keeps rows", () => withTempDb(db => {
  db.exec(`
    PRAGMA user_version = 20;
    CREATE TABLE recurring_expenses (id TEXT PRIMARY KEY, name TEXT, start_month_year TEXT);
    CREATE TABLE recurring_incomes (id TEXT PRIMARY KEY, name TEXT, start_month_year TEXT);
    INSERT INTO recurring_expenses (id, name, start_month_year) VALUES ('exp-1', 'Rent', '2026-01');
    INSERT INTO recurring_incomes (id, name, start_month_year) VALUES ('inc-1', 'Salary', NULL);
  `);

  applyPlanningMigrations(db);

  assert.equal(db.pragma("user_version", { simple: true }), PLANNING_SCHEMA_VERSION);
  assert.deepEqual(
    { ...db.prepare("SELECT id, name, start_month_year, end_month_year FROM recurring_expenses").get() },
    { id: "exp-1", name: "Rent", start_month_year: "2026-01", end_month_year: null }
  );
  assert.equal(db.prepare("SELECT end_month_year FROM recurring_incomes WHERE id = 'inc-1'").get().end_month_year, null);
}));

// A failed metadata upgrade must leave both the previous version and facts intact.
test("planning v22 summary migration is atomic and retryable", () => withTempDb(db => {
  initializePlanningSchema(db);
  db.exec("DROP TABLE cashflow_ledger_summary_cache; PRAGMA user_version = 21;");
  db.prepare("INSERT INTO one_off_transactions (id,name,currency,amount,type,date,created_at,updated_at) VALUES ('kept','Kept','PLN',10,'expense','2026-06-10','2026-06-01','2026-06-01')").run();
  assert.throws(() => applyPlanningMigrations(db, { beforeStep(version, connection) {
    if (version === 22) {
      connection.exec("CREATE TABLE cashflow_ledger_summary_cache (budget_id TEXT PRIMARY KEY)");
      throw new Error("Injected summary migration failure");
    }
  } }), /Injected summary migration failure/);
  assert.equal(db.pragma("user_version", { simple: true }), 21);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='cashflow_ledger_summary_cache'").get().n, 0);
  applyPlanningMigrations(db);
  assert.equal(db.pragma("user_version", { simple: true }), PLANNING_SCHEMA_VERSION);
  assert.equal(db.prepare("SELECT amount FROM one_off_transactions WHERE id='kept'").get().amount, 10);
}));


// Audit DDL and the version stamp must roll back with the financial database.
test("planning v22 audit migration preserves prior data and retries after late failure", () => withTempDb(db => {
  initializePlanningSchema(db);
  db.exec("DROP TABLE cashflow_ledger_origins; DROP TABLE cashflow_ledger_corrections; DROP TABLE cashflow_ledger_originals; DROP TABLE cashflow_ledger_audit_state; PRAGMA user_version = 21;");
  db.prepare("INSERT INTO one_off_transactions (id,name,currency,amount,type,date,created_at,updated_at) VALUES ('kept','Kept','PLN',10,'expense','2026-06-10','2026-06-01','2026-06-01')").run();
  assert.throws(() => applyPlanningMigrations(db, { beforeStep(version, connection) {
    if (version === 22) {
      connection.exec(LEDGER_AUDIT_SCHEMA);
      throw new Error("Injected audit migration failure");
    }
  } }), /Injected audit migration failure/);
  assert.equal(db.pragma("user_version", { simple: true }), 21);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'cashflow_ledger_%' AND name <> 'cashflow_ledger_summary_cache'").get().n, 0);
  assert.equal(db.prepare("SELECT amount FROM one_off_transactions WHERE id='kept'").get().amount, 10);
  applyPlanningMigrations(db);
  assert.equal(db.pragma("user_version", { simple: true }), PLANNING_SCHEMA_VERSION);
  for (const table of ['cashflow_ledger_audit_state', 'cashflow_ledger_originals', 'cashflow_ledger_corrections']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, 'Migration must not invent acceptance evidence');
  }
  assert.equal(db.prepare("SELECT amount FROM one_off_transactions WHERE id='kept'").get().amount, 10);
  db.exec("PRAGMA foreign_keys = ON");
  assert.throws(() => db.prepare("INSERT INTO cashflow_ledger_originals VALUES ('missing','payment',1,'{}','fixture')").run(), /FOREIGN KEY/);
}));

test('planning v22 origin migration preserves prior state and rolls back late failure', () => withTempDb(db => {
  initializePlanningSchema(db);
  db.exec('DROP TABLE cashflow_ledger_origins; ALTER TABLE cashflow_ledger_audit_state DROP COLUMN origin_version; PRAGMA user_version = 21;');
  db.prepare("INSERT INTO one_off_transactions (id,name,currency,amount,type,date,created_at,updated_at) VALUES ('kept-origin','Kept','PLN',10,'expense','2026-06-10','2026-06-01','2026-06-01')").run();
  db.prepare("INSERT INTO cashflow_ledger_audit_state (budget_id,last_sequence,baseline_complete) VALUES ('kept-origin',0,1)").run();
  const prior = db.prepare("SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = 'kept-origin'").get();
  const exec = db.exec;
  db.exec = function(sql) {
    const result = exec.call(this, sql);
    if (sql === LEDGER_ORIGIN_SCHEMA) throw new Error('Injected origin migration failure');
    return result;
  };
  try { assert.throws(() => applyPlanningMigrations(db), /Injected origin migration failure/); }
  finally { db.exec = exec; }
  assert.equal(db.pragma('user_version', { simple: true }), 21);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='cashflow_ledger_origins'").get().n, 0);
  assert.deepEqual(db.prepare("SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = 'kept-origin'").get(), prior);
  applyPlanningMigrations(db);
  assert.equal(db.pragma('user_version', { simple: true }), PLANNING_SCHEMA_VERSION);
  assert.deepEqual(db.prepare("SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = 'kept-origin'").get(), { ...prior, origin_version: 0 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM cashflow_ledger_origins').get().n, 0);
  assert.equal(db.prepare("SELECT amount FROM one_off_transactions WHERE id='kept-origin'").get().amount, 10);
  db.pragma('foreign_keys = ON');
  assert.throws(() => db.prepare("INSERT INTO cashflow_ledger_origins VALUES ('missing','{}','synthetic')").run(), /FOREIGN KEY/);
}));

for (const sourceVersion of [20, 21]) {
  test(`planning ${sourceVersion} to 22 calls backup hooks before the combined step and is a no-op on retry`, () => withTempDb(db => {
    initializeMainPlanningSchema(db);
    if (sourceVersion === 20) db.exec(`
      ALTER TABLE recurring_expenses DROP COLUMN end_month_year;
      ALTER TABLE recurring_incomes DROP COLUMN end_month_year;
      PRAGMA user_version = 20;
    `);
    const steps = [];
    applyPlanningMigrations(db, { beforeStep(version, connection) {
      steps.push([version, connection.pragma('user_version', { simple: true })]);
      assert.equal(connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cashflow_sync_heads'").get(), undefined);
      if (version === 22) {
        assert.ok(connection.prepare('PRAGMA table_info(recurring_expenses)').all().some(column => column.name === 'end_month_year'));
      }
    } });
    assert.deepEqual(steps, sourceVersion === 20 ? [[21, 20], [22, 21]] : [[22, 21]]);
    assert.equal(db.pragma('user_version', { simple: true }), 22);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ledger_merge_state').get().n, 0);
    for (const table of ['cashflow_ledger_audit_state', 'cashflow_ledger_originals', 'cashflow_ledger_corrections', 'cashflow_ledger_origins']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    }
    const before = db.serialize();
    applyPlanningMigrations(db, { beforeStep() { assert.fail('Current schema must not migrate'); } });
    assert.deepEqual(db.serialize(), before);
  }));
}

for (const sourceVersion of [14, 20, 21]) {
  test(`main planning ${sourceVersion} imports every legacy yearly ledger row into planning 22 and retains recovery copies`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cashflow-main-upgrade-'));
    const paths = createCashflowStoragePaths(directory);
    const userId = 'main-user';
    const planningPath = paths.planningDbPath(userId);
    const planning = new Database(planningPath);
    initializeMainPlanningSchema(planning);
    planning.exec(`
      UPDATE settings SET ledger_currency = 'EUR', ntfy_url = 'https://ntfy.example/budget' WHERE id = 1;
      INSERT INTO recurring_incomes (id,name,currency,amount,prediction_strategy,repeat_every_months,
        start_month_year,end_month_year,anchor_type,anchor_day_of_month,created_at,updated_at)
      VALUES ('salary','Salary','EUR',1000,'fixed',1,'2025-01','2027-12','day_of_month',1,'2025-01-01','2025-01-01');
      INSERT INTO one_off_transactions (id,name,currency,amount,type,date,created_at,updated_at)
      VALUES ('kept','Kept','EUR',12,'expense','2026-01-10','2026-01-01','2026-01-01');
    `);
    const priorSettings = planning.prepare('SELECT * FROM settings').get();
    const priorIncome = planning.prepare('SELECT * FROM recurring_incomes').get();
    planning.close();
    const originals = [];
    const files = [];
    for (const year of [2025, 2026]) {
      const filename = paths.ledgerDbPath(userId, year);
      files.push(filename);
      const ledger = new Database(filename);
      initializeLedgerSchema(ledger);
      for (const index of [1, 2]) ledger.prepare(`INSERT INTO confirmed_transactions (
        id,name,currency,amount,type,date,confirmed_date,fx_rate,buffered_fx_rate,ledger_currency,
        running_balance_pln,ledger_amount,source_recurring_income_id,occurrence_key,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`payment-${year}-${index}`, 'Kept payment', 'EUR', 10.25 * index,
        'income', `${year}-01-0${index}`, `${year}-01-0${index}`, 1, 1, 'EUR', 10.25 * index, 10.25 * index,
        'salary', `income:salary:${year}-01-0${index}`, `${year}-01-01`, `${year}-01-01`);
      originals.push(...ledger.prepare('SELECT * FROM confirmed_transactions ORDER BY id').all().map(row => ({ ...row, ledger_year: year })));
      ledger.close();
    }
    if (sourceVersion < 21) {
      const legacy = new Database(planningPath);
      legacy.exec(`ALTER TABLE recurring_expenses DROP COLUMN end_month_year;
        ALTER TABLE recurring_incomes DROP COLUMN end_month_year`);
      if (sourceVersion < 20) legacy.exec('ALTER TABLE recurring_expenses DROP COLUMN anchor_income_id');
      if (sourceVersion < 19) legacy.exec('ALTER TABLE settings DROP COLUMN ntfy_auth_token');
      if (sourceVersion < 18) legacy.exec('ALTER TABLE settings DROP COLUMN ledger_history_compaction_months');
      if (sourceVersion < 17) legacy.exec(`ALTER TABLE settings DROP COLUMN notification_channel;
        ALTER TABLE settings DROP COLUMN discord_webhook_url`);
      if (sourceVersion < 15) legacy.exec('ALTER TABLE pending_transactions DROP COLUMN pending_origin');
      legacy.pragma(`user_version = ${sourceVersion}`);
      legacy.close();
    }
    const service = createCashflowDbService(paths);
    try {
      const db = service.openPlanningDb(userId);
      try {
        assert.equal(db.pragma('user_version', { simple: true }), 22);
        assert.deepEqual(db.prepare(`SELECT ${LEDGER_COLUMNS.join(', ')}, ledger_year FROM ledger_transactions ORDER BY id`).all(), originals);
        assert.deepEqual(db.prepare('SELECT * FROM settings').get(), { ...priorSettings, notification_channels: null });
        assert.deepEqual(db.prepare('SELECT * FROM recurring_incomes').get(), { ...priorIncome, end_month_year: sourceVersion < 21 ? null : priorIncome.end_month_year });
        assert.equal(db.prepare("SELECT amount FROM one_off_transactions WHERE id = 'kept'").get().amount, 12);
        assert.equal(db.prepare('SELECT count(*) AS n FROM ledger_merge_state').get().n, 1);
        assert.equal(db.prepare('SELECT count(*) AS n FROM cashflow_ledger_originals').get().n, 0);
      } finally { db.close(); }
      for (const filename of files) {
        assert.equal(fs.existsSync(filename), false);
        assert.equal(fs.existsSync(`${filename}.merged`), true);
      }
      const userDir = paths.userDataDir(userId);
      const recoveries = fs.readdirSync(path.join(userDir, 'backups')).filter(name => name.startsWith('migration_backup_'));
      assert.equal(recoveries.length, 1);
      const backupPath = path.join(userDir, 'backups', recoveries[0], 'planning.sqlite');
      const backup = new Database(backupPath, { readonly: true });
      try { assert.equal(backup.pragma('user_version', { simple: true }), sourceVersion); }
      finally { backup.close(); }
      const reopened = service.openPlanningDb(userId);
      try { assert.deepEqual(reopened.prepare(`SELECT ${LEDGER_COLUMNS.join(', ')}, ledger_year FROM ledger_transactions ORDER BY id`).all(), originals); }
      finally { reopened.close(); }
      for (const year of [2025, 2026]) {
        const ledger = service.openLedgerDb(userId, year);
        try { assert.equal(ledger.prepare('SELECT count(*) AS n FROM confirmed_transactions').get().n, 2); }
        finally { ledger.close(); }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
