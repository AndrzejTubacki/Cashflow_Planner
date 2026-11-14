import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { standaloneOriginAuditFixture as fixture } from '../helpers/standalone-origin-fixture.js';
import { correctLocalConfirmation } from '../../src/engine/local-confirmation.js';
import { standaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
import { createLedgerAuditReplay } from '../../src/engine/ledger-audit-replay.js';
import { prepareLedgerAuditHashes, replayLedgerAuditFromHost, prepareLedgerAuditHashesJson, replayLedgerAuditFromHostJson } from '../../src/engine/ledger-audit-host.js';
import { planLedgerCorrection } from '../../src/engine/cashflow-ledger-correction-plan.js';
import { normalizeLedgerAuditFact } from '../../src/engine/ledger-audit-fact.js';

const primitives = { digestText: text => createHash('sha256').update(text).digest('hex'), utf8ByteLength: text => Buffer.byteLength(text) };
const codec = createLedgerAuditReplay({ ...primitives, allowStandaloneOrigins: true });
const upgraded = { allowStandaloneOrigins: true };
const timing = { today: '2026-06-02', generationTimestamp: '2026-06-02T12:00:00.000Z', idSeed: 'origin-audit' };
const reviewAt = '2026-06-02T12:01:00.000Z';
const budgetId = 'server-origin-audit';

function auditFor(snapshot) {
  return { version: 2, budgetId, baselineComplete: true, lastSequence: snapshot.localAudit.length,
    origin: standaloneLedgerOrigin(snapshot, timing.generationTimestamp), originals: [], corrections: [] };
}
const replay = audit => codec.replayLedgerAuditSnapshot(audit, budgetId);

/** Construct the exact event a future owning server writer must retain. Tests
 * independently assert balances and outcomes, not just replay's own checksum. */
function append(audit, replacement, { targetId = 'confirmed-original', id = `new-review-${audit.lastSequence + 1}`, retryOf = null } = {}) {
  const state = replay(audit);
  const original = state.originals.get(targetId);
  const current = state.heads.get(targetId);
  const actorId = 'synthetic-server-actor', reason = 'Explicit server review';
  const result = planLedgerCorrection({ budgetId, rows: state.rows, original: original.row,
    currentCorrectionId: current, expectedCorrectionId: current, replacement, reason,
    today: timing.today, createdAt: reviewAt, sourceAtAcceptance: original.sourceAtAcceptance,
    openingBalance: state.opening.ledgerCurrency === original.row.ledger_currency ? state.opening.amount : 0 });
  const event = { version: 2, budgetId, id, targetId, actorId, sequence: audit.lastSequence + 1,
    originalHash: codec.digest(original), previousAcceptedId: current, retryOf,
    requestHash: codec.digest({ targetId, expectedCorrectionId: current, replacement, reason, actorId, retryOf }),
    requested: replacement, reason, reviewDate: timing.today, createdAt: reviewAt,
    status: result.status, failureCode: result.failureCode, blockingIds: result.blockingIds, before: result.before, after: result.after };
  return { ...structuredClone(audit), lastSequence: event.sequence, corrections: [...audit.corrections, event] };
}

test('origin-aware audit corrections use the signed opening once and preserve original facts', () => {
  const { audit } = fixture();
  const before = JSON.stringify(audit.origin);
  const updated = append(audit, { amount: 450, date: timing.today });
  assert.equal(updated.corrections[0].status, 'accepted');
  const state = replay(updated);
  assert.equal(state.rows[0].amount, 450);
  assert.equal(state.originals.get('confirmed-original').row.amount, 400);
  assert.equal(state.opening.amount - state.rows[0].ledger_amount, 50);
  assert.equal(state.heads.get('confirmed-original'), updated.corrections[0].id);
  assert.equal(JSON.stringify(audit.origin), before);
  assert.deepEqual(updated.origin, audit.origin);
  const signed = append(fixture({ opening: -50, type: 'income', amount: 100 }).audit, { amount: 75, date: timing.today });
  assert.equal(signed.corrections[0].status, 'accepted');
  assert.equal(replay(signed).opening.amount + replay(signed).rows[0].ledger_amount, 25);
});

test('origin-aware audit preserves captured FX and actual years during later corrections', () => {
  const { audit } = fixture({ opening: 1000, amount: 100, currency: 'EUR', date: '2020-12-31' });
  const updated = append(audit, { amount: 90, date: '2021-01-01' });
  const row = replay(updated).rows[0];
  assert.equal(updated.corrections[0].status, 'accepted');
  assert.equal(row.confirmed_date, '2021-01-01');
  assert.equal(row.ledger_year, 2021);
  assert.equal(row.fx_rate, 4.2);
  assert.equal(row.ledger_amount, 378);
  assert.equal(replay(updated).opening.amount - row.ledger_amount, 622);
});

test('origin-aware audit restores a locally voided original using its retained accepted head', () => {
  const { snapshot } = fixture();
  const voided = correctLocalConfirmation({ snapshot, ...timing, confirmationId: 'confirmed-original',
    expectedCorrectionId: null, replacement: null, reason: 'Original void', idSeed: 'void' });
  const audit = auditFor(voided);
  const state = replay(audit);
  assert.equal(state.rows.length, 0);
  assert.equal(state.heads.get('confirmed-original'), 'correction-void');
  assert.equal(state.corrections.get('correction-void').actorId, null);
  const restored = append(audit, { amount: 400, date: timing.today });
  assert.equal(restored.corrections[0].before, null);
  assert.equal(restored.corrections[0].status, 'accepted');
  assert.equal(replay(restored).rows[0].amount, 400);
});

test('old local blocked branches remain recorded and new server retries consume only a leaf', () => {
  let { snapshot } = fixture();
  const correction = (idSeed, retryOf) => {
    snapshot = correctLocalConfirmation({ snapshot, ...timing, confirmationId: 'confirmed-original', expectedCorrectionId: null,
      replacement: { amount: 600, date: timing.today }, reason: 'Retained blocked branch', idSeed, retryOf });
  };
  correction('root', null); correction('child', 'correction-root'); correction('branch', 'correction-root');
  const audit = auditFor(snapshot);
  assert.equal(replay(audit).corrections.size, 3);
  const accepted = append(audit, { amount: 450, date: timing.today }, { retryOf: 'correction-child' });
  assert.equal(replay(accepted).rows[0].amount, 450);
  assert.equal(replay(accepted).corrections.get('correction-root').status, 'blocked');
  assert.throws(() => replay(append(audit, { amount: 450, date: timing.today }, { retryOf: 'correction-root' })), /retained intention review/);
  assert.throws(() => replay(append(accepted, { amount: 400, date: timing.today }, { retryOf: 'correction-child' })), /retained intention review/);
});

test('origin-aware replay and native host hashes verify identical state and independent-copy lineage', () => {
  const audit = append(fixture().audit, { amount: 450, date: timing.today });
  const request = prepareLedgerAuditHashes({ audit, budgetId }, upgraded);
  const hashes = request.texts.map(text => [text, createHash('sha256').update(text).digest('hex')]);
  const native = replayLedgerAuditFromHost({ audit, budgetId, hashes }, upgraded);
  assert.deepEqual(native.rows, replay(audit).rows);
  assert.equal(native.opening.amount, 500);
  assert.deepEqual(native.origin, audit.origin);
  assert.throws(() => replayLedgerAuditFromHost({ audit, budgetId, hashes: [] }, upgraded), /hash receipt missing/);
  const copy = codec.copyLedgerAuditSnapshot(audit, 'independent-origin-copy');
  const copied = codec.replayLedgerAuditSnapshot(copy, 'independent-origin-copy');
  assert.equal(copied.rows[0].budget_id, 'independent-origin-copy');
  assert.equal(copied.rows[0].amount, 450);
  assert.deepEqual(copy.origin, audit.origin);
  assert.notEqual(copy.corrections[0].originalHash, audit.corrections[0].originalHash);
  assert.equal(copy.corrections[0].actorId, audit.corrections[0].actorId);
});

test('origin-aware audit does not spend the original currency offset in a later different-currency ledger', () => {
  const { audit } = fixture({ opening: 1000 });
  for (const [id, type, amount] of [['euro-income', 'income', 200], ['euro-expense', 'expense', 100]]) {
    const row = normalizeLedgerAuditFact({ id, name: id, type, amount, currency: 'EUR', ledger_currency: 'EUR',
      fx_rate: 1, buffered_fx_rate: 1, ledger_amount: amount, date: timing.today, confirmed_date: timing.today,
      ledger_year: 2026, created_at: reviewAt, updated_at: reviewAt }, budgetId);
    delete row.running_balance_pln;
    audit.originals.push({ version: 1, budgetId, sequence: ++audit.lastSequence, captureKind: 'payment',
      actorId: 'synthetic-server-actor', capturedAt: reviewAt, row, sourceAtAcceptance: null });
  }
  const blocked = append(audit, { amount: 250, date: timing.today }, { targetId: 'euro-expense' });
  assert.equal(blocked.corrections[0].status, 'blocked');
  assert.equal(blocked.corrections[0].failureCode, 'history_overdraft');
  assert.equal(replay(blocked).rows.find(row => row.id === 'euro-expense').amount, 100);
});

test('origin-aware replay refuses downgraded/unknown formats, sequence gaps, forged outcomes and altered hashes', () => {
  const audit = append(fixture().audit, { amount: 450, date: timing.today });
  for (const mutate of [value => { value.version = 1; }, value => { value.version = 3; },
    value => { delete value.origin; }, value => { value.origin.accessToken = 'synthetic-forbidden'; },
    value => { value.lastSequence--; }, value => { value.corrections[0].sequence = 1; },
    value => { value.corrections[0].after.amount = 1; }, value => { value.corrections[0].originalHash = '0'.repeat(64); },
    value => { value.corrections[0].requestHash = '0'.repeat(64); },
    value => { value.originals.push({ ...replay(audit).originals.values().next().value, sequence: ++value.lastSequence }); }]) {
    const changed = structuredClone(audit); mutate(changed);
    assert.throws(() => replay(changed));
  }
  for (const openingBalance of ['500', NaN, 0.001, Number.MAX_VALUE]) {
    const state = replay(audit), original = state.originals.get('confirmed-original');
    assert.throws(() => planLedgerCorrection({ budgetId, rows: state.rows, original: original.row,
      currentCorrectionId: state.heads.get(original.row.id), expectedCorrectionId: state.heads.get(original.row.id),
      replacement: null, reason: 'Invalid offset', today: timing.today, createdAt: reviewAt, openingBalance }));
  }
});

test('legacy direct hosts reject origins while engine 0.4 JSON hosts use compiled capability', () => {
  const audit = fixture().audit;
  const legacy = createLedgerAuditReplay(primitives);
  assert.throws(() => legacy.replayLedgerAuditSnapshot(audit, budgetId), /upgraded host/);
  assert.throws(() => legacy.copyLedgerAuditSnapshot(audit, 'another-budget'), /upgraded host/);
  const input = { audit, budgetId, hashes: [], allowStandaloneOrigins: true };
  assert.throws(() => prepareLedgerAuditHashes(input), /upgraded host/);
  assert.throws(() => replayLedgerAuditFromHost(input), /upgraded host/);
  const prepared = JSON.parse(prepareLedgerAuditHashesJson(JSON.stringify(input)));
  assert.equal(prepared.ok, true);
  input.hashes = prepared.texts.map(text => [text, primitives.digestText(text)]);
  for (const importedFlag of [false, true]) {
    const result = JSON.parse(replayLedgerAuditFromHostJson(JSON.stringify({ ...input, allowStandaloneOrigins: importedFlag })));
    assert.equal(result.ok, true);
    assert.equal(result.replay.opening.amount, 500);
  }
});
