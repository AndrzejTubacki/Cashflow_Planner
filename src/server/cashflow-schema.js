import { LEDGER_AUDIT_SCHEMA, LEDGER_ORIGIN_SCHEMA } from "./cashflow-ledger-audit-store.js";
import { LEDGER_SUMMARY_SCHEMA } from "./cashflow-ledger-history-summary.js";
import {
  DEFAULT_FUTURE_PERIODS,
  DEFAULT_FX_BUFFER_PERCENT,
  NOTIFICATION_DELIVERY_TIME
} from "./cashflow-constants.js";
import { FINANCIAL_JOURNAL_SCHEMA } from "./cashflow-financial-journal.js";

export const PLANNING_SCHEMA_VERSION = 22;
/** First planning schema that holds the ledger (ledger_transactions). */
export const LEDGER_IN_PLANNING_SCHEMA_VERSION = 22;
export const LEDGER_SCHEMA_VERSION = 5;
export const PLANNING_TABLE_NAMES = [
  "settings",
  "planned_transactions",
  "recurring_expenses",
  "recurring_incomes",
  "one_off_transactions",
  "flex_transactions",
  "goals",
  "future_transactions",
  "pending_transactions",
  "fx_rates_cache",
  "ledger_currency_events",
  "backup_metadata",
  "event_log",
  "notification_queue",
  "projection_snapshots"
];
export const LEDGER_TABLE_NAMES = [
  "confirmed_transactions"
];

