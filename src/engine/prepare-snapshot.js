import { addMoneyAmounts } from "./cashflow-money-utils.js";
import { latestBalanceFromConfirmedRows, sortConfirmedRowsForBalance, storedOrComputedConfirmedLedgerAmount } from "./cashflow-ledger-balance-utils.js";
import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";
import { ENGINE_PROTOCOL_VERSION } from "./index.js";
import { SNAPSHOT_VERSION } from "./snapshot.js";

/** Prepare explicit aggregates from complete normalized history, never from a UI page.
 * The owning host may supply a verified offset in the selected ledger currency. */
export function prepareSnapshot({ budgetId, revision, settings, tables, confirmedRows,
  fxSnapshot, today, generationTimestamp, idSeed, ledgerOpeningBalance = 0 }) {
  if (!Array.isArray(confirmedRows)) throw new Error("Complete confirmedRows are required");
  // PostgreSQL drivers can return Date objects and native JSON values. Normalize
  // storage types before handing data to the plain-JSON calculation boundary.
  function normalized(row) {
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      value instanceof Date
        ? (["date", "confirmed_date"].includes(key)
          ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
          : value.toISOString())
        : key === "fx_rates_used" && value && typeof value === "object" ? JSON.stringify(value) : value]));
  }
  settings = normalized(settings);
  tables = Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, rows.map(normalized)]));
  confirmedRows = confirmedRows.map(normalized);
  const ledgerCurrency = settings.ledger_currency || "PLN";
  const rows = sortConfirmedRowsForBalance(confirmedRows);
  const current = rows.filter(row => (row.ledger_currency || "PLN") === ledgerCurrency);
  const goal = new Map();
  const flex = new Map();
  const progress = new Map();
  for (const row of rows) {
    if (row.source_one_off_id) {
      const currency = String(row.currency || "").toUpperCase();
      const key = `${row.source_one_off_id}:${row.type}:${currency}`;
      const value = progress.get(key) || { sourceId: row.source_one_off_id, type: row.type,
        currency, confirmedAmount: 0, confirmedCount: 0 };
      value.confirmedAmount = addMoneyAmounts(value.confirmedAmount, row.amount);
      value.confirmedCount++;
      progress.set(key, value);
    }
    if ((row.ledger_currency || "PLN") !== ledgerCurrency || row.type === "income") continue;
    const amount = storedOrComputedConfirmedLedgerAmount(row);
    if (row.source_goal_id) goal.set(row.source_goal_id, addMoneyAmounts(goal.get(row.source_goal_id) || 0, amount));
    if (row.source_flex_id) flex.set(row.source_flex_id, addMoneyAmounts(flex.get(row.source_flex_id) || 0, amount));
  }
  return {
    snapshotVersion: SNAPSHOT_VERSION, budgetId, revision,
    request: {
      protocolVersion: ENGINE_PROTOCOL_VERSION, today, generationTimestamp, idSeed, settings, tables, fxSnapshot,
      openingBalance: latestBalanceFromConfirmedRows(current.filter(row => String(row.date) <= today), { openingBalance: ledgerOpeningBalance }),
      predictionRows: rows,
      confirmedRowsAfterToday: current.filter(row => String(row.date) > today)
        .map(row => ({ ...row, ledger_amount: storedOrComputedConfirmedLedgerAmount(row) })),
      handledOccurrenceKeys: [...new Set(rows.map(row => row.occurrence_key || occurrenceKeyFromRow(row)).filter(Boolean))],
      oneOffProgress: [...progress], confirmedFunding: { source_goal_id: [...goal], source_flex_id: [...flex] }
    }
  };
}