import {
  POSTGRES_GLOBAL_COLUMNS,
  POSTGRES_GLOBAL_TABLES
} from "./cashflow-postgres-global-schema.js";

export function quoteGlobalIdentifier(identifier) {
  const value = String(identifier || "");
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe global metadata identifier: ${value}`);
  }
  return `"${value}"`;
}

export function assertGlobalMetadataTable(tableName) {
  const safeTable = String(tableName || "").trim();
  if (!POSTGRES_GLOBAL_TABLES.includes(safeTable)) {
    throw new Error(`Unsupported global metadata table: ${safeTable}`);
  }
  return safeTable;
}

export function columnsForGlobalRow(tableName, row) {
  const safeTable = assertGlobalMetadataTable(tableName);
  const columns = POSTGRES_GLOBAL_COLUMNS[safeTable]
    .filter(column => Object.prototype.hasOwnProperty.call(row, column));
  if (!columns.length) {
    throw new Error(`Cannot insert empty row into ${safeTable}`);
  }
  return columns;
}

export function normalizeGlobalRowsForInsert(tableName, rows = []) {
  const safeTable = assertGlobalMetadataTable(tableName);
  if (!Array.isArray(rows)) {
    throw new Error(`Global metadata rows for ${safeTable} must be an array`);
  }

  const allowedColumns = new Set(POSTGRES_GLOBAL_COLUMNS[safeTable] || []);
  return {
    rows: rows.map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`Invalid global metadata row for ${safeTable} at index ${index}: row must be an object`);
      }
      for (const column of Object.keys(row)) {
        if (!allowedColumns.has(column)) {
          throw new Error(`Invalid global metadata row for ${safeTable} at index ${index}: unsupported column ${column}`);
        }
      }
      return { ...row };
    }),
    tableName: safeTable
  };
}

export function normalizeGlobalTablesForReplace(tables = {}) {
  if (!tables || typeof tables !== "object" || Array.isArray(tables)) {
    throw new Error("Global metadata replacement tables must be an object");
  }
  for (const tableName of Object.keys(tables)) {
    assertGlobalMetadataTable(tableName);
  }

  return Object.fromEntries(
    POSTGRES_GLOBAL_TABLES.map(tableName => [
      tableName,
      normalizeGlobalRowsForInsert(tableName, tables[tableName] || []).rows
    ])
  );
}
