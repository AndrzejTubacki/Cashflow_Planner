import { requireMoneyAmount } from "./cashflow-input-validation.js";
import { createNodeLedgerAuditReplay } from "./cashflow-ledger-audit-store.js";
import { readSqliteFinancialExportAudit, validateFinancialExportAudit } from "./cashflow-ledger-audit-export.js";
import { createHash } from "crypto";
import { rotateSqliteFinancialEpoch } from "./cashflow-financial-journal.js";
import { requireIsoDate } from "./cashflow-date-utils.js";
import {
  applyBudgetStoreImportPlan,
  createBudgetStoreImportPlanFromFullExport,
  createBudgetStorePayloadFromFullExport
} from "./cashflow-budget-store-import-plan.js";
import {
  createBudgetStoreSnapshot,
  normalizeBudgetStoreSnapshot,
  restoreBudgetStoreSnapshot
} from "./cashflow-budget-store-snapshot.js";
import { requireSupportedCurrency } from "./cashflow-fx-provider-utils.js";
import { validateFullImportRows } from "./cashflow-import-validation.js";
import { roundMoneyAmount } from "./cashflow-money-utils.js";
import { POSTGRES_BUDGET_COLUMNS } from "./cashflow-postgres-budget-schema.js";
import { LEDGER_SCHEMA_VERSION, PLANNING_SCHEMA_VERSION } from "./cashflow-schema.js";
import {
  OPERATIONAL_SETTINGS_COLUMNS,
  validateAndNormalizeSettings
} from "./cashflow-settings-validation.js";
import { badRequest, conflict } from "./cashflow-user-utils.js";
import { BUDGET_RUNTIME_LOCK_JOBS, budgetRuntimeLockName } from "./cashflow-runtime-locks.js";

const EXPORT_FORMAT = "cashflow-full-export";
const EXPORT_VERSION = 1;

// Full/sample imports own the shared cross-operation lock. Keep contention
// as a typed HTTP conflict now that the redundant route lock is gone.
function dataPortabilityLockConflict(userId) {
  return conflict("An import or restore is already running for this budget", [{
    field: "operation",
    reason: "locked",
    lock: budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.dataPortability)
  }]);
}

const PLANNING_EXPORT_TABLES = [
  "settings",
  "fx_rates_cache",
  "ledger_currency_events",
  "planned_transactions",
  "recurring_expenses",
  "recurring_incomes",
  "flex_transactions",
  "goals",
  "one_off_transactions",
  "pending_transactions"
];

const PLANNING_DELETE_ORDER = [
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

const PLANNING_INSERT_ORDER = [
  "settings",
  "fx_rates_cache",
  "ledger_currency_events",
  "planned_transactions",
  "recurring_expenses",
  "recurring_incomes",
  "flex_transactions",
  "goals",
  "one_off_transactions",
  "pending_transactions"
];

const ID_TABLES = [
  "ledger_currency_events",
  "planned_transactions",
  "recurring_expenses",
  "recurring_incomes",
  "flex_transactions",
  "goals",
  "one_off_transactions",
  "pending_transactions"
];

const ONE_OFF_CSV_COLUMNS = ["name", "type", "amount", "currency", "date"];
const CONFIRMED_LEDGER_CSV_HEADERS = [
  "ledger_year",
  "id",
  "name",
  "type",
  "date",
  "confirmed_date",
  "currency",
  "amount",
  "ledger_currency",
  "ledger_amount",
  "fx_rate",
  "buffered_fx_rate",
  "running_balance",
  "source_recurring_expense_id",
  "source_recurring_income_id",
  "source_one_off_id",
  "source_flex_id",
  "source_goal_id",
  "occurrence_key",
  "created_at",
  "updated_at"
];
const SETTINGS_COMPAT_DEFAULTS = {
  holiday_country: "PL",
  minimum_reserve_enabled: 0,
  minimum_reserve_amount: 0,
  ledger_history_compaction_months: 0,
  notification_channel: "ntfy",
  ntfy_auth_token: null,
  discord_webhook_url: null
};

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map(col => col.name);
}

function selectRows(db, tableName) {
  return db.prepare(`SELECT * FROM ${tableName}`).all();
}

function insertRows(db, tableName, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;

  const liveColumns = tableColumns(db, tableName);
  const inserts = new Map();
  let count = 0;
  for (const row of rows) {
    const columns = liveColumns.filter(column => Object.prototype.hasOwnProperty.call(row, column));
    if (!columns.length) continue;
    const key = columns.join(",");
    let insert = inserts.get(key);
    if (!insert) {
      const columnList = columns.map(column => `"${column}"`).join(", ");
      const placeholders = columns.map(() => "?").join(", ");
      insert = db.prepare(`
        INSERT INTO ${tableName} (${columnList})
        VALUES (${placeholders})
      `);
      inserts.set(key, insert);
    }
    insert.run(...columns.map(column => row[column]));
    count += 1;
  }

  return count;
}

function csvEscape(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = "'" + text;
  }
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function confirmedLedgerRowsToCsv(rows = []) {
  const lines = [CONFIRMED_LEDGER_CSV_HEADERS.join(",")];

  for (const row of rows) {
    lines.push(CONFIRMED_LEDGER_CSV_HEADERS.map(header => {
      if (header === "running_balance") return csvEscape(row.running_balance_pln ?? row.running_balance);
      return csvEscape(row[header]);
    }).join(","));
  }

  return lines.join("\n");
}

function parseCsvLine(line, rowNumber = 1) {
  const values = [];
  let current = "";
  let inQuotes = false;
  let quoteClosed = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else if (inQuotes) {
        inQuotes = false;
        quoteClosed = true;
      } else if (current === "") {
        inQuotes = true;
        quoteClosed = false;
      } else {
        throw badRequest("CSV row has malformed quotes", [{ row: rowNumber, field: null, reason: "malformed_quotes" }]);
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      quoteClosed = false;
    } else {
      if (quoteClosed) {
        throw badRequest("CSV row has malformed quotes", [{ row: rowNumber, field: null, reason: "unexpected_character_after_quote" }]);
      }
      current += char;
    }
  }

  if (inQuotes) {
    throw badRequest("CSV row has malformed quotes", [{ row: rowNumber, field: null, reason: "unterminated_quote" }]);
  }

  values.push(current);
  return values;
}

function parseCsv(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(line => line.trim() !== "");

  if (!lines.length) {
    throw badRequest("CSV file is empty");
  }

  const headers = parseCsvLine(lines[0], 1).map(header => header.trim().toLowerCase());

  if (headers.length !== ONE_OFF_CSV_COLUMNS.length || headers.some((header, index) => header !== ONE_OFF_CSV_COLUMNS[index])) {
    const details = [];
    const missing = ONE_OFF_CSV_COLUMNS.filter(column => !headers.includes(column));
    const unexpected = headers.filter(column => !ONE_OFF_CSV_COLUMNS.includes(column));

    for (const column of missing) details.push({ row: 1, field: column, reason: "missing_column" });
    for (const column of unexpected) details.push({ row: 1, field: column, reason: "unexpected_column" });
    if (!details.length) details.push({ row: 1, field: null, reason: "columns_must_be_exactly_name_type_amount_currency_date" });

    throw badRequest("CSV columns must be exactly: name,type,amount,currency,date", details);
  }

  return lines.slice(1).map((line, index) => {
    const rowNumber = index + 2;
    const values = parseCsvLine(line, rowNumber);
    if (values.length !== headers.length) {
      throw badRequest("CSV row has the wrong number of columns", [{
        row: rowNumber,
        field: null,
        reason: "column_count_mismatch"
      }]);
    }

    const row = {};

    headers.forEach((header, valueIndex) => {
      row[header] = values[valueIndex] ?? "";
    });

    return {
      rowNumber: index + 2,
      row
    };
  });
}

function normalizeCsvOneOff({ rowNumber, row }, generateId) {
  const name = String(row.name || "").trim();
  const type = String(row.type || "").trim().toLowerCase();
  const details = [];
  const amountText = String(row.amount ?? "").trim();
  let amount = null;
  let currency = null;
  let date = null;

  if (!name) {
    details.push({ row: rowNumber, field: "name", reason: "required" });
  }

  if (!["income", "expense"].includes(type)) {
    details.push({ row: rowNumber, field: "type", reason: "must_be_income_or_expense" });
  }

  if (!amountText) {
    details.push({ row: rowNumber, field: "amount", reason: "required" });
  } else {
    const normalizedAmountText = amountText.replace(",", ".");
    amount = Number(normalizedAmountText);
    if (!Number.isFinite(amount)) {
      details.push({ row: rowNumber, field: "amount", reason: "must_be_numeric" });
    } else if (amount < 0) {
      details.push({ row: rowNumber, field: "amount", reason: "must_be_non_negative" });
    } else {
      try { amount = requireMoneyAmount(amountText, 'amount', { min: 0 }); }
      catch { details.push({ row: rowNumber, field: 'amount', reason: 'unsafe_money' }); }
    }
  }

  try {
    currency = requireSupportedCurrency(row.currency || "", `CSV row ${rowNumber} currency`);
  } catch {
    details.push({ row: rowNumber, field: "currency", reason: "unsupported_currency" });
  }

  try {
    date = requireIsoDate(row.date || "", `CSV row ${rowNumber} date`);
  } catch {
    details.push({ row: rowNumber, field: "date", reason: "invalid_date" });
  }

  if (details.length) {
    throw badRequest(`CSV row ${rowNumber} is invalid`, details);
  }

  return {
    id: generateId("oneoff"),
    name,
    currency,
    amount,
    type,
    date
  };
}

