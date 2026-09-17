import {
  createPostgresGlobalSchemaSql,
  POSTGRES_GLOBAL_COLUMNS,
  POSTGRES_GLOBAL_SCHEMA_VERSION,
  POSTGRES_GLOBAL_TABLES
} from "./cashflow-postgres-global-schema.js";

export const SQLITE_GLOBAL_METADATA_EXPORT_FORMAT = "cashflow-sqlite-global-metadata-export";
export const SQLITE_GLOBAL_METADATA_EXPORT_VERSION = 1;

const JSON_COLUMNS = new Set([
  "permissions",
  "profile_json",
  "config_json",
  "external_config_json",
  "draft_config_json",
  "details_json"
]);

const BOOLEAN_COLUMNS = new Map([
  ["auth_identities.email_verified", "email_verified"],
  ["auth_providers.enabled", "enabled"]
]);

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
}

function quoteIdentifier(identifier) {
  const value = String(identifier || "");
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function normalizeJsonValue(value, {
  table,
  column,
  rowIndex
}) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      JSON.parse(value);
    } catch {
      throw new Error(`${table}[${rowIndex}].${column} must contain valid JSON`);
    }
    return value;
  }
  return JSON.stringify(value);
}

function normalizeBooleanValue(value, {
  table,
  column,
  rowIndex
}) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return Boolean(value);
  throw new Error(`${table}[${rowIndex}].${column} must be boolean-compatible`);
}

function normalizeRowValue(table, column, value, rowIndex) {
  if (JSON_COLUMNS.has(column)) {
    return normalizeJsonValue(value, { table, column, rowIndex });
  }
  if (BOOLEAN_COLUMNS.has(`${table}.${column}`)) {
    return normalizeBooleanValue(value, { table, column, rowIndex });
  }
  return value === undefined ? null : value;
}

function normalizeRowsForTable(table, rows) {
  if (!Array.isArray(rows)) {
    throw new Error(`Export table ${table} must be an array`);
  }

  const allowed = new Set(POSTGRES_GLOBAL_COLUMNS[table] || []);
  return rows.map((row, rowIndex) => {
    assertPlainObject(row, `Export table ${table} row ${rowIndex} must be an object`);
    const normalized = {};

    for (const column of Object.keys(row)) {
      if (!allowed.has(column)) {
        throw new Error(`Export table ${table} row ${rowIndex} contains unknown column ${column}`);
      }
      normalized[column] = normalizeRowValue(table, column, row[column], rowIndex);
    }

    return normalized;
  });
}

export function normalizeSqliteGlobalMetadataExport(payload) {
  assertPlainObject(payload, "Global metadata export must be a JSON object");
  if (payload.format !== SQLITE_GLOBAL_METADATA_EXPORT_FORMAT) {
    throw new Error(`Unsupported global metadata export format: ${payload.format || "missing"}`);
  }
  if (Number(payload.version) !== SQLITE_GLOBAL_METADATA_EXPORT_VERSION) {
    throw new Error(`Unsupported global metadata export version: ${payload.version || "missing"}`);
  }
  if (payload.targetBackend && payload.targetBackend !== "postgres") {
    throw new Error(`Unsupported global metadata export target: ${payload.targetBackend}`);
  }
  assertPlainObject(payload.tables, "Global metadata export tables must be an object");

  const allowedTables = new Set(POSTGRES_GLOBAL_TABLES);
  for (const table of Object.keys(payload.tables)) {
    if (!allowedTables.has(table)) {
      throw new Error(`Global metadata export contains unknown table ${table}`);
    }
  }

  const tables = {};
  const rowCounts = {};
  for (const table of POSTGRES_GLOBAL_TABLES) {
    const rows = normalizeRowsForTable(table, payload.tables[table] || []);
    tables[table] = rows;
    rowCounts[table] = rows.length;
  }

  return {
    format: payload.format,
    version: SQLITE_GLOBAL_METADATA_EXPORT_VERSION,
    sourceBackend: payload.sourceBackend || "sqlite",
    targetBackend: "postgres",
    sourceGlobalSchemaVersion: Number(payload.sourceGlobalSchemaVersion || 0),
    targetGlobalSchemaVersion: POSTGRES_GLOBAL_SCHEMA_VERSION,
    tables,
    rowCounts
  };
}

function columnsForRows(table, rows) {
  const orderedColumns = POSTGRES_GLOBAL_COLUMNS[table] || [];
  const present = new Set();
  for (const row of rows) {
    Object.keys(row).forEach(column => present.add(column));
  }
  return orderedColumns.filter(column => present.has(column));
}

function insertSql(table, columns) {
  const columnList = columns.map(quoteIdentifier).join(", ");
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  return `INSERT INTO ${quoteIdentifier(table)} (${columnList}) VALUES (${placeholders})`;
}

async function insertTableRows(client, table, rows) {
  if (!rows.length) return 0;
  const columns = columnsForRows(table, rows);
  if (!columns.length) return 0;
  const sql = insertSql(table, columns);

  for (const row of rows) {
    await client.query(sql, columns.map(column => row[column] ?? null));
  }

  return rows.length;
}

export async function importSqliteGlobalMetadataToPostgres({
  client,
  dryRun = true,
  initializeSchema = true,
  manageTransaction = true,
  payload
} = {}) {
  const normalized = normalizeSqliteGlobalMetadataExport(payload);
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      targetBackend: "postgres",
      targetGlobalSchemaVersion: POSTGRES_GLOBAL_SCHEMA_VERSION,
      rowCounts: normalized.rowCounts
    };
  }
  if (!client || typeof client.query !== "function") {
    throw new Error("A Postgres client with query() is required when dryRun is false");
  }

  const inserted = {};
  if (manageTransaction) await client.query("BEGIN");
  try {
    if (initializeSchema) {
      await client.query(createPostgresGlobalSchemaSql({ includeTransaction: false }));
    }
    if (normalized.tables.global_options.length) {
      await client.query("DELETE FROM global_options WHERE id = 1");
    }
    if (normalized.tables.auth_config.length) {
      await client.query("DELETE FROM auth_config WHERE id = 1");
    }
    for (const table of POSTGRES_GLOBAL_TABLES) {
      inserted[table] = await insertTableRows(client, table, normalized.tables[table]);
    }
    if (manageTransaction) await client.query("COMMIT");
  } catch (error) {
    if (manageTransaction) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  }

  return {
    ok: true,
    dryRun: false,
    targetBackend: "postgres",
    targetGlobalSchemaVersion: POSTGRES_GLOBAL_SCHEMA_VERSION,
    inserted
  };
}
