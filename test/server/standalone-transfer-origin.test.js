import assert from 'node:assert/strict';
import test from 'node:test';
import { completeSnapshot, localCommandFixtures } from '../engine/fixtures.js';
import { calculateSnapshot } from '../../src/engine/snapshot.js';
import { prepareSnapshot } from '../../src/engine/prepare-snapshot.js';
import { confirmLocalOccurrence, correctLocalConfirmation, refreshLocalSnapshot } from '../../src/engine/local-confirmation.js';
import { prepareStandaloneTransferOrigin } from '../../src/server/cashflow-standalone-transfer-origin.js';
import { standaloneTransferDestination } from '../../src/server/cashflow-standalone-transfer-record.js';

const budgetId = 'budget_1960951c-623a-8e4c-a789-6660bdc8f329';
const timing = { today: '2026-06-02', generationTimestamp: '2026-06-02T12:00:00.000Z', idSeed: 'origin' };

/** Build real standalone history, rather than inserting purported financial
 * results. All fixtures are synthetic and need no accounts or databases. */
function initial(openingBalance = 500) {
  const value = completeSnapshot();
  Object.assign(value, { budgetId: 'local-origin', name: 'Independent source' });
  Object.assign(value.request, timing, { openingBalance });
  value.request.tables.one_off_transactions = [];
  return value;
}
function confirm(snapshot, sourceId, idSeed, amount) {
  const plan = calculateSnapshot(snapshot).plan;
  const row = [...plan.pendingRows, ...plan.futureRows].find(value => ['source_one_off_id', 'source_recurring_income_id',
    'source_recurring_expense_id', 'source_goal_id', 'source_flex_id'].some(key => value[key] === sourceId));
  assert.ok(row, `Missing allocation ${sourceId}`);
  return confirmLocalOccurrence({ snapshot, ...timing, idSeed, occurrenceKey: row.occurrence_key,
    ...(row.date > timing.today ? { early: true } : {}), ...(amount === undefined ? {} : { amount }) });
}
function correction(snapshot, target, replacement, idSeed, extra = {}) {
  return correctLocalConfirmation({ snapshot, ...timing, confirmationId: `confirmed-${target}`, replacement,
    expectedCorrectionId: null, reason: 'Reviewed source evidence', idSeed, ...extra });
}
function prepare(snapshot, overrides = {}) {
  return prepareStandaloneTransferOrigin({ sourceJson: JSON.stringify(snapshot), budgetId, ...timing, ...overrides });
}

/** Compare complete calculated plans, not just balances. Only a budget_id
 * scope column can differ; source IDs, occurrence IDs, dates, money, rates,
 * summaries, prediction results and diagnostics must remain identical. */
function financial(value) {
  if (Array.isArray(value)) return value.map(financial);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'budget_id').map(([key, item]) => [key, financial(item)]));
}
function equivalent(result) {
  const source = result.sourceSnapshot;
  assert.deepEqual(financial(result.calculation.plan), financial(calculateSnapshot(source).plan));
  for (const key of ['openingBalance', 'handledOccurrenceKeys', 'oneOffProgress', 'confirmedFunding']) {
    assert.deepEqual(result.snapshot.request[key], source.request[key], key);
  }
  assert.equal(result.snapshot.budgetId, budgetId);
  assert.equal(result.snapshot.snapshotVersion, 1);
  for (const rows of Object.values(result.snapshot.request.tables)) for (const row of rows) assert.equal(row.budget_id, budgetId);
}

test('origin projection retains signed openings without inventing a payment or counting history twice', () => {
  for (const opening of [-50, 0, 500]) {
    const result = prepare(initial(opening));
    equivalent(result);
    assert.deepEqual(result.opening, { ledgerCurrency: 'PLN', amount: opening });
    assert.deepEqual(result.confirmedRows, []);
    assert.deepEqual(result.originals, []);
  }
  const source = initial(-50);
  source.request.tables.one_off_transactions.push({ id: 'income', name: 'Cover opening', type: 'income', amount: 100, currency: 'PLN', date: timing.today });
  const result = prepare(confirm(source, 'income', 'income'));
  equivalent(result);
  assert.equal(result.opening.amount, -50);
  assert.equal(result.confirmedRows[0].running_balance_pln, 50);
  assert.equal(result.snapshot.request.openingBalance, 50);
});

test('origin projection retains voided installment reservations and lossless correction proof', () => {
  const source = initial();
  source.request.tables.one_off_transactions.push({ id: 'bill', name: 'Partial bill', type: 'expense', amount: 300, currency: 'PLN', date: timing.today });
  const first = confirm(source, 'bill', 'first', 100);
  const voided = correction(first, 'first', null, 'void');
  const empty = prepare(voided);
  equivalent(empty);
  assert.equal(empty.originals.length, 1);
  assert.equal(empty.confirmedRows.length, 0);
  assert.equal(empty.snapshot.request.oneOffProgress[0][1].confirmedCount, 1);
  // Effective-only preparation demonstrably loses the reserved identity.
  const lossy = prepareSnapshot({ budgetId, revision: 0, ...empty.snapshot.request, confirmedRows: [] });
  assert.deepEqual(lossy.request.oneOffProgress, []);
  const repaid = confirm(voided, 'bill', 'second', 100);
  const before = JSON.stringify(repaid);
  const result = prepare(repaid);
  equivalent(result);
  assert.equal(result.originals.length, 2);
  assert.equal(result.confirmedRows[0].occurrence_key, 'one_off_remainder:bill:2');
  assert.deepEqual(result.sourceSnapshot.localAudit, repaid.localAudit);
  assert.equal(JSON.stringify(repaid), before);
  result.confirmedRows[0].amount = 1;
  assert.equal(result.sourceSnapshot.localHistory[0].amount, 100);
});

