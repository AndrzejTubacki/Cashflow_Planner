import assert from 'node:assert/strict';
import test from 'node:test';
import { completeSnapshot } from './fixtures.js';
import { calculateSnapshot } from '../../src/engine/snapshot.js';
import { confirmLocalOccurrence, correctLocalConfirmation, refreshLocalSnapshot } from '../../src/engine/local-confirmation.js';
import { standaloneLedgerOrigin, replayStandaloneLedgerOrigin, STANDALONE_ORIGIN_SOURCE_FIELDS } from '../../src/engine/standalone-ledger-origin.js';
import { POSTGRES_BUDGET_COLUMNS } from '../../src/server/cashflow-postgres-budget-schema.js';

const timing = { today: '2026-06-02', generationTimestamp: '2026-06-02T12:00:00.000Z', idSeed: 'origin-replay' };
const budgetId = 'server-origin-replay';
const replay = origin => replayStandaloneLedgerOrigin({ origin, budgetId, utf8ByteLength: text => Buffer.byteLength(text) });

/** Genuine accepted source/payment events, followed by a real dependency
 * refusal. No claimed balance or imported server actor supplies authority. */
function source() {
  let snapshot = completeSnapshot();
  Object.assign(snapshot, { budgetId: 'local-origin-replay', name: 'Synthetic origin' });
  Object.assign(snapshot.request, timing, { openingBalance: 0 });
  snapshot.request.tables.one_off_transactions = [
    { id: 'income', name: 'Income', currency: 'PLN', amount: 500, type: 'income', date: '2026-06-01' },
    { id: 'expense', name: 'Expense', currency: 'PLN', amount: 400, type: 'expense', date: timing.today }];
  for (const id of ['income', 'expense']) {
    const plan = calculateSnapshot(snapshot).plan;
    const row = [...plan.pendingRows, ...plan.futureRows].find(row => row.source_one_off_id === id);
    snapshot = confirmLocalOccurrence({ snapshot, ...timing, idSeed: id, occurrenceKey: row.occurrence_key });
  }
  return correctLocalConfirmation({ snapshot, ...timing, confirmationId: 'confirmed-income', expectedCorrectionId: null,
    replacement: { amount: 200, date: '2026-06-01' }, reason: 'Recorded refusal', idSeed: 'blocked' });
}

test('portable origin replays complete evidence, maps actual dates and retains immutable heads and blocked intentions', () => {
  const snapshot = source();
  const origin = standaloneLedgerOrigin(snapshot, timing.generationTimestamp);
  const original = structuredClone(origin);
  const result = replay(origin);
  assert.deepEqual(result.balances.map(row => [row.id, row.running_balance_pln]), [['confirmed-income', 500], ['confirmed-expense', 100]]);
  assert.deepEqual([...result.heads], [['confirmed-income', null], ['confirmed-expense', null]]);
  assert.equal(result.originals.get('confirmed-income').row.confirmed_date, '2026-06-01');
  assert.equal(result.origin.events[0].row.confirmed_date, timing.today);
  assert.equal(result.originals.get('confirmed-income').actorId, null);
  assert.equal(result.originals.get('confirmed-income').captureKind, 'standalone');
  assert.equal(result.corrections.get('correction-blocked').status, 'blocked');
  assert.equal(result.lastSequence, 3);
  result.rows[0].amount = 1;
  assert.deepEqual(origin, original);
  assert.equal(result.origin.events[0].row.amount, 500);
});

test('portable origin retains empty signed openings and fully voided original identities', () => {
  const empty = completeSnapshot();
  Object.assign(empty, { budgetId: 'local-empty-origin', name: 'Empty signed opening' });
  empty.request.tables.one_off_transactions = [];
  Object.assign(empty.request, timing, { openingBalance: -50 });
  const signed = replay(standaloneLedgerOrigin(refreshLocalSnapshot({ snapshot: empty, ...timing }), timing.generationTimestamp));
  assert.deepEqual(signed.opening, { ledgerCurrency: 'PLN', amount: -50 });
  assert.deepEqual(signed.rows, []);
  assert.equal(signed.lastSequence, 0);
  const snapshot = source();
  const voided = correctLocalConfirmation({ snapshot, ...timing, idSeed: 'void', confirmationId: 'confirmed-expense',
    expectedCorrectionId: null, replacement: null, reason: 'Void accepted expense' });
  const result = replay(standaloneLedgerOrigin(voided, timing.generationTimestamp));
  assert.equal(result.originals.size, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.heads.get('confirmed-expense'), 'correction-void');
  assert.equal(result.corrections.get('correction-void').before.amount, 400);
  assert.equal(result.corrections.get('correction-void').after, null);
});

test('portable source column bounds match the registered financial database schema', () => {
  for (const [table, columns] of Object.entries(STANDALONE_ORIGIN_SOURCE_FIELDS)) {
    assert.deepEqual([...columns].sort(), [...POSTGRES_BUDGET_COLUMNS[table]].sort(), table);
  }
});

test('portable origin refuses altered financial outcomes, foreign evidence and unsupported metadata', () => {
  const origin = standaloneLedgerOrigin(source(), timing.generationTimestamp);
  for (const mutate of [
    value => { value.events.at(-1).status = 'accepted'; },
    value => { value.events[0].row.amount = 999; },
    value => { value.events[0].source.row.budget_id = 'foreign-budget'; },
    value => { value.events[0].source.row.accessToken = 'synthetic-forbidden'; },
    value => { value.events[0].row.accessToken = 'synthetic-forbidden'; },
    value => { value.events.at(-1).requested.token = 'synthetic-forbidden'; },
    value => { value.events.at(-1).reason = { nested: {} }; },
    value => { value.accessToken = 'synthetic-forbidden'; },
    value => { value.version = 2; }, value => { value.legacyCount = -1; },
    value => { value.sourceRevision = 1.5; }, value => { value.openingBalance = '500'; },
    value => { value.ledgerCurrency = 'pln'; }, value => { value.materializedAt = '2026-06-02 12:00:00'; }
  ]) {
    const changed = structuredClone(origin); mutate(changed);
    assert.throws(() => replay(changed));
  }
  assert.throws(() => replayStandaloneLedgerOrigin({ origin, budgetId: 'local-foreign', utf8ByteLength: text => Buffer.byteLength(text) }));
  assert.throws(() => replayStandaloneLedgerOrigin({ origin, budgetId }));
});

test('portable origin bounds replay work and encoded bytes before financial replay', () => {
  const origin = standaloneLedgerOrigin(source(), timing.generationTimestamp);
  const many = { ...origin, events: Array.from({ length: 7072 }, () => ({ kind: 'payment' })) };
  assert.throws(() => replay(many), /work limit/);
  const large = structuredClone(origin);
  large.events[0].row.note = 'a'.repeat(10 * 1024 * 1024);
  assert.throws(() => replay(large), /10 MB/);
});
