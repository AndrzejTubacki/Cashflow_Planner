import {
  createPostgresBudgetDbService
} from "./cashflow-postgres-budget-db-service.js";
import {
  sortConfirmedRowsForBalance
} from "./cashflow-ledger-balance-utils.js";
import {
  roundMoneyAmount
} from "./cashflow-money-utils.js";
import {
  POSTGRES_BUDGET_COLUMNS,
  POSTGRES_BUDGET_LEDGER_TABLES,
  POSTGRES_BUDGET_PLANNING_TABLES,
  POSTGRES_BUDGET_TABLES
} from "./cashflow-postgres-budget-schema.js";
import {
  normalizeSqliteBindValue
} from "./cashflow-sqlite-bind-utils.js";

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function assertBudgetTable(tableName) {
  if (!POSTGRES_BUDGET_TABLES.includes(tableName)) {
    throw new Error(`Unsupported budget table: ${tableName}`);
  }
  return tableName;
}

function assertPlanningTable(tableName) {
  if (!POSTGRES_BUDGET_PLANNING_TABLES.includes(tableName)) {
    throw new Error(`Unsupported planning table: ${tableName}`);
  }
  return tableName;
}

function assertIdPlanningTable(tableName, { allowSettings = true } = {}) {
  const safeTable = assertPlanningTable(tableName);
  if ((!allowSettings && safeTable === "settings") || !POSTGRES_BUDGET_COLUMNS[safeTable]?.includes("id")) {
    throw new Error(`Planning table does not support id-based writes: ${safeTable}`);
  }
  return safeTable;
}

function countFromResult(result) {
  return Number(result?.rows?.[0]?.count || 0);
}

function normalizeLedgerYear(value, index) {
  const ledgerYear = Number(value);
  if (!Number.isInteger(ledgerYear) || ledgerYear < 1900 || ledgerYear > 9999) {
    throw new Error(`Invalid confirmed-ledger balance update at index ${index}: ledgerYear is required`);
  }
  return ledgerYear;
}

function normalizeFiniteMoney(value, field, index) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid confirmed-ledger balance update at index ${index}: ${field} must be finite`);
  }
  return roundMoneyAmount(number);
}

function normalizeBalanceUpdates(updates = []) {
  if (!Array.isArray(updates)) {
    throw new Error("confirmed-ledger balance updates must be an array");
  }

  return updates.map((update, index) => {
    const id = String(update?.id || "").trim();
    if (!id) {
      throw new Error(`Invalid confirmed-ledger balance update at index ${index}: id is required`);
    }

    return {
      id,
      ledgerAmount: normalizeFiniteMoney(
        update.ledgerAmount ?? update.ledger_amount,
        "ledgerAmount",
        index
      ),
      ledgerYear: normalizeLedgerYear(update.ledgerYear ?? update.ledger_year, index),
      runningBalance: normalizeFiniteMoney(
        update.runningBalance ?? update.running_balance_pln,
        "runningBalance",
        index
      )
    };
  });
}

function normalizePlanningRowsForInsert(budgetId, tableName, rows = []) {
  const safeTable = assertPlanningTable(tableName);
  if (!Array.isArray(rows)) {
    throw new Error("planning rows must be an array");
  }

  const allowedColumns = new Set(POSTGRES_BUDGET_COLUMNS[safeTable] || []);
  return rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Invalid planning row at index ${index}: row must be an object`);
    }
    for (const column of Object.keys(row)) {
      if (!allowedColumns.has(column)) {
        throw new Error(`Invalid planning row at index ${index}: unsupported column ${column}`);
      }
    }
    if (row.budget_id !== undefined && row.budget_id !== budgetId) {
      throw new Error(`Invalid planning row at index ${index}: budget_id does not match`);
    }
    if (safeTable !== "settings" && allowedColumns.has("id") && !String(row.id || "").trim()) {
      throw new Error(`Invalid planning row at index ${index}: id is required`);
    }

    return {
      ...row,
      budget_id: budgetId
    };
  });
}

function columnsForInsertedRow(tableName, row, { includeBudgetId }) {
  const columns = POSTGRES_BUDGET_COLUMNS[tableName]
    .filter(column => includeBudgetId || column !== "budget_id")
    .filter(column => Object.prototype.hasOwnProperty.call(row, column));

  if (!columns.length) {
    throw new Error(`Cannot insert empty row into ${tableName}`);
  }

  return columns;
}

const DATE_ONLY_COLUMNS_BY_TABLE = {
  confirmed_transactions: ["date", "confirmed_date"],
  fx_rates_cache: ["rate_date", "effective_date"],
  future_transactions: ["date"],
  goals: ["due_date"],
  one_off_transactions: ["date"],
  pending_transactions: ["date"]
};

const TIMESTAMP_COLUMNS_BY_TABLE = {
  backup_metadata: ["backup_timestamp"],
  confirmed_transactions: ["created_at", "updated_at"],
  event_log: ["timestamp"],
  flex_transactions: ["created_at", "updated_at"],
  future_transactions: ["created_at", "updated_at", "generation_timestamp"],
  goals: ["created_at", "updated_at"],
  ledger_currency_events: ["changed_at"],
  notification_queue: ["queued_at", "sent_at"],
  one_off_transactions: ["created_at", "updated_at"],
  pending_transactions: ["created_at", "updated_at"],
  planned_transactions: ["created_at", "updated_at"],
  projection_snapshots: ["snapshot_timestamp", "created_at"],
  recurring_expenses: ["created_at", "updated_at"],
  recurring_incomes: ["created_at", "updated_at"],
  settings: ["setup_completed_at", "updated_at"]
};

function dbDateOnly(value) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return value;
}

function dbTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function normalizeRowsFromDb(tableName, rows = []) {
  const dateColumns = DATE_ONLY_COLUMNS_BY_TABLE[tableName] || [];
  const timestampColumns = TIMESTAMP_COLUMNS_BY_TABLE[tableName] || [];
  if (!dateColumns.length && !timestampColumns.length) return rows;

  return rows.map(row => {
    const normalized = { ...row };
    for (const column of dateColumns) {
      if (Object.prototype.hasOwnProperty.call(normalized, column)) {
        normalized[column] = dbDateOnly(normalized[column]);
      }
    }
    for (const column of timestampColumns) {
      if (Object.prototype.hasOwnProperty.call(normalized, column)) {
        normalized[column] = dbTimestamp(normalized[column]);
      }
    }
    return normalized;
  });
}

function normalizePlanningIds(tableName, ids = [], { allowSettings = false } = {}) {
  const safeTable = assertIdPlanningTable(tableName, { allowSettings });
  if (!Array.isArray(ids)) {
    throw new Error("planning row ids must be an array");
  }

  return {
    safeTable,
    ids: ids.map((id, index) => {
      const normalized = String(id || "").trim();
      if (!normalized) {
        throw new Error(`Invalid planning row id at index ${index}: id is required`);
      }
      return normalized;
    })
  };
}

function normalizeNotificationLimit(value) {
  const limit = Number(value ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("notification claim limit must be an integer from 1 to 500");
  }
  return limit;
}

function normalizeNotificationIds(ids = []) {
  if (!Array.isArray(ids)) {
    throw new Error("notification ids must be an array");
  }
  return ids.map((id, index) => {
    const normalized = String(id || "").trim();
    if (!normalized) {
      throw new Error(`Invalid notification id at index ${index}: id is required`);
    }
    return normalized;
  });
}

const PROJECTION_EVENT_ACTIONS = new Set([
  "funding_shortfall",
  "goal_impossible",
  "necessary_underfunded"
]);

const FUTURE_SOURCE_COLUMNS = new Set([
  "source_flex_id",
  "source_goal_id",
  "source_one_off_id",
  "source_recurring_expense_id",
  "source_recurring_income_id"
]);

function normalizeEventActions(actions = []) {
  if (!Array.isArray(actions)) {
    throw new Error("projection event actions must be an array");
  }

  return actions.map((action, index) => {
    const normalized = String(action || "").trim();
    if (!PROJECTION_EVENT_ACTIONS.has(normalized)) {
      throw new Error(`Invalid projection event action at index ${index}`);
    }
    return normalized;
  });
}

function normalizeOccurrenceKeys(keys = []) {
  if (!Array.isArray(keys)) {
    throw new Error("occurrence keys must be an array");
  }

  return keys.map((key, index) => {
    const normalized = String(key || "").trim();
    if (!normalized) {
      throw new Error(`Invalid occurrence key at index ${index}: occurrence key is required`);
    }
    return normalized;
  });
}

