import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createPostgresGlobalSchemaSql } from '../../src/server/cashflow-postgres-global-schema.js';
import { FINANCIAL_JOURNAL_SCHEMA } from '../../src/server/cashflow-financial-journal.js';
import { appSyncCapabilities } from '../../src/server/cashflow-app-sync-contract.js';
import { createFinancialOperationService, hostPlanningStore } from '../../src/server/cashflow-financial-operation-service.js';
import { createCashflowLedgerService } from '../../src/server/cashflow-ledger-service.js';
import { createCashflowProjectionStateService } from '../../src/server/cashflow-projection-state-service.js';
import { createCashflowPredictionService } from '../../src/server/cashflow-prediction-service.js';
import { createCashflowProjectionEngineService } from '../../src/server/cashflow-projection-engine-service.js';
import { createCashflowProjectionCoordinatorService } from '../../src/server/cashflow-projection-coordinator-service.js';
import { createCashflowPendingConfirmationService } from '../../src/server/cashflow-pending-confirmation-service.js';
import { createCashflowPendingTransitionService } from '../../src/server/cashflow-pending-transition-service.js';
import { createLedgerCorrectionService } from '../../src/server/cashflow-ledger-correction-service.js';
import { setTodayOverrideForTests } from '../../src/server/cashflow-date-utils.js';

const instanceId = '11111111-1111-4111-8111-111111111111';
const budgetId = 'reserve-operations';
const today = '2026-06-01';
const stamp = `${today}T00:00:00.000Z`;
const key = side => `reserve_transfer:2026-06:2026-07:${side}`;

/** Use the real coordinator/engine, confirmation, transition, ledger and audit
 * services over the host writer. The only substitutes are authorization and FX
 * for synthetic same-currency fixtures; no external data or provider is read. */
function services(store) {
  const ledger = createCashflowLedgerService({ budgetStore: store });
  const state = createCashflowProjectionStateService({ budgetStore: store });
  const prediction = createCashflowPredictionService({ budgetStore: store });
  const engine = createCashflowProjectionEngineService({ budgetStore: store, ...state, ...prediction,
    safeGetCurrentFxSnapshotAsync: async () => ({}), getCachedFxSnapshotAsync: async () => ({}), logServerEvent: () => {} });
  const coordinator = createCashflowProjectionCoordinatorService({ budgetStore: store, ...state,
    regenerateProjectionsAsync: engine.regenerateProjectionsAsync, logCashflowError: () => {} });
  const withProjectionStatus = (id, row, options = {}) => coordinator.withProjectionStatus(id, row, { ...options, store });
  const confirm = createCashflowPendingConfirmationService({ budgetStore: store,
    getConfirmedFxForDate: async () => ({ fxRate: 1, bufferedFxRate: 1 }),
    newestConfirmedTransactionDateAsync: ledger.newestConfirmedTransactionDateAsync,
    wouldLedgerGoNegativeAfterInsertAsync: ledger.wouldLedgerGoNegativeAfterInsertAsync, withProjectionStatus });
  const transition = createCashflowPendingTransitionService({ budgetStore: store, normalizePendingStatus: state.normalizePendingStatus, withProjectionStatus });
  return { ...confirm, ...transition, project: () => engine.regenerateProjectionsAsync(budgetId, store) };
}
function host(store, afterRecord = null) {
  return createFinancialOperationService({ budgetStore: store, afterRecord,
    authorize: async () => ({ instanceId, accountId: 'synthetic-owner', budgetId }),
    project: ({ writer }) => services(writer).project(), ledgerActions: ({ store: writer }) => services(writer) });
}
const transaction = (store, work) => store.backend === 'postgres' ? store.transaction(work) : store.planningTransaction(budgetId, work);

/** Reproject from genuine planning sources, then exercise either side first.
 * Browser actions consume exactly these rows through the same service factory. */
