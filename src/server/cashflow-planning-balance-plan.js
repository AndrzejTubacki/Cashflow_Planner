import { DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { todayInTimezone } from "./cashflow-date-utils.js";
import {
  addMoneyAmounts,
  roundMoneyAmount,
  subtractMoneyAmounts
} from "./cashflow-money-utils.js";
import {
  sortConfirmedRowsForBalance,
  storedOrComputedConfirmedLedgerAmount
} from "./cashflow-ledger-balance-utils.js";

function activeLedgerCurrency(settings = {}) {
  return settings?.ledger_currency || "PLN";
}

function rowLedgerCurrency(row = {}) {
  return row?.ledger_currency || "PLN";
}

function confirmedBalanceAsOfRows(rows = [], cutoffDate = null) {
  const eligible = sortConfirmedRowsForBalance(rows)
    .filter(row => !cutoffDate || String(row.date || "") <= cutoffDate);

  if (!eligible.length) return 0;

  const latest = eligible.at(-1);
  if (latest.running_balance_pln !== null && latest.running_balance_pln !== undefined) {
    return roundMoneyAmount(latest.running_balance_pln);
  }

  return roundMoneyAmount(eligible.reduce((balance, row) => {
    const amount = storedOrComputedConfirmedLedgerAmount(row);
    return row.type === "income"
      ? addMoneyAmounts(balance, amount)
      : subtractMoneyAmounts(balance, amount);
  }, 0));
}

function comparePlanningBalanceRows(a = {}, b = {}) {
  const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
  if (dateCompare !== 0) return dateCompare;

  const bucketRanks = {
    confirmed: 0,
    pending: 1,
    future: 2
  };
  const bucketOrder = (bucketRanks[a.bucket] ?? 99) - (bucketRanks[b.bucket] ?? 99);
  if (bucketOrder !== 0) return bucketOrder;

  const createdCompare = String(a.created_at || "").localeCompare(String(b.created_at || ""));
  if (createdCompare !== 0) return createdCompare;

  return String(a.id || "").localeCompare(String(b.id || ""));
}

export function createPlanningRunningBalancePlan({
  confirmedRows = [],
  futureRows = [],
  pendingRows = [],
  settings = {},
  today = null
} = {}) {
  const ledgerCurrency = activeLedgerCurrency(settings);
  const currentDate = today || todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE);
  const activeConfirmedRows = sortConfirmedRowsForBalance(confirmedRows)
    .filter(row => rowLedgerCurrency(row) === ledgerCurrency);
  const updates = [];

  for (const row of pendingRows) {
    if (rowLedgerCurrency(row) !== ledgerCurrency) {
      updates.push({
        bucket: "pending",
        id: row.id,
        running_balance: null
      });
    }
  }

  for (const row of futureRows) {
    if (rowLedgerCurrency(row) !== ledgerCurrency) {
      updates.push({
        bucket: "future",
        id: row.id,
        running_balance: null
      });
    }
  }

  const planningRows = [
    ...activeConfirmedRows
      .filter(row => String(row.date || "") > currentDate)
      .map(row => ({
        bucket: "confirmed",
        created_at: row.created_at,
        date: row.date,
        id: row.id,
        ledger_amount: storedOrComputedConfirmedLedgerAmount(row),
        type: row.type
      })),
    ...pendingRows
      .filter(row => rowLedgerCurrency(row) === ledgerCurrency)
      .map(row => ({
        bucket: "pending",
        created_at: row.created_at,
        date: row.date,
        id: row.id,
        ledger_amount: row.ledger_amount,
        type: row.type
      })),
    ...futureRows
      .filter(row => rowLedgerCurrency(row) === ledgerCurrency)
      .map(row => ({
        bucket: "future",
        created_at: row.created_at,
        date: row.date,
        id: row.id,
        ledger_amount: row.ledger_amount,
        type: row.type
      }))
  ].sort(comparePlanningBalanceRows);

  let balance = confirmedBalanceAsOfRows(activeConfirmedRows, currentDate);

  for (const row of planningRows) {
    const ledgerAmount = roundMoneyAmount(row.ledger_amount);
    balance = row.type === "income"
      ? addMoneyAmounts(balance, ledgerAmount)
      : subtractMoneyAmounts(balance, ledgerAmount);

    if (row.bucket === "confirmed") continue;

    updates.push({
      bucket: row.bucket,
      id: row.id,
      running_balance: roundMoneyAmount(balance)
    });
  }

  return {
    ledgerCurrency,
    today: currentDate,
    updates
  };
}

export async function applyPlanningRunningBalancePlan({
  budgetId,
  budgetStore,
  plan
} = {}) {
  if (!budgetStore || typeof budgetStore.updatePlanningRowsById !== "function") {
    throw new Error("A budget store with updatePlanningRowsById() is required");
  }

  const pendingUpdates = [];
  const futureUpdates = [];
  for (const update of plan?.updates || []) {
    if (!update.id) continue;
    const target = update.bucket === "future" ? futureUpdates : pendingUpdates;
    target.push({
      id: update.id,
      running_balance: update.running_balance
    });
  }

  const result = {
    futureUpdated: 0,
    pendingUpdated: 0
  };

  if (pendingUpdates.length) {
    result.pendingUpdated = (await budgetStore.updatePlanningRowsById(
      budgetId,
      "pending_transactions",
      pendingUpdates
    )).updated;
  }

  if (futureUpdates.length) {
    result.futureUpdated = (await budgetStore.updatePlanningRowsById(
      budgetId,
      "future_transactions",
      futureUpdates
    )).updated;
  }

  return result;
}