function normalizeOneOffRemainderFilter(oneOffId, {
  keepDate = null,
  keepOccurrenceKey = null
} = {}) {
  const normalizedOneOffId = String(oneOffId || "").trim();
  if (!normalizedOneOffId) {
    throw new Error("oneOffId is required");
  }

  const normalizedKeepKey = keepOccurrenceKey == null
    ? null
    : String(keepOccurrenceKey || "").trim();
  if (keepOccurrenceKey != null && !normalizedKeepKey) {
    throw new Error("keepOccurrenceKey cannot be blank");
  }

  const normalizedKeepDate = keepDate == null
    ? null
    : String(keepDate || "").slice(0, 10);
  if (keepDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(normalizedKeepDate)) {
    throw new Error("keepDate must be YYYY-MM-DD");
  }

  return {
    keepDate: normalizedKeepDate,
    keepOccurrenceKey: normalizedKeepKey,
    oneOffId: normalizedOneOffId
  };
}

function normalizeFutureSourceFilter(sourceColumn, sourceId, ledgerCurrency) {
  const safeColumn = String(sourceColumn || "").trim();
  if (!FUTURE_SOURCE_COLUMNS.has(safeColumn)) {
    throw new Error(`Unsupported future source column: ${safeColumn}`);
  }

  const normalizedSourceId = String(sourceId || "").trim();
  if (!normalizedSourceId) {
    throw new Error("sourceId is required");
  }

  const normalizedLedgerCurrency = String(ledgerCurrency || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalizedLedgerCurrency)) {
    throw new Error("ledgerCurrency must be a three-letter currency code");
  }

  return {
    ledgerCurrency: normalizedLedgerCurrency,
    sourceColumn: safeColumn,
    sourceId: normalizedSourceId
  };
}

function normalizeNotificationRows(budgetId, rows = []) {
  if (!Array.isArray(rows)) {
    throw new Error("notification rows must be an array");
  }

  return rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Invalid notification row at index ${index}: row must be an object`);
    }
    if (row.budget_id !== undefined && row.budget_id !== budgetId) {
      throw new Error(`Invalid notification row at index ${index}: budget_id does not match`);
    }

    const id = String(row.id || "").trim();
    const notificationType = String(row.notification_type || row.notificationType || "").trim();
    const title = String(row.title || "").trim();
    const message = String(row.message || "").trim();

    if (!id) throw new Error(`Invalid notification row at index ${index}: id is required`);
    if (!notificationType) throw new Error(`Invalid notification row at index ${index}: notification_type is required`);
    if (!title) throw new Error(`Invalid notification row at index ${index}: title is required`);
    if (!message) throw new Error(`Invalid notification row at index ${index}: message is required`);

    return {
      budget_id: budgetId,
      dedupe_key: row.dedupe_key ?? row.dedupeKey ?? null,
      entity_id: row.entity_id ?? row.entityId ?? null,
      id,
      message,
      notification_type: notificationType,
      priority: String(row.priority || "default").trim() || "default",
      queued_at: row.queued_at || row.queuedAt || new Date().toISOString(),
      sent_at: row.sent_at ?? row.sentAt ?? null,
      title
    };
  });
}

function normalizeFxRateRows(budgetId, rows = []) {
  if (!Array.isArray(rows)) {
    throw new Error("FX rate rows must be an array");
  }

  return rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Invalid FX rate row at index ${index}: row must be an object`);
    }
    const baseCurrency = String(row.base_currency || row.baseCurrency || row.currency || "").trim().toUpperCase();
    const quoteCurrency = String(row.quote_currency || row.quoteCurrency || "PLN").trim().toUpperCase();
    const currency = String(row.currency || baseCurrency).trim().toUpperCase();
    const rateDate = String(row.rate_date || row.rateDate || "").slice(0, 10);
    const effectiveDate = String(row.effective_date || row.effectiveDate || rateDate).slice(0, 10);
    const rate = Number(row.rate);

    if (row.budget_id !== undefined && row.budget_id !== budgetId) {
      throw new Error(`Invalid FX rate row at index ${index}: budget_id does not match`);
    }
    if (!baseCurrency) {
      throw new Error(`Invalid FX rate row at index ${index}: base_currency is required`);
    }
    if (!quoteCurrency) {
      throw new Error(`Invalid FX rate row at index ${index}: quote_currency is required`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate)) {
      throw new Error(`Invalid FX rate row at index ${index}: rate_date must be YYYY-MM-DD`);
    }
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Invalid FX rate row at index ${index}: rate must be positive`);
    }

    return {
      base_currency: baseCurrency,
      budget_id: budgetId,
      currency,
      effective_date: /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) ? effectiveDate : rateDate,
      quote_currency: quoteCurrency,
      rate,
      rate_date: rateDate,
      raw_json: row.raw_json ?? row.rawJson ?? null,
      source: String(row.source || "cache"),
      updated_at: row.updated_at || row.updatedAt || new Date().toISOString()
    };
  });
}

function normalizePlanningRowUpdates(budgetId, tableName, updates = []) {
  const safeTable = assertIdPlanningTable(tableName);
  if (!Array.isArray(updates)) {
    throw new Error("planning row updates must be an array");
  }

  const allowedColumns = new Set(POSTGRES_BUDGET_COLUMNS[safeTable] || []);
  return {
    safeTable,
    updates: updates.map((update, index) => {
      if (!update || typeof update !== "object" || Array.isArray(update)) {
        throw new Error(`Invalid planning row update at index ${index}: row must be an object`);
      }
      const id = String(update.id || "").trim();
      if (!id) {
        throw new Error(`Invalid planning row update at index ${index}: id is required`);
      }
      if (update.budget_id !== undefined && update.budget_id !== budgetId) {
        throw new Error(`Invalid planning row update at index ${index}: budget_id does not match`);
      }
      for (const column of Object.keys(update)) {
        if (!allowedColumns.has(column)) {
          throw new Error(`Invalid planning row update at index ${index}: unsupported column ${column}`);
        }
      }

      const values = Object.fromEntries(
        Object.entries(update).filter(([column]) => column !== "budget_id" && column !== "id")
      );
      if (!Object.keys(values).length) {
        throw new Error(`Invalid planning row update at index ${index}: at least one writable field is required`);
      }

      return {
        id,
        values
      };
    })
  };
}

function normalizeConfirmedRowsForInsert(budgetId, rows = []) {
  if (!Array.isArray(rows)) {
    throw new Error("confirmed rows must be an array");
  }

  const allowedColumns = new Set(POSTGRES_BUDGET_COLUMNS.confirmed_transactions || []);
  const requiredTextColumns = [
    "id",
    "name",
    "currency",
    "type",
    "date",
    "confirmed_date",
    "created_at",
    "updated_at"
  ];
  const requiredNumberColumns = [
    "amount",
    "running_balance_pln"
  ];
  const normalized = rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Invalid confirmed row at index ${index}: row must be an object`);
    }

    const prepared = { ...row };
    if (prepared.ledgerYear !== undefined && prepared.ledger_year === undefined) {
      prepared.ledger_year = prepared.ledgerYear;
    }
    delete prepared.ledgerYear;

    for (const column of Object.keys(prepared)) {
      if (!allowedColumns.has(column)) {
        throw new Error(`Invalid confirmed row at index ${index}: unsupported column ${column}`);
      }
    }
    if (prepared.budget_id !== undefined && prepared.budget_id !== budgetId) {
      throw new Error(`Invalid confirmed row at index ${index}: budget_id does not match`);
    }
    const id = String(prepared.id || "").trim();
    if (!id) {
      throw new Error(`Invalid confirmed row at index ${index}: id is required`);
    }
    for (const column of requiredTextColumns) {
      if (!String(prepared[column] || "").trim()) {
        throw new Error(`Invalid confirmed row at index ${index}: ${column} is required`);
      }
    }
    if (!["income", "expense"].includes(prepared.type)) {
      throw new Error(`Invalid confirmed row at index ${index}: type must be income or expense`);
    }
    for (const column of requiredNumberColumns) {
      const number = Number(prepared[column]);
      if (!Number.isFinite(number)) {
        throw new Error(`Invalid confirmed row at index ${index}: ${column} must be finite`);
      }
    }

    const ledgerYear = normalizeLedgerYear(prepared.ledger_year, index);
    const confirmedYear = /^\d{4}-\d{2}-\d{2}/.test(String(prepared.confirmed_date || ""))
      ? Number(String(prepared.confirmed_date).slice(0, 4))
      : NaN;
    if (!Number.isInteger(confirmedYear)) {
      throw new Error(`Invalid confirmed row at index ${index}: confirmed_date must start with YYYY-MM-DD`);
    }
    if (confirmedYear !== ledgerYear) {
      throw new Error(`Invalid confirmed row at index ${index}: ledger_year must match confirmed_date`);
    }

    return {
      ...prepared,
      amount: roundMoneyAmount(prepared.amount),
      budget_id: budgetId,
      id,
      ledger_amount: prepared.ledger_amount === null || prepared.ledger_amount === undefined
        ? prepared.ledger_amount
        : roundMoneyAmount(prepared.ledger_amount),
      ledger_year: ledgerYear,
      running_balance_pln: roundMoneyAmount(prepared.running_balance_pln)
    };
  });

  const years = new Set(normalized.map(row => row.ledger_year));
  if (years.size > 1) {
    throw new Error("confirmed rows must target one ledger year per insert call");
  }

  return normalized;
}

