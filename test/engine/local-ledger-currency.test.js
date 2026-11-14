import assert from 'node:assert/strict';
import test from 'node:test';
import { completeSnapshot } from './fixtures.js';
import { changeLocalLedgerCurrency, changeLocalLedgerCurrencyJson } from '../../src/engine/app-entry.js';
import { confirmLocalOccurrence, refreshLocalSnapshot, undoLocalConfirmation } from '../../src/engine/local-confirmation.js';

const timing = { today: '2026-06-01', generationTimestamp: '2026-06-01T12:00:00.000Z', idSeed: 'switch' };
/** Isolated phone budget; its original opening belongs to PLN only. */
function local(balance = 500) {
  const snapshot = completeSnapshot();
  snapshot.budgetId = 'local-currency'; snapshot.request.openingBalance = balance;
  snapshot.request.tables.one_off_transactions = [];
  return snapshot;
}
function change(snapshot, extra = {}) {
  return changeLocalLedgerCurrency({ snapshot, newCurrency: 'EUR', manualRates: { 'PLN/EUR': 0.25 }, ...timing, ...extra });
}
function confirm(snapshot, extra = {}) {
  return confirmLocalOccurrence({ snapshot, occurrenceKey: snapshot.request.tables.pending_transactions[0].occurrence_key,
    ...timing, idSeed: 'confirm', ...extra });
}

test('local ledger conversion refuses stale direct and inverse cache observations without changing the snapshot', () => {
  for (const [pair, rate] of [['pln/eur', 0.25], ['eur/pln', 4]]) {
    const snapshot = local(100);
    const before = JSON.stringify(snapshot);
    assert.throws(() => change(snapshot, { manualRates: {}, cachedRates: {
      [pair]: { rate, source: 'nbp', effectiveDate: '2026-04-30' }
    } }), error => error.status === 409 && error.details.code === 'stale_fx_rate' && error.details.ageDays === 32);
    assert.equal(JSON.stringify(snapshot), before);
    assert.equal(change(snapshot, { manualRates: {}, cachedRates: {
      [pair]: { rate, source: 'manual', effectiveDate: '2020-01-01' }
    } }).request.tables.pending_transactions[0].amount, 25);
  }
});

test('a usable cached conversion keeps its observation date instead of making the rate look newly fetched', () => {
  const switched = change(local(100), { manualRates: {}, cachedRates: {
    'pln/eur': { rate: 0.25, source: 'nbp', effectiveDate: '2026-05-25' }
  } });
  assert.equal(switched.request.fxSnapshot['pln/eur'].effectiveDate, '2026-05-25');
});

test('local currency change records visible pending conversion, confirms, reopens and reverses with audit', () => {
  const original = local(); const before = JSON.stringify(original);
  const switched = change(original);
  assert.equal(JSON.stringify(original), before);
  assert.equal(switched.request.settings.ledger_currency, 'EUR');
  assert.equal(switched.request.openingBalance, 0);
  assert.equal(switched.request.tables.ledger_currency_events[0].old_balance, 500);
  assert.equal(switched.request.tables.pending_transactions[0].amount, 125);
  assert.throws(() => change(switched, { newCurrency: 'USD' }), /pending ledger currency conversion/);
  const paid = confirm(switched);
  assert.equal(paid.request.openingBalance, 125);
  assert.equal(paid.request.tables.pending_transactions.length, 0);
  assert.equal(paid.localHistory[0].ledger_currency, 'EUR');
  const reopened = refreshLocalSnapshot({ snapshot: paid, ...timing });
  assert.equal(reopened.request.openingBalance, 125);
  const undone = undoLocalConfirmation({ snapshot: reopened, confirmationId: 'confirmed-confirm', ...timing, idSeed: 'undo' });
  assert.equal(undone.localHistory.length, 0);
  assert.equal(undone.request.openingBalance, 0);
  assert.equal(undone.localAudit.at(-1).status, 'accepted');
  assert.equal(undone.localAudit.at(-1).before.amount, 125);
});

test('zero balance needs no rate and its zero conversion can be confirmed', () => {
  const switched = change(local(0), { manualRates: {} });
  assert.equal(switched.request.tables.ledger_currency_events[0].source, 'zero-balance');
  assert.equal(switched.request.tables.ledger_currency_events[0].fx_rate, 1);
  assert.equal(confirm(switched).request.openingBalance, 0);
});

test('missing and unsupported rates/currencies fail atomically through the native bridge', () => {
  assert.throws(() => change(local(), { manualRates: {} }), /Missing FX rate/);
  assert.throws(() => change(local(), { newCurrency: 'XXX' }), /currency/i);
  const result = JSON.parse(changeLocalLedgerCurrencyJson(JSON.stringify({ snapshot: local(), newCurrency: 'EUR', ...timing })));
  assert.equal(result.ok, false); assert.equal(result.error.code, 'LOCAL_LEDGER_CURRENCY_REJECTED');
});

test('manual direct, inverse and cached direct/inverse use browser precedence and cent arithmetic', () => {
  for (const [extra, source] of [
    [{ manualRates: { 'EUR/PLN': 4 } }, 'manual-inverse'],
    [{ manualRates: {}, cachedRates: { 'pln/eur': { rate: 0.25, source: 'nbp', effectiveDate: timing.today } } }, 'cache'],
    [{ manualRates: {}, cachedRates: { 'eur/pln': { rate: 4, source: 'nbp', effectiveDate: timing.today } } }, 'inverse-cache'],
    [{ cachedRates: { 'pln/eur': { rate: 9, source: 'nbp', effectiveDate: timing.today } } }, 'manual']
  ]) {
    const switched = change(local(100.01), extra);
    assert.equal(switched.request.tables.pending_transactions[0].amount, 25);
    assert.equal(switched.request.tables.ledger_currency_events[0].source, source);
  }
});

