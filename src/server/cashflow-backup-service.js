import Database from "better-sqlite3";
import { backupPruningPlan } from "./cashflow-backup-retention.js";
import { POSTGRES_BUDGET_COLUMNS } from "./cashflow-postgres-budget-schema.js";
import { rotateSqliteFinancialEpoch } from "./cashflow-financial-journal.js";
import { LEDGER_COLUMNS, LEDGER_IN_PLANNING_SCHEMA_VERSION } from "./cashflow-schema.js";
import { applyLedgerMigrations } from "./cashflow-migrations.js";
import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";
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
import { badRequest, conflict, notFound } from "./cashflow-user-utils.js";
import { readSqliteFinancialExportAudit, validateFinancialExportAudit } from './cashflow-ledger-audit-export.js';

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

// The service owns this cross-operation lock, so contention must retain the
// same typed HTTP conflict contract the former route wrapper exposed.
function dataPortabilityLockConflict(userId) {
  return conflict("An import or restore is already running for this budget", [{
    field: "operation",
    reason: "locked",
    lock: budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.dataPortability)
  }]);
}


import { BUDGET_RUNTIME_LOCK_JOBS, budgetRuntimeLockName } from "./cashflow-runtime-locks.js";

/** Durable backup/restore uses the same host-selected audit semantics as the
 * owning financial runtime; stored JSON cannot enable new origin semantics. */
