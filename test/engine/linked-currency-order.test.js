import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeKeepFixture, nativeTiming as timing } from '../helpers/native-keep-fixture.js';
import { reviewLocalCorrection, applyReviewedLocalCorrection } from '../../src/engine/local-correction-review.js';
import { materializeLinkedStandalone } from '../../src/engine/linked-materialization.js';
import { confirmLocalOccurrence, correctLocalConfirmation, refreshLocalSnapshot } from '../../src/engine/local-confirmation.js';
import { standaloneLedgerOrigin, replayStandaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
function command(snapshot) {
  return { snapshot, ...timing, confirmationId: 'confirmed-old', expectedCorrectionId: null,
    reason: 'Reviewed native KEEP correction', replacement: { amount: 80, date: timing.today } };
}
for (const stage of ['pending', 'confirmed', 'voided', 'funding']) for (const legacy of [false, true]) {
  test(`native KEEP ${stage}, ${legacy ? 'legacy receipt rebase' : 'durable switch boundary'}: review/apply/backup`, () => {
    const { copy } = nativeKeepFixture({ stage, legacy });
    const input = command(copy), review = reviewLocalCorrection(input);
    assert.equal(review.status, 'accepted', review.failureCode);
    assert.equal(Boolean(review.orderingResolution), legacy);
    const revised = applyReviewedLocalCorrection({ ...input, review });
    assert.deepEqual(revised.localAudit[0], copy.localAudit[0]);
    assert.equal(revised.localHistory.find(row => row.id === 'confirmed-old').amount, 80);
    assert.deepEqual(refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(revised)), ...timing }).localHistory, revised.localHistory);
    const origin = standaloneLedgerOrigin(revised, timing.generationTimestamp);
    assert.equal(replayStandaloneLedgerOrigin({ origin, budgetId: 'native-upload', utf8ByteLength: s => Buffer.byteLength(s) }).rows.length, revised.localHistory.length);
    if (stage === 'pending') {
      const pending = revised.request.tables.pending_transactions[0];
      const paid = confirmLocalOccurrence({ snapshot: revised, ...timing, idSeed: 'kept-conversion', occurrenceKey: pending.occurrence_key });
      assert.equal(paid.localHistory.find(row => row.id === 'confirmed-kept-conversion').amount, 105);
      assert.deepEqual(refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(paid)), ...timing }).localHistory, paid.localHistory);
    }
    const retry = { ...command(revised), idSeed: 'another', expectedCorrectionId: revised.localAudit.at(-1).id,
      replacement: { amount: 60, date: timing.today } };
    const retryReview = reviewLocalCorrection(retry);
    assert.equal(retryReview.status, 'accepted');
    assert.equal(retryReview.changes[0].after.event.converted_opening_balance, 110);
    applyReviewedLocalCorrection({ ...retry, review: retryReview });
    if (legacy) {
      const forged = structuredClone(review); forged.orderingResolution.switches[0].afterSequence++;
      assert.throws(() => applyReviewedLocalCorrection({ ...input, review: forged }), /review again/);
    }
  });
}
for (const uploaded of [false, true, 'currency']) for (const signed of [false, true]) test(`native additions, repeated switches, uploaded=${uploaded} signed=${signed}`, () => {
  const { copy } = nativeKeepFixture({ repeated: true, uploaded, signed });
  const input = command(copy), review = reviewLocalCorrection(input);
  assert.equal(review.status, 'accepted', review.failureCode); assert.equal(review.changes.length, 3);
  const revised = applyReviewedLocalCorrection({ ...input, review });
  assert.deepEqual(refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(revised)), ...timing }).localHistory, revised.localHistory);
  assert.deepEqual(copy.localAudit[0], revised.localAudit[0]);
});
test('reduced pre-switch income cannot leave unfunded downstream spending', () => {
  const { copy } = nativeKeepFixture({ stage: 'funding' });
  const input = { ...command(copy), confirmationId: 'confirmed-income', replacement: { amount: 400, date: timing.today } };
  const review = reviewLocalCorrection(input);
  assert.equal(review.status, 'blocked'); assert.equal(review.failureCode, 'history_overdraft');
  assert.deepEqual(applyReviewedLocalCorrection({ ...input, review }).localHistory, copy.localHistory);
});
test('missing, pruned, inconsistent and ambiguous legacy evidence never guesses from dates or amounts', () => {
  for (const mode of ['missing', 'pruned', 'gap', 'sequence', 'ambiguous']) {
    const { input } = nativeKeepFixture({ legacy: true, repeated: mode === 'ambiguous' ? 'ambiguous' : false });
    const event = input.parts['currency-events'][0];
    if (mode === 'missing') delete event.orderResolution;
    if (mode === 'pruned') event.orderResolution.records[0].operation.payload = null;
    if (mode === 'gap') event.orderResolution.records.shift();
    if (mode === 'sequence') event.orderResolution.records[0].result.revision = 99;
    const copy = materializeLinkedStandalone(input), review = reviewLocalCorrection(command(copy));
    assert.equal(review.failureCode, 'currency_conversion_dependency', mode);
    assert.equal(review.orderingBlocked, 'accepted_ordering_evidence_unavailable');
  }
});

