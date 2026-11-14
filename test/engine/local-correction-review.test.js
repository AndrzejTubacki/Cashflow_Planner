import assert from 'node:assert/strict';
import test from 'node:test';
import { completeSnapshot } from './fixtures.js';
import { changeLocalLedgerCurrency } from '../../src/engine/local-ledger-currency.js';
import { confirmLocalOccurrence, correctLocalConfirmation, refreshLocalSnapshot } from '../../src/engine/local-confirmation.js';
import { reviewLocalCorrection, applyReviewedLocalCorrection, applyReviewedLocalCorrectionJson } from '../../src/engine/local-correction-review.js';

const timing = { today: '2026-06-01', generationTimestamp: '2026-06-01T12:00:00.000Z', idSeed: 'review' };
/** Synthetic ledger only; accepting order is deliberately independent of IDs. */
function earlier(foreign = false) {
  const snapshot = completeSnapshot();
  snapshot.budgetId = 'local-review'; snapshot.request.openingBalance = 500;
  snapshot.request.tables.one_off_transactions = [{ id: 'old', name: 'Earlier expense', type: 'expense', amount: 100,
    currency: foreign ? 'USD' : 'PLN', date: timing.today }];
  if (foreign) snapshot.request.fxSnapshot = { 'usd/pln': { rate: 1, source: 'manual', effectiveDate: timing.today } };
  return confirmLocalOccurrence({ snapshot, ...timing, idSeed: 'old', occurrenceKey: 'one_off:old:expense:2026-06-01' });
}
function switchTo(snapshot, currency = 'EUR', rate = 0.25, idSeed = 'switch') {
  return changeLocalLedgerCurrency({ snapshot, ...timing, idSeed, newCurrency: currency,
    manualRates: { [`${snapshot.request.settings.ledger_currency}/${currency}`]: rate } });
}
function conversion(snapshot, idSeed = 'conversion', amount) {
  return confirmLocalOccurrence({ snapshot, ...timing, idSeed, amount,
    occurrenceKey: snapshot.request.tables.pending_transactions[0].occurrence_key });
}
function command(snapshot, replacement = { amount: 80, date: timing.today }, extra = {}) {
  return { snapshot, ...timing, confirmationId: 'confirmed-old', expectedCorrectionId: null,
    reason: 'Reviewed earlier payment', replacement, ...extra };
}
function apply(input) {
  const original = JSON.stringify(input.snapshot);
  const review = reviewLocalCorrection(input);
  assert.equal(JSON.stringify(input.snapshot), original, 'review must be read-only');
  const result = applyReviewedLocalCorrection({ ...input, review });
  assert.equal(JSON.stringify(input.snapshot), original, 'apply must be atomic and immutable');
  const reopened = refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(result)), ...timing });
  assert.deepEqual(reopened.localHistory, result.localHistory, 'backup/reopen replays the same money');
  return { result, review };
}

for (const stage of ['before-switch', 'pending', 'confirmed', 'voided']) {
  for (const kind of ['amount', 'void', 'fx']) test(`${kind} correction ${stage} recomputes conversion and survives backup/reopen`, () => {
    let snapshot = earlier(kind === 'fx');
    if (stage !== 'before-switch') snapshot = switchTo(snapshot);
    if (['confirmed', 'voided'].includes(stage)) snapshot = conversion(snapshot);
    if (stage === 'voided') snapshot = correctLocalConfirmation(command(snapshot, null,
      { confirmationId: 'confirmed-conversion', idSeed: 'void-conversion' }));
    const originals = structuredClone(snapshot.localAudit);
    const replacement = kind === 'void' ? null : { amount: kind === 'fx' ? 100 : 80, date: timing.today,
      ...(kind === 'fx' ? { fx_rate: 0.8 } : {}) };
    const { result, review } = apply(command(snapshot, replacement));
    assert.equal(review.status, 'accepted');
    assert.deepEqual(result.localAudit.slice(0, originals.length), originals);
    const converted = kind === 'void' ? 125 : 105;
    if (stage === 'pending') {
      assert.equal(result.request.tables.pending_transactions[0].amount, converted);
      assert.equal(conversion(result).request.openingBalance, converted);
    } else if (stage === 'confirmed') assert.equal(result.request.openingBalance, converted);
    else if (stage === 'voided') {
      assert.equal(result.request.openingBalance, 0);
      assert.equal(result.localHistory.some(row => row.id === 'confirmed-conversion'), false);
      assert.equal(review.changes[0].outcome, 'voided');
    } else assert.equal(switchTo(result).request.tables.pending_transactions[0].amount, converted);
  });
}

