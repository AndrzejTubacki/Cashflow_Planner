import assert from 'node:assert/strict';
import test from 'node:test';
import { currencyTransferFixture, currencyTiming } from '../helpers/currency-transfer-fixture.js';
import { standaloneLedgerOrigin, replayStandaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
import { createNodeLedgerAuditReplay } from '../../src/server/cashflow-ledger-audit-store.js';
import { validateStandaloneTransferSource } from '../../src/server/cashflow-standalone-transfer-source.js';
import { prepareStandaloneTransferOrigin } from '../../src/server/cashflow-standalone-transfer-origin.js';
const budgetId = 'budget_11111111-1111-8111-8111-111111111111';
const replay = origin => replayStandaloneLedgerOrigin({ origin, budgetId, utf8ByteLength: value => Buffer.byteLength(value) });
for (const stage of ['pending', 'confirmed', 'voided', 'returned']) for (const reviewed of [false, true]) {
  test(`currency origin v2 ${stage}, reviewed=${reviewed} preserves replay and forecasts`, () => {
    const source = currencyTransferFixture(stage, reviewed);
    const origin = standaloneLedgerOrigin(source, currencyTiming.generationTimestamp);
    assert.equal(origin.version, 2);
    const state = replay(origin);
    assert.equal(state.opening.ledgerCurrency, 'PLN');
    assert.equal(state.opening.amount, 500);
    for (const original of state.originals.values()) if (original.row.occurrence_key.startsWith('ledger_currency_conversion:')) assert.equal(original.sourceAtAcceptance, null);
    assert.deepEqual(origin.openingBalances, [{ amount: 500, ledgerCurrency: 'PLN' }, { amount: 0, ledgerCurrency: 'EUR' }]);
    assert.equal(state.pendingConversions.length, stage === 'pending' ? 1 : 0);
    const prepared = prepareStandaloneTransferOrigin({ sourceJson: JSON.stringify(source), budgetId, ...currencyTiming });
    assert.equal(prepared.snapshot.request.openingBalance, source.request.openingBalance);
    assert.deepEqual(state.rows.map(row => [row.id, row.amount, row.ledger_currency, row.fx_rate]), source.localHistory.map(row => [row.id, row.amount, row.ledger_currency, row.fx_rate]));
    assert.deepEqual(state.balances.map(row => row.running_balance_pln), source.localHistory.map(row => row.running_balance_pln));
    const codec = createNodeLedgerAuditReplay({ allowStandaloneOrigins: true });
    const audit = { version: 2, budgetId, baselineComplete: true, lastSequence: origin.events.length, origin, originals: [], corrections: [] };
    assert.deepEqual(codec.replayLedgerAuditSnapshot(audit, budgetId).rows, state.rows);
    const bad = structuredClone(origin); bad.openingBalances[1].amount = 100;
    assert.throws(() => replay(bad), /opening evidence/);
    const old = structuredClone(source); delete old.transferVersion;
    assert.throws(() => validateStandaloneTransferSource(JSON.stringify(old), currencyTiming), /version 2/);
  });
}
test('v2 origin rejects altered pending conversion and reviewed recomputation', () => {
  const source = currencyTransferFixture('pending', true);
  const origin = standaloneLedgerOrigin(source, currencyTiming.generationTimestamp);
  const pending = structuredClone(origin); pending.events.find(event => event.kind === 'ledger-currency').pending.amount++;
  assert.throws(() => replay(pending), /conversion evidence/);
  const review = structuredClone(origin); review.events.at(-1).conversionReview.changes[0].after.event.converted_opening_balance++;
  assert.throws(() => replay(review), /conversion correction review/);
});

test('currency origin retains old transaction FX and an explicit reviewed FX correction', async () => {
  const { standaloneOriginAuditFixture } = await import('../helpers/standalone-origin-fixture.js');
  const { changeLocalLedgerCurrency } = await import('../../src/engine/local-ledger-currency.js');
  const { applyReviewedLocalCorrection, reviewLocalCorrection } = await import('../../src/engine/local-correction-review.js');
  let source = standaloneOriginAuditFixture({ currency: 'EUR', amount: 50 }).snapshot;
  source = changeLocalLedgerCurrency({ snapshot: source, ...currencyTiming, idSeed: 'foreign-switch', newCurrency: 'EUR', manualRates: { 'PLN/EUR': 0.25 } });
  const command = { snapshot: source, ...currencyTiming, idSeed: 'foreign-review', confirmationId: 'confirmed-original', expectedCorrectionId: null,
    reason: 'Actual historical rate', replacement: { amount: 50, date: currencyTiming.today, fx_rate: 4 } };
  source = applyReviewedLocalCorrection({ ...command, review: reviewLocalCorrection(command) });
  source.transferVersion = 2;
  const prepared = prepareStandaloneTransferOrigin({ sourceJson: JSON.stringify(source), budgetId, ...currencyTiming });
  assert.equal(prepared.ledgerOrigin.events[0].row.fx_rate, 4.2);
  assert.equal(prepared.confirmedRows[0].fx_rate, 4);
  assert.equal(prepared.confirmedRows[0].ledger_currency, 'PLN');
  assert.equal(prepared.confirmedRows[0].currency, 'EUR');
  assert.equal(prepared.snapshot.request.tables.pending_transactions[0].amount, 75);
  assert.equal(prepared.snapshot.request.openingBalance, 0);
  const altered = structuredClone(source); altered.request.tables.pending_transactions[0].amount++;
  assert.throws(() => validateStandaloneTransferSource(JSON.stringify(altered), currencyTiming), /mirrors differ/);
});

test('zero and signed openings belong only to the initial currency after transfer', async () => {
  const { completeSnapshot } = await import('./fixtures.js');
  const { changeLocalLedgerCurrency } = await import('../../src/engine/local-ledger-currency.js');
  for (const opening of [0, -100]) {
    const initial = completeSnapshot();
    Object.assign(initial, { budgetId: 'local-signed-currency', name: 'Signed currency' });
    initial.request.openingBalance = opening; initial.request.tables.one_off_transactions = [];
    const source = changeLocalLedgerCurrency({ snapshot: initial, ...currencyTiming, newCurrency: 'EUR', manualRates: { 'PLN/EUR': 0.25 } });
    source.transferVersion = 2;
    const prepared = prepareStandaloneTransferOrigin({ sourceJson: JSON.stringify(source), budgetId, ...currencyTiming });
    assert.equal(prepared.snapshot.request.openingBalance, 0);
    assert.equal(prepared.opening.amount, opening);
    assert.equal(prepared.snapshot.request.tables.pending_transactions[0].amount, Math.abs(opening / 4));
    assert.equal(prepared.confirmedRows.length, 0);
  }
});
