import assert from 'node:assert/strict';
import test from 'node:test';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createPostgresGlobalSchemaSql } from '../../src/server/cashflow-postgres-global-schema.js';
import { createLedgerCorrectionService } from '../../src/server/cashflow-ledger-correction-service.js';
import { createBudgetStoreSnapshot, normalizeBudgetStoreSnapshot, restoreBudgetStoreSnapshot } from '../../src/server/cashflow-budget-store-snapshot.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createCashflowProjectionStateService } from '../../src/server/cashflow-projection-state-service.js';
import { createAppSnapshotService } from '../../src/server/cashflow-app-snapshot-service.js';

const budgetId = 'audit-backup';
const stamp = '2026-10-23T12:00:00.000Z';
/** Accepted facts use the real runtime ledger, including original year and FX. */
function payment(id, amount, type, date) {
  return { id, name: id, amount, type, date, confirmed_date: date, ledger_year: Number(date.slice(0,4)),
    currency: 'PLN', ledger_currency: 'PLN', fx_rate: 1, buffered_fx_rate: 1, ledger_amount: amount,
    occurrence_key: `manual:${id}`, running_balance_pln: type === 'income' ? amount : 100,
    created_at: `${date}T12:00:00.000Z`, updated_at: `${date}T12:00:00.000Z` };
}
/** Use the same owning connection, lock and actual writer as financial commits. */
function transaction(store, work) {
  const own = store.backend === 'postgres' ? fn => store.transaction(fn) : fn => store.planningTransaction(budgetId, fn);
  return own(async (writer, connection) => {
    if (store.backend === 'postgres') await writer.lockBudgetLedger(budgetId);
    const query = async (sql, values = []) => {
      if (store.backend === 'postgres') {
        let index = 0;
        return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), values)).rows;
      }
      const statement = connection.prepare(sql);
      return statement.reader ? statement.all(...values) : (statement.run(...values), []);
    };
    return work({ writer, service: createLedgerCorrectionService({ budgetId, writer, query }) });
  });
}

/** Full snapshot replacement retains originals/blocked work and rolls back a
 * late audit failure together with the restored facts on both real databases. */
