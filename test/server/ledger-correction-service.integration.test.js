import assert from 'node:assert/strict';
import test from 'node:test';
import { createLedgerCorrectionService, normalizeLedgerAuditFact } from '../../src/server/cashflow-ledger-correction-service.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createPostgresGlobalSchemaSql } from '../../src/server/cashflow-postgres-global-schema.js';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const budgetId = 'correction-writer';
const stamp = '2026-10-23T12:00:00.000Z';
/** Actual store rows include years, defaults and timestamps, not a JSON ledger. */
function payment(id, amount, type, date, extra = {}) {
  return { id, name: id, amount, type, date, confirmed_date: date, currency: 'PLN', ledger_currency: 'PLN',
    ledger_year: Number(date.slice(0, 4)), fx_rate: 1, buffered_fx_rate: 1, ledger_amount: amount,
    running_balance_pln: 0, occurrence_key: `manual:${id}:${type}:${date}`, created_at: `${date}T00:00:00.000Z`,
    updated_at: `${date}T00:00:00.000Z`, ...extra };
}
const income = payment('income', 500, 'income', '2018-01-01', { ledger_amount: null });
const expense = payment('expense', 400, 'expense', '2019-01-01');
const foreign = payment('foreign', 10, 'expense', '2020-01-01', { currency: 'EUR', fx_rate: 2, buffered_fx_rate: 2.2, ledger_amount: 22 });
const otherLedger = payment('other-currency', 700, 'income', '2017-01-01', { currency: 'EUR', ledger_currency: 'EUR', running_balance_pln: 700 });
const request = (id, extra = {}) => ({ id, targetId: income.id, expectedCorrectionId: null,
  replacement: { amount: 200, date: income.date }, reason: 'Reviewed actual payment', today: '2026-10-23',
  createdAt: stamp, actorId: 'synthetic-reviewer', ...extra });

/** Both backends lend their real financial transaction/writer. Production
 * initialization now creates the audit tables; fixtures add no substitute DDL. */
async function exercise(store) {
  for (const row of [otherLedger, income, expense, foreign]) await store.insertConfirmedTransactions(budgetId, [row]);
  const transaction = action => {
    const own = store.backend === 'postgres' ? callback => store.transaction(callback)
      : callback => store.planningTransaction(budgetId, callback);
    return own(async (writer, connection) => {
      if (store.backend === 'postgres') await writer.lockBudgetLedger(budgetId);
      const query = async (sql, parameters = []) => {
        if (store.backend === 'postgres') {
          let index = 0;
          return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), parameters)).rows;
        }
        const statement = connection.prepare(sql);
        return statement.reader ? statement.all(...parameters) : (statement.run(...parameters), []);
      };
      return action({ writer, query, service: createLedgerCorrectionService({ budgetId, writer, query }) });
    });
  };
  const correct = input => transaction(({ service }) => service.correct(input));
  const snapshot = () => transaction(({ service }) => service.audit.exportSnapshot());
  await transaction(({ service }) => service.audit.ensureLegacyBaseline({ capturedAt: stamp }));
  const originalSnapshot = await snapshot();
  assert.equal(originalSnapshot.originals.find(item => item.row.id === income.id).row.ledger_amount, 500);
  assert.equal((await correct(request('blocked'))).event.status, 'blocked');
  assert.equal((await store.listConfirmedTransactions(budgetId)).find(row => row.id === income.id).amount, 500);
  await correct(request('resolve-expense', { targetId: expense.id, replacement: { amount: 100, date: expense.date } }));
  const retry = await correct(request('retry-income', { retryOf: 'blocked' }));
  assert.equal(retry.event.status, 'accepted');
  assert.equal(retry.plan.balances.at(-1).running_balance_pln, 78);
  await correct(request('void-expense', { targetId: expense.id, expectedCorrectionId: 'resolve-expense', replacement: null }));
  assert.equal((await store.listConfirmedTransactions(budgetId)).some(row => row.id === expense.id), false);
  await correct(request('void-expense-again', { targetId: expense.id, expectedCorrectionId: 'void-expense', replacement: null }));
  await correct(request('restore-expense', { targetId: expense.id, expectedCorrectionId: 'void-expense-again', replacement: { amount: 50, date: '2021-01-01' } }));
  const moved = await correct(request('move-income-year', { expectedCorrectionId: 'retry-income', replacement: { amount: 200, date: '2019-12-01' } }));
  assert.equal(moved.event.status, 'accepted');
  assert.equal((await store.listConfirmedTransactions(budgetId, { ledgerYear: 2018 })).some(row => row.id === income.id), false);
  assert.equal((await store.listConfirmedTransactions(budgetId, { ledgerYear: 2019 })).find(row => row.id === income.id).date, '2019-12-01');
  assert.equal((await snapshot()).originals.find(item => item.row.id === income.id).row.ledger_year, 2018);

  const newPayment = payment('new-payment', 40, 'income', '2022-01-01', { source_one_off_id: 'new-source', running_balance_pln: 168 });
  await transaction(async ({ writer, service }) => {
    await writer.insertPlanningRows(budgetId, 'one_off_transactions', [{ id: 'new-source', name: 'New source', currency: 'PLN', amount: 100,
      type: 'income', date: '2022-01-01', created_at: stamp, updated_at: stamp }]);
    await writer.insertConfirmedTransactions(budgetId, [newPayment]);
    await service.capturePayment({ paymentId: newPayment.id, actorId: 'synthetic-writer', capturedAt: stamp });
  });
  await transaction(({ writer }) => writer.updatePlanningRowsById(budgetId, 'one_off_transactions', [{ id: 'new-source', amount: 999 }]));
  const captured = (await snapshot()).originals.find(item => item.row.id === newPayment.id);
  assert.equal(captured.sourceAtAcceptance.row.amount, 100, 'Later planning must not become acceptance evidence');
  const adjustedFx = await correct(request('correct-foreign', { targetId: foreign.id, replacement: { amount: 5, date: foreign.date } }));
  assert.equal(adjustedFx.event.after.fx_rate, 2); assert.equal(adjustedFx.event.after.buffered_fx_rate, 2.2);
  assert.equal(adjustedFx.event.after.ledger_amount, 11);
  assert.equal(adjustedFx.plan.balances.at(-1).running_balance_pln, 179);
  assert.deepEqual((await store.listConfirmedTransactions(budgetId)).find(row => row.id === otherLedger.id),
    { ...originalSnapshot.originals.find(item => item.row.id === otherLedger.id).row, running_balance_pln: 700,
      ledger_year: (await store.listConfirmedTransactions(budgetId)).find(row => row.id === otherLedger.id).ledger_year });
  const beforeFailure = await snapshot();
  const ledgerBeforeFailure = await store.listConfirmedTransactions(budgetId);
  const rollbackInput = request('must-roll-back', { expectedCorrectionId: 'move-income-year', replacement: { amount: 250, date: '2019-12-01' } });
  await assert.rejects(transaction(async ({ service }) => {
    await service.correct(rollbackInput); throw new Error('injected projection/journal failure');
  }), /injected projection/);
  assert.deepEqual(await snapshot(), beforeFailure);
  assert.deepEqual(await store.listConfirmedTransactions(budgetId), ledgerBeforeFailure);
  await assert.rejects(transaction(async ({ writer, query }) => {
    const failing = { ...writer, updateConfirmedLedgerBalances: async () => ({ updated: 1000 }) };
    await createLedgerCorrectionService({ budgetId, writer: failing, query }).correct(rollbackInput);
  }), /facts and balances differ/);
  assert.deepEqual(await snapshot(), beforeFailure);
  assert.deepEqual(await store.listConfirmedTransactions(budgetId), ledgerBeforeFailure);
  await assert.rejects(transaction(async ({ writer, query }) => {
    const failing = { ...writer, insertConfirmedTransactions: async () => { throw new Error('injected ledger insert failure'); } };
    await createLedgerCorrectionService({ budgetId, writer: failing, query }).correct(rollbackInput);
  }), /injected ledger insert/);
  assert.deepEqual(await snapshot(), beforeFailure);
  assert.deepEqual(await store.listConfirmedTransactions(budgetId), ledgerBeforeFailure);
  await transaction(async ({ writer, query }) => {
    const refuseWrites = async () => { throw new Error('Replay must not apply money'); };
    const strict = { ...writer, deleteConfirmedTransactionsById: refuseWrites, insertConfirmedTransactions: refuseWrites,
      updateConfirmedLedgerBalances: refuseWrites };
    const replay = await createLedgerCorrectionService({ budgetId, writer: strict, query }).correct(request('move-income-year', {
      expectedCorrectionId: 'retry-income', replacement: { amount: 200, date: '2019-12-01' } }));
    assert.equal(replay.replayed, true); assert.equal(replay.plan, null);
  });
  assert.deepEqual(await snapshot(), beforeFailure);
}

