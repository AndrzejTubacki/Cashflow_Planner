import { completeSnapshot } from '../engine/fixtures.js';
import { confirmLocalOccurrence, correctLocalConfirmation } from '../../src/engine/local-confirmation.js';
import { changeLocalLedgerCurrency } from '../../src/engine/local-ledger-currency.js';
import { reviewLocalCorrection, applyReviewedLocalCorrection } from '../../src/engine/local-correction-review.js';

export const currencyTiming = { today: '2026-06-02', generationTimestamp: '2026-06-02T12:00:00.000Z', idSeed: 'transfer-currency' };
/** Real standalone commands, including blocked/reviewed H5 outcomes; no forged mirrors. */
export function currencyTransferFixture(stage = 'pending', reviewed = false) {
  const timing = currencyTiming;
  let snapshot = completeSnapshot();
  Object.assign(snapshot, { budgetId: 'local-currency-transfer', name: 'Currency history' });
  Object.assign(snapshot.request, timing, { openingBalance: 500 });
  snapshot.request.tables.one_off_transactions = [{ id: 'old', name: 'Earlier expense', type: 'expense', currency: 'PLN', amount: 100, date: timing.today }];
  snapshot = confirmLocalOccurrence({ snapshot, ...timing, idSeed: 'old', occurrenceKey: `one_off:old:expense:${timing.today}` });
  snapshot = changeLocalLedgerCurrency({ snapshot, ...timing, idSeed: 'switch', newCurrency: 'EUR', manualRates: { 'PLN/EUR': 0.25 } });
  if (stage !== 'pending') snapshot = confirmLocalOccurrence({ snapshot, ...timing, idSeed: 'conversion', occurrenceKey: snapshot.request.tables.pending_transactions[0].occurrence_key });
  if (stage === 'voided') snapshot = correctLocalConfirmation({ snapshot, ...timing, idSeed: 'void', confirmationId: 'confirmed-conversion', expectedCorrectionId: null, reason: 'Void conversion', replacement: null });
  if (reviewed) {
    const intent = { ...timing, confirmationId: 'confirmed-old', expectedCorrectionId: null, reason: 'Reviewed earlier expense', replacement: { amount: 80, date: timing.today } };
    snapshot = correctLocalConfirmation({ snapshot, ...intent, idSeed: 'blocked' });
    const input = { snapshot, ...intent, idSeed: 'reviewed', retryOf: 'correction-blocked' };
    snapshot = applyReviewedLocalCorrection({ ...input, review: reviewLocalCorrection(input) });
  }
  if (stage === 'returned') {
    snapshot = changeLocalLedgerCurrency({ snapshot, ...timing, idSeed: 'return', newCurrency: 'PLN', manualRates: { 'EUR/PLN': 4 } });
    snapshot = confirmLocalOccurrence({ snapshot, ...timing, idSeed: 'return-conversion', occurrenceKey: snapshot.request.tables.pending_transactions[0].occurrence_key });
  }
  snapshot.request.tables.one_off_transactions.push({ id: 'future', name: 'Future PLN bill', type: 'expense', currency: 'PLN', amount: 10, date: '2026-06-10' });
  for (const entry of Object.values(snapshot.request.fxSnapshot)) if (entry.source === 'manual') entry.effectiveDate = '2020-01-01';
  // Transfer v2 is explicit, local snapshot/audit framing remains unchanged.
  snapshot.transferVersion = 2;
  return snapshot;
}
