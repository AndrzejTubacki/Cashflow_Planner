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
  })();
}

export function applyPlanningMigrations(db) {
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
  })();
}
