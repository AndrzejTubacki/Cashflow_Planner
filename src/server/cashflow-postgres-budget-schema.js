import {
  LEDGER_SCHEMA_VERSION,
  LEDGER_TABLE_NAMES,
  PLANNING_SCHEMA_VERSION,
  PLANNING_TABLE_NAMES
} from "./cashflow-schema.js";

export const POSTGRES_PLANNING_SCHEMA_VERSION = PLANNING_SCHEMA_VERSION;
export const POSTGRES_LEDGER_SCHEMA_VERSION = LEDGER_SCHEMA_VERSION;
export const POSTGRES_BUDGET_PLANNING_TABLES = [...PLANNING_TABLE_NAMES];
export const POSTGRES_BUDGET_LEDGER_TABLES = [...LEDGER_TABLE_NAMES];
export const POSTGRES_BUDGET_TABLES = [
  ...POSTGRES_BUDGET_PLANNING_TABLES,
  ...POSTGRES_BUDGET_LEDGER_TABLES
];

export const POSTGRES_BUDGET_COLUMNS = {
  settings: [
    "budget_id",
    "id",
    "ledger_currency",
    "timezone",
    "locale",
    "holiday_country",
    "future_periods",
    "minimum_reserve_enabled",
    "minimum_reserve_amount",
    "ledger_history_compaction_months",
    "budget_period_income_id",
    "fx_buffer_percent",
    "fx_provider",
    "fx_used_currencies",
    "manual_fx_rates",
    "auto_backup_enabled",
    "backup_interval_minutes",
    "backup_retention_count",
    "backup_location",
    "notification_channel",
    "ntfy_url",
    "ntfy_auth_token",
    "discord_webhook_url",
    "notification_delivery_time",
    "notify_goal_impossible",
    "notify_necessary_underfunded",
    "notify_funding_shortfall",
    "notify_income_missing",
    "notify_pending_summary",
    "notify_goal_funded",
    "notify_fx_changed",
    "ntfy_priority_goal_impossible",
    "ntfy_priority_necessary_underfunded",
    "ntfy_priority_funding_shortfall",
    "ntfy_priority_income_missing",
    "ntfy_priority_pending_summary",
    "ntfy_priority_goal_funded",
    "ntfy_priority_fx_changed",
    "necessary_underfunded_repeat_days",
    "setup_completed",
    "setup_completed_at",
    "updated_at"
  ],
  planned_transactions: [
    "budget_id",
    "id",
    "type",
    "operating_priority",
    "goal_priority",
    "created_at",
    "updated_at"
  ],
  recurring_expenses: [
    "budget_id",
    "id",
    "name",
    "currency",
    "amount",
    "prediction_strategy",
    "prediction_substitute_missing",
    "prediction_min_recorded_months",
    "necessary",
    "active",
    "repeat_every_months",
    "start_month_year",
    "anchor_type",
    "anchor_day_of_month",
    "anchor_offset_days",
    "anchor_business_day_adjustment",
    "anchor_holiday_country",
    "planned_transaction_id",
    "created_at",
    "updated_at"
  ],
  recurring_incomes: [
    "budget_id",
    "id",
    "name",
    "currency",
    "amount",
    "prediction_strategy",
    "prediction_substitute_missing",
    "prediction_min_recorded_months",
    "active",
    "repeat_every_months",
    "start_month_year",
    "anchor_type",
    "anchor_day_of_month",
    "anchor_offset_days",
    "anchor_business_day_adjustment",
    "anchor_holiday_country",
    "period_setting",
    "created_at",
    "updated_at"
  ],
  one_off_transactions: [
    "budget_id",
    "id",
    "name",
    "currency",
    "amount",
    "type",
    "date",
    "created_at",
    "updated_at"
  ],
  flex_transactions: [
    "budget_id",
    "id",
    "name",
    "currency",
    "amount",
    "active",
    "allow_split",
    "min_amount",
    "max_amount",
    "planned_transaction_id",
    "created_at",
    "updated_at"
  ],
  goals: [
    "budget_id",
    "id",
    "name",
    "currency",
    "amount",
    "active",
    "due_date",
    "planned_transaction_id",
    "created_at",
    "updated_at"
  ],
  future_transactions: [
    "budget_id",
    "id",
    "name",
    "currency",
    "amount",
    "type",
    "date",
    "period",
    "source_recurring_expense_id",
    "source_recurring_income_id",
    "source_one_off_id",
    "source_flex_id",
    "source_goal_id",
    "fx_rate",
    "buffered_fx_rate",
    "ledger_currency",
    "requested_amount",
    "funded_amount",
    "ledger_amount",
    "running_balance",
    "status",
    "note",
    "occurrence_key",
    "generation_timestamp",
    "created_at"
  ],
  pending_transactions: [
    "budget_id",
    "id",
    "name",
    "currency",
    "amount",
    "type",
    "date",
    "source_recurring_expense_id",
    "source_recurring_income_id",
    "source_one_off_id",
    "source_flex_id",
    "source_goal_id",
    "fx_rate",
    "buffered_fx_rate",
    "ledger_currency",
    "status",
    "funded_amount",
    "requested_amount",
    "ledger_amount",
    "running_balance",
    "pending_origin",
    "note",
    "occurrence_key",
    "created_at",
    "updated_at"
  ],
  fx_rates_cache: [
    "budget_id",
    "base_currency",
    "quote_currency",
    "currency",
    "rate_date",
    "rate",
    "effective_date",
    "source",
    "raw_json",
    "updated_at"
  ],
  ledger_currency_events: [
    "budget_id",
    "id",
    "old_currency",
    "new_currency",
    "old_balance",
    "converted_opening_balance",
    "fx_rate",
    "rate_date",
    "source",
    "details",
    "created_at"
  ],
  backup_metadata: [
    "budget_id",
    "id",
    "backup_timestamp",
    "backup_path",
    "size_bytes",
    "success",
    "error_message",
    "created_at"
  ],
  event_log: [
    "budget_id",
    "id",
    "action",
    "entity_type",
    "entity_id",
    "details",
    "timestamp"
  ],
  notification_queue: [
    "budget_id",
    "id",
    "notification_type",
    "title",
    "message",
    "priority",
    "entity_id",
    "queued_at",
    "sent_at",
    "dedupe_key"
  ],
  projection_snapshots: [
    "budget_id",
    "id",
    "snapshot_timestamp",
    "total_projected_income",
    "total_projected_expenses",
    "available_balance",
    "fx_rates_used",
    "ledger_currency",
    "generation_succeeded",
    "warning_count",
    "created_at"
  ],
  confirmed_transactions: [
    "budget_id",
    "ledger_year",
    "id",
    "name",
    "currency",
    "amount",
    "type",
    "date",
    "confirmed_date",
    "fx_rate",
    "buffered_fx_rate",
    "ledger_currency",
    "running_balance_pln",
    "ledger_amount",
    "source_recurring_expense_id",
    "source_recurring_income_id",
    "source_one_off_id",
    "source_flex_id",
    "source_goal_id",
    "occurrence_key",
    "created_at",
    "updated_at"
  ]
};

