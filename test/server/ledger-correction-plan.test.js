import assert from 'node:assert/strict';
import test from 'node:test';
import { planLedgerCorrection } from '../../src/server/cashflow-ledger-correction-plan.js';
import { replayLedgerAuditSnapshot } from '../../src/server/cashflow-ledger-audit-store.js';

const budgetId = 'correction-budget';
const today = '2026-10-22';
const createdAt = '2026-10-22T12:00:00.000Z';
/** Genuine normalized ledger facts, with dates deliberately years before review. */
function row(id, amount, type, date, extra = {}) {
  return { id, budget_id: budgetId, name: id, amount, type, date, confirmed_date: date,
    currency: 'PLN', ledger_currency: 'PLN', fx_rate: 1, buffered_fx_rate: 1,
    ledger_amount: amount, ledger_year: Number(date.slice(0, 4)), occurrence_key: `manual:${id}:${type}:${date}`,
    created_at: `${date}T12:00:00.000Z`, updated_at: `${date}T12:00:00.000Z`, running_balance_pln: 0, ...extra };
}
const income = row('income', 500, 'income', '2018-12-30');
const expense = row('expense', 400, 'expense', '2019-01-02');
const input = (extra = {}) => ({ budgetId, original: income, rows: [income, expense], expectedCorrectionId: null,
  currentCorrectionId: null, replacement: { amount: 450, date: income.date }, reason: 'Actual receipt was lower', today, createdAt, ...extra });

test('older correction retains identity/source/occurrence and rebuilds exact balances without mutating inputs', () => {
  const value = input(); const retained = structuredClone(value);
  const result = planLedgerCorrection(value);
  assert.equal(result.status, 'accepted');
  assert.equal(result.after.id, income.id);
  assert.equal(result.after.occurrence_key, income.occurrence_key);
  assert.equal(result.after.created_at, income.created_at);
  assert.equal(result.after.amount, 450);
  assert.equal(result.after.updated_at, createdAt);
  assert.deepEqual(result.balances.map(r => r.running_balance_pln), [450, 50]);
  assert.deepEqual(value, retained);
});

test('dependency failure retains an intention; explicit dependent correction permits retry', () => {
  const blocked = planLedgerCorrection(input({ replacement: { amount: 200, date: income.date } }));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.failureCode, 'history_overdraft');
  assert.deepEqual(blocked.blockingIds, [expense.id]);
  assert.equal(blocked.after, null); assert.deepEqual(blocked.balances, []);
  assert.deepEqual(blocked.requested, { amount: 200, date: income.date });
  const resolved = planLedgerCorrection(input({ original: expense, replacement: { amount: 100, date: expense.date } }));
  assert.equal(resolved.status, 'accepted');
  const retry = planLedgerCorrection(input({ rows: [income, resolved.after], replacement: blocked.requested }));
  assert.equal(retry.status, 'accepted');
  assert.deepEqual(retry.balances.map(r => r.running_balance_pln), [200, 100]);
});

test('void and restore keep the original identity and may cross ledger years', () => {
  const voided = planLedgerCorrection(input({ original: expense, replacement: null }));
  assert.equal(voided.status, 'accepted'); assert.equal(voided.after, null);
  const restored = planLedgerCorrection(input({ original: expense, rows: [income], currentCorrectionId: 'void-1',
    expectedCorrectionId: 'void-1', replacement: { amount: 200, date: '2020-01-03' } }));
  assert.equal(restored.after.id, expense.id); assert.equal(restored.after.ledger_year, 2020);
  assert.equal(restored.after.confirmed_date, '2020-01-03');
  assert.equal(restored.after.occurrence_key, expense.occurrence_key);
  assert.deepEqual(restored.balances.map(r => r.running_balance_pln), [500, 300]);
});

test('foreign corrections retain captured rates or explicitly re-enter them; no planning rates are consulted', () => {
  const foreign = row('foreign', 100, 'expense', '2019-01-02', { currency: 'EUR', fx_rate: 2, buffered_fx_rate: 2.2, ledger_amount: 220 });
  const kept = planLedgerCorrection(input({ original: foreign, rows: [income, foreign], replacement: { amount: 50, date: foreign.date } }));
  assert.equal(kept.after.fx_rate, 2); assert.equal(kept.after.buffered_fx_rate, 2.2); assert.equal(kept.after.ledger_amount, 110);
  const reentered = planLedgerCorrection(input({ original: foreign, rows: [income, foreign], replacement: { amount: 50, date: foreign.date, fx_rate: 3 } }));
  assert.equal(reentered.after.fx_rate, 3); assert.equal(reentered.after.buffered_fx_rate, 3); assert.equal(reentered.after.ledger_amount, 150);
  assert.equal(reentered.balances.at(-1).running_balance_pln, 350);
});

