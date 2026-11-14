import assert from 'node:assert/strict';
import test from 'node:test';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createCashflowDataPortabilityService } from '../../src/server/cashflow-data-portability-service.js';
import { createLedgerCorrectionService } from '../../src/server/cashflow-ledger-correction-service.js';
import { createNodeLedgerAuditReplay } from '../../src/server/cashflow-ledger-audit-store.js';
import { createPostgresGlobalSchemaSql } from '../../src/server/cashflow-postgres-global-schema.js';
import { readSqliteFinancialExportAudit } from '../../src/server/cashflow-ledger-audit-export.js';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { correctLocalConfirmation } from '../../src/engine/local-confirmation.js';
import { standaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const budgetId = 'server-origin-audit', copyId = 'origin-json-copy', stamp = '2026-06-02T12:00:00.000Z';
const upgraded = { allowStandaloneOrigins: true };
const codec = createNodeLedgerAuditReplay(upgraded);

/** Operate on the actual budget writer/connection. This tests JSON primitives,
 * not the not-yet-upgraded projection callbacks or Android import journey. */
function transaction(store, scope, work) {
  const own = store.backend === 'postgres' ? fn => store.transaction(fn) : fn => store.planningTransaction(scope, fn);
  return own(async (writer, connection) => {
    if (store.backend === 'postgres') await writer.lockBudgetLedger(scope);
    const query = async (sql, values = []) => {
      if (store.backend === 'postgres') { let index = 0; return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), values)).rows; }
      const statement = connection.prepare(sql);
      return statement.reader ? statement.all(...values) : (statement.run(...values), []);
    };
    return work(createLedgerCorrectionService({ budgetId: scope, writer, query, ...upgraded }));
  });
}

/** A genuine local void arrives as history, not as an invented new server
 * event. Copies must retain its head so a later explicit restoration works. */
async function exercise(store, sqlite = null) {
  const { snapshot } = standaloneOriginAuditFixture();
  const voided = correctLocalConfirmation({ snapshot, today: '2026-06-02', generationTimestamp: stamp,
    confirmationId: 'confirmed-original', expectedCorrectionId: null, replacement: null,
    reason: 'Retained local reversal', idSeed: 'local-void' });
  const audit = { version: 2, budgetId, baselineComplete: true, lastSequence: 2,
    origin: standaloneLedgerOrigin(voided, stamp), originals: [], corrections: [] };
  await store.insertPlanningRows(budgetId, 'one_off_transactions', [{ id: 'source', name: 'Source payment', amount: 400,
    currency: 'PLN', type: 'expense', date: '2026-06-02', created_at: stamp, updated_at: stamp }]);
  await transaction(store, budgetId, service => service.audit.restoreSnapshot(audit));
  const service = createCashflowDataPortabilityService({ budgetStore: store, ...upgraded,
    ...(sqlite ? { openPlanningDb: sqlite.openPlanningDb, openLedgerDb: sqlite.openLedgerDb, listLedgerYears: sqlite.listLedgerYears } : {}) });
  const legacy = createCashflowDataPortabilityService({ budgetStore: store });
  const exported = await service.exportFullDataAsync(budgetId, 'synthetic-origin');
  assert.equal(exported.version, 2);
  assert.deepEqual(exported.ledgerAudit, audit);
  assert.deepEqual(Object.values(exported.ledgers).flat(), []);
  await assert.rejects(legacy.exportFullDataAsync(budgetId), /upgraded host/);
  await assert.rejects(legacy.previewFullImportAsync(copyId, { ...exported, allowStandaloneOrigins: true }), /upgraded host/);
  if (sqlite) {
    assert.deepEqual(service.exportFullData(budgetId).ledgerAudit, audit);
    const db = sqlite.openPlanningDb(budgetId);
    try { assert.deepEqual(readSqliteFinancialExportAudit(db, budgetId, upgraded), audit); }
    finally { db.close(); }
  }
  await assert.rejects(service.prepareFullImportPlanAsync(copyId, exported, 'merge'), /cannot be merged/);
  const prepared = await service.prepareFullImportPlanAsync(copyId, exported, 'replace');
  await service.applyPreparedFullImportPlanAsync(prepared);
  const copied = await store.exportLedgerAuditSnapshot(copyId);
  assert.deepEqual(copied.origin, audit.origin);
  assert.equal(copied.budgetId, copyId);
  const initial = codec.replayLedgerAuditSnapshot(copied, copyId);
  assert.equal(initial.heads.get('confirmed-original'), 'correction-local-void');
  assert.equal(initial.originals.get('confirmed-original').actorId, null);
  assert.equal(initial.originals.get('confirmed-original').row.budget_id, copyId);
  const restored = await transaction(store, copyId, current => current.correct({ id: 'restore-copied', targetId: 'confirmed-original',
    expectedCorrectionId: 'correction-local-void', replacement: { amount: 400, date: '2026-06-02' }, reason: 'Explicit copy restoration',
    today: '2026-06-02', createdAt: '2026-06-02T12:01:00.000Z', actorId: 'synthetic-current-reviewer' }));
  assert.equal(restored.event.status, 'accepted');
  assert.equal((await store.listConfirmedTransactions(copyId))[0].running_balance_pln, 100);
  const later = await service.exportFullDataAsync(copyId);
  assert.deepEqual(later.ledgerAudit.origin, audit.origin);
  assert.equal(later.ledgerAudit.corrections.length, 1);
  assert.equal(later.ledgerAudit.corrections[0].actorId, 'synthetic-current-reviewer');
  const safety = await service.createBudgetSafetySnapshotAsync(copyId);
  await service.applyPreparedFullImportPlanAsync(await service.prepareFullImportPlanAsync(copyId, exported, 'replace'));
  assert.equal((await store.listConfirmedTransactions(copyId)).length, 0);
  await service.restoreBudgetSafetySnapshotAsync(safety);
  assert.deepEqual(await store.exportLedgerAuditSnapshot(copyId), later.ledgerAudit);
  const plain = structuredClone(exported); plain.version = 1; delete plain.ledgerAudit; delete plain.checksum;
  await assert.rejects(service.prepareFullImportPlanAsync(copyId, plain, 'merge'), /cannot receive merged/);
  assert.deepEqual(await store.exportLedgerAuditSnapshot(copyId), later.ledgerAudit);
  const changed = structuredClone(exported); changed.ledgerAudit.origin.events[0].row.amount = 1;
  await assert.rejects(service.prepareFullImportPlanAsync(copyId, changed, 'replace'), /checksum/);
  delete changed.checksum;
  await assert.rejects(service.prepareFullImportPlanAsync(copyId, changed, 'replace'));
  assert.deepEqual(await store.exportLedgerAuditSnapshot(copyId), later.ledgerAudit);
}

test('SQLite financial JSON primitives retain origin heads, refuse merges and support independent restoration', async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId });
  try {
    const db = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
    const target = db.openPlanningDb(copyId); target.close();
    await exercise(createSqliteBudgetStore({ ...db, ...upgraded }), db);
  } finally { await harness.cleanup(); }
});

test('PostgreSQL financial JSON primitives retain origin scope and later corrections through explicit replacement', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  for (const id of [budgetId, copyId]) await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Synthetic JSON',now(),now())", [id]);
  const store = await createPostgresBudgetStore({ databaseUrl, ...upgraded });
  try {
    await store.initialize();
    for (const id of [budgetId, copyId]) await store.insertPlanningRows(id, 'settings', [{ id: 1, updated_at: stamp }]);
    await exercise(store);
  } finally { await store.close(); }
}));
