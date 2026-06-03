export function applyLedgerMigrations(db, {
  occurrenceKeyFromRow
}) {
  const currentVersion = db.pragma("user_version", { simple: true });

  const columns = (tableName) =>
    db.prepare(`PRAGMA table_info(${tableName})`).all().map(col => col.name);

  const addColumnIfMissing = (tableName, columnName, ddl) => {
    if (!columns(tableName).includes(columnName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
    }
  };

  db.transaction(() => {
    if (currentVersion < 2) {
      addColumnIfMissing("confirmed_transactions", "source_flex_id", "source_flex_id TEXT");
      addColumnIfMissing("confirmed_transactions", "source_goal_id", "source_goal_id TEXT");
      addColumnIfMissing("confirmed_transactions", "ledger_amount", "ledger_amount REAL");

      db.pragma("user_version = 2");
    }

    if (currentVersion < 3) {
      addColumnIfMissing("confirmed_transactions", "occurrence_key", "occurrence_key TEXT");

      const confirmedRows = db.prepare(`
        SELECT id, type, date,
          source_recurring_expense_id,
          source_recurring_income_id,
          source_one_off_id,
          source_flex_id,
          source_goal_id,
          occurrence_key
        FROM confirmed_transactions
      `).all();

      const updateOccurrence = db.prepare(`
        UPDATE confirmed_transactions
        SET occurrence_key = ?
        WHERE id = ?
      `);

      for (const row of confirmedRows) {
        if (row.occurrence_key) continue;

        updateOccurrence.run(occurrenceKeyFromRow(row), row.id);
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_confirmed_occurrence_key
          ON confirmed_transactions(occurrence_key);
      `);

      db.pragma("user_version = 3");
    }

    if (currentVersion < 4) {
      addColumnIfMissing("confirmed_transactions", "ledger_currency", "ledger_currency TEXT NOT NULL DEFAULT 'PLN'");

      db.prepare(`
        UPDATE confirmed_transactions
        SET ledger_currency = COALESCE(NULLIF(ledger_currency, ''), 'PLN')
      `).run();

      db.pragma("user_version = 4");
    }
  })();
}

export function applyPlanningMigrations(db) {
  const currentVersion = db.pragma("user_version", { simple: true });
  const validPredictionSubstituteValues = `
    'none',
    'starting_value',
    'average_extreme_starting_value',
    'median_recorded',
    'last_confirmed',
    'previous_year_same_month',
    'require_min_recorded_months'
  `;

  const tableExists = (tableName) =>
    Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));

  const columns = (tableName) =>
    db.prepare(`PRAGMA table_info(${tableName})`).all().map(col => col.name);

  const addColumnIfMissing = (tableName, columnName, ddl) => {
    if (!tableExists(tableName)) return;

    if (!columns(tableName).includes(columnName)) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
    }
  };

  db.transaction(() => {
    if (currentVersion < 2) {
      addColumnIfMissing("future_transactions", "date", "date TEXT");
      addColumnIfMissing("future_transactions", "source_one_off_id", "source_one_off_id TEXT");

      db.prepare(`
        UPDATE future_transactions
        SET date = period || '-01'
        WHERE date IS NULL
      `).run();

      db.pragma("user_version = 2");
    }

    if (currentVersion < 3) {
      addColumnIfMissing("future_transactions", "requested_amount", "requested_amount REAL");
      addColumnIfMissing("future_transactions", "funded_amount", "funded_amount REAL");
      addColumnIfMissing("future_transactions", "ledger_amount", "ledger_amount REAL");
      addColumnIfMissing("future_transactions", "status", "status TEXT DEFAULT 'funded'");
      addColumnIfMissing("future_transactions", "note", "note TEXT");

      addColumnIfMissing("pending_transactions", "requested_amount", "requested_amount REAL");
      addColumnIfMissing("pending_transactions", "funded_amount", "funded_amount REAL");
      addColumnIfMissing("pending_transactions", "ledger_amount", "ledger_amount REAL");
      addColumnIfMissing("pending_transactions", "note", "note TEXT");

      db.prepare(`
        UPDATE pending_transactions
        SET funded_amount = amount
        WHERE funded_amount IS NULL
      `).run();

      db.prepare(`
        UPDATE pending_transactions
        SET requested_amount = amount
        WHERE requested_amount IS NULL
      `).run();

      db.prepare(`
        UPDATE pending_transactions
        SET ledger_amount = amount * COALESCE(buffered_fx_rate, fx_rate, 1)
        WHERE ledger_amount IS NULL
      `).run();

      db.pragma("user_version = 3");
    }

    if (currentVersion < 4) {
      addColumnIfMissing("future_transactions", "occurrence_key", "occurrence_key TEXT");
      addColumnIfMissing("pending_transactions", "occurrence_key", "occurrence_key TEXT");

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_future_occurrence_key
          ON future_transactions(occurrence_key);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_occurrence_key
          ON pending_transactions(occurrence_key)
          WHERE occurrence_key IS NOT NULL;
      `);

      db.pragma("user_version = 4");
    }

    if (currentVersion < 5) {
      addColumnIfMissing("future_transactions", "running_balance", "running_balance REAL");
      addColumnIfMissing("pending_transactions", "running_balance", "running_balance REAL");

      db.pragma("user_version = 5");
    }

    if (currentVersion < 6) {
      addColumnIfMissing("settings", "ntfy_url", "ntfy_url TEXT");

      if (columns("settings").includes("ntfy_topic")) {
        db.prepare(`
          UPDATE settings
          SET ntfy_url = COALESCE(ntfy_url, ntfy_topic)
          WHERE ntfy_url IS NULL
            AND ntfy_topic IS NOT NULL
        `).run();
      }

      db.prepare(`
        UPDATE settings
        SET ledger_currency = 'PLN'
        WHERE ledger_currency IS NULL OR ledger_currency != 'PLN'
      `).run();

      db.pragma("user_version = 6");
    }

    if (currentVersion < 7) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fx_rates_cache (
          currency TEXT NOT NULL,
          rate_date TEXT NOT NULL,
          rate REAL NOT NULL CHECK (rate > 0),
          effective_date TEXT,
          source TEXT NOT NULL DEFAULT 'nbp',
          raw_json TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (currency, rate_date)
        );

        CREATE INDEX IF NOT EXISTS idx_fx_rates_cache_currency_date
          ON fx_rates_cache(currency, rate_date);
      `);

      db.pragma("user_version = 7");
    }

    if (currentVersion < 8) {
      addColumnIfMissing("settings", "fx_provider", "fx_provider TEXT NOT NULL DEFAULT 'nbp'");
      addColumnIfMissing("settings", "fx_used_currencies", "fx_used_currencies TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing("settings", "manual_fx_rates", "manual_fx_rates TEXT NOT NULL DEFAULT '{}'");

      db.prepare(`
        UPDATE settings
        SET fx_provider = COALESCE(NULLIF(fx_provider, ''), 'nbp'),
            fx_used_currencies = COALESCE(NULLIF(fx_used_currencies, ''), '[]'),
            manual_fx_rates = COALESCE(NULLIF(manual_fx_rates, ''), '{}')
      `).run();

      db.pragma("user_version = 8");
    }

    if (currentVersion < 9) {
      addColumnIfMissing("settings", "locale", "locale TEXT NOT NULL DEFAULT 'en'");

      db.prepare(`
        UPDATE settings
        SET locale = COALESCE(NULLIF(locale, ''), 'en')
      `).run();

      db.pragma("user_version = 9");
    }

    if (currentVersion < 10) {
      addColumnIfMissing(
        "recurring_expenses",
        "prediction_substitute_missing",
        "prediction_substitute_missing TEXT NOT NULL DEFAULT 'none'"
      );
      addColumnIfMissing(
        "recurring_incomes",
        "prediction_substitute_missing",
        "prediction_substitute_missing TEXT NOT NULL DEFAULT 'none'"
      );

      if (tableExists("recurring_expenses")) {
        db.prepare(`
          UPDATE recurring_expenses
          SET prediction_substitute_missing = 'none'
          WHERE prediction_substitute_missing IS NULL
             OR prediction_substitute_missing NOT IN (
               ${validPredictionSubstituteValues}
             )
        `).run();
      }

      if (tableExists("recurring_incomes")) {
        db.prepare(`
          UPDATE recurring_incomes
          SET prediction_substitute_missing = 'none'
          WHERE prediction_substitute_missing IS NULL
             OR prediction_substitute_missing NOT IN (
               ${validPredictionSubstituteValues}
             )
        `).run();
      }

      db.pragma("user_version = 10");
    }

    if (currentVersion < 11) {
      addColumnIfMissing(
        "recurring_expenses",
        "prediction_min_recorded_months",
        "prediction_min_recorded_months INTEGER NOT NULL DEFAULT 6"
      );
      addColumnIfMissing(
        "recurring_incomes",
        "prediction_min_recorded_months",
        "prediction_min_recorded_months INTEGER NOT NULL DEFAULT 6"
      );

      if (tableExists("recurring_expenses")) {
        db.prepare(`
          UPDATE recurring_expenses
          SET prediction_substitute_missing = 'none'
          WHERE prediction_substitute_missing IS NULL
             OR prediction_substitute_missing NOT IN (
               ${validPredictionSubstituteValues}
             )
        `).run();

        db.prepare(`
          UPDATE recurring_expenses
          SET prediction_min_recorded_months = 6
          WHERE prediction_min_recorded_months IS NULL
             OR prediction_min_recorded_months < 1
             OR prediction_min_recorded_months > 12
        `).run();
      }

      if (tableExists("recurring_incomes")) {
        db.prepare(`
          UPDATE recurring_incomes
          SET prediction_substitute_missing = 'none'
          WHERE prediction_substitute_missing IS NULL
             OR prediction_substitute_missing NOT IN (
               ${validPredictionSubstituteValues}
             )
        `).run();

        db.prepare(`
          UPDATE recurring_incomes
          SET prediction_min_recorded_months = 6
          WHERE prediction_min_recorded_months IS NULL
             OR prediction_min_recorded_months < 1
             OR prediction_min_recorded_months > 12
        `).run();
      }

      db.pragma("user_version = 11");
    }

    if (currentVersion < 12) {
      if (tableExists("settings")) {
        const existingSettingsColumns = columns("settings");
        const valueExpr = (name, fallback) =>
          existingSettingsColumns.includes(name) ? `COALESCE(${name}, ${fallback})` : fallback;

        db.exec("ALTER TABLE settings RENAME TO settings_old_v12");
        db.exec(`
          CREATE TABLE settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            ledger_currency TEXT NOT NULL DEFAULT 'PLN',
            timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw',
            locale TEXT NOT NULL DEFAULT 'en',
            future_periods INTEGER NOT NULL DEFAULT 11,
            budget_period_income_id TEXT,
            fx_buffer_percent REAL NOT NULL DEFAULT 0,
            fx_provider TEXT NOT NULL DEFAULT 'nbp'
              CHECK (fx_provider IN ('disabled', 'manual', 'nbp', 'frankfurter')),
            fx_used_currencies TEXT NOT NULL DEFAULT '[]',
            manual_fx_rates TEXT NOT NULL DEFAULT '{}',
            auto_backup_enabled INTEGER NOT NULL DEFAULT 0,
            backup_interval_minutes INTEGER NOT NULL DEFAULT 1440,
            backup_retention_count INTEGER NOT NULL DEFAULT 10,
            backup_location TEXT,
            ntfy_url TEXT,
            notification_delivery_time TEXT NOT NULL DEFAULT '08:00',
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
            updated_at TEXT NOT NULL,
            UNIQUE(id)
          );
        `);

        db.prepare(`
          INSERT INTO settings (
            id, ledger_currency, timezone, locale, future_periods, budget_period_income_id,
            fx_buffer_percent, fx_provider, fx_used_currencies, manual_fx_rates,
            auto_backup_enabled, backup_interval_minutes, backup_retention_count, backup_location,
            ntfy_url, notification_delivery_time, notify_goal_impossible, notify_necessary_underfunded,
            notify_funding_shortfall, notify_income_missing, notify_pending_summary, notify_goal_funded,
            notify_fx_changed, ntfy_priority_goal_impossible, ntfy_priority_necessary_underfunded,
            ntfy_priority_funding_shortfall, ntfy_priority_income_missing, ntfy_priority_pending_summary,
            ntfy_priority_goal_funded, ntfy_priority_fx_changed, necessary_underfunded_repeat_days,
            updated_at
          )
          SELECT
            ${valueExpr("id", "1")},
            ${valueExpr("ledger_currency", "'PLN'")},
            ${valueExpr("timezone", "'Europe/Warsaw'")},
            ${valueExpr("locale", "'en'")},
            ${valueExpr("future_periods", "11")},
            ${existingSettingsColumns.includes("budget_period_income_id") ? "budget_period_income_id" : "NULL"},
            ${valueExpr("fx_buffer_percent", "0")},
            ${valueExpr("fx_provider", "'nbp'")},
            ${valueExpr("fx_used_currencies", "'[]'")},
            ${valueExpr("manual_fx_rates", "'{}'")},
            ${valueExpr("auto_backup_enabled", "0")},
            ${valueExpr("backup_interval_minutes", "1440")},
            ${valueExpr("backup_retention_count", "10")},
            ${existingSettingsColumns.includes("backup_location") ? "backup_location" : "NULL"},
            ${existingSettingsColumns.includes("ntfy_url") ? "ntfy_url" : existingSettingsColumns.includes("ntfy_topic") ? "ntfy_topic" : "NULL"},
            ${valueExpr("notification_delivery_time", "'08:00'")},
            ${valueExpr("notify_goal_impossible", "1")},
            ${valueExpr("notify_necessary_underfunded", "1")},
            ${valueExpr("notify_funding_shortfall", "1")},
            ${valueExpr("notify_income_missing", "1")},
            ${valueExpr("notify_pending_summary", "1")},
            ${valueExpr("notify_goal_funded", "0")},
            ${valueExpr("notify_fx_changed", "1")},
            ${valueExpr("ntfy_priority_goal_impossible", "'high'")},
            ${valueExpr("ntfy_priority_necessary_underfunded", "'default'")},
            ${valueExpr("ntfy_priority_funding_shortfall", "'default'")},
            ${valueExpr("ntfy_priority_income_missing", "'high'")},
            ${valueExpr("ntfy_priority_pending_summary", "'default'")},
            ${valueExpr("ntfy_priority_goal_funded", "'default'")},
            ${valueExpr("ntfy_priority_fx_changed", "'default'")},
            ${valueExpr("necessary_underfunded_repeat_days", "1")},
            ${valueExpr("updated_at", "datetime('now')")}
          FROM settings_old_v12
          LIMIT 1
        `).run();

        db.exec("DROP TABLE settings_old_v12");
      }

      if (tableExists("fx_rates_cache")) {
        addColumnIfMissing("fx_rates_cache", "base_currency", "base_currency TEXT");
        addColumnIfMissing("fx_rates_cache", "quote_currency", "quote_currency TEXT NOT NULL DEFAULT 'PLN'");

        db.prepare(`
          UPDATE fx_rates_cache
          SET base_currency = COALESCE(NULLIF(base_currency, ''), NULLIF(currency, ''), 'PLN'),
              quote_currency = COALESCE(NULLIF(quote_currency, ''), 'PLN')
        `).run();

        db.exec("ALTER TABLE fx_rates_cache RENAME TO fx_rates_cache_old_v12");
        db.exec(`
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

          INSERT OR IGNORE INTO fx_rates_cache (
            base_currency, quote_currency, currency, rate_date, rate, effective_date, source, raw_json, updated_at
          )
          SELECT
            COALESCE(NULLIF(base_currency, ''), NULLIF(currency, ''), 'PLN'),
            COALESCE(NULLIF(quote_currency, ''), 'PLN'),
            COALESCE(NULLIF(currency, ''), NULLIF(base_currency, ''), 'PLN'),
            rate_date,
            rate,
            effective_date,
            COALESCE(NULLIF(source, ''), 'cache'),
            raw_json,
            COALESCE(updated_at, datetime('now'))
          FROM fx_rates_cache_old_v12;

          DROP TABLE fx_rates_cache_old_v12;
        `);
      } else {
        db.exec(`
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
        `);
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_fx_rates_cache_currency_date
          ON fx_rates_cache(currency, rate_date);
        CREATE INDEX IF NOT EXISTS idx_fx_rates_cache_pair_date
          ON fx_rates_cache(base_currency, quote_currency, rate_date);

        CREATE TABLE IF NOT EXISTS ledger_currency_events (
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
      `);

      addColumnIfMissing("pending_transactions", "ledger_currency", "ledger_currency TEXT NOT NULL DEFAULT 'PLN'");
      addColumnIfMissing("future_transactions", "ledger_currency", "ledger_currency TEXT NOT NULL DEFAULT 'PLN'");
      addColumnIfMissing("projection_snapshots", "ledger_currency", "ledger_currency TEXT NOT NULL DEFAULT 'PLN'");

      db.prepare(`
        INSERT OR IGNORE INTO ledger_currency_events (
          id, old_currency, new_currency, old_balance, converted_opening_balance,
          fx_rate, rate_date, source, details, created_at
        ) VALUES (
          'ledger-currency-initial', 'PLN', 'PLN', 0, 0, 1, date('now'), 'migration',
          '{"initial":true}', datetime('now')
        )
      `).run();

      db.pragma("user_version = 12");
    }

    if (currentVersion < 13) {
      addColumnIfMissing("settings", "setup_completed", "setup_completed INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing("settings", "setup_completed_at", "setup_completed_at TEXT");

      const functionalTables = [
        "planned_transactions",
        "recurring_expenses",
        "recurring_incomes",
        "flex_transactions",
        "goals",
        "one_off_transactions",
        "pending_transactions"
      ];
      const hasFunctionalRows = functionalTables.some(tableName => {
        if (!tableExists(tableName)) return false;
        return Boolean(db.prepare(`SELECT 1 FROM ${tableName} LIMIT 1`).get());
      });

      if (tableExists("settings") && hasFunctionalRows) {
        db.prepare(`
          UPDATE settings
          SET setup_completed = 1,
              setup_completed_at = COALESCE(setup_completed_at, datetime('now')),
              updated_at = datetime('now')
          WHERE id = 1
        `).run();
      }

      db.pragma("user_version = 13");
    }

    if (currentVersion < 14) {
      if (tableExists("settings")) {
        addColumnIfMissing("settings", "holiday_country", "holiday_country TEXT NOT NULL DEFAULT 'PL'");
        addColumnIfMissing("settings", "minimum_reserve_enabled", "minimum_reserve_enabled INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing("settings", "minimum_reserve_amount", "minimum_reserve_amount REAL NOT NULL DEFAULT 0");

        db.prepare(`
          UPDATE settings
          SET holiday_country = CASE
                WHEN UPPER(COALESCE(holiday_country, 'PL')) IN ('PL', 'DE') THEN UPPER(COALESCE(holiday_country, 'PL'))
                ELSE 'PL'
              END,
              minimum_reserve_enabled = CASE WHEN COALESCE(minimum_reserve_enabled, 0) = 1 THEN 1 ELSE 0 END,
              minimum_reserve_amount = MAX(0, COALESCE(minimum_reserve_amount, 0)),
              updated_at = datetime('now')
          WHERE id = 1
        `).run();
      }

      db.pragma("user_version = 14");
    }
  })();
}
