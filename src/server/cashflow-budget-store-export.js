import {
  POSTGRES_BUDGET_LEDGER_TABLES,
  POSTGRES_BUDGET_PLANNING_TABLES,
  POSTGRES_BUDGET_TABLES,
  POSTGRES_LEDGER_SCHEMA_VERSION,
  POSTGRES_PLANNING_SCHEMA_VERSION
} from "./cashflow-postgres-budget-schema.js";
import {
  SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
  SQLITE_BUDGET_STORAGE_EXPORT_VERSION
} from "./cashflow-postgres-budget-import.js";

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function assertBudgetStore(store) {
  if (!store || typeof store.listPlanningRows !== "function" || typeof store.listConfirmedTransactions !== "function") {
    throw new Error("A budget store with listPlanningRows() and listConfirmedTransactions() is required");
  }
}

function emptyTables() {
  return Object.fromEntries(POSTGRES_BUDGET_TABLES.map(table => [table, []]));
}

function addRows(target, table, rows) {
  target[table].push(...(rows || []).map(row => ({ ...row })));
}

function rowCountsForTables(tables) {
  return Object.fromEntries(POSTGRES_BUDGET_TABLES.map(table => [
    table,
    tables[table]?.length || 0
  ]));
}

export async function createBudgetStoreExport({
  budgetIds,
  budgetStore,
  now = new Date()
} = {}) {
  assertBudgetStore(budgetStore);
  const ids = [...new Set((budgetIds || []).map(id => String(id || "").trim()).filter(Boolean))].sort();
  if (!ids.length) {
    throw new Error("At least one budgetId is required");
  }

  const tables = emptyTables();
  const budgetSources = [];

  for (const budgetId of ids) {
    const ledgerYears = typeof budgetStore.listLedgerYears === "function"
      ? (await budgetStore.listLedgerYears(budgetId)).map(year => Number(year)).filter(Number.isInteger).sort((a, b) => a - b)
      : [];
    budgetSources.push({
      ledgerYears,
      budgetId,
      sourceBackend: budgetStore.backend || "unknown"
    });

    for (const table of POSTGRES_BUDGET_PLANNING_TABLES) {
      addRows(tables, table, await budgetStore.listPlanningRows(budgetId, table));
    }

    for (const table of POSTGRES_BUDGET_LEDGER_TABLES) {
      if (table !== "confirmed_transactions") continue;
      addRows(tables, table, await budgetStore.listConfirmedTransactions(budgetId));
    }
  }

  return {
    budgetCount: ids.length,
    budgetSources,
    containsSensitiveData: true,
    exportedAt: nowIso(now),
    format: SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
    rowCounts: rowCountsForTables(tables),
    sourceBackend: budgetStore.backend || "unknown",
    targetBackend: "postgres",
    targetLedgerSchemaVersion: POSTGRES_LEDGER_SCHEMA_VERSION,
    targetPlanningSchemaVersion: POSTGRES_PLANNING_SCHEMA_VERSION,
    tables,
    version: SQLITE_BUDGET_STORAGE_EXPORT_VERSION
  };
}