function cloneExportData(exportData) {
  return JSON.parse(JSON.stringify(exportData));
}

function stripOperationalSettings(settingsRow) {
  const next = { ...settingsRow };
  for (const column of OPERATIONAL_SETTINGS_COLUMNS) {
    delete next[column];
  }
  return next;
}

function hasFunctionalRows(exportData) {
  const planning = exportData?.planning || {};
  const functionalTables = [
    "planned_transactions",
    "recurring_expenses",
    "recurring_incomes",
    "flex_transactions",
    "goals",
    "one_off_transactions",
    "pending_transactions"
  ];

  return functionalTables.some(tableName => (planning[tableName] || []).length > 0)
    || Object.values(exportData?.ledgers || {}).some(rows => Array.isArray(rows) && rows.length > 0);
}

function canonicalizeForChecksum(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForChecksum);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalizeForChecksum(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function computeExportChecksum({ planning, ledgers, ledgerAudit }) {
  const canonical = canonicalizeForChecksum({ planning, ledgers, ...(ledgerAudit === undefined ? {} : { ledgerAudit }) });
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/** Audited exports use v2 so older readers cannot silently discard history.
 * Ordinary v1 exports retain their exact checksum and compatibility contract.
 * Origin export requires an explicitly upgraded owning host. */
function buildExportEnvelope({ appVersion, includeOperationalSettings, ledgers, planning, userId, ledgerAudit = null, allowStandaloneOrigins = false }) {
  if (ledgerAudit !== null) validateFinancialExportAudit(userId, ledgerAudit, ledgers, { allowStandaloneOrigins });
  return {
    format: EXPORT_FORMAT,
    version: ledgerAudit === null ? EXPORT_VERSION : 2,
    ...(ledgerAudit === null ? {} : { ledgerAudit }),
    schemaVersions: {
      planning: PLANNING_SCHEMA_VERSION,
      ledger: LEDGER_SCHEMA_VERSION
    },
    appVersion,
    exportedAt: new Date().toISOString(),
    userId,
    operationalSettingsIncluded: includeOperationalSettings,
    planning,
    ledgers,
    checksum: computeExportChecksum({ planning, ledgers, ...(ledgerAudit === null ? {} : { ledgerAudit }) })
  };
}

// The only real column rename in the migration history (schema v12): the
// ntfy settings column used to be called ntfy_topic. Everything since has
// been additive (new nullable/defaulted columns), which the column
// intersection in insertRows already reconciles safely on its own.
function applyKnownSettingsCompatRenames(settings) {
  if (!settings.ntfy_url && settings.ntfy_topic) {
    settings.ntfy_url = settings.ntfy_topic;
  }
  delete settings.ntfy_topic;
}

function planningRowColumns(rows) {
  const columns = new Set();
  for (const row of rows || []) {
    for (const key of Object.keys(row || {})) columns.add(key);
  }
  return columns;
}

// Only reports columns this schema expects that the export doesn't have
// (which import tolerates, backfilling defaults). The reverse case, a field
// in the export this schema no longer recognizes, can't reach this report:
// validateFullImportRows rejects it with a hard "unknown_field" error before
// a preview is built, for both preview and the real import.
function computeDefaultedColumns(exportedColumns, liveColumns) {
  return liveColumns.filter(column => !exportedColumns.has(column)).sort();
}

const SETTINGS_PREVIEW_IGNORED_FIELDS = new Set(["id", "budget_id", "updated_at"]);

function buildFullImportPreview({
  conflicts,
  currentRowCounts,
  currentSettings,
  exportData,
  ledgerYears,
  liveColumnsByTable,
  mode
}) {
  const tables = {};
  for (const tableName of PLANNING_EXPORT_TABLES) {
    const exportedRows = exportData.planning[tableName] || [];
    tables[tableName] = {
      exportRowCount: exportedRows.length,
      currentRowCount: currentRowCounts[tableName] ?? 0,
      defaultedColumns: computeDefaultedColumns(
        planningRowColumns(exportedRows),
        liveColumnsByTable[tableName] || []
      )
    };
  }

  const importedSettings = exportData.planning.settings[0] || {};
  const settingsChanges = Object.entries(importedSettings)
    .filter(([field]) => !SETTINGS_PREVIEW_IGNORED_FIELDS.has(field))
    .map(([field, value]) => ({
      field,
      from: currentSettings?.[field] ?? null,
      to: value ?? null
    }))
    .filter(change => String(change.from) !== String(change.to));

  return {
    ok: true,
    mode,
    schemaVersions: {
      export: exportData.schemaVersions || null,
      current: { planning: PLANNING_SCHEMA_VERSION, ledger: LEDGER_SCHEMA_VERSION }
    },
    tables,
    ledgerYears: {
      export: Object.keys(exportData.ledgers),
      current: ledgerYears
    },
    settingsChanges,
    conflicts: conflicts || []
  };
}

// Fence notification associations across asynchronous import preparation. Hashes
// stay internal and errors never contain destinations or stored credentials.
function notificationAssociationFingerprint(settings = {}) {
  return createHash("sha256").update(JSON.stringify([
    settings.ntfy_url || null, settings.ntfy_auth_token || null
  ])).digest("hex");
}

function assertImportNotificationState(settings, expected) {
  if (expected && notificationAssociationFingerprint(settings) !== expected) {
    throw conflict(String(settings.locale || "en").startsWith("pl")
      ? "Ustawienia powiadomień uległy zmianie; przygotuj import ponownie."
      : "Notification settings changed; prepare the import again.");
  }
}

function prepareExportDataForImport(exportData, options = {}) {
  const {
    currentSettings = {},
    includeOperationalSettings = false,
    merge = false,
    normalizeLocale = value => String(value || "en").trim().toLowerCase(),
    validateSettings = true
  } = options;
  if (merge && exportData.ledgerAudit) throw badRequest('Correction history cannot be merged; replace explicitly or create an independent copy');
  const prepared = cloneExportData(exportData);
  const settings = { ...(prepared.planning.settings[0] || {}) };
  const notificationTokenProvided = Object.hasOwn(settings, "ntfy_auth_token") && settings.ntfy_auth_token !== undefined;
  const hasData = hasFunctionalRows(prepared);
  const setupTimestamp = prepared.exportedAt || new Date().toISOString();

  applyKnownSettingsCompatRenames(settings);

  for (const [key, value] of Object.entries(SETTINGS_COMPAT_DEFAULTS)) {
    if (settings[key] === undefined || settings[key] === null || settings[key] === "") {
      settings[key] = value;
    }
  }

  if (settings.setup_completed === undefined || settings.setup_completed === null) {
    settings.setup_completed = hasData ? 1 : 0;
  }

  if (Number(settings.setup_completed) === 1 && !settings.setup_completed_at) {
    settings.setup_completed_at = setupTimestamp;
  }

  if (!settings.updated_at) {
    settings.updated_at = setupTimestamp;
  }

  const preservedOperationalSettings = Object.fromEntries(
    [...OPERATIONAL_SETTINGS_COLUMNS]
      .filter(field => Object.prototype.hasOwnProperty.call(currentSettings, field))
      .map(field => [field, currentSettings[field]])
  );
  let importSettings;
  if (merge) {
    importSettings = { ...currentSettings };
  } else if (includeOperationalSettings) {
    // Preserve an omitted token; a default null is not an explicit clear.
    if (!notificationTokenProvided) settings.ntfy_auth_token = currentSettings.ntfy_auth_token ?? null;
    importSettings = validateAndNormalizeSettings(settings, {
      currentSettings,
      notificationTokenProvided,
      includeOperationalSettings: true,
      normalizeLocale
    });
  } else {
    importSettings = {
      ...validateAndNormalizeSettings(stripOperationalSettings(settings), {
        includeOperationalSettings: false,
        normalizeLocale
      }),
      ...preservedOperationalSettings
    };
  }
  prepared.planning.settings = [validateSettings ? importSettings : { ...currentSettings }];
  validateFullImportRows(prepared, {
    validateBudgetPeriodIncome: !merge
  });
  return prepared;
}

function rolledBackError(error, safetyBackup, operation) {
  const wrapped = new Error(`${operation} failed and was rolled back: ${error.message}`);
  wrapped.status = Number(error?.status) || 500;
  if (error?.details) wrapped.details = error.details;
  if (error?.conflicts) wrapped.conflicts = error.conflicts;
  wrapped.rollback = {
    phase: "rolled_back",
    safetyBackup,
    originalError: error.message,
    originalStatus: wrapped.status
  };
  return wrapped;
}

function safeSnapshotSummary(snapshot) {
  return {
    budgetIds: Array.isArray(snapshot?.budgetIds) ? [...snapshot.budgetIds] : [],
    createdAt: snapshot?.createdAt || null,
    format: snapshot?.format || null,
    reason: snapshot?.reason || null
  };
}

function rolledBackSnapshotError(error, safetySnapshot, operation) {
  const wrapped = new Error(`${operation} failed and was rolled back: ${error.message}`);
  wrapped.status = Number(error?.status) || 500;
  if (error?.details) wrapped.details = error.details;
  if (error?.conflicts) wrapped.conflicts = error.conflicts;
  wrapped.rollback = {
    phase: "rolled_back",
    safetySnapshot: safeSnapshotSummary(safetySnapshot),
    originalError: error.message,
    originalStatus: wrapped.status
  };
  return wrapped;
}

function importedOccurrenceKeys(exportData) {
  return new Set([
    ...exportData.planning.pending_transactions,
    ...Object.values(exportData.ledgers).flat()
  ].map(row => row.occurrence_key).filter(Boolean));
}

/** Verify file structure/checksum and the host's supported financial semantics
 * before import planning. An input field cannot opt the host into origins. */
function normalizeExportPayload(payload, { allowStandaloneOrigins = false } = {}) {
  const exportData = payload?.export || payload;

  if (!exportData || typeof exportData !== "object") {
    throw badRequest("Import payload is missing export data");
  }

  if (exportData.format !== EXPORT_FORMAT) {
    throw badRequest("Unsupported export format");
  }

  if (![EXPORT_VERSION, 2].includes(Number(exportData.version))) {
    throw badRequest("Unsupported export version");
  }

  if (Number(exportData.version) === 1 && Object.hasOwn(exportData, 'ledgerAudit')) {
    throw badRequest('Version-1 export cannot contain correction history');
  }
  if (Number(exportData.version) === 2 && (!exportData.ledgerAudit || exportData.ledgerAudit.budgetId !== exportData.userId)) {
    throw badRequest('Audited export requires its complete original budget scope');
  }

  if (!exportData.planning || typeof exportData.planning !== "object") {
    throw badRequest("Export is missing planning data");
  }

  if (!exportData.ledgers || typeof exportData.ledgers !== "object") {
    throw badRequest("Export is missing ledger data");
  }

  if (exportData.checksum) {
    const expectedChecksum = computeExportChecksum({
      planning: exportData.planning,
      ledgers: exportData.ledgers,
      ...(Number(exportData.version) === 2 ? { ledgerAudit: exportData.ledgerAudit } : {})
    });
    if (exportData.checksum !== expectedChecksum) {
      throw badRequest("Export checksum does not match its contents; the file may be corrupted or was edited after export");
    }
  }

  const exportPlanningVersion = Number(exportData.schemaVersions?.planning);
  if (Number.isFinite(exportPlanningVersion) && exportPlanningVersion > PLANNING_SCHEMA_VERSION) {
    throw badRequest(
      `This export was created by a newer version of Cashflow (planning schema ${exportPlanningVersion}; this instance is on ${PLANNING_SCHEMA_VERSION}). Upgrade this instance before importing it.`
    );
  }

  const exportLedgerVersion = Number(exportData.schemaVersions?.ledger);
  if (Number.isFinite(exportLedgerVersion) && exportLedgerVersion > LEDGER_SCHEMA_VERSION) {
    throw badRequest(
      `This export was created by a newer version of Cashflow (ledger schema ${exportLedgerVersion}; this instance is on ${LEDGER_SCHEMA_VERSION}). Upgrade this instance before importing it.`
    );
  }

  for (const tableName of PLANNING_EXPORT_TABLES) {
    if (!Array.isArray(exportData.planning[tableName])) {
      throw badRequest(`Export is missing planning table: ${tableName}`);
    }
  }

  if (!Array.isArray(exportData.planning.settings) || exportData.planning.settings.length !== 1) {
    throw badRequest("Export must include exactly one settings row");
  }

  for (const [year, rows] of Object.entries(exportData.ledgers)) {
    if (!/^\d{4}$/.test(String(year)) || !Array.isArray(rows)) {
      throw badRequest(`Export has invalid ledger year: ${year}`);
    }
  }

  if (Number(exportData.version) === 2) validateFinancialExportAudit(exportData.userId, exportData.ledgerAudit, exportData.ledgers, { allowStandaloneOrigins });
  return exportData;
}

function sampleExport() {
  const now = "2026-06-01T10:00:00.000Z";

  const planning = {
      settings: [{
        id: 1,
        ledger_currency: "PLN",
        timezone: "Europe/Warsaw",
        locale: "en",
        holiday_country: "PL",
        future_periods: 4,
        minimum_reserve_enabled: 1,
        minimum_reserve_amount: 500,
        ledger_history_compaction_months: 0,
        budget_period_income_id: "sample-income-salary",
        fx_buffer_percent: 0,
        fx_provider: "manual",
        fx_used_currencies: "[\"EUR\"]",
        manual_fx_rates: "{\"EUR/PLN\":4.3}",
        auto_backup_enabled: 0,
        backup_interval_minutes: 1440,
        backup_retention_count: 10,
        backup_location: null,
        notification_channel: "ntfy",
        ntfy_url: null,
        ntfy_auth_token: null,
        discord_webhook_url: null,
        notification_delivery_time: "08:00",
        notify_goal_impossible: 1,
        notify_necessary_underfunded: 1,
        notify_funding_shortfall: 1,
        notify_income_missing: 1,
        notify_pending_summary: 1,
        notify_goal_funded: 0,
        notify_fx_changed: 1,
        ntfy_priority_goal_impossible: "high",
        ntfy_priority_necessary_underfunded: "default",
        ntfy_priority_funding_shortfall: "default",
        ntfy_priority_income_missing: "high",
        ntfy_priority_pending_summary: "default",
        ntfy_priority_goal_funded: "default",
        ntfy_priority_fx_changed: "default",
        necessary_underfunded_repeat_days: 1,
        setup_completed: 1,
        setup_completed_at: now,
        updated_at: now
      }],
      fx_rates_cache: [{
        base_currency: "EUR",
        quote_currency: "PLN",
        currency: "EUR",
        rate_date: "2026-06-01",
        rate: 4.3,
        effective_date: "2026-06-01",
        source: "manual",
        raw_json: "{\"sample\":true}",
        updated_at: now
      }],
      ledger_currency_events: [],
      planned_transactions: [
        { id: "sample-plan-rent", type: "recurring_expense", operating_priority: 1, goal_priority: null, created_at: now, updated_at: now },
        { id: "sample-plan-groceries", type: "flex", operating_priority: 2, goal_priority: null, created_at: now, updated_at: now },
        { id: "sample-plan-emergency", type: "goal", operating_priority: null, goal_priority: 1, created_at: now, updated_at: now }
      ],
      recurring_expenses: [{
        id: "sample-expense-rent",
        name: "Sample rent",
        currency: "PLN",
        amount: 2200,
        prediction_strategy: "fixed",
        prediction_substitute_missing: "none",
        prediction_min_recorded_months: 6,
        necessary: 1,
        active: 1,
        repeat_every_months: 1,
        start_month_year: "2026-01",
        anchor_type: "day_of_month",
        anchor_day_of_month: 5,
        anchor_offset_days: 0,
        anchor_business_day_adjustment: "none",
        anchor_holiday_country: "PL",
        planned_transaction_id: "sample-plan-rent",
        created_at: now,
        updated_at: now
      }],
      recurring_incomes: [{
        id: "sample-income-salary",
        name: "Sample salary",
        currency: "PLN",
        amount: 7000,
        prediction_strategy: "fixed",
        prediction_substitute_missing: "none",
        prediction_min_recorded_months: 6,
        active: 1,
        repeat_every_months: 1,
        start_month_year: "2026-01",
        anchor_type: "day_of_month",
        anchor_day_of_month: 1,
        anchor_offset_days: 0,
        anchor_business_day_adjustment: "none",
        anchor_holiday_country: "PL",
        period_setting: 1,
        created_at: now,
        updated_at: now
      }],
      flex_transactions: [{
        id: "sample-flex-groceries",
        name: "Sample groceries",
        currency: "PLN",
        amount: 1200,
        active: 1,
        allow_split: 1,
        min_amount: 800,
        max_amount: 1200,
        planned_transaction_id: "sample-plan-groceries",
        created_at: now,
        updated_at: now
      }],
      goals: [{
        id: "sample-goal-emergency",
        name: "Sample emergency fund",
        currency: "PLN",
        amount: 5000,
        active: 1,
        due_date: "2026-12-31",
        planned_transaction_id: "sample-plan-emergency",
        created_at: now,
        updated_at: now
      }],
      one_off_transactions: [
        { id: "sample-oneoff-laptop", name: "Sample laptop", currency: "PLN", amount: 3500, type: "expense", date: "2026-07-15", created_at: now, updated_at: now },
        { id: "sample-oneoff-bonus", name: "Sample bonus", currency: "PLN", amount: 1200, type: "income", date: "2026-08-10", created_at: now, updated_at: now }
      ],
      pending_transactions: []
  };

  const ledgers = {
    "2026": [
        {
          id: "sample-ledger-salary-2026-01",
          name: "Sample salary",
          currency: "PLN",
          amount: 7000,
          type: "income",
          date: "2026-01-01",
          confirmed_date: "2026-01-01",
          fx_rate: 1,
          buffered_fx_rate: 1,
          ledger_currency: "PLN",
          running_balance_pln: 7000,
          ledger_amount: 7000,
          source_recurring_expense_id: null,
          source_recurring_income_id: "sample-income-salary",
          source_one_off_id: null,
          source_flex_id: null,
          source_goal_id: null,
          occurrence_key: "sample:salary:2026-01",
          created_at: now,
          updated_at: now
        },
        {
          id: "sample-ledger-rent-2026-01",
          name: "Sample rent",
          currency: "PLN",
          amount: 2200,
          type: "expense",
          date: "2026-01-05",
          confirmed_date: "2026-01-05",
          fx_rate: 1,
          buffered_fx_rate: 1,
          ledger_currency: "PLN",
          running_balance_pln: 4800,
          ledger_amount: 2200,
          source_recurring_expense_id: "sample-expense-rent",
          source_recurring_income_id: null,
          source_one_off_id: null,
          source_flex_id: null,
          source_goal_id: null,
          occurrence_key: "sample:rent:2026-01",
          created_at: now,
          updated_at: now
        },
        {
          id: "sample-ledger-groceries-2026-01",
          name: "Sample groceries",
          currency: "PLN",
          amount: 850,
          type: "expense",
          date: "2026-01-07",
          confirmed_date: "2026-01-07",
          fx_rate: 1,
          buffered_fx_rate: 1,
          ledger_currency: "PLN",
          running_balance_pln: 3950,
          ledger_amount: 850,
          source_recurring_expense_id: null,
          source_recurring_income_id: null,
          source_one_off_id: null,
          source_flex_id: "sample-flex-groceries",
          source_goal_id: null,
          occurrence_key: "sample:groceries:2026-01",
          created_at: now,
          updated_at: now
        }
      ]
  };

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now,
    sample: true,
    planning,
    ledgers,
    checksum: computeExportChecksum({ planning, ledgers })
  };
}


/** Financial JSON/CSV primitives. Origin-aware hosts must configure matching
 * stores and balance/projection callbacks; default runtime readers stay closed.
 * Retained audited history permits explicit replacement/copy, never merging. */
export function createCashflowDataPortabilityService({
  budgetStore = null,
  allowStandaloneOrigins = false,
  cleanupOperationalData = () => null,
  protectBackup = () => () => {},
  createBackup,
  createBackupAsync = null,
  generateId,
  logError = () => {},
  logServerEvent = () => {},
  mutationHook = null,
  listLedgerYears,
  loadAllConfirmedTransactions,
  lockService = null,
  openLedgerDb,
  openPlanningDb,
  normalizeLocale = value => String(value || "en").trim().toLowerCase(),
  recalculateLedgerRunningBalance,
  recalculateLedgerRunningBalanceAsync = null,
  regenerateProjectionsAfterMutation,
  regenerateProjectionsAfterMutationAsync = null,
  restoreBackupFromPath
}) {
  // The host must also supply origin-aware balance/projection callbacks before
  // enabling complete runtime imports. No file or request field sets policy.
  const { copyLedgerAuditSnapshot } = createNodeLedgerAuditReplay({ allowStandaloneOrigins });

async function withAsyncRollback({ userId, mode, safetySnapshot, operationName = "Import", onRollbackBatch }, fn) {
  try {
    return await fn();
  } catch (error) {
    logError(`cashflow_async_import_failed_before_rollback`, {
      userId,
      mode: mode || null,
      error: error.message,
      safetySnapshot: safeSnapshotSummary(safetySnapshot)
    });
    try {
      await restoreBudgetSafetySnapshotAsync(safetySnapshot, { onBatch: onRollbackBatch });
      logServerEvent(`cashflow_async_import_rolled_back`, {
        userId,
        mode: mode || null,
        error: error.message,
        safetySnapshot: safeSnapshotSummary(safetySnapshot)
      });
    } catch (rollbackError) {
      logError(`cashflow_async_import_rollback_failed`, {
        userId,
        mode: mode || null,
        error: error.message,
        rollbackError: rollbackError.message,
        safetySnapshot: safeSnapshotSummary(safetySnapshot)
      });
      const combined = new Error(`${operationName} failed and rollback also failed`);
      combined.status = 500;
      combined.details = {
        phase: "rollback_failed",
        safetySnapshot: safeSnapshotSummary(safetySnapshot),
        originalError: error.message,
        originalStatus: Number(error?.status) || 500,
        rollbackError: rollbackError.message
      };
      throw combined;
    }
    throw rolledBackSnapshotError(error, safetySnapshot, operationName);
  }
}

function withSyncRollback({ userId, mode, safetyBackup, hookName, operationName = "Import" }, fn) {
  try {
    return fn();
  } catch (error) {
    logError("cashflow_import_failed_before_rollback", {
      userId,
      mode,
      safetyBackup,
      error: error.message
    });
    try {
      runMutationHook(hookName, { userId, safetyBackup, error });
      restoreBackupFromPath(userId, safetyBackup);
      logServerEvent("cashflow_import_rolled_back", {
        userId,
        mode,
        safetyBackup,
        error: error.message
      });
    } catch (rollbackError) {
      logError("cashflow_import_rollback_failed", {
        userId,
        mode,
        safetyBackup,
        error: error.message,
        rollbackError: rollbackError.message
      });
      const combined = new Error(`${operationName} failed and rollback also failed`);
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
    throw rolledBackError(error, safetyBackup, operationName);
  }
}


  function usesPostgresBudgetStoreForFullImport() {
    return budgetStore?.backend === "postgres"
      && typeof budgetStore.transaction === "function"
      && typeof recalculateLedgerRunningBalanceAsync === "function"
      && typeof regenerateProjectionsAfterMutationAsync === "function";
  }

  // CSV one-off import never touches confirmed ledger balances, so unlike
  // the full-import gate above it does not need recalculateLedgerRunningBalanceAsync.
  function usesPostgresBudgetStoreForCsvImport() {
    return budgetStore?.backend === "postgres"
      && typeof budgetStore.transaction === "function"
      && typeof regenerateProjectionsAfterMutationAsync === "function";
  }
  function runMutationHook(phase, details = {}) {
    if (typeof mutationHook === "function") mutationHook({ phase, ...details });
  }

  /** Synchronous SQLite compatibility path also exports any retained audit;
   * requesting an export never captures or invents historical source evidence. */
  function exportFullData(userId, appVersion = "0.0.0", options = {}) {
    const includeOperationalSettings = Boolean(options.includeOperationalSettings);
    const db = openPlanningDb(userId);
    const planning = {};
    let ledgerAudit = null;

    try {
      ledgerAudit = readSqliteFinancialExportAudit(db, userId, { allowStandaloneOrigins });
      for (const tableName of PLANNING_EXPORT_TABLES) {
        planning[tableName] = selectRows(db, tableName);
      }
      if (!includeOperationalSettings) {
        planning.settings = planning.settings.map(stripOperationalSettings);
      }
    } finally {
      db.close();
    }

    const ledgers = {};
    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        ledgers[year] = selectRows(ledgerDb, "confirmed_transactions");
      } finally {
        ledgerDb.close();
      }
    }

    return buildExportEnvelope({ appVersion, includeOperationalSettings, ledgers, planning, userId, ledgerAudit, allowStandaloneOrigins });
  }

  function stripBudgetStoreColumns(row, columns = ["budget_id"]) {
    const result = { ...(row || {}) };
    for (const column of columns) {
      delete result[column];
    }
    return result;
  }

  /** Runtime exporters retain full immutable/correction evidence, including
   * voids, and fail closed if concurrent reads disagree with the audit. */
  async function exportFullDataAsync(userId, appVersion = "0.0.0", options = {}) {
    if (!budgetStore || typeof budgetStore.listPlanningRows !== "function") {
      return exportFullData(userId, appVersion, options);
    }

    const includeOperationalSettings = Boolean(options.includeOperationalSettings);
    const planning = {};
    for (const tableName of PLANNING_EXPORT_TABLES) {
      planning[tableName] = (await budgetStore.listPlanningRows(userId, tableName))
        .map(row => stripBudgetStoreColumns(row));
    }
    if (!includeOperationalSettings) {
      planning.settings = planning.settings.map(stripOperationalSettings);
    }

    const ledgers = {};
    const years = typeof budgetStore.listLedgerYears === "function"
      ? await budgetStore.listLedgerYears(userId)
      : listLedgerYears(userId);
    for (const year of years) {
      const yearKey = String(year);
      const rows = typeof budgetStore.listConfirmedTransactions === "function"
        ? await budgetStore.listConfirmedTransactions(userId, { ledgerYear: Number(year) })
        : [];
      ledgers[yearKey] = rows.map(row => stripBudgetStoreColumns(row, ["budget_id", "ledger_year"]));
    }

    const ledgerAudit = typeof budgetStore.exportLedgerAuditSnapshot === 'function'
      ? await budgetStore.exportLedgerAuditSnapshot(userId) : null;
    return buildExportEnvelope({ appVersion, includeOperationalSettings, ledgers, planning, userId, ledgerAudit, allowStandaloneOrigins });
  }

  function replacePlanningData(userId, exportData, expectedNotificationState) {
    const db = openPlanningDb(userId);

    try {
      db.transaction(() => {
        assertImportNotificationState(db.prepare("SELECT * FROM settings WHERE id = 1").get(), expectedNotificationState);
        rotateSqliteFinancialEpoch(db, userId);
        db.pragma("foreign_keys = OFF");

        for (const tableName of PLANNING_DELETE_ORDER) {
          db.prepare(`DELETE FROM ${tableName}`).run();
        }

        for (const tableName of PLANNING_INSERT_ORDER) {
          insertRows(db, tableName, exportData.planning[tableName]);
        }

        db.pragma("foreign_keys = ON");

        const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
        if (fkErrors.length) {
          throw badRequest(`Import failed foreign key check: ${JSON.stringify(fkErrors)}`);
        }
      })();
    } finally {
      db.close();
    }
  }

  function replaceLedgerData(userId, exportData) {
    const existingYears = listLedgerYears(userId);
    const importYears = Object.keys(exportData.ledgers);
    const allYears = [...new Set([...existingYears, ...importYears])];

    for (const year of allYears) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        ledgerDb.transaction(() => {
          ledgerDb.prepare("DELETE FROM confirmed_transactions").run();
          insertRows(ledgerDb, "confirmed_transactions", exportData.ledgers[year] || []);
        })();
      } finally {
        ledgerDb.close();
      }
    }
  }

  function idConflicts(db, tableName, rows, labelPrefix = tableName) {
    const conflicts = [];
    const seen = new Set();

    for (const row of rows || []) {
      const id = row?.id;
      if (!id) continue;

      const key = `${labelPrefix}:${id}`;
      if (seen.has(key)) {
        conflicts.push({ table: labelPrefix, id, reason: "duplicate_in_import" });
        continue;
      }
      seen.add(key);

      const existing = db.prepare(`SELECT 1 AS exists_flag FROM ${tableName} WHERE id = ? LIMIT 1`).get(id);
      if (existing) {
        conflicts.push({ table: labelPrefix, id, reason: "already_exists" });
      }
    }

    return conflicts;
  }

  function fxCacheConflicts(db, rows) {
    const conflicts = [];
    const seen = new Set();

    for (const row of rows || []) {
      const base = row?.base_currency;
      const quote = row?.quote_currency || "PLN";
      const date = row?.rate_date;
      if (!base || !quote || !date) continue;

      const id = `${base}/${quote}/${date}`;
      if (seen.has(id)) {
        conflicts.push({ table: "fx_rates_cache", id, reason: "duplicate_in_import" });
        continue;
      }
      seen.add(id);

      const existing = db.prepare(`
        SELECT 1 AS exists_flag
        FROM fx_rates_cache
        WHERE base_currency = ? AND quote_currency = ? AND rate_date = ?
        LIMIT 1
      `).get(base, quote, date);

      if (existing) {
        conflicts.push({ table: "fx_rates_cache", id, reason: "already_exists" });
      }
    }

    return conflicts;
  }

  function idConflictsFromRows(existingRows, tableName, rows, labelPrefix = tableName) {
    const conflicts = [];
    const seen = new Set();
    const existingIds = new Set((existingRows || []).map(row => row.id).filter(Boolean));

    for (const row of rows || []) {
      const id = row?.id;
      if (!id) continue;

      const key = `${labelPrefix}:${id}`;
      if (seen.has(key)) {
        conflicts.push({ table: labelPrefix, id, reason: "duplicate_in_import" });
        continue;
      }
      seen.add(key);

      if (existingIds.has(id)) {
        conflicts.push({ table: labelPrefix, id, reason: "already_exists" });
      }
    }

    return conflicts;
  }

  function fxCacheConflictsFromRows(existingRows, rows) {
    const conflicts = [];
    const seen = new Set();
    const existingKeys = new Set((existingRows || [])
      .map(row => {
        const base = row?.base_currency;
        const quote = row?.quote_currency || "PLN";
        const date = row?.rate_date;
        return base && quote && date ? `${base}/${quote}/${date}` : null;
      })
      .filter(Boolean));

    for (const row of rows || []) {
      const base = row?.base_currency;
      const quote = row?.quote_currency || "PLN";
      const date = row?.rate_date;
      if (!base || !quote || !date) continue;

      const id = `${base}/${quote}/${date}`;
      if (seen.has(id)) {
        conflicts.push({ table: "fx_rates_cache", id, reason: "duplicate_in_import" });
        continue;
      }
      seen.add(id);

      if (existingKeys.has(id)) {
        conflicts.push({ table: "fx_rates_cache", id, reason: "already_exists" });
      }
    }

    return conflicts;
  }

  function collectMergeConflicts(userId, exportData) {
    const conflicts = [];
    const existingConfirmedRows = loadAllConfirmedTransactions(userId);
    const existingConfirmedIds = new Set(existingConfirmedRows.map(row => row.id));
    let existingPendingIds = new Set();
    const db = openPlanningDb(userId);

    try {
      conflicts.push(...fxCacheConflicts(db, exportData.planning.fx_rates_cache));
      for (const tableName of ID_TABLES) {
        conflicts.push(...idConflicts(db, tableName, exportData.planning[tableName]));
      }
      existingPendingIds = new Set(
        db.prepare("SELECT id FROM pending_transactions").all().map(row => row.id)
      );

      const importedKeys = importedOccurrenceKeys(exportData);
      if (importedKeys.size) {
        const existingPendingKeys = db.prepare(`
          SELECT occurrence_key
          FROM pending_transactions
          WHERE occurrence_key IS NOT NULL
        `).all();
        for (const row of existingPendingKeys) {
          if (importedKeys.has(row.occurrence_key)) {
            conflicts.push({
              table: "occurrence_keys",
              id: row.occurrence_key,
              reason: "already_exists"
            });
          }
        }
      }
    } finally {
      db.close();
    }

    const importedKeys = importedOccurrenceKeys(exportData);
    if (importedKeys.size) {
      for (const row of existingConfirmedRows) {
        if (row.occurrence_key && importedKeys.has(row.occurrence_key)) {
          conflicts.push({
            table: "occurrence_keys",
            id: row.occurrence_key,
            reason: "already_exists"
          });
        }
      }
    }

    for (const [year, rows] of Object.entries(exportData.ledgers)) {
      for (const row of rows) {
        if (existingConfirmedIds.has(row.id) || existingPendingIds.has(row.id)) {
          conflicts.push({
            table: `ledger_${year}.confirmed_transactions`,
            id: row.id,
            reason: "already_exists"
          });
        }
      }
    }

    for (const row of exportData.planning.pending_transactions) {
      if (existingConfirmedIds.has(row.id)) {
        conflicts.push({
          table: "pending_transactions",
          id: row.id,
          reason: "already_exists"
        });
      }
    }

    return conflicts;
  }

  async function collectMergeConflictsAsync(userId, exportData) {
    if (!budgetStore || typeof budgetStore.listPlanningRows !== "function") {
      return collectMergeConflicts(userId, exportData);
    }

    const conflicts = [];
    const existingConfirmedRows = typeof budgetStore.listConfirmedTransactions === "function"
      ? await budgetStore.listConfirmedTransactions(userId)
      : loadAllConfirmedTransactions(userId);
    const existingConfirmedIds = new Set(existingConfirmedRows.map(row => row.id));
    let existingPendingIds = new Set();

    conflicts.push(
      ...fxCacheConflictsFromRows(
        await budgetStore.listPlanningRows(userId, "fx_rates_cache"),
        exportData.planning.fx_rates_cache
      )
    );

    for (const tableName of ID_TABLES) {
      const existingRows = await budgetStore.listPlanningRows(userId, tableName);
      conflicts.push(...idConflictsFromRows(existingRows, tableName, exportData.planning[tableName]));
      if (tableName === "pending_transactions") {
        existingPendingIds = new Set(existingRows.map(row => row.id).filter(Boolean));
      }
    }

    const importedKeys = importedOccurrenceKeys(exportData);
    if (importedKeys.size) {
      const existingPendingRows = await budgetStore.listPlanningRows(userId, "pending_transactions");
      for (const row of existingPendingRows) {
        if (row.occurrence_key && importedKeys.has(row.occurrence_key)) {
          conflicts.push({
            table: "occurrence_keys",
            id: row.occurrence_key,
            reason: "already_exists"
          });
        }
      }
      for (const row of existingConfirmedRows) {
        if (row.occurrence_key && importedKeys.has(row.occurrence_key)) {
          conflicts.push({
            table: "occurrence_keys",
            id: row.occurrence_key,
            reason: "already_exists"
          });
        }
      }
    }

    for (const [year, rows] of Object.entries(exportData.ledgers)) {
      for (const row of rows) {
        if (existingConfirmedIds.has(row.id) || existingPendingIds.has(row.id)) {
          conflicts.push({
            table: `ledger_${year}.confirmed_transactions`,
            id: row.id,
            reason: "already_exists"
          });
        }
      }
    }

    for (const row of exportData.planning.pending_transactions) {
      if (existingConfirmedIds.has(row.id)) {
        conflicts.push({
          table: "pending_transactions",
          id: row.id,
          reason: "already_exists"
        });
      }
    }

    return conflicts;
  }

  async function previewFullImportAsync(userId, payload, mode = "replace", options = {}) {
    if (!budgetStore || typeof budgetStore.listPlanningRows !== "function") {
      return previewFullImport(userId, payload, mode, options);
    }

    const normalizedMode = mode === "merge" ? "merge" : "replace";
    if (normalizedMode === 'merge' && typeof budgetStore.exportLedgerAuditSnapshot === 'function'
      && await budgetStore.exportLedgerAuditSnapshot(userId) !== null) {
      throw badRequest('A budget with correction history cannot receive merged financial data');
    }
    const currentRowsByTable = {};
    const currentRowCounts = {};
    const liveColumnsByTable = {};

    for (const tableName of PLANNING_EXPORT_TABLES) {
      const rows = await budgetStore.listPlanningRows(userId, tableName);
      currentRowsByTable[tableName] = rows;
      currentRowCounts[tableName] = rows.length;
      liveColumnsByTable[tableName] = (POSTGRES_BUDGET_COLUMNS[tableName] || [])
        .filter(column => column !== "budget_id");
    }
    const currentSettings = stripBudgetStoreColumns(currentRowsByTable.settings[0] || {});

    const exportData = prepareExportDataForImport(
      normalizeExportPayload(payload, { allowStandaloneOrigins }),
      {
        currentSettings,
        includeOperationalSettings: normalizedMode === "replace" && Boolean(options.includeOperationalSettings),
        merge: normalizedMode === "merge",
        normalizeLocale,
        validateSettings: normalizedMode === "replace"
      }
    );

    const conflicts = normalizedMode === "merge" ? await collectMergeConflictsAsync(userId, exportData) : [];
    const ledgerYears = typeof budgetStore.listLedgerYears === "function"
      ? await budgetStore.listLedgerYears(userId)
      : listLedgerYears(userId);

    return buildFullImportPreview({
      conflicts,
      currentRowCounts,
      currentSettings,
      exportData,
      ledgerYears,
      liveColumnsByTable,
      mode: normalizedMode
    });
  }

  async function prepareFullImportPlanAsync(userId, payload, mode = "replace", options = {}) {
    const normalizedMode = mode === "merge" ? "merge" : "replace";
    const includeOperationalSettings = normalizedMode === "replace"
      && Boolean(options.includeOperationalSettings);
    let currentSettings;

    if (budgetStore && typeof budgetStore.listPlanningRows === "function") {
      const rows = await budgetStore.listPlanningRows(userId, "settings");
      currentSettings = stripBudgetStoreColumns(rows[0] || {});
    } else {
      const currentDb = openPlanningDb(userId);
      try {
        currentSettings = currentDb.prepare("SELECT * FROM settings WHERE id = 1").get() || {};
      } finally {
        currentDb.close();
      }
    }

    const exportData = prepareExportDataForImport(
      normalizeExportPayload(payload, { allowStandaloneOrigins }),
      {
        currentSettings,
        includeOperationalSettings,
        merge: normalizedMode === "merge",
        normalizeLocale,
        validateSettings: normalizedMode === "replace"
      }
    );

    // Audit semantics take precedence over ordinary row conflicts: even a
    // disjoint merge can change the context of retained correction decisions.
    const currentAudit = typeof budgetStore?.exportLedgerAuditSnapshot === 'function'
      ? await budgetStore.exportLedgerAuditSnapshot(userId) : null;
    if (normalizedMode === 'merge' && currentAudit !== null) {
      throw badRequest('A budget with correction history cannot receive merged financial data');
    }
    if (normalizedMode === "merge") {
      const conflicts = await collectMergeConflictsAsync(userId, exportData);
      if (conflicts.length) {
        const error = new Error("Import has conflicts");
        error.status = 409;
        error.conflicts = conflicts;
        throw error;
      }
    }

    const importPlan = createBudgetStoreImportPlanFromFullExport({
      budgetId: userId,
      exportData,
      includeEmptyReplaceBatches: normalizedMode === "replace",
      includeSettings: normalizedMode !== "merge"
    });

    if (exportData.ledgerAudit || currentAudit !== null) {
      importPlan.auditedSnapshot = normalizeBudgetStoreSnapshot({ format: 'cashflow-budget-store-snapshot', version: 2,
        payload: createBudgetStorePayloadFromFullExport({ budgetId: userId, exportData }),
        ledgerAudits: exportData.ledgerAudit ? [copyLedgerAuditSnapshot(exportData.ledgerAudit, userId)] : [] }, { allowStandaloneOrigins });
    }
    return {
      ok: true,
      exportData,
      importPlan,
      notificationPrecondition: normalizedMode === "replace"
        ? { budgetId: userId, fingerprint: notificationAssociationFingerprint(currentSettings) } : null,
      mode: normalizedMode
    };
  }

  async function applyPreparedFullImportPlanAsync(preflight, options = {}) {
    if (!budgetStore || typeof budgetStore !== "object") {
      throw new Error("A budget store is required to apply prepared import plans");
    }
    if (!preflight?.importPlan) {
      throw new Error("A prepared full import plan is required");
    }

    const beforeApply = async writer => {
      const expected = preflight.notificationPrecondition;
      if (!expected) return;
      const rows = await writer.listPlanningRows(expected.budgetId, "settings");
      assertImportNotificationState(rows[0] || {}, expected.fingerprint);
    };
    if (preflight.importPlan.auditedSnapshot) {
      return restoreBudgetStoreSnapshot({ budgetStore, snapshot: preflight.importPlan.auditedSnapshot,
        preserveBackupMetadata: true, beforeApply, onBatch: options.onBatch, allowStandaloneOrigins });
    }
    const mode = preflight.mode === "merge" ? "append" : "replace";
    return await applyBudgetStoreImportPlan({
      budgetStore,
      mode,
      onBatch: options.onBatch,
      // Recovery discovery must survive replacement on both storage backends.
      preserveBackupMetadata: true,
      beforeApply,
      plan: preflight.importPlan
    });
  }

  async function applyPreparedFullImportPlanWithRollbackAsync(userId, preflight, options = {}) {
    const safetySnapshot = await createBudgetSafetySnapshotAsync(
      userId,
      options.reason || `full_import_${preflight?.mode || "unknown"}`
    );

        return await withAsyncRollback({
      userId,
      mode: preflight.mode,
      safetySnapshot,
      operationName: "Import",
      onRollbackBatch: options.onRollbackBatch
    }, async () => {
      const applyResult = await applyPreparedFullImportPlanAsync(preflight, {
        onBatch: options.onBatch
      });
      return {
        apply: applyResult,
        mode: preflight.mode,
        ok: true,
        safetySnapshot: safeSnapshotSummary(safetySnapshot)
      };
    });
  }

  /**
   * PostgreSQL and audited SQLite full import: composes prepare/apply/
   * rollback primitives with running-balance recalculation and projection
   * regeneration so the async path reaches the same end state as the sync
   * `importFullData` (data written, balances correct, projections rebuilt),
   * treating a post-apply projection failure as a reason to roll back the
   * whole import, exactly like the sync version does. The safety backup
   * enforces backup retention while joining this import's portability lock.
   */
  async function importFullDataAsync(userId, payload, mode = "replace", options = {}) {
    const incoming = payload?.export || payload;
    const currentAudit = typeof budgetStore?.exportLedgerAuditSnapshot === 'function'
      ? await budgetStore.exportLedgerAuditSnapshot(userId) : null;
    const audited = Number(incoming?.version) === 2 || currentAudit !== null;
    if (!usesPostgresBudgetStoreForFullImport() && !audited) {
      return importFullData(userId, payload, mode, options);
    }
    if (audited && (!budgetStore || typeof recalculateLedgerRunningBalanceAsync !== 'function'
      || typeof regenerateProjectionsAfterMutationAsync !== 'function')) {
      throw badRequest('Audited import requires the complete asynchronous financial runtime');
    }

    const runImport = async () => {
      const preflight = await prepareFullImportPlanAsync(userId, payload, mode, options);
      // Runtime imports keep a discoverable durable backup as well as the
      // transaction rollback snapshot. A successful import must not discard the
      // user's only recovery copy of the replaced budget.
      const persistentSafetyBackup = typeof createBackupAsync === 'function'
        ? await createBackupAsync(userId, { deferCleanup: true, dataPortabilityLockHeld: true })
        : budgetStore.backend === 'sqlite' && typeof createBackup === 'function'
          ? createBackup(userId, { deferCleanup: true }) : null;
      const releaseSafety = protectBackup(persistentSafetyBackup);
      try {
        const safetySnapshot = await createBudgetSafetySnapshotAsync(userId, `full_import_${preflight.mode}`);

        return await withAsyncRollback({
          userId,
          mode: preflight.mode,
          safetySnapshot,
          operationName: "Import",
          onRollbackBatch: options.onRollbackBatch
        }, async () => {
          const applyResult = await applyPreparedFullImportPlanAsync(preflight, { onBatch: options.onBatch });
          await recalculateLedgerRunningBalanceAsync(userId);
          const projection = await regenerateProjectionsAfterMutationAsync(userId);
          if (projection?.projection_ok === false) {
            throw new Error(`Projection regeneration failed after import: ${projection.projection_error || "unknown error"}`);
          }

          return {
            ok: true,
            mode: preflight.mode,
            safetyBackup: persistentSafetyBackup ?? safeSnapshotSummary(safetySnapshot),
            safetySnapshot: safeSnapshotSummary(safetySnapshot),
            ...(preflight.mode === "merge"
              ? { importedPlanningTables: PLANNING_INSERT_ORDER.filter(name => name !== "settings") }
              : {}),
            importedLedgerYears: Object.keys(preflight.exportData.ledgers),
            _projection: projection,
            apply: applyResult
          };
        });
      } finally { releaseSafety(); }
    };

    if (lockService && typeof lockService.withLock === "function") {
      const lockResult = await lockService.withLock(
        budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.dataPortability),
        runImport,
        { ttlMs: 300000 }
      );
      if (!lockResult?.acquired) {
        throw dataPortabilityLockConflict(userId);
      }
      return lockResult.result;
    }
    return await runImport();
  }

  function mergePlanningData(userId, exportData) {
    const db = openPlanningDb(userId);

    try {
      db.transaction(() => {
        rotateSqliteFinancialEpoch(db, userId);
        db.pragma("foreign_keys = OFF");

        for (const tableName of PLANNING_INSERT_ORDER.filter(name => name !== "settings")) {
          insertRows(db, tableName, exportData.planning[tableName]);
        }

        db.pragma("foreign_keys = ON");

        const fkErrors = db.prepare("PRAGMA foreign_key_check").all();
        if (fkErrors.length) {
          throw badRequest(`Import failed foreign key check: ${JSON.stringify(fkErrors)}`);
        }
      })();
    } finally {
      db.close();
    }
  }

  function mergeLedgerData(userId, exportData) {
    for (const [year, rows] of Object.entries(exportData.ledgers)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        ledgerDb.transaction(() => {
          insertRows(ledgerDb, "confirmed_transactions", rows);
        })();
      } finally {
        ledgerDb.close();
      }
    }
  }

  /** Synchronous legacy previews enforce the same audited-merge refusal as
   * runtime previews; a preview must never advertise an unsafe merge as valid. */
  function previewFullImport(userId, payload, mode = "replace", options = {}) {
    const normalizedMode = mode === "merge" ? "merge" : "replace";
    const db = openPlanningDb(userId);
    let currentSettings;
    const currentRowCounts = {};
    const liveColumnsByTable = {};

    try {
      if (normalizedMode === 'merge' && readSqliteFinancialExportAudit(db, userId, { allowStandaloneOrigins }) !== null) {
        throw badRequest('A budget with correction history cannot receive merged financial data');
      }
      currentSettings = db.prepare("SELECT * FROM settings WHERE id = 1").get() || {};
      for (const tableName of PLANNING_EXPORT_TABLES) {
        currentRowCounts[tableName] = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
        liveColumnsByTable[tableName] = tableColumns(db, tableName);
      }
    } finally {
      db.close();
    }

    const exportData = prepareExportDataForImport(
      normalizeExportPayload(payload, { allowStandaloneOrigins }),
      {
        currentSettings,
        includeOperationalSettings: normalizedMode === "replace" && Boolean(options.includeOperationalSettings),
        merge: normalizedMode === "merge",
        normalizeLocale,
        validateSettings: normalizedMode === "replace"
      }
    );

    const conflicts = normalizedMode === "merge" ? collectMergeConflicts(userId, exportData) : [];

    return buildFullImportPreview({
      conflicts,
      currentRowCounts,
      currentSettings,
      exportData,
      ledgerYears: listLedgerYears(userId),
      liveColumnsByTable,
      mode: normalizedMode
    });
  }

  /** Legacy SQLite-only writer cannot replay audit records. Fail closed and
   * direct audited callers to the complete asynchronous transactional runtime. */
  function importFullData(userId, payload, mode = "replace", options = {}) {
    const incoming = payload?.export || payload;
    const auditDb = openPlanningDb(userId);
    let currentAudit;
    try { currentAudit = readSqliteFinancialExportAudit(auditDb, userId, { allowStandaloneOrigins }); } finally { auditDb.close(); }
    if (Number(incoming?.version) === 2 || currentAudit !== null) {
      throw badRequest('Use the asynchronous runtime to import retained correction history');
    }

    const normalizedMode = mode === "merge" ? "merge" : "replace";
    const includeOperationalSettings = normalizedMode === "replace"
      && Boolean(options.includeOperationalSettings);
    const currentDb = openPlanningDb(userId);
    let currentSettings;
    try {
      currentSettings = currentDb.prepare("SELECT * FROM settings WHERE id = 1").get() || {};
    } finally {
      currentDb.close();
    }
    const exportData = prepareExportDataForImport(
      normalizeExportPayload(payload, { allowStandaloneOrigins }),
      {
        currentSettings,
        includeOperationalSettings,
        merge: normalizedMode === "merge",
        normalizeLocale,
        validateSettings: normalizedMode === "replace"
      }
    );

    if (normalizedMode === "merge") {
      const conflicts = collectMergeConflicts(userId, exportData);
      if (conflicts.length) {
        const error = new Error("Import has conflicts");
        error.status = 409;
        error.conflicts = conflicts;
        throw error;
      }

      const safetyBackup = createBackup(userId, { deferCleanup: true });

      try {
        return withSyncRollback({
          userId,
          mode: normalizedMode,
          safetyBackup,
          hookName: "before_merge_rollback",
          operationName: "Import"
        }, () => {
          mergeLedgerData(userId, exportData);
          mergePlanningData(userId, exportData);
          runMutationHook("after_merge_planning", { userId, safetyBackup });
          recalculateLedgerRunningBalance(userId);
          const projection = regenerateProjectionsAfterMutation(userId);
          if (projection?.projection_ok === false) {
            throw new Error(`Projection regeneration failed after import: ${projection.projection_error || "unknown error"}`);
          }
          cleanupOperationalData(userId, "merge_import_completed");

          return {
            ok: true,
            mode: normalizedMode,
            safetyBackup,
            importedPlanningTables: PLANNING_INSERT_ORDER.filter(name => name !== "settings"),
            importedLedgerYears: Object.keys(exportData.ledgers),
            _projection: projection
          };
        });
      } catch (error) {
        cleanupOperationalData(userId, "merge_import_rolled_back");
        throw error;
      }
    }

    const safetyBackup = createBackup(userId, { deferCleanup: true });

    try {
      return withSyncRollback({
        userId,
        mode: normalizedMode,
        safetyBackup,
        hookName: "before_replace_rollback",
        operationName: "Import"
      }, () => {
        replaceLedgerData(userId, exportData);
        replacePlanningData(userId, exportData, notificationAssociationFingerprint(currentSettings));
        runMutationHook("after_replace_planning", { userId, safetyBackup });
        recalculateLedgerRunningBalance(userId);
        const projection = regenerateProjectionsAfterMutation(userId);
        if (projection?.projection_ok === false) {
          throw new Error(`Projection regeneration failed after import: ${projection.projection_error || "unknown error"}`);
        }
        cleanupOperationalData(userId, "replace_import_completed");

        return {
          ok: true,
          mode: normalizedMode,
          safetyBackup,
          importedLedgerYears: Object.keys(exportData.ledgers),
          _projection: projection
        };
      });
    } catch (error) {
      cleanupOperationalData(userId, "replace_import_rolled_back");
      throw error;
    }
  }

  function confirmedOneOffSourceIds(userId) {
    return new Set(
      loadAllConfirmedTransactions(userId)
        .map(row => row.source_one_off_id)
        .filter(Boolean)
    );
  }

  async function confirmedOneOffSourceIdsAsync(userId) {
    if (budgetStore && typeof budgetStore.listConfirmedTransactions === "function") {
      return new Set(
        (await budgetStore.listConfirmedTransactions(userId))
          .map(row => row.source_one_off_id)
          .filter(Boolean)
      );
    }
    return confirmedOneOffSourceIds(userId);
  }

  async function prepareOneOffCsvImportPlanAsync(userId, csv, mode = "append") {
    const normalizedMode = mode === "replace" ? "replace" : "append";
    const parsedRows = parseCsv(csv);
    const rows = parsedRows.map(row => normalizeCsvOneOff(row, generateId));
    const deleteOneOffIds = [];

    if (normalizedMode === "replace") {
      const confirmedIds = await confirmedOneOffSourceIdsAsync(userId);
      let existingRows;
      if (budgetStore && typeof budgetStore.listPlanningRows === "function") {
        existingRows = await budgetStore.listPlanningRows(userId, "one_off_transactions");
      } else {
        const db = openPlanningDb(userId);
        try {
          existingRows = db.prepare("SELECT id FROM one_off_transactions").all();
        } finally {
          db.close();
        }
      }

      deleteOneOffIds.push(...existingRows
        .map(row => row.id)
        .filter(id => !confirmedIds.has(id)));
    }

    return {
      ok: true,
      deleteFutureSourceOneOffIds: [...deleteOneOffIds],
      deleteOneOffIds,
      deletePendingSourceOneOffIds: [...deleteOneOffIds],
      imported: rows.length,
      mode: normalizedMode,
      rows
    };
  }

  async function applyPreparedOneOffCsvImportPlanAsync(userId, plan) {
    if (!budgetStore || typeof budgetStore !== "object") {
      throw new Error("A budget store is required to apply prepared CSV import plans");
    }
    if (!plan || !Array.isArray(plan.rows)) {
      throw new Error("A prepared CSV import plan is required");
    }

    const applyWithWriter = async writer => {
      if (typeof writer.insertPlanningRows !== "function") {
        throw new Error("Budget-store writer must implement insertPlanningRows");
      }
      if (typeof writer.lockBudgetLedger === "function") await writer.lockBudgetLedger(userId);
      if (typeof writer.rotateSyncEpoch === "function") await writer.rotateSyncEpoch(userId);

      let deletedOneOffs = 0;
      let deletedPendingRows = 0;
      let deletedFutureRows = 0;

      if (plan.mode === "replace") {
        if (
          typeof writer.listPlanningRows !== "function"
          || typeof writer.deletePlanningRowsById !== "function"
        ) {
          throw new Error("Budget-store writer must implement listPlanningRows and deletePlanningRowsById for CSV replace mode");
        }

        const oneOffIds = new Set(plan.deleteOneOffIds || []);
        const idsForSource = rows => rows
          .filter(row => oneOffIds.has(row.source_one_off_id))
          .map(row => row.id)
          .filter(Boolean);
        const pendingIds = idsForSource(await writer.listPlanningRows(userId, "pending_transactions"));
        const futureIds = idsForSource(await writer.listPlanningRows(userId, "future_transactions"));

        if (pendingIds.length) {
          deletedPendingRows = Number((await writer.deletePlanningRowsById(userId, "pending_transactions", pendingIds))?.deleted || 0);
        }
        if (futureIds.length) {
          deletedFutureRows = Number((await writer.deletePlanningRowsById(userId, "future_transactions", futureIds))?.deleted || 0);
        }
        if (oneOffIds.size) {
          deletedOneOffs = Number((await writer.deletePlanningRowsById(
            userId,
            "one_off_transactions",
            [...oneOffIds]
          ))?.deleted || 0);
        }
      }

      // SQLite's explicit-column store needs timestamps as well as PostgreSQL.
      const timestamp = new Date().toISOString();
      const inserted = plan.rows.length
        ? Number((await writer.insertPlanningRows(userId, "one_off_transactions", plan.rows.map(row => ({
          ...row, created_at: timestamp, updated_at: timestamp
        }))))?.inserted || 0)
        : 0;

      return {
        deletedFutureRows,
        deletedOneOffs,
        deletedPendingRows,
        inserted
      };
    };

    const summary = typeof budgetStore.transaction === "function"
      ? await budgetStore.transaction(applyWithWriter)
      : await applyWithWriter(budgetStore);

    return {
      ...summary,
      mode: plan.mode === "replace" ? "replace" : "append",
      ok: true
    };
  }

  async function createBudgetSafetySnapshotAsync(userId, reason = "data_portability") {
    if (!budgetStore || typeof budgetStore.listPlanningRows !== "function") {
      throw new Error("A budget store is required to create async safety snapshots");
    }
    return await createBudgetStoreSnapshot({
      budgetIds: [userId],
      budgetStore,
      reason,
      allowStandaloneOrigins
    });
  }

  async function restoreBudgetSafetySnapshotAsync(snapshot, options = {}) {
    if (!budgetStore || typeof budgetStore !== "object") {
      throw new Error("A budget store is required to restore async safety snapshots");
    }
    return await restoreBudgetStoreSnapshot({
      budgetStore,
      onBatch: options.onBatch,
      preserveBackupMetadata: true,
      snapshot,
      allowStandaloneOrigins
    });
  }

  function importOneOffCsv(userId, csv, mode = "append") {
    const normalizedMode = mode === "replace" ? "replace" : "append";
    const parsedRows = parseCsv(csv);
    const rows = parsedRows.map(row => normalizeCsvOneOff(row, generateId));
    const db = openPlanningDb(userId);

    try {
      db.transaction(() => {
        rotateSqliteFinancialEpoch(db, userId);
        if (normalizedMode === "replace") {
          const confirmedIds = confirmedOneOffSourceIds(userId);
          const existing = db.prepare("SELECT id FROM one_off_transactions").all();
          const deletable = existing
            .map(row => row.id)
            .filter(id => !confirmedIds.has(id));

          for (const id of deletable) {
            db.prepare("DELETE FROM pending_transactions WHERE source_one_off_id = ?").run(id);
            db.prepare("DELETE FROM future_transactions WHERE source_one_off_id = ?").run(id);
            db.prepare("DELETE FROM one_off_transactions WHERE id = ?").run(id);
          }
        }

        const insert = db.prepare(`
          INSERT INTO one_off_transactions (
            id, name, currency, amount, type, date, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `);

        for (const row of rows) {
          insert.run(row.id, row.name, row.currency, row.amount, row.type, row.date);
        }
      })();
    } finally {
      db.close();
    }

    const projection = regenerateProjectionsAfterMutation(userId);

    return {
      ok: true,
      mode: normalizedMode,
      imported: rows.length,
      _projection: projection
    };
  }

  // Matches importOneOffCsv's contract exactly: no safety backup here either
  // (the sync version doesn't create one for CSV import), just prepare, apply,
  // and regenerate projections.
  async function importOneOffCsvAsync(userId, csv, mode = "append") {
    if (!usesPostgresBudgetStoreForCsvImport()) {
      return importOneOffCsv(userId, csv, mode);
    }

    const plan = await prepareOneOffCsvImportPlanAsync(userId, csv, mode);
    const applyResult = await applyPreparedOneOffCsvImportPlanAsync(userId, plan);
    const projection = await regenerateProjectionsAfterMutationAsync(userId);

    return {
      ok: true,
      mode: plan.mode,
      imported: plan.imported,
      _projection: projection,
      apply: applyResult
    };
  }

  function exportConfirmedLedgerCsv(userId) {
    return confirmedLedgerRowsToCsv(loadAllConfirmedTransactions(userId));
  }

  async function exportConfirmedLedgerCsvAsync(userId) {
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return exportConfirmedLedgerCsv(userId);
    }

    const years = typeof budgetStore.listLedgerYears === "function"
      ? await budgetStore.listLedgerYears(userId)
      : listLedgerYears(userId);
    const rows = [];
    for (const year of years) {
      rows.push(...(await budgetStore.listConfirmedTransactions(userId, { ledgerYear: Number(year) })));
    }

    return confirmedLedgerRowsToCsv(rows);
  }

  function exportSampleData() {
    return sampleExport();
  }

  function importSampleData(userId) {
    return importFullData(userId, sampleExport(), "replace");
  }

  async function importSampleDataAsync(userId) {
    return importFullDataAsync(userId, sampleExport(), "replace");
  }

  return {
    exportConfirmedLedgerCsv,
    exportConfirmedLedgerCsvAsync,
    exportFullData,
    exportFullDataAsync,
    exportSampleData,
    previewFullImport,
    previewFullImportAsync,
    collectMergeConflictsAsync,
    prepareFullImportPlanAsync,
    applyPreparedFullImportPlanAsync,
    applyPreparedFullImportPlanWithRollbackAsync,
    prepareOneOffCsvImportPlanAsync,
    applyPreparedOneOffCsvImportPlanAsync,
    createBudgetSafetySnapshotAsync,
    restoreBudgetSafetySnapshotAsync,
    importFullData,
    importFullDataAsync,
    importOneOffCsv,
    importOneOffCsvAsync,
    importSampleData,
    importSampleDataAsync
  };
}
