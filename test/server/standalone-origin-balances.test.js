import assert from 'node:assert/strict';
import test from 'node:test';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createPostgresGlobalSchemaSql } from '../../src/server/cashflow-postgres-global-schema.js';
import { createCashflowLedgerService } from '../../src/server/cashflow-ledger-service.js';
import { createCashflowProjectionStateService } from '../../src/server/cashflow-projection-state-service.js';
import { createCashflowPendingConfirmationService } from '../../src/server/cashflow-pending-confirmation-service.js';
import { hostPlanningStore } from '../../src/server/cashflow-financial-operation-service.js';
import { createCashflowSettingsService } from '../../src/server/cashflow-settings-service.js';
import { createLedgerCorrectionService } from '../../src/server/cashflow-ledger-correction-service.js';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { correctLocalConfirmation } from '../../src/engine/local-confirmation.js';
import { standaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const budgetId = 'server-origin-audit', stamp = '2026-06-02T12:00:00.000Z';
const upgraded = { allowStandaloneOrigins: true };

/** Each check uses its owning writer, including uncommitted proof. Reading
 * from the root store inside this transaction would miss the origin or hang. */
function transaction(store, work) {
  const own = store.backend === 'postgres' ? fn => store.transaction(fn) : fn => store.planningTransaction(budgetId, fn);
  return own(async (writer, connection) => {
    if (store.backend === 'postgres') await writer.lockBudgetLedger(budgetId);
    const query = async (sql, values = []) => {
      if (store.backend === 'postgres') { let index = 0; return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), values)).rows; }
      const statement = connection.prepare(sql);
      return statement.reader ? statement.all(...values) : (statement.run(...values), []);
    };
    return work(writer, createLedgerCorrectionService({ budgetId, writer, query, ...upgraded }), connection);
  });
}

/** A real locally voided payment leaves no effective rows. The implicit
 * opening and reserved installment must still drive balances and projections. */