export function createCashflowBackupService({
  allowStandaloneOrigins = false,
  lockService = null,
  backupDir,
  backupHook = null,
  backupRootDir,
  budgetStore = null,
  directorySizeBytes,
  generateId,
  getSettings,
  getGlobalOptions = () => ({}),
  getGlobalOptionsAsync = null,
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
  // Deliberately not async: the SQLite failure-injection tests rely on a
  // hook throwing synchronously and being caught by the caller's own local
  // try/catch. Wrapping that in an async function would turn the throw into
  // a rejected promise instead, which a non-awaiting (SQLite, synchronous)
  // caller below would never catch. Returning the hook's result unwrapped
  // lets an async caller (the Postgres path) still `await` it to pause
  // mid-operation for its own tests, while a sync caller that doesn't await
  // keeps today's synchronous-throw behavior exactly as before.
  function runBackupHook(phase, details = {}) {
    if (typeof backupHook === "function") return backupHook({ phase, ...details });
  }

  // Postgres has no VACUUM INTO / file-copy equivalent, so its backup path
  // stores a JSON budget-store snapshot in the shared artifact table. The
  // logical reference is retained in backup_metadata for discovery/restore.
  function usesPostgresBudgetStoreForBackup() {
    return budgetStore?.backend === "postgres"
      && typeof budgetStore.listPlanningRows === "function"
      && typeof budgetStore.insertPlanningRows === "function"
      && typeof budgetStore.saveBackupArtifact === "function"
      && typeof budgetStore.readBackupArtifact === "function"
      && typeof getSettingsAsync === "function"
      && typeof recalculateLedgerRunningBalanceAsync === "function"
      && typeof regenerateProjectionsAfterMutationAsync === "function";
  }

  /** Verify every retained audit namespace against the complete backup ledger.
   * Unknown/orphan/foreign namespaces cannot become unaudited replacement data. */
  function validateSqliteBackupAudit(db, ledgerRows, expectedBudgetId = null) {
    const scopes = new Set();
    for (const table of ['cashflow_ledger_audit_state', 'cashflow_ledger_origins', 'cashflow_ledger_originals', 'cashflow_ledger_corrections']) {
      if (tableExists(db, table)) for (const row of db.prepare(`SELECT DISTINCT budget_id FROM ${table}`).all()) scopes.add(row.budget_id);
    }
    if (scopes.size > 1 || (expectedBudgetId !== null && [...scopes].some(id => id !== expectedBudgetId))) {
      throw new Error('Backup correction history has an unexpected budget scope');
    }
    if (!scopes.size) return null;
    const budgetId = [...scopes][0];
    const audit = readSqliteFinancialExportAudit(db, budgetId, { allowStandaloneOrigins });
    if (audit === null) throw new Error('Backup correction history has no retained parent state');
    const ledgers = {};
    for (const row of ledgerRows) (ledgers[row.ledger_year] ||= []).push(row);
    validateFinancialExportAudit(budgetId, audit, ledgers, { allowStandaloneOrigins });
    return audit;
  }

  /** Validate both SQLite integrity and financial evidence before publication
   * or replacement, including legacy yearly-ledger backups. */
  function validateBackupFolderForRestore(backupPath, expectedBudgetId = null) {
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
      validateSqliteBackupAudit(planningDb, backupLedgerRows(backupPath, planningSource, backupLedgerYears), expectedBudgetId);
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

  function collectSourceSets(tables) {
    return {
      source_recurring_expense_id: new Set(tables.recurring_expenses.map(row => row.id)),
      source_recurring_income_id: new Set(tables.recurring_incomes.map(row => row.id)),
      source_one_off_id: new Set(tables.one_off_transactions.map(row => row.id)),
      source_flex_id: new Set(tables.flex_transactions.map(row => row.id)),
      source_goal_id: new Set(tables.goals.map(row => row.id))
    };
  }

  function validateSettingsRow(warnings, tables) {
    const settings = tables.settings.find(row => Number(row.id) === 1);
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
      ["notification_channels", () => settings.notification_channels == null || /^(ntfy|discord)?(,(ntfy|discord))?$/.test(String(settings.notification_channels))],
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
      const row = tables.recurring_incomes.find(row => row.id === settings.budget_period_income_id
        && Number(row.active) === 1 && Number(row.period_setting) === 1);
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

  function validatePlanningSourceLinks(warnings, tables) {
    const sourceSets = collectSourceSets(tables);
    const rowsByTable = [
      ["pending_transactions", tables.pending_transactions],
      ["future_transactions", tables.future_transactions]
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

    const plannedRows = tables.planned_transactions;
    for (const planned of plannedRows) {
      const references = [
        ["recurring_expenses", "recurring_expense"],
        ["flex_transactions", "flex"],
        ["goals", "goal"]
      ].flatMap(([table, expectedType]) =>
        tables[table].filter(row => row.planned_transaction_id === planned.id)
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

  function validateOccurrenceKeys(warnings, tables, confirmedRows) {
    const occurrences = new Map();
    const add = (row, table, year = null) => {
      const key = row.occurrence_key;
      if (!key) return;
      if (!occurrences.has(key)) occurrences.set(key, []);
      occurrences.get(key).push({ table, id: row.id, year });
    };

    for (const row of tables.pending_transactions.filter(row => row.occurrence_key != null)) {
      add(row, "pending_transactions");
    }
    for (const row of tables.future_transactions.filter(row => row.occurrence_key != null)) {
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

  // Both storage backends feed the same validation rules with plain rows.
  const validationTables = ["settings", "planned_transactions", "recurring_expenses",
    "recurring_incomes", "one_off_transactions", "flex_transactions", "goals",
    "pending_transactions", "future_transactions"];

  function duplicatePriorities(rows, field) {
    const counts = new Map();
    for (const row of rows) {
      if (row[field] != null) counts.set(row[field], (counts.get(row[field]) || 0) + 1);
    }
    return [...counts].filter(([, count]) => count > 1).map(([priority, count]) => ({ priority, count }));
  }

  function validateRows(tables, confirmedRows) {
    const warnings = [];
    const { ledgerCurrency } = validateSettingsRow(warnings, tables);
    const duplicateOperating = duplicatePriorities(tables.planned_transactions.filter(row =>
      ["recurring_expense", "flex"].includes(row.type)), "operating_priority");

    for (const row of duplicateOperating) {
      warnings.push({
        type: "duplicate_operating_priority",
        message: `Duplicate operating priority ${row.priority}`,
        details: row
      });
    }

    const duplicateGoals = duplicatePriorities(tables.planned_transactions.filter(row =>
      row.type === "goal"), "goal_priority");

    for (const row of duplicateGoals) {
      warnings.push({
        type: "duplicate_goal_priority",
        message: `Duplicate goal priority ${row.priority}`,
        details: row
      });
    }

    const badFlex = tables.flex_transactions.filter(row => Number(row.allow_split) === 1
      && row.min_amount != null && row.max_amount != null
      && Number(row.min_amount) > Number(row.max_amount));

    for (const row of badFlex) {
      warnings.push({
        type: "invalid_flex_min_max",
        message: `${row.name} has min_amount greater than max_amount`,
        details: row
      });
    }

    for (const table of ["pending_transactions", "future_transactions"]) {
      const rows = tables[table];
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

    const orphanPlanned = tables.planned_transactions.filter(row =>
      ![...tables.recurring_expenses, ...tables.flex_transactions, ...tables.goals]
        .some(source => source.planned_transaction_id === row.id));

    for (const row of orphanPlanned) {
      warnings.push({
        type: "orphan_planned_transaction",
        message: `Orphan planned transaction ${row.id}`,
        details: row
      });
    }

    validatePlanningSourceLinks(warnings, tables);
    validateOccurrenceKeys(warnings, tables, confirmedRows);
    validateLedgerRows(warnings, confirmedRows, ledgerCurrency);

    const invalidPending = tables.pending_transactions.filter(row =>
      Number(row.amount) < 0 || row.date == null || row.currency == null);

    for (const row of invalidPending) {
      warnings.push({
        type: "invalid_pending_transaction",
        message: `Invalid pending transaction ${row.id}`,
        details: row
      });
    }

    return { ok: warnings.length === 0, warnings };
  }

  function validationEvent(userId, result) {
    return {
      id: generateId("event"), action: "validation_completed", entity_type: "cashflow",
      entity_id: userId, details: JSON.stringify({ warning_count: result.warnings.length, warnings: result.warnings }),
      timestamp: now().toISOString()
    };
  }

  function validateCashflowData(userId) {
    // Preserve the synchronous SQLite API for existing callers.
    const db = openPlanningDb(userId);
    try {
      const tables = Object.fromEntries(validationTables.map(table =>
        [table, db.prepare(`SELECT * FROM ${table}`).all()]));
      const confirmedRows = [];
      for (const year of listLedgerYears(userId)) {
        const ledgerDb = openLedgerDb(userId, year);
        try {
          confirmedRows.push(...ledgerDb.prepare("SELECT *, ? AS ledger_year FROM confirmed_transactions").all(year));
        } finally {
          ledgerDb.close();
        }
      }
      const result = validateRows(tables, confirmedRows);
      const event = validationEvent(userId, result);
      db.prepare(`INSERT INTO event_log (id, action, entity_type, entity_id, details, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)`).run(event.id, event.action, event.entity_type, event.entity_id, event.details, event.timestamp);
      return result;
    } finally {
      db.close();
    }
  }

  async function validateCashflowDataAsync(userId) {
    // Never open SQLite files when the budget store owns PostgreSQL storage.
    if (budgetStore?.backend !== "postgres") return validateCashflowData(userId);
    const tables = Object.fromEntries(await Promise.all(validationTables.map(async table =>
      [table, await budgetStore.listPlanningRows(userId, table)])));
    const confirmedRows = [];
    for (const year of await budgetStore.listLedgerYears(userId)) {
      const rows = await budgetStore.listConfirmedTransactions(userId, { ledgerYear: year });
      confirmedRows.push(...rows.map(row => ({ ...row, ledger_year: year })));
    }
    const result = validateRows(tables, confirmedRows);
    await budgetStore.insertPlanningRows(userId, "event_log", [validationEvent(userId, result)]);
    return result;
  }

  const protectedBackups = new Set();

  /** Pin recovery artifacts across asynchronous mutations, including rollback. */
  function protectBackup(backupPath) {
    protectedBackups.add(backupPath);
    return () => protectedBackups.delete(backupPath);
  }

  /** Metadata alone is not authority to recursively remove an arbitrary path.
   * Require the app's exact folder shape, only owned regular files, and a
   * readable Cashflow schema. Symlinks and foreign files are left untouched.
   */
  function isOwnedBackupFolder(backupPath, roots = null, temporary = false, expectedBudgetId = null) {
    if (roots && !roots.some(root => path.dirname(path.resolve(backupPath)) === path.resolve(root))) return false;
    if (!/^backup_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_backup[-_][a-zA-Z0-9_-]+(?:\.tmp)?$/.test(path.basename(backupPath))) return false;
    try {
      if (!fs.lstatSync(backupPath).isDirectory()) return false;
      const files = fs.readdirSync(backupPath, { withFileTypes: true });
      if (!files.length || files.some(file => !file.isFile() || !/^(planning\.sqlite|ledger_\d{4}\.sqlite)$/.test(file.name))) return false;
      const db = new Database(path.join(backupPath, 'planning.sqlite'), { readonly: true, fileMustExist: true });
      try { if (!tableExists(db, 'settings') || !tableExists(db, 'backup_metadata')) return false; }
      finally { db.close(); }
      if (!temporary) validateBackupFolderForRestore(backupPath, expectedBudgetId);
      return temporary || !backupPath.endsWith('.tmp');
    } catch { return false; }
  }

  function cleanupBackupFolders(userId, keepPaths = []) {
    const settings = getSettings(userId);
    const db = openPlanningDb(userId);
    try {
      // Metadata keeps historical custom locations discoverable after a move.
      // The folder must still identify this exact registered backup and pass
      // the same budget-scoped validation as restore before recursive deletion.
      const backups = db.prepare('SELECT * FROM backup_metadata WHERE success = 1').all()
        .filter(row => typeof row.backup_path === 'string'
          && path.basename(row.backup_path).endsWith(`_${row.id}`)
          && isOwnedBackupFolder(row.backup_path, null, false, userId));
      const toDelete = backupPruningPlan(backups, settings, getGlobalOptions(), now().getTime(),
        [...protectedBackups, ...keepPaths]);
      let deleted = 0;
      for (const backup of toDelete) {
        fs.rmSync(backup.backup_path, { recursive: true });
        db.prepare('DELETE FROM backup_metadata WHERE id = ? AND success = 1').run(backup.id);
        deleted += 1;
      }
      return { deleted };
    } finally { db.close(); }
  }

  /** Use the same portability lock as restore/import in scheduled maintenance.
   * Artifact bytes and metadata disappear in one PostgreSQL transaction.
   */
  async function cleanupOperationalDataAsync(userId, { dataPortabilityLockHeld = false, keepPaths = [] } = {}) {
    const work = async () => {
      if (!usesPostgresBudgetStoreForBackup()) return cleanupOperationalData(userId, keepPaths);
      const settings = await getSettingsAsync(userId);
      const options = getGlobalOptionsAsync ? await getGlobalOptionsAsync() : getGlobalOptions();
      return budgetStore.transaction(async writer => {
        await writer.lockBudgetLedger(userId);
        const rows = await writer.listBackupArtifactsForPruning(userId);
        const toDelete = backupPruningPlan(rows, settings, options, now().getTime(), [...protectedBackups, ...keepPaths]);
        let backupsDeleted = 0;
        for (const row of toDelete) {
          backupsDeleted += await writer.deleteBackupArtifact(userId, row.id);
        }
        return { backupsDeleted, metadataDeleted: backupsDeleted };
      });
    };
    if (dataPortabilityLockHeld || !lockService?.withLock) return work();
    const result = await lockService.withLock(budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.dataPortability), work, { ttlMs: 300000 });
    return result.acquired ? result.result : { backupsDeleted: 0, skipped: true };
  }

  async function cleanupOperationalDataBestEffortAsync(userId, reason, options = {}) {
    try {
      await runBackupHook('before_retention_cleanup', { userId, reason });
      const result = await cleanupOperationalDataAsync(userId, options);
      logServerEvent('cashflow_operational_retention_completed', { userId, reason, ...result });
      return result;
    } catch (error) {
      logError('cashflow_operational_retention_failed', { userId, reason, code: error.code || 'retention_failed' });
      return null;
    }
  }

  function cleanupStaleTemporaryFolders(dir, currentTime) {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
    let deleted = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".tmp")) continue;
      const fullPath = path.join(dir, entry.name);
      if (!isOwnedBackupFolder(fullPath, [dir], true)) continue;
      if (currentTime - fs.statSync(fullPath).mtimeMs <= STALE_TEMP_AGE_MS) continue;
      fs.rmSync(fullPath, { recursive: true, force: true });
      deleted += 1;
    }
    return deleted;
  }

  function cleanupOperationalData(userId, keepPaths = []) {
    const settings = getSettings(userId);
    const root = backupRootDir(userId, settings);
    const builtInRoot = typeof backupDir === "function" ? backupDir(userId) : root;
    const currentTime = now().getTime();
    const folderCleanup = cleanupBackupFolders(userId, keepPaths);
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
        metadataDeleted: result.metadataDeleted + folderCleanup.deleted,
        backupsDeleted: folderCleanup.deleted,
        migrationBackupsDeleted: migrationCleanup.completedDeleted,
        staleTemporaryDeleted: staleTemporaryDeleted + migrationCleanup.staleTemporaryDeleted
      };
    } finally {
      db.close();
    }
  }

  function cleanupOperationalDataBestEffort(userId, reason, keepPaths = []) {
    try {
      runBackupHook("before_retention_cleanup", { userId, reason });
      const result = cleanupOperationalData(userId, keepPaths);
      logServerEvent("cashflow_operational_retention_completed", { userId, reason, ...result });
      return result;
    } catch (error) {
      logError("cashflow_operational_retention_failed", {
        userId,
        reason,
        code: error.code || 'retention_failed'
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

    const backupPath = await createBackupAsync(userId);
    return { backupPath };
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

      // Schema 22: the ledger is inside planning.sqlite, so the planning copy is
      // the whole budget; no yearly ledger files are written any more.

      runBackupHook("before_backup_validation", { userId, backupRoot, temporaryRoot });
      validateBackupFolderForRestore(temporaryRoot);
      fs.renameSync(temporaryRoot, backupRoot);
      runBackupHook("before_success_metadata", { userId, backupRoot });
      recordMetadata(true, null, directorySizeBytes(backupRoot));
      if (!deferCleanup) cleanupOperationalDataBestEffort(userId, "backup_created", [backupRoot]);
      else {
        // Safety backups still enforce backup limits; full operational cleanup
        // waits until the owning mutation finishes.
        try {
          const result = cleanupBackupFolders(userId, [backupRoot]);
          logServerEvent('cashflow_operational_retention_completed', { userId, reason: 'safety_backup_created', backupsDeleted: result.deleted });
        } catch (error) {
          logError('cashflow_operational_retention_failed', { userId, reason: 'safety_backup_created', code: error.code || 'retention_failed' });
        }
      }
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
    const runBackup = async () => {
    if (!usesPostgresBudgetStoreForBackup()) return createBackup(userId, options);

    const createdAt = now().toISOString();
    const backupId = generateId("backup");
    const backupPath = `postgres-backup:${backupId}`;

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
      // The snapshot reads each planning/ledger table with its own separate
      // query, so it only avoids a torn read if every one of those queries
      // runs inside the same transaction/connection as the lock that blocks
      // ordinary mutations (see lockBudgetLedger) - and the lock has to stay
      // held for that whole transaction, not just an instant before it,
      // since a pg_advisory_xact_lock releases at commit. Taking the lock
      // and then committing in its own separate transaction (as this used
      // to) therefore releases the lock before any table is read, giving no
      // protection at all against a mutation committing partway through.
      //
      // Deliberately plain READ COMMITTED, not REPEATABLE READ: this lock is
      // the same one an in-flight mutation already waits on (see the test
      // above this comment's sibling in backup-service.test.js), so once our
      // lockBudgetLedger call below returns, any such mutation has already
      // committed - REPEATABLE READ would instead freeze our view as of
      // *before* that wait resolved (Postgres fixes a REPEATABLE READ
      // snapshot at the transaction's first statement, even one that itself
      // blocks), making every read below silently stale. READ COMMITTED
      // lets each read see whatever is truly committed as of right now,
      // which combined with the lock being held for the whole read is both
      // necessary and sufficient: nothing using the same lock can commit a
      // conflicting change until we release it.
      const snapshot = await budgetStore.transaction(async writer => {
        await writer.lockBudgetLedger(userId);
        await runBackupHook("before_planning_copy", { userId, backupPath });
        return await createBudgetStoreSnapshot({
          allowStandaloneOrigins,
          budgetIds: [userId],
          budgetStore: writer,
          excludeBackupMetadata: true,
          reason: options.reason || "manual"
        });
      });
      const serialized = JSON.stringify(snapshot);

      await runBackupHook("before_backup_validation", { userId, backupPath });
      normalizeBudgetStoreSnapshot(snapshot, { allowStandaloneOrigins });

      await runBackupHook("before_success_metadata", { userId, backupPath });
      await budgetStore.saveBackupArtifact(userId, {
        id: backupId,
        backup_timestamp: createdAt,
        backup_path: backupPath,
        size_bytes: Buffer.byteLength(serialized, "utf8"),
        success: true,
        error_message: null,
        created_at: new Date().toISOString()
      }, serialized);
      await cleanupOperationalDataBestEffortAsync(userId, 'backup_created', {
        dataPortabilityLockHeld: true, keepPaths: [backupPath]
      });
      return backupPath;
    } catch (error) {
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
    };

    // Restore already holds this exact lock while creating its safety backup.
    // Public/manual backup calls still acquire it here as before.
    if (options.dataPortabilityLockHeld) {
      return await runBackup();
    }
    if (lockService && typeof lockService.withLock === "function") {
      const lockResult = await lockService.withLock(
        budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.dataPortability),
        runBackup,
        { ttlMs: 300000 }
      );
      if (!lockResult?.acquired) {
        throw dataPortabilityLockConflict(userId);
      }
      return lockResult.result;
    }
    return await runBackup();
  }

  /** Replace planning, ledger, retained audit and device fence together. A
   * backup without audit explicitly clears the replaced audit namespace. */
  function importPlanningBackupIntoLiveDb(userId, backupPlanningPath, ledgerRows = [], afterReplace = () => null) {
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
      const sourceAudit = validateSqliteBackupAudit(backupDb, ledgerRows, userId);

      return liveDb.transaction(() => {
        if (tableExists(liveDb, 'cashflow_ledger_audit_state')) {
          const previous = liveDb.prepare('SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = ?').get(userId);
          if (Number(previous?.origin_version ?? 0) !== 0 && !allowStandaloneOrigins) throw new Error('Standalone ledger origins need an upgraded backup host');
        }
        liveDb.pragma("foreign_keys = OFF");

        // Delete children explicitly: PRAGMA foreign_keys cannot change inside
        // an active transaction, and correctness must not depend on its value.
        const auditTables = ['cashflow_ledger_audit_state', 'cashflow_ledger_origins', 'cashflow_ledger_originals', 'cashflow_ledger_corrections'];
        for (const table of [...auditTables].reverse()) if (tableExists(liveDb, table)) liveDb.prepare(`DELETE FROM ${table}`).run();

        for (const tableName of deleteOrder) {
          if (tableExists(liveDb, tableName)) {
            liveDb.prepare(`DELETE FROM ${tableName}`).run();
          }
        }

        for (const tableName of insertOrder) {
          replaceTableRowsFromBackup(liveDb, backupDb, tableName);
        }
        // The ledger and the device fence commit with the planning tables.
        liveDb.prepare("DELETE FROM ledger_transactions").run();
        const insertLedger = liveDb.prepare(`INSERT INTO ledger_transactions (${LEDGER_COLUMNS.join(", ")}, ledger_year)
          VALUES (${LEDGER_COLUMNS.map(() => "?").join(", ")}, ?)`);
        const defaults = { ledger_currency: "PLN", running_balance_pln: 0 };
        for (const row of ledgerRows) insertLedger.run(...LEDGER_COLUMNS.map(column => row[column] ?? defaults[column] ?? null), Number(row.ledger_year));
        for (const table of auditTables) replaceTableRowsFromBackup(liveDb, backupDb, table);
        const retainedAudit = validateSqliteBackupAudit(liveDb, liveDb.prepare('SELECT * FROM ledger_transactions').all(), userId);
        if (JSON.stringify(sourceAudit) !== JSON.stringify(retainedAudit)) throw new Error('Restored correction history was not retained completely');
        rotateSqliteFinancialEpoch(liveDb, userId);

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
        return afterReplace(liveDb);
      })();
    } finally {
      backupDb.close();
      liveDb.close();
    }
  }

  /** Ledger rows of a backup: from its planning.sqlite (schema 22+), or, for a
   * legacy backup, from its yearly files, migrated on a temporary copy. */
  function backupLedgerRows(backupPath, planningSource, backupLedgerYears) {
    const planning = new Database(planningSource, { readonly: true, fileMustExist: true });
    try {
      initReadOnlyPragmas(planning);
      // Only a merged planning file holds the ledger; an older backup whose
      // planning copy was just migrated has the table but still empty.
      if (Number(planning.pragma("user_version", { simple: true })) >= LEDGER_IN_PLANNING_SCHEMA_VERSION
        && tableExists(planning, "ledger_merge_state")
        && planning.prepare("SELECT 1 FROM ledger_merge_state WHERE id = 1").get()) {
        return planning.prepare("SELECT * FROM ledger_transactions").all();
      }
    } finally { planning.close(); }
    const rows = [];
    for (const year of backupLedgerYears) {
      const copy = path.join(backupPath, `.restore-ledger-${year}-${process.pid}.sqlite`);
      fs.copyFileSync(path.join(backupPath, `ledger_${year}.sqlite`), copy);
      const ledger = new Database(copy);
      try {
        applyLedgerMigrations(ledger, { occurrenceKeyFromRow });
        for (const row of ledger.prepare("SELECT * FROM confirmed_transactions").all()) rows.push({ ...row, ledger_year: Number(year) });
      } finally { ledger.close(); for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(copy + suffix, { force: true }); }
    }
    return rows;
  }

  function restoreBackupFromPath(userId, backupPath) {
    const { planningSource, backupLedgerYears } = validateBackupFolderForRestore(backupPath, userId);
    const ledgerRows = backupLedgerRows(backupPath, planningSource, backupLedgerYears);
    return importPlanningBackupIntoLiveDb(userId, planningSource, ledgerRows, db => {
      runBackupHook('after_restore_replace', { userId });
      recalculateLedgerRunningBalance(userId, { db });
      const projection = regenerateProjectionsAfterMutation(userId, { db });
      if (projection && typeof projection.then === 'function') throw new Error('Synchronous restore requires synchronous projection');
      if (projection?.projection_ok === false) throw new Error(`Projection regeneration failed after restore: ${projection.projection_error || 'unknown error'}`);
      return projection;
    });
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
      validateBackupFolderForRestore(backupPath, userId);
    } catch (error) {
      throw badRequest("Backup is invalid and cannot be restored", {
        phase: "backup_validation_failed",
        backupPath,
        error: error.message
      });
    }

    const release = protectBackup(backupPath);
    let result;
    try {
      const safetyBackup = createBackup(userId, { deferCleanup: true });

      // Failure rolls back the owning SQLite transaction; never compensate with
      // an older independently captured snapshot after releasing its locks.
      runBackupHook('before_restore_apply', { userId, backupPath, safetyBackup });
      const projection = restoreBackupFromPath(userId, backupPath);
      result = { ok: true, restoredFrom: backupPath, safetyBackup,
        mode: 'row_import_validated', _projection: projection };
    } finally { release(); }
    // Prune once the source is no longer pinned, so the limits hold again.
    // The safety backup is the way back from this restore; always keep it.
    cleanupOperationalDataBestEffort(userId, 'restore_completed', [result.safetyBackup]);
    return result;
  }

  /** Read and validate an artifact before acquiring the owning write transaction.
   * SQLite file backups are adapted to the same scoped snapshot contract as PG. */
  async function snapshotForRestore(userId, backupPath) {
    if (budgetStore?.backend === 'sqlite') {
      if (!fs.existsSync(backupPath)) throw notFound('Backup not found', [{ field: 'backupId', reason: 'backup_folder_missing' }]);
      const { planningSource, backupLedgerYears } = validateBackupFolderForRestore(backupPath, userId);
      const ledgerRows = backupLedgerRows(backupPath, planningSource, backupLedgerYears);
      const db = new Database(planningSource, { readonly: true, fileMustExist: true });
      try {
        const scoped = (table, rows) => rows.map(row => Object.fromEntries(
          POSTGRES_BUDGET_COLUMNS[table].map(key => [key, key === 'budget_id' ? userId : row[key]])
            .filter(([, value]) => value !== undefined)));
        return await createBudgetStoreSnapshot({ budgetIds: [userId], allowStandaloneOrigins,
          excludeBackupMetadata: true, budgetStore: {
            backend: 'sqlite',
            listPlanningRows: async (_id, table) => tableExists(db, table) ? scoped(table, db.prepare(`SELECT * FROM "${table}"`).all()) : [],
            listConfirmedTransactions: async () => scoped('confirmed_transactions', ledgerRows),
            listLedgerYears: async () => [...new Set(ledgerRows.map(row => Number(row.ledger_year)))],
            exportLedgerAuditSnapshot: async () => readSqliteFinancialExportAudit(db, userId, { allowStandaloneOrigins })
          } });
      } finally { db.close(); }
    }
    let raw;
    if (String(backupPath).startsWith('postgres-backup:')) {
      raw = await budgetStore.readBackupArtifact(userId, String(backupPath).slice('postgres-backup:'.length));
      if (raw == null) throw notFound('Backup not found');
    } else {
      if (!fs.existsSync(backupPath)) throw notFound('Backup not found');
      raw = fs.readFileSync(backupPath, 'utf8');
    }
    const snapshot = normalizeBudgetStoreSnapshot(JSON.parse(raw), { allowStandaloneOrigins });
    if (snapshot.budgetIds.length !== 1 || snapshot.budgetIds[0] !== userId) throw badRequest('Backup budget does not match');
    return snapshot;
  }

  /** Replacement, audit, epoch, balances and projections commit together. No
   * later snapshot compensation may overwrite an independently committed write. */
  async function applyRestoreSnapshot(userId, snapshot, within = null) {
    const run = within || (work => budgetStore.backend === 'sqlite'
      ? budgetStore.planningTransaction(userId, work) : budgetStore.transaction(work));
    try {
      return await run(async writer => {
        // Nested snapshot transactions must join this exact writer/commit.
        const store = new Proxy(writer, { get(target, prop) {
          if (prop === 'transaction') return callback => callback(store);
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        if (typeof store.lockBudgetLedger === 'function') await store.lockBudgetLedger(userId);
        await restoreBudgetStoreSnapshot({ budgetStore: store, allowStandaloneOrigins,
          includeExistingLedgerYears: true, preserveBackupMetadata: true, snapshot });
        await runBackupHook("after_restore_replace", { userId });
        await recalculateLedgerRunningBalanceAsync(userId, { store });
        const projection = await regenerateProjectionsAfterMutationAsync(userId, { store });
        if (projection?.projection_ok === false) throw new Error(`Projection regeneration failed after restore: ${projection.projection_error || 'unknown error'}`);
        return projection;
      });
    } catch (error) {
      // The owning transaction has settled before reporting rollback. Never
      // reapply the safety snapshot or log raw errors/artifact contents.
      logServerEvent("cashflow_restore_rolled_back", { userId, recovery: "transaction" });
      const rolledBack = new Error(`Restore failed and was rolled back: ${error.message}`);
      rolledBack.status = Number(error?.status) || 500;
      if (error?.details) rolledBack.details = error.details;
      throw rolledBack;
    }
  }

  async function restoreBackupFromPathAsync(userId, backupPath) {
    return applyRestoreSnapshot(userId, await snapshotForRestore(userId, backupPath));
  }

  /** Authorization supplied by the device host runs inside the same transaction
   * as replacement; the pre-apply hook remains outside that boundary. */
  async function restoreBackupAsync(userId, backupId, { within = null } = {}) {
    const runRestore = async () => {
      const row = (await budgetStore.listPlanningRows(userId, 'backup_metadata')).find(row => row.id === backupId);
      if (!row?.backup_path || !Number(row.success)) throw notFound('Backup not found');
      const release = protectBackup(row.backup_path);
      let result;
      try {
        let snapshot;
        try { snapshot = await snapshotForRestore(userId, row.backup_path); }
        catch (error) {
          if (error?.status === 404) throw error;
          throw badRequest('Backup is invalid and cannot be restored', { phase: 'backup_validation_failed' });
        }
        const safetyBackup = await createBackupAsync(userId, { deferCleanup: true, dataPortabilityLockHeld: true });
        const releaseSafety = protectBackup(safetyBackup);
        try {
          await runBackupHook('before_restore_apply', { userId, backupPath: row.backup_path, safetyBackup });
          const projection = await applyRestoreSnapshot(userId, snapshot, within);
          result = { ok: true, restoredFrom: row.backup_path, safetyBackup,
            mode: budgetStore.backend === 'sqlite' ? 'row_import_validated' : 'budget_store_snapshot', _projection: projection };
        } finally { releaseSafety(); }
      } finally { release(); }
      // Prune once the source is no longer pinned, so the limits hold again.
      // The safety backup is the way back from this restore; always keep it.
      await cleanupOperationalDataBestEffortAsync(userId, 'restore_completed', { dataPortabilityLockHeld: true, keepPaths: [result.safetyBackup] });
      return result;
    };
    if (!lockService || typeof lockService.withLock !== 'function') return runRestore();
    const result = await lockService.withLock(budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.dataPortability), runRestore, { ttlMs: 300000 });
    if (!result?.acquired) throw dataPortabilityLockConflict(userId);
    return result.result;
  }

  return {
    cleanupOperationalData,
    cleanupOperationalDataAsync,
    cleanupOperationalDataBestEffort,
    cleanupOperationalDataBestEffortAsync,
    protectBackup,
    createBackup,
    createBackupAsync,
    maybeRunAutomaticBackup,
    maybeRunAutomaticBackupAsync,
    restoreBackup,
    restoreBackupAsync,
    restoreBackupFromPath,
    restoreBackupFromPathAsync,
    validateBackupFolderForRestore,
    validateCashflowData,
    validateCashflowDataAsync
  };
}
