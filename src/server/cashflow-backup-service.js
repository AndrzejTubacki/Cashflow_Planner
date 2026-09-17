import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  createBudgetStoreSnapshot,
  normalizeBudgetStoreSnapshot,
  restoreBudgetStoreSnapshot
} from "./cashflow-budget-store-snapshot.js";
import {
  replaceTableRowsFromBackup,
  tableExists
} from "./cashflow-db-utils.js";
import {
  requireHolidayCountry,
  requireIsoDate,
  requireIsoMonth
} from "./cashflow-date-utils.js";
import {
  FX_PROVIDER_IDS,
  SUPPORTED_FX_CURRENCIES,
  requireSupportedCurrency
} from "./cashflow-fx-provider-utils.js";
import { cleanupMigrationRecoveryFolders } from "./cashflow-migration-recovery.js";
import { addMoneyAmounts, multiplyMoney, roundMoneyAmount, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import { badRequest, notFound } from "./cashflow-user-utils.js";

const PROJECTION_SNAPSHOT_RETENTION = 100;
const EVENT_LOG_RETENTION = 2_000;
const SENT_NOTIFICATION_RETENTION = 1_000;
const FAILED_BACKUP_METADATA_RETENTION = 100;
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;
const SOURCE_FIELDS = [
  "source_recurring_expense_id",
  "source_recurring_income_id",
  "source_one_off_id",
  "source_flex_id",
  "source_goal_id"
];
const ACTIVE_LEDGER_DRIFT_EPSILON = 0.01;

export function createCashflowBackupService({
  backupDir,
  backupHook = null,
  backupRootDir,
  budgetStore = null,
  directorySizeBytes,
  generateId,
  getSettings,
  getSettingsAsync = null,
  initReadOnlyPragmas,
  listLedgerYears,
  logError = () => {},
  logServerEvent = () => {},
  now = () => new Date(),
  openLedgerDb,
  openPlanningDb,
  recalculateLedgerRunningBalance,
  recalculateLedgerRunningBalanceAsync = null,
  regenerateProjectionsAfterMutation,
  regenerateProjectionsAfterMutationAsync = null
}) {
  function runBackupHook(phase, details = {}) {
    if (typeof backupHook === "function") backupHook({ phase, ...details });
  }

  // Postgres has no VACUUM INTO / file-copy equivalent, so its backup path
  // stores a JSON budget-store snapshot instead of a folder of .sqlite files,
  // and tracks metadata as a backup_metadata planning row instead of a local
  // SQL row. Both paths share the same backup root directory, retention
  // count, and rollback-on-restore-failure contract.
  function usesPostgresBudgetStoreForBackup() {
    return budgetStore?.backend === "postgres"
      && typeof budgetStore.listPlanningRows === "function"
      && typeof budgetStore.insertPlanningRows === "function"
      && typeof getSettingsAsync === "function"
      && typeof recalculateLedgerRunningBalanceAsync === "function"
      && typeof regenerateProjectionsAfterMutationAsync === "function";
  }

  function validateBackupFolderForRestore(backupPath) {
    if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isDirectory()) {
      throw new Error("Backup folder not found");
    }

    const planningSource = path.join(backupPath, "planning.sqlite");

    if (!fs.existsSync(planningSource)) {
      throw new Error("Backup is missing planning.sqlite");
    }

    const backupLedgerYears = fs.readdirSync(backupPath)
      .map(name => {
        const match = name.match(/^ledger_(\d{4})\.sqlite$/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    const planningDb = new Database(planningSource, {
      readonly: true,
      fileMustExist: true
    });

    try {
      initReadOnlyPragmas(planningDb);

      const integrity = planningDb.prepare("PRAGMA integrity_check").get();
      if (integrity.integrity_check !== "ok") {
        throw new Error(`Backup planning.sqlite integrity check failed: ${integrity.integrity_check}`);
      }

      const requiredTables = [
        "settings",
        "planned_transactions",
        "recurring_expenses",
        "recurring_incomes",
        "flex_transactions",
        "goals",
        "one_off_transactions",
        "pending_transactions",
        "future_transactions"
      ];

      for (const tableName of requiredTables) {
        if (!tableExists(planningDb, tableName)) {
          throw new Error(`Backup planning.sqlite missing table: ${tableName}`);
        }
      }
    } finally {
      planningDb.close();
    }

    for (const year of backupLedgerYears) {
      const ledgerPath = path.join(backupPath, `ledger_${year}.sqlite`);
      const ledgerDb = new Database(ledgerPath, {
        readonly: true,
        fileMustExist: true
      });

      try {
        initReadOnlyPragmas(ledgerDb);

        const integrity = ledgerDb.prepare("PRAGMA integrity_check").get();
        if (integrity.integrity_check !== "ok") {
          throw new Error(`Backup ledger_${year}.sqlite integrity check failed: ${integrity.integrity_check}`);
        }

        if (!tableExists(ledgerDb, "confirmed_transactions")) {
          throw new Error(`Backup ledger_${year}.sqlite missing confirmed_transactions`);
        }
      } finally {
        ledgerDb.close();
      }
    }

    return {
      planningSource,
      backupLedgerYears
    };
  }

  function pushWarning(warnings, type, message, details = {}) {
    warnings.push({
      type,
      message,
      details
    });
  }

  function isFiniteNumber(value) {
    return typeof value !== "boolean" && Number.isFinite(Number(value));
  }

  function isValidDate(value) {
    try {
      requireIsoDate(value);
      return true;
    } catch {
      return false;
    }
  }

  function isValidMonth(value) {
    try {
      requireIsoMonth(value);
      return true;
    } catch {
      return false;
    }
  }

  function isValidCurrency(value) {
    try {
      requireSupportedCurrency(value);
      return true;
    } catch {
      return false;
    }
  }

  function isValidHolidayCountry(value) {
    try {
      requireHolidayCountry(value);
      return true;
    } catch {
      return false;
    }
  }

  function isValidTimezone(value) {
    const timezone = String(value || "").trim();
    if (!timezone) return false;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
      return true;
    } catch {
      return false;
    }
  }

  function isHttpUrlOrEmpty(value) {
    if (value === null || value === undefined || value === "") return true;
    try {
      const parsed = new URL(String(value).trim());
      return ["http:", "https:"].includes(parsed.protocol);
    } catch {
      return false;
    }
  }

  function isReasonableStringOrEmpty(value, maxLength) {
    if (value === null || value === undefined || value === "") return true;
    return typeof value === "string" && value.length <= maxLength;
  }

  function parseJsonForValidation(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "object") return value;
    try {
      return JSON.parse(String(value));
    } catch {
      return undefined;
    }
  }

  function sourceCount(row) {
    return SOURCE_FIELDS.filter(field => row?.[field]).length;
  }

  function collectSourceSets(db) {
    return {
      source_recurring_expense_id: new Set(db.prepare("SELECT id FROM recurring_expenses").all().map(row => row.id)),
      source_recurring_income_id: new Set(db.prepare("SELECT id FROM recurring_incomes").all().map(row => row.id)),
      source_one_off_id: new Set(db.prepare("SELECT id FROM one_off_transactions").all().map(row => row.id)),
      source_flex_id: new Set(db.prepare("SELECT id FROM flex_transactions").all().map(row => row.id)),
      source_goal_id: new Set(db.prepare("SELECT id FROM goals").all().map(row => row.id))
    };
  }

  function validateSettingsRow(warnings, db) {
    const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
    if (!settings) {
      pushWarning(warnings, "missing_settings", "Settings row is missing", { table: "settings", id: 1 });
      return { ledgerCurrency: "PLN" };
    }

    const checks = [
      ["ledger_currency", () => isValidCurrency(settings.ledger_currency)],
      ["timezone", () => isValidTimezone(settings.timezone)],
      ["holiday_country", () => isValidHolidayCountry(settings.holiday_country)],
      ["future_periods", () => Number.isInteger(Number(settings.future_periods)) && Number(settings.future_periods) >= 1 && Number(settings.future_periods) <= 60],
      ["minimum_reserve_amount", () => isFiniteNumber(settings.minimum_reserve_amount) && Number(settings.minimum_reserve_amount) >= 0],
      ["ledger_history_compaction_months", () => Number.isInteger(Number(settings.ledger_history_compaction_months || 0)) && Number(settings.ledger_history_compaction_months || 0) >= 0 && Number(settings.ledger_history_compaction_months || 0) <= 600],
      ["fx_buffer_percent", () => isFiniteNumber(settings.fx_buffer_percent) && Number(settings.fx_buffer_percent) >= 0 && Number(settings.fx_buffer_percent) <= 100],
      ["fx_provider", () => FX_PROVIDER_IDS.includes(String(settings.fx_provider || ""))],
      ["notification_channel", () => ["ntfy", "discord"].includes(String(settings.notification_channel || "ntfy"))],
      ["ntfy_url", () => isHttpUrlOrEmpty(settings.ntfy_url)],
      ["ntfy_auth_token", () => isReasonableStringOrEmpty(settings.ntfy_auth_token, 500)],
      ["discord_webhook_url", () => isHttpUrlOrEmpty(settings.discord_webhook_url)]
    ];

    for (const [field, valid] of checks) {
      if (!valid()) {
        pushWarning(warnings, "malformed_setting", `Malformed setting ${field}`, {
          table: "settings",
          id: 1,
          field
        });
      }
    }

    const currencyList = parseJsonForValidation(settings.fx_used_currencies);
    if (!Array.isArray(currencyList) || currencyList.some(currency => !SUPPORTED_FX_CURRENCIES.includes(String(currency || "").toUpperCase()))) {
      pushWarning(warnings, "malformed_setting", "Malformed setting fx_used_currencies", {
        table: "settings",
        id: 1,
        field: "fx_used_currencies"
      });
    }

    const manualRates = parseJsonForValidation(settings.manual_fx_rates);
    const ledgerCurrency = isValidCurrency(settings.ledger_currency)
      ? String(settings.ledger_currency).toUpperCase()
      : "PLN";
    const manualRatesValid = manualRates
      && typeof manualRates === "object"
      && !Array.isArray(manualRates)
      && Object.entries(manualRates).every(([pair, rate]) => {
        const [base, quote = ledgerCurrency] = String(pair || "").toUpperCase().split("/");
        return base
          && quote
          && base !== quote
          && SUPPORTED_FX_CURRENCIES.includes(base)
          && SUPPORTED_FX_CURRENCIES.includes(quote)
          && isFiniteNumber(rate)
          && Number(rate) > 0;
      });
    if (!manualRatesValid) {
      pushWarning(warnings, "malformed_setting", "Malformed setting manual_fx_rates", {
        table: "settings",
        id: 1,
        field: "manual_fx_rates"
      });
    }

    if (settings.budget_period_income_id) {
      const row = db.prepare(`
        SELECT id
        FROM recurring_incomes
        WHERE id = ?
          AND active = 1
          AND period_setting = 1
      `).get(settings.budget_period_income_id);
      if (!row) {
        pushWarning(warnings, "stale_budget_period_income", "Budget period income setting points to a missing or inactive income", {
          table: "settings",
          id: 1,
          field: "budget_period_income_id"
        });
      }
    }

    return { ledgerCurrency };
  }

  function validatePlanningSourceLinks(warnings, db) {
    const sourceSets = collectSourceSets(db);
    const rowsByTable = [
      ["pending_transactions", db.prepare("SELECT * FROM pending_transactions").all()],
      ["future_transactions", db.prepare("SELECT * FROM future_transactions").all()]
    ];

    for (const [table, rows] of rowsByTable) {
      for (const row of rows) {
        const count = sourceCount(row);
        if (count > 1) {
          pushWarning(warnings, "multiple_source_links", `${table} row ${row.id} has multiple source links`, {
            table,
            id: row.id
          });
        }

        for (const field of SOURCE_FIELDS) {
          const sourceId = row[field];
          if (sourceId && !sourceSets[field]?.has(sourceId)) {
            pushWarning(warnings, "stale_source_link", `${table} row ${row.id} references missing ${field}`, {
              table,
              id: row.id,
              field
            });
          }
        }
      }
    }

    const plannedRows = db.prepare("SELECT * FROM planned_transactions").all();
    for (const planned of plannedRows) {
      const references = [
        ["recurring_expenses", "recurring_expense"],
        ["flex_transactions", "flex"],
        ["goals", "goal"]
      ].flatMap(([table, expectedType]) =>
        db.prepare(`SELECT id FROM ${table} WHERE planned_transaction_id = ?`).all(planned.id)
          .map(row => ({ table, id: row.id, expectedType }))
      );

      if (!references.length) {
        pushWarning(warnings, "orphan_planned_transaction", `Orphan planned transaction ${planned.id}`, {
          table: "planned_transactions",
          id: planned.id
        });
      }

      for (const reference of references) {
        if (planned.type !== reference.expectedType) {
          pushWarning(warnings, "planned_type_mismatch", `Planned transaction ${planned.id} type does not match ${reference.table}`, {
            table: "planned_transactions",
            id: planned.id,
            expectedType: reference.expectedType,
            actualType: planned.type,
            sourceTable: reference.table,
            sourceId: reference.id
          });
        }
      }
    }
  }

  function validateOccurrenceKeys(warnings, db, confirmedRows) {
    const occurrences = new Map();
    const add = (row, table, year = null) => {
      const key = row.occurrence_key;
      if (!key) return;
      if (!occurrences.has(key)) occurrences.set(key, []);
      occurrences.get(key).push({ table, id: row.id, year });
    };

    for (const row of db.prepare("SELECT id, occurrence_key FROM pending_transactions WHERE occurrence_key IS NOT NULL").all()) {
      add(row, "pending_transactions");
    }
    for (const row of db.prepare("SELECT id, occurrence_key FROM future_transactions WHERE occurrence_key IS NOT NULL").all()) {
      add(row, "future_transactions");
    }
    for (const row of confirmedRows) {
      add(row, "confirmed_transactions", row.ledger_year);
    }

    for (const [occurrenceKey, rows] of occurrences.entries()) {
      if (rows.length > 1) {
        pushWarning(warnings, "duplicate_occurrence_key", `Duplicate occurrence key ${occurrenceKey}`, {
          occurrence_key: occurrenceKey,
          rows
        });
      }
    }
  }

  function validateLedgerRows(warnings, ledgerRows, activeLedgerCurrency) {
    let expectedBalance = 0;
    const activeRows = ledgerRows
      .filter(row => String(row.ledger_currency || "PLN").toUpperCase() === activeLedgerCurrency)
      .sort((a, b) => {
        const dateCompare = String(a.date).localeCompare(String(b.date));
        if (dateCompare !== 0) return dateCompare;
        const createdCompare = String(a.created_at).localeCompare(String(b.created_at));
        if (createdCompare !== 0) return createdCompare;
        return String(a.id).localeCompare(String(b.id));
      });

    for (const row of ledgerRows) {
      if (!["income", "expense"].includes(row.type)) {
        pushWarning(warnings, "invalid_ledger_row", `Ledger row ${row.id} has invalid type`, {
          table: "confirmed_transactions",
          id: row.id,
          year: row.ledger_year,
          field: "type"
        });
      }
      for (const field of ["date", "confirmed_date", "created_at", "updated_at"]) {
        if (field === "date" || field === "confirmed_date") {
          if (!isValidDate(row[field])) {
            pushWarning(warnings, "invalid_ledger_row", `Ledger row ${row.id} has invalid ${field}`, {
              table: "confirmed_transactions",
              id: row.id,
              year: row.ledger_year,
              field
            });
          }
        } else if (!row[field]) {
          pushWarning(warnings, "invalid_ledger_row", `Ledger row ${row.id} is missing ${field}`, {
            table: "confirmed_transactions",
            id: row.id,
            year: row.ledger_year,
            field
          });
        }
      }
      if (String(row.confirmed_date || "").slice(0, 4) !== String(row.ledger_year)) {
        pushWarning(warnings, "ledger_year_mismatch", `Ledger row ${row.id} is stored in the wrong ledger year`, {
          table: "confirmed_transactions",
          id: row.id,
          year: row.ledger_year,
          confirmed_date: row.confirmed_date
        });
      }
      for (const field of ["currency", "ledger_currency"]) {
        if (!isValidCurrency(row[field])) {
          pushWarning(warnings, "invalid_ledger_row", `Ledger row ${row.id} has unsupported ${field}`, {
            table: "confirmed_transactions",
            id: row.id,
            year: row.ledger_year,
            field
          });
        }
      }
      for (const field of ["amount", "running_balance_pln"]) {
        if (!isFiniteNumber(row[field]) || Number(row[field]) < 0 && field === "amount") {
          pushWarning(warnings, "invalid_ledger_row", `Ledger row ${row.id} has invalid ${field}`, {
            table: "confirmed_transactions",
            id: row.id,
            year: row.ledger_year,
            field
          });
        }
      }
      if (row.ledger_amount !== null && row.ledger_amount !== undefined && !isFiniteNumber(row.ledger_amount)) {
        pushWarning(warnings, "invalid_ledger_row", `Ledger row ${row.id} has invalid ledger_amount`, {
          table: "confirmed_transactions",
          id: row.id,
          year: row.ledger_year,
          field: "ledger_amount"
        });
      }
      if (sourceCount(row) > 1) {
        pushWarning(warnings, "multiple_source_links", `Ledger row ${row.id} has multiple source links`, {
          table: "confirmed_transactions",
          id: row.id,
          year: row.ledger_year
        });
      }
    }

    for (const row of activeRows) {
      const ledgerAmount = row.ledger_amount !== null && row.ledger_amount !== undefined
        ? roundMoneyAmount(row.ledger_amount)
        : multiplyMoney(row.amount, row.buffered_fx_rate || row.fx_rate || 1);
      expectedBalance = row.type === "income"
        ? addMoneyAmounts(expectedBalance, ledgerAmount)
        : subtractMoneyAmounts(expectedBalance, ledgerAmount);
      const actual = Number(row.running_balance_pln);
      if (Number.isFinite(actual) && Math.abs(actual - expectedBalance) > ACTIVE_LEDGER_DRIFT_EPSILON) {
        pushWarning(warnings, "active_ledger_running_balance_drift", `Ledger row ${row.id} running balance differs from recalculated active-ledger balance`, {
          table: "confirmed_transactions",
          id: row.id,
          year: row.ledger_year,
          expected: Number(expectedBalance.toFixed(2)),
          actual: Number(actual.toFixed(2))
        });
      }
    }
  }

  function validateCashflowData(userId) {
    const db = openPlanningDb(userId);
    const warnings = [];

    try {
      const { ledgerCurrency } = validateSettingsRow(warnings, db);
      const confirmedRows = [];
      for (const year of listLedgerYears(userId)) {
        const ledgerDb = openLedgerDb(userId, year);
        try {
          confirmedRows.push(...ledgerDb.prepare(`
            SELECT *, ? AS ledger_year
            FROM confirmed_transactions
          `).all(year));
        } finally {
          ledgerDb.close();
        }
      }

      const duplicateOperating = db.prepare(`
        SELECT operating_priority AS priority, COUNT(*) AS count
        FROM planned_transactions
        WHERE type IN ('recurring_expense', 'flex')
          AND operating_priority IS NOT NULL
        GROUP BY operating_priority
        HAVING COUNT(*) > 1
      `).all();

      for (const row of duplicateOperating) {
        warnings.push({
          type: "duplicate_operating_priority",
          message: `Duplicate operating priority ${row.priority}`,
          details: row
        });
      }

      const duplicateGoals = db.prepare(`
        SELECT goal_priority AS priority, COUNT(*) AS count
        FROM planned_transactions
        WHERE type = 'goal'
          AND goal_priority IS NOT NULL
        GROUP BY goal_priority
        HAVING COUNT(*) > 1
      `).all();

      for (const row of duplicateGoals) {
        warnings.push({
          type: "duplicate_goal_priority",
          message: `Duplicate goal priority ${row.priority}`,
          details: row
        });
      }

      const badFlex = db.prepare(`
        SELECT *
        FROM flex_transactions
        WHERE allow_split = 1
          AND min_amount IS NOT NULL
          AND max_amount IS NOT NULL
          AND min_amount > max_amount
      `).all();

      for (const row of badFlex) {
        warnings.push({
          type: "invalid_flex_min_max",
          message: `${row.name} has min_amount greater than max_amount`,
          details: row
        });
      }

      for (const table of ["pending_transactions", "future_transactions"]) {
        const rows = db.prepare(`SELECT * FROM ${table}`).all();
        for (const row of rows) {
          const invalidFields = [];
          if (!isFiniteNumber(row.amount) || Number(row.amount) < 0) invalidFields.push("amount");
          if (!isValidDate(row.date)) invalidFields.push("date");
          if (!isValidCurrency(row.currency)) invalidFields.push("currency");
          if (row.ledger_currency && !isValidCurrency(row.ledger_currency)) invalidFields.push("ledger_currency");
          if (!["income", "expense", "goal_allocation"].includes(row.type)) invalidFields.push("type");
          if (row.running_balance !== null && row.running_balance !== undefined && !isFiniteNumber(row.running_balance)) invalidFields.push("running_balance");
          if (row.ledger_amount !== null && row.ledger_amount !== undefined && !isFiniteNumber(row.ledger_amount)) invalidFields.push("ledger_amount");

          for (const field of invalidFields) {
            pushWarning(warnings, "invalid_generated_transaction", `${table} row ${row.id} has invalid ${field}`, {
              table,
              id: row.id,
              field
            });
          }
        }
      }

      const orphanPlanned = db.prepare(`
        SELECT pt.*
        FROM planned_transactions pt
        LEFT JOIN recurring_expenses re ON re.planned_transaction_id = pt.id
        LEFT JOIN flex_transactions f ON f.planned_transaction_id = pt.id
        LEFT JOIN goals g ON g.planned_transaction_id = pt.id
        WHERE re.id IS NULL AND f.id IS NULL AND g.id IS NULL
      `).all();

      for (const row of orphanPlanned) {
        warnings.push({
          type: "orphan_planned_transaction",
          message: `Orphan planned transaction ${row.id}`,
          details: row
        });
      }

      validatePlanningSourceLinks(warnings, db);
      validateOccurrenceKeys(warnings, db, confirmedRows);
      validateLedgerRows(warnings, confirmedRows, ledgerCurrency);

      const invalidPending = db.prepare(`
        SELECT *
        FROM pending_transactions
        WHERE amount < 0
          OR date IS NULL
          OR currency IS NULL
      `).all();

      for (const row of invalidPending) {
        warnings.push({
          type: "invalid_pending_transaction",
          message: `Invalid pending transaction ${row.id}`,
          details: row
        });
      }

      db.prepare(`
        INSERT INTO event_log (id, action, entity_type, entity_id, details, timestamp)
        VALUES (?, 'validation_completed', 'cashflow', ?, ?, datetime('now'))
      `).run(
        generateId("event"),
        userId,
        JSON.stringify({ warning_count: warnings.length, warnings })
      );

      return {
        ok: warnings.length === 0,
        warnings
      };
    } finally {
      db.close();
    }
  }

  function cleanupBackupFolders(userId) {
    const settings = getSettings(userId);
    const retention = Math.max(1, Number(settings?.backup_retention_count || 10));
    const dir = backupRootDir(userId, settings);

    if (!fs.existsSync(dir)) return { deleted: 0, retainedPaths: [] };

    const backups = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith("backup_") && !entry.name.endsWith(".tmp"))
      .map(entry => {
        const fullPath = path.join(dir, entry.name);
        return {
          path: fullPath,
          mtimeMs: fs.statSync(fullPath).mtimeMs
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const toDelete = backups.slice(retention);

    for (const backup of toDelete) {
      fs.rmSync(backup.path, { recursive: true, force: true });
    }

    return {
      deleted: toDelete.length,
      retainedPaths: backups.slice(0, retention).map(backup => backup.path)
    };
  }

  function cleanupStaleTemporaryFolders(dir, currentTime) {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
    let deleted = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("backup_") || !entry.name.endsWith(".tmp")) continue;
      const fullPath = path.join(dir, entry.name);
      if (currentTime - fs.statSync(fullPath).mtimeMs <= STALE_TEMP_AGE_MS) continue;
      fs.rmSync(fullPath, { recursive: true, force: true });
      deleted += 1;
    }
    return deleted;
  }

  function cleanupOperationalData(userId) {
    const settings = getSettings(userId);
    const root = backupRootDir(userId, settings);
    const builtInRoot = typeof backupDir === "function" ? backupDir(userId) : root;
    const currentTime = now().getTime();
    const folderCleanup = cleanupBackupFolders(userId);
    const staleTemporaryDeleted = [...new Set([root, builtInRoot])]
      .reduce((total, dir) => total + cleanupStaleTemporaryFolders(dir, currentTime), 0);
    const migrationCleanup = cleanupMigrationRecoveryFolders(builtInRoot, currentTime);
    const db = openPlanningDb(userId);

    try {
      const result = db.transaction(() => {
        const snapshotsDeleted = db.prepare(`
          DELETE FROM projection_snapshots
          WHERE id NOT IN (
            SELECT id FROM projection_snapshots
            ORDER BY snapshot_timestamp DESC, id DESC
            LIMIT ?
          )
        `).run(PROJECTION_SNAPSHOT_RETENTION).changes;
        const eventsDeleted = db.prepare(`
          DELETE FROM event_log
          WHERE id NOT IN (
            SELECT id FROM event_log
            ORDER BY timestamp DESC, id DESC
            LIMIT ?
          )
        `).run(EVENT_LOG_RETENTION).changes;
        const notificationsDeleted = db.prepare(`
          DELETE FROM notification_queue
          WHERE sent_at IS NOT NULL
            AND id NOT IN (
              SELECT id FROM notification_queue
              WHERE sent_at IS NOT NULL
              ORDER BY sent_at DESC, queued_at DESC, id DESC
              LIMIT ?
            )
        `).run(SENT_NOTIFICATION_RETENTION).changes;

        const successful = db.prepare(`
          SELECT id, backup_path
          FROM backup_metadata
          WHERE success = 1
        `).all();
        let metadataDeleted = 0;
        for (const row of successful) {
          if (!fs.existsSync(row.backup_path) || !fs.statSync(row.backup_path).isDirectory()) {
            metadataDeleted += db.prepare("DELETE FROM backup_metadata WHERE id = ?").run(row.id).changes;
          }
        }
        metadataDeleted += db.prepare(`
          DELETE FROM backup_metadata
          WHERE success = 0
            AND id NOT IN (
              SELECT id FROM backup_metadata
              WHERE success = 0
              ORDER BY backup_timestamp DESC, created_at DESC, id DESC
              LIMIT ?
            )
        `).run(FAILED_BACKUP_METADATA_RETENTION).changes;

        return {
          snapshotsDeleted,
          eventsDeleted,
          notificationsDeleted,
          metadataDeleted
        };
      })();

      return {
        ...result,
        backupsDeleted: folderCleanup.deleted,
        migrationBackupsDeleted: migrationCleanup.completedDeleted,
        staleTemporaryDeleted: staleTemporaryDeleted + migrationCleanup.staleTemporaryDeleted
      };
    } finally {
      db.close();
    }
  }

  function cleanupOperationalDataBestEffort(userId, reason) {
    try {
      runBackupHook("before_retention_cleanup", { userId, reason });
      const result = cleanupOperationalData(userId);
      logServerEvent("cashflow_operational_retention_completed", { userId, reason, ...result });
      return result;
    } catch (error) {
      logError("cashflow_operational_retention_failed", {
        userId,
        reason,
        error: error.message
      });
      return null;
    }
  }

  function maybeRunAutomaticBackup(userId) {
    const settings = getSettings(userId);

    if (!Number(settings?.auto_backup_enabled)) return null;

    const intervalMinutes = Number(settings?.backup_interval_minutes || 1440);
    const db = openPlanningDb(userId);

    try {
      const lastBackup = db.prepare(`
        SELECT backup_timestamp
        FROM backup_metadata
        WHERE success = 1
        ORDER BY backup_timestamp DESC
        LIMIT 1
      `).get();

      if (lastBackup?.backup_timestamp) {
        const ageMs = Date.now() - new Date(lastBackup.backup_timestamp).getTime();
        const requiredMs = intervalMinutes * 60 * 1000;

        if (ageMs < requiredMs) return null;
      }
    } finally {
      db.close();
    }

    const backupPath = createBackup(userId, { deferCleanup: true });
    const deleted = cleanupOperationalDataBestEffort(userId, "automatic_backup")?.backupsDeleted || 0;

    return { backupPath, deleted };
  }

  async function maybeRunAutomaticBackupAsync(userId) {
    if (!usesPostgresBudgetStoreForBackup()) {
      return maybeRunAutomaticBackup(userId);
    }

    const settings = await getSettingsAsync(userId);
    if (!Number(settings?.auto_backup_enabled)) return null;

    const intervalMinutes = Number(settings?.backup_interval_minutes || 1440);
    const rows = await budgetStore.listPlanningRows(userId, "backup_metadata");
    const lastBackup = rows
      .filter(row => row.success)
      .sort((a, b) => String(b.backup_timestamp || "").localeCompare(String(a.backup_timestamp || "")))[0];

    if (lastBackup?.backup_timestamp) {
      const ageMs = Date.now() - new Date(lastBackup.backup_timestamp).getTime();
      const requiredMs = intervalMinutes * 60 * 1000;
      if (ageMs < requiredMs) return null;
    }

    // Retention cleanup (backupsDeleted) is SQLite-only — see the note in
    // runRecoverableUserMutation — so it's skipped here rather than
    // best-effort, same as the rest of the Postgres backup path.
    const backupPath = await createBackupAsync(userId, { deferCleanup: true });
    return { backupPath, deleted: 0 };
  }

  function createBackup(userId, options = {}) {
    const { deferCleanup = false } = options;
    const settings = getSettings(userId);
    const dir = backupRootDir(userId, settings);
    const createdAt = now().toISOString();
    const timestamp = createdAt.replace(/[:.]/g, "-");
    const backupId = generateId("backup");
    const backupRoot = path.join(dir, `backup_${timestamp}_${backupId}`);
    const temporaryRoot = `${backupRoot}.tmp`;

    function recordMetadata(success, errorMessage = null, sizeBytes = null) {
      const db = openPlanningDb(userId);
      try {
        db.prepare(`
          INSERT INTO backup_metadata (
            id, backup_timestamp, backup_path, size_bytes, success, error_message, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(backupId, createdAt, backupRoot, sizeBytes, success ? 1 : 0, errorMessage);
      } finally {
        db.close();
      }
    }

    try {
      fs.mkdirSync(temporaryRoot, { recursive: false });

      const planningBackupPath = path.join(temporaryRoot, "planning.sqlite");
      runBackupHook("before_planning_copy", { userId, backupRoot, temporaryRoot });
      const planningDb = openPlanningDb(userId);

      try {
        planningDb.prepare("VACUUM INTO ?").run(planningBackupPath);
      } finally {
        planningDb.close();
      }

      for (const year of listLedgerYears(userId)) {
        const ledgerBackupPath = path.join(temporaryRoot, `ledger_${year}.sqlite`);
        runBackupHook("before_ledger_copy", { userId, year, backupRoot, temporaryRoot });
        const ledgerDb = openLedgerDb(userId, year);

        try {
          ledgerDb.prepare("VACUUM INTO ?").run(ledgerBackupPath);
        } finally {
          ledgerDb.close();
        }
      }

      runBackupHook("before_backup_validation", { userId, backupRoot, temporaryRoot });
      validateBackupFolderForRestore(temporaryRoot);
      fs.renameSync(temporaryRoot, backupRoot);
      runBackupHook("before_success_metadata", { userId, backupRoot });
      recordMetadata(true, null, directorySizeBytes(backupRoot));
      if (!deferCleanup) cleanupOperationalDataBestEffort(userId, "backup_created");
      return backupRoot;
    } catch (error) {
      for (const partialPath of [temporaryRoot, backupRoot]) {
        try {
          fs.rmSync(partialPath, { recursive: true, force: true });
        } catch (cleanupError) {
          logError("cashflow_backup_partial_cleanup_failed", {
            userId,
            backupPath: backupRoot,
            partialPath,
            error: cleanupError.message
          });
        }
      }

      try {
        recordMetadata(false, error.message, null);
      } catch (metadataError) {
        logError("cashflow_backup_failure_metadata_failed", {
          userId,
          backupPath: backupRoot,
          error: error.message,
          metadataError: metadataError.message
        });
      }
      logError("cashflow_backup_creation_failed", {
        userId,
        backupPath: backupRoot,
        error: error.message
      });
      throw error;
    }
  }

  async function createBackupAsync(userId, options = {}) {
    if (!usesPostgresBudgetStoreForBackup()) {
      return createBackup(userId, options);
    }

    const settings = await getSettingsAsync(userId);
    const dir = backupRootDir(userId, settings);
    const createdAt = now().toISOString();
    const timestamp = createdAt.replace(/[:.]/g, "-");
    const backupId = generateId("backup");
    const backupPath = path.join(dir, `backup_${timestamp}_${backupId}.json`);
    const temporaryPath = `${backupPath}.tmp`;

    async function recordMetadata(success, errorMessage = null, sizeBytes = null) {
      await budgetStore.insertPlanningRows(userId, "backup_metadata", [{
        id: backupId,
        backup_timestamp: createdAt,
        backup_path: backupPath,
        size_bytes: sizeBytes,
        success: Boolean(success),
        error_message: errorMessage,
        created_at: new Date().toISOString()
      }]);
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
      runBackupHook("before_planning_copy", { userId, backupPath, temporaryPath });
      const snapshot = await createBudgetStoreSnapshot({
        budgetIds: [userId],
        budgetStore,
        reason: options.reason || "manual"
      });
      const serialized = JSON.stringify(snapshot);

      runBackupHook("before_backup_validation", { userId, backupPath, temporaryPath });
      normalizeBudgetStoreSnapshot(snapshot);

      fs.writeFileSync(temporaryPath, serialized, "utf8");
      fs.renameSync(temporaryPath, backupPath);
      runBackupHook("before_success_metadata", { userId, backupPath });
      await recordMetadata(true, null, Buffer.byteLength(serialized, "utf8"));
      return backupPath;
    } catch (error) {
      for (const partialPath of [temporaryPath, backupPath]) {
        try {
          fs.rmSync(partialPath, { force: true });
        } catch (cleanupError) {
          logError("cashflow_backup_partial_cleanup_failed", {
            userId,
            backupPath,
            partialPath,
            error: cleanupError.message
          });
        }
      }

      try {
        await recordMetadata(false, error.message, null);
      } catch (metadataError) {
        logError("cashflow_backup_failure_metadata_failed", {
          userId,
          backupPath,
          error: error.message,
          metadataError: metadataError.message
        });
      }
      logError("cashflow_backup_creation_failed", {
        userId,
        backupPath,
        error: error.message
      });
      throw error;
    }
  }

  function importPlanningBackupIntoLiveDb(userId, backupPlanningPath) {
    const liveDb = openPlanningDb(userId);
    const backupDb = new Database(backupPlanningPath, {
      readonly: true,
      fileMustExist: true
    });

    const deleteOrder = [
      "notification_queue",
      "projection_snapshots",
      "event_log",
      "future_transactions",
      "pending_transactions",
      "one_off_transactions",
      "goals",
      "flex_transactions",
      "recurring_incomes",
      "recurring_expenses",
      "planned_transactions",
      "ledger_currency_events",
      "fx_rates_cache",
      "settings"
    ];

    const insertOrder = [
      "settings",
      "fx_rates_cache",
      "ledger_currency_events",
      "planned_transactions",
      "recurring_expenses",
      "recurring_incomes",
      "flex_transactions",
      "goals",
      "one_off_transactions",
      "pending_transactions",
      "future_transactions",
      "event_log",
      "projection_snapshots",
      "notification_queue"
    ];

    try {
      initReadOnlyPragmas(backupDb);

      liveDb.transaction(() => {
        liveDb.pragma("foreign_keys = OFF");

        for (const tableName of deleteOrder) {
          if (tableExists(liveDb, tableName)) {
            liveDb.prepare(`DELETE FROM ${tableName}`).run();
          }
        }

        for (const tableName of insertOrder) {
          replaceTableRowsFromBackup(liveDb, backupDb, tableName);
        }

        liveDb.pragma("foreign_keys = ON");

        const fkErrors = liveDb.prepare("PRAGMA foreign_key_check").all();
        if (fkErrors.length) {
          throw new Error(`Restore failed foreign key check: ${JSON.stringify(fkErrors)}`);
        }

        liveDb.prepare(`
          INSERT INTO event_log (id, action, entity_type, entity_id, details, timestamp)
          VALUES (?, 'restore_completed', 'cashflow', ?, ?, datetime('now'))
        `).run(
          generateId("event"),
          userId,
          JSON.stringify({ backupPlanningPath })
        );
      })();
    } finally {
      backupDb.close();
      liveDb.close();
    }
  }

  function importLedgerBackupIntoLiveDb(userId, backupLedgerPath, year) {
    const liveDb = openLedgerDb(userId, year);
    const backupDb = new Database(backupLedgerPath, {
      readonly: true,
      fileMustExist: true
    });

    try {
      initReadOnlyPragmas(backupDb);

      liveDb.transaction(() => {
        replaceTableRowsFromBackup(liveDb, backupDb, "confirmed_transactions");
      })();
    } finally {
      backupDb.close();
      liveDb.close();
    }
  }

  function clearLedgerYear(userId, year) {
    const ledgerDb = openLedgerDb(userId, year);

    try {
      ledgerDb.prepare("DELETE FROM confirmed_transactions").run();
    } finally {
      ledgerDb.close();
    }
  }

  function restoreBackupFromPath(userId, backupPath) {
    const { planningSource, backupLedgerYears } = validateBackupFolderForRestore(backupPath);
    const existingLedgerYears = listLedgerYears(userId);

    importPlanningBackupIntoLiveDb(userId, planningSource);

    for (const year of backupLedgerYears) {
      importLedgerBackupIntoLiveDb(userId, path.join(backupPath, `ledger_${year}.sqlite`), year);
    }

    for (const year of existingLedgerYears) {
      if (!backupLedgerYears.includes(year)) {
        clearLedgerYear(userId, year);
      }
    }

    recalculateLedgerRunningBalance(userId);

    const projection = regenerateProjectionsAfterMutation(userId);
    if (projection?.projection_ok === false) {
      throw new Error(`Projection regeneration failed after restore: ${projection.projection_error || "unknown error"}`);
    }
    return projection;
  }

  function restoreBackup(userId, backupId) {
    const db = openPlanningDb(userId);

    let backupPath;

    try {
      const row = db.prepare(`
        SELECT backup_path, success
        FROM backup_metadata
        WHERE id = ?
      `).get(backupId);

      if (!row?.backup_path || Number(row.success) !== 1) {
        throw notFound("Backup not found", [{ field: "backupId", reason: "not_found" }]);
      }

      backupPath = row.backup_path;
    } finally {
      db.close();
    }

    if (!fs.existsSync(backupPath)) {
      throw notFound("Backup not found", [{ field: "backupId", reason: "backup_folder_missing" }]);
    }
    try {
      validateBackupFolderForRestore(backupPath);
    } catch (error) {
      throw badRequest("Backup is invalid and cannot be restored", {
        phase: "backup_validation_failed",
        backupPath,
        error: error.message
      });
    }

    const safetyBackup = createBackup(userId, { deferCleanup: true });

    try {
      runBackupHook("before_restore_apply", { userId, backupPath, safetyBackup });
      const projection = restoreBackupFromPath(userId, backupPath);
      cleanupOperationalDataBestEffort(userId, "restore_completed");

      return {
        ok: true,
        restoredFrom: backupPath,
        safetyBackup,
        mode: "row_import_validated",
        _projection: projection
      };
    } catch (error) {
      logError("cashflow_restore_failed_before_rollback", {
        userId,
        restoredFrom: backupPath,
        safetyBackup,
        error: error.message
      });
      try {
        runBackupHook("before_restore_rollback", { userId, backupPath, safetyBackup, error });
        restoreBackupFromPath(userId, safetyBackup);
        logServerEvent("cashflow_restore_rolled_back", {
          userId,
          restoredFrom: backupPath,
          safetyBackup,
          error: error.message
        });
        cleanupOperationalDataBestEffort(userId, "restore_rolled_back");
      } catch (rollbackError) {
        logError("cashflow_restore_rollback_failed", {
          userId,
          restoredFrom: backupPath,
          safetyBackup,
          error: error.message,
          rollbackError: rollbackError.message
        });
        const combined = new Error("Restore failed and rollback also failed");
        combined.status = 500;
        combined.details = {
          phase: "rollback_failed",
          safetyBackup,
          originalError: error.message,
          originalStatus: Number(error?.status) || 500,
          rollbackError: rollbackError.message
        };
        throw combined;
      }

      const rolledBack = new Error(`Restore failed and was rolled back: ${error.message}`);
      rolledBack.status = Number(error?.status) || 500;
      if (error?.details) rolledBack.details = error.details;
      throw rolledBack;
    }
  }

  async function restoreBackupFromPathAsync(userId, backupPath) {
    const raw = fs.readFileSync(backupPath, "utf8");
    const snapshot = normalizeBudgetStoreSnapshot(JSON.parse(raw));

    await restoreBudgetStoreSnapshot({
      budgetStore,
      // A restore must end up exactly matching the backup, so ledger years
      // present now but absent from the backup need to be cleared too, not
      // just left alone.
      includeExistingLedgerYears: true,
      snapshot
    });

    await recalculateLedgerRunningBalanceAsync(userId);

    const projection = await regenerateProjectionsAfterMutationAsync(userId);
    if (projection?.projection_ok === false) {
      throw new Error(`Projection regeneration failed after restore: ${projection.projection_error || "unknown error"}`);
    }
    return projection;
  }

  async function restoreBackupAsync(userId, backupId) {
    if (!usesPostgresBudgetStoreForBackup()) {
      return restoreBackup(userId, backupId);
    }

    const rows = await budgetStore.listPlanningRows(userId, "backup_metadata");
    const row = rows.find(candidate => candidate.id === backupId);
    if (!row?.backup_path || !row.success) {
      throw notFound("Backup not found", [{ field: "backupId", reason: "not_found" }]);
    }

    const backupPath = row.backup_path;
    if (!fs.existsSync(backupPath)) {
      throw notFound("Backup not found", [{ field: "backupId", reason: "backup_folder_missing" }]);
    }

    try {
      normalizeBudgetStoreSnapshot(JSON.parse(fs.readFileSync(backupPath, "utf8")));
    } catch (error) {
      throw badRequest("Backup is invalid and cannot be restored", {
        phase: "backup_validation_failed",
        backupPath,
        error: error.message
      });
    }

    const safetyBackup = await createBackupAsync(userId, { deferCleanup: true });

    try {
      runBackupHook("before_restore_apply", { userId, backupPath, safetyBackup });
      const projection = await restoreBackupFromPathAsync(userId, backupPath);

      return {
        ok: true,
        restoredFrom: backupPath,
        safetyBackup,
        mode: "budget_store_snapshot",
        _projection: projection
      };
    } catch (error) {
      logError("cashflow_restore_failed_before_rollback", {
        userId,
        restoredFrom: backupPath,
        safetyBackup,
        error: error.message
      });
      try {
        runBackupHook("before_restore_rollback", { userId, backupPath, safetyBackup, error });
        await restoreBackupFromPathAsync(userId, safetyBackup);
        logServerEvent("cashflow_restore_rolled_back", {
          userId,
          restoredFrom: backupPath,
          safetyBackup,
          error: error.message
        });
      } catch (rollbackError) {
        logError("cashflow_restore_rollback_failed", {
          userId,
          restoredFrom: backupPath,
          safetyBackup,
          error: error.message,
          rollbackError: rollbackError.message
        });
        const combined = new Error("Restore failed and rollback also failed");
        combined.status = 500;
        combined.details = {
          phase: "rollback_failed",
          safetyBackup,
          originalError: error.message,
          originalStatus: Number(error?.status) || 500,
          rollbackError: rollbackError.message
        };
        throw combined;
      }

      const rolledBack = new Error(`Restore failed and was rolled back: ${error.message}`);
      rolledBack.status = Number(error?.status) || 500;
      if (error?.details) rolledBack.details = error.details;
      throw rolledBack;
    }
  }

  return {
    cleanupOperationalData,
    cleanupOperationalDataBestEffort,
    createBackup,
    createBackupAsync,
    maybeRunAutomaticBackup,
    maybeRunAutomaticBackupAsync,
    restoreBackup,
    restoreBackupAsync,
    restoreBackupFromPath,
    restoreBackupFromPathAsync,
    validateBackupFolderForRestore,
    validateCashflowData
  };
}
