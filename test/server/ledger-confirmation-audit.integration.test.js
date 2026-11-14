import assert from 'node:assert/strict';
import test from 'node:test';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createPostgresGlobalSchemaSql } from '../../src/server/cashflow-postgres-global-schema.js';
import { createCashflowPendingConfirmationService } from '../../src/server/cashflow-pending-confirmation-service.js';
import { createCashflowLedgerService } from '../../src/server/cashflow-ledger-service.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const budgetId = 'confirmation-audit';
const stamp = '2026-01-01T00:00:00.000Z';
/** Actual confirmations must retain source evidence before projection changes
 * planning, roll it back with late failures, and ignore actor claims in input. */
async function exercise(store) {
  await store.insertConfirmedTransactions(budgetId, [{ id: 'legacy', name: 'Legacy', amount: 500, type: 'income',
    currency: 'PLN', ledger_currency: 'PLN', date: '2018-01-01', confirmed_date: '2018-01-01', ledger_year: 2018,
    fx_rate: 1, buffered_fx_rate: 1, ledger_amount: 500, running_balance_pln: 500, occurrence_key: 'legacy',
    created_at: stamp, updated_at: stamp }]);
  const base = { name: 'Original source', currency: 'PLN', amount: 40, created_at: stamp, updated_at: stamp };
  const recurrence = { prediction_strategy: 'fixed', repeat_every_months: 1, anchor_type: 'month_end' };
  const sources = [
    ['one_off_transactions', 'source_one_off_id', { id: 'once', ...base, type: 'income', date: '2026-01-01' }],
    ['recurring_incomes', 'source_recurring_income_id', { id: 'salary', ...base, ...recurrence }],
    ['recurring_expenses', 'source_recurring_expense_id', { id: 'rent', ...base, ...recurrence, planned_transaction_id: 'plan-rent' }],
    ['goals', 'source_goal_id', { id: 'goal', ...base, due_date: '2026-12-01', planned_transaction_id: 'plan-goal' }],
    ['flex_transactions', 'source_flex_id', { id: 'flex', ...base, planned_transaction_id: 'plan-flex' }]
  ];
  for (const [table, field, row] of sources) {
    if (row.planned_transaction_id) await store.insertPlanningRows(budgetId, 'planned_transactions', [{ id: row.planned_transaction_id,
      type: table === 'goals' ? 'goal' : table === 'flex_transactions' ? 'flex' : 'recurring_expense', created_at: stamp, updated_at: stamp }]);
    await store.insertPlanningRows(budgetId, table, [row]);
    await store.insertPlanningRows(budgetId, 'pending_transactions', [{ id: `pay-${row.id}`, ...base, type: ['once', 'salary'].includes(row.id) ? 'income' : 'expense',
      date: '2026-01-01', occurrence_key: `manual:${row.id}`, funded_amount: 40, requested_amount: 40,
      status: 'pending', [field]: row.id }]);
  }
  const ledger = createCashflowLedgerService({ budgetStore: store });
  let fail = true;
  const confirmation = createCashflowPendingConfirmationService({ budgetStore: store,
    getConfirmedFxForDate: async () => ({ fxRate: 1, bufferedFxRate: 1 }),
    newestConfirmedTransactionDateAsync: ledger.newestConfirmedTransactionDateAsync,
    wouldLedgerGoNegativeAfterInsertAsync: ledger.wouldLedgerGoNegativeAfterInsertAsync,
    withProjectionStatus: async (_id, receipt, { store: writer }) => {
      const audit = await writer.exportLedgerAuditSnapshot(budgetId);
      assert.ok(audit.originals.find(item => item.row.id === receipt.id), 'capture precedes projection');
      if (fail) throw new Error('Injected late projection failure');
      return receipt;
    } });
  const before = await store.listConfirmedTransactions(budgetId);
  await assert.rejects(confirmation.confirmPendingTransaction(budgetId, 'pay-once', {}, { actorId: 'trusted-account' }), /Injected late projection failure/);
  assert.deepEqual(await store.listConfirmedTransactions(budgetId), before);
  assert.equal(await store.exportLedgerAuditSnapshot(budgetId), null, 'failed first confirmation rolls back legacy baseline too');
  assert.equal((await store.listPlanningRows(budgetId, 'pending_transactions')).length, 5);
  fail = false;
  for (const [, , row] of sources) await confirmation.confirmPendingTransaction(budgetId, `pay-${row.id}`,
    { actorId: 'forged-account' }, { actorId: 'trusted-account' });
  const audit = await store.exportLedgerAuditSnapshot(budgetId);
  assert.equal(audit.originals.length, 6);
  const legacy = audit.originals.find(item => item.row.id === 'legacy');
  assert.equal(legacy.captureKind, 'legacy'); assert.equal(legacy.actorId, null); assert.equal(legacy.sourceAtAcceptance, null);
  for (const [table, , row] of sources) {
    const original = audit.originals.find(item => item.row.id === `pay-${row.id}`);
    assert.equal(original.captureKind, 'payment'); assert.equal(original.actorId, 'trusted-account');
    assert.equal(original.sourceAtAcceptance.table, table); assert.equal(original.sourceAtAcceptance.row.amount, 40);
    if (row.planned_transaction_id) assert.equal(original.sourceAtAcceptance.plan.id, row.planned_transaction_id);
    await store.updatePlanningRowsById(budgetId, table, [{ id: row.id, amount: 999 }]);
  }
  assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), audit, 'future edits cannot rewrite acceptance evidence');
}

test('SQLite confirmation retains exact audit/source evidence and atomic rollback', async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId });
  try { await exercise(createSqliteBudgetStore(createCashflowDbService(createCashflowStoragePaths(harness.dataDir)))); }
  finally { await harness.cleanup(); }
});
test('PostgreSQL confirmation retains the same audit/source evidence and rollback', { skip: !postgresRuntimeTestsEnabled() },
  () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await pool.query(createPostgresGlobalSchemaSql());
    await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
    const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
    try {
      await store.initialize();
      await store.insertPlanningRows(budgetId, 'settings', [{ id: 1, updated_at: stamp }]);
      await exercise(store);
    } finally { await store.close(); }
  }));

test('HTTP confirmation captures its authenticated account and ignores payload actor', async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId });
  try {
    const store = createSqliteBudgetStore(createCashflowDbService(createCashflowStoragePaths(harness.dataDir)));
    await store.insertPlanningRows(budgetId, 'pending_transactions', [{ id: 'http-payment', name: 'Actual income', amount: 50,
      funded_amount: 50, requested_amount: 50, currency: 'PLN', type: 'income', date: '2026-01-01',
      status: 'pending', occurrence_key: 'manual:http-payment', created_at: stamp, updated_at: stamp }]);
    await harness.api('/api/pending/http-payment/confirm', { method: 'POST', body: { actorId: 'forged-account' } });
    const audit = await store.exportLedgerAuditSnapshot(budgetId);
    assert.ok(audit, 'public confirmations must retain immutable originals');
    assert.equal(audit.originals.length, 1);
    assert.equal(audit.originals[0].captureKind, 'payment');
    assert.ok(audit.originals[0].actorId);
    assert.notEqual(audit.originals[0].actorId, 'forged-account');
    assert.notEqual(audit.originals[0].actorId, 'server', 'HTTP writes must retain the resolved account');
  } finally { await harness.cleanup(); }
});
