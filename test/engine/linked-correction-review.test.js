import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { portableLinkedInstallmentCommand } from '../helpers/ledger-audit-fixtures.js';
import { prepareLinkedLedgerAuditHashes } from '../../src/engine/linked-ledger-audit.js';
import { prepareLinkedSnapshot } from '../../src/engine/linked-snapshot.js';
import * as review from '../../src/engine/linked-correction-review.js';

/** Native hosts hash exactly the prepared strings; none come from input files. */
function command() {
  const source = portableLinkedInstallmentCommand();
  return { ...source, payload: { targetId: 'expense', expectedCorrectionId: 'void-expense', replacement: { amount: 50, date: '2019-01-01' },
    reason: 'Reviewed restoration', retryOf: null }, auditHashes: prepareLinkedLedgerAuditHashes(source).texts
      .map(text => [text, createHash('sha256').update(text).digest('hex')]) };
}

test('linked correction review retains voided identity and predicts effect without changing accepted evidence', () => {
  const input = command(), before = structuredClone(input);
  const result = review.reviewLinkedCorrection(input);
  assert.equal(result.status, 'accepted'); assert.equal(result.before, null);
  assert.equal(result.after.id, 'expense'); assert.equal(result.after.amount, 50);
  assert.equal(result.after.source_one_off_id, 'desk');
  assert.deepEqual(input, before);
});
test('blocked review identifies dependent payments and cannot apply money', () => {
  const input = command(); input.payload.replacement.amount = 500;
  const result = review.reviewLinkedCorrection(input);
  assert.equal(result.status, 'blocked'); assert.equal(result.after, null);
  assert.deepEqual(result.blockingIds, ['expense']);
});
test('review refuses stale heads, already-reviewed lineage, forged facts and authority fields', () => {
  for (const mutate of [input => { input.payload.expectedCorrectionId = null; }, input => { input.payload.actorId = 'forged'; },
    input => { input.payload.targetId = 'income'; input.payload.expectedCorrectionId = 'retry'; input.payload.retryOf = 'blocked'; },
    input => { input.parts.ledger[0].amount = 999; }]) {
    const input = command(); mutate(input); assert.throws(() => review.reviewLinkedCorrection(input));
  }
});
test('legacy review uses accepted facts and unknown captured source, without seeding an audit', () => {
  const input = command(); input.parts['ledger-audit'] = []; input.auditHashes = [];
  input.payload = { targetId: 'income', expectedCorrectionId: null, replacement: { amount: 400, date: '2018-01-01' }, reason: 'Legacy review', retryOf: null };
  const before = structuredClone(input); const result = review.reviewLinkedCorrection(input);
  assert.equal(result.status, 'accepted'); assert.equal(result.after.amount, 400);
  assert.deepEqual(input, before);
});
test('foreign review keeps both recorded rates unless the user explicitly re-enters one', () => {
  const input = command(); input.parts['ledger-audit'] = []; input.auditHashes = [];
  Object.assign(input.parts.ledger[0], { currency: 'EUR', fx_rate: 2, buffered_fx_rate: 2.2, ledger_amount: 990 });
  input.payload = { targetId: 'income', expectedCorrectionId: null, replacement: { amount: 5, date: '2018-01-01' }, reason: 'Recorded rate', retryOf: null };
  let result = review.reviewLinkedCorrection(input);
  assert.equal(result.after.fx_rate, 2); assert.equal(result.after.buffered_fx_rate, 2.2); assert.equal(result.after.ledger_amount, 11);
  input.payload.replacement.fx_rate = 3; result = review.reviewLinkedCorrection(input);
  assert.equal(result.after.fx_rate, 3); assert.equal(result.after.buffered_fx_rate, 3); assert.equal(result.after.ledger_amount, 15);
});

test('queued corrections stay visible without changing accepted or working money before server outcome', () => {
  const input = command(); input.pending.push({ operationId: 'queued-correction', kind: 'ledger.correct', payload: input.payload });
  const snapshot = prepareLinkedSnapshot(input);
  assert.equal(snapshot.request.openingBalance, 450);
  assert.deepEqual(snapshot.linked.unapplied, [{ operationId: 'queued-correction', reason: 'CORRECTION_AWAITING_SERVER' }]);
  assert.equal(snapshot.linked.acceptedAudit.corrections.length, 3);
});
