import assert from 'node:assert/strict';
import test from 'node:test';
import { completeSnapshot, reserveRequest } from './fixtures.js';
import { calculateSnapshot } from '../../src/engine/snapshot.js';
import { confirmLocalOccurrence, confirmLocalOccurrenceJson, refreshLocalSnapshot, correctLocalConfirmation, undoLocalConfirmation } from '../../src/engine/local-confirmation.js';
import { standaloneLedgerOrigin, replayStandaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
import { parseReserveTransferOccurrenceKey } from '../../src/engine/cashflow-occurrence-utils.js';

/** Real projection creates both rows; no hand-authored pending reserve can
 * authorize money. A goal in June competes with July's necessary bill. */
function fixture(today = '2026-06-01') {
  const snapshot = completeSnapshot();
  const request = reserveRequest();
  Object.assign(snapshot.request, request, { today, tables: { ...snapshot.request.tables, ...request.tables } });
  snapshot.budgetId = 'local-reserve';
  return snapshot;
}
const key = side => `reserve_transfer:2026-06:2026-07:${side}`;
const rows = snapshot => { const plan = calculateSnapshot(snapshot).plan; return [...plan.pendingRows, ...plan.futureRows]; };
const timing = (snapshot, idSeed) => ({ today: snapshot.request.today, generationTimestamp: `${snapshot.request.today}T12:00:00.000Z`, idSeed });
function confirm(snapshot, side, extra = {}) {
  return confirmLocalOccurrence({ snapshot, occurrenceKey: key(side), ...timing(snapshot, side), early: true, ...extra });
}
function correct(snapshot, id, replacement, idSeed, expectedCorrectionId = null) {
  return correctLocalConfirmation({ snapshot, confirmationId: id, replacement, reason: 'Review reserve payment',
    expectedCorrectionId, ...timing(snapshot, idSeed) });
}

for (const side of ['out', 'in']) test(`local reserve ${side} locks its counterpart and replays source-less audit`, () => {
  const snapshot = fixture();
  const before = JSON.stringify(snapshot);
  assert.equal(rows(snapshot).find(row => row.occurrence_key === key(side)).amount, 100);
  const accepted = confirm(snapshot, side, { amount: 80, actualDate: '2026-05-31' });
  assert.equal(JSON.stringify(snapshot), before);
  const row = accepted.localHistory[0];
  assert.deepEqual([row.type, row.amount, row.ledger_amount, row.date, row.confirmed_date],
    [side === 'out' ? 'expense' : 'income', 80, 80, '2026-05-31', '2026-06-01']);
  assert.equal(accepted.localAudit[0].source, null);
  const reopened = refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(accepted)), ...timing(accepted, 'reopen') });
  assert.deepEqual(reopened.localHistory, accepted.localHistory);
  assert.equal(rows(reopened).some(row => row.occurrence_key === key(side)), false);
  const other = side === 'out' ? 'in' : 'out';
  assert.equal(rows(reopened).find(row => row.occurrence_key === key(other)).amount, 80);
  const paired = confirm(reopened, other, { idSeed: 'paired' });
  assert.equal(rows(paired).some(row => row.occurrence_key.startsWith('reserve_transfer:')), false);
  assert.equal(paired.request.openingBalance, 150);
  const undone = undoLocalConfirmation({ snapshot: accepted, confirmationId: row.id, ...timing(accepted, 'undo') });
  assert.equal(undone.localHistory.length, 0);
  assert.equal(undone.localAudit.length, 2);
  assert.equal(rows(undone).find(row => row.occurrence_key === key(side)).amount, 100);
  const corrected = correct(accepted, row.id, { amount: 90, date: '2026-06-01' }, 'correct');
  assert.equal(corrected.localAudit[0].row.amount, 80);
  assert.equal(corrected.localHistory[0].amount, 90);
  assert.equal(rows(corrected).find(row => row.occurrence_key === key(other)).amount, 90);
  const restored = correct(undone, row.id, { amount: 85, date: '2026-06-01' }, 'restore', 'correction-undo');
  assert.equal(restored.localHistory[0].amount, 85);
});

test('local reserve due rows and JSON bridge use the normal confirmation command', () => {
  const snapshot = fixture('2026-06-30');
  snapshot.request.tables.goals[0].due_date = '2026-06-30';
  const response = JSON.parse(confirmLocalOccurrenceJson(JSON.stringify({ snapshot, occurrenceKey: key('out'), ...timing(snapshot, 'json') })));
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.snapshot.localHistory[0].date, '2026-06-30');
  const rolled = refreshLocalSnapshot({ snapshot: response.snapshot, today: '2026-07-01', generationTimestamp: '2026-07-01T12:00:00.000Z', idSeed: 'roll' });
  assert.equal(rows(rolled).find(row => row.occurrence_key === key('in')).amount, 100);
  const incoming = confirmLocalOccurrence({ snapshot: rolled, occurrenceKey: key('in'), ...timing(rolled, 'incoming') });
  assert.equal(incoming.localHistory.length, 2);
});