async function exercise(store, epoch, side, recordedAmount) {
  await store.insertConfirmedTransactions(budgetId, [{ id: 'opening', name: 'Synthetic opening', currency: 'PLN', amount: 150,
    type: 'income', date: '2026-05-31', confirmed_date: '2026-05-31', ledger_year: 2026, fx_rate: 1, buffered_fx_rate: 1,
    ledger_currency: 'PLN', ledger_amount: 150, running_balance_pln: 150, occurrence_key: 'synthetic-opening', created_at: stamp, updated_at: stamp }]);
  await store.insertPlanningRows(budgetId, 'planned_transactions', [{ id: 'goal-plan', type: 'goal', goal_priority: 1, created_at: stamp, updated_at: stamp }]);
  await store.insertPlanningRows(budgetId, 'goals', [{ id: 'goal', name: 'June goal', amount: 150, currency: 'PLN', active: 1,
    due_date: '2026-06-20', planned_transaction_id: 'goal-plan', created_at: stamp, updated_at: stamp }]);
  await store.insertPlanningRows(budgetId, 'one_off_transactions', [{ id: 'bill', name: 'July bill', amount: 100, currency: 'PLN', type: 'expense', date: '2026-07-10', created_at: stamp, updated_at: stamp }]);
  await transaction(store, writer => services(writer).project());
  const api = host(store);
  let revision = 0;
  const op = (kind, payload) => ({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: revision, kind, payload });
  const payload = (which, amount = 80, date = today) => ({ occurrenceKey: key(which), amount, confirmedDate: date, fxRate: null });
  const accept = async operation => { const receipt = await api.apply(operation); revision = receipt.revision; return receipt; };
  const future = await store.listPlanningRows(budgetId, 'future_transactions');
  assert.equal(future.find(row => row.occurrence_key === key(side)).amount, 100);
  const originalFuture = JSON.stringify(future);
  // All these failures leave both planning and financial state at the same head.
  for (const [bad, pattern] of [
    [payload('out', 151), /negative/],
    [{ ...payload(side), fxRate: 2 }, /FX_RATE_NOT_APPLICABLE/],
    [payload(side, -1), /amount/], [payload(side, 1.001), /amount/],
    [payload(side, 80, '2026-02-30'), /date/i],
    [{ ...payload(side), occurrenceKey: 'reserve_transfer:2026-07:2026-06:out' }, /identity/],
    [{ ...payload(side), occurrenceKey: 'reserve_transfer:2026-06:2026-08:out' }, /OCCURRENCE_NOT_FOUND/]
  ]) {
    const operation = op('occurrence.confirm', bad);
    await assert.rejects(() => api.apply(operation), pattern);
    assert.equal(await api.lookup({ budgetId, epoch, operationId: operation.operationId }), null);
    assert.equal(JSON.stringify(await store.listPlanningRows(budgetId, 'future_transactions')), originalFuture);
    assert.equal((await store.listPlanningRows(budgetId, 'pending_transactions')).length, 0);
    assert.equal((await store.listConfirmedTransactions(budgetId)).length, 1);
  }
  // The browser service refuses backdating across a ledger currency change.
  // Exercise that same refusal before a successful actual-date override.
  await store.insertPlanningRows(budgetId, 'ledger_currency_events', [{ id: 'currency-boundary', old_currency: 'EUR',
    new_currency: 'PLN', old_balance: 37.5, converted_opening_balance: 150, fx_rate: 4,
    rate_date: today, source: 'synthetic', created_at: stamp }]);
  const beforeCurrency = op('occurrence.confirm', payload(side, recordedAmount, '2026-05-31'));
  await assert.rejects(() => api.apply(beforeCurrency), /before the latest ledger currency change/);
  assert.equal(await api.lookup({ budgetId, epoch, operationId: beforeCurrency.operationId }), null);
  assert.equal(JSON.stringify(await store.listPlanningRows(budgetId, 'future_transactions')), originalFuture);
  await store.deletePlanningRowsById(budgetId, 'ledger_currency_events', ['currency-boundary']);
  if (side === 'in') {
    const staged = future.find(row => row.occurrence_key === key(side));
    const { period, generation_timestamp, ...pending } = staged;
    await store.insertPlanningRows(budgetId, 'pending_transactions', [{ ...pending, pending_origin: 'manual', updated_at: stamp }]);
    await store.deletePlanningRowsById(budgetId, 'future_transactions', [staged.id]);
  }
  const beforeFailure = JSON.stringify(await store.listPlanningRows(budgetId, 'future_transactions'));
  const pendingBeforeFailure = await store.listPlanningRows(budgetId, 'pending_transactions');
  const operation = op('occurrence.confirm', payload(side, recordedAmount, '2026-05-31'));
  await assert.rejects(() => host(store, () => { throw new Error('reserve rollback probe'); }).apply(operation), /rollback probe/);
  assert.equal(await api.lookup({ budgetId, epoch, operationId: operation.operationId }), null);
  assert.equal(JSON.stringify(await store.listPlanningRows(budgetId, 'future_transactions')), beforeFailure);
  assert.deepEqual(await store.listPlanningRows(budgetId, 'pending_transactions'), pendingBeforeFailure);
  const receipt = await accept(operation);
  const fact = receipt.confirmedTransaction;
  assert.deepEqual([fact.occurrence_key, fact.type, fact.amount, fact.ledger_amount, fact.date, fact.confirmed_date],
    [key(side), side === 'out' ? 'expense' : 'income', recordedAmount, recordedAmount, '2026-05-31', '2026-05-31']);
  assert.equal((await api.apply(operation)).replayed, true);
  assert.deepEqual((await api.lookup({ budgetId, epoch, operationId: operation.operationId })).confirmedTransaction, fact);
  const changes = await api.changes({ budgetId, epoch, afterRevision: 0, limit: 100 });
  assert.equal(changes.changes.length, 1);
  assert.deepEqual(changes.changes[0].confirmedTransaction, fact);
  const other = side === 'out' ? 'in' : 'out';
  assert.equal((await store.listPlanningRows(budgetId, 'future_transactions')).find(row => row.occurrence_key === key(other)).amount, recordedAmount);
  await assert.rejects(() => api.apply(op('occurrence.confirm', payload(side))), /OCCURRENCE_NOT_FOUND/);

  // Reviewed corrections use the same source-less immutable evidence as browser
  // confirmations. Voiding regenerates the original pair; restoring re-locks it.
  const correction = replacement => op('ledger.correct', { targetId: fact.id, expectedCorrectionId: null, replacement, retryOf: null, reason: 'Review reserve' });
  const voidOp = correction(null);
  await accept(voidOp);
  assert.equal((await store.listConfirmedTransactions(budgetId)).some(row => row.id === fact.id), false);
  assert.equal((await store.listPlanningRows(budgetId, 'future_transactions')).find(row => row.occurrence_key === key(side)).amount, 100);
  await accept(op('ledger.correct', { targetId: fact.id, expectedCorrectionId: voidOp.operationId, retryOf: null,
    replacement: { amount: 90, date: today }, reason: 'Restore reviewed reserve' }));
  assert.equal((await store.listPlanningRows(budgetId, 'future_transactions')).find(row => row.occurrence_key === key(other)).amount, 90);
  await accept(op('occurrence.confirm', payload(other, 90)));
  assert.equal((await store.listPlanningRows(budgetId, 'future_transactions')).some(row => row.occurrence_key.startsWith('reserve_transfer:')), false);
  const accepted = await store.listConfirmedTransactions(budgetId);
  assert.equal(accepted.length, 3);
  assert.equal(accepted.at(-1).running_balance_pln, 150);
  await transaction(store, async (writer, connection) => {
    const query = async (sql, args = []) => {
      if (store.backend === 'postgres') { let i = 0; return (await connection.query(sql.replace(/\?/g, () => `$${++i}`), args)).rows; }
      const statement = connection.prepare(sql); return statement.reader ? statement.all(...args) : (statement.run(...args), []);
    };
    const audit = await createLedgerCorrectionService({ budgetId, writer, query }).audit.exportSnapshot();
    assert.equal(audit.originals.find(row => row.row.id === fact.id).sourceAtAcceptance, null);
    assert.equal(audit.corrections.length, 2);
  });
  assert.deepEqual((await api.lookup({ budgetId, epoch, operationId: operation.operationId })).confirmedTransaction, fact);
}