function normalizeConfirmedRowUpdates(budgetId, ledgerYear, updates = []) {
  const targetYear = normalizeLedgerYear(ledgerYear, "argument");
  if (!Array.isArray(updates)) {
    throw new Error("confirmed row updates must be an array");
  }

  const allowedColumns = new Set(POSTGRES_BUDGET_COLUMNS.confirmed_transactions || []);
  return {
    ledgerYear: targetYear,
    updates: updates.map((update, index) => {
      if (!update || typeof update !== "object" || Array.isArray(update)) {
        throw new Error(`Invalid confirmed row update at index ${index}: row must be an object`);
      }
      const id = String(update.id || "").trim();
      if (!id) {
        throw new Error(`Invalid confirmed row update at index ${index}: id is required`);
      }
      if (update.budget_id !== undefined && update.budget_id !== budgetId) {
        throw new Error(`Invalid confirmed row update at index ${index}: budget_id does not match`);
      }
      if (update.ledger_year !== undefined && Number(update.ledger_year) !== targetYear) {
        throw new Error(`Invalid confirmed row update at index ${index}: ledger_year does not match`);
      }
      for (const column of Object.keys(update)) {
        if (!allowedColumns.has(column)) {
          throw new Error(`Invalid confirmed row update at index ${index}: unsupported column ${column}`);
        }
      }

      const values = Object.fromEntries(
        Object.entries(update)
          .filter(([column]) => !["budget_id", "ledger_year", "id"].includes(column))
          .map(([column, value]) => {
            if (["amount", "ledger_amount", "running_balance_pln"].includes(column) && value !== null && value !== undefined) {
              return [column, roundMoneyAmount(value)];
            }
            return [column, value];
          })
      );
      if (!Object.keys(values).length) {
        throw new Error(`Invalid confirmed row update at index ${index}: at least one writable field is required`);
      }
      if (values.type !== undefined && !["income", "expense"].includes(values.type)) {
        throw new Error(`Invalid confirmed row update at index ${index}: type must be income or expense`);
      }
      if (values.confirmed_date !== undefined) {
        const confirmedYear = /^\d{4}-\d{2}-\d{2}/.test(String(values.confirmed_date || ""))
          ? Number(String(values.confirmed_date).slice(0, 4))
          : NaN;
        if (!Number.isInteger(confirmedYear) || confirmedYear !== targetYear) {
          throw new Error(`Invalid confirmed row update at index ${index}: confirmed_date must match ledger_year`);
        }
      }

      return {
        id,
        values
      };
    })
  };
}

function normalizeConfirmedIds(ledgerYear, ids = []) {
  const targetYear = normalizeLedgerYear(ledgerYear, "argument");
  if (!Array.isArray(ids)) {
    throw new Error("confirmed row ids must be an array");
  }

  return {
    ids: ids.map((id, index) => {
      const normalized = String(id || "").trim();
      if (!normalized) {
        throw new Error(`Invalid confirmed row id at index ${index}: id is required`);
      }
      return normalized;
    }),
    ledgerYear: targetYear
  };
}

function orderByForTable(tableName) {
  const columns = POSTGRES_BUDGET_COLUMNS[tableName] || [];
  if (tableName === "fx_rates_cache") {
    return ["base_currency", "quote_currency", "rate_date"]
      .filter(column => columns.includes(column))
      .map(column => `${quoteIdentifier(column)} ASC`)
      .join(", ");
  }
  if (columns.includes("id")) return `${quoteIdentifier("id")} ASC`;
  if (columns.includes("created_at")) return `${quoteIdentifier("created_at")} ASC`;
  return "";
}

