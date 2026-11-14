import { decodeLedgerAuditRecord, decodeStandaloneLedgerOrigin, createNodeLedgerAuditReplay } from './cashflow-ledger-audit-store.js';
import { normalizeBudgetStoreSnapshot } from './cashflow-budget-store-snapshot.js';
import { badRequest } from './cashflow-user-utils.js';

/** Match one complete audit with the financial facts actually being exported.
 * This rejects a concurrent ledger/audit mismatch instead of publishing a file
 * whose correction history cannot later be restored. No state is changed.
 * Origin semantics must be explicitly supported by the calling host. */
export function validateFinancialExportAudit(budgetId, ledgerAudit, ledgers, { allowStandaloneOrigins = false } = {}) {
  const rows = Object.entries(ledgers).flatMap(([year, payments]) => payments.map(row => ({
    ...row, budget_id: budgetId, ledger_year: Number(year)
  })));
  try {
    return normalizeBudgetStoreSnapshot({ format: 'cashflow-budget-store-snapshot', version: 2,
      ledgerAudits: [ledgerAudit], payload: { format: 'cashflow-sqlite-budget-storage-export', version: 1,
        budgetSources: [{ budgetId }], tables: { confirmed_transactions: rows } } }, { allowStandaloneOrigins }).ledgerAudits[0];
  } catch (error) {
    // Snapshot primitives also serve internal backups. At this external file
    // boundary, invalid replay/facts are a client error, never an HTTP 500.
    throw badRequest(`Invalid financial correction history: ${error.message}`);
  }
}

/** Synchronous SQLite exporters preserve the same checked proof/index/history
 * as async stores when their host explicitly supports origins. Older schemas
 * have no audit namespace; export must never seed one merely by reading it. */
export function readSqliteFinancialExportAudit(db, budgetId, { allowStandaloneOrigins = false } = {}) {
  const codec = createNodeLedgerAuditReplay({ allowStandaloneOrigins });
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cashflow_ledger_audit_state'").get();
  if (!exists) return null;
  const state = db.prepare('SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = ?').get(budgetId);
  if (!state) return null;
  // Unupgraded exporters cannot silently omit an origin, especially an empty
  // signed opening with no original index row to expose the mismatch.
  const hasOrigins = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cashflow_ledger_origins'").get();
  const originRow = hasOrigins ? db.prepare('SELECT * FROM cashflow_ledger_origins WHERE budget_id = ?').get(budgetId) : null;
  if ((Number(state.origin_version ?? 0) !== 0 || originRow) && !allowStandaloneOrigins) throw badRequest('Standalone ledger origins need an upgraded export host');
  const origin = decodeStandaloneLedgerOrigin(budgetId, originRow, state.origin_version);
  const originals = db.prepare('SELECT * FROM cashflow_ledger_originals WHERE budget_id = ? ORDER BY sequence_number').all(budgetId)
    .map(row => decodeLedgerAuditRecord(budgetId, row, 'original', origin?.originals.get(row.payment_id) ?? null));
  const ids = new Set(originals.map(item => item.row.id));
  if (origin && [...origin.originals.keys()].some(id => !ids.has(id))) throw badRequest('Standalone original index is missing');
  const snapshot = { version: origin ? 2 : 1, budgetId, baselineComplete: Number(state.baseline_complete) === 1,
    lastSequence: Number(state.last_sequence),
    ...(origin ? { origin: origin.origin } : {}),
    originals: originals.filter(item => item.sequence > (origin?.lastSequence ?? 0)),
    corrections: db.prepare('SELECT * FROM cashflow_ledger_corrections WHERE budget_id = ? ORDER BY sequence_number').all(budgetId)
      .map(row => decodeLedgerAuditRecord(budgetId, row, 'correction')) };
  if (origin) codec.replayLedgerAuditSnapshot(snapshot, budgetId);
  return snapshot;
}