for (const side of ['out', 'in']) for (const recordedAmount of [80, 0]) {
  test(`SQLite reserve ${side} amount ${recordedAmount} confirms, locks, journals, corrects and rolls back like browser actions`, async () => {
    const harness = await createCashflowTestHarness({ userId: budgetId, today });
    const dbService = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
    const store = createSqliteBudgetStore(dbService), epoch = randomUUID();
    try {
      const db = dbService.openPlanningDb(budgetId);
      try { db.prepare('UPDATE settings SET future_periods = 2').run(); db.exec(FINANCIAL_JOURNAL_SCHEMA);
        db.prepare('INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 0)').run(budgetId, epoch); }
      finally { db.close(); }
      await exercise(store, epoch, side, recordedAmount);
      assert.deepEqual(harness.errors, []);
    } finally { await harness.cleanup(); }
  });
  test(`PostgreSQL reserve ${side} amount ${recordedAmount} confirms, locks, journals, corrects and rolls back like browser actions`, {
    skip: !postgresRuntimeTestsEnabled()
  }, () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await pool.query(createPostgresGlobalSchemaSql());
    await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Reserve fixture',now(),now())", [budgetId]);
    const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 }), epoch = randomUUID();
    const previousToday = setTodayOverrideForTests(today);
    try {
      await store.initialize();
      await store.insertPlanningRows(budgetId, 'settings', [{ id: 1, ledger_currency: 'PLN', future_periods: 2, updated_at: stamp }]);
      await pool.query(FINANCIAL_JOURNAL_SCHEMA);
      await pool.query('INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ($1,$2,0)', [budgetId, epoch]);
      await exercise(store, epoch, side, recordedAmount);
    } finally { setTodayOverrideForTests(previousToday); await store.close(); }
  }));
}