test('old payments and their audit currency survive a switch and new-currency confirmation', () => {
  const snapshot = local();
  snapshot.request.tables.one_off_transactions = [{ id: 'old', name: 'Paid before switch', currency: 'PLN', type: 'expense', amount: 100, date: timing.today }];
  const paid = confirmLocalOccurrence({ snapshot, occurrenceKey: 'one_off:old:expense:2026-06-01', ...timing, idSeed: 'old' });
  const old = structuredClone(paid.localHistory[0]);
  const switched = change(paid);
  const next = confirm(switched);
  assert.deepEqual(next.localHistory.find(row => row.id === old.id), old);
  assert.equal(next.request.openingBalance, 100);
  assert.equal(next.localAudit[0].row.ledger_currency, 'PLN');
  assert.equal(next.request.tables.one_off_transactions[0].currency, 'PLN');
});

test('altered conversion audit or pending mirror is rejected on refresh', () => {
  for (const tamper of [s => { s.request.tables.pending_transactions[0].amount++; },
    s => { s.localAudit.at(-1).event.old_balance++; }, s => { s.request.settings.ledger_currency = 'USD'; }]) {
    const snapshot = change(local()); tamper(snapshot);
    assert.throws(() => refreshLocalSnapshot({ snapshot, ...timing }), /conversion|currency|exchange rates/i);
  }
});

import { correctLocalConfirmation } from '../../src/engine/local-confirmation.js';

test('corrections before currency change stay accepted; later dependency changes are retained as blocked', () => {
  const snapshot = local();
  snapshot.request.tables.one_off_transactions = [{ id: 'old', name: 'Earlier payment', currency: 'PLN', type: 'expense', amount: 100, date: timing.today }];
  const paid = confirmLocalOccurrence({ snapshot, occurrenceKey: 'one_off:old:expense:2026-06-01', ...timing, idSeed: 'old' });
  const revised = correctLocalConfirmation({ snapshot: paid, confirmationId: 'confirmed-old', expectedCorrectionId: null,
    reason: 'Actual amount', replacement: { amount: 80, date: timing.today }, ...timing, idSeed: 'before-switch' });
  const switched = change(revised);
  assert.equal(switched.request.tables.pending_transactions[0].amount, 105);
  const blocked = correctLocalConfirmation({ snapshot: switched, confirmationId: 'confirmed-old', expectedCorrectionId: 'correction-before-switch',
    reason: 'Would invalidate conversion', replacement: null, ...timing, idSeed: 'blocked' });
  assert.equal(blocked.localAudit.at(-1).failureCode, 'currency_conversion_dependency');
  assert.equal(blocked.localAudit.at(-1).status, 'blocked');
  assert.equal(blocked.localHistory[0].amount, 80);
  assert.equal(refreshLocalSnapshot({ snapshot: blocked, ...timing }).localHistory[0].amount, 80);
});

test('conversion void can be restored through the existing correction API', () => {
  const paid = confirm(change(local()));
  const undone = undoLocalConfirmation({ snapshot: paid, confirmationId: 'confirmed-confirm', ...timing, idSeed: 'undo' });
  const restored = correctLocalConfirmation({ snapshot: undone, confirmationId: 'confirmed-confirm', expectedCorrectionId: 'correction-undo',
    reason: 'Restore conversion', replacement: { amount: 125, date: timing.today }, ...timing, idSeed: 'restore' });
  assert.equal(restored.request.openingBalance, 125);
  assert.equal(restored.localAudit.at(-1).status, 'accepted');
});

test('a subsequent switch preserves balances by currency, including switching back to the opening currency', () => {
  const euro = confirm(change(local()));
  const back = change(euro, { newCurrency: 'PLN', manualRates: { 'EUR/PLN': 4 }, idSeed: 'back' });
  assert.equal(back.request.openingBalance, 500);
  const paid = confirm(back, { idSeed: 'back-paid' });
  assert.equal(paid.request.openingBalance, 1000);
  assert.deepEqual(paid.localHistory.map(row => [row.ledger_currency, row.running_balance_pln]).sort(), [['EUR', 125], ['PLN', 1000]]);
});

test('signed opening balance produces an expense conversion like the browser', () => {
  const switched = change(local(-100));
  assert.equal(switched.request.tables.pending_transactions[0].type, 'expense');
  assert.equal(confirm(switched).request.openingBalance, -25);
});

test('zero balance switches without planning quotes; missing quotes are explicit and cannot confirm a foreign payment', () => {
  const snapshot = local(0);
  snapshot.request.tables.one_off_transactions = [{ id: 'foreign', name: 'Original currency income', currency: 'PLN', type: 'income', amount: 100, date: timing.today }];
  const switched = change(snapshot, { manualRates: {} });
  assert.equal(switched.request.tables.ledger_currency_events[0].source, 'zero-balance');
  assert.deepEqual(switched.localMissingPlanningRates, ['PLN']);
  const paid = confirm(switched);
  assert.equal(paid.request.openingBalance, 0);
  assert.deepEqual(refreshLocalSnapshot({ snapshot: paid, ...timing }).localMissingPlanningRates, ['PLN']);
  assert.throws(() => confirmLocalOccurrence({ snapshot: paid, occurrenceKey: 'one_off:foreign:income:2026-06-01', ...timing, idSeed: 'foreign' }), /Missing FX rate|Add an exchange rate/);
});
