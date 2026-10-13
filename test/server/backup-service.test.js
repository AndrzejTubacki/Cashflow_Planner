import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import express from 'express';
import { createCashflowBackupService } from '../../src/server/cashflow-backup-service.js';
import { createCashflowLedgerService } from '../../src/server/cashflow-ledger-service.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { registerCashflowRoutes } from '../../src/server/cashflow-routes.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const gated = { skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests' };

function artifactStoreFixture({ artifactPayload = null } = {}) {
  const metadata = [];
  const artifacts = new Map();
  const calls = [];
  if (artifactPayload !== null) artifacts.set('existing', artifactPayload);
  const store = {
    backend: 'postgres',
    async insertPlanningRows(_budgetId, tableName, rows) {
      assert.equal(tableName, 'backup_metadata');
      metadata.push(...rows);
    },
    async listConfirmedTransactions() { return []; },
    async listLedgerYears() { return []; },
    async listPlanningRows(_budgetId, tableName) {
      if (tableName === 'backup_metadata') return metadata;
      return [];
    },
    async readBackupArtifact(budgetId, artifactId) {
      calls.push({ artifactId, budgetId, operation: 'read' });
      return artifacts.get(artifactId) ?? null;
    },
    async saveBackupArtifact(budgetId, row, payload) {
      calls.push({ artifactId: row.id, budgetId, operation: 'save' });
      metadata.push(row);
      artifacts.set(row.id, payload);
    },
    async transaction(fn) {
      // The real transaction() hands the callback a writer that can read
      // through the same connection as the lock; this mock has only one
      // connection, so the outer store's own read methods stand in for it.
      return await fn({ ...store, lockBudgetLedger: async () => ({ locked: true }) });
    }
  };
  const service = createCashflowBackupService({
    backupRootDir: () => { throw new Error('Postgres backup must not use local files'); },
    budgetStore: store,
    generateId: () => 'backup_test',
    getSettingsAsync: async () => ({ id: 1 }),
    recalculateLedgerRunningBalanceAsync: async () => {},
    regenerateProjectionsAfterMutationAsync: async () => ({ projection_ok: true })
  });
  return { artifacts, calls, metadata, service };
}

test('Postgres backup saves its snapshot through the shared artifact store without a local path', async () => {
  const { artifacts, calls, metadata, service } = artifactStoreFixture();
  const ref = await service.createBackupAsync('household');

  assert.equal(ref, 'postgres-backup:backup_test');
  assert.deepEqual(calls, [{ artifactId: 'backup_test', budgetId: 'household', operation: 'save' }]);
  assert.equal(metadata[0].backup_path, ref);
  assert.equal(JSON.parse(artifacts.get('backup_test')).format, 'cashflow-budget-store-snapshot');
});

test('Postgres restore validation reads the shared artifact instead of checking a local path', async () => {
  const { calls, metadata, service } = artifactStoreFixture({ artifactPayload: '{bad json' });
  metadata.push({ id: 'existing', backup_path: 'postgres-backup:existing', success: true });

  await assert.rejects(
    () => service.restoreBackupAsync('household', 'existing'),
    error => error.status === 400 && error.details?.phase === 'backup_validation_failed'
  );
  assert.deepEqual(calls, [{ artifactId: 'existing', budgetId: 'household', operation: 'read' }]);
});

// Replace the old in-memory Postgres impersonation with actual SQL-backed
// backups, restore transactions, constraints, and metadata queries.
async function fixture(fn) {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const store = await createPostgresBudgetStore({ databaseUrl });
    try {
      await global.initialize(); await store.initialize();
      await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ('household','household','Test',now(),now())");
      await pool.query("INSERT INTO settings (budget_id, updated_at) VALUES ('household',now())");
      const ledger = createCashflowLedgerService({ budgetStore: store });
      const lockService = global.createLockService({ ownerId: `backup_test_${crypto.randomUUID()}` });
      let hook = () => {};
      const service = createCashflowBackupService({
        budgetStore: store,
        generateId: prefix => `${prefix}_${crypto.randomUUID()}`,
        getSettingsAsync: async id => (await store.listPlanningRows(id, 'settings'))[0],
        backupRootDir: () => { throw new Error('Postgres backup must not use local files'); },
        backupHook: details => hook(details),
        lockService,
        recalculateLedgerRunningBalanceAsync: ledger.recalculateLedgerRunningBalanceAsync,
        // Projection execution itself is covered by postgres-runtime.integration;
        // this boundary records scheduling, with failures injected via backupHook.
        regenerateProjectionsAfterMutationAsync: async () => ({ projection_ok: true })
      });
      await fn({ lockService, service, store, pool, setHook: value => { hook = value; } });
    } finally { await store.close(); await global.close(); }
  });
}

