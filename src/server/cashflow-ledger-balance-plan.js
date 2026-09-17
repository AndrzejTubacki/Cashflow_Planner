import {
  confirmedRowsWithRunningBalances,
  latestBalanceFromConfirmedRows
} from "./cashflow-ledger-balance-utils.js";

function normalizeLedgerCurrency(value) {
  return String(value || "PLN").trim().toUpperCase() || "PLN";
}

function rowLedgerCurrency(row = {}) {
  return normalizeLedgerCurrency(row.ledger_currency || "PLN");
}

export async function createLedgerRunningBalancePlan({
  budgetId,
  budgetStore,
  ledgerCurrency = null,
  openingBalance = 0
} = {}) {
  if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
    throw new Error("A budget store with listConfirmedTransactions() is required");
  }
  if (!budgetId) {
    throw new Error("budgetId is required");
  }

  let targetLedgerCurrency = ledgerCurrency ? normalizeLedgerCurrency(ledgerCurrency) : null;
  if (!targetLedgerCurrency && typeof budgetStore.listPlanningRows === "function") {
    const settings = await budgetStore.listPlanningRows(budgetId, "settings");
    targetLedgerCurrency = normalizeLedgerCurrency(settings?.[0]?.ledger_currency || "PLN");
  }
  targetLedgerCurrency ||= "PLN";

  const rows = (await budgetStore.listConfirmedTransactions(budgetId))
    .filter(row => rowLedgerCurrency(row) === targetLedgerCurrency);
  const rowsWithBalances = confirmedRowsWithRunningBalances(rows, { openingBalance });

  return {
    budgetId,
    ledgerCurrency: targetLedgerCurrency,
    latestBalance: latestBalanceFromConfirmedRows(rowsWithBalances, { openingBalance }),
    updates: rowsWithBalances.map(row => ({
      id: row.id,
      ledgerAmount: row.ledger_amount,
      ledgerYear: row.ledger_year,
      runningBalance: row.running_balance_pln
    }))
  };
}

export async function applyLedgerRunningBalancePlan({
  budgetStore,
  plan
} = {}) {
  if (!budgetStore || typeof budgetStore.updateConfirmedLedgerBalances !== "function") {
    throw new Error("A budget store with updateConfirmedLedgerBalances() is required");
  }
  if (!plan?.budgetId || !Array.isArray(plan.updates)) {
    throw new Error("A ledger running-balance plan is required");
  }

  const result = await budgetStore.updateConfirmedLedgerBalances(plan.budgetId, plan.updates);
  return {
    budgetId: plan.budgetId,
    ledgerCurrency: plan.ledgerCurrency,
    latestBalance: plan.latestBalance,
    ok: true,
    updated: Number(result?.updated || 0)
  };
}
