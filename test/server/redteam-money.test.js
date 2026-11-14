import test from 'node:test';
import assert from 'node:assert/strict';
import { requireMoneyAmount } from '../../src/server/cashflow-input-validation.js';
import { validatePlanMutationInput } from '../../src/server/cashflow-plan-input-validation.js';
import { validateFullImportRows } from '../../src/server/cashflow-import-validation.js';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';

for (const amount of ['100000000000000.01', '1e308', '10000000000']) {
  test(`CFSEC-07 browser money rejects unsafe ${amount}`, () => {
    assert.throws(() => validatePlanMutationInput('one-off', { amount }), error => error.status === 400);
  });
}
test('CFSEC-07 rounding cannot defeat a positive monetary lower bound', () => {
  assert.throws(() => requireMoneyAmount('0.001', 'amount', { min: 0, exclusiveMin: true }), error => error.status === 400);
  assert.equal(requireMoneyAmount('9999999999.99', 'amount'), 9999999999.99);
  assert.equal(requireMoneyAmount('1.235', 'amount'), 1.24);
});

test('CFSEC-07 rejected browser and CSV imports leave source rows unchanged', async () => {
  const h = await createCashflowTestHarness({ inProcess: true });
  try {
    const baseline = await h.api('/api/export/full');
    for (const amount of ['100000000000000.01', '1e308']) {
      const result = await h.request('/api/one-off', { method: 'POST', body: { name: 'Fixture', type: 'income', currency: 'PLN', date: '2026-05-22', amount } });
      assert.equal(result.response.status, 400);
      const csv = await h.request('/api/import/one-offs-csv/preview', { method: 'POST', body: { csv: `name,type,amount,currency,date\nFixture,income,${amount},PLN,2026-05-22` } });
      assert.equal(csv.response.status, 400);
      const full = structuredClone(baseline);
      full.planning.one_off_transactions = [{ id: 'fixture-row', name: 'Fixture', type: 'income', currency: 'PLN', date: '2026-05-22', amount, created_at: '2026-05-20T00:00:00Z', updated_at: '2026-05-20T00:00:00Z' }];
      assert.throws(() => validateFullImportRows(full), error => error.status === 400);
    }
    const db = h.openPlanningDb();
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM one_off_transactions').get().n, 0); }
    finally { db.close(); }
  } finally { await h.cleanup(); }
});
