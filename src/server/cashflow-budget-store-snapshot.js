import { createBudgetStoreExport } from "./cashflow-budget-store-export.js";
import {
  normalizeSqliteBudgetStorageExport
} from "./cashflow-postgres-budget-import.js";
import {
  POSTGRES_BUDGET_PLANNING_TABLES
} from "./cashflow-postgres-budget-schema.js";

export const BUDGET_STORE_SNAPSHOT_FORMAT = "cashflow-budget-store-snapshot";
export const BUDGET_STORE_SNAPSHOT_VERSION = 1;

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function assertSnapshotWriter(budgetStore) {
  if (!budgetStore || typeof budgetStore !== "object") {
    throw new Error("A budget-store writer is required");
  }
  if (typeof budgetStore.replacePlanningRows !== "function") {
    throw new Error("Budget-store writer must implement replacePlanningRows");
  }
  if (typeof budgetStore.replaceConfirmedTransactionsForYear !== "function") {
    throw new Error("Budget-store writer must implement replaceConfirmedTransactionsForYear");
  }
}

function budgetIdsFromExport(exportPayload) {
  const ids = new Set();
  for (const source of exportPayload.budgetSources || []) {
    if (source?.budgetId) ids.add(String(source.budgetId));
  }
  for (const row of exportPayload.tables?.settings || []) {
    if (row?.budget_id) ids.add(String(row.budget_id));
  }
  return [...ids].sort();
}

function sourceLedgerYearsForBudget(exportPayload, budgetId) {
  const source = (exportPayload.budgetSources || [])
    .find(item => String(item?.budgetId || "") === budgetId);
  const directYears = Array.isArray(source?.ledgerYears)
    ? source.ledgerYears
    : [];
  const schemaYears = Array.isArray(source?.ledgerSchemaVersions)
    ? source.ledgerSchemaVersions.map(item => item?.year)
    : [];
  return [...new Set([...directYears, ...schemaYears]
    .map(year => Number(year))
    .filter(Number.isInteger))]
    .sort((a, b) => a - b);
}

function rowsForBudget(exportPayload, tableName, budgetId) {
  return (exportPayload.tables?.[tableName] || [])
    .filter(row => String(row.budget_id || "") === budgetId)
    .map(row => ({ ...row }));
}

function confirmedRowsForBudgetYear(exportPayload, budgetId, ledgerYear) {
  return rowsForBudget(exportPayload, "confirmed_transactions", budgetId)
    .filter(row => Number(row.ledger_year) === Number(ledgerYear));
}

function ledgerYearsFromRows(exportPayload, budgetId) {
  return [...new Set(rowsForBudget(exportPayload, "confirmed_transactions", budgetId)
    .map(row => Number(row.ledger_year))
    .filter(Number.isInteger))]
    .sort((a, b) => a - b);
}

export async function createBudgetStoreSnapshot({
  budgetIds,
  budgetStore,
  now = new Date(),
  reason = "manual"
} = {}) {
  const payload = await createBudgetStoreExport({
    budgetIds,
    budgetStore,
    now
  });

  return {
    budgetCount: payload.budgetCount,
    budgetIds: budgetIdsFromExport(payload),
    containsSensitiveData: true,
    createdAt: nowIso(now),
    format: BUDGET_STORE_SNAPSHOT_FORMAT,
    payload,
    reason: String(reason || "manual"),
    version: BUDGET_STORE_SNAPSHOT_VERSION
  };
}

export function normalizeBudgetStoreSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Budget-store snapshot must be an object");
  }
  if (snapshot.format !== BUDGET_STORE_SNAPSHOT_FORMAT) {
    throw new Error("Unsupported budget-store snapshot format");
  }
  if (snapshot.version !== BUDGET_STORE_SNAPSHOT_VERSION) {
    throw new Error("Unsupported budget-store snapshot version");
  }

  const payload = normalizeSqliteBudgetStorageExport(snapshot.payload);
  return {
    budgetCount: payload.budgetSources?.length || budgetIdsFromExport(payload).length,
    budgetIds: budgetIdsFromExport(payload),
    containsSensitiveData: true,
    createdAt: snapshot.createdAt || null,
    format: snapshot.format,
    payload,
    reason: snapshot.reason || "manual",
    version: snapshot.version
  };
}

export async function restoreBudgetStoreSnapshot({
  budgetStore,
  includeExistingLedgerYears = true,
  onBatch = () => {},
  snapshot
} = {}) {
  assertSnapshotWriter(budgetStore);
  const normalized = normalizeBudgetStoreSnapshot(snapshot);
  const payload = normalized.payload;

  const restoreWithWriter = async writer => {
    const appliedBatches = [];

    for (const budgetId of normalized.budgetIds) {
      for (const tableName of POSTGRES_BUDGET_PLANNING_TABLES) {
        const rows = rowsForBudget(payload, tableName, budgetId);
        await onBatch({
          budgetId,
          ledgerYear: null,
          rows: rows.length,
          tableName,
          type: "planning"
        });
        const result = await writer.replacePlanningRows(budgetId, tableName, rows);
        appliedBatches.push({
          budgetId,
          ledgerYear: null,
          result: { ...(result || {}) },
          rows: rows.length,
          tableName,
          type: "planning"
        });
      }

      const sourceYears = new Set([
        ...sourceLedgerYearsForBudget(payload, budgetId),
        ...ledgerYearsFromRows(payload, budgetId)
      ]);
      if (includeExistingLedgerYears && typeof writer.listLedgerYears === "function") {
        for (const year of await writer.listLedgerYears(budgetId)) {
          const normalizedYear = Number(year);
          if (Number.isInteger(normalizedYear)) sourceYears.add(normalizedYear);
        }
      }

      for (const ledgerYear of [...sourceYears].sort((a, b) => a - b)) {
        const rows = confirmedRowsForBudgetYear(payload, budgetId, ledgerYear);
        await onBatch({
          budgetId,
          ledgerYear,
          rows: rows.length,
          tableName: "confirmed_transactions",
          type: "ledger"
        });
        const result = await writer.replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows);
        appliedBatches.push({
          budgetId,
          ledgerYear,
          result: { ...(result || {}) },
          rows: rows.length,
          tableName: "confirmed_transactions",
          type: "ledger"
        });
      }
    }

    return appliedBatches;
  };

  const appliedBatches = typeof budgetStore.transaction === "function"
    ? await budgetStore.transaction(restoreWithWriter)
    : await restoreWithWriter(budgetStore);

  return {
    appliedBatches,
    budgetCount: normalized.budgetCount,
    budgetIds: [...normalized.budgetIds],
    ok: true,
    restoredAt: nowIso(new Date()),
    sourceCreatedAt: normalized.createdAt,
    writeBatchCount: appliedBatches.length
  };
}
