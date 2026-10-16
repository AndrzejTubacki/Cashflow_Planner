import { addMoneyAmounts, roundMoneyAmount, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import { sortConfirmedRowsForBalance, storedOrComputedConfirmedLedgerAmount } from "./cashflow-ledger-balance-utils.js";

// Display-only: never use these comparators to decide funding or allocations.
export function compareLedgerRowsForDisplay(a = {}, b = {}) {
  return String(a.date || "").localeCompare(String(b.date || ""))
    || Number(b.type === "income") - Number(a.type === "income")
    || String(a.created_at || "").localeCompare(String(b.created_at || ""))
    || String(a.id || "").localeCompare(String(b.id || ""));
}

// Income takes precedence even when same-day rows belong to different periods.
export function compareFutureRowsForDisplay(a = {}, b = {}) {
  return String(a.date || "").localeCompare(String(b.date || ""))
    || Number(b.type === "income") - Number(a.type === "income")
    || String(a.period || "").localeCompare(String(b.period || ""))
    || String(b.type || "").localeCompare(String(a.type || ""))
    || String(a.created_at || "").localeCompare(String(b.created_at || ""))
    || String(a.id || "").localeCompare(String(b.id || ""));
}

// Reorder confirmed presentation without rewriting history or its funding state.
// Preserve implicit opening balances (e.g. compacted history) per currency by
// deriving the opening from the latest stored balance in historical order.
export function confirmedRowsForDisplay(rows = []) {
  const currencies = new Map();
  for (const row of rows) {
    const currency = row.ledger_currency || "PLN";
    if (!currencies.has(currency)) currencies.set(currency, []);
    currencies.get(currency).push(row);
  }
  const displayed = [];
  for (const currencyRows of currencies.values()) {
    let total = 0;
    let opening = 0;
    const signed = row => row.type === "income"
      ? storedOrComputedConfirmedLedgerAmount(row) : -storedOrComputedConfirmedLedgerAmount(row);
    for (const row of sortConfirmedRowsForBalance(currencyRows)) {
      total = addMoneyAmounts(total, signed(row));
      const stored = row.running_balance ?? row.running_balance_pln;
      if (stored !== null && stored !== undefined) opening = subtractMoneyAmounts(stored, total);
    }
    let balance = opening;
    for (const row of [...currencyRows].sort(compareLedgerRowsForDisplay)) {
      balance = addMoneyAmounts(balance, signed(row));
      displayed.push({ ...row, running_balance: roundMoneyAmount(balance) });
    }
  }
  return displayed.sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))
    || compareLedgerRowsForDisplay(a, b));
}