import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { encodeLedgerAuditRecords, decodeLedgerAuditRecords } from '../../src/engine/ledger-audit-transport.js';
import { linkedLedgerAudit, prepareLinkedLedgerAuditHashes, verifyLinkedLedgerAudit,
  prepareLinkedLedgerAuditHashesJson, verifyLinkedLedgerAuditJson } from '../../src/engine/linked-ledger-audit.js';
import { replayStandaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
import { auditUtf8ByteLength } from '../../src/engine/ledger-audit-host.js';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { correctLocalConfirmation } from '../../src/engine/local-confirmation.js';
import { standaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
import { prepareLinkedSnapshot, prepareLinkedSnapshotJson } from '../../src/engine/linked-snapshot.js';
import { reviewLinkedCorrection } from '../../src/engine/linked-correction-review.js';

const budgetId = 'server-origin-audit', upgraded = { allowStandaloneOrigins: true };
const sha = text => createHash('sha256').update(text).digest('hex');

/** The owning host, not downloaded JSON, computes these integrity receipts. */
function receipts(parts) {
  return prepareLinkedLedgerAuditHashes({ budgetId, parts }, upgraded).texts.map(text => [text, sha(text)]);
}

/** Retained local payment notes contain both non-ASCII and surrogate-pair scalars so
 * proof spans multiple fragments and crosses real JSON/UTF-8 boundaries. */
function largeAudit() {
  const audit = standaloneOriginAuditFixture().audit;
  audit.origin.events[0].row.note = 'Zażółć 🌍 '.repeat(8000);
  return audit;
}

test('ordinary linked audit keeps the existing record format and exact reconstruction', () => {
  const audit = { version: 1, budgetId, baselineComplete: true, lastSequence: 0, originals: [], corrections: [] };
  const records = encodeLedgerAuditRecords(audit);
  assert.deepEqual(records, [{ kind: 'state', value: { version: 1, budgetId, baselineComplete: true, lastSequence: 0 } }]);
  assert.deepEqual(linkedLedgerAudit(records, budgetId), audit);
  assert.deepEqual(encodeLedgerAuditRecords(null), []);
  assert.equal(decodeLedgerAuditRecords([], budgetId), null);
});

test('opted-in origin fragments roundtrip exact proof through JSON and native hash replay', () => {
  const audit = largeAudit();
  const records = encodeLedgerAuditRecords(audit, upgraded);
  assert.ok(records[0].value.originChunks > 1);
  assert.ok(records.every(record => auditUtf8ByteLength(JSON.stringify(record)) < 1024 * 1024));
  const downloaded = JSON.parse(JSON.stringify(records));
  assert.deepEqual(linkedLedgerAudit(downloaded, budgetId, upgraded), audit);
  for (const record of downloaded.slice(1)) {
    const text = record.value.text;
    assert.ok(text.length <= 32768);
    assert.ok(!(/[\ud800-\udbff]$/.test(text)));
    assert.ok(!(/^[\udc00-\udfff]/.test(text)));
  }
  const replay = replayStandaloneLedgerOrigin({ origin: audit.origin, budgetId, utf8ByteLength: auditUtf8ByteLength });
  const parts = { 'ledger-audit': downloaded, ledger: replay.rows };
  const verified = verifyLinkedLedgerAudit({ budgetId, parts, auditHashes: receipts(parts) }, upgraded);
  assert.deepEqual(verified.audit, audit);
  assert.equal(verified.replay.opening.amount, 500);
  assert.equal(verified.audit.origin.events[0].row.note, audit.origin.events[0].row.note);
});

test('legacy direct readers refuse origins while new JSON hosts use compiled capability', () => {
  const audit = standaloneOriginAuditFixture().audit;
  assert.throws(() => encodeLedgerAuditRecords(audit), /upgraded host/);
  const parts = { 'ledger-audit': encodeLedgerAuditRecords(audit, upgraded), ledger: [] };
  assert.throws(() => linkedLedgerAudit(parts['ledger-audit'], budgetId), /upgraded host/);
  const input = { budgetId, parts, allowStandaloneOrigins: true, auditHashes: [] };
  assert.equal(JSON.parse(prepareLinkedLedgerAuditHashesJson(JSON.stringify(input))).ok, true);
  assert.equal(JSON.parse(verifyLinkedLedgerAuditJson(JSON.stringify(input))).ok, false);
  assert.throws(() => decodeLedgerAuditRecords(parts['ledger-audit'], budgetId, { allowStandaloneOrigins: 'true' }), /capability/);
});

test('origin framing refuses gaps, duplicates, reordered fragments, mixed formats and unknown fields', () => {
  const records = encodeLedgerAuditRecords(largeAudit(), upgraded);
  const changes = [
    value => { value.splice(1, 1); },
    value => { value.splice(2, 0, structuredClone(value[1])); },
    value => { [value[1], value[2]] = [value[2], value[1]]; },
    value => { value[0].value.originChunks++; },
    value => { value[0].value.originChunks = 0; },
    value => { value[0].value.version = 1; },
    value => { value[0].value.version = 3; },
    value => { value[1].value.extra = true; },
    value => { value[1].extra = true; },
    value => { value[1].value.index = 0.5; },
    value => { value[1].value.text = ''; },
    value => { value[1].value.text = 'x'.repeat(32769); },
    value => { value.push({ kind: 'unknown', value: {} }); },
    value => { value.push(structuredClone(value[0])); },
    value => { value[0].value.budgetId = 'another-budget'; }
  ];
  for (const change of changes) {
    const invalid = structuredClone(records); change(invalid);
    assert.throws(() => decodeLedgerAuditRecords(invalid, budgetId, upgraded));
  }
});

test('transport bounds proof bytes before joining/parsing, and financial replay rejects changed proof or facts', () => {
  const audit = standaloneOriginAuditFixture().audit;
  const records = encodeLedgerAuditRecords(audit, upgraded);
  const malformed = structuredClone(records);
  malformed[1].value.text = '{broken';
  assert.throws(() => decodeLedgerAuditRecords(malformed, budgetId, upgraded), /origin JSON/);
  const oversized = structuredClone(audit);
  oversized.origin.events[0].source.row.name = 'x'.repeat(10 * 1024 * 1024);
  assert.throws(() => encodeLedgerAuditRecords(oversized, upgraded), /10 MB/);
  const tooMany = [{ kind: 'state', value: { ...records[0].value, originChunks: 322 } }];
  assert.throws(() => decodeLedgerAuditRecords(tooMany, budgetId, upgraded), /chunk count/);
  const huge = [{ kind: 'state', value: { ...records[0].value, originChunks: 321 } },
    ...Array.from({ length: 321 }, (_, index) => ({ kind: 'origin-chunk', value: { index, text: 'x'.repeat(32768) } }))];
  assert.throws(() => decodeLedgerAuditRecords(huge, budgetId, upgraded), /10 MB/);
  const parts = { 'ledger-audit': records, ledger: [] };
  assert.throws(() => verifyLinkedLedgerAudit({ budgetId, parts, auditHashes: receipts(parts) }, upgraded), /differs from retained/);
  const changed = structuredClone(audit); changed.origin.openingBalance = 0;
  const forgedParts = { 'ledger-audit': encodeLedgerAuditRecords(changed, upgraded), ledger: [] };
  assert.throws(() => receipts(forgedParts));
});

/** Build a complete downloaded part set from genuine standalone history. All
 * capability and hash receipts are supplied separately by the owning host. */
function viewFixture(voided = false) {
  let { snapshot, audit } = standaloneOriginAuditFixture();
  if (voided) {
    snapshot = correctLocalConfirmation({ snapshot, today: '2026-06-02', generationTimestamp: '2026-06-02T12:00:00.000Z',
      confirmationId: 'confirmed-original', expectedCorrectionId: null, replacement: null,
      reason: 'Retained void', idSeed: 'local-void' });
    audit = { ...audit, lastSequence: 2, origin: standaloneLedgerOrigin(snapshot, '2026-06-02T12:00:00.000Z') };
  }
  const replay = replayStandaloneLedgerOrigin({ origin: audit.origin, budgetId, utf8ByteLength: auditUtf8ByteLength });
  const parts = { settings: [snapshot.request.settings], ledger: replay.rows, 'ledger-audit': encodeLedgerAuditRecords(audit, upgraded),
    planning: Object.entries(snapshot.request.tables).filter(([name]) => !['future_transactions', 'projection_snapshots'].includes(name))
      .flatMap(([table, rows]) => rows.map(row => ({ table, row }))),
    'currency-events': [], fx: [], 'fx-snapshot': [{ snapshot: null }] };
  return { budgetId, epoch: '11111111-1111-4111-8111-111111111111', revision: 1, parts, auditHashes: receipts(parts),
    today: '2026-06-02', generationTimestamp: '2026-06-02T12:00:00.000Z', idSeed: 'origin-view' };
}

test('opted-in linked views retain empty signed openings and voided original installment identities', () => {
  const input = viewFixture(true);
  const view = prepareLinkedSnapshot(input, upgraded);
  assert.equal(view.request.openingBalance, 500);
  assert.equal(view.request.oneOffProgress[0][1].confirmedCount, 1);
  assert.equal(view.request.oneOffProgress[0][1].confirmedAmount, 0);
  assert.equal(view.linked.acceptedEvidence.originals[0].actorId, null);
  assert.equal(view.linked.acceptedEvidence.corrections[0].id, 'correction-local-void');
  assert.equal(new Map(view.linked.correctionHeads).get('confirmed-original'), 'correction-local-void');
  assert.throws(() => prepareLinkedSnapshot({ ...input, allowStandaloneOrigins: true }), /upgraded host/);
  assert.equal(JSON.parse(prepareLinkedSnapshotJson(JSON.stringify({ ...input, allowStandaloneOrigins: false }))).ok, true);
  assert.equal(prepareLinkedSnapshot({ ...viewFixture(), today: '2026-06-01' }, upgraded).request.openingBalance, 500);
  assert.equal(prepareLinkedSnapshot(viewFixture(), upgraded).request.openingBalance, 100);
});

test('origin-linked provisional confirmations and correction reviews use the verified offset once', () => {
  const input = viewFixture(true);
  input.parts.planning.push({ table: 'pending_transactions', row: { id: 'new-payment', name: 'New payment', amount: 20,
    currency: 'PLN', type: 'expense', date: '2026-06-02', ledger_currency: 'PLN', ledger_amount: 20,
    fx_rate: 1, buffered_fx_rate: 1, occurrence_key: 'manual:new-payment:expense:2026-06-02' } });
  const view = prepareLinkedSnapshot({ ...input, pending: [{ operationId: 'synthetic-preview', kind: 'occurrence.confirm',
    payload: { occurrenceKey: 'manual:new-payment:expense:2026-06-02', amount: 20, confirmedDate: '2026-06-02', fxRate: null } }] }, upgraded);
  assert.equal(view.request.openingBalance, 480);
  assert.deepEqual(view.linked.provisionalOperationIds, ['synthetic-preview']);
  assert.deepEqual(view.linked.acceptedAudit, linkedLedgerAudit(input.parts['ledger-audit'], budgetId, upgraded));
  const review = reviewLinkedCorrection({ ...input, payload: { targetId: 'confirmed-original',
    expectedCorrectionId: 'correction-local-void', replacement: { amount: 400, date: '2026-06-02' },
    reason: 'Restore original', retryOf: null } }, upgraded);
  assert.equal(review.status, 'accepted');
  assert.equal(review.after.amount, 400);
  assert.equal(reviewLinkedCorrection({ ...input, payload: { ...review.intent, replacement: { amount: 501, date: '2026-06-02' } } }, upgraded).status, 'blocked');
  assert.throws(() => reviewLinkedCorrection({ ...input, payload: review.intent }), /upgraded host/);
});
