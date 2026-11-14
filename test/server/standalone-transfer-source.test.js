import assert from 'node:assert/strict';
import test from 'node:test';
import { completeSnapshot } from '../engine/fixtures.js';
import { calculateSnapshot } from '../../src/engine/snapshot.js';
import { confirmLocalOccurrence, correctLocalConfirmation, refreshLocalSnapshot } from '../../src/engine/local-confirmation.js';
import { STANDALONE_TRANSFER_MAX_BYTES, validateStandaloneTransferSource } from '../../src/server/cashflow-standalone-transfer-source.js';

const timing = { today: '2026-06-02', generationTimestamp: '2026-06-02T12:00:00.000Z', idSeed: 'transfer-review' };
/** Only genuine standalone engine acceptances enter these fixtures. No server
 * allocation, copied budget, account, credential or database is involved. */
function initial(opening = 500) {
  const snapshot = completeSnapshot();
  Object.assign(snapshot, { budgetId: 'local-transfer-source', name: 'Transfer source' });
  Object.assign(snapshot.request, timing, { openingBalance: opening });
  snapshot.request.tables.one_off_transactions = [];
  return snapshot;
}
function confirm(snapshot, sourceId, idSeed, amount) {
  const plan = calculateSnapshot(snapshot).plan;
  const row = [...plan.pendingRows, ...plan.futureRows].find(value => ['source_one_off_id', 'source_recurring_income_id',
    'source_recurring_expense_id', 'source_goal_id', 'source_flex_id'].some(field => value[field] === sourceId));
  return confirmLocalOccurrence({ snapshot, ...timing, idSeed, occurrenceKey: row.occurrence_key,
    ...(row.date > timing.today ? { early: true } : {}), ...(amount === undefined ? {} : { amount }) });
}
function correct(snapshot, target, replacement, idSeed, extra = {}) {
  return correctLocalConfirmation({ snapshot, ...timing, confirmationId: `confirmed-${target}`, replacement,
    expectedCorrectionId: null, reason: 'Reviewed original payment', idSeed, ...extra });
}
const review = snapshot => validateStandaloneTransferSource(JSON.stringify(snapshot), timing);

test('transfer preflight separates signed original opening and current balance without inventing payments', () => {
  for (const opening of [500, 0, -50]) {
    const result = review(initial(opening));
    assert.equal(result.originalOpeningBalance, opening);
    assert.equal(result.confirmedBalance, opening);
    assert.equal(result.originalPayments.length, 0);
    assert.equal(result.effectivePayments.length, 0);
    assert.equal(result.snapshot.snapshotVersion, 2);
  }
  const source = initial();
  source.request.tables.one_off_transactions.push({ id: 'expense', name: 'Partial bill', type: 'expense', amount: 300, currency: 'PLN', date: timing.today });
  const accepted = confirm(source, 'expense', 'partial', 100);
  const original = JSON.stringify(accepted);
  const result = review(accepted);
  assert.equal(result.originalOpeningBalance, 500);
  assert.equal(result.confirmedBalance, 400);
  assert.equal(result.originalPayments.length, 1);
  assert.equal(result.oneOffProgress[0][1].confirmedAmount, 100);
  assert.equal(JSON.stringify(accepted), original);
  const signed = initial(-50);
  signed.request.tables.one_off_transactions.push({ id: 'income', name: 'Cover signed opening', type: 'income', amount: 100, currency: 'PLN', date: timing.today });
  const funded = review(confirm(signed, 'income', 'signed-income'));
  assert.equal(funded.originalOpeningBalance, -50);
  assert.equal(funded.confirmedBalance, 50);
});

