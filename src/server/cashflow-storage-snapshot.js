import {
  createBudgetStoreSnapshot,
  normalizeBudgetStoreSnapshot,
  restoreBudgetStoreSnapshot
} from "./cashflow-budget-store-snapshot.js";
import {
  createGlobalStoreExport
} from "./cashflow-global-store-export.js";
import {
  applyGlobalStoreImportPlan,
  createGlobalStoreImportPlan
} from "./cashflow-global-store-import-plan.js";
import {
  normalizeSqliteGlobalMetadataExport
} from "./cashflow-postgres-global-import.js";

export const CASHFLOW_STORAGE_SNAPSHOT_FORMAT = "cashflow-storage-backend-snapshot";
export const CASHFLOW_STORAGE_SNAPSHOT_VERSION = 1;

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

export async function createCashflowStorageSnapshot({
  budgetIds,
  budgetStore,
  globalStore,
  now = new Date(),
  reason = "manual"
} = {}) {
  if (!globalStore || typeof globalStore.listRows !== "function") {
    throw new Error("A global store is required");
  }
  if (!budgetStore || typeof budgetStore.listPlanningRows !== "function") {
    throw new Error("A budget store is required");
  }

  const createdAt = nowIso(now);
  const global = await createGlobalStoreExport({
    globalStore,
    now
  });
  const budget = await createBudgetStoreSnapshot({
    budgetIds,
    budgetStore,
    now,
    reason
  });

  return {
    budgetCount: budget.budgetCount,
    budgetIds: [...budget.budgetIds],
    containsSensitiveData: true,
    createdAt,
    format: CASHFLOW_STORAGE_SNAPSHOT_FORMAT,
    global,
    budget,
    reason: String(reason || "manual"),
    version: CASHFLOW_STORAGE_SNAPSHOT_VERSION
  };
}

export function normalizeCashflowStorageSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Storage snapshot must be an object");
  }
  if (snapshot.format !== CASHFLOW_STORAGE_SNAPSHOT_FORMAT) {
    throw new Error("Unsupported storage snapshot format");
  }
  if (snapshot.version !== CASHFLOW_STORAGE_SNAPSHOT_VERSION) {
    throw new Error("Unsupported storage snapshot version");
  }

  const global = normalizeSqliteGlobalMetadataExport(snapshot.global);
  const budget = normalizeBudgetStoreSnapshot(snapshot.budget);
  return {
    budgetCount: budget.budgetCount,
    budgetIds: [...budget.budgetIds],
    containsSensitiveData: true,
    createdAt: snapshot.createdAt || null,
    format: snapshot.format,
    global,
    budget,
    reason: snapshot.reason || "manual",
    version: snapshot.version
  };
}

export async function restoreCashflowStorageSnapshot({
  budgetStore,
  globalStore,
  includeExistingLedgerYears = true,
  onBatch = () => {},
  snapshot
} = {}) {
  const normalized = normalizeCashflowStorageSnapshot(snapshot);

  const globalPlan = createGlobalStoreImportPlan(normalized.global);
  await onBatch({
    rows: Object.values(globalPlan.rowCounts).reduce((sum, count) => sum + Number(count || 0), 0),
    scope: "global",
    tableName: null,
    type: "replace"
  });
  const globalResult = await applyGlobalStoreImportPlan({
    globalStore,
    mode: "replace",
    plan: globalPlan,
    onBatch: batch => onBatch({
      ...batch,
      scope: "global",
      type: "table"
    })
  });

  const budgetResult = await restoreBudgetStoreSnapshot({
    budgetStore,
    includeExistingLedgerYears,
    snapshot: normalized.budget,
    onBatch: batch => onBatch({
      ...batch,
      scope: "budget"
    })
  });

  return {
    budgetCount: normalized.budgetCount,
    budgetIds: [...normalized.budgetIds],
    global: {
      rowCounts: { ...globalResult.rowCounts },
      writeBatchCount: globalResult.writeBatchCount
    },
    budget: {
      budgetCount: budgetResult.budgetCount,
      budgetIds: [...budgetResult.budgetIds],
      writeBatchCount: budgetResult.writeBatchCount
    },
    ok: true,
    restoredAt: nowIso(new Date()),
    sourceCreatedAt: normalized.createdAt
  };
}
