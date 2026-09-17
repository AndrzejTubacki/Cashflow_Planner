import {
  normalizeSqliteGlobalMetadataExport
} from "./cashflow-postgres-global-import.js";
import {
  POSTGRES_GLOBAL_TABLES
} from "./cashflow-postgres-global-schema.js";

function emptyCounts() {
  return Object.fromEntries(POSTGRES_GLOBAL_TABLES.map(tableName => [tableName, 0]));
}

export function createGlobalStoreImportPlan(payload) {
  const normalized = normalizeSqliteGlobalMetadataExport(payload);
  const writeBatches = [];

  for (const tableName of POSTGRES_GLOBAL_TABLES) {
    const rows = normalized.tables[tableName] || [];
    if (!rows.length) continue;
    writeBatches.push({
      rows,
      tableName
    });
  }

  return {
    containsSensitiveData: true,
    format: normalized.format,
    rowCounts: {
      ...emptyCounts(),
      ...normalized.rowCounts
    },
    sourceBackend: normalized.sourceBackend,
    sourceGlobalSchemaVersion: normalized.sourceGlobalSchemaVersion,
    targetBackend: normalized.targetBackend,
    targetGlobalSchemaVersion: normalized.targetGlobalSchemaVersion,
    version: normalized.version,
    writeBatches
  };
}

function assertGlobalStoreAppender(globalStore) {
  if (!globalStore || typeof globalStore !== "object") {
    throw new Error("A global-store writer is required");
  }
  if (typeof globalStore.insertRows !== "function") {
    throw new Error("Global-store writer must implement insertRows");
  }
}

function assertGlobalStoreReplacer(globalStore) {
  if (!globalStore || typeof globalStore !== "object") {
    throw new Error("A global-store writer is required");
  }
  if (typeof globalStore.replaceAllRows !== "function") {
    throw new Error("Global-store writer must implement replaceAllRows for replace mode");
  }
}

function tablesFromPlan(plan) {
  const tables = Object.fromEntries(POSTGRES_GLOBAL_TABLES.map(tableName => [tableName, []]));
  for (const batch of plan.writeBatches || []) {
    if (!POSTGRES_GLOBAL_TABLES.includes(batch.tableName)) {
      throw new Error(`Unsupported global metadata table: ${batch.tableName}`);
    }
    tables[batch.tableName] = batch.rows.map(row => ({ ...row }));
  }
  return tables;
}

export async function applyGlobalStoreImportPlan({
  globalStore,
  mode = "append",
  onBatch = () => {},
  plan,
  payload
} = {}) {
  const normalizedMode = String(mode || "append").trim().toLowerCase();
  if (!["append", "replace"].includes(normalizedMode)) {
    throw new Error("Global-store import mode must be append or replace");
  }

  const importPlan = plan || createGlobalStoreImportPlan(payload);
  if (!importPlan || !Array.isArray(importPlan.writeBatches)) {
    throw new Error("A global-store import plan or payload is required");
  }

  if (normalizedMode === "replace") {
    assertGlobalStoreReplacer(globalStore);
    for (const batch of importPlan.writeBatches) {
      await onBatch({
        rows: batch.rows.length,
        tableName: batch.tableName
      });
    }
    const result = await globalStore.replaceAllRows(tablesFromPlan(importPlan));
    return {
      appliedBatches: importPlan.writeBatches.map(batch => ({
        mode: normalizedMode,
        rows: batch.rows.length,
        tableName: batch.tableName
      })),
      mode: normalizedMode,
      ok: true,
      result: { ...(result || {}) },
      rowCounts: { ...importPlan.rowCounts },
      writeBatchCount: importPlan.writeBatches.length
    };
  }

  assertGlobalStoreAppender(globalStore);
  const appliedBatches = [];
  for (const batch of importPlan.writeBatches) {
    await onBatch({
      rows: batch.rows.length,
      tableName: batch.tableName
    });
    const result = await globalStore.insertRows(batch.tableName, batch.rows);
    appliedBatches.push({
      mode: normalizedMode,
      result: { ...(result || {}) },
      rows: batch.rows.length,
      tableName: batch.tableName
    });
  }

  return {
    appliedBatches,
    mode: normalizedMode,
    ok: true,
    rowCounts: { ...importPlan.rowCounts },
    writeBatchCount: importPlan.writeBatches.length
  };
}