async function exercise(store, harness = null) {
  await store.insertPlanningRows(budgetId, 'one_off_transactions', [{ id: 'installment-source', name: 'Old installment',
    amount: 400, type: 'expense', currency: 'PLN', date: '2019-01-01', created_at: stamp, updated_at: stamp }]);
  for (const row of [payment('income', 500, 'income', '2018-01-01'), {
    ...payment('expense', 400, 'expense', '2019-01-01'), source_one_off_id: 'installment-source',
    occurrence_key: 'one_off_remainder:installment-source:7' }]) {
    await store.insertConfirmedTransactions(budgetId, [row]);
  }
  await transaction(store, ({ service }) => service.audit.ensureLegacyBaseline({ capturedAt: stamp }));
  const correct = (id, extra = {}) => transaction(store, ({ service }) => service.correct({
    id, targetId: 'income', expectedCorrectionId: null, replacement: { amount: 200, date: '2018-01-01' },
    reason: 'Reviewed historical payment', actorId: 'reviewer', createdAt: stamp, today: '2026-10-23', ...extra }));
  assert.equal((await correct('blocked')).event.status, 'blocked');
  await correct('resolve', { targetId: 'expense', replacement: { amount: 100, date: '2019-01-01' } });
  await correct('retry', { retryOf: 'blocked' });
  await correct('void', { targetId: 'expense', expectedCorrectionId: 'resolve', replacement: null });
  const progressState = createCashflowProjectionStateService({ budgetStore: store,
    ...(harness ? { openPlanningDb: harness.openPlanningDb, loadAllConfirmedTransactions: () => {
      const db = harness.openPlanningDb();
      try { return db.prepare('SELECT * FROM ledger_transactions').all(); } finally { db.close(); }
    } } : {}) });
  const expectedProgress = { sourceId: 'installment-source', type: 'expense', currency: 'PLN', confirmedAmount: 0, confirmedCount: 7 };
  assert.deepEqual((await progressState.confirmedOneOffProgressAsync(budgetId)).get('installment-source:expense:PLN'), expectedProgress);
  await transaction(store, async ({ writer }) => {
    assert.deepEqual((await progressState.confirmedOneOffProgressAsync(budgetId, writer)).get('installment-source:expense:PLN'), expectedProgress);
  });
  if (harness) assert.deepEqual(progressState.confirmedOneOffProgress(budgetId).get('installment-source:expense:PLN'), expectedProgress);
  const preview = await createAppSnapshotService({ budgetStore: store })(budgetId);
  assert.deepEqual(new Map(preview.request.oneOffProgress).get('installment-source:expense:PLN'), expectedProgress);
  assert.equal(preview.writesSupported, false);
  assert.doesNotMatch(JSON.stringify(preview), /Reviewed historical payment|reviewer/);
  if (harness) {
    await harness.api('/api/regenerate-projections', { method: 'POST', body: {} });
    const pending = (await harness.api('/api')).pendingTransactions.find(row => row.source_one_off_id === 'installment-source');
    assert.equal(pending.occurrence_key, 'one_off_remainder:installment-source:8');
    assert.equal(pending.requested_amount, 400);
  }
  const snapshot = await createBudgetStoreSnapshot({ budgetStore: store, budgetIds: [budgetId], now: new Date(stamp) });
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.ledgerAudits.length, 1);
  assert.equal(snapshot.ledgerAudits[0].originals.length, 2);
  assert.equal(snapshot.ledgerAudits[0].corrections.length, 4);
  let unboundWrites = 0;
  await assert.rejects(restoreBudgetStoreSnapshot({ snapshot, budgetStore: {
    replacePlanningRows: async () => { unboundWrites++; },
    replaceConfirmedTransactionsForYear: async () => { unboundWrites++; }
  } }), /transaction-bound audit writer/);
  assert.equal(unboundWrites, 0);
  await correct('restore-later', { targetId: 'expense', expectedCorrectionId: 'void', replacement: { amount: 50, date: '2021-01-01' } });
  assert.deepEqual((await progressState.confirmedOneOffProgressAsync(budgetId)).get('installment-source:expense:PLN'),
    { ...expectedProgress, confirmedAmount: 50 });
  await transaction(store, async ({ writer, service }) => {
    await writer.insertConfirmedTransactions(budgetId, [{ ...payment('later-income', 30, 'income', '2022-01-01'), running_balance_pln: 180 }]);
    await service.capturePayment({ paymentId: 'later-income', actorId: 'reviewer', capturedAt: stamp });
  });
  const beforeFailure = await store.listConfirmedTransactions(budgetId);
  const auditBeforeFailure = await store.exportLedgerAuditSnapshot(budgetId);
  await assert.rejects(restoreBudgetStoreSnapshot({ budgetStore: store, snapshot, onBatch(batch) {
    if (batch.tableName === 'ledger-audit') throw new Error('Injected late audit restore failure');
  } }), /Injected late audit restore failure/);
  assert.deepEqual(await store.listConfirmedTransactions(budgetId), beforeFailure);
  assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), auditBeforeFailure);
  await restoreBudgetStoreSnapshot({ budgetStore: store, snapshot: JSON.parse(JSON.stringify(snapshot)) });
  assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), snapshot.ledgerAudits[0]);
  assert.equal((await store.listConfirmedTransactions(budgetId)).length, 1);
  const replay = await correct('blocked');
  assert.equal(replay.replayed, true);
  assert.equal(replay.event.status, 'blocked');
  assert.equal(replay.plan, null);
  for (const mutate of [
    s => { s.ledgerAudits[0].budgetId = 'another-budget'; },
    s => { s.ledgerAudits.push(structuredClone(s.ledgerAudits[0])); },
    s => { s.payload.tables.confirmed_transactions[0].amount += 1; },
    s => { s.version = 1; },
    s => { s.ledgerAudits = 'lost'; },
    s => { s.ledgerAudits = null; },
    s => { delete s.ledgerAudits; }
  ]) {
    const damaged = structuredClone(snapshot); mutate(damaged);
    assert.throws(() => normalizeBudgetStoreSnapshot(damaged));
    await assert.rejects(restoreBudgetStoreSnapshot({ budgetStore: store, snapshot: damaged }));
    assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), snapshot.ledgerAudits[0]);
  }
  const alteredTotals = structuredClone(snapshot);
  alteredTotals.payload.tables.confirmed_transactions[0].running_balance_pln = 999999;
  await restoreBudgetStoreSnapshot({ budgetStore: store, snapshot: alteredTotals });
  assert.equal((await store.listConfirmedTransactions(budgetId))[0].running_balance_pln, 200);
  assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), snapshot.ledgerAudits[0]);
  const legacy = structuredClone(snapshot); legacy.version = 1; delete legacy.ledgerAudits;
  await restoreBudgetStoreSnapshot({ budgetStore: store, snapshot: legacy });
  assert.equal(await store.exportLedgerAuditSnapshot(budgetId), null);
  assert.equal((await store.listConfirmedTransactions(budgetId))[0].amount, 200);
}

test('SQLite budget snapshots preserve correction audit and roll back late replacement failures', async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId });
  try { await exercise(createSqliteBudgetStore(createCashflowDbService(createCashflowStoragePaths(harness.dataDir))), harness); }
  finally { await harness.cleanup(); }
});

test('PostgreSQL budget snapshots preserve the same audit and atomic replacement contract', {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
  const store = await createPostgresBudgetStore({ databaseUrl });
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, 'settings', [{ id: 1, updated_at: stamp }]);
    await exercise(store);
  } finally { await store.close(); }
}));