test('H5 retained block requires explicit reviewed retry after voided conversion', () => {
  const paid = conversion(switchTo(earlier()));
  const voided = correctLocalConfirmation(command(paid, null, { confirmationId: 'confirmed-conversion', idSeed: 'void' }));
  const blocked = correctLocalConfirmation(command(voided, undefined, { idSeed: 'blocked' }));
  assert.equal(blocked.localAudit.at(-1).failureCode, 'currency_conversion_dependency');
  assert.equal(refreshLocalSnapshot({ snapshot: blocked, ...timing }).localHistory[0].amount, 100);
  const { result } = apply(command(blocked, undefined, { retryOf: 'correction-blocked', idSeed: 'retry' }));
  assert.equal(result.localHistory[0].amount, 80);
  assert.equal(result.localAudit.at(-2).status, 'blocked');
  assert.equal(result.localAudit.at(-1).retryOf, 'correction-blocked');
});

test('new-currency spending remains a funded dependency, then explicit retry succeeds', () => {
  let snapshot = conversion(switchTo(earlier()));
  snapshot.request.tables.one_off_transactions.push({ id: 'new', name: 'EUR expense', currency: 'EUR', type: 'expense', amount: 90, date: timing.today });
  snapshot = confirmLocalOccurrence({ snapshot, ...timing, idSeed: 'spend', occurrenceKey: 'one_off:new:expense:2026-06-01' });
  const input = command(snapshot, { amount: 200, date: timing.today }, { idSeed: 'blocked' });
  const { result: blocked, review } = apply(input);
  assert.equal(review.failureCode, 'history_overdraft');
  assert.equal(review.downstream.find(row => row.id === 'confirmed-spend').running_balance_pln, -15);
  assert.deepEqual(blocked.localHistory, snapshot.localHistory);
  const freed = correctLocalConfirmation(command(blocked, null, { confirmationId: 'confirmed-spend', idSeed: 'free' }));
  const { result } = apply(command(freed, input.replacement, { idSeed: 'retry', retryOf: 'correction-blocked' }));
  assert.equal(result.request.openingBalance, 75);
});

test('multiple switches cascade without rewriting original events, including return to PLN', () => {
  const euro = conversion(switchTo(earlier()));
  const pound = conversion(switchTo(euro, 'GBP', 2, 'second'), 'second-paid');
  const back = conversion(switchTo(pound, 'PLN', 4, 'third'), 'third-paid');
  const { result, review } = apply(command(back));
  assert.equal(review.changes.length, 3);
  assert.equal(result.localHistory.find(row => row.id === 'confirmed-conversion').amount, 105);
  assert.equal(result.localHistory.find(row => row.id === 'confirmed-second-paid').amount, 210);
  assert.equal(result.localHistory.find(row => row.id === 'confirmed-third-paid').amount, 840);
  assert.equal(result.request.openingBalance, 1260);
  const again = apply(command(result, { amount: 60, date: timing.today }, { expectedCorrectionId: 'correction-review', idSeed: 'again' }));
  assert.equal(again.result.request.openingBalance, 1320);
});

test('manual conversion amount deviation and its void policy survive recomputation', () => {
  const paid = conversion(switchTo(earlier()), 'conversion', 90);
  const { result } = apply(command(paid));
  assert.equal(result.request.openingBalance, 95, 'retains the explicitly accepted minus-ten adjustment');
});