export function createSqliteBudgetStore({
  listLedgerYears,
  openLedgerDb,
  openPlanningDb
} = {}) {
  if (typeof openPlanningDb !== "function") {
    throw new Error("openPlanningDb is required for SQLite budget storage");
  }

  function ledgerYearsForBudget(budgetId) {
    return typeof listLedgerYears === "function" ? listLedgerYears(budgetId) : [];
  }

  async function countRows(budgetId, tableName, { ledgerYear = null } = {}) {
    assertBudgetTable(tableName);

    if (POSTGRES_BUDGET_LEDGER_TABLES.includes(tableName)) {
      if (typeof openLedgerDb !== "function") {
        throw new Error("openLedgerDb is required for SQLite ledger storage");
      }
      const years = ledgerYear == null ? ledgerYearsForBudget(budgetId) : [ledgerYear];
      let total = 0;
      for (const year of years) {
        const db = openLedgerDb(budgetId, year, { create: false });
        try {
          total += Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get()?.count || 0);
        } finally {
          db.close();
        }
      }
      return total;
    }

    if (!POSTGRES_BUDGET_PLANNING_TABLES.includes(tableName)) {
      throw new Error(`Unsupported SQLite budget table: ${tableName}`);
    }

    const db = openPlanningDb(budgetId, { create: false });
    try {
      return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get()?.count || 0);
    } finally {
      db.close();
    }
  }

  async function listPlanningRows(budgetId, tableName) {
    const safeTable = assertPlanningTable(tableName);
    const orderBy = orderByForTable(safeTable);
    const db = openPlanningDb(budgetId, { create: false });
    try {
      return db.prepare(`
        SELECT *, ? AS budget_id
        FROM ${quoteIdentifier(safeTable)}
        ${orderBy ? `ORDER BY ${orderBy}` : ""}
      `).all(budgetId);
    } finally {
      db.close();
    }
  }

  async function insertPlanningRows(budgetId, tableName, rows = []) {
    const safeTable = assertPlanningTable(tableName);
    const normalized = normalizePlanningRowsForInsert(budgetId, safeTable, rows);
    const db = openPlanningDb(budgetId);

    try {
      const insertRows = db.transaction(() => {
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForInsertedRow(safeTable, row, { includeBudgetId: false });
          const statement = db.prepare(`
            INSERT INTO ${quoteIdentifier(safeTable)} (${columns.map(quoteIdentifier).join(", ")})
            VALUES (${columns.map(() => "?").join(", ")})
          `);
          inserted += statement.run(columns.map(column => normalizeSqliteBindValue(row[column]))).changes;
        }
        return inserted;
      });
      return { inserted: insertRows() };
    } finally {
      db.close();
    }
  }

  async function updatePlanningRowsById(budgetId, tableName, updates = []) {
    const { safeTable, updates: normalized } = normalizePlanningRowUpdates(budgetId, tableName, updates);
    const db = openPlanningDb(budgetId);

    try {
      const updateRows = db.transaction(() => {
        let updated = 0;
        for (const update of normalized) {
          const columns = Object.keys(update.values);
          const statement = db.prepare(`
            UPDATE ${quoteIdentifier(safeTable)}
            SET ${columns.map(column => `${quoteIdentifier(column)} = ?`).join(", ")}
            WHERE id = ?
          `);
          updated += statement.run([
            ...columns.map(column => normalizeSqliteBindValue(update.values[column])),
            update.id
          ]).changes;
        }
        return updated;
      });
      return { updated: updateRows() };
    } finally {
      db.close();
    }
  }

  async function deletePlanningRowsById(budgetId, tableName, ids = []) {
    const { safeTable, ids: normalized } = normalizePlanningIds(tableName, ids);
    const db = openPlanningDb(budgetId);

    try {
      const deleteRows = db.transaction(() => {
        if (!normalized.length) return 0;
        return db.prepare(`
          DELETE FROM ${quoteIdentifier(safeTable)}
          WHERE id IN (${normalized.map(() => "?").join(", ")})
        `).run(normalized).changes;
      });
      return { deleted: deleteRows() };
    } finally {
      db.close();
    }
  }

  async function deleteProjectionEventLogs(budgetId, actions = []) {
    const normalized = normalizeEventActions(actions);
    const db = openPlanningDb(budgetId);

    try {
      if (!normalized.length) return { deleted: 0 };
      return {
        deleted: db.prepare(`
          DELETE FROM event_log
          WHERE action IN (${normalized.map(() => "?").join(", ")})
        `).run(normalized).changes
      };
    } finally {
      db.close();
    }
  }

  async function deletePendingTransactionsByOccurrenceKeys(budgetId, occurrenceKeys = []) {
    const normalized = normalizeOccurrenceKeys(occurrenceKeys);
    const db = openPlanningDb(budgetId);

    try {
      if (!normalized.length) return { deleted: 0 };
      return {
        deleted: db.prepare(`
          DELETE FROM pending_transactions
          WHERE occurrence_key IN (${normalized.map(() => "?").join(", ")})
        `).run(normalized).changes
      };
    } finally {
      db.close();
    }
  }

  async function deletePendingOneOffRemainders(budgetId, oneOffId, options = {}) {
    const filter = normalizeOneOffRemainderFilter(oneOffId, options);
    const db = openPlanningDb(budgetId);

    try {
      if (filter.keepOccurrenceKey && filter.keepDate) {
        return {
          deleted: db.prepare(`
            DELETE FROM pending_transactions
            WHERE source_one_off_id = ?
              AND (
                occurrence_key != ?
                OR date != ?
              )
          `).run(filter.oneOffId, filter.keepOccurrenceKey, filter.keepDate).changes
        };
      }

      if (filter.keepOccurrenceKey) {
        return {
          deleted: db.prepare(`
            DELETE FROM pending_transactions
            WHERE source_one_off_id = ?
              AND occurrence_key != ?
          `).run(filter.oneOffId, filter.keepOccurrenceKey).changes
        };
      }

      return {
        deleted: db.prepare(`
          DELETE FROM pending_transactions
          WHERE source_one_off_id = ?
        `).run(filter.oneOffId).changes
      };
    } finally {
      db.close();
    }
  }

  async function pendingTransactionExistsByOccurrenceKey(budgetId, occurrenceKey) {
    const [normalized] = normalizeOccurrenceKeys([occurrenceKey]);
    const db = openPlanningDb(budgetId, { create: false });

    try {
      return Boolean(db.prepare(`
        SELECT 1
        FROM pending_transactions
        WHERE occurrence_key = ?
        LIMIT 1
      `).get(normalized));
    } finally {
      db.close();
    }
  }

  async function sumFutureLedgerAmountBySource(budgetId, sourceColumn, sourceId, ledgerCurrency) {
    const filter = normalizeFutureSourceFilter(sourceColumn, sourceId, ledgerCurrency);
    const db = openPlanningDb(budgetId, { create: false });

    try {
      return roundMoneyAmount(db.prepare(`
        SELECT COALESCE(SUM(ledger_amount), 0) AS value
        FROM future_transactions
        WHERE ${quoteIdentifier(filter.sourceColumn)} = ?
          AND COALESCE(ledger_currency, 'PLN') = ?
      `).get(filter.sourceId, filter.ledgerCurrency)?.value || 0);
    } finally {
      db.close();
    }
  }

  async function futureProjectionSummary(budgetId) {
    const db = openPlanningDb(budgetId, { create: false });

    try {
      const income = db.prepare(`
        SELECT COALESCE(SUM(ledger_amount), 0) AS value
        FROM future_transactions
        WHERE type = 'income'
      `).get();
      const expenses = db.prepare(`
        SELECT COALESCE(SUM(ledger_amount), 0) AS value
        FROM future_transactions
        WHERE type != 'income'
      `).get();
      const warnings = db.prepare(`
        SELECT COUNT(*) AS value
        FROM future_transactions
        WHERE status IN ('partial', 'underfunded')
      `).get();

      return {
        totalProjectedExpenses: roundMoneyAmount(expenses?.value || 0),
        totalProjectedIncome: roundMoneyAmount(income?.value || 0),
        warningCount: Number(warnings?.value || 0)
      };
    } finally {
      db.close();
    }
  }

  async function replacePlanningRows(budgetId, tableName, rows = []) {
    const safeTable = assertPlanningTable(tableName);
    const normalized = normalizePlanningRowsForInsert(budgetId, safeTable, rows);
    const db = openPlanningDb(budgetId);

    try {
      const replaceRows = db.transaction(() => {
        db.prepare(`DELETE FROM ${quoteIdentifier(safeTable)}`).run();
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForInsertedRow(safeTable, row, { includeBudgetId: false });
          const statement = db.prepare(`
            INSERT INTO ${quoteIdentifier(safeTable)} (${columns.map(quoteIdentifier).join(", ")})
            VALUES (${columns.map(() => "?").join(", ")})
          `);
          inserted += statement.run(columns.map(column => normalizeSqliteBindValue(row[column]))).changes;
        }
        return inserted;
      });
      return { inserted: replaceRows(), replaced: true };
    } finally {
      db.close();
    }
  }

  async function upsertFxRates(budgetId, rows = []) {
    const normalized = normalizeFxRateRows(budgetId, rows);
    const db = openPlanningDb(budgetId);

    try {
      const upsertRows = db.transaction(() => {
        let upserted = 0;
        const statement = db.prepare(`
          INSERT INTO fx_rates_cache (
            base_currency, quote_currency, currency, rate_date, rate,
            effective_date, source, raw_json, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(base_currency, quote_currency, rate_date) DO UPDATE SET
            currency = excluded.currency,
            rate = excluded.rate,
            effective_date = excluded.effective_date,
            source = excluded.source,
            raw_json = excluded.raw_json,
            updated_at = excluded.updated_at
        `);
        for (const row of normalized) {
          upserted += statement.run(
            row.base_currency,
            row.quote_currency,
            row.currency,
            row.rate_date,
            row.rate,
            row.effective_date,
            row.source,
            row.raw_json,
            row.updated_at
          ).changes;
        }
        return upserted;
      });
      return { upserted: upsertRows() };
    } finally {
      db.close();
    }
  }

  async function upsertNotifications(budgetId, rows = []) {
    const normalized = normalizeNotificationRows(budgetId, rows);
    const db = openPlanningDb(budgetId);

    try {
      const upsertRows = db.transaction(() => {
        let upserted = 0;
        const statement = db.prepare(`
          INSERT INTO notification_queue (
            id, notification_type, title, message, priority, entity_id, queued_at, sent_at, dedupe_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(dedupe_key) DO UPDATE SET
            title = excluded.title,
            message = excluded.message,
            priority = excluded.priority,
            queued_at = excluded.queued_at
        `);
        for (const row of normalized) {
          upserted += statement.run(
            row.id,
            row.notification_type,
            row.title,
            row.message,
            row.priority,
            row.entity_id,
            row.queued_at,
            row.sent_at,
            row.dedupe_key
          ).changes;
        }
        return upserted;
      });
      return { upserted: upsertRows() };
    } finally {
      db.close();
    }
  }

  async function listConfirmedTransactions(budgetId, { ledgerYear = null } = {}) {
    if (typeof openLedgerDb !== "function") {
      throw new Error("openLedgerDb is required for SQLite ledger storage");
    }
    const years = ledgerYear == null ? ledgerYearsForBudget(budgetId) : [ledgerYear];
    const rows = [];

    for (const year of years) {
      const db = openLedgerDb(budgetId, year, { create: false });
      try {
        rows.push(...db.prepare(`
          SELECT *, ? AS ledger_year, ? AS budget_id
          FROM confirmed_transactions
        `).all(year, budgetId));
      } finally {
        db.close();
      }
    }

    return sortConfirmedRowsForBalance(rows);
  }

  async function insertConfirmedTransactions(budgetId, rows = []) {
    if (typeof openLedgerDb !== "function") {
      throw new Error("openLedgerDb is required for SQLite ledger storage");
    }

    const normalized = normalizeConfirmedRowsForInsert(budgetId, rows);
    if (!normalized.length) return { inserted: 0 };

    const ledgerYear = normalized[0].ledger_year;
    const db = openLedgerDb(budgetId, ledgerYear);
    try {
      const insertRows = db.transaction(() => {
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForInsertedRow("confirmed_transactions", row, { includeBudgetId: false })
            .filter(column => column !== "ledger_year");
          const statement = db.prepare(`
            INSERT INTO confirmed_transactions (${columns.map(quoteIdentifier).join(", ")})
            VALUES (${columns.map(() => "?").join(", ")})
          `);
          inserted += statement.run(columns.map(column => normalizeSqliteBindValue(row[column]))).changes;
        }
        return inserted;
      });
      return { inserted: insertRows() };
    } finally {
      db.close();
    }
  }

  async function updateConfirmedTransactionsById(budgetId, ledgerYear, updates = []) {
    if (typeof openLedgerDb !== "function") {
      throw new Error("openLedgerDb is required for SQLite ledger storage");
    }

    const { ledgerYear: targetYear, updates: normalized } = normalizeConfirmedRowUpdates(
      budgetId,
      ledgerYear,
      updates
    );
    const db = openLedgerDb(budgetId, targetYear);
    try {
      const updateRows = db.transaction(() => {
        let updated = 0;
        for (const update of normalized) {
          const columns = Object.keys(update.values);
          const statement = db.prepare(`
            UPDATE confirmed_transactions
            SET ${columns.map(column => `${quoteIdentifier(column)} = ?`).join(", ")}
            WHERE id = ?
          `);
          updated += statement.run([
            ...columns.map(column => normalizeSqliteBindValue(update.values[column])),
            update.id
          ]).changes;
        }
        return updated;
      });
      return { updated: updateRows() };
    } finally {
      db.close();
    }
  }

  async function deleteConfirmedTransactionsById(budgetId, ledgerYear, ids = []) {
    if (typeof openLedgerDb !== "function") {
      throw new Error("openLedgerDb is required for SQLite ledger storage");
    }

    const { ledgerYear: targetYear, ids: normalized } = normalizeConfirmedIds(ledgerYear, ids);
    const db = openLedgerDb(budgetId, targetYear);
    try {
      const deleteRows = db.transaction(() => {
        if (!normalized.length) return 0;
        return db.prepare(`
          DELETE FROM confirmed_transactions
          WHERE id IN (${normalized.map(() => "?").join(", ")})
        `).run(normalized).changes;
      });
      return { deleted: deleteRows() };
    } finally {
      db.close();
    }
  }

  async function replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows = []) {
    if (typeof openLedgerDb !== "function") {
      throw new Error("openLedgerDb is required for SQLite ledger storage");
    }

    const targetYear = normalizeLedgerYear(ledgerYear, "argument");
    const normalized = normalizeConfirmedRowsForInsert(budgetId, rows);
    for (const row of normalized) {
      if (row.ledger_year !== targetYear) {
        throw new Error("confirmed rows must match the replacement ledger year");
      }
    }

    const db = openLedgerDb(budgetId, targetYear);
    try {
      const replaceRows = db.transaction(() => {
        db.prepare("DELETE FROM confirmed_transactions").run();
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForInsertedRow("confirmed_transactions", row, { includeBudgetId: false })
            .filter(column => column !== "ledger_year");
          const statement = db.prepare(`
            INSERT INTO confirmed_transactions (${columns.map(quoteIdentifier).join(", ")})
            VALUES (${columns.map(() => "?").join(", ")})
          `);
          inserted += statement.run(columns.map(column => normalizeSqliteBindValue(row[column]))).changes;
        }
        return inserted;
      });
      return { inserted: replaceRows(), ledgerYear: targetYear, replaced: true };
    } finally {
      db.close();
    }
  }

  async function checkReadiness(budgetId) {
    const db = openPlanningDb(budgetId, { create: false });
    try {
      const planningSchemaVersion = Number(db.pragma("user_version", { simple: true }) || 0);
      return {
        ok: true,
        backend: "sqlite",
        budgetId,
        ledgerYears: ledgerYearsForBudget(budgetId),
        planningSchemaVersion
      };
    } finally {
      db.close();
    }
  }

  async function updateConfirmedLedgerBalances(budgetId, updates = []) {
    if (typeof openLedgerDb !== "function") {
      throw new Error("openLedgerDb is required for SQLite ledger storage");
    }

    const normalized = normalizeBalanceUpdates(updates);
    const byYear = new Map();
    for (const update of normalized) {
      const existing = byYear.get(update.ledgerYear) || [];
      existing.push(update);
      byYear.set(update.ledgerYear, existing);
    }

    let updated = 0;
    for (const [year, yearUpdates] of byYear.entries()) {
      const db = openLedgerDb(budgetId, year);
      try {
        const statement = db.prepare(`
          UPDATE confirmed_transactions
          SET running_balance_pln = ?, ledger_amount = ?
          WHERE id = ?
        `);
        const applyUpdates = db.transaction(() => {
          let changes = 0;
          for (const update of yearUpdates) {
            changes += statement.run(
              update.runningBalance,
              update.ledgerAmount,
              update.id
            ).changes;
          }
          return changes;
        });
        updated += applyUpdates();
      } finally {
        db.close();
      }
    }

    return { updated };
  }

  return {
    backend: "sqlite",
    checkReadiness,
    close: async () => {},
    countRows,
    deleteConfirmedTransactionsById,
    deletePlanningRowsById,
    deletePendingOneOffRemainders,
    deletePendingTransactionsByOccurrenceKeys,
    deleteProjectionEventLogs,
    futureProjectionSummary,
    insertConfirmedTransactions,
    insertPlanningRows,
    listConfirmedTransactions,
    listPlanningRows,
    listLedgerYears: async budgetId => ledgerYearsForBudget(budgetId),
    pendingTransactionExistsByOccurrenceKey,
    replaceConfirmedTransactionsForYear,
    replacePlanningRows,
    sumFutureLedgerAmountBySource,
    updateConfirmedTransactionsById,
    updatePlanningRowsById,
    updateConfirmedLedgerBalances,
    upsertFxRates,
    upsertNotifications
  };
}