export function initializePlanningSchema(db) {
  db.exec(`
    PRAGMA user_version = ${PLANNING_SCHEMA_VERSION};

    CREATE TABLE fx_rates_cache (
      base_currency TEXT NOT NULL,
      quote_currency TEXT NOT NULL DEFAULT 'PLN',
      currency TEXT NOT NULL,
      rate_date TEXT NOT NULL,
      rate REAL NOT NULL CHECK (rate > 0),
      effective_date TEXT,
      source TEXT NOT NULL DEFAULT 'nbp',
      raw_json TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (base_currency, quote_currency, rate_date)
    );

    CREATE INDEX idx_fx_rates_cache_currency_date
      ON fx_rates_cache(currency, rate_date);
    CREATE INDEX idx_fx_rates_cache_pair_date
      ON fx_rates_cache(base_currency, quote_currency, rate_date);

    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ledger_currency TEXT NOT NULL DEFAULT 'PLN',
      timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw',
      locale TEXT NOT NULL DEFAULT 'en',
      holiday_country TEXT NOT NULL DEFAULT 'PL',
      future_periods INTEGER NOT NULL DEFAULT ${DEFAULT_FUTURE_PERIODS},
      minimum_reserve_enabled INTEGER NOT NULL DEFAULT 0,
      minimum_reserve_amount REAL NOT NULL DEFAULT 0 CHECK (minimum_reserve_amount >= 0),
      ledger_history_compaction_months INTEGER NOT NULL DEFAULT 0
        CHECK (ledger_history_compaction_months BETWEEN 0 AND 600),
      budget_period_income_id TEXT,
      fx_buffer_percent REAL NOT NULL DEFAULT ${DEFAULT_FX_BUFFER_PERCENT},
      fx_provider TEXT NOT NULL DEFAULT 'nbp'
        CHECK (fx_provider IN ('disabled', 'manual', 'nbp', 'frankfurter')),
      fx_used_currencies TEXT NOT NULL DEFAULT '[]',
      manual_fx_rates TEXT NOT NULL DEFAULT '{}',
      auto_backup_enabled INTEGER NOT NULL DEFAULT 0,
      backup_interval_minutes INTEGER NOT NULL DEFAULT 1440,
      backup_retention_count INTEGER NOT NULL DEFAULT 10,
      backup_location TEXT,
      notification_channel TEXT NOT NULL DEFAULT 'ntfy'
        CHECK (notification_channel IN ('ntfy', 'discord')),
      ntfy_url TEXT,
      ntfy_auth_token TEXT,
      discord_webhook_url TEXT,
      notification_channels TEXT,
      notification_delivery_time TEXT NOT NULL DEFAULT '${NOTIFICATION_DELIVERY_TIME}',
      notify_goal_impossible INTEGER NOT NULL DEFAULT 1,
      notify_necessary_underfunded INTEGER NOT NULL DEFAULT 1,
      notify_funding_shortfall INTEGER NOT NULL DEFAULT 1,
      notify_income_missing INTEGER NOT NULL DEFAULT 1,
      notify_pending_summary INTEGER NOT NULL DEFAULT 1,
      notify_goal_funded INTEGER NOT NULL DEFAULT 0,
      notify_fx_changed INTEGER NOT NULL DEFAULT 1,
      ntfy_priority_goal_impossible TEXT DEFAULT 'high',
      ntfy_priority_necessary_underfunded TEXT DEFAULT 'default',
      ntfy_priority_funding_shortfall TEXT DEFAULT 'default',
      ntfy_priority_income_missing TEXT DEFAULT 'high',
      ntfy_priority_pending_summary TEXT DEFAULT 'default',
      ntfy_priority_goal_funded TEXT DEFAULT 'default',
      ntfy_priority_fx_changed TEXT DEFAULT 'default',
      necessary_underfunded_repeat_days INTEGER NOT NULL DEFAULT 1,
      setup_completed INTEGER NOT NULL DEFAULT 0,
      setup_completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(id)
    );

    CREATE TABLE ledger_currency_events (
      id TEXT PRIMARY KEY,
      old_currency TEXT NOT NULL,
      new_currency TEXT NOT NULL,
      old_balance REAL NOT NULL,
      converted_opening_balance REAL NOT NULL,
      fx_rate REAL NOT NULL,
      rate_date TEXT NOT NULL,
      source TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE planned_transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('recurring_expense', 'flex', 'goal')),
      operating_priority INTEGER,
      goal_priority INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE recurring_expenses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount >= 0),
      prediction_strategy TEXT NOT NULL CHECK (prediction_strategy IN ('fixed', '12month_max')),
      prediction_substitute_missing TEXT NOT NULL DEFAULT 'none'
        CHECK (prediction_substitute_missing IN (
          'none',
          'starting_value',
          'average_extreme_starting_value',
          'median_recorded',
          'last_confirmed',
          'previous_year_same_month',
          'require_min_recorded_months'
        )),
      prediction_min_recorded_months INTEGER NOT NULL DEFAULT 6
        CHECK (prediction_min_recorded_months BETWEEN 1 AND 12),
      necessary INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      repeat_every_months INTEGER NOT NULL CHECK (repeat_every_months BETWEEN 1 AND 12),
      start_month_year TEXT,
      end_month_year TEXT,
      anchor_type TEXT NOT NULL CHECK (anchor_type IN ('day_of_month', 'month_end')),
      anchor_day_of_month INTEGER CHECK (
        (anchor_type = 'day_of_month' AND anchor_day_of_month BETWEEN 1 AND 31)
        OR anchor_type = 'month_end'
      ),
      anchor_offset_days INTEGER DEFAULT 0,
      anchor_business_day_adjustment TEXT DEFAULT 'none'
        CHECK (anchor_business_day_adjustment IN ('none', 'previous', 'next')),
      anchor_holiday_country TEXT DEFAULT 'PL',
      -- When set, overrides anchor_type/anchor_day_of_month: this expense
      -- occurs anchor_offset_days after the referenced recurring income's
      -- own occurrence date each cycle. See calculateNextDate().
      anchor_income_id TEXT,
      planned_transaction_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (planned_transaction_id) REFERENCES planned_transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE recurring_incomes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount >= 0),
      prediction_strategy TEXT NOT NULL CHECK (prediction_strategy IN ('fixed', '12month_min')),
      prediction_substitute_missing TEXT NOT NULL DEFAULT 'none'
        CHECK (prediction_substitute_missing IN (
          'none',
          'starting_value',
          'average_extreme_starting_value',
          'median_recorded',
          'last_confirmed',
          'previous_year_same_month',
          'require_min_recorded_months'
        )),
      prediction_min_recorded_months INTEGER NOT NULL DEFAULT 6
        CHECK (prediction_min_recorded_months BETWEEN 1 AND 12),
      active INTEGER NOT NULL DEFAULT 1,
      repeat_every_months INTEGER NOT NULL CHECK (repeat_every_months BETWEEN 1 AND 12),
      start_month_year TEXT,
      end_month_year TEXT,
      anchor_type TEXT NOT NULL CHECK (anchor_type IN ('day_of_month', 'month_end')),
      anchor_day_of_month INTEGER CHECK (
        (anchor_type = 'day_of_month' AND anchor_day_of_month BETWEEN 1 AND 31)
        OR anchor_type = 'month_end'
      ),
      anchor_offset_days INTEGER DEFAULT 0,
      anchor_business_day_adjustment TEXT DEFAULT 'none'
        CHECK (anchor_business_day_adjustment IN ('none', 'previous', 'next')),
      anchor_holiday_country TEXT DEFAULT 'PL',
      period_setting INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE flex_transactions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount >= 0),
      active INTEGER NOT NULL DEFAULT 1,
      allow_split INTEGER NOT NULL DEFAULT 0,
      min_amount REAL,
      max_amount REAL,
      planned_transaction_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (planned_transaction_id) REFERENCES planned_transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE goals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      active INTEGER NOT NULL DEFAULT 1,
      due_date TEXT NOT NULL,
      planned_transaction_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (planned_transaction_id) REFERENCES planned_transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE one_off_transactions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL CHECK (amount >= 0),
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE pending_transactions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'goal_allocation')),
      date TEXT NOT NULL,
      source_recurring_expense_id TEXT,
      source_recurring_income_id TEXT,
      source_one_off_id TEXT,
      source_flex_id TEXT,
      source_goal_id TEXT,
      fx_rate REAL,
      buffered_fx_rate REAL,
      ledger_currency TEXT NOT NULL DEFAULT 'PLN',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'partial', 'underfunded', 'funded')),
      funded_amount REAL,
      requested_amount REAL,
      ledger_amount REAL,
      running_balance REAL,
      pending_origin TEXT NOT NULL DEFAULT 'projection'
        CHECK (pending_origin IN ('projection', 'scheduled', 'manual', 'system')),
      note TEXT,
      occurrence_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (source_recurring_expense_id) REFERENCES recurring_expenses(id),
      FOREIGN KEY (source_recurring_income_id) REFERENCES recurring_incomes(id),
      FOREIGN KEY (source_one_off_id) REFERENCES one_off_transactions(id),
      FOREIGN KEY (source_flex_id) REFERENCES flex_transactions(id),
      FOREIGN KEY (source_goal_id) REFERENCES goals(id)
    );

    CREATE TABLE future_transactions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'goal_allocation')),
      date TEXT NOT NULL,
      period TEXT NOT NULL,
      source_recurring_expense_id TEXT,
      source_recurring_income_id TEXT,
      source_one_off_id TEXT,
      source_flex_id TEXT,
      source_goal_id TEXT,
      fx_rate REAL,
      buffered_fx_rate REAL,
      ledger_currency TEXT NOT NULL DEFAULT 'PLN',
      requested_amount REAL,
      funded_amount REAL,
      ledger_amount REAL,
      running_balance REAL,
      status TEXT NOT NULL DEFAULT 'funded'
        CHECK (status IN ('funded', 'partial', 'underfunded')),
      note TEXT,
      occurrence_key TEXT,
      generation_timestamp TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (source_recurring_expense_id) REFERENCES recurring_expenses(id),
      FOREIGN KEY (source_recurring_income_id) REFERENCES recurring_incomes(id),
      FOREIGN KEY (source_one_off_id) REFERENCES one_off_transactions(id),
      FOREIGN KEY (source_flex_id) REFERENCES flex_transactions(id),
      FOREIGN KEY (source_goal_id) REFERENCES goals(id)
    );

    CREATE TABLE event_log (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE projection_snapshots (
      id TEXT PRIMARY KEY,
      snapshot_timestamp TEXT NOT NULL,
      total_projected_income REAL NOT NULL,
      total_projected_expenses REAL NOT NULL,
      available_balance REAL NOT NULL,
      fx_rates_used TEXT NOT NULL,
      ledger_currency TEXT NOT NULL DEFAULT 'PLN',
      generation_succeeded INTEGER NOT NULL,
      warning_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE notification_queue (
      id TEXT PRIMARY KEY,
      notification_type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'default',
      entity_id TEXT,
      queued_at TEXT NOT NULL,
      sent_at TEXT,
      sent_channels TEXT NOT NULL DEFAULT '',
      dedupe_key TEXT UNIQUE
    );

    CREATE TABLE backup_metadata (
      id TEXT PRIMARY KEY,
      backup_timestamp TEXT NOT NULL,
      backup_path TEXT NOT NULL,
      size_bytes INTEGER,
      success INTEGER NOT NULL,
      error_message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_future_date ON future_transactions(date);
    CREATE INDEX idx_future_period ON future_transactions(period);
    CREATE INDEX idx_future_occurrence_key ON future_transactions(occurrence_key);
    CREATE INDEX idx_future_source_recurring_expense ON future_transactions(source_recurring_expense_id);
    CREATE INDEX idx_future_source_recurring_income ON future_transactions(source_recurring_income_id);
    CREATE INDEX idx_future_source_one_off ON future_transactions(source_one_off_id);
    CREATE INDEX idx_future_source_goal ON future_transactions(source_goal_id);
    CREATE INDEX idx_future_source_flex ON future_transactions(source_flex_id);

    CREATE INDEX idx_pending_date ON pending_transactions(date);
    CREATE INDEX idx_pending_source_recurring_expense ON pending_transactions(source_recurring_expense_id);
    CREATE INDEX idx_pending_source_recurring_income ON pending_transactions(source_recurring_income_id);
    CREATE INDEX idx_pending_source_one_off ON pending_transactions(source_one_off_id);
    CREATE INDEX idx_pending_source_goal ON pending_transactions(source_goal_id);
    CREATE INDEX idx_pending_source_flex ON pending_transactions(source_flex_id);
    CREATE UNIQUE INDEX idx_pending_occurrence_key
      ON pending_transactions(occurrence_key)
      WHERE occurrence_key IS NOT NULL;

    CREATE INDEX idx_event_action_entity ON event_log(action, entity_id);
    CREATE INDEX idx_notification_unsent ON notification_queue(sent_at);

    INSERT INTO settings (id, ledger_currency, updated_at)
    VALUES (1, 'PLN', datetime('now'));
  `);
  db.exec(FINANCIAL_JOURNAL_SCHEMA);
  db.exec(LEDGER_SUMMARY_SCHEMA);
  db.exec(LEDGER_AUDIT_SCHEMA);
  db.exec(LEDGER_ORIGIN_SCHEMA);
  db.exec(LEDGER_IN_PLANNING_SCHEMA);
  db.prepare("INSERT INTO ledger_merge_state (id, merged_at) VALUES (1, datetime('now'))").run();
}