test('real SQLite writer applies corrections across ledger years and rolls failures back', async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId });
  try {
    const db = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
    await exercise(createSqliteBudgetStore(db));
  } finally { await harness.cleanup(); }
});

test('real PostgreSQL writer applies the same correction and rollback contract', { skip: !postgresRuntimeTestsEnabled() },
  async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await pool.query(createPostgresGlobalSchemaSql());
    await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
    const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
    try {
      await store.initialize();
      await exercise(store);
      const beforeDelete = await pool.query('SELECT count(*)::integer AS n FROM cashflow_ledger_originals WHERE budget_id=$1', [budgetId]);
      assert.equal(beforeDelete.rows[0].n > 0, true);
      await pool.query('DELETE FROM budgets WHERE id=$1', [budgetId]);
      for (const table of ['cashflow_ledger_audit_state', 'cashflow_ledger_originals', 'cashflow_ledger_corrections']) {
        assert.equal((await pool.query(`SELECT count(*)::integer AS n FROM ${table} WHERE budget_id=$1`, [budgetId])).rows[0].n, 0);
      }
    } finally {
      try { await pool.query('DROP TABLE IF EXISTS cashflow_ledger_origins, cashflow_ledger_corrections, cashflow_ledger_originals, cashflow_ledger_audit_state'); }
      finally { await store.close(); }
    }
  }));

test('audit normalization preserves facts across database timestamp/year representations', () => {
  const value = payment('timestamp', 50, 'income', '2020-01-01');
  assert.deepEqual(normalizeLedgerAuditFact({ ...value, ledger_year: '2020', created_at: '2020-01-01 00:00:00',
    updated_at: new Date(value.updated_at), ledger_amount: null }, budgetId), normalizeLedgerAuditFact(value, budgetId));
  for (const extra of [{ budget_id: 'foreign' }, { created_at: '2020-01-01T00:00:00' },
    { created_at: '2020-02-30T00:00:00Z' }, { updated_at: '2020-01-01T24:00:00Z' }]) {
    assert.throws(() => normalizeLedgerAuditFact({ ...value, ...extra }, budgetId));
  }
});