test('transfer retains voided installment provenance while recomputing paid money only from effective facts', () => {
  const source = initial();
  source.request.tables.one_off_transactions.push({ id: 'expense', name: 'Installments', type: 'expense', amount: 300, currency: 'PLN', date: timing.today });
  const first = confirm(source, 'expense', 'first', 100);
  const voided = correct(first, 'first', null, 'void');
  const empty = review(voided);
  assert.equal(empty.confirmedBalance, 500);
  assert.equal(empty.originalPayments.length, 1);
  assert.equal(empty.effectivePayments.length, 0);
  assert.equal(empty.oneOffProgress[0][1].confirmedCount, 1);
  assert.equal(empty.oneOffProgress[0][1].confirmedAmount, 0);
  const result = review(confirm(voided, 'expense', 'second', 100));
  assert.equal(result.originalPayments.length, 2);
  assert.equal(result.effectivePayments[0].occurrence_key, 'one_off_remainder:expense:2');
  assert.equal(result.oneOffProgress[0][1].confirmedCount, 2);
  assert.equal(result.oneOffProgress[0][1].confirmedAmount, 100);
  assert.equal(result.confirmedBalance, 400);
});

test('transfer keeps blocked audit intentions and captured source evidence after prospective deletion', () => {
  const source = initial(0);
  source.request.tables.one_off_transactions.push(
    { id: 'income', name: 'Income', type: 'income', amount: 500, currency: 'PLN', date: '2026-06-01' },
    { id: 'expense', name: 'Expense', type: 'expense', amount: 400, currency: 'PLN', date: timing.today });
  const accepted = confirm(confirm(source, 'income', 'income'), 'expense', 'expense');
  const blocked = correct(accepted, 'income', { amount: 200, date: '2026-06-01' }, 'blocked');
  blocked.request.tables.one_off_transactions = [];
  const result = review(blocked);
  assert.equal(result.confirmedBalance, 100);
  assert.equal(result.snapshot.localAudit.at(-1).status, 'blocked');
  assert.deepEqual(result.snapshot.localAudit, blocked.localAudit);
  assert.equal(result.originalPayments[0].source.row.amount, 500);
  assert.equal(result.snapshot.request.tables.one_off_transactions.length, 0);
});

test('transfer preserves actual and capture dates and historical FX independently of current planning rates', () => {
  const source = initial(1000);
  source.request.fxSnapshot = { 'eur/pln': { rate: 4.2, source: 'manual', effectiveDate: '2026-06-01' } };
  source.request.tables.one_off_transactions.push({ id: 'foreign', name: 'Foreign bill', type: 'expense', amount: 100, currency: 'EUR', date: '2020-12-31' });
  const accepted = confirm(source, 'foreign', 'foreign');
  accepted.request.fxSnapshot['eur/pln'].rate = 5;
  const result = review(accepted);
  assert.equal(result.confirmedBalance, 580);
  assert.equal(result.effectivePayments[0].fx_rate, 4.2);
  assert.equal(result.effectivePayments[0].date, '2020-12-31');
  assert.equal(result.effectivePayments[0].ledger_year, 2020);
  assert.equal(result.effectivePayments[0].confirmed_date, timing.today);
  assert.equal(result.snapshot.request.fxSnapshot['eur/pln'].rate, 5);
});

