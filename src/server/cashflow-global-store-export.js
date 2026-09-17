import {
  SQLITE_GLOBAL_METADATA_EXPORT_FORMAT,
  SQLITE_GLOBAL_METADATA_EXPORT_VERSION
} from "./cashflow-postgres-global-import.js";
import {
  POSTGRES_GLOBAL_SCHEMA_VERSION,
  POSTGRES_GLOBAL_TABLES
} from "./cashflow-postgres-global-schema.js";

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function assertGlobalStore(globalStore) {
  if (!globalStore || typeof globalStore.listRows !== "function") {
    throw new Error("A global store with listRows() is required");
  }
}

function rowCountsForTables(tables) {
  return Object.fromEntries(POSTGRES_GLOBAL_TABLES.map(table => [
    table,
    tables[table]?.length || 0
  ]));
}

export async function createGlobalStoreExport({
  globalStore,
  now = new Date()
} = {}) {
  assertGlobalStore(globalStore);
  const ready = typeof globalStore.checkReadiness === "function"
    ? await globalStore.checkReadiness()
    : {};
  const tables = {};

  for (const tableName of POSTGRES_GLOBAL_TABLES) {
    tables[tableName] = (await globalStore.listRows(tableName)).map(row => ({ ...row }));
  }

  return {
    containsSensitiveData: true,
    exportedAt: nowIso(now),
    format: SQLITE_GLOBAL_METADATA_EXPORT_FORMAT,
    rowCounts: rowCountsForTables(tables),
    sourceBackend: globalStore.backend || ready.backend || "unknown",
    sourceGlobalSchemaVersion: Number(ready.globalSchemaVersion || 0),
    tables,
    targetBackend: "postgres",
    targetGlobalSchemaVersion: POSTGRES_GLOBAL_SCHEMA_VERSION,
    version: SQLITE_GLOBAL_METADATA_EXPORT_VERSION
  };
}
