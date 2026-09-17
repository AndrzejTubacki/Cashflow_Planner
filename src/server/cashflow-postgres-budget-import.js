import {
  createPostgresBudgetStorageSchemaSql,
  POSTGRES_BUDGET_COLUMNS,
  POSTGRES_BUDGET_TABLES
} from "./cashflow-postgres-budget-schema.js";
import { normalizeUserId } from "./cashflow-user-utils.js";

export const SQLITE_BUDGET_STORAGE_EXPORT_FORMAT = "cashflow-sqlite-budget-storage-export";
export const SQLITE_BUDGET_STORAGE_EXPORT_VERSION = 1;

const BOOLEAN_COLUMNS = {
  settings: new Set([
    "minimum_reserve_enabled",
    "auto_backup_enabled",
    "notify_goal_impossible",
    "notify_necessary_underfunded",
    "notify_funding_shortfall",
    "notify_income_missing",
    "notify_pending_summary",
    "notify_goal_funded",
    "notify_fx_changed",
    "setup_completed"
  ]),
  recurring_expenses: new Set(["necessary", "active"]),
  recurring_incomes: new Set(["active", "period_setting"]),
  flex_transactions: new Set(["active", "allow_split"]),
  goals: new Set(["active"]),
  backup_metadata: new Set(["success"]),
  projection_snapshots: new Set(["generation_succeeded"])
};

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function detail(table, row, field, reason) {
  return {
    table,
    row,
    field,
    reason
  };
}