test('Postgres backup commits snapshot bytes with discovery metadata', gated, async () => fixture(async ({ service, store }) => {
  const ref = await service.createBackupAsync('household');
  const rows = await store.listPlanningRows('household', 'backup_metadata');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].backup_path, ref);
  assert.equal(rows[0].success, true);
  const payload = await store.readBackupArtifact('household', rows[0].id);
  assert.equal(Number(rows[0].size_bytes), Buffer.byteLength(payload));
  assert.equal(JSON.parse(payload).format, 'cashflow-budget-store-snapshot');
}));

test('Postgres backup failure publishes neither success metadata nor partial bytes', gated, async () => fixture(async ({ service, store, pool, setHook }) => {
  setHook(({ phase }) => { if (phase === 'before_success_metadata') throw new Error('injected backup failure'); });
  await assert.rejects(service.createBackupAsync('household'), /injected backup failure/);
  const metadata = await store.listPlanningRows('household', 'backup_metadata');
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].success, false);
  assert.equal(Number((await pool.query('SELECT count(*) FROM cashflow_backup_artifacts')).rows[0].count), 0);
}));

test('Postgres restore restores settings and keeps its safety artifact', gated, async () => fixture(async ({ service, store, pool }) => {
  const ref = await service.createBackupAsync('household');
  await pool.query("UPDATE settings SET minimum_reserve_amount = 999 WHERE budget_id = 'household'");
  const result = await service.restoreBackupAsync('household', ref.slice('postgres-backup:'.length));
  assert.equal(result.ok, true);
  assert.equal(Number((await store.listPlanningRows('household', 'settings'))[0].minimum_reserve_amount), 0);
  assert.ok(await store.readBackupArtifact('household', result.safetyBackup.slice('postgres-backup:'.length)));
}));

