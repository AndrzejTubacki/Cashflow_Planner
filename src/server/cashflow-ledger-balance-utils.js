import {
  addMoneyAmounts,
  multiplyMoney,
  roundMoneyAmount,
  subtractMoneyAmounts
} from "./cashflow-money-utils.js";

function dateOnlySortKey(value) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return String(value || "").slice(0, 10);
}

function timestampSortKey(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || "");
}

export function computedConfirmedLedgerAmount(row = {}) {
  return multiplyMoney(row.amount, row.buffered_fx_rate || row.fx_rate || 1);
}

export function storedOrComputedConfirmedLedgerAmount(row = {}) {
  if (row.ledger_amount !== null && row.ledger_amount !== undefined) {
    return roundMoneyAmount(row.ledger_amount);
  }

  return computedConfirmedLedgerAmount(row);
}

export function compareConfirmedRowsForBalance(a = {}, b = {}) {
  const dateCompare = dateOnlySortKey(a.date).localeCompare(dateOnlySortKey(b.date));
  if (dateCompare !== 0) return dateCompare;

  const createdCompare = timestampSortKey(a.created_at).localeCompare(timestampSortKey(b.created_at));
  if (createdCompare !== 0) return createdCompare;

  return String(a.id || "").localeCompare(String(b.id || ""));
}

export function sortConfirmedRowsForBalance(rows = []) {
  return [...rows].sort(compareConfirmedRowsForBalance);
}

export function confirmedRowsWithRunningBalances(rows = [], {
  openingBalance = 0
} = {}) {
  let balance = roundMoneyAmount(openingBalance);

  return sortConfirmedRowsForBalance(rows).map(row => {
    const ledgerAmount = computedConfirmedLedgerAmount(row);
    balance = row.type === "income"
      ? addMoneyAmounts(balance, ledgerAmount)
      : subtractMoneyAmounts(balance, ledgerAmount);

    return {
      ...row,
      ledger_amount: ledgerAmount,
      running_balance_pln: roundMoneyAmount(balance)
    };
  });
}

export function wouldConfirmedRowsGoNegative(rows = [], {
  openingBalance = 0
} = {}) {
  for (const row of confirmedRowsWithRunningBalances(rows, { openingBalance })) {
    if (row.running_balance_pln < -0.005) return true;
  }

  return false;
}

export function latestBalanceFromConfirmedRows(rows = [], {
  openingBalance = 0
} = {}) {
  const sorted = sortConfirmedRowsForBalance(rows);
  if (!sorted.length) return roundMoneyAmount(openingBalance);

  const last = sorted[sorted.length - 1];
  if (last.running_balance_pln !== null && last.running_balance_pln !== undefined) {
    return roundMoneyAmount(last.running_balance_pln);
  }

  const withBalances = confirmedRowsWithRunningBalances(sorted, { openingBalance });
  return roundMoneyAmount(withBalances.at(-1)?.running_balance_pln ?? openingBalance);
}