test('transfer preflight retains recurring prediction history and effective goal/flex funding', () => {
  const source = initial();
  const recurring = { currency: 'PLN', active: 1, prediction_strategy: 'fixed', repeat_every_months: 1,
    anchor_type: 'day_of_month', anchor_day_of_month: 1, anchor_business_day_adjustment: 'none' };
  source.request.tables.recurring_incomes = [{ ...recurring, id: 'salary', name: 'Salary', amount: 600,
    prediction_strategy: '12month_min', prediction_substitute_missing: 'last_confirmed' }];
  source.request.tables.planned_transactions = [{ id: 'rent-plan', operating_priority: 1 },
    { id: 'goal-plan', goal_priority: 1 }, { id: 'flex-plan', operating_priority: 2 }];
  source.request.tables.recurring_expenses = [{ ...recurring, id: 'rent', name: 'Rent', amount: 100,
    necessary: 1, planned_transaction_id: 'rent-plan' }];
  source.request.tables.goals = [{ id: 'goal', name: 'Goal', amount: 200, currency: 'PLN', active: 1,
    due_date: '2026-06-20', planned_transaction_id: 'goal-plan' }];
  source.request.tables.flex_transactions = [{ id: 'flex', name: 'Split flex', amount: 100, currency: 'PLN', active: 1,
    allow_split: 1, min_amount: 10, max_amount: 30, planned_transaction_id: 'flex-plan' }];
  let accepted = source;
  for (const id of ['salary', 'rent', 'goal', 'flex']) accepted = confirm(accepted, id, id);
  accepted.request.tables.recurring_incomes[0].amount = 5;
  const result = review(accepted);
  assert.equal(result.originalPayments.length, 4);
  assert.equal(result.effectivePayments.find(row => row.source_recurring_income_id === 'salary').amount, 600);
  for (const [field, id] of [['source_goal_id', 'goal'], ['source_flex_id', 'flex']]) {
    const amount = result.effectivePayments.find(row => row[field] === id).ledger_amount;
    assert.ok(amount > 0);
    assert.equal(new Map(result.confirmedFunding[field]).get(id), amount);
  }
  assert.ok(calculateSnapshot(result.snapshot).plan.futureRows.some(row => row.source_recurring_income_id === 'salary' && row.amount === 600));
});

test('transfer recomputes aggregate claims and refuses altered financial mirrors before any allocation', () => {
  const source = initial();
  source.request.tables.one_off_transactions.push({ id: 'expense', name: 'Bill', type: 'expense', amount: 300, currency: 'PLN', date: timing.today });
  const accepted = confirm(source, 'expense', 'first', 100);
  const forged = structuredClone(accepted);
  forged.request.openingBalance = 999999;
  forged.request.oneOffProgress[0][1].confirmedAmount = 299;
  assert.equal(review(forged).confirmedBalance, 400);
  assert.equal(review(forged).oneOffProgress[0][1].confirmedAmount, 100);
  for (const mutate of [value => { value.localHistory[0].amount = 1; },
    value => { value.localAudit[0].row.ledger_amount = 1; },
    value => { value.request.predictionRows = []; },
    value => { value.request.confirmedRowsAfterToday = [value.localHistory[0]]; },
    value => { value.request.tables.one_off_transactions[0].budget_id = 'another-budget'; }]) {
    const altered = structuredClone(accepted); mutate(altered);
    assert.throws(() => review(altered));
  }
});

test('transfer refuses credentials, private settings, unknown nested metadata and generated workflow authority', () => {
  const source = refreshLocalSnapshot({ snapshot: initial(), ...timing });
  for (const mutate of [value => { value.accessToken = 'synthetic-forbidden-token'; },
    value => { value.request.settings.ntfy_auth_token = 'synthetic-private-setting'; },
    value => { value.request.settings.timezone = { accessToken: 'synthetic-hidden-token' }; },
    value => { value.request.settings.manual_fx_rates = { accessToken: 'synthetic-hidden-token' }; },
    value => { value.request.tables.projection_snapshots.push({ balance: 1000000 }); },
    value => { value.request.tables.one_off_transactions.push({ id: 'extra', name: 'Unknown', amount: 1, type: 'income', currency: 'PLN', date: timing.today, credentials: {} }); }]) {
    const altered = structuredClone(source); mutate(altered);
    assert.throws(() => review(altered));
  }
  assert.throws(() => validateStandaloneTransferSource(' '.repeat(STANDALONE_TRANSFER_MAX_BYTES + 1), timing), /10 MB/);
  const different = structuredClone(source); different.budgetId = 'remote-budget';
  assert.throws(() => review(different), /identity/);
});

test('transfer bounds audit replay work before visiting oversized malformed evidence', () => {
  const source = refreshLocalSnapshot({ snapshot: initial(), ...timing });
  // Repeated tiny incomplete events stay below the byte bound. They must hit
  // the work guard before row validation or quadratic financial replay starts.
  source.localAudit = Array.from({ length: 7072 }, () => ({ kind: 'payment' }));
  assert.throws(() => review(source), /replay work limit/);
});
