import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { portableGoalPolicyFixture } from '../helpers/ledger-audit-fixtures.js';
import { canonicalAuditValue } from '../../src/engine/ledger-audit-json.js';
import { replayLedgerAuditSnapshot, copyLedgerAuditSnapshot, decodeLedgerAuditRecord } from '../../src/server/cashflow-ledger-audit-store.js';

const hash = value => createHash('sha256').update(JSON.stringify(canonicalAuditValue(value))).digest('hex');
/** Build recorded version-1 rejection and new version-2 reviews through the
 * same planner, retaining each original policy instead of rewriting its outcome. */
test('mixed goal policies retain old rejection, explicit retry, void/restoration and independent copy', () => {
  const audit = portableGoalPolicyFixture();
  assert.deepEqual(audit.corrections.map(event => event.version), [1, 2, 2, 2]);
  assert.deepEqual(audit.corrections.map(event => event.status), ['blocked', 'accepted', 'accepted', 'accepted']);
  assert.equal(audit.corrections[0].failureCode, 'source_date');
  assert.equal(audit.corrections[1].retryOf, 'old-rejection');
  const prefix = { ...audit, corrections: audit.corrections.slice(0, 1), lastSequence: 3 };
  assert.equal(replayLedgerAuditSnapshot(prefix, audit.budgetId).rows.find(row => row.id === 'expense').amount, 400);
  for (const event of audit.corrections) {
    const stored = { budget_id: audit.budgetId, id: event.id, payment_id: event.targetId, sequence_number: event.sequence,
      status: event.status, data_json: JSON.stringify(event), record_hash: hash(event) };
    assert.deepEqual(decodeLedgerAuditRecord(audit.budgetId, stored, 'correction'), event);
  }
  const result = replayLedgerAuditSnapshot(JSON.parse(JSON.stringify(audit)), audit.budgetId);
  assert.equal(result.rows.find(row => row.id === 'expense').date, '2020-01-02');
  const copied = copyLedgerAuditSnapshot(audit, 'independent-goal-copy');
  assert.deepEqual(copied.corrections.map(event => event.version), [1, 2, 2, 2]);
  assert.equal(replayLedgerAuditSnapshot(copied, copied.budgetId).rows.find(row => row.id === 'expense').amount, 250);
  for (const version of [0, 3, '2', null]) {
    const malformed = structuredClone(audit); malformed.corrections.at(-1).version = version;
    assert.throws(() => replayLedgerAuditSnapshot(malformed, audit.budgetId));
  }
  const reinterpreted = structuredClone(audit); reinterpreted.corrections[0].version = 2;
  assert.throws(() => replayLedgerAuditSnapshot(reinterpreted, audit.budgetId), /financial replay/);
});
