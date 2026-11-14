import { decodeLedgerAuditRecords } from '../../src/engine/ledger-audit-transport.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import path from 'node:path';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createLedgerCorrectionService } from '../../src/server/cashflow-ledger-correction-service.js';
import { createNodeLedgerAuditReplay } from '../../src/server/cashflow-ledger-audit-store.js';
import { createFinancialOperationService } from '../../src/server/cashflow-financial-operation-service.js';
import { appSyncCapabilities } from '../../src/server/cashflow-app-sync-contract.js';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const budgetId = 'server-origin-audit', stamp = '2026-06-02T12:00:00.000Z';
const upgraded = { allowStandaloneOrigins: true };

/** Real HTTP/module callbacks run only against an owned synthetic runtime.
 * No environment or request field can opt a normal server into origins. */
async function exercise(databaseConfig, databaseUrl = null, allowStandaloneOrigins = true) {
  const harness = await createCashflowTestHarness({ initializeUser: false, userId: budgetId,
    today: '2026-06-02', databaseConfig, allowStandaloneOrigins });
  let store;
  try {
    await harness.api('/api/users', { method: 'POST', skipUserHeader: true,
      body: { userId: budgetId, displayName: 'Synthetic origin owner', email: 'origin-runtime@example.test' } });
    const api = (route, options = {}) => harness.api(route, { ...options, useSession: true });
    const request = (route, options = {}) => harness.request(route, { ...options, useSession: true });
    const sqlite = databaseUrl ? null : createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
    store = databaseUrl ? await createPostgresBudgetStore({ databaseUrl, ...upgraded }) : createSqliteBudgetStore({ ...sqlite, ...upgraded });
    await store.insertPlanningRows(budgetId, 'one_off_transactions', [{ id: 'source', name: 'Transferred payment', amount: 400,
      currency: 'PLN', type: 'expense', date: '2026-06-02', created_at: stamp, updated_at: stamp }]);
    const audit = standaloneOriginAuditFixture().audit;
    const replay = createNodeLedgerAuditReplay(upgraded).replayLedgerAuditSnapshot(audit, budgetId);
    const transaction = async work => {
      const own = store.backend === 'postgres' ? fn => store.transaction(fn) : fn => store.planningTransaction(budgetId, fn);
      return own(async (writer, connection) => {
        if (store.backend === 'postgres') await writer.lockBudgetLedger(budgetId);
        const query = async (sql, values = []) => {
          if (store.backend === 'postgres') { let n = 0; return (await connection.query(sql.replace(/\?/g, () => `$${++n}`), values)).rows; }
          const statement = connection.prepare(sql);
          return statement.reader ? statement.all(...values) : (statement.run(...values), []);
        };
        return work(writer, createLedgerCorrectionService({ budgetId, writer, query, ...upgraded }));
      });
    };
    await transaction(async (writer, service) => {
      await writer.insertConfirmedTransactions(budgetId, replay.rows.map(row => ({ ...row, running_balance_pln: 100 })));
      await service.audit.restoreSnapshot(audit);
    });
    if (!allowStandaloneOrigins) {
      assert.equal((await request('/api/export/full')).response.status, 400);
      assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), audit);
      return;
    }
    const exported = await api('/api/export/full');
    assert.deepEqual(exported.ledgerAudit, audit);
    const merged = await request('/api/import/full', { method: 'POST', body: { mode: 'merge', export: exported } });
    assert.equal(merged.response.status, 400);
    const imported = await api('/api/import/full', { method: 'POST', body: { mode: 'replace', export: exported } });
    assert.equal(imported.import.ok, true);
    assert.deepEqual((await api('/api/export/full')).ledgerAudit, audit);
    assert.equal((await store.listConfirmedTransactions(budgetId))[0].running_balance_pln, 100);
    const backup = await api('/api/backup', { method: 'POST', body: {} });
    const metadata = (await store.listPlanningRows(budgetId, 'backup_metadata')).find(row => row.backup_path === backup.path);
    assert.ok(metadata?.success);
    await transaction((_writer, service) => service.correct({ id: 'later-review', targetId: 'confirmed-original',
      expectedCorrectionId: null, replacement: { amount: 450, date: '2026-06-02' }, reason: 'Synthetic later review',
      actorId: 'synthetic-owner', today: '2026-06-02', createdAt: stamp }));
    assert.equal((await store.listConfirmedTransactions(budgetId))[0].running_balance_pln, 50);
    if (sqlite) {
      const later = await store.exportLedgerAuditSnapshot(budgetId);
      // An ignored proof write must roll back the owning transaction without
      // applying a safety snapshot. The predicate targets the older sequence.
      const db = sqlite.openPlanningDb(budgetId);
      try { db.exec(`CREATE TRIGGER ignore_restored_origin BEFORE INSERT ON cashflow_ledger_origins
        WHEN (SELECT last_sequence FROM cashflow_ledger_audit_state WHERE budget_id = NEW.budget_id) = 1
        BEGIN SELECT RAISE(IGNORE); END`); }
      finally { db.close(); }
      try {
        assert.equal((await request(`/api/restore/${metadata.id}`, { method: 'POST', body: {} })).response.status, 400);
        assert.ok(harness.events.some(entry => entry.kind === 'cashflow_restore_rolled_back' && entry.details.recovery === 'transaction'));
        assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), later);
        assert.equal((await store.listConfirmedTransactions(budgetId))[0].running_balance_pln, 50);
      } finally {
        const connection = sqlite.openPlanningDb(budgetId);
        try { connection.exec('DROP TRIGGER ignore_restored_origin'); } finally { connection.close(); }
      }
      const backupDb = new Database(path.join(backup.path, 'planning.sqlite'));
      const proof = backupDb.prepare('SELECT * FROM cashflow_ledger_origins WHERE budget_id = ?').get(budgetId);
      try {
        backupDb.prepare("UPDATE cashflow_ledger_origins SET record_hash = 'invalid' WHERE budget_id = ?").run(budgetId);
        assert.equal((await request(`/api/restore/${metadata.id}`, { method: 'POST', body: {} })).response.status, 400);
        assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), later);
      } finally {
        backupDb.prepare('UPDATE cashflow_ledger_origins SET record_hash = ? WHERE budget_id = ?').run(proof.record_hash, budgetId);
        backupDb.close();
      }
    }
    await api(`/api/restore/${metadata.id}`, { method: 'POST', body: {} });
    assert.deepEqual((await api('/api/export/full')).ledgerAudit, audit);
    assert.equal((await store.listConfirmedTransactions(budgetId))[0].running_balance_pln, 100);
    // State v3 pages losslessly carry the origin; a legacy state-v2 client
    // receives compatibility refusal rather than silently losing evidence.
    const scope = { protocolVersion: 1, instanceId: '11111111-1111-4111-8111-111111111111', accountId: budgetId, budgetId };
    const host = createFinancialOperationService({ budgetStore: store, authorize: async () => scope, project: async () => {} });
    const { protocolVersion, financialModelVersion, stateVersion, engineProtocolVersion, engineVersion } = appSyncCapabilities();
    const manifest = await host.bootstrap({ ...scope,
      compatibility: { protocolVersion, financialModelVersion, stateVersion, engineProtocolVersion, engineVersion } });
    const records = [];
    let token = manifest.firstPageToken;
    while (token !== null) {
      const page = await host.bootstrapPage({ ...scope, bootstrapId: manifest.bootstrapId, pageToken: token, limit: 1 });
      if (page.part === 'ledger-audit') records.push(...page.records);
      token = page.nextPageToken;
    }
    assert.deepEqual(decodeLedgerAuditRecords(records, budgetId, upgraded), audit);
    await assert.rejects(host.negotiate({ ...scope, offer: { protocolVersions: [1], stateVersions: [2],
      financialModelVersions: [1], engineProtocolVersions: [1], engineVersions: [engineVersion] } }),
    error => error.code === 'COMPATIBILITY_REQUIRED');
    assert.ok(!harness.errors.some(entry => /projection_failed|rollback_failed/.test(entry.kind)));
  } finally { await store?.close(); await harness.cleanup(); }
}

test('opted-in SQLite module preserves origins through real financial import, projection and backup routes', () => exercise());
test('explicit legacy runtime refuses origin financial export without changing retained evidence', () => exercise(undefined, null, false));
test('opted-in PostgreSQL module preserves origins through real import and durable backup restore', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try { await global.initialize(); await budget.initialize(); }
  finally { await global.close(); await budget.close(); }
  await exercise({ backend: 'postgres', supported: true, external: true, databaseUrlConfigured: true }, databaseUrl);
}));
