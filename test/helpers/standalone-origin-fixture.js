import { completeSnapshot } from '../engine/fixtures.js';
import { calculateSnapshot } from '../../src/engine/snapshot.js';
import { confirmLocalOccurrence } from '../../src/engine/local-confirmation.js';
import { standaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';

/** Synthetic origin accepted by the actual standalone engine. Shared by Node
 * regression and restricted-realm tests; it contains no runtime/user data. */
export function standaloneOriginAuditFixture({ opening = 500, type = 'expense', currency = 'PLN', amount = 400, date = '2026-06-02' } = {}) {
  const timing = { today: '2026-06-02', generationTimestamp: '2026-06-02T12:00:00.000Z', idSeed: 'origin-audit' };
  const initial = completeSnapshot();
  Object.assign(initial, { budgetId: 'local-origin-audit', name: 'Synthetic source' });
  Object.assign(initial.request, timing, { openingBalance: opening });
  initial.request.tables.one_off_transactions = [{ id: 'source', name: 'Source payment', currency, amount, type, date }];
  if (currency !== 'PLN') initial.request.fxSnapshot = { 'eur/pln': { rate: 4.2, source: 'manual', effectiveDate: '2026-06-01' } };
  const plan = calculateSnapshot(initial).plan;
  const row = [...plan.pendingRows, ...plan.futureRows].find(row => row.source_one_off_id === 'source');
  const snapshot = confirmLocalOccurrence({ snapshot: initial, ...timing, occurrenceKey: row.occurrence_key, idSeed: 'original' });
  return { snapshot, audit: { version: 2, budgetId: 'server-origin-audit', baselineComplete: true,
    lastSequence: snapshot.localAudit.length, origin: standaloneLedgerOrigin(snapshot, timing.generationTimestamp), originals: [], corrections: [] } };
}
