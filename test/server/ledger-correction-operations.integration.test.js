import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINE_VERSION } from '../../src/engine/index.js';
import { randomUUID } from 'node:crypto';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createPostgresGlobalSchemaSql } from '../../src/server/cashflow-postgres-global-schema.js';
import { createFinancialOperationService, createFinancialGrantAuthorizer } from '../../src/server/cashflow-financial-operation-service.js';
import { normalizeAppOperation } from '../../src/server/cashflow-app-operation-contract.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const budgetId = 'correction-operations';
const stamp = '2026-01-01T00:00:00.000Z';
const scope = { protocolVersion: 1, instanceId: '11111111-1111-4111-8111-111111111111', accountId: 'trusted-reviewer', budgetId };
const offer = { protocolVersions: [1], stateVersions: [3], financialModelVersions: [1], engineProtocolVersions: [1], engineVersions: [ENGINE_VERSION] };
const payload = (targetId = 'income', extra = {}) => ({ targetId, expectedCorrectionId: null,
  replacement: { amount: 50, date: '2018-01-01' }, reason: 'Reviewed older payment', retryOf: null, ...extra });

/** Corrections upload a bounded reviewed intent, never actor, effective facts,
 * review time, hashes, source evidence or a precomputed financial plan. */
test('correction operation shape refuses invented authority and preserves reviewed intent', () => {
  const operation = { version: 1, operationId: randomUUID(), budgetId, epoch: randomUUID(), baseRevision: 0, kind: 'ledger.correct', payload: payload() };
  assert.deepEqual(normalizeAppOperation(operation), operation);
  for (const patch of [{ actorId: 'forged' }, { today: '2018-01-01' }, { rows: [] }, { original: {} },
    { expectedCorrectionId: 0 }, { targetId: '' }, { retryOf: '' }, { reason: ' ' }, { reason: 'x'.repeat(501) },
    { replacement: { amount: 0, date: '2018-01-01' } }, { replacement: { amount: 1, date: '2018-02-30' } },
    { replacement: { amount: 1, date: '2018-01-01', ledger_amount: 500 } }]) {
    assert.throws(() => normalizeAppOperation({ ...operation, payload: { ...operation.payload, ...patch } }));
  }
  assert.equal(normalizeAppOperation({ ...operation, payload: payload('income', { replacement: null }) }).payload.replacement, null);
  assert.deepEqual(operation.payload, payload());
});

test('correction authorization uses the ledger confirmation capability on the owning transaction', async () => {
  let capability;
  const authorize = createFinancialGrantAuthorizer({ backend: 'postgres', token: 'synthetic-token', deviceService: {
    authorizeFinancialWrite: async (_transaction, _token, id, required) => { assert.equal(id, budgetId); capability = required; return scope; }
  } });
  await authorize({ budgetId, action: 'write', operation: { kind: 'ledger.correct' }, query: async () => [] });
  assert.equal(capability, 'ledger:confirm');
});

/** Actual journal commits distinguish a durable blocked request from a refused
 * write, retain the same result on replay and roll back a late receipt failure. */
