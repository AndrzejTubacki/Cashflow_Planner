import assert from 'node:assert/strict';
import test from 'node:test';
import { assertStandaloneTransferReadable } from '../../src/server/cashflow-standalone-transfer-readable.js';

/** Bounded synthetic readers exercise limits before JSON/engine allocation.
 * Successful real financial and origin replay is covered by publisher tests. */
function writer(tables = {}) {
  return { transactionBound: true,
    async listPlanningRows(_budgetId, table) {
      if (table === 'settings') return [{ id: 1, ledger_currency: 'PLN', future_periods: 3 }];
      return tables[table] ?? [];
    },
    async listConfirmedTransactions() { return []; },
    async exportLedgerAuditSnapshot() { return null; }
  };
}
const command = { budgetId: 'synthetic-readable-budget', today: '2026-06-02',
  generationTimestamp: '2026-06-02T12:00:00.000Z', idSeed: 'synthetic-readable', readFxSnapshot: async () => null };

test('transfer native-readability gate accepts a complete empty baseline', async () => {
  const result = await assertStandaloneTransferReadable({ ...command, writer: writer() });
  assert.equal(result.records, 2);
});
test('transfer native-readability gate refuses too many real bootstrap records before calculation', async () => {
  const rows = Array.from({ length: 200000 }, (_, index) => ({ id: `source-${index}`, type: 'expense', name: 'Synthetic source',
    currency: 'PLN', amount: 1, date: '2026-06-10' }));
  await assert.rejects(assertStandaloneTransferReadable({ ...command, writer: writer({ one_off_transactions: rows }) }), { code: 'TRANSFER_SIZE_LIMIT' });
});
test('transfer native-readability gate refuses a cache page exceeding the actual HTTP response bound', async () => {
  await assert.rejects(assertStandaloneTransferReadable({ ...command, writer: writer({ fx_rates_cache: [
    { base_currency: 'EUR', quote_currency: 'PLN', rate: 4, raw_json: 'x'.repeat(10 * 1024 * 1024) }
  ] }) }), { code: 'TRANSFER_SIZE_LIMIT' });
});