async function exercise(store, sqlite = null) {
  const { snapshot } = standaloneOriginAuditFixture();
  const voided = correctLocalConfirmation({ snapshot, today: '2026-06-02', generationTimestamp: stamp,
    confirmationId: 'confirmed-original', expectedCorrectionId: null, replacement: null,
    reason: 'Synthetic retained void', idSeed: 'local-void' });
  const audit = { version: 2, budgetId, baselineComplete: true, lastSequence: 2,
    origin: standaloneLedgerOrigin(voided, stamp), originals: [], corrections: [] };
  await store.insertPlanningRows(budgetId, 'one_off_transactions', [{ id: 'source', name: 'Source', type: 'expense',
    amount: 400, currency: 'PLN', date: '2026-06-02', created_at: stamp, updated_at: stamp }]);
  await store.insertPlanningRows(budgetId, 'pending_transactions', [{ id: 'future-payment', name: 'Future expense',
    amount: 20, currency: 'PLN', type: 'expense', date: '2999-01-01', ledger_currency: 'PLN', ledger_amount: 20,
    occurrence_key: 'manual:future-payment', created_at: stamp, updated_at: stamp }]);
  await transaction(store, async (writer, service) => {
    await service.audit.restoreSnapshot(audit);
    const ledger = createCashflowLedgerService({ budgetStore: writer, ...upgraded });
    assert.equal(await ledger.latestConfirmedBalanceAsync(budgetId), 500);
    assert.equal(await writer.ledgerOpeningBalance(budgetId, 'PLN'), 500);
    assert.equal(await writer.ledgerOpeningBalance(budgetId, 'EUR'), 0);
    const candidate = { id: 'candidate', type: 'expense', amount: 50, date: '2026-06-03', created_at: stamp, fx_rate: 1 };
    assert.equal(await ledger.wouldLedgerGoNegativeAfterInsertAsync(budgetId, candidate, {}, writer), false);
    assert.equal(await ledger.wouldLedgerGoNegativeAfterInsertAsync(budgetId, { ...candidate, amount: 501 }, {}, writer), true);
  });
  const ledger = createCashflowLedgerService({ budgetStore: store, ...sqlite, ...upgraded });
  const projection = createCashflowProjectionStateService({ budgetStore: store, ...sqlite, ...upgraded,
    latestConfirmedBalance: ledger.latestConfirmedBalance, loadAllConfirmedTransactions: ledger.loadAllConfirmedTransactions });
  assert.equal(await ledger.latestConfirmedBalanceAsync(budgetId), 500);
  assert.equal(await ledger.latestConfirmedBalanceAsync(budgetId, { ledgerCurrency: 'EUR' }), 0);
  assert.equal(await projection.confirmedBalanceAsOfAsync(budgetId, '2026-06-01'), 500);
  assert.equal((await projection.recalculatePlanningRunningBalancesAsync(budgetId)).plan.updates[0].running_balance, 480);
  const progress = await projection.confirmedOneOffProgressAsync(budgetId);
  assert.equal(progress.get('source:expense:PLN').confirmedCount, 1);
  assert.equal(progress.get('source:expense:PLN').confirmedAmount, 0);
  if (sqlite) {
    assert.equal(ledger.latestConfirmedBalance(budgetId), 500);
    assert.deepEqual(projection.confirmedOneOffProgress(budgetId), progress);
    const db = sqlite.openPlanningDb(budgetId);
    try { assert.equal(projection.confirmedBalanceAsOf(db, budgetId, '2026-06-01'), 500); }
    finally { db.close(); }
  }
  await transaction(store, async (writer, service) => {
    await service.correct({ id: 'restore', targetId: 'confirmed-original', expectedCorrectionId: 'correction-local-void',
      replacement: { amount: 400, date: '2026-06-02' }, reason: 'Restore retained payment', today: '2026-06-02',
      createdAt: stamp, actorId: 'synthetic-reviewer' });
    const ownLedger = createCashflowLedgerService({ budgetStore: writer, ...upgraded });
    const result = await ownLedger.recalculateLedgerRunningBalanceAsync(budgetId);
    assert.equal(result.latestBalance, 100);
    assert.equal((await writer.listConfirmedTransactions(budgetId))[0].running_balance_pln, 100);
  });
  assert.equal(await projection.confirmedBalanceAsOfAsync(budgetId, '2026-06-01'), 500);
  assert.equal(await projection.confirmedBalanceAsOfAsync(budgetId, '2026-06-02'), 100);
  assert.equal((await projection.recalculatePlanningRunningBalancesAsync(budgetId)).plan.updates[0].running_balance, 80);
  assert.equal(await ledger.latestConfirmedBalanceAsync(budgetId), 100);
  if (sqlite) {
    ledger.recalculateLedgerRunningBalance(budgetId);
    assert.equal(ledger.latestConfirmedBalance(budgetId), 100);
  }
  // Exercise actual confirmation, capture and balances, then fail late so this
  // fixture also proves the origin and pending work survive owning rollback.
  await assert.rejects(transaction(store, async writer => {
    const facade = hostPlanningStore(writer);
    const ownLedger = createCashflowLedgerService({ budgetStore: facade, ...upgraded });
    const actions = createCashflowPendingConfirmationService({ budgetStore: facade,
      newestConfirmedTransactionDateAsync: ownLedger.newestConfirmedTransactionDateAsync,
      wouldLedgerGoNegativeAfterInsertAsync: ownLedger.wouldLedgerGoNegativeAfterInsertAsync,
      getConfirmedFxForDate: () => ({ fxRate: 1, bufferedFxRate: 1 }),
      withProjectionStatus: async (_id, result) => result });
    const accepted = await actions.confirmPendingTransaction(budgetId, 'future-payment',
      { amount: 20, confirmed_date: '2026-06-03' }, { actorId: 'synthetic-reviewer' });
    assert.equal(accepted.running_balance_pln, 80);
    assert.equal((await writer.exportLedgerAuditSnapshot(budgetId)).originals.length, 1);
    throw new Error('Injected late confirmation failure');
  }), /Injected late confirmation failure/);
  assert.equal(await ledger.latestConfirmedBalanceAsync(budgetId), 100);
  assert.ok((await store.listPlanningRows(budgetId, 'pending_transactions')).some(row => row.id === 'future-payment'));
  await transaction(store, async (writer, service) => {
    await service.correct({ id: 'void-again', targetId: 'confirmed-original', expectedCorrectionId: 'restore', replacement: null,
      reason: 'Explicit later void', today: '2026-06-02', createdAt: stamp, actorId: 'synthetic-reviewer' });
    const empty = structuredClone(audit);
    empty.lastSequence = 0; empty.origin.events = []; empty.origin.legacyCount = 0; empty.origin.openingBalance = -50;
    await writer.replaceLedgerAuditSnapshot(budgetId, empty);
    assert.equal(await writer.ledgerOpeningBalance(budgetId, 'PLN'), -50);
    assert.equal(await createCashflowLedgerService({ budgetStore: writer }).latestConfirmedBalanceAsync(budgetId), -50);
  });
  assert.equal(await ledger.latestConfirmedBalanceAsync(budgetId), -50);
  assert.equal((await projection.recalculatePlanningRunningBalancesAsync(budgetId)).plan.updates[0].running_balance, -70);
  await assert.rejects(transaction(store, async writer => {
    const facade = hostPlanningStore(writer);
    const settings = createCashflowSettingsService({ budgetStore: facade, getCachedFxRateAsync: async () => 0.5 });
    await settings.updateSettings(budgetId, { ledger_currency: 'EUR' });
    const event = (await writer.listPlanningRows(budgetId, 'ledger_currency_events'))[0];
    assert.equal(event.old_balance, -50);
    assert.equal(event.converted_opening_balance, -25);
    assert.equal(await writer.ledgerOpeningBalance(budgetId, 'EUR'), 0);
    assert.equal(await writer.ledgerOpeningBalance(budgetId, 'PLN'), -50);
    throw new Error('Injected late currency failure');
  }), /Injected late currency failure/);
  assert.equal((await store.listPlanningRows(budgetId, 'settings'))[0].ledger_currency, 'PLN');
  assert.equal((await store.listPlanningRows(budgetId, 'ledger_currency_events')).length, 0);
  // Browser settings use the same origin proof, including an uploaded empty
  // signed history. SQLite exercises its native synchronous settings branch.
  await createCashflowSettingsService({ budgetStore: store, ...sqlite,
    latestConfirmedBalance: ledger.latestConfirmedBalance,
    latestConfirmedBalanceAsync: ledger.latestConfirmedBalanceAsync,
    getCachedFxRate: () => 0.5, getCachedFxRateAsync: async () => 0.5
  }).updateSettings(budgetId, { ledger_currency: 'EUR' });
  const converted = (await store.listPlanningRows(budgetId, 'pending_transactions'))
    .find(row => row.occurrence_key.startsWith('ledger_currency_conversion:'));
  assert.equal(Number(converted.amount), 25);
  assert.equal(converted.type, 'expense');
  const currencyEvent = (await store.listPlanningRows(budgetId, 'ledger_currency_events'))[0];
  assert.equal(Number(currencyEvent.old_balance), -50);
  assert.equal(Number(currencyEvent.converted_opening_balance), -25);
  assert.equal(await store.ledgerOpeningBalance(budgetId, 'PLN'), -50);
  assert.equal(await store.ledgerOpeningBalance(budgetId, 'EUR'), 0);
}

test('SQLite origin balances retain signed openings, cutoff history and voided installment progress', async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId });
  try {
    const db = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
    await exercise(createSqliteBudgetStore({ ...db, ...upgraded }), db);
  } finally { await harness.cleanup(); }
});

test('PostgreSQL origin balances and projection inputs use the owning transaction and currency', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Synthetic balance',now(),now())", [budgetId]);
  const store = await createPostgresBudgetStore({ databaseUrl, ...upgraded });
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, 'settings', [{ id: 1, ledger_currency: 'PLN', updated_at: stamp }]);
    await exercise(store);
  } finally { await store.close(); }
}));