/** Schema 22: the ledger lives in planning.sqlite, so a financial commit that
 * touches sources, pending rows, ledger and the sync journal is one SQLite
 * transaction (as on PostgreSQL). ledger_merge_state marks completed imports
 * of legacy yearly ledger files. */
export const LEDGER_IN_PLANNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_transactions (
  id TEXT PRIMARY KEY,
  ledger_year INTEGER NOT NULL CHECK (ledger_year BETWEEN 1 AND 9999),
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  date TEXT NOT NULL,
  confirmed_date TEXT NOT NULL,
  fx_rate REAL,
  buffered_fx_rate REAL,
  ledger_currency TEXT NOT NULL DEFAULT 'PLN',
  running_balance_pln REAL NOT NULL,
  ledger_amount REAL,
  source_recurring_expense_id TEXT,
  source_recurring_income_id TEXT,
  source_one_off_id TEXT,
  source_flex_id TEXT,
  source_goal_id TEXT,
  occurrence_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_year ON ledger_transactions(ledger_year);
CREATE INDEX IF NOT EXISTS idx_ledger_date ON ledger_transactions(date);
CREATE INDEX IF NOT EXISTS idx_ledger_occurrence_key ON ledger_transactions(occurrence_key);
CREATE INDEX IF NOT EXISTS idx_ledger_source_one_off ON ledger_transactions(source_one_off_id);
CREATE INDEX IF NOT EXISTS idx_ledger_source_goal ON ledger_transactions(source_goal_id);
CREATE INDEX IF NOT EXISTS idx_ledger_source_flex ON ledger_transactions(source_flex_id);
CREATE INDEX IF NOT EXISTS idx_ledger_source_recurring_income ON ledger_transactions(source_recurring_income_id);
CREATE INDEX IF NOT EXISTS idx_ledger_source_recurring_expense ON ledger_transactions(source_recurring_expense_id);
CREATE TABLE IF NOT EXISTS ledger_merge_state (id INTEGER PRIMARY KEY CHECK (id = 1), merged_at TEXT NOT NULL);`;

/** Columns of the legacy yearly confirmed_transactions table, in order. */
export const LEDGER_COLUMNS = ["id", "name", "currency", "amount", "type", "date", "confirmed_date", "fx_rate", "buffered_fx_rate",
  "ledger_currency", "running_balance_pln", "ledger_amount", "source_recurring_expense_id", "source_recurring_income_id",
  "source_one_off_id", "source_flex_id", "source_goal_id", "occurrence_key", "created_at", "updated_at"];

/** SQL that (re)points the temporary `confirmed_transactions` view of a
 * planning connection at one ledger year. INSTEAD OF triggers write through to
 * ledger_transactions with that year; they are unqualified because SQLite
 * forbids schema prefixes inside trigger bodies (the table lives only in main).
 * Legacy per-year SQL keeps working, and every ledger write shares the planning
 * file's locks and transactions. */
export function ledgerYearViewSql(year) {
  const ledgerYear = Number(year);
  if (!Number.isInteger(ledgerYear) || ledgerYear < 1 || ledgerYear > 9999) throw new Error("Invalid ledger year");
  const columns = LEDGER_COLUMNS.join(", ");
  const defaults = { ledger_currency: "'PLN'", running_balance_pln: "0" };
  const values = LEDGER_COLUMNS.map(column => defaults[column] ? `COALESCE(NEW.${column}, ${defaults[column]})` : `NEW.${column}`).join(", ");
  return `
    DROP VIEW IF EXISTS temp.confirmed_transactions;
    CREATE TEMP VIEW confirmed_transactions AS SELECT ${columns} FROM main.ledger_transactions WHERE ledger_year = ${ledgerYear};
    CREATE TEMP TRIGGER confirmed_transactions_insert INSTEAD OF INSERT ON confirmed_transactions
    BEGIN INSERT INTO ledger_transactions (${columns}, ledger_year) VALUES (${values}, ${ledgerYear}); END;
    CREATE TEMP TRIGGER confirmed_transactions_update INSTEAD OF UPDATE ON confirmed_transactions
    BEGIN UPDATE ledger_transactions SET ${LEDGER_COLUMNS.map(column => `${column} = NEW.${column}`).join(", ")}
      WHERE id = OLD.id AND ledger_year = ${ledgerYear}; END;
    CREATE TEMP TRIGGER confirmed_transactions_delete INSTEAD OF DELETE ON confirmed_transactions
    BEGIN DELETE FROM ledger_transactions WHERE id = OLD.id AND ledger_year = ${ledgerYear}; END;`;
}

export function initializeLedgerSchema(db) {
  db.exec(`
    PRAGMA user_version = ${LEDGER_SCHEMA_VERSION};

    CREATE TABLE confirmed_transactions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
      date TEXT NOT NULL,
      confirmed_date TEXT NOT NULL,
      fx_rate REAL,
      buffered_fx_rate REAL,
      ledger_currency TEXT NOT NULL DEFAULT 'PLN',
      running_balance_pln REAL NOT NULL,
      ledger_amount REAL,
      source_recurring_expense_id TEXT,
      source_recurring_income_id TEXT,
      source_one_off_id TEXT,
      source_flex_id TEXT,
      source_goal_id TEXT,
      occurrence_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX idx_confirmed_date ON confirmed_transactions(date);
    CREATE INDEX idx_confirmed_confirmed_date ON confirmed_transactions(confirmed_date);
    CREATE INDEX idx_confirmed_source_recurring_expense ON confirmed_transactions(source_recurring_expense_id);
    CREATE INDEX idx_confirmed_source_recurring_income ON confirmed_transactions(source_recurring_income_id);
    CREATE INDEX idx_confirmed_source_one_off ON confirmed_transactions(source_one_off_id);
    CREATE INDEX idx_confirmed_source_goal ON confirmed_transactions(source_goal_id);
    CREATE INDEX idx_confirmed_source_flex ON confirmed_transactions(source_flex_id);
    CREATE INDEX idx_confirmed_occurrence_key ON confirmed_transactions(occurrence_key);
  `);
}

