import { requireHolidayCountry, requireIsoDate, requireIsoMonth } from "./cashflow-date-utils.js";
import { requireSupportedCurrency } from "./cashflow-fx-provider-utils.js";
import { badRequest } from "./cashflow-user-utils.js";

const EXPORT_FORMAT = "cashflow-full-export";
const EXPORT_VERSION = 1;

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

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map(col => col.name);
}

function selectRows(db, tableName) {
  return db.prepare(`SELECT * FROM ${tableName}`).all();
}

function insertRows(db, tableName, rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;

  const liveColumns = tableColumns(db, tableName);
  const columns = liveColumns.filter(column => Object.prototype.hasOwnProperty.call(rows[0], column));
  if (!columns.length) return 0;

  const columnList = columns.map(column => `"${column}"`).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const insert = db.prepare(`
    INSERT INTO ${tableName} (${columnList})
    VALUES (${placeholders})
  `);

  let count = 0;
  for (const row of rows) {
    insert.run(...columns.map(column => row[column]));
    count += 1;
  }

  return count;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
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

  const headers = parseCsvLine(lines[0]).map(header => header.trim().toLowerCase());
  const missing = ONE_OFF_CSV_COLUMNS.filter(column => !headers.includes(column));

  if (missing.length) {
    throw badRequest(`CSV is missing required columns: ${missing.join(", ")}`);
  }

  return lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
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
  const amount = Number(row.amount);
  const currency = requireSupportedCurrency(row.currency || "PLN");
  const date = requireIsoDate(row.date || "", `CSV row ${rowNumber} date`);

  if (!name) {
    throw badRequest(`CSV row ${rowNumber} is missing name`);
  }

  if (!["income", "expense"].includes(type)) {
    throw badRequest(`CSV row ${rowNumber} has invalid type`);
  }

  if (!Number.isFinite(amount) || amount < 0) {
    throw badRequest(`CSV row ${rowNumber} has invalid amount`);
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

function normalizeExportPayload(payload) {
  const exportData = payload?.export || payload;

  if (!exportData || typeof exportData !== "object") {
    throw badRequest("Import payload is missing export data");
  }

  if (exportData.format !== EXPORT_FORMAT) {
    throw badRequest("Unsupported export format");
  }

  if (Number(exportData.version) !== EXPORT_VERSION) {
    throw badRequest("Unsupported export version");
  }

  if (!exportData.planning || typeof exportData.planning !== "object") {
    throw badRequest("Export is missing planning data");
  }

  if (!exportData.ledgers || typeof exportData.ledgers !== "object") {
    throw badRequest("Export is missing ledger data");
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

  validateExportPayloadRows(exportData);

  return exportData;
}

function validateExportPayloadRows(exportData) {
  const settings = exportData.planning.settings[0] || {};
  requireSupportedCurrency(settings.ledger_currency || "PLN", "settings.ledger_currency");
  requireHolidayCountry(settings.holiday_country || "PL", "settings.holiday_country");

  for (const tableName of ["recurring_expenses", "recurring_incomes", "goals", "flex_transactions", "one_off_transactions", "pending_transactions"]) {
    for (const row of exportData.planning[tableName] || []) {
      if (row.currency !== undefined) {
        requireSupportedCurrency(row.currency, `${tableName}.currency`);
      }
      if (row.ledger_currency !== undefined && row.ledger_currency !== null) {
        requireSupportedCurrency(row.ledger_currency, `${tableName}.ledger_currency`);
      }
      if (row.date) {
        requireIsoDate(row.date, `${tableName}.date`);
      }
      if (row.due_date) {
        requireIsoDate(row.due_date, `${tableName}.due_date`);
      }
      if (row.start_month_year) {
        requireIsoMonth(row.start_month_year, `${tableName}.start_month_year`);
      }
      if (row.anchor_holiday_country) {
        requireHolidayCountry(row.anchor_holiday_country, `${tableName}.anchor_holiday_country`);
      }
    }
  }

  for (const [year, rows] of Object.entries(exportData.ledgers || {})) {
    for (const row of rows || []) {
      if (String(row.date || "").slice(0, 4) !== String(year)) {
        requireIsoDate(row.date, `ledger_${year}.date`);
      } else {
        requireIsoDate(row.date, `ledger_${year}.date`);
      }
      requireIsoDate(row.confirmed_date, `ledger_${year}.confirmed_date`);
      requireSupportedCurrency(row.currency, `ledger_${year}.currency`);
      requireSupportedCurrency(row.ledger_currency || settings.ledger_currency || "PLN", `ledger_${year}.ledger_currency`);
    }
  }
}

function sampleExport() {
  const now = "2026-06-01T10:00:00.000Z";

  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now,
    sample: true,
    planning: {
      settings: [{
        id: 1,
        ledger_currency: "PLN",
        timezone: "Europe/Warsaw",
        locale: "en",
        holiday_country: "PL",
        future_periods: 4,
        minimum_reserve_enabled: 1,
        minimum_reserve_amount: 500,
        budget_period_income_id: "sample-income-salary",
        fx_buffer_percent: 0,
        fx_provider: "manual",
        fx_used_currencies: "[\"EUR\"]",
        manual_fx_rates: "{\"EUR/PLN\":4.3}",
        auto_backup_enabled: 0,
        backup_interval_minutes: 1440,
        backup_retention_count: 10,
        backup_location: null,
        ntfy_url: null,
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
    },
    ledgers: {
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
    }
  };
}

export function createCashflowDataPortabilityService({
  createBackup,
  generateId,
  listLedgerYears,
  loadAllConfirmedTransactions,
  openLedgerDb,
  openPlanningDb,
  recalculateLedgerRunningBalance,
  regenerateProjectionsAfterMutation,
  restoreBackupFromPath
}) {
  function exportFullData(userId, appVersion = "0.0.0") {
    const db = openPlanningDb(userId);
    const planning = {};

    try {
      for (const tableName of PLANNING_EXPORT_TABLES) {
        planning[tableName] = selectRows(db, tableName);
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

    return {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      appVersion,
      exportedAt: new Date().toISOString(),
      userId,
      planning,
      ledgers
    };
  }

  function replacePlanningData(userId, exportData) {
    const db = openPlanningDb(userId);

    try {
      db.transaction(() => {
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

  function collectMergeConflicts(userId, exportData) {
    const conflicts = [];
    const db = openPlanningDb(userId);

    try {
      conflicts.push(...fxCacheConflicts(db, exportData.planning.fx_rates_cache));
      for (const tableName of ID_TABLES) {
        conflicts.push(...idConflicts(db, tableName, exportData.planning[tableName]));
      }
    } finally {
      db.close();
    }

    for (const [year, rows] of Object.entries(exportData.ledgers)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        conflicts.push(...idConflicts(ledgerDb, "confirmed_transactions", rows, `ledger_${year}.confirmed_transactions`));
      } finally {
        ledgerDb.close();
      }
    }

    return conflicts;
  }

  function mergePlanningData(userId, exportData) {
    const db = openPlanningDb(userId);

    try {
      db.transaction(() => {
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

  function importFullData(userId, payload, mode = "replace") {
    const exportData = normalizeExportPayload(payload);
    const normalizedMode = mode === "merge" ? "merge" : "replace";

    if (normalizedMode === "merge") {
      const conflicts = collectMergeConflicts(userId, exportData);
      if (conflicts.length) {
        const error = new Error("Import has conflicting IDs");
        error.status = 409;
        error.conflicts = conflicts;
        throw error;
      }

      mergePlanningData(userId, exportData);
      mergeLedgerData(userId, exportData);
      recalculateLedgerRunningBalance(userId);
      const projection = regenerateProjectionsAfterMutation(userId);

      return {
        ok: true,
        mode: normalizedMode,
        importedPlanningTables: PLANNING_INSERT_ORDER.filter(name => name !== "settings"),
        importedLedgerYears: Object.keys(exportData.ledgers),
        _projection: projection
      };
    }

    const safetyBackup = createBackup(userId);

    try {
      replacePlanningData(userId, exportData);
      replaceLedgerData(userId, exportData);
      recalculateLedgerRunningBalance(userId);
      const projection = regenerateProjectionsAfterMutation(userId);

      return {
        ok: true,
        mode: normalizedMode,
        safetyBackup,
        importedLedgerYears: Object.keys(exportData.ledgers),
        _projection: projection
      };
    } catch (error) {
      restoreBackupFromPath(userId, safetyBackup);
      throw new Error(`Import failed and was rolled back from safety backup ${safetyBackup}: ${error.message}`);
    }
  }

  function confirmedOneOffSourceIds(userId) {
    return new Set(
      loadAllConfirmedTransactions(userId)
        .map(row => row.source_one_off_id)
        .filter(Boolean)
    );
  }

  function importOneOffCsv(userId, csv, mode = "append") {
    const normalizedMode = mode === "replace" ? "replace" : "append";
    const parsedRows = parseCsv(csv);
    const rows = parsedRows.map(row => normalizeCsvOneOff(row, generateId));
    const db = openPlanningDb(userId);

    try {
      db.transaction(() => {
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

  function exportConfirmedLedgerCsv(userId) {
    const headers = [
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

    const lines = [headers.join(",")];

    for (const row of loadAllConfirmedTransactions(userId)) {
      lines.push(headers.map(header => {
        if (header === "running_balance") return csvEscape(row.running_balance_pln);
        return csvEscape(row[header]);
      }).join(","));
    }

    return lines.join("\n");
  }

  function exportSampleData() {
    return sampleExport();
  }

  function importSampleData(userId) {
    return importFullData(userId, sampleExport(), "replace");
  }

  return {
    exportConfirmedLedgerCsv,
    exportFullData,
    exportSampleData,
    importFullData,
    importOneOffCsv,
    importSampleData
  };
}