test('origin projection maps actual dates explicitly and keeps capture time and historical foreign rates in proof', () => {
  const source = initial(1000);
  source.request.fxSnapshot = { 'eur/pln': { rate: 4.2, source: 'manual', effectiveDate: '2026-06-01' } };
  source.request.tables.one_off_transactions.push({ id: 'foreign', name: 'Old foreign bill', type: 'expense', amount: 100, currency: 'EUR', date: '2020-12-31' });
  const paid = confirm(source, 'foreign', 'foreign');
  paid.request.fxSnapshot['eur/pln'].rate = 5;
  const result = prepare(paid);
  equivalent(result);
  assert.equal(result.sourceSnapshot.localHistory[0].confirmed_date, timing.today);
  const row = result.confirmedRows[0];
  assert.equal(row.confirmed_date, '2020-12-31');
  assert.equal(row.ledger_year, 2020);
  assert.equal(row.created_at, paid.localHistory[0].created_at);
  assert.equal(row.updated_at, timing.generationTimestamp);
  assert.equal(row.fx_rate, 4.2);
  assert.equal(row.ledger_amount, 420);
  assert.equal(row.running_balance_pln, 580);
  assert.equal(result.snapshot.request.fxSnapshot['eur/pln'].rate, 5);
});

test('origin projection preserves blocked retry branches and deleted prospective sources', () => {
  const source = initial(0);
  source.request.tables.one_off_transactions.push(
    { id: 'income', name: 'Income', type: 'income', amount: 500, currency: 'PLN', date: '2026-06-01' },
    { id: 'expense', name: 'Expense', type: 'expense', amount: 400, currency: 'PLN', date: timing.today });
  const paid = confirm(confirm(source, 'income', 'income'), 'expense', 'expense');
  const blocked = correction(paid, 'income', { amount: 200, date: '2026-06-01' }, 'blocked');
  const retry = correction(blocked, 'income', { amount: 200, date: '2026-06-01' }, 'retry', { retryOf: 'correction-blocked' });
  const branch = correction(retry, 'income', { amount: 200, date: '2026-06-01' }, 'branch', { retryOf: 'correction-blocked' });
  branch.request.tables.one_off_transactions = [];
  const result = prepare(branch);
  equivalent(result);
  assert.deepEqual(result.sourceSnapshot.localAudit, branch.localAudit);
  assert.equal(result.sourceSnapshot.localAudit.filter(event => event.status === 'blocked').length, 3);
  assert.equal(result.originals[0].row.amount, 500);
  assert.equal(result.sourceSnapshot.localAudit[0].source.row.amount, 500);
  assert.equal(result.confirmedRows.at(-1).running_balance_pln, 100);
});

test('origin projection preserves history-based predictions, goal funding and split flex progress', () => {
  const source = initial();
  const recurring = { currency: 'PLN', active: 1, repeat_every_months: 1, anchor_type: 'day_of_month',
    anchor_day_of_month: 1, anchor_business_day_adjustment: 'none', prediction_strategy: 'fixed' };
  source.request.tables.recurring_incomes = [{ ...recurring, id: 'salary', name: 'Salary', amount: 600,
    prediction_strategy: '12month_min', prediction_substitute_missing: 'last_confirmed' }];
  source.request.tables.planned_transactions = [{ id: 'rent-plan', operating_priority: 1 },
    { id: 'goal-plan', goal_priority: 1 }, { id: 'flex-plan', operating_priority: 2 }];
  source.request.tables.recurring_expenses = [{ ...recurring, id: 'rent', name: 'Rent', amount: 100, necessary: 1, planned_transaction_id: 'rent-plan' }];
  source.request.tables.goals = [{ id: 'goal', name: 'Goal', amount: 200, currency: 'PLN', active: 1,
    due_date: '2026-06-20', planned_transaction_id: 'goal-plan' }];
  source.request.tables.flex_transactions = [{ id: 'flex', name: 'Split flex', amount: 100, currency: 'PLN', active: 1,
    allow_split: 1, min_amount: 10, max_amount: 30, planned_transaction_id: 'flex-plan' }];
  let paid = source;
  for (const id of ['salary', 'rent', 'goal', 'flex']) paid = confirm(paid, id, id);
  paid.request.tables.recurring_incomes[0].amount = 5;
  paid.request.tables.recurring_expenses[0].active = 0;
  const result = prepare(paid);
  equivalent(result);
  assert.ok(result.calculation.plan.futureRows.some(row => row.source_recurring_income_id === 'salary' && row.amount === 600));
  assert.equal(result.snapshot.request.tables.recurring_expenses[0].active, 0);
});