test('actual goal dates may follow deadlines while legacy policy and complete balances remain enforced', () => {
  const moved = planLedgerCorrection(input({ replacement: { amount: 500, date: '2020-01-01' } }));
  assert.equal(moved.failureCode, 'history_overdraft');
  const goal = row('goal', 100, 'expense', '2019-01-02', { source_goal_id: 'goal-source' });
  const lateInput = input({ original: goal, rows: [income, goal], replacement: { amount: 100, date: '2020-01-01' },
    sourceAtAcceptance: { table: 'goals', row: { id: 'goal-source', due_date: '2019-02-01' } } });
  assert.equal(planLedgerCorrection(lateInput).status, 'accepted');
  assert.equal(planLedgerCorrection({ ...lateInput, policyVersion: 1 }).failureCode, 'source_date');
  const restored = planLedgerCorrection({ ...lateInput, rows: [income], currentCorrectionId: 'void', expectedCorrectionId: 'void' });
  assert.equal(restored.status, 'accepted');
  assert.equal(restored.after.date, '2020-01-01');
  for (const policyVersion of [0, 3, '2', null]) assert.throws(() => planLedgerCorrection({ ...lateInput, policyVersion }));
});

test('stale heads, unsafe amounts, altered scope and arbitrary replacement fields are refused', () => {
  for (const extra of [{ expectedCorrectionId: 'unreviewed-head' }, { reason: '' },
    { replacement: { amount: 1.001, date: income.date } }, { replacement: { amount: 0, date: income.date } },
    { replacement: { amount: 1, date: '2027-01-01' } }, { replacement: { amount: 1, date: '2026-02-30' } },
    { replacement: { amount: 1, date: income.date, id: 'changed' } },
    { replacement: { amount: 1, date: income.date, fx_rate: 2 } },
    { rows: [income, { ...expense, budget_id: 'other-budget' }] },
    { rows: [income, { ...expense, id: income.id }] }, { original: { ...income, ledger_amount: 1 } },
    { original: { ...income, currency: 'pln' } }, { original: { ...income, source_goal_id: 0 } }]) {
    assert.throws(() => planLedgerCorrection(input(extra)));
  }
});

test('other ledger currencies are preserved and unrepresentable FX is blocked safely', () => {
  const other = row('other-ledger', 700, 'income', '2018-01-01', { currency: 'EUR', ledger_currency: 'EUR' });
  const result = planLedgerCorrection(input({ rows: [other, income, expense] }));
  assert.equal(result.status, 'accepted'); assert.equal(result.balances.length, 2);
  assert.ok(result.balances.every(r => r.ledger_currency === 'PLN'));
  const huge = row('huge-fx', 1, 'income', income.date, { currency: 'EUR', ledger_amount: 1 });
  assert.throws(() => planLedgerCorrection(input({ original: huge, rows: [huge], replacement: { amount: 9999999999.99, date: income.date, fx_rate: 1000000 } })));
});

test('a legitimate sub-cent foreign conversion remains zero without inventing a missing rate', () => {
  const small = row('small-fx', 0.01, 'expense', expense.date, { currency: 'EUR', fx_rate: 0.01, buffered_fx_rate: 0.01, ledger_amount: 0 });
  const result = planLedgerCorrection(input({ original: small, rows: [income, small], replacement: { amount: 0.02, date: small.date } }));
  assert.equal(result.status, 'accepted'); assert.equal(result.after.ledger_amount, 0);
  assert.equal(result.balances.at(-1).running_balance_pln, 500);
  const missing = { ...small }; delete missing.fx_rate; delete missing.buffered_fx_rate;
  assert.throws(() => planLedgerCorrection(input({ original: missing, rows: [income, missing], replacement: null })));
});

test('missing originals, impossible timestamps and mismatched captured source evidence are refused', () => {
  for (const extra of [{ rows: [expense] }, { createdAt: '2026-02-30T12:00:00Z' },
    { sourceAtAcceptance: { table: 'one_off_transactions', row: { id: 'unrelated-source' } } }]) {
    assert.throws(() => planLedgerCorrection(input(extra)));
  }
});

