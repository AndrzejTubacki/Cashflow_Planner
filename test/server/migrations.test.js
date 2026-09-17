import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyLedgerMigrations,
  applyPlanningMigrations
} from "../../src/server/cashflow-migrations.js";
import { occurrenceKeyFromRow } from "../../src/server/cashflow-occurrence-utils.js";
import {
  LEDGER_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION
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
    VALUES (1, 'https://:tk_g5qdcly4l23ssxlpx8ys8wcwtqh68@ntfy.tubacki.pl/budget');
  `);

  applyPlanningMigrations(db);

  const version = db.pragma("user_version", { simple: true });
  const row = db.prepare("SELECT ntfy_url, ntfy_auth_token FROM settings WHERE id = 1").get();

  assert.equal(version, PLANNING_SCHEMA_VERSION);
  assert.equal(row.ntfy_url, "https://ntfy.tubacki.pl/budget");
  assert.equal(row.ntfy_auth_token, "tk_g5qdcly4l23ssxlpx8ys8wcwtqh68");
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