test('Postgres restore route succeeds on its first uncontended call with runtime locks enabled', gated, async () => fixture(async ({ lockService, service, store, pool }) => {
  const ref = await service.createBackupAsync('household');
  const backupId = ref.slice('postgres-backup:'.length);
  await pool.query("UPDATE settings SET minimum_reserve_amount = 999 WHERE budget_id = 'household'");

  const app = express();
  app.use(express.json());
  registerCashflowRoutes(app, {
    getAdminAuthConfigAsync: async () => null,
    getSettingsAsync: async () => ({ locale: 'en' }),
    getSnapshotAsync: async () => ({}),
    lockService,
    logCashflowError: () => {},
    logError: () => {},
    resolveRequestContext: async () => ({
      budget: { id: 'household' },
      capabilities: ['budget:restore']
    }),
    resolveRequestUser: async () => 'household',
    restoreBackup: () => { throw new Error('Postgres restore route must use restoreBackupAsync'); },
    restoreBackupAsync: service.restoreBackupAsync,
    translateLocale: async (_locale, message) => message
  });

  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/restore/${encodeURIComponent(backupId)}`, {
      method: 'POST',
      headers: { 'x-cashflow-user-id': 'household' }
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.restore?.ok, true);
    assert.equal(Number((await store.listPlanningRows('household', 'settings'))[0].minimum_reserve_amount), 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}));

test('Postgres restore failure rolls back and retains both backup artifacts', gated, async () => fixture(async ({ service, store, pool, setHook }) => {
  const ref = await service.createBackupAsync('household');
  await pool.query("UPDATE settings SET minimum_reserve_amount = 123 WHERE budget_id = 'household'");
  setHook(({ phase }) => { if (phase === 'before_restore_apply') throw new Error('injected restore failure'); });
  await assert.rejects(service.restoreBackupAsync('household', ref.slice('postgres-backup:'.length)), /rolled back/);
  assert.equal(Number((await store.listPlanningRows('household', 'settings'))[0].minimum_reserve_amount), 123);
  assert.equal((await store.listPlanningRows('household', 'backup_metadata')).length, 2);
}));

for (const scenario of ['disabled', 'recent', 'elapsed']) {
  test(`Postgres automatic backup handles ${scenario} interval`, gated, async () => fixture(async ({ service, store, pool }) => {
    await pool.query("UPDATE settings SET auto_backup_enabled = $1, backup_interval_minutes = 60 WHERE budget_id = 'household'", [scenario !== 'disabled']);
    if (scenario !== 'disabled') {
      await service.createBackupAsync('household');
      if (scenario === 'elapsed') await pool.query("UPDATE backup_metadata SET backup_timestamp = now() - interval '2 hours'");
    }
    const result = await service.maybeRunAutomaticBackupAsync('household');
    assert.equal(Boolean(result), scenario === 'elapsed');
    const rows = await store.listPlanningRows('household', 'backup_metadata');
    assert.equal(rows.length, scenario === 'disabled' ? 0 : scenario === 'recent' ? 1 : 2);
  }));
}

test('Postgres backup waits for an in-flight financial transaction before reading its snapshot', gated, async () => fixture(async ({ service, store, pool }) => {
  let entered;
  let release;
  const acquired = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const mutation = store.transaction(async (writer, client) => {
    await writer.lockBudgetLedger('household');
    await client.query("UPDATE settings SET minimum_reserve_amount = 77 WHERE budget_id = 'household'");
    entered();
    await gate;
  });
  await acquired;
  let completed = false;
  const backup = service.createBackupAsync('household').finally(() => { completed = true; });
  // Observe actual server-side lock contention; no guessed scheduling delay.
  let waiting = false;
  try {
    const deadline = Date.now() + 5000;
    while (!completed && Date.now() < deadline) {
      const result = await pool.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
      if (result.rows.length) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true, 'backup must wait on the budget transaction lock');
  } finally {
    release();
    await mutation;
    await backup;
  }
  const ref = await backup;
  const snapshot = JSON.parse(await store.readBackupArtifact('household', ref.slice('postgres-backup:'.length)));
  assert.equal(Number(snapshot.payload.tables.settings[0].minimum_reserve_amount), 77);
}));

// Proves the opposite direction from the test above: once the backup itself
// already holds the ledger lock and is mid-snapshot, a *new* financial
// mutation racing it must stay blocked for the lock's whole lifetime, not
// just an instant at the start. A lock taken and released in its own
// separate transaction before any table is read (the original bug) would
// let this mutation through immediately and land partway through the
// multi-table read, tearing the snapshot between tables that have and
// haven't picked up its change yet.
test('Postgres backup blocks a racing mutation for its whole snapshot read, so the snapshot cannot tear', gated, async () => fixture(async ({ service, store, setHook }) => {
  const stamp = new Date().toISOString();
  await store.insertPlanningRows('household', 'pending_transactions', [{
    id: 'racing_pending', name: 'Racing', currency: 'PLN', amount: 10, type: 'expense',
    date: '2026-01-01', funded_amount: 10, occurrence_key: 'racing_pending',
    created_at: stamp, updated_at: stamp
  }]);

  let signalPaused;
  let releaseBackup;
  const paused = new Promise(resolve => { signalPaused = resolve; });
  const gate = new Promise(resolve => { releaseBackup = resolve; });
  setHook(async details => {
    if (details.phase === 'before_planning_copy') {
      // Fires only once the backup's own transaction already holds
      // lockBudgetLedger (see the production code), so pausing here holds
      // the lock open for as long as the test wants, mid-snapshot.
      signalPaused();
      await gate;
    }
  });

  const backup = service.createBackupAsync('household');
  await paused;

  let mutationFinished = false;
  const mutation = store.transaction(async writer => {
    await writer.lockBudgetLedger('household');
    await writer.insertConfirmedTransactions('household', [{
      id: 'racing_confirmed', name: 'Racing', amount: 10, type: 'expense',
      currency: 'PLN', ledger_currency: 'PLN', ledger_year: 2026,
      date: '2026-01-01', confirmed_date: '2026-01-01', fx_rate: 1, buffered_fx_rate: 1,
      ledger_amount: 10, running_balance_pln: 0, created_at: stamp, updated_at: stamp
    }]);
    await writer.deletePlanningRowsById('household', 'pending_transactions', ['racing_pending']);
  }).then(() => { mutationFinished = true; });

  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(mutationFinished, false, 'a racing mutation must stay blocked while the backup holds the lock mid-read');

  releaseBackup();
  const ref = await backup;
  await mutation;
  assert.equal(mutationFinished, true, 'the mutation must complete once the backup releases the lock');

  const snapshot = JSON.parse(await store.readBackupArtifact('household', ref.slice('postgres-backup:'.length)));
  const pendingIds = snapshot.payload.tables.pending_transactions.map(row => row.id);
  const confirmedIds = (snapshot.payload.tables.confirmed_transactions || []).map(row => row.id);
  // The whole read finished strictly before the mutation could even start,
  // so the snapshot must show neither side of it: the old pending row is
  // still there and the new confirmed row is absent - never a mix.
  assert.equal(pendingIds.includes('racing_pending'), true);
  assert.equal(confirmedIds.includes('racing_confirmed'), false);
}));