// Earlier compaction and zero-balance system entries can leave accepted zero
// facts. They must not prevent correction of a different historical payment.
test('accepted zero-value history does not block otherwise valid older corrections', () => {
  const zero = row('legacy-zero', 0, 'income', '2017-01-01', {
    occurrence_key: 'ledger_history_compaction:PLN:2017-01-01'
  });
  const value = input({ rows: [zero, income, expense] });
  const before = structuredClone(value);
  const result = planLedgerCorrection(value);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.balances.map(row => row.running_balance_pln), [0, 450, 50]);
  assert.deepEqual(value, before);
  assert.throws(() => planLedgerCorrection(input({ rows: [{ ...zero, amount: -1, ledger_amount: -1 }, income, expense] })));
  assert.throws(() => planLedgerCorrection(input({ replacement: { amount: 0, date: income.date } })));
});

// Portable evidence must not accept impossible partitions or sortable timestamps
// that the real normalized writer could never produce.
test('recorded ledger years and UTC timestamps must be valid before a correction can use them', () => {
  const invalid = [
    { ledger_year: 2019 }, { ledger_year: '2018' }, { ledger_year: 2018.5 },
    { created_at: 'not-a-time' }, { updated_at: '2018-02-30T12:00:00.000Z' },
    { created_at: '2018-12-30T24:00:00.000Z' }, { created_at: '2018-12-30T12:00:00' },
    { updated_at: null }
  ];
  for (const patch of invalid) {
    const malformed = { ...income, ...patch };
    assert.throws(() => planLedgerCorrection(input({ original: malformed, rows: [malformed, expense] })), undefined,
      `Malformed retained fact was accepted: ${JSON.stringify(patch)}`);
  }
});


test('review timestamps normalize to the same canonical representation as persisted facts', () => {
  const result = planLedgerCorrection(input({ createdAt: '2026-10-22T12:00:00Z' }));
  assert.equal(result.status, 'accepted');
  assert.equal(result.after.updated_at, createdAt);
  const repeated = planLedgerCorrection(input({ rows: [result.after, expense], currentCorrectionId: 'first-review',
    expectedCorrectionId: 'first-review', replacement: { amount: 500, date: income.date } }));
  assert.equal(repeated.status, 'accepted');
});


// A pristine baseline has no correction hash links to reject tampering for us:
// validation must reject malformed original facts on their own merits.
test('portable baseline replay refuses malformed facts even without correction hash links', () => {
  const { running_balance_pln: _derived, ...original } = income;
  const snapshot = { version: 1, budgetId, baselineComplete: true, lastSequence: 1,
    originals: [{ version: 1, budgetId, sequence: 1, captureKind: 'legacy', actorId: null,
      capturedAt: createdAt, row: original, sourceAtAcceptance: null }], corrections: [] };
  assert.equal(replayLedgerAuditSnapshot(snapshot, budgetId).rows.length, 1);
  for (const patch of [{ ledger_year: 2019 }, { ledger_year: '2018' }, { created_at: 'invalid' },
    { updated_at: '2018-02-30T12:00:00.000Z' }, { created_at: '2018-12-30T24:00:00.000Z' }]) {
    const malformed = structuredClone(snapshot);
    Object.assign(malformed.originals[0].row, patch);
    assert.throws(() => replayLedgerAuditSnapshot(malformed, budgetId));
  }
});

test('linked correction has no standalone dead end after a confirmed or voided currency conversion', () => {
  const earlier = row('earlier', 100, 'expense', expense.date);
  const conversion = row('conversion', 100, 'income', '2020-01-01', { currency: 'EUR', ledger_currency: 'EUR',
    occurrence_key: 'ledger_currency_conversion:conversion', note: 'Retained independent server conversion' });
  for (const confirmed of [true, false]) for (const replacement of [{ amount: 80, date: earlier.date }, null]) {
    const rows = [income, earlier, ...(confirmed ? [conversion] : [])];
    const before = structuredClone(rows);
    const result = planLedgerCorrection(input({ original: earlier, rows, replacement }));
    assert.equal(result.status, 'accepted');
    assert.equal(result.failureCode, null);
    assert.equal(result.balances.at(-1).running_balance_pln, replacement ? 420 : 500);
    assert.ok(result.balances.every(row => row.ledger_currency === 'PLN'));
    assert.deepEqual(rows, before, 'Server conversions remain independent accepted facts');
  }
});