/** Reproduce the phone contract calendar and setup's pending opening. Forecast
 * funding is not confirmed money: both browser services and sync must refuse
 * the expense until the opening is recorded, then allow the same early/partial
 * reserve with a null FX rate. Device refusal also rolls the staging move back. */
async function exercisePendingOpening(store, epoch, path) {
  const date = '2026-05-20', occurrenceKey = 'reserve_transfer:2026-05:2026-06:out';
  const created = `${date}T12:00:00.000Z`;
  await store.insertPlanningRows(budgetId, 'pending_transactions', [{ id: 'opening-pending', name: 'Opening balance',
    currency: 'PLN', amount: 150, type: 'income', date, fx_rate: 1, buffered_fx_rate: 1, ledger_currency: 'PLN',
    funded_amount: 150, requested_amount: 150, ledger_amount: 150, status: 'pending', pending_origin: 'system',
    occurrence_key: 'first_run_opening_balance:opening-pending', created_at: created, updated_at: created }]);
  await store.insertPlanningRows(budgetId, 'planned_transactions', [{ id: 'goal-plan', type: 'goal', goal_priority: 1, created_at: created, updated_at: created }]);
  await store.insertPlanningRows(budgetId, 'goals', [{ id: 'goal', name: 'May goal', amount: 150, currency: 'PLN', active: 1,
    due_date: '2026-05-31', planned_transaction_id: 'goal-plan', created_at: created, updated_at: created }]);
  await store.insertPlanningRows(budgetId, 'one_off_transactions', [{ id: 'bill', name: 'June bill', amount: 100,
    currency: 'PLN', type: 'expense', date: '2026-06-10', created_at: created, updated_at: created }]);
  await transaction(store, writer => services(writer).project());
  const future = await store.listPlanningRows(budgetId, 'future_transactions');
  const reserve = future.find(row => row.occurrence_key === occurrenceKey);
  assert.ok(reserve);
  assert.deepEqual([reserve.date, reserve.requested_amount, reserve.funded_amount], ['2026-05-31', 100, 100]);
  const api = host(store);
  let revision = 0;
  const { protocolVersion, stateVersion, financialModelVersion, engineProtocolVersion, engineVersion } = appSyncCapabilities();
  const compatibility = { protocolVersion, stateVersion, financialModelVersion, engineProtocolVersion, engineVersion };
  const operation = key => ({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: revision,
    kind: 'occurrence.confirm', payload: { occurrenceKey: key, amount: key === occurrenceKey ? 80 : 150, confirmedDate: date, fxRate: null } });
  const submit = async op => {
    const result = await api.submit({ protocolVersion: 1, instanceId, accountId: 'synthetic-owner', budgetId, compatibility, operation: op });
    revision = result.receipt.revision;
    return result.receipt.confirmedTransaction;
  };
  // Browser route stages separately; the shared service consumes the same row.
  const browserMove = async () => transaction(store, writer => services(hostPlanningStore(writer))
    .moveFutureTransactionToPending(budgetId, reserve.id, { occurrenceKey }));
  const browserConfirm = async (id, amount) => transaction(store, writer => services(hostPlanningStore(writer))
    .confirmPendingTransaction(budgetId, id, { amount, confirmed_date: date }, { actorId: 'synthetic-owner' }));
  const refused = operation(occurrenceKey);
  let pendingId;
  if (path === 'browser') {
    await browserMove();
    pendingId = (await store.listPlanningRows(budgetId, 'pending_transactions')).find(row => row.occurrence_key === occurrenceKey).id;
  }
  await assert.rejects(path === 'device' ? submit(refused) : browserConfirm(pendingId, 80),
    error => error.code === 'LEDGER_BALANCE_NEGATIVE' && /ledger balance negative/.test(error.message));
  assert.equal((await store.listConfirmedTransactions(budgetId)).length, 0);
  assert.equal(await api.lookup({ budgetId, epoch, operationId: refused.operationId }), null);
  if (path === 'device') {
    assert.deepEqual(await store.listPlanningRows(budgetId, 'future_transactions'), future);
    assert.equal((await store.listPlanningRows(budgetId, 'pending_transactions')).length, 1);
    await submit(operation('first_run_opening_balance:opening-pending'));
  } else {
    await browserConfirm('opening-pending', 150);
  }
  const fact = path === 'device' ? await submit(operation(occurrenceKey)) : await browserConfirm(pendingId, 80);
  assert.deepEqual([fact.occurrence_key, fact.amount, fact.date, fact.confirmed_date, fact.ledger_amount],
    [occurrenceKey, 80, date, date, 80]);
  const ledger = await store.listConfirmedTransactions(budgetId);
  assert.equal(ledger.at(-1).running_balance_pln, 70);
  assert.equal((await store.listPlanningRows(budgetId, 'future_transactions'))
    .find(row => row.occurrence_key === 'reserve_transfer:2026-05:2026-06:in').amount, 80);
}

