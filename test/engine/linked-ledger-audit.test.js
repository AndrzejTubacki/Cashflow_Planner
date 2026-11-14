import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { portableLinkedInstallmentCommand } from '../helpers/ledger-audit-fixtures.js';
import { prepareLinkedLedgerAuditHashes, verifyLinkedLedgerAudit } from '../../src/engine/linked-ledger-audit.js';
import { prepareLinkedSnapshot } from '../../src/engine/linked-snapshot.js';
import { calculateSnapshot } from '../../src/engine/snapshot.js';
import { LEDGER_AUDIT_FACT_FIELDS } from '../../src/engine/ledger-audit-fact.js';
import { POSTGRES_BUDGET_COLUMNS } from '../../src/server/cashflow-postgres-budget-schema.js';

/** The owning host computes every digest over the canonical requested text. */
function withHashes(command = portableLinkedInstallmentCommand()) {
  const { texts } = prepareLinkedLedgerAuditHashes(command);
  return { ...command, auditHashes: texts.map(text => [text, createHash('sha256').update(text).digest('hex')]) };
}

test('portable audit normalization keeps the complete runtime ledger field contract', () => {
  assert.deepEqual(LEDGER_AUDIT_FACT_FIELDS, POSTGRES_BUDGET_COLUMNS.confirmed_transactions);
});

test('linked state retains originals, blocked/retried/voided history and original installment identities', () => {
  const command = withHashes();
  const before = structuredClone(command);
  const snapshot = prepareLinkedSnapshot(command);
  assert.equal(snapshot.linked.acceptedAudit.originals.length, 2);
  assert.deepEqual(snapshot.linked.acceptedAudit.corrections.map(event => event.status), ['blocked', 'accepted', 'accepted']);
  assert.equal(snapshot.request.openingBalance, 450);
  assert.equal(snapshot.request.oneOffProgress[0][1].confirmedCount, 7);
  assert.equal(snapshot.request.oneOffProgress[0][1].confirmedAmount, 0);
  assert.deepEqual(command, before);
});

test('provisional confirmations advance beyond retained voided ordinals without rewriting accepted evidence', () => {
  const command = withHashes();
  command.pending.push({ operationId: 'new-payment', kind: 'occurrence.confirm', payload: {
    occurrenceKey: 'one_off_remainder:desk:8', amount: 100, confirmedDate: command.today, fxRate: null } });
  const snapshot = prepareLinkedSnapshot(command);
  assert.equal(snapshot.request.openingBalance, 350);
  assert.equal(snapshot.request.oneOffProgress[0][1].confirmedCount, 8);
  assert.equal(snapshot.request.oneOffProgress[0][1].confirmedAmount, 100);
  assert.equal(snapshot.linked.acceptedAudit.lastSequence, 5);
  const remainder = calculateSnapshot(snapshot).plan.pendingRows.find(row => row.source_one_off_id === 'desk');
  assert.equal(remainder.occurrence_key, 'one_off_remainder:desk:9');
  assert.equal(remainder.requested_amount, 300);
});

test('provisional work cannot recycle a voided payment identity or cross-kind historical source identity', () => {
  const command = withHashes();
  command.parts.planning.find(record => record.table === 'pending_transactions').row.id = 'expense';
  command.pending.push({ operationId: 'reused-payment', kind: 'occurrence.confirm', payload: {
    occurrenceKey: 'one_off_remainder:desk:8', amount: 100, confirmedDate: command.today, fxRate: null } });
  const snapshot = prepareLinkedSnapshot(command);
  assert.deepEqual(snapshot.linked.unapplied, [{ operationId: 'reused-payment', reason: 'ALREADY_CONFIRMED' }]);
  assert.equal(snapshot.request.predictionRows.length, 1);
  const id = '33333333-3333-4333-8333-333333333333';
  const alias = withHashes(portableLinkedInstallmentCommand(id));
  alias.parts.planning = [];
  alias.pending.push({ operationId: 'reused-source', kind: 'goal.create', payload: {
    id, name: 'Reused source', currency: 'PLN', amount: 100, active: true, priority: 1, due_date: '2026-12-31' } });
  const refused = prepareLinkedSnapshot(alias);
  assert.deepEqual(refused.linked.unapplied, [{ operationId: 'reused-source', reason: 'SOURCE_EXISTS' }]);
  assert.equal(refused.request.tables.goals.length, 0);
});

test('linked download validation refuses incomplete, foreign and financially mismatched audit records', () => {
  for (const mutate of [
    command => { delete command.parts['ledger-audit']; },
    command => { command.parts['ledger-audit'].pop(); },
    command => { command.parts['ledger-audit'].push(command.parts['ledger-audit'][0]); },
    command => { command.parts['ledger-audit'][0].value.budgetId = 'foreign-budget'; },
    command => { command.parts['ledger-audit'][1].extra = 'cannot drop'; },
    command => { command.parts.ledger[0].name = 'Edited outside the audit'; },
    command => { command.auditHashes = []; }
  ]) {
    const command = withHashes(); mutate(command);
    assert.throws(() => prepareLinkedSnapshot(command));
    assert.throws(() => verifyLinkedLedgerAudit(command));
  }
});