export async function createPostgresBudgetStore(options = {}) {
  const service = await createPostgresBudgetDbService(options);

  function repositoryForClient(client) {
    async function countRows(budgetId, tableName, { ledgerYear = null } = {}) {
      assertBudgetTable(tableName);
      const params = [budgetId];
      let where = "budget_id = $1";
      if (ledgerYear != null) {
        params.push(Number(ledgerYear));
        where += " AND ledger_year = $2";
      }
      const result = await client.query(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)} WHERE ${where}`,
        params
      );
      return countFromResult(result);
    }

    async function listPlanningRows(budgetId, tableName) {
      const safeTable = assertPlanningTable(tableName);
      const orderBy = orderByForTable(safeTable);
      const result = await client.query(
        `
          SELECT *
          FROM ${quoteIdentifier(safeTable)}
          WHERE budget_id = $1
          ${orderBy ? `ORDER BY ${orderBy}` : ""}
        `,
        [budgetId]
      );
      return normalizeRowsFromDb(safeTable, result?.rows || []);
    }

    async function insertPlanningRows(budgetId, tableName, rows = []) {
      const safeTable = assertPlanningTable(tableName);
      const normalized = normalizePlanningRowsForInsert(budgetId, safeTable, rows);
      let inserted = 0;
      for (const row of normalized) {
        const columns = columnsForInsertedRow(safeTable, row, { includeBudgetId: true });
        const result = await client.query(
          `
            INSERT INTO ${quoteIdentifier(safeTable)} (${columns.map(quoteIdentifier).join(", ")})
            VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
          `,
          columns.map(column => row[column])
        );
        inserted += Number(result?.rowCount || 0);
      }
      return { inserted };
    }

    async function replacePlanningRows(budgetId, tableName, rows = []) {
      const safeTable = assertPlanningTable(tableName);
      const normalized = normalizePlanningRowsForInsert(budgetId, safeTable, rows);

      await client.query(
        `DELETE FROM ${quoteIdentifier(safeTable)} WHERE budget_id = $1`,
        [budgetId]
      );
      let inserted = 0;
      for (const row of normalized) {
        const columns = columnsForInsertedRow(safeTable, row, { includeBudgetId: true });
        const result = await client.query(
          `
            INSERT INTO ${quoteIdentifier(safeTable)} (${columns.map(quoteIdentifier).join(", ")})
            VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
          `,
          columns.map(column => row[column])
        );
        inserted += Number(result?.rowCount || 0);
      }
      return { inserted, replaced: true };
    }

    async function upsertFxRates(budgetId, rows = []) {
      const normalized = normalizeFxRateRows(budgetId, rows);
      let upserted = 0;
      for (const row of normalized) {
        const result = await client.query(
          `
            INSERT INTO fx_rates_cache (
              budget_id, base_currency, quote_currency, currency, rate_date,
              rate, effective_date, source, raw_json, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (budget_id, base_currency, quote_currency, rate_date)
            DO UPDATE SET
              currency = EXCLUDED.currency,
              rate = EXCLUDED.rate,
              effective_date = EXCLUDED.effective_date,
              source = EXCLUDED.source,
              raw_json = EXCLUDED.raw_json,
              updated_at = EXCLUDED.updated_at
          `,
          [
            row.budget_id,
            row.base_currency,
            row.quote_currency,
            row.currency,
            row.rate_date,
            row.rate,
            row.effective_date,
            row.source,
            row.raw_json,
            row.updated_at
          ]
        );
        upserted += Number(result?.rowCount || 0);
      }
      return { upserted };
    }

    async function upsertNotifications(budgetId, rows = []) {
      const normalized = normalizeNotificationRows(budgetId, rows);
      let upserted = 0;
      for (const row of normalized) {
        const result = await client.query(
          `
            INSERT INTO notification_queue (
              budget_id, id, notification_type, title, message, priority,
              entity_id, queued_at, sent_at, dedupe_key
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (budget_id, dedupe_key)
            WHERE dedupe_key IS NOT NULL
            DO UPDATE SET
              title = EXCLUDED.title,
              message = EXCLUDED.message,
              priority = EXCLUDED.priority,
              queued_at = EXCLUDED.queued_at
          `,
          [
            row.budget_id,
            row.id,
            row.notification_type,
            row.title,
            row.message,
            row.priority,
            row.entity_id,
            row.queued_at,
            row.sent_at,
            row.dedupe_key
          ]
        );
        upserted += Number(result?.rowCount || 0);
      }
      return { upserted };
    }

    async function updatePlanningRowsById(budgetId, tableName, updates = []) {
      const { safeTable, updates: normalized } = normalizePlanningRowUpdates(budgetId, tableName, updates);
      let updated = 0;
      for (const update of normalized) {
        const columns = Object.keys(update.values);
        const result = await client.query(
          `
            UPDATE ${quoteIdentifier(safeTable)}
            SET ${columns.map((column, index) => `${quoteIdentifier(column)} = $${index + 3}`).join(", ")}
            WHERE budget_id = $1
              AND id = $2
          `,
          [
            budgetId,
            update.id,
            ...columns.map(column => update.values[column])
          ]
        );
        updated += Number(result?.rowCount || 0);
      }
      return { updated };
    }

    async function deletePlanningRowsById(budgetId, tableName, ids = []) {
      const { safeTable, ids: normalized } = normalizePlanningIds(tableName, ids);
      let deleted = 0;
      if (normalized.length) {
        const result = await client.query(
          `
            DELETE FROM ${quoteIdentifier(safeTable)}
            WHERE budget_id = $1
              AND id = ANY($2::text[])
          `,
          [budgetId, normalized]
        );
        deleted = Number(result?.rowCount || 0);
      }
      return { deleted };
    }

    async function deleteProjectionEventLogs(budgetId, actions = []) {
      const normalized = normalizeEventActions(actions);
      if (!normalized.length) return { deleted: 0 };
      const result = await client.query(
        `
          DELETE FROM event_log
          WHERE budget_id = $1
            AND action = ANY($2::text[])
        `,
        [budgetId, normalized]
      );
      return { deleted: Number(result?.rowCount || 0) };
    }

    async function deletePendingTransactionsByOccurrenceKeys(budgetId, occurrenceKeys = []) {
      const normalized = normalizeOccurrenceKeys(occurrenceKeys);
      if (!normalized.length) return { deleted: 0 };
      const result = await client.query(
        `
          DELETE FROM pending_transactions
          WHERE budget_id = $1
            AND occurrence_key = ANY($2::text[])
        `,
        [budgetId, normalized]
      );
      return { deleted: Number(result?.rowCount || 0) };
    }

    async function deletePendingOneOffRemainders(budgetId, oneOffId, options = {}) {
      const filter = normalizeOneOffRemainderFilter(oneOffId, options);
      const params = [budgetId, filter.oneOffId];
      let predicate = "";

      if (filter.keepOccurrenceKey && filter.keepDate) {
        params.push(filter.keepOccurrenceKey, filter.keepDate);
        predicate = `
          AND (
            occurrence_key != $3
            OR date != $4
          )
        `;
      } else if (filter.keepOccurrenceKey) {
        params.push(filter.keepOccurrenceKey);
        predicate = "AND occurrence_key != $3";
      }

      const result = await client.query(
        `
          DELETE FROM pending_transactions
          WHERE budget_id = $1
            AND source_one_off_id = $2
            ${predicate}
        `,
        params
      );
      return { deleted: Number(result?.rowCount || 0) };
    }

    async function pendingTransactionExistsByOccurrenceKey(budgetId, occurrenceKey) {
      const [normalized] = normalizeOccurrenceKeys([occurrenceKey]);
      const result = await client.query(
        `
          SELECT 1
          FROM pending_transactions
          WHERE budget_id = $1
            AND occurrence_key = $2
          LIMIT 1
        `,
        [budgetId, normalized]
      );
      return Boolean(result?.rows?.[0]);
    }

    async function sumFutureLedgerAmountBySource(budgetId, sourceColumn, sourceId, ledgerCurrency) {
      const filter = normalizeFutureSourceFilter(sourceColumn, sourceId, ledgerCurrency);
      const result = await client.query(
        `
          SELECT COALESCE(SUM(ledger_amount), 0) AS value
          FROM future_transactions
          WHERE budget_id = $1
            AND ${quoteIdentifier(filter.sourceColumn)} = $2
            AND COALESCE(ledger_currency, 'PLN') = $3
        `,
        [budgetId, filter.sourceId, filter.ledgerCurrency]
      );
      return roundMoneyAmount(result?.rows?.[0]?.value || 0);
    }

    async function futureProjectionSummary(budgetId) {
      const result = await client.query(
        `
          SELECT
            COALESCE(SUM(CASE WHEN type = 'income' THEN ledger_amount ELSE 0 END), 0) AS total_projected_income,
            COALESCE(SUM(CASE WHEN type != 'income' THEN ledger_amount ELSE 0 END), 0) AS total_projected_expenses,
            COUNT(*) FILTER (WHERE status IN ('partial', 'underfunded')) AS warning_count
          FROM future_transactions
          WHERE budget_id = $1
        `,
        [budgetId]
      );
      const row = result?.rows?.[0] || {};
      return {
        totalProjectedExpenses: roundMoneyAmount(row.total_projected_expenses || 0),
        totalProjectedIncome: roundMoneyAmount(row.total_projected_income || 0),
        warningCount: Number(row.warning_count || 0)
      };
    }

    async function listConfirmedTransactions(budgetId, { ledgerYear = null } = {}) {
      const params = [budgetId];
      let where = "budget_id = $1";
      if (ledgerYear != null) {
        params.push(Number(ledgerYear));
        where += " AND ledger_year = $2";
      }
      const result = await client.query(
        `
          SELECT *
          FROM confirmed_transactions
          WHERE ${where}
          ORDER BY date ASC, created_at ASC, id ASC
        `,
        params
      );
      return normalizeRowsFromDb("confirmed_transactions", result?.rows || []);
    }

    async function insertConfirmedTransactions(budgetId, rows = []) {
      const normalized = normalizeConfirmedRowsForInsert(budgetId, rows);
      let inserted = 0;
      for (const row of normalized) {
        const columns = columnsForInsertedRow("confirmed_transactions", row, { includeBudgetId: true });
        const result = await client.query(
          `
            INSERT INTO confirmed_transactions (${columns.map(quoteIdentifier).join(", ")})
            VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
          `,
          columns.map(column => row[column])
        );
        inserted += Number(result?.rowCount || 0);
      }
      return { inserted };
    }

    async function updateConfirmedTransactionsById(budgetId, ledgerYear, updates = []) {
      const { ledgerYear: targetYear, updates: normalized } = normalizeConfirmedRowUpdates(
        budgetId,
        ledgerYear,
        updates
      );
      let updated = 0;
      for (const update of normalized) {
        const columns = Object.keys(update.values);
        const result = await client.query(
          `
            UPDATE confirmed_transactions
            SET ${columns.map((column, index) => `${quoteIdentifier(column)} = $${index + 4}`).join(", ")}
            WHERE budget_id = $1
              AND ledger_year = $2
              AND id = $3
          `,
          [
            budgetId,
            targetYear,
            update.id,
            ...columns.map(column => update.values[column])
          ]
        );
        updated += Number(result?.rowCount || 0);
      }
      return { updated };
    }

    async function deleteConfirmedTransactionsById(budgetId, ledgerYear, ids = []) {
      const { ledgerYear: targetYear, ids: normalized } = normalizeConfirmedIds(ledgerYear, ids);
      let deleted = 0;
      if (normalized.length) {
        const result = await client.query(
          `
            DELETE FROM confirmed_transactions
            WHERE budget_id = $1
              AND ledger_year = $2
              AND id = ANY($3::text[])
          `,
          [budgetId, targetYear, normalized]
        );
        deleted = Number(result?.rowCount || 0);
      }
      return { deleted };
    }

    async function replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows = []) {
      const targetYear = normalizeLedgerYear(ledgerYear, "argument");
      const normalized = normalizeConfirmedRowsForInsert(budgetId, rows);
      for (const row of normalized) {
        if (row.ledger_year !== targetYear) {
          throw new Error("confirmed rows must match the replacement ledger year");
        }
      }

      await client.query(
        `
          DELETE FROM confirmed_transactions
          WHERE budget_id = $1
            AND ledger_year = $2
        `,
        [budgetId, targetYear]
      );
      let inserted = 0;
      for (const row of normalized) {
        const columns = columnsForInsertedRow("confirmed_transactions", row, { includeBudgetId: true });
        const result = await client.query(
          `
            INSERT INTO confirmed_transactions (${columns.map(quoteIdentifier).join(", ")})
            VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
          `,
          columns.map(column => row[column])
        );
        inserted += Number(result?.rowCount || 0);
      }
      return { inserted, ledgerYear: targetYear, replaced: true };
    }

    async function listLedgerYears(budgetId) {
      const result = await client.query(
        `
          SELECT DISTINCT ledger_year
          FROM confirmed_transactions
          WHERE budget_id = $1
          ORDER BY ledger_year
        `,
        [budgetId]
      );
      return (result?.rows || []).map(row => Number(row.ledger_year));
    }

    async function updateConfirmedLedgerBalances(budgetId, updates = []) {
      const normalized = normalizeBalanceUpdates(updates);
      let updated = 0;
      for (const update of normalized) {
        const result = await client.query(
          `
            UPDATE confirmed_transactions
            SET running_balance_pln = $4,
                ledger_amount = $5
            WHERE budget_id = $1
              AND ledger_year = $2
              AND id = $3
          `,
          [
            budgetId,
            update.ledgerYear,
            update.id,
            update.runningBalance,
            update.ledgerAmount
          ]
        );
        updated += Number(result?.rowCount || 0);
      }
      return { updated };
    }

    async function lockBudgetLedger(budgetId) {
      const id = String(budgetId || "").trim();
      if (!id) {
        throw new Error("budgetId is required for ledger lock");
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`cashflow:budget-ledger:${id}`]
      );
      return { locked: true };
    }

    async function claimUnsentNotifications(budgetId, { limit = 50 } = {}) {
      const result = await client.query(
        `
          SELECT *
          FROM notification_queue
          WHERE budget_id = $1
            AND sent_at IS NULL
          ORDER BY queued_at ASC, id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        `,
        [budgetId, normalizeNotificationLimit(limit)]
      );
      return normalizeRowsFromDb("notification_queue", result?.rows || []);
    }

    async function markNotificationsSent(budgetId, ids = [], sentAt = new Date().toISOString()) {
      const normalizedIds = normalizeNotificationIds(ids);
      if (!normalizedIds.length) return { updated: 0 };
      const result = await client.query(
        `
          UPDATE notification_queue
          SET sent_at = $3
          WHERE budget_id = $1
            AND id = ANY($2::text[])
            AND sent_at IS NULL
        `,
        [budgetId, normalizedIds, sentAt]
      );
      return { updated: Number(result?.rowCount || 0) };
    }

    return {
      claimUnsentNotifications,
      countRows,
      deleteConfirmedTransactionsById,
      deletePlanningRowsById,
      deletePendingOneOffRemainders,
      deletePendingTransactionsByOccurrenceKeys,
      deleteProjectionEventLogs,
      futureProjectionSummary,
      insertConfirmedTransactions,
      insertPlanningRows,
      listConfirmedTransactions,
      listLedgerYears,
      listPlanningRows,
      lockBudgetLedger,
      markNotificationsSent,
      pendingTransactionExistsByOccurrenceKey,
      replaceConfirmedTransactionsForYear,
      replacePlanningRows,
      sumFutureLedgerAmountBySource,
      updateConfirmedTransactionsById,
      updatePlanningRowsById,
      updateConfirmedLedgerBalances,
      upsertFxRates,
      upsertNotifications
    };
  }

  async function transaction(fn) {
    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        const result = await fn(repositoryForClient(client), client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
        throw error;
      }
    });
  }

  async function countRows(budgetId, tableName, { ledgerYear = null } = {}) {
    assertBudgetTable(tableName);
    const params = [budgetId];
    let where = "budget_id = $1";
    if (ledgerYear != null) {
      params.push(Number(ledgerYear));
      where += " AND ledger_year = $2";
    }
    return await service.withClient(async client => {
      const result = await client.query(
        `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)} WHERE ${where}`,
        params
      );
      return countFromResult(result);
    });
  }

  async function listPlanningRows(budgetId, tableName) {
    const safeTable = assertPlanningTable(tableName);
    const orderBy = orderByForTable(safeTable);

    return await service.withClient(async client => {
      const result = await client.query(
        `
          SELECT *
          FROM ${quoteIdentifier(safeTable)}
          WHERE budget_id = $1
          ${orderBy ? `ORDER BY ${orderBy}` : ""}
        `,
        [budgetId]
      );
      return normalizeRowsFromDb(safeTable, result?.rows || []);
    });
  }

  async function insertPlanningRows(budgetId, tableName, rows = []) {
    const safeTable = assertPlanningTable(tableName);
    const normalized = normalizePlanningRowsForInsert(budgetId, safeTable, rows);

    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForInsertedRow(safeTable, row, { includeBudgetId: true });
          const result = await client.query(
            `
              INSERT INTO ${quoteIdentifier(safeTable)} (${columns.map(quoteIdentifier).join(", ")})
              VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
            `,
            columns.map(column => row[column])
          );
          inserted += Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return { inserted };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function replacePlanningRows(budgetId, tableName, rows = []) {
    const safeTable = assertPlanningTable(tableName);
    const normalized = normalizePlanningRowsForInsert(budgetId, safeTable, rows);

    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        await client.query(
          `DELETE FROM ${quoteIdentifier(safeTable)} WHERE budget_id = $1`,
          [budgetId]
        );
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForInsertedRow(safeTable, row, { includeBudgetId: true });
          const result = await client.query(
            `
              INSERT INTO ${quoteIdentifier(safeTable)} (${columns.map(quoteIdentifier).join(", ")})
              VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
            `,
            columns.map(column => row[column])
          );
          inserted += Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return { inserted, replaced: true };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function upsertFxRates(budgetId, rows = []) {
    const normalized = normalizeFxRateRows(budgetId, rows);

    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        let upserted = 0;
        for (const row of normalized) {
          const result = await client.query(
            `
              INSERT INTO fx_rates_cache (
                budget_id, base_currency, quote_currency, currency, rate_date,
                rate, effective_date, source, raw_json, updated_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
              ON CONFLICT (budget_id, base_currency, quote_currency, rate_date)
              DO UPDATE SET
                currency = EXCLUDED.currency,
                rate = EXCLUDED.rate,
                effective_date = EXCLUDED.effective_date,
                source = EXCLUDED.source,
                raw_json = EXCLUDED.raw_json,
                updated_at = EXCLUDED.updated_at
            `,
            [
              row.budget_id,
              row.base_currency,
              row.quote_currency,
              row.currency,
              row.rate_date,
              row.rate,
              row.effective_date,
              row.source,
              row.raw_json,
              row.updated_at
            ]
          );
          upserted += Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return { upserted };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function upsertNotifications(budgetId, rows = []) {
    const normalized = normalizeNotificationRows(budgetId, rows);

    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        let upserted = 0;
        for (const row of normalized) {
          const result = await client.query(
            `
              INSERT INTO notification_queue (
                budget_id, id, notification_type, title, message, priority,
                entity_id, queued_at, sent_at, dedupe_key
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
              ON CONFLICT (budget_id, dedupe_key)
              WHERE dedupe_key IS NOT NULL
              DO UPDATE SET
                title = EXCLUDED.title,
                message = EXCLUDED.message,
                priority = EXCLUDED.priority,
                queued_at = EXCLUDED.queued_at
            `,
            [
              row.budget_id,
              row.id,
              row.notification_type,
              row.title,
              row.message,
              row.priority,
              row.entity_id,
              row.queued_at,
              row.sent_at,
              row.dedupe_key
            ]
          );
          upserted += Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return { upserted };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function updatePlanningRowsById(budgetId, tableName, updates = []) {
    const { safeTable, updates: normalized } = normalizePlanningRowUpdates(budgetId, tableName, updates);

    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        let updated = 0;
        for (const update of normalized) {
          const columns = Object.keys(update.values);
          const result = await client.query(
            `
              UPDATE ${quoteIdentifier(safeTable)}
              SET ${columns.map((column, index) => `${quoteIdentifier(column)} = $${index + 3}`).join(", ")}
              WHERE budget_id = $1
                AND id = $2
            `,
            [
              budgetId,
              update.id,
              ...columns.map(column => update.values[column])
            ]
          );
          updated += Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return { updated };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function deletePlanningRowsById(budgetId, tableName, ids = []) {
    const { safeTable, ids: normalized } = normalizePlanningIds(tableName, ids);

    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        let deleted = 0;
        if (normalized.length) {
          const result = await client.query(
            `
              DELETE FROM ${quoteIdentifier(safeTable)}
              WHERE budget_id = $1
                AND id = ANY($2::text[])
            `,
            [budgetId, normalized]
          );
          deleted = Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return { deleted };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function deleteProjectionEventLogs(budgetId, actions = []) {
    return await service.withClient(async client =>
      await repositoryForClient(client).deleteProjectionEventLogs(budgetId, actions)
    );
  }

  async function deletePendingTransactionsByOccurrenceKeys(budgetId, occurrenceKeys = []) {
    return await service.withClient(async client =>
      await repositoryForClient(client).deletePendingTransactionsByOccurrenceKeys(budgetId, occurrenceKeys)
    );
  }

  async function deletePendingOneOffRemainders(budgetId, oneOffId, options = {}) {
    return await service.withClient(async client =>
      await repositoryForClient(client).deletePendingOneOffRemainders(budgetId, oneOffId, options)
    );
  }

  async function pendingTransactionExistsByOccurrenceKey(budgetId, occurrenceKey) {
    return await service.withClient(async client =>
      await repositoryForClient(client).pendingTransactionExistsByOccurrenceKey(budgetId, occurrenceKey)
    );
  }

  async function sumFutureLedgerAmountBySource(budgetId, sourceColumn, sourceId, ledgerCurrency) {
    return await service.withClient(async client =>
      await repositoryForClient(client).sumFutureLedgerAmountBySource(
        budgetId,
        sourceColumn,
        sourceId,
        ledgerCurrency
      )
    );
  }

  async function futureProjectionSummary(budgetId) {
    return await service.withClient(async client =>
      await repositoryForClient(client).futureProjectionSummary(budgetId)
    );
  }

  async function listConfirmedTransactions(budgetId, { ledgerYear = null } = {}) {
    const params = [budgetId];
    let where = "budget_id = $1";
    if (ledgerYear != null) {
      params.push(Number(ledgerYear));
      where += " AND ledger_year = $2";
    }

    return await service.withClient(async client => {
      const result = await client.query(
        `
          SELECT *
          FROM confirmed_transactions
          WHERE ${where}
          ORDER BY date ASC, created_at ASC, id ASC
        `,
        params
      );
      return normalizeRowsFromDb("confirmed_transactions", result?.rows || []);
    });
  }

  async function insertConfirmedTransactions(budgetId, rows = []) {
    const normalized = normalizeConfirmedRowsForInsert(budgetId, rows);

    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForInsertedRow("confirmed_transactions", row, { includeBudgetId: true });
          const result = await client.query(
            `
              INSERT INTO confirmed_transactions (${columns.map(quoteIdentifier).join(", ")})
              VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
            `,
            columns.map(column => row[column])
          );
          inserted += Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return { inserted };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function updateConfirmedTransactionsById(budgetId, ledgerYear, updates = []) {
    const { ledgerYear: targetYear, updates: normalized } = normalizeConfirmedRowUpdates(
      budgetId,
      ledgerYear,
      updates
    );

    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        let updated = 0;
        for (const update of normalized) {
          const columns = Object.keys(update.values);
          const result = await client.query(
            `
              UPDATE confirmed_transactions
              SET ${columns.map((column, index) => `${quoteIdentifier(column)} = $${index + 4}`).join(", ")}
              WHERE budget_id = $1
                AND ledger_year = $2
                AND id = $3
            `,
            [
              budgetId,
              targetYear,
              update.id,
              ...columns.map(column => update.values[column])
            ]
          );
          updated += Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return { updated };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function deleteConfirmedTransactionsById(budgetId, ledgerYear, ids = []) {
    const { ledgerYear: targetYear, ids: normalized } = normalizeConfirmedIds(ledgerYear, ids);

    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        let deleted = 0;
        if (normalized.length) {
          const result = await client.query(
            `
              DELETE FROM confirmed_transactions
              WHERE budget_id = $1
                AND ledger_year = $2
                AND id = ANY($3::text[])
            `,
            [budgetId, targetYear, normalized]
          );
          deleted = Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return { deleted };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows = []) {
    const targetYear = normalizeLedgerYear(ledgerYear, "argument");
    const normalized = normalizeConfirmedRowsForInsert(budgetId, rows);
    for (const row of normalized) {
      if (row.ledger_year !== targetYear) {
        throw new Error("confirmed rows must match the replacement ledger year");
      }
    }

    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        await client.query(
          `
            DELETE FROM confirmed_transactions
            WHERE budget_id = $1
              AND ledger_year = $2
          `,
          [budgetId, targetYear]
        );
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForInsertedRow("confirmed_transactions", row, { includeBudgetId: true });
          const result = await client.query(
            `
              INSERT INTO confirmed_transactions (${columns.map(quoteIdentifier).join(", ")})
              VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
            `,
            columns.map(column => row[column])
          );
          inserted += Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return { inserted, ledgerYear: targetYear, replaced: true };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function listLedgerYears(budgetId) {
    return await service.withClient(async client => {
      const result = await client.query(
        `
          SELECT DISTINCT ledger_year
          FROM confirmed_transactions
          WHERE budget_id = $1
          ORDER BY ledger_year
        `,
        [budgetId]
      );
      return (result?.rows || []).map(row => Number(row.ledger_year));
    });
  }

  async function checkReadiness(budgetId = null) {
    const ready = await service.checkReadiness();
    return {
      ...ready,
      budgetId
    };
  }

  async function updateConfirmedLedgerBalances(budgetId, updates = []) {
    const normalized = normalizeBalanceUpdates(updates);

    return await service.withClient(async client => {
      await client.query("BEGIN");
      try {
        let updated = 0;
        for (const update of normalized) {
          const result = await client.query(
            `
              UPDATE confirmed_transactions
              SET running_balance_pln = $4,
                  ledger_amount = $5
              WHERE budget_id = $1
                AND ledger_year = $2
                AND id = $3
            `,
            [
              budgetId,
              update.ledgerYear,
              update.id,
              update.runningBalance,
              update.ledgerAmount
            ]
          );
          updated += Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return { updated };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  return {
    backend: "postgres",
    checkReadiness,
    close: service.close,
    countRows,
    deleteConfirmedTransactionsById,
    deletePlanningRowsById,
    deletePendingOneOffRemainders,
    deletePendingTransactionsByOccurrenceKeys,
    deleteProjectionEventLogs,
    futureProjectionSummary,
    initialize: service.initializeBudgetSchema,
    insertConfirmedTransactions,
    insertPlanningRows,
    listConfirmedTransactions,
    listLedgerYears,
    listPlanningRows,
    pendingTransactionExistsByOccurrenceKey,
    replaceConfirmedTransactionsForYear,
    replacePlanningRows,
    sumFutureLedgerAmountBySource,
    transaction,
    updateConfirmedTransactionsById,
    updatePlanningRowsById,
    updateConfirmedLedgerBalances,
    upsertFxRates,
    upsertNotifications,
    withClient: service.withClient
  };
}
