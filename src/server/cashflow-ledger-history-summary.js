import { createHash } from "node:crypto";
import { addMoneyAmounts, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import { storedOrComputedConfirmedLedgerAmount } from "./cashflow-ledger-balance-utils.js";

// Derived metadata only: never exported as payments or used to replace originals.
export const LEDGER_SUMMARY_SCHEMA = `CREATE TABLE IF NOT EXISTS cashflow_ledger_summary_cache (
  budget_id TEXT PRIMARY KEY, cache_json TEXT NOT NULL, updated_at TEXT NOT NULL
);`;

/** Hash all retained source facts, excluding recalculable running balances and operational timestamps.
 * A changed fact invalidates the summary even when the row count stays equal. */
export function buildLedgerHistorySummary(rows, cachedJson = null) {
  const facts = rows.map(row => Object.fromEntries(Object.keys(row).sort()
    .filter(key => !["running_balance_pln", "updated_at"].includes(key))
    .map(key => [key, key === "ledger_year" ? Number(row[key]) : row[key]]))).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const fingerprint = createHash("sha256").update(JSON.stringify(facts)).digest("hex");
  const totals = new Map();
  for (const row of rows) {
    const ledgerCurrency = String(row.ledger_currency || "PLN").toUpperCase();
    const summary = totals.get(ledgerCurrency) || { ledgerCurrency, count: 0, incomeTotal: 0, expenseTotal: 0, netAmount: 0 };
    const amount = storedOrComputedConfirmedLedgerAmount(row);
    summary.count += 1;
    const field = row.type === "income" ? "incomeTotal" : "expenseTotal";
    summary[field] = addMoneyAmounts(summary[field], amount);
    summary.netAmount = subtractMoneyAmounts(summary.incomeTotal, summary.expenseTotal);
    totals.set(ledgerCurrency, summary);
  }
  const summaries = [...totals.values()].sort((a, b) => a.ledgerCurrency.localeCompare(b.ledgerCurrency));
  let cached;
  try { cached = JSON.parse(cachedJson); } catch { /* Corrupt derived metadata is rebuilt from retained facts. */ }
  const cache = { version: 1, fingerprint, summaries };
  return { cache, summaries, needsCompaction: rows.length > 0 && JSON.stringify(cached) !== JSON.stringify(cache) };
}
