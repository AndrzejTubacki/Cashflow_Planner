import {
  SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
  SQLITE_BUDGET_STORAGE_EXPORT_VERSION,
  normalizeSqliteBudgetStorageExport
} from "./cashflow-postgres-budget-import.js";
import {
  POSTGRES_BUDGET_LEDGER_TABLES,
  POSTGRES_BUDGET_PLANNING_TABLES,
  POSTGRES_BUDGET_TABLES
} from "./cashflow-postgres-budget-schema.js";

function emptyCounts() {
  return Object.fromEntries(POSTGRES_BUDGET_TABLES.map(tableName => [tableName, 0]));
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
}

function rowCountsForTables(tables) {
  return Object.fromEntries(POSTGRES_BUDGET_TABLES.map(tableName => [
    tableName,
    tables[tableName]?.length || 0
  ]));
}

export function createBudgetStorePayloadFromFullExport({
  budgetId,
  exportData,
  includeSettings = true,
  sourceBackend = "cashflow-full-export"
} = {}) {
  const normalizedBudgetId = String(budgetId || "").trim();
  if (!normalizedBudgetId) {
    throw new Error("A target budgetId is required");
  }
  assertPlainObject(exportData, "A Cashflow full export is required");
  assertPlainObject(exportData.planning, "Cashflow full export is missing planning data");
  assertPlainObject(exportData.ledgers, "Cashflow full export is missing ledger data");

  const tables = Object.fromEntries(POSTGRES_BUDGET_TABLES.map(tableName => [tableName, []]));

  for (const tableName of POSTGRES_BUDGET_PLANNING_TABLES) {
    if (tableName === "settings" && !includeSettings) {
      tables[tableName] = [];
      continue;
    }
    const rows = exportData.planning[tableName] || [];
    if (!Array.isArray(rows)) {
      throw new Error(`Cashflow full export planning table must be an array: ${tableName}`);
    }
    tables[tableName] = rows.map(row => ({
      ...row,
      budget_id: normalizedBudgetId
    }));
  }

  const ledgerYears = [];
  for (const [year, rows] of Object.entries(exportData.ledgers)) {
    if (!Array.isArray(rows)) {
      throw new Error(`Cashflow full export ledger year must be an array: ${year}`);
    }
    const ledgerYear = Number(year);
    if (!Number.isInteger(ledgerYear)) {
      throw new Error(`Cashflow full export ledger year is invalid: ${year}`);
    }
    ledgerYears.push(ledgerYear);
    tables.confirmed_transactions.push(...rows.map(row => ({
      ...row,
      budget_id: normalizedBudgetId,
      ledger_year: ledgerYear
    })));
  }

  ledgerYears.sort((a, b) => a - b);

  return {
    budgetCount: 1,
    budgetSources: [{
      budgetId: normalizedBudgetId,
      ledgerYears,
      sourceBackend
    }],
    containsSensitiveData: true,
    exportedAt: exportData.exportedAt || null,
    format: SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
    rowCounts: rowCountsForTables(tables),
    sourceBackend,
    targetBackend: "postgres",
    tables,
    version: SQLITE_BUDGET_STORAGE_EXPORT_VERSION
  };
}

export function createBudgetStoreImportPlanFromFullExport(options = {}) {
  return createBudgetStoreImportPlan(createBudgetStorePayloadFromFullExport(options), {
    includeEmptyReplaceBatches: Boolean(options.includeEmptyReplaceBatches)
  });
}

function ensureBudgetPlan(plansByBudget, budgetId) {
  if (!plansByBudget.has(budgetId)) {
    plansByBudget.set(budgetId, {
      budgetId,
      confirmedLedgers: {},
      planningTables: Object.fromEntries(
        POSTGRES_BUDGET_PLANNING_TABLES.map(tableName => [tableName, []])
      ),
      rowCounts: emptyCounts()
    });
  }
  return plansByBudget.get(budgetId);
}

