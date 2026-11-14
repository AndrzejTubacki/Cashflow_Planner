import test from 'node:test';
import assert from 'node:assert/strict';
import { completeSnapshot } from './fixtures.js';
import { calculateSnapshot } from '../../src/engine/snapshot.js';
import { refreshLocalSnapshot, confirmLocalOccurrence } from '../../src/engine/local-confirmation.js';
import { recoveryWindow } from '../../src/engine/recovery-window.js';

function fixture() {
  const s = completeSnapshot(); s.budgetId = 'local-overdue'; s.localRecoveryRows = [];
  s.request.tables.one_off_transactions = [];
  s.request.openingBalance = 10000;
  for (const [table, id, amount] of [['recurring_expenses', 'rent', 100], ['recurring_incomes', 'salary', 500]]) {
    if (table === "recurring_expenses") s.request.tables.planned_transactions.push({ id: `p-${id}`, operating_priority: 1 });
    s.request.tables[table].push({ id, ...(table === "recurring_expenses" ? { planned_transaction_id: `p-${id}` } : {}), name: id, amount, currency: 'PLN',
      active: 1, necessary: 1, priority: 1, prediction_strategy: 'fixed', repeat_every_months: 1,
      anchor_type: 'day_of_month', anchor_day_of_month: 25, anchor_business_day_adjustment: 'none' });
  }
  return s;
}
const timing = today => ({ today, generationTimestamp: `${today}T00:00:00.000Z`, idSeed: `test-${today}` });
const refresh = (snapshot, today) => refreshLocalSnapshot({ snapshot, ...timing(today) });
const choices = s => { const p = calculateSnapshot(s).plan; return [...p.pendingRows, ...p.futureRows]; };

test('shared recovery window keeps current periods and adds only known historical periods', () => {
  const row = { occurrence_key: 'recurring_expense:rent:expense:2026-05-25', source_recurring_expense_id: 'rent' };
  const options = { settings: {}, recurringIncomes: [], today: '2026-08-03', futurePeriods: 3, candidates: [row, row] };
  const r = recoveryWindow(options);
  assert.equal(r.recoveryOccurrenceKeys.size, 1);
  assert.equal(r.currentPeriodStart, '2026-08-01');
  assert.deepEqual(r.periods.map(p => p.start), ['2026-05-01', '2026-08-01', '2026-09-01', '2026-10-01']);
  assert.equal(recoveryWindow({ ...options, candidates: [] }).periods.length, 3);
});

test('offered expense and income survive next day, ended period and several periods without duplicates or earlier backlog', () => {
  let s = refresh(fixture(), '2026-05-20');
  const before = choices(s);
  const expected = before.filter(r => r.date === '2026-05-25');
  assert.equal(expected.length, 2);
  for (const day of ['2026-05-26', '2026-06-03', '2026-09-03', '2026-09-03']) {
    s = refresh(s, day);
    const p = calculateSnapshot(s).plan;
    for (const row of expected) {
      const recovered = p.pendingRows.filter(r => r.occurrence_key === row.occurrence_key);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].date, row.date);
      assert.equal(recovered[0].amount, row.amount);
    }
    const rows = choices(s);
    assert.equal(new Set(rows.map(r => r.occurrence_key)).size, rows.length);
    assert.ok(rows.every(r => r.date >= '2026-05-25'));
    assert.deepEqual(s.request.tables.pending_transactions, []);
    assert.deepEqual(s.request.tables.future_transactions, []);
  }
});

test('recovered choices confirm normally and never return after repeated refresh', () => {
  let s = refresh(refresh(fixture(), '2026-05-20'), '2026-08-03');
  for (const row of choices(s).filter(r => r.date === '2026-05-25')) {
    s = confirmLocalOccurrence({ snapshot: s, occurrenceKey: row.occurrence_key,
      ...timing('2026-08-03'), idSeed: `pay-${row.type}`, actualDate: '2026-08-03' });
    s = refresh(s, '2026-08-03');
    assert.ok(!choices(s).some(r => r.occurrence_key === row.occurrence_key));
  }
  assert.equal(s.localHistory.length, 2);
});

test('fresh budgets invent no missed recurring dates; hints do not override amounts, journal mirrors or linked mode', () => {
  const fresh = refresh(fixture(), '2026-08-03');
  assert.ok(choices(fresh).every(r => r.date >= '2026-08-03'));
  const s = refresh(fixture(), '2026-05-20');
  const original = calculateSnapshot(s).plan;
  const without = structuredClone(s); delete without.localRecoveryRows;
  assert.deepEqual(calculateSnapshot(without).plan, original);
  const malformed = structuredClone(s); malformed.localRecoveryRows[0].date = '2026-05-24';
  assert.throws(() => refresh(malformed, '2026-06-03'), /Invalid standalone recovery/);
  const badMirror = structuredClone(s); badMirror.request.tables.pending_transactions.push(choices(s)[0]);
  assert.throws(() => refresh(badMirror, '2026-06-03'), /Unsupported standalone workflow/);
  const linked = structuredClone(without); linked.budgetId = 'server-budget'; linked.writesSupported = false; linked.snapshotVersion = 1;
  assert.deepEqual(calculateSnapshot(linked).plan, calculateSnapshot(without).plan);
  linked.localRecoveryRows = s.localRecoveryRows;
  assert.throws(() => calculateSnapshot(linked), /Standalone recovery/);
  const edited = structuredClone(s); edited.request.tables.recurring_expenses[0].amount = 123;
  assert.equal(choices(refresh(edited, '2026-06-03')).find(r => r.source_recurring_expense_id === 'rent' && r.date === '2026-05-25').amount, 123);
});

test('a long unopened gap recovers only offered months; pausing/deleting a source removes its due choices', () => {
  const offered = refresh(fixture(), '2026-05-20');
  const overdue = refresh(offered, '2026-09-03');
  assert.deepEqual([...new Set(calculateSnapshot(overdue).plan.pendingRows.map(row => row.date))],
    ['2026-05-25', '2026-06-25', '2026-07-25']);
  const paused = structuredClone(overdue);
  paused.request.tables.recurring_expenses[0].active = 0;
  assert.ok(!choices(refresh(paused, '2026-09-04')).some(row => row.source_recurring_expense_id));
  const deleted = structuredClone(overdue);
  deleted.request.tables.recurring_expenses = []; deleted.request.tables.planned_transactions = [];
  assert.ok(!choices(refresh(deleted, '2026-09-04')).some(row => row.source_recurring_expense_id));
});

test('income-anchored periods retain exact scheduled choices across an ended period', () => {
  const base = fixture();
  base.request.settings.budget_period_income_id = 'salary';
  base.request.tables.recurring_incomes[0].period_setting = 1;
  const s = refresh(base, '2026-05-20');
  const key = choices(s).find(row => row.source_recurring_expense_id && row.date === '2026-05-25').occurrence_key;
  const due = calculateSnapshot(refresh(s, '2026-09-03')).plan.pendingRows.filter(row => row.occurrence_key === key);
  assert.equal(due.length, 1); assert.equal(due[0].amount, 100); assert.equal(due[0].date, '2026-05-25');
});
