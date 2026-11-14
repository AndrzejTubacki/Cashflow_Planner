import { validateStandaloneTransferSource } from './cashflow-standalone-transfer-source.js';
import { standaloneLedgerOrigin, replayStandaloneLedgerOrigin } from '../engine/standalone-ledger-origin.js';
import { oneOffProgressWithOriginals } from '../engine/ledger-audit-progress.js';
import { prepareSnapshot } from '../engine/prepare-snapshot.js';
import { calculateSnapshot } from '../engine/snapshot.js';

/** Project validated local evidence into a new server namespace, without
 * pretending it is a version-1 server audit. This is an internal preparation
 * result, not a portable record, permission, database writer or receipt.
 *
 * Keep the complete validated local proof: its capture dates, old correction
 * policies and retry branches must never be reinterpreted as fresh operations.
 * A signed opening is separate from payments and must be retained by the future
 * origin-aware writer/replayer. A normal server setup payment cannot replace it.
 * Call outside the final publication transaction; preflight replays bounded
 * financial history and calculation can be expensive. */
export function prepareStandaloneTransferOrigin({ sourceJson, budgetId, ...timing }) {
  if (typeof budgetId !== 'string' || !/^budget_[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(budgetId)) {
    throw new Error('Standalone transfer requires a host-reserved destination');
  }
  const source = validateStandaloneTransferSource(sourceJson, timing);
  const proof = source.snapshot;

  const materializedAt = timing.generationTimestamp;
  const replay = replayStandaloneLedgerOrigin({ origin: standaloneLedgerOrigin(proof, materializedAt), budgetId,
    utf8ByteLength: text => Buffer.byteLength(text, 'utf8') });
  const originals = [...replay.originals.values()];
  const confirmedRows = replay.balances;
  const tables = Object.fromEntries(Object.entries(proof.request.tables)
    .map(([table, rows]) => [table, rows.map(row => ({ ...row, budget_id: budgetId }))]));
  const snapshot = prepareSnapshot({ budgetId, revision: 0, settings: structuredClone(source.serverSettings),
    tables, confirmedRows, fxSnapshot: structuredClone(proof.request.fxSnapshot), ...timing,
    ledgerOpeningBalance: replay.opening.ledgerCurrency === proof.request.settings.ledger_currency ? replay.opening.amount : 0 });
  // Empty/fully voided history still has an opening, and voided originals still
  // reserve installment ordinals. Neither can be inferred from effective rows.
  snapshot.request.openingBalance = source.confirmedBalance;
  snapshot.request.oneOffProgress = [...oneOffProgressWithOriginals(confirmedRows, originals)];
  const calculation = calculateSnapshot(snapshot);
  return { version: 1, budgetId, materializedAt, sourceSnapshot: proof, ledgerOrigin: replay.origin,
    opening: replay.opening,
    originals, confirmedRows, snapshot, calculation };
}
