import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBudgetStoreSnapshot } from '../../src/server/cashflow-budget-store-snapshot.js';
import { normalizeLedgerAuditFact } from '../../src/server/cashflow-ledger-correction-service.js';
import { validateLedgerCorrectionFact } from '../../src/server/cashflow-ledger-correction-plan.js';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { createNodeLedgerAuditReplay } from '../../src/server/cashflow-ledger-audit-store.js';

/** A valid baseline has no correction hashes to hide invalid financial input.
 * Derived balances in the transport payload are deliberately untrusted. */
function snapshot(amounts) {
  const budgetId = 'snapshot-validation';
  const rows = amounts.map((amount, index) => normalizeLedgerAuditFact({ id: `payment-${index}`, name: 'Payment', amount,
    type: 'income', date: '2018-01-01', confirmed_date: '2018-01-01', ledger_year: 2018, currency: 'PLN', ledger_currency: 'PLN',
    fx_rate: 1, buffered_fx_rate: 1, ledger_amount: amount, running_balance_pln: 999999,
    created_at: '2018-01-01T12:00:00.000Z', updated_at: '2018-01-01T12:00:00.000Z' }, budgetId));
  return { format: 'cashflow-budget-store-snapshot', version: 2,
    payload: { format: 'cashflow-sqlite-budget-storage-export', version: 1,
      budgetSources: [{ budgetId, ledgerYears: [2018] }], tables: { settings: [{ budget_id: budgetId, id: 1 }], confirmed_transactions: rows } },
    ledgerAudits: [{ version: 1, budgetId, baselineComplete: true, lastSequence: rows.length, corrections: [],
      originals: rows.map((row, index) => ({ version: 1, budgetId, sequence: index + 1, captureKind: 'legacy',
        actorId: null, capturedAt: '2026-10-23T12:00:00.000Z', sourceAtAcceptance: null,
        row: validateLedgerCorrectionFact(row, budgetId) })) }] };
}

test('audited snapshot restore derives balances from verified facts instead of transport totals', () => {
  const input = snapshot([100, 50]);
  const restored = normalizeBudgetStoreSnapshot(input);
  assert.deepEqual(restored.payload.tables.confirmed_transactions.map(row => row.running_balance_pln), [100, 150]);
  assert.equal(input.payload.tables.confirmed_transactions[0].running_balance_pln, 999999);
});

test('audited snapshot restore refuses a cumulative balance outside safe monetary precision', () => {
  assert.throws(() => normalizeBudgetStoreSnapshot(snapshot([50000000000000, 50000000000000])), /safe monetary precision/);
});

test('audited restore keeps ledger currencies separate and uses the captured buffered FX rate', () => {
  const input = snapshot([100, 10, 50]);
  for (const value of [input.payload.tables.confirmed_transactions[1], input.ledgerAudits[0].originals[1].row]) {
    Object.assign(value, { type: 'expense', currency: 'EUR', fx_rate: 2, buffered_fx_rate: 2.2, ledger_amount: 22 });
  }
  for (const value of [input.payload.tables.confirmed_transactions[2], input.ledgerAudits[0].originals[2].row]) {
    Object.assign(value, { currency: 'EUR', ledger_currency: 'EUR' });
  }
  const restored = normalizeBudgetStoreSnapshot(input);
  assert.deepEqual(restored.payload.tables.confirmed_transactions.map(row => row.running_balance_pln), [100, 78, 50]);
  assert.equal(restored.payload.tables.confirmed_transactions[1].ledger_amount, 22);
});

/** Add an independently accepted post-import fact in its owning currency.
 * Imported source proof remains unchanged and conveys no author permission. */
function originSnapshot({ emptyOpening = null, income = 200, currency = 'EUR' } = {}) {
  const audit = standaloneOriginAuditFixture().audit;
  if (emptyOpening !== null) {
    audit.origin.events = []; audit.origin.openingBalance = emptyOpening; audit.origin.legacyCount = 0; audit.lastSequence = 0;
  }
  const row = validateLedgerCorrectionFact(normalizeLedgerAuditFact({ id: 'new-opening', name: 'New currency opening',
    amount: income, type: 'income', currency, ledger_currency: currency, date: '2026-06-02', confirmed_date: '2026-06-02',
    ledger_year: 2026, fx_rate: 1, buffered_fx_rate: 1, ledger_amount: income, occurrence_key: 'manual:new-opening',
    created_at: '2026-06-02T12:01:00.000Z', updated_at: '2026-06-02T12:01:00.000Z' }, audit.budgetId), audit.budgetId);
  audit.originals.push({ version: 1, budgetId: audit.budgetId, sequence: ++audit.lastSequence, captureKind: 'payment',
    actorId: 'synthetic-actor', capturedAt: row.created_at, row, sourceAtAcceptance: null });
  const codec = createNodeLedgerAuditReplay({ allowStandaloneOrigins: true });
  const rows = codec.replayLedgerAuditSnapshot(audit, audit.budgetId).rows;
  return { format: 'cashflow-budget-store-snapshot', version: 2, ledgerAudits: [audit],
    payload: { format: 'cashflow-sqlite-budget-storage-export', version: 1,
      budgetSources: [{ budgetId: audit.budgetId, ledgerYears: [2026] }],
      tables: { settings: [{ budget_id: audit.budgetId, id: 1, ledger_currency: currency }],
        confirmed_transactions: rows.map(row => ({ ...row, running_balance_pln: 999999 })) } } };
}

test('origin snapshot restores its historical currency offset once, independently of the current settings currency', () => {
  const input = originSnapshot();
  const checked = normalizeBudgetStoreSnapshot(input, { allowStandaloneOrigins: true });
  assert.deepEqual(checked.payload.tables.confirmed_transactions.map(row => [row.ledger_currency, row.running_balance_pln]),
    [['PLN', 100], ['EUR', 200]]);
  assert.equal(input.payload.tables.confirmed_transactions[0].running_balance_pln, 999999);
});

test('origin snapshot refuses cumulative unsafe precision caused by the retained signed offset', () => {
  const input = originSnapshot({ emptyOpening: 90000000000000, income: 100000000000, currency: 'PLN' });
  assert.throws(() => normalizeBudgetStoreSnapshot(input, { allowStandaloneOrigins: true }), /safe monetary precision/);
});
