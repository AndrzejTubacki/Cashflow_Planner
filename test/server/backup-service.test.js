import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { createCashflowBackupService } from '../../src/server/cashflow-backup-service.js';
import { createCashflowLedgerService } from '../../src/server/cashflow-ledger-service.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const gated = { skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests' };

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
      let hook = () => {};
      const service = createCashflowBackupService({
        budgetStore: store,
        generateId: prefix => `${prefix}_${crypto.randomUUID()}`,
        getSettingsAsync: async id => (await store.listPlanningRows(id, 'settings'))[0],
        backupRootDir: () => { throw new Error('Postgres backup must not use local files'); },
        backupHook: details => hook(details),
        recalculateLedgerRunningBalanceAsync: ledger.recalculateLedgerRunningBalanceAsync,
        // Projection execution itself is covered by postgres-runtime.integration;
        // this boundary records scheduling, with failures injected via backupHook.
        regenerateProjectionsAfterMutationAsync: async () => ({ projection_ok: true })
      });
      await fn({ service, store, pool, setHook: value => { hook = value; } });
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
