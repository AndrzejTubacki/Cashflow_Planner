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
  `);

  applyPlanningMigrations(db);

  const version = db.pragma("user_version", { simple: true });
  const columns = db.prepare("PRAGMA table_info(settings)").all().map(column => column.name);
  const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();

  assert.equal(version, 9);
  assert.equal(columns.includes("locale"), true);
  assert.equal(settings.locale, "en");
  assert.equal(settings.fx_provider, "manual");
  assert.equal(settings.fx_used_currencies, '["EUR"]');
  assert.equal(settings.manual_fx_rates, '{"EUR":4.2}');
  assert.equal(settings.future_periods, 7);
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

  assert.equal(version, 3);
  assert.equal(columns.includes("occurrence_key"), true);
  assert.equal(row.ledger_amount, 25);
  assert.equal(row.running_balance_pln, 75);
  assert.equal(row.occurrence_key, "one_off:oneoff-1:expense:2026-01-02");
}));