async function exercise(store) {
  await store.insertPlanningRows(budgetId, 'planned_transactions', [{ id: 'goal-plan', type: 'goal', goal_priority: 1, created_at: stamp, updated_at: stamp }]);
  await store.insertPlanningRows(budgetId, 'goals', [{ id: 'old-goal', name: 'Historical goal', amount: 80,
    currency: 'PLN', planned_transaction_id: 'goal-plan', active: 1, due_date: '2018-12-31', created_at: stamp, updated_at: stamp }]);
  for (const [id, amount, type, year, balance] of [['income', 100, 'income', 2018, 100], ['expense', 80, 'expense', 2019, 20]]) {
    const capture = async writer => {
      await writer.prepareLedgerAuditCapture(budgetId, stamp);
      await writer.insertConfirmedTransactions(budgetId, [{ id, name: id, amount, type,
      ...(id === 'expense' ? { source_goal_id: 'old-goal' } : {}), currency: 'PLN', ledger_currency: 'PLN',
      date: `${year}-01-01`, confirmed_date: `${year}-01-01`, ledger_year: year, fx_rate: 1, buffered_fx_rate: 1,
      ledger_amount: amount, running_balance_pln: balance, occurrence_key: `manual:${id}`, created_at: stamp, updated_at: stamp }]);
      await writer.captureLedgerAuditPayment(budgetId, { paymentId: id, actorId: scope.accountId, capturedAt: stamp });
    };
    if (store.backend === 'postgres') await store.transaction(async writer => { await writer.lockBudgetLedger(budgetId); await capture(writer); });
    else await store.planningTransaction(budgetId, capture);
  }
  let allowed = true, fail = false, projects = 0;
  const host = createFinancialOperationService({ budgetStore: store,
    authorize: async () => { if (!allowed) { const error = new Error('revoked'); error.status = 403; throw error; } return scope; },
    project: async () => { projects++; }, afterRecord: async () => { if (fail) throw new Error('Injected late receipt failure'); } });
  const compatibility = (await host.negotiate({ ...scope, offer })).compatibility;
  const manifest = await host.bootstrap({ ...scope, compatibility });
  let revision = manifest.revision;
  const op = values => ({ version: 1, operationId: randomUUID(), budgetId, epoch: manifest.epoch,
    baseRevision: revision, kind: 'ledger.correct', payload: values });
  const submit = async operation => {
    const result = await host.submit({ ...scope, compatibility, operation });
    revision = result.receipt.revision; return result;
  };
  const blocked = op(payload());
  const blockedResult = await submit(blocked);
  assert.equal(blockedResult.receipt.sourceId, null);
  assert.equal(projects, 0, 'blocked intention applies no financial projection');
  let audit = await store.exportLedgerAuditSnapshot(budgetId);
  assert.equal(audit.originals.length, 2); assert.equal(audit.corrections.length, 1);
  assert.equal(audit.corrections[0].status, 'blocked'); assert.deepEqual(audit.corrections[0].blockingIds, ['expense']);
  assert.equal(audit.corrections[0].actorId, scope.accountId);
  assert.equal((await store.listConfirmedTransactions(budgetId)).find(row => row.id === 'income').amount, 100);
  assert.equal((await submit(blocked)).replayed, true);
  assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), audit);
  const resolve = op(payload('expense', { replacement: { amount: 30, date: '2019-01-01' } }));
  await submit(resolve);
  assert.equal((await submit(blocked)).replayed, true, 'old blocked event cannot silently become accepted');
  revision = (await host.changes({ budgetId, epoch: manifest.epoch, afterRevision: 0, limit: 100 })).headRevision;
  const retry = op(payload('income', { retryOf: blocked.operationId }));
  fail = true;
  const beforeFailure = await store.exportLedgerAuditSnapshot(budgetId);
  const ledgerBeforeFailure = await store.listConfirmedTransactions(budgetId);
  await assert.rejects(submit(retry), /Injected late receipt failure/);
  assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), beforeFailure);
  assert.deepEqual(await store.listConfirmedTransactions(budgetId), ledgerBeforeFailure);
  assert.equal(await host.lookup({ budgetId, epoch: manifest.epoch, operationId: retry.operationId }), null);
  fail = false;
  await submit(retry);
  audit = await store.exportLedgerAuditSnapshot(budgetId);
  assert.equal(audit.corrections.at(-1).status, 'accepted');
  assert.equal(audit.corrections.at(-1).retryOf, blocked.operationId);
  const stale = op(payload('income', { replacement: { amount: 60, date: '2018-01-01' } }));
  await assert.rejects(submit(stale), error => error.code === 'OPERATION_REJECTED');
  assert.equal(await host.lookup({ budgetId, epoch: manifest.epoch, operationId: stale.operationId }), null);
  const voidOp = op(payload('expense', { expectedCorrectionId: resolve.operationId, replacement: null }));
  await submit(voidOp);
  assert.equal((await store.listConfirmedTransactions(budgetId)).some(row => row.id === 'expense'), false);
  const restore = op(payload('expense', { expectedCorrectionId: voidOp.operationId, replacement: { amount: 20, date: '2020-01-01' } }));
  await submit(restore);
  assert.equal((await store.listConfirmedTransactions(budgetId)).find(row => row.id === 'expense').ledger_year, store.backend === 'sqlite' ? '2020' : 2020);
  const finalAudit = await store.exportLedgerAuditSnapshot(budgetId);
  assert.ok(finalAudit.corrections.every(event => event.version === 2));
  assert.equal(finalAudit.originals.find(event => event.row.id === 'expense').sourceAtAcceptance.row.due_date, '2018-12-31');
  assert.equal(finalAudit.corrections.at(-1).after.date, '2020-01-01');
  allowed = false;
  await assert.rejects(submit(restore), error => error.status === 403);
  await assert.rejects(host.lookup({ budgetId, epoch: manifest.epoch, operationId: restore.operationId }), error => error.status === 403);
  assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), finalAudit);
}

test('SQLite correction intents atomically retain blocked work, retries, void/restore and receipts', async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId });
  try { await exercise(createSqliteBudgetStore(createCashflowDbService(createCashflowStoragePaths(harness.dataDir)))); }
  finally { await harness.cleanup(); }
});
test('PostgreSQL correction intents obey the same financial and receipt boundaries', { skip: !postgresRuntimeTestsEnabled() },
  () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await pool.query(createPostgresGlobalSchemaSql());
    await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
    const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
    try { await store.initialize(); await store.insertPlanningRows(budgetId, 'settings', [{ id: 1, updated_at: stamp }]); await exercise(store); }
    finally { await store.close(); }
  }));