for (const path of ['device', 'browser']) {
  test(`SQLite ${path} early partial reserve requires confirmed opening income`, async () => {
    const harness = await createCashflowTestHarness({ userId: budgetId, today: '2026-05-20' });
    const dbService = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
    const store = createSqliteBudgetStore(dbService), epoch = randomUUID();
    try {
      const db = dbService.openPlanningDb(budgetId);
      try { db.prepare('UPDATE settings SET future_periods = 2').run(); db.exec(FINANCIAL_JOURNAL_SCHEMA);
        db.prepare('INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 0)').run(budgetId, epoch); }
      finally { db.close(); }
      await exercisePendingOpening(store, epoch, path);
      assert.deepEqual(harness.errors, []);
    } finally { await harness.cleanup(); }
  });
  test(`PostgreSQL ${path} early partial reserve requires confirmed opening income`, {
    skip: !postgresRuntimeTestsEnabled()
  }, () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await pool.query(createPostgresGlobalSchemaSql());
    await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Reserve fixture',now(),now())", [budgetId]);
    const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 }), epoch = randomUUID();
    const previousToday = setTodayOverrideForTests('2026-05-20');
    try {
      await store.initialize();
      await store.insertPlanningRows(budgetId, 'settings', [{ id: 1, ledger_currency: 'PLN', future_periods: 2, updated_at: '2026-05-20T12:00:00.000Z' }]);
      await pool.query(FINANCIAL_JOURNAL_SCHEMA);
      await pool.query('INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ($1,$2,0)', [budgetId, epoch]);
      await exercisePendingOpening(store, epoch, path);
    } finally { setTodayOverrideForTests(previousToday); await store.close(); }
  }));
}
