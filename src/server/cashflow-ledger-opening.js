import { readSqliteFinancialExportAudit } from './cashflow-ledger-audit-export.js';

/** Read verified, currency-scoped proof without consulting a cached balance.
 * Real stores expose this on both root and owning transaction readers. Legacy
 * facade-only adapters have no origin capability and retain a zero opening. */
export async function budgetLedgerOpeningBalance(store, budgetId, ledgerCurrency) {
  if (typeof store?.ledgerOpeningBalance === 'function') return store.ledgerOpeningBalance(budgetId, ledgerCurrency);
  if (store?.supportsStandaloneOrigins) throw new Error('Origin-aware ledger opening reader is required');
  return 0;
}

/** Synchronous legacy hosts use their existing planning connection. The raw
 * audit reader verifies proof/index/history and refuses unsupported origins;
 * it does not compare temporarily unrecorded new confirmation rows. */
export function sqliteLedgerOpeningBalance(db, budgetId, ledgerCurrency, { allowStandaloneOrigins = false } = {}) {
  const audit = readSqliteFinancialExportAudit(db, budgetId, { allowStandaloneOrigins });
  return audit?.origin?.ledgerCurrency === ledgerCurrency ? audit.origin.openingBalance : 0;
}

/** First-run setup (browser and device) stages the declared opening for review.
 * A currency switch carries only these system rows into its replacement pending
 * conversion; ordinary pending income is never part of the opening balance. */
export function firstRunOpeningRows(rows, ledgerCurrency) {
  return rows.filter(row => row.pending_origin === 'system'
    && String(row.occurrence_key || '').startsWith('first_run_opening_balance:')
    && row.ledger_currency === ledgerCurrency);
}