function importValidationError(message, details = []) {
  const error = new Error(message);
  error.status = 400;
  error.details = details;
  return error;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeBooleanValue(value, tableName, column, rowNumber) {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return Boolean(value);
  throw importValidationError("Invalid budget storage export", [
    detail(tableName, rowNumber, column, "must be boolean-compatible")
  ]);
}

function normalizeRow(tableName, row, rowIndex) {
  const rowNumber = rowIndex + 1;
  if (!isPlainObject(row)) {
    throw importValidationError("Invalid budget storage export", [
      detail(tableName, rowNumber, "", "row must be an object")
    ]);
  }

  const allowedColumns = new Set(POSTGRES_BUDGET_COLUMNS[tableName]);
  for (const column of Object.keys(row)) {
    if (!allowedColumns.has(column)) {
      throw importValidationError("Invalid budget storage export", [
        detail(tableName, rowNumber, column, "unknown_column")
      ]);
    }
  }

  if (!String(row.budget_id || "").trim()) {
    throw importValidationError("Invalid budget storage export", [
      detail(tableName, rowNumber, "budget_id", "required")
    ]);
  }
  row.budget_id = normalizeUserId(row.budget_id);

  if (tableName === "settings" && Number(row.id) !== 1) {
    throw importValidationError("Invalid budget storage export", [
      detail(tableName, rowNumber, "id", "must_be_1")
    ]);
  }

  if (POSTGRES_BUDGET_COLUMNS[tableName].includes("id") && tableName !== "settings") {
    if (!String(row.id || "").trim()) {
      throw importValidationError("Invalid budget storage export", [
        detail(tableName, rowNumber, "id", "required")
      ]);
    }
  }

  if (tableName === "confirmed_transactions") {
    const year = Number(row.ledger_year);
    if (!Number.isInteger(year) || year < 1900 || year > 9999) {
      throw importValidationError("Invalid budget storage export", [
        detail(tableName, rowNumber, "ledger_year", "invalid_year")
      ]);
    }
    row.ledger_year = year;
  }

  for (const column of BOOLEAN_COLUMNS[tableName] || []) {
    if (Object.prototype.hasOwnProperty.call(row, column)) {
      row[column] = normalizeBooleanValue(row[column], tableName, column, rowNumber);
    }
  }

  return row;
}

function keyForRow(tableName, row) {
  if (tableName === "settings") return `${row.budget_id}:settings:1`;
  if (tableName === "fx_rates_cache") {
    return [
      row.budget_id,
      row.base_currency,
      row.quote_currency,
      row.rate_date
    ].join(":");
  }
  if (tableName === "confirmed_transactions") {
    return `${row.budget_id}:${row.ledger_year}:${row.id}`;
  }
  if (POSTGRES_BUDGET_COLUMNS[tableName].includes("id")) {
    return `${row.budget_id}:${row.id}`;
  }
  return null;
}

function assertNoDuplicates(tableName, rows) {
  const seen = new Set();
  rows.forEach((row, index) => {
    const key = keyForRow(tableName, row);
    if (!key) return;
    if (seen.has(key)) {
      throw importValidationError("Invalid budget storage export", [
        detail(tableName, index + 1, "", "duplicate_key")
      ]);
    }
    seen.add(key);
  });
}

export function normalizeSqliteBudgetStorageExport(payload) {
  if (!isPlainObject(payload)) {
    throw importValidationError("Budget storage export must be an object");
  }
  if (payload.format !== SQLITE_BUDGET_STORAGE_EXPORT_FORMAT) {
    throw importValidationError("Unsupported budget storage export format", [
      detail("", 0, "format", "unsupported")
    ]);
  }
  if (payload.version !== SQLITE_BUDGET_STORAGE_EXPORT_VERSION) {
    throw importValidationError("Unsupported budget storage export version", [
      detail("", 0, "version", "unsupported")
    ]);
  }
  if (!isPlainObject(payload.tables)) {
    throw importValidationError("Budget storage export tables must be an object", [
      detail("", 0, "tables", "required")
    ]);
  }

  for (const tableName of Object.keys(payload.tables)) {
    if (!POSTGRES_BUDGET_TABLES.includes(tableName)) {
      throw importValidationError("Invalid budget storage export", [
        detail(tableName, 0, "", "unknown_table")
      ]);
    }
  }

  const tables = {};
  const rowCounts = {};
  for (const tableName of POSTGRES_BUDGET_TABLES) {
    const rows = payload.tables[tableName] || [];
    if (!Array.isArray(rows)) {
      throw importValidationError("Invalid budget storage export", [
        detail(tableName, 0, "", "table rows must be an array")
      ]);
    }
    tables[tableName] = rows.map((row, index) => normalizeRow(tableName, { ...row }, index));
    assertNoDuplicates(tableName, tables[tableName]);
    rowCounts[tableName] = tables[tableName].length;
  }

  return {
    format: payload.format,
    version: payload.version,
    exportedAt: payload.exportedAt || null,
    sourceBackend: payload.sourceBackend || "sqlite",
    targetBackend: payload.targetBackend || "postgres",
    containsSensitiveData: payload.containsSensitiveData !== false,
    budgetSources: Array.isArray(payload.budgetSources) ? payload.budgetSources : [],
    rowCounts,
    tables
  };
}

function convertValue(tableName, column, value) {
  if ((BOOLEAN_COLUMNS[tableName] || new Set()).has(column)) {
    return normalizeBooleanValue(value, tableName, column, 0);
  }
  return value === undefined ? null : value;
}

async function insertRows(client, tableName, rows) {
  let inserted = 0;
  for (const row of rows) {
    const columns = POSTGRES_BUDGET_COLUMNS[tableName]
      .filter(column => Object.prototype.hasOwnProperty.call(row, column));
    if (!columns.length) continue;

    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const sql = `
      INSERT INTO ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(", ")})
      VALUES (${placeholders})
    `;
    await client.query(sql, columns.map(column => convertValue(tableName, column, row[column])));
    inserted += 1;
  }
  return inserted;
}

export async function importSqliteBudgetStorageToPostgres({
  client,
  dryRun = true,
  initializeSchema = true,
  manageTransaction = true,
  payload
} = {}) {
  const normalized = normalizeSqliteBudgetStorageExport(payload);
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      rowCounts: normalized.rowCounts
    };
  }
  if (!client || typeof client.query !== "function") {
    throw new Error("A Postgres client is required when dryRun is false");
  }

  const inserted = {};
  if (manageTransaction) await client.query("BEGIN");
  try {
    if (initializeSchema) {
      await client.query(createPostgresBudgetStorageSchemaSql({ includeTransaction: false }));
    }
    for (const tableName of POSTGRES_BUDGET_TABLES) {
      inserted[tableName] = await insertRows(client, tableName, normalized.tables[tableName]);
    }
    if (manageTransaction) await client.query("COMMIT");
  } catch (error) {
    if (manageTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original import failure.
      }
    }
    throw error;
  }

  return {
    ok: true,
    dryRun: false,
    inserted
  };
}