test('local reserve refusals preserve input and audit replay rejects corrupted evidence', () => {
  const snapshot = fixture();
  const before = JSON.stringify(snapshot);
  for (const extra of [{ early: false }, { amount: -1 }, { amount: 1.001 },
    { amount: 151 }, { actualDate: '2026-06-02' }, { fxRate: 2 }, { occurrenceKey: 'reserve_transfer:2026-07:2026-06:out' },
    { occurrenceKey: 'reserve_transfer:2026-06:2026-08:out' }]) {
    assert.throws(() => confirm(snapshot, 'out', extra));
    assert.equal(JSON.stringify(snapshot), before);
  }
  const accepted = confirm(snapshot, 'out');
  assert.throws(() => confirm(accepted, 'out', { idSeed: 'duplicate' }), /already confirmed/);
  for (const change of [row => { row.type = 'income'; }, row => { row.occurrence_key = 'reserve_transfer:2026-13:2026-14:out'; },
    row => { row.source_one_off_id = 'bill-1'; }, row => { row.fx_rate = 2; }, row => { row.ledger_amount = 1; }]) {
    const corrupt = structuredClone(accepted);
    change(corrupt.localAudit[0].row);
    assert.throws(() => refreshLocalSnapshot({ snapshot: corrupt, ...timing(corrupt, 'corrupt') }));
  }
  const blocked = correct(accepted, accepted.localHistory[0].id, { amount: 200, date: '2026-06-01' }, 'blocked');
  assert.equal(blocked.localAudit.at(-1).status, 'blocked');
  assert.equal(blocked.localHistory[0].amount, 100);
  const forged = structuredClone(blocked); forged.localAudit.at(-1).status = 'accepted';
  assert.throws(() => refreshLocalSnapshot({ snapshot: forged, ...timing(forged, 'forged') }), /dependencies/);
});

test('reserve identities accept monthly and income-anchored periods only', () => {
  for (const value of ['reserve_transfer:2026-06:2026-07:out', 'reserve_transfer:2026-06-10:2026-07-10:in']) assert.ok(parseReserveTransferOccurrenceKey(value));
  for (const value of ['reserve_transfer:2026-06:2026-06:out', 'reserve_transfer:2026-07:2026-06:in',
    'reserve_transfer:2026-02-30:2026-03-30:in', 'reserve_transfer:2026-06:2026-07-01:out', 'reserve_transfer:2026-13:2027-01:out']) assert.equal(parseReserveTransferOccurrenceKey(value), null);
});


test('reserve payments and corrections retain portable standalone origin evidence', () => {
  const accepted = confirm(fixture(), 'out', { amount: 80 });
  const snapshot = correct(accepted, accepted.localHistory[0].id, { amount: 90, date: '2026-06-01' }, 'portable');
  const origin = standaloneLedgerOrigin(snapshot, '2026-06-01T12:01:00.000Z');
  const replayed = replayStandaloneLedgerOrigin({ origin, budgetId: 'server-reserve', utf8ByteLength: value => Buffer.byteLength(value) });
  assert.equal(replayed.rows[0].amount, 90);
  assert.equal(replayed.originals.values().next().value.sourceAtAcceptance, null);
  assert.equal(replayed.corrections.size, 1);
});


test('income-anchored reserve halves confirm using full date period keys', () => {
  const snapshot = fixture('2026-06-10');
  snapshot.request.settings.budget_period_income_id = 'pay';
  snapshot.request.tables.recurring_incomes = [{ id: 'pay', name: 'Period income', currency: 'PLN', amount: 1,
    active: 1, period_setting: 1, anchor_type: 'day_of_month', anchor_day_of_month: 10, prediction_strategy: 'fixed',
    repeat_every_months: 1, anchor_business_day_adjustment: 'none' }];
  const occurrenceKey = 'reserve_transfer:2026-06-10:2026-07-10:in';
  assert.ok(rows(snapshot).some(row => row.occurrence_key === occurrenceKey));
  const accepted = confirmLocalOccurrence({ snapshot, occurrenceKey, early: true, amount: 80, ...timing(snapshot, 'anchor') });
  assert.equal(accepted.localHistory[0].type, 'income');
  assert.equal(rows(accepted).find(row => row.occurrence_key === 'reserve_transfer:2026-06-10:2026-07-10:out').amount, 80);
  assert.equal(refreshLocalSnapshot({ snapshot: accepted, ...timing(accepted, 'anchor-reopen') }).localHistory.length, 1);
});


for (const side of ['out', 'in']) test(`zero reserve ${side} is auditable and locks a zero counterpart like a browser amount override`, () => {
  const accepted = confirm(fixture(), side, { amount: 0 });
  const other = side === 'out' ? 'in' : 'out';
  assert.equal(accepted.localHistory[0].amount, 0);
  assert.equal(rows(accepted).find(row => row.occurrence_key === key(other)).amount, 0);
  const reopened = refreshLocalSnapshot({ snapshot: accepted, ...timing(accepted, 'zero-reopen') });
  const paired = confirm(reopened, other, { idSeed: 'zero-paired' });
  assert.equal(paired.localHistory.length, 2);
  assert.equal(paired.localHistory[1].amount, 0);
  assert.equal(rows(paired).some(row => row.occurrence_key.startsWith('reserve_transfer:')), false);
  const undone = undoLocalConfirmation({ snapshot: accepted, confirmationId: accepted.localLastConfirmationId, ...timing(accepted, 'zero-undo') });
  assert.equal(undone.localHistory.length, 0);
  assert.equal(rows(undone).find(row => row.occurrence_key === key(side)).amount, 100);
});
