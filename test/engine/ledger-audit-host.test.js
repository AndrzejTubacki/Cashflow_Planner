import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { portableLedgerAuditFixture } from '../helpers/ledger-audit-fixtures.js';
import { auditUtf8ByteLength, prepareLedgerAuditHashes, prepareLedgerAuditHashesJson,
  replayLedgerAuditFromHost, replayLedgerAuditFromHostJson } from '../../src/engine/ledger-audit-host.js';

/** A host computes every digest itself over the engine's canonical strings. */
function hostRequest(audit = portableLedgerAuditFixture()) {
  const { texts } = prepareLedgerAuditHashes({ audit, budgetId: audit.budgetId });
  return { audit, budgetId: audit.budgetId, hashes: texts.map(text => [text, createHash('sha256').update(text).digest('hex')]) };
}

test('portable UTF-8 byte counting agrees with the host for ASCII, Polish, emoji and lone surrogates', () => {
  for (const text of ['', 'abc', 'Zażółć gęślą jaźń', '🪙💰', '\ud800', '\udfff', '\ud800a', '\ud800\ud800\udc00', 'a'.repeat(1024)]) {
    assert.equal(auditUtf8ByteLength(text), Buffer.byteLength(text));
  }
  assert.throws(() => auditUtf8ByteLength(3));
});

test('native hash preparation and replay retain blocked intentions, accepted retry and immutable originals', () => {
  const input = hostRequest();
  const before = structuredClone(input);
  const result = replayLedgerAuditFromHost(input);
  assert.deepEqual(result.rows.map(row => [row.id, row.amount]), [['income', 450], ['expense', 400]]);
  assert.deepEqual(result.heads, [['income', 'retry'], ['expense', null]]);
  assert.deepEqual(result.corrections.map(event => event.status), ['blocked', 'accepted']);
  assert.equal(result.originals[0].row.amount, 500);
  assert.deepEqual(input, before);
  assert.equal(JSON.parse(replayLedgerAuditFromHostJson(JSON.stringify(input))).ok, true);
});

test('native audit replay rejects missing, duplicated, wrong and foreign hash receipts and forged outcomes', () => {
  for (const mutate of [
    input => { input.hashes = []; },
    input => { input.hashes.push(input.hashes[0]); },
    input => { input.hashes = input.hashes.map(([text]) => [text, '0'.repeat(64)]); },
    input => { input.hashes[0][1] = 'not-a-digest'; },
    input => { input.budgetId = 'foreign-budget'; },
    input => { input.audit.corrections[0].status = 'accepted'; },
    input => { input.audit.originals[0].row.amount = 600; }
  ]) {
    const input = hostRequest(); mutate(input);
    assert.throws(() => replayLedgerAuditFromHost(input));
    const result = JSON.parse(replayLedgerAuditFromHostJson(JSON.stringify(input)));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'LEDGER_AUDIT_REPLAY_REJECTED');
  }
  assert.equal(JSON.parse(prepareLedgerAuditHashesJson('not JSON')).ok, false);
  const audit = portableLedgerAuditFixture();
  assert.throws(() => prepareLedgerAuditHashes({ audit, budgetId: 'foreign-budget' }));
});