test('stale, forged and changed-intent reviews fail without a partial snapshot', () => {
  const input = command(conversion(switchTo(earlier())));
  const review = reviewLocalCorrection(input);
  for (const changed of [ { ...review, revision: review.revision + 1 },
    { ...review, changes: [] }, { ...review, downstream: [] } ]) {
    const rejected = JSON.parse(applyReviewedLocalCorrectionJson(JSON.stringify({ ...input, review: changed })));
    assert.equal(rejected.ok, false); assert.equal(rejected.snapshot, undefined);
  }
  assert.throws(() => applyReviewedLocalCorrection({ ...input, reason: 'Changed intention', review }), /review again/);
  const altered = applyReviewedLocalCorrection({ ...input, review });
  altered.localAudit.at(-1).conversionReview.changes[0].after.event.old_balance++;
  assert.throws(() => refreshLocalSnapshot({ snapshot: altered, ...timing }), /Altered conversion correction review/);
});

test('later confirmations and switches use reviewed pending evidence, while ordinary guard remains active', () => {
  const pending = switchTo(earlier());
  const { result } = apply(command(pending));
  const paid = conversion(result);
  const later = conversion(switchTo(paid, 'GBP', 2, 'later'), 'later-paid');
  assert.equal(later.request.openingBalance, 210);
  const blocked = correctLocalConfirmation(command(later, null, { expectedCorrectionId: 'correction-review', idSeed: 'ordinary' }));
  assert.equal(blocked.localAudit.at(-1).failureCode, 'currency_conversion_dependency');
  assert.equal(blocked.request.openingBalance, 210);
});

test('date-only review checks historical funding and voided conversions may be explicitly restored', () => {
  const paid = conversion(switchTo(earlier()));
  const voided = correctLocalConfirmation(command(paid, null, { confirmationId: 'confirmed-conversion', idSeed: 'void' }));
  const { result } = apply(command(voided));
  const restored = correctLocalConfirmation(command(result, { amount: 105, date: timing.today },
    { confirmationId: 'confirmed-conversion', expectedCorrectionId: 'correction-void', idSeed: 'restore' }));
  assert.equal(restored.request.openingBalance, 105);
  const { review } = apply(command(restored, { amount: 80, date: '2026-05-31' },
    { expectedCorrectionId: 'correction-review', idSeed: 'date' }));
  assert.equal(review.changes.length, 0);
});

test('review can change a zero conversion to negative without losing signed opening evidence', () => {
  const snapshot = completeSnapshot();
  snapshot.budgetId = 'local-signed-review'; snapshot.request.openingBalance = -100;
  snapshot.request.tables.one_off_transactions = [{ id: 'old', name: 'Income', type: 'income', amount: 100, currency: 'PLN', date: timing.today }];
  const paid = confirmLocalOccurrence({ snapshot, ...timing, idSeed: 'old', occurrenceKey: 'one_off:old:income:2026-06-01' });
  const converted = conversion(switchTo(paid));
  const { result, review } = apply(command(converted, null));
  assert.equal(review.changes[0].after.event.converted_opening_balance, -25);
  assert.equal(result.localHistory[0].type, 'expense');
  assert.equal(result.request.openingBalance, -25);
  assert.equal(result.localOpeningBalance, -100);
});

test('recomputed conversion acceptance still requires its own original source event', () => {
  const euro = conversion(switchTo(earlier()));
  const returned = conversion(switchTo(euro, 'PLN', 4, 'return'), 'return-paid');
  const final = conversion(switchTo(returned, 'EUR', 0.25, 'again'), 'again-paid');
  const { result } = apply(command(final));
  const altered = structuredClone(result);
  const events = altered.localAudit;
  const conversionEvents = events.filter(event => event.kind === 'ledger-currency');
  const payment = events.find(event => event.id === 'confirmed-again-paid');
  payment.source.row = structuredClone(conversionEvents[0].event);
  assert.throws(() => refreshLocalSnapshot({ snapshot: altered, ...timing }), /Conversion payment lacks retained event/);
});