const POSTGRES_BUDGET_SCHEMA_BODY = `
CREATE TABLE IF NOT EXISTS cashflow_budget_schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  planning_version INTEGER NOT NULL,
  ledger_version INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id INTEGER NOT NULL DEFAULT 1 CHECK (id = 1),
  ledger_currency TEXT NOT NULL DEFAULT 'PLN',
  timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw',
  locale TEXT NOT NULL DEFAULT 'en',
  holiday_country TEXT NOT NULL DEFAULT 'PL',
  future_periods INTEGER NOT NULL DEFAULT 11,
  minimum_reserve_enabled BOOLEAN NOT NULL DEFAULT false,
  minimum_reserve_amount DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (minimum_reserve_amount >= 0),
  ledger_history_compaction_months INTEGER NOT NULL DEFAULT 0
    CHECK (ledger_history_compaction_months BETWEEN 0 AND 600),
  budget_period_income_id TEXT,
  fx_buffer_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
  fx_provider TEXT NOT NULL DEFAULT 'nbp'
    CHECK (fx_provider IN ('disabled', 'manual', 'nbp', 'frankfurter')),
  fx_used_currencies JSONB NOT NULL DEFAULT '[]'::jsonb,
  manual_fx_rates JSONB NOT NULL DEFAULT '{}'::jsonb,
  auto_backup_enabled BOOLEAN NOT NULL DEFAULT false,
  backup_interval_minutes INTEGER NOT NULL DEFAULT 1440,
  backup_retention_count INTEGER NOT NULL DEFAULT 10,
  backup_location TEXT,
  notification_channel TEXT NOT NULL DEFAULT 'ntfy'
    CHECK (notification_channel IN ('ntfy', 'discord')),
  ntfy_url TEXT,
  ntfy_auth_token TEXT,
  discord_webhook_url TEXT,
  notification_delivery_time TEXT NOT NULL DEFAULT '08:00'
    CHECK (notification_delivery_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  notify_goal_impossible BOOLEAN NOT NULL DEFAULT true,
  notify_necessary_underfunded BOOLEAN NOT NULL DEFAULT true,
  notify_funding_shortfall BOOLEAN NOT NULL DEFAULT true,
  notify_income_missing BOOLEAN NOT NULL DEFAULT true,
  notify_pending_summary BOOLEAN NOT NULL DEFAULT true,
  notify_goal_funded BOOLEAN NOT NULL DEFAULT false,
  notify_fx_changed BOOLEAN NOT NULL DEFAULT true,
  ntfy_priority_goal_impossible TEXT DEFAULT 'high',
  ntfy_priority_necessary_underfunded TEXT DEFAULT 'default',
  ntfy_priority_funding_shortfall TEXT DEFAULT 'default',
  ntfy_priority_income_missing TEXT DEFAULT 'high',
  ntfy_priority_pending_summary TEXT DEFAULT 'default',
  ntfy_priority_goal_funded TEXT DEFAULT 'default',
  ntfy_priority_fx_changed TEXT DEFAULT 'default',
  necessary_underfunded_repeat_days INTEGER NOT NULL DEFAULT 1,
  setup_completed BOOLEAN NOT NULL DEFAULT false,
  setup_completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id)
);

CREATE TABLE IF NOT EXISTS planned_transactions (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('recurring_expense', 'flex', 'goal')),
  operating_priority INTEGER,
  goal_priority INTEGER,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id)
);

CREATE TABLE IF NOT EXISTS recurring_expenses (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL CHECK (amount >= 0),
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
  necessary BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  repeat_every_months INTEGER NOT NULL CHECK (repeat_every_months BETWEEN 1 AND 12),
  start_month_year TEXT CHECK (start_month_year IS NULL OR start_month_year ~ '^\\d{4}-\\d{2}$'),
  anchor_type TEXT NOT NULL CHECK (anchor_type IN ('day_of_month', 'month_end')),
  anchor_day_of_month INTEGER CHECK (
    (anchor_type = 'day_of_month' AND anchor_day_of_month BETWEEN 1 AND 31)
    OR anchor_type = 'month_end'
  ),
  anchor_offset_days INTEGER DEFAULT 0,
  anchor_business_day_adjustment TEXT DEFAULT 'none'
    CHECK (anchor_business_day_adjustment IN ('none', 'previous', 'next')),
  anchor_holiday_country TEXT DEFAULT 'PL',
  planned_transaction_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id),
  UNIQUE (budget_id, planned_transaction_id),
  FOREIGN KEY (budget_id, planned_transaction_id)
    REFERENCES planned_transactions(budget_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recurring_incomes (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL CHECK (amount >= 0),
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
  active BOOLEAN NOT NULL DEFAULT true,
  repeat_every_months INTEGER NOT NULL CHECK (repeat_every_months BETWEEN 1 AND 12),
  start_month_year TEXT CHECK (start_month_year IS NULL OR start_month_year ~ '^\\d{4}-\\d{2}$'),
  anchor_type TEXT NOT NULL CHECK (anchor_type IN ('day_of_month', 'month_end')),
  anchor_day_of_month INTEGER CHECK (
    (anchor_type = 'day_of_month' AND anchor_day_of_month BETWEEN 1 AND 31)
    OR anchor_type = 'month_end'
  ),
  anchor_offset_days INTEGER DEFAULT 0,
  anchor_business_day_adjustment TEXT DEFAULT 'none'
    CHECK (anchor_business_day_adjustment IN ('none', 'previous', 'next')),
  anchor_holiday_country TEXT DEFAULT 'PL',
  period_setting BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id)
);

CREATE TABLE IF NOT EXISTS one_off_transactions (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL CHECK (amount >= 0),
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id)
);

CREATE TABLE IF NOT EXISTS flex_transactions (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL CHECK (amount >= 0),
  active BOOLEAN NOT NULL DEFAULT true,
  allow_split BOOLEAN NOT NULL DEFAULT false,
  min_amount DOUBLE PRECISION,
  max_amount DOUBLE PRECISION,
  planned_transaction_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id),
  UNIQUE (budget_id, planned_transaction_id),
  FOREIGN KEY (budget_id, planned_transaction_id)
    REFERENCES planned_transactions(budget_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS goals (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
  active BOOLEAN NOT NULL DEFAULT true,
  due_date DATE NOT NULL,
  planned_transaction_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id),
  UNIQUE (budget_id, planned_transaction_id),
  FOREIGN KEY (budget_id, planned_transaction_id)
    REFERENCES planned_transactions(budget_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pending_transactions (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'goal_allocation')),
  date DATE NOT NULL,
  source_recurring_expense_id TEXT,
  source_recurring_income_id TEXT,
  source_one_off_id TEXT,
  source_flex_id TEXT,
  source_goal_id TEXT,
  fx_rate DOUBLE PRECISION,
  buffered_fx_rate DOUBLE PRECISION,
  ledger_currency TEXT NOT NULL DEFAULT 'PLN',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'partial', 'underfunded', 'funded')),
  funded_amount DOUBLE PRECISION,
  requested_amount DOUBLE PRECISION,
  ledger_amount DOUBLE PRECISION,
  running_balance DOUBLE PRECISION,
  pending_origin TEXT NOT NULL DEFAULT 'projection'
    CHECK (pending_origin IN ('projection', 'scheduled', 'manual', 'system')),
  note TEXT,
  occurrence_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id),
  -- Deferred so a whole-budget restore/import can replace every planning
  -- table inside one transaction regardless of write order: a pending or
  -- future row and the recurring/one-off/flex/goal row it points to are
  -- deleted-and-reinserted independently, and an immediate (non-deferred)
  -- check would reject the delete of the still-referenced parent row before
  -- the transaction has a chance to reinsert it. See cashflow-budget-store-
  -- snapshot.js's restoreBudgetStoreSnapshot for the multi-table replace.
  FOREIGN KEY (budget_id, source_recurring_expense_id)
    REFERENCES recurring_expenses(budget_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (budget_id, source_recurring_income_id)
    REFERENCES recurring_incomes(budget_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (budget_id, source_one_off_id)
    REFERENCES one_off_transactions(budget_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (budget_id, source_flex_id)
    REFERENCES flex_transactions(budget_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (budget_id, source_goal_id)
    REFERENCES goals(budget_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS future_transactions (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense', 'goal_allocation')),
  date DATE NOT NULL,
  -- "period" is a budget period's key, computed by buildBudgetPeriods() in
  -- cashflow-period-utils.js, and it has two legitimate shapes depending on
  -- whether the budget has a period-anchor income configured: plain
  -- "YYYY-MM" for calendar-month periods (no anchor income), or the full
  -- "YYYY-MM-DD" anchor start date (from calculateNextDate()) when a
  -- "repeat every N months" income anchors periods to a specific day that
  -- doesn't align with calendar months. The SQLite schema stores this as
  -- plain TEXT with no format constraint. This CHECK previously assumed
  -- only the "YYYY-MM" shape, rejecting every future_transactions insert
  -- once a real period-anchor income was involved; a first attempt at
  -- fixing it assumed only the "YYYY-MM-DD" shape and broke the *other*
  -- real case instead — both were only caught by live/real-Postgres runs,
  -- not by review, because each shape is only produced by a different
  -- settings combination.
  period TEXT NOT NULL CHECK (period ~ '^\\d{4}-\\d{2}(-\\d{2})?$'),
  source_recurring_expense_id TEXT,
  source_recurring_income_id TEXT,
  source_one_off_id TEXT,
  source_flex_id TEXT,
  source_goal_id TEXT,
  fx_rate DOUBLE PRECISION,
  buffered_fx_rate DOUBLE PRECISION,
  ledger_currency TEXT NOT NULL DEFAULT 'PLN',
  requested_amount DOUBLE PRECISION,
  funded_amount DOUBLE PRECISION,
  ledger_amount DOUBLE PRECISION,
  running_balance DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'funded'
    CHECK (status IN ('funded', 'partial', 'underfunded')),
  note TEXT,
  occurrence_key TEXT,
  generation_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id),
  -- Deferred so a whole-budget restore/import can replace every planning
  -- table inside one transaction regardless of write order: a pending or
  -- future row and the recurring/one-off/flex/goal row it points to are
  -- deleted-and-reinserted independently, and an immediate (non-deferred)
  -- check would reject the delete of the still-referenced parent row before
  -- the transaction has a chance to reinsert it. See cashflow-budget-store-
  -- snapshot.js's restoreBudgetStoreSnapshot for the multi-table replace.
  FOREIGN KEY (budget_id, source_recurring_expense_id)
    REFERENCES recurring_expenses(budget_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (budget_id, source_recurring_income_id)
    REFERENCES recurring_incomes(budget_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (budget_id, source_one_off_id)
    REFERENCES one_off_transactions(budget_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (budget_id, source_flex_id)
    REFERENCES flex_transactions(budget_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (budget_id, source_goal_id)
    REFERENCES goals(budget_id, id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS fx_rates_cache (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL DEFAULT 'PLN',
  currency TEXT NOT NULL,
  rate_date DATE NOT NULL,
  rate DOUBLE PRECISION NOT NULL CHECK (rate > 0),
  effective_date DATE,
  source TEXT NOT NULL DEFAULT 'nbp',
  raw_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, base_currency, quote_currency, rate_date)
);

CREATE TABLE IF NOT EXISTS ledger_currency_events (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  old_currency TEXT NOT NULL,
  new_currency TEXT NOT NULL,
  old_balance DOUBLE PRECISION NOT NULL,
  converted_opening_balance DOUBLE PRECISION NOT NULL,
  fx_rate DOUBLE PRECISION NOT NULL,
  rate_date DATE NOT NULL,
  source TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id)
);

CREATE TABLE IF NOT EXISTS backup_metadata (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  backup_timestamp TIMESTAMPTZ NOT NULL,
  backup_path TEXT NOT NULL,
  size_bytes BIGINT,
  success BOOLEAN NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id)
);

CREATE TABLE IF NOT EXISTS event_log (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details JSONB,
  timestamp TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id)
);

CREATE TABLE IF NOT EXISTS notification_queue (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'default',
  entity_id TEXT,
  queued_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  dedupe_key TEXT,
  PRIMARY KEY (budget_id, id)
);

CREATE TABLE IF NOT EXISTS projection_snapshots (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  snapshot_timestamp TIMESTAMPTZ NOT NULL,
  total_projected_income DOUBLE PRECISION NOT NULL,
  total_projected_expenses DOUBLE PRECISION NOT NULL,
  available_balance DOUBLE PRECISION NOT NULL,
  fx_rates_used JSONB NOT NULL,
  ledger_currency TEXT NOT NULL DEFAULT 'PLN',
  generation_succeeded BOOLEAN NOT NULL,
  warning_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, id)
);

CREATE TABLE IF NOT EXISTS confirmed_transactions (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  ledger_year INTEGER NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  date DATE NOT NULL,
  confirmed_date DATE NOT NULL,
  fx_rate DOUBLE PRECISION,
  buffered_fx_rate DOUBLE PRECISION,
  ledger_currency TEXT NOT NULL DEFAULT 'PLN',
  running_balance_pln DOUBLE PRECISION NOT NULL,
  ledger_amount DOUBLE PRECISION,
  source_recurring_expense_id TEXT,
  source_recurring_income_id TEXT,
  source_one_off_id TEXT,
  source_flex_id TEXT,
  source_goal_id TEXT,
  occurrence_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, ledger_year, id),
  CHECK (ledger_year = EXTRACT(YEAR FROM confirmed_date)::INTEGER)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settings_budget_period_income_fk'
  ) THEN
    ALTER TABLE settings
      ADD CONSTRAINT settings_budget_period_income_fk
      FOREIGN KEY (budget_id, budget_period_income_id)
      REFERENCES recurring_incomes(budget_id, id) ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_future_budget_date ON future_transactions(budget_id, date);
CREATE INDEX IF NOT EXISTS idx_future_budget_period ON future_transactions(budget_id, period);
CREATE INDEX IF NOT EXISTS idx_future_budget_occurrence_key ON future_transactions(budget_id, occurrence_key);
CREATE INDEX IF NOT EXISTS idx_future_budget_source_recurring_expense ON future_transactions(budget_id, source_recurring_expense_id);
CREATE INDEX IF NOT EXISTS idx_future_budget_source_recurring_income ON future_transactions(budget_id, source_recurring_income_id);
CREATE INDEX IF NOT EXISTS idx_future_budget_source_one_off ON future_transactions(budget_id, source_one_off_id);
CREATE INDEX IF NOT EXISTS idx_future_budget_source_goal ON future_transactions(budget_id, source_goal_id);
CREATE INDEX IF NOT EXISTS idx_future_budget_source_flex ON future_transactions(budget_id, source_flex_id);

CREATE INDEX IF NOT EXISTS idx_pending_budget_date ON pending_transactions(budget_id, date);
CREATE INDEX IF NOT EXISTS idx_pending_budget_source_recurring_expense ON pending_transactions(budget_id, source_recurring_expense_id);
CREATE INDEX IF NOT EXISTS idx_pending_budget_source_recurring_income ON pending_transactions(budget_id, source_recurring_income_id);
CREATE INDEX IF NOT EXISTS idx_pending_budget_source_one_off ON pending_transactions(budget_id, source_one_off_id);
CREATE INDEX IF NOT EXISTS idx_pending_budget_source_goal ON pending_transactions(budget_id, source_goal_id);
CREATE INDEX IF NOT EXISTS idx_pending_budget_source_flex ON pending_transactions(budget_id, source_flex_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_budget_occurrence_key
  ON pending_transactions(budget_id, occurrence_key)
  WHERE occurrence_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fx_rates_cache_budget_currency_date ON fx_rates_cache(budget_id, currency, rate_date);
CREATE INDEX IF NOT EXISTS idx_fx_rates_cache_budget_pair_date ON fx_rates_cache(budget_id, base_currency, quote_currency, rate_date);
CREATE INDEX IF NOT EXISTS idx_event_budget_action_entity ON event_log(budget_id, action, entity_id);
CREATE INDEX IF NOT EXISTS idx_notification_budget_unsent ON notification_queue(budget_id, sent_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_budget_dedupe
  ON notification_queue(budget_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projection_snapshots_budget_created ON projection_snapshots(budget_id, created_at);

CREATE INDEX IF NOT EXISTS idx_confirmed_budget_date ON confirmed_transactions(budget_id, date);
CREATE INDEX IF NOT EXISTS idx_confirmed_budget_confirmed_date ON confirmed_transactions(budget_id, confirmed_date);
CREATE INDEX IF NOT EXISTS idx_confirmed_budget_source_recurring_expense ON confirmed_transactions(budget_id, source_recurring_expense_id);
CREATE INDEX IF NOT EXISTS idx_confirmed_budget_source_recurring_income ON confirmed_transactions(budget_id, source_recurring_income_id);
CREATE INDEX IF NOT EXISTS idx_confirmed_budget_source_one_off ON confirmed_transactions(budget_id, source_one_off_id);
CREATE INDEX IF NOT EXISTS idx_confirmed_budget_source_goal ON confirmed_transactions(budget_id, source_goal_id);
CREATE INDEX IF NOT EXISTS idx_confirmed_budget_source_flex ON confirmed_transactions(budget_id, source_flex_id);
CREATE INDEX IF NOT EXISTS idx_confirmed_budget_occurrence_key ON confirmed_transactions(budget_id, occurrence_key);

INSERT INTO cashflow_budget_schema_version (
  id, planning_version, ledger_version, applied_at
)
VALUES (
  1, ${POSTGRES_PLANNING_SCHEMA_VERSION}, ${POSTGRES_LEDGER_SCHEMA_VERSION}, now()
)
ON CONFLICT (id) DO UPDATE SET
  planning_version = EXCLUDED.planning_version,
  ledger_version = EXCLUDED.ledger_version,
  applied_at = EXCLUDED.applied_at;
`;

export function createPostgresBudgetStorageSchemaSql({
  includeTransaction = true
} = {}) {
  const body = POSTGRES_BUDGET_SCHEMA_BODY.trim();
  if (!includeTransaction) return `${body}\n`;
  return `BEGIN;\n\n${body}\n\nCOMMIT;\n`;
}