export function createBudgetStoreImportPlan(payload, options = {}) {
  const includeEmptyReplaceBatches = Boolean(options.includeEmptyReplaceBatches);
  const normalized = normalizeSqliteBudgetStorageExport(payload);
  const plansByBudget = new Map();

  for (const tableName of POSTGRES_BUDGET_PLANNING_TABLES) {
    for (const row of normalized.tables[tableName] || []) {
      const budgetPlan = ensureBudgetPlan(plansByBudget, row.budget_id);
      budgetPlan.planningTables[tableName].push({ ...row });
      budgetPlan.rowCounts[tableName] += 1;
    }
  }

  for (const tableName of POSTGRES_BUDGET_LEDGER_TABLES) {
    if (tableName !== "confirmed_transactions") continue;
    for (const row of normalized.tables[tableName] || []) {
      const budgetPlan = ensureBudgetPlan(plansByBudget, row.budget_id);
      const ledgerYear = Number(row.ledger_year);
      const ledgerKey = String(ledgerYear);
      if (!budgetPlan.confirmedLedgers[ledgerKey]) {
        budgetPlan.confirmedLedgers[ledgerKey] = [];
      }
      budgetPlan.confirmedLedgers[ledgerKey].push({ ...row });
      budgetPlan.rowCounts[tableName] += 1;
    }
  }

  const budgetPlans = [...plansByBudget.values()]
    .sort((a, b) => a.budgetId.localeCompare(b.budgetId))
    .map(plan => ({
      ...plan,
      confirmedLedgers: Object.fromEntries(
        Object.entries(plan.confirmedLedgers)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([year, rows]) => [year, rows])
      )
    }));

  const writeBatches = [];
  for (const plan of budgetPlans) {
    for (const tableName of POSTGRES_BUDGET_PLANNING_TABLES) {
      const rows = plan.planningTables[tableName];
      if (rows.length || includeEmptyReplaceBatches) {
        writeBatches.push({
          budgetId: plan.budgetId,
          rows,
          tableName,
          type: "planning"
        });
      }
    }

    for (const [year, rows] of Object.entries(plan.confirmedLedgers)) {
      if (rows.length) {
        writeBatches.push({
          budgetId: plan.budgetId,
          ledgerYear: Number(year),
          rows,
          tableName: "confirmed_transactions",
          type: "ledger"
        });
      }
    }
  }

  return {
    budgetCount: budgetPlans.length,
    budgetIds: budgetPlans.map(plan => plan.budgetId),
    budgetPlans,
    containsSensitiveData: normalized.containsSensitiveData,
    exportedAt: normalized.exportedAt,
    format: normalized.format,
    rowCounts: normalized.rowCounts,
    sourceBackend: normalized.sourceBackend,
    targetBackend: normalized.targetBackend,
    version: normalized.version,
    writeBatches
  };
}

function assertBudgetStoreWriter(budgetStore) {
  if (!budgetStore || typeof budgetStore !== "object") {
    throw new Error("A budget-store writer is required");
  }
  if (typeof budgetStore.insertPlanningRows !== "function") {
    throw new Error("Budget-store writer must implement insertPlanningRows");
  }
  if (typeof budgetStore.insertConfirmedTransactions !== "function") {
    throw new Error("Budget-store writer must implement insertConfirmedTransactions");
  }
}

function assertBudgetStoreReplacer(budgetStore) {
  assertBudgetStoreWriter(budgetStore);
  if (typeof budgetStore.replacePlanningRows !== "function") {
    throw new Error("Budget-store writer must implement replacePlanningRows for replace mode");
  }
  if (typeof budgetStore.replaceConfirmedTransactionsForYear !== "function") {
    throw new Error("Budget-store writer must implement replaceConfirmedTransactionsForYear for replace mode");
  }
}

export async function applyBudgetStoreImportPlan({
  budgetStore,
  mode = "append",
  onBatch = () => {},
  plan,
  payload
} = {}) {
  const normalizedMode = String(mode || "append").trim().toLowerCase();
  if (!["append", "replace"].includes(normalizedMode)) {
    throw new Error("Budget-store import mode must be append or replace");
  }
  if (normalizedMode === "replace") {
    assertBudgetStoreReplacer(budgetStore);
  } else {
    assertBudgetStoreWriter(budgetStore);
  }
  const importPlan = plan || createBudgetStoreImportPlan(payload);
  if (!importPlan || !Array.isArray(importPlan.writeBatches)) {
    throw new Error("A budget-store import plan or payload is required");
  }

  const applyWithWriter = async writer => {
    const appliedBatches = [];
    for (const batch of importPlan.writeBatches) {
      await onBatch({
        budgetId: batch.budgetId,
        ledgerYear: batch.ledgerYear || null,
        rows: batch.rows.length,
        tableName: batch.tableName,
        type: batch.type
      });

      const result = batch.type === "planning"
        ? normalizedMode === "replace"
          ? await writer.replacePlanningRows(batch.budgetId, batch.tableName, batch.rows)
          : await writer.insertPlanningRows(batch.budgetId, batch.tableName, batch.rows)
        : normalizedMode === "replace"
          ? await writer.replaceConfirmedTransactionsForYear(batch.budgetId, batch.ledgerYear, batch.rows)
          : await writer.insertConfirmedTransactions(batch.budgetId, batch.rows);
      appliedBatches.push({
        budgetId: batch.budgetId,
        ledgerYear: batch.ledgerYear || null,
        mode: normalizedMode,
        result: { ...(result || {}) },
        rows: batch.rows.length,
        tableName: batch.tableName,
        type: batch.type
      });
    }

    return appliedBatches;
  };

  const appliedBatches = typeof budgetStore.transaction === "function"
    ? await budgetStore.transaction(applyWithWriter)
    : await applyWithWriter(budgetStore);

  return {
    appliedBatches,
    budgetCount: importPlan.budgetCount,
    budgetIds: [...importPlan.budgetIds],
    mode: normalizedMode,
    ok: true,
    rowCounts: { ...importPlan.rowCounts },
    writeBatchCount: importPlan.writeBatches.length
  };
}