for (const stage of ['pending', 'confirmed']) test(`KEEP ${stage} conversion crosses zero with a retained negative opening`, () => {
  const { copy } = nativeKeepFixture({ stage, signed: 'zero' });
  const input = { ...command(copy), confirmationId: 'confirmed-income', replacement: null };
  const review = reviewLocalCorrection(input);
  assert.equal(review.status, 'accepted', review.failureCode);
  assert.equal(review.changes[0].after.event.converted_opening_balance, -25);
  assert.equal(review.changes[0].after.pending.type, 'expense');
  const revised = applyReviewedLocalCorrection({ ...input, review });
  assert.equal(revised.localOpeningBalance, -100);
  if (stage === 'confirmed') assert.equal(revised.request.openingBalance, -25);
  assert.deepEqual(refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(revised)), ...timing }).localHistory, revised.localHistory);
});

test('version-1 KEEP preserves an old blocked review and permits an explicitly audited rebase retry', () => {
  for (const stage of ['pending', 'confirmed', 'voided']) for (const legacy of [false, true]) {
    const { copy } = nativeKeepFixture({ stage, legacy });
    const old = structuredClone(copy); old.localAudit[0].version = 1;
    // Mirrors must follow the v1 interpretation before its historical review.
    if (stage !== 'pending') {
      old.request.tables.pending_transactions = [];
      for (const event of old.localAudit[0].currencyEvents) delete event.orderResolution;
    }
    let recorded;
    if (stage === 'pending') {
      recorded = correctLocalConfirmation(command(old));
      recorded.localAudit.at(-1).conversionReview = { changes: [], downstream: old.localHistory.filter(row => row.id !== 'confirmed-old') };
      assert.deepEqual(refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(recorded)), ...timing }).localAudit, recorded.localAudit);
    } else recorded = old;
    const input = { ...command(recorded), idSeed: 'v1-rebase', ...(stage === 'pending' ? { retryOf: recorded.localAudit.at(-1).id } : {}) };
    const review = reviewLocalCorrection(input);
    // A v1 copy without retained legacy receipts still requires new evidence.
    if (legacy && stage !== 'pending') {
      assert.equal(review.status, 'blocked'); continue;
    }
    assert.equal(review.status, 'accepted', `${stage}: ${review.failureCode}`);
    assert.ok(review.orderingResolution);
    const revised = applyReviewedLocalCorrection({ ...input, review });
    assert.deepEqual(revised.localAudit.slice(0, recorded.localAudit.length), recorded.localAudit);
    assert.deepEqual(refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(revised)), ...timing }).localHistory, revised.localHistory);
  }
});

test('uploaded currency origin plus native additions needs no invented extra switch', () => {
  for (const version of [1, 2]) {
    const { copy } = nativeKeepFixture({ uploaded: 'currency' });
    copy.localAudit[0].version = version;
    const input = command(copy), review = reviewLocalCorrection(input);
    assert.equal(review.status, 'accepted', review.failureCode);
    assert.equal(Boolean(review.orderingResolution), version === 1);
    const revised = applyReviewedLocalCorrection({ ...input, review });
    assert.equal(revised.localHistory.find(row => row.id === 'confirmed-euro-paid').amount, 105);
    assert.deepEqual(revised.localAudit[0], copy.localAudit[0]);
    assert.deepEqual(refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(revised)), ...timing }).localHistory, revised.localHistory);
  }
});