test('origin projection keeps a legacy source-limit refusal blocked under its recorded rules', () => {
  const source = initial();
  source.request.tables.one_off_transactions.push({ id: 'bill', name: 'Bill', type: 'expense', amount: 400, currency: 'PLN', date: timing.today });
  const paid = confirm(source, 'bill', 'bill');
  const legacy = correction(paid, 'bill', { amount: 450, date: timing.today }, 'old-cap');
  const event = legacy.localAudit.at(-1);
  assert.equal(event.status, 'accepted');
  // Reconstruct the previous policy's authentic refusal, preserving its prior
  // effective mirrors. Replay must retain it, not apply today's amount rules.
  delete event.policyVersion;
  Object.assign(event, { status: 'blocked', failureCode: 'source_limit', after: null });
  legacy.localHistory = structuredClone(paid.localHistory);
  legacy.request.predictionRows = structuredClone(paid.localHistory);
  const result = prepare(legacy);
  equivalent(result);
  assert.deepEqual(result.sourceSnapshot.localAudit, legacy.localAudit);
  assert.equal(result.sourceSnapshot.localAudit.at(-1).failureCode, 'source_limit');
  assert.equal(result.confirmedRows[0].amount, 400);
  assert.equal(result.snapshot.request.openingBalance, 100);
});

test('origin projection retains early, actual-date, foreign-rate and late-goal correction command results', () => {
  const commands = localCommandFixtures({ refresh: refreshLocalSnapshot, confirm: confirmLocalOccurrence, correct: correctLocalConfirmation });
  for (const command of commands.filter(value => ['correctLocalConfirmationJson', 'confirmLocalOccurrenceJson'].includes(value.method))) {
    const method = command.method === 'correctLocalConfirmationJson' ? correctLocalConfirmation : confirmLocalOccurrence;
    const accepted = method(command.input);
    const result = prepare(accepted, { today: command.input.today, generationTimestamp: command.input.generationTimestamp });
    equivalent(result);
    assert.deepEqual(result.sourceSnapshot.localAudit, accepted.localAudit);
  }
});

test('origin projection refuses altered mirrors, private data, non-reserved scope and ambiguous host timestamps', () => {
  const source = initial();
  source.request.tables.one_off_transactions.push({ id: 'bill', name: 'Bill', type: 'expense', amount: 100, currency: 'PLN', date: timing.today });
  const paid = confirm(source, 'bill', 'bill');
  for (const mutate of [value => { value.localHistory[0].amount = 1; }, value => { value.accessToken = 'synthetic-forbidden'; }]) {
    const forged = structuredClone(paid); mutate(forged);
    assert.throws(() => prepare(forged));
  }
  for (const target of ['local-source', 'other-budget', '1960951c-623a-4e4c-a789-6660bdc8f329']) assert.throws(() => prepare(paid, { budgetId: target }), /host-reserved/);
  for (const timestamp of ['2026-06-02 12:00:00', '2026-06-02T12:00:00Z', '2026-02-30T12:00:00.000Z']) {
    assert.throws(() => prepare(paid, { generationTimestamp: timestamp }));
  }
});

test('origin projection refuses timestamp normalization that would reorder accepted financial facts', () => {
  const source = initial();
  source.request.tables.one_off_transactions.push(
    { id: 'first', name: 'First payment', type: 'expense', amount: 100, currency: 'PLN', date: timing.today },
    { id: 'second', name: 'Second payment', type: 'expense', amount: 50, currency: 'PLN', date: timing.today });
  let paid = source;
  paid = confirm(confirm(paid, 'first', 'z'), 'second', 'a');
  // Current commands emit milliseconds; supported historical evidence also
  // permits submillisecond UTC capture instants. Change only that metadata in
  // the original and both complete mirrors, retaining accepted money/source.
  for (const rows of [paid.localAudit.map(event => event.row), paid.localHistory, paid.request.predictionRows]) {
    for (const row of rows) row.created_at = row.id === 'confirmed-z'
      ? '2026-06-02T12:00:00.000000001Z' : '2026-06-02T12:00:00.000000002Z';
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  assert.deepEqual(paid.localHistory.map(row => row.id), ['confirmed-z', 'confirmed-a']);
  // Both instants truncate to the same millisecond. An opaque-ID tie-break
  // would reverse them; retain local data and refuse preparation, never invent
  // new capture times to make it pass. Origin-aware ordering is still pending.
  assert.throws(() => prepare(paid), /financial order/);
});

test('origin preparation accepts the journal actual reserved budget identity', () => {
  const destination = standaloneTransferDestination({ instanceId: '11111111-1111-4111-8111-111111111111',
    accountId: 'synthetic-owner', deviceId: 'synthetic-device', transferId: '22222222-2222-4222-8222-222222222222' });
  assert.match(destination, /^budget_/);
  assert.equal(prepare(initial(), { budgetId: destination }).budgetId, destination);
});
