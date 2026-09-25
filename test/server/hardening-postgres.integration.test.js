import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createCashflowBackupService } from '../../src/server/cashflow-backup-service.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const gated = { skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests' };

// Independent stores and roots model separate replicas sharing only Postgres.
test('shared backup artifacts survive replica loss, repeated backups, restore and failed-apply rollback', gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const a = await createPostgresBudgetStore({ databaseUrl });
    const b = await createPostgresBudgetStore({ databaseUrl });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-backup-replicas-'));
    try {
      await global.initialize();
      await a.initialize();
      for (const id of ['budget_a', 'budget_b']) {
        await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,$1,now(),now())", [id]);
        await pool.query("INSERT INTO settings (budget_id,updated_at) VALUES ($1,now())", [id]);
      }
      // An additive operator migration must be repeatable and preserve existing rows.
      const migration = fs.readFileSync(new URL('../../scripts/migrations/postgres-v1.0.1.sql', import.meta.url), 'utf8');
      await pool.query('DROP TABLE cashflow_backup_artifacts');
      await pool.query(migration);
      await pool.query(migration);
      let failProjection = false;
      const service = (store, rootName) => createCashflowBackupService({
        budgetStore: store,
        backupRootDir: () => path.join(root, rootName),
        generateId: prefix => `${prefix}_${crypto.randomUUID()}`,
        getSettingsAsync: async id => (await store.listPlanningRows(id, 'settings'))[0],
        // The failure injection occurs after real financial snapshot application.
        recalculateLedgerRunningBalanceAsync: async () => {},
        regenerateProjectionsAfterMutationAsync: async () => {
          if (failProjection) { failProjection = false; throw new Error('injected post-apply failure'); }
          return { projection_ok: true };
        }
      });
      const serviceA = service(a, 'a');
      const serviceB = service(b, 'b');
      const ref = await serviceA.createBackupAsync('budget_a');
      const id = ref.slice('postgres-backup:'.length);
      const first = JSON.parse(await b.readBackupArtifact('budget_a', id));
      assert.deepEqual(first.payload.tables.backup_metadata, []);
      const next = await serviceA.createBackupAsync('budget_a');
      const second = JSON.parse(await b.readBackupArtifact('budget_a', next.slice('postgres-backup:'.length)));
      assert.deepEqual(second.payload.tables.backup_metadata, []);
      fs.rmSync(root, { recursive: true, force: true });
      await pool.query("UPDATE settings SET minimum_reserve_amount = 123 WHERE budget_id = 'budget_a'");
      await serviceB.restoreBackupAsync('budget_a', id);
      assert.equal(Number((await b.listPlanningRows('budget_a', 'settings'))[0].minimum_reserve_amount), Number(first.payload.tables.settings[0].minimum_reserve_amount));
      await pool.query("UPDATE settings SET minimum_reserve_amount = 456 WHERE budget_id = 'budget_a'");
      failProjection = true;
      await assert.rejects(serviceB.restoreBackupAsync('budget_a', id), /was rolled back/);
      assert.equal(Number((await b.listPlanningRows('budget_a', 'settings'))[0].minimum_reserve_amount), 456);
      assert.equal((await b.listPlanningRows('budget_a', 'backup_metadata')).length, 4);
      assert.equal(await b.readBackupArtifact('budget_b', id), null);
      await assert.rejects(serviceB.restoreBackupFromPathAsync('budget_b', ref), error => error.status === 404);
      await assert.rejects(serviceB.restoreBackupAsync('budget_b', id), error => error.status === 404);
      // A normal full-data replacement must not orphan shared backup history.
      const { applyBudgetStoreImportPlan, createBudgetStoreImportPlan } = await import('../../src/server/cashflow-budget-store-import-plan.js');
      await applyBudgetStoreImportPlan({
        budgetStore: b, mode: 'replace', preserveBackupMetadata: true,
        plan: createBudgetStoreImportPlan(first.payload, { includeEmptyReplaceBatches: true })
      });
      assert.equal((await b.listPlanningRows('budget_a', 'backup_metadata')).length, 4);
      const legacy = path.join(root, 'legacy.json');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(legacy, JSON.stringify(first));
      await a.insertPlanningRows('budget_a', 'backup_metadata', [{ id: 'legacy', backup_timestamp: new Date().toISOString(), backup_path: legacy, success: true, created_at: new Date().toISOString() }]);
      await serviceB.restoreBackupAsync('budget_a', 'legacy');
      fs.rmSync(legacy);
      await assert.rejects(serviceB.restoreBackupAsync('budget_a', 'legacy'), error => error.status === 404);
      await pool.query("DELETE FROM budgets WHERE id = 'budget_a'");
      assert.equal(await b.readBackupArtifact('budget_a', id), null);
    } finally {
      await b.close(); await a.close(); await global.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// A one-client pool would deadlock if withLock pinned it across the callback.
test('same-database runtime locks borrow the global pool and allow nested queries at saturation', gated, async () => {
  const { createCashflowRuntimeLockService } = await import('../../src/server/cashflow-runtime-lock-service.js');
  await withDisposablePostgresDb(async ({ databaseUrl }) => {
    const global = await createPostgresGlobalStore({ databaseUrl, poolMax: 1 });
    try {
      await global.initialize();
      const runtime = await createCashflowRuntimeLockService({
        env: { CASHFLOW_DB_BACKEND: 'postgres', CASHFLOW_DATABASE_URL: databaseUrl, CASHFLOW_RUNTIME_LOCK_BACKEND: 'postgres' },
        globalStore: global,
        pgModule: { Pool: class { constructor() { throw new Error('duplicate pool'); } } }
      });
      const outcomes = await Promise.all(Array.from({ length: 4 }, (_, i) =>
        runtime.lockService.withLock(`saturation:${i}`, async () => {
          await global.listRows('budgets');
          return 'completed';
        })
      ));
      assert.ok(outcomes.every(result => result.acquired && result.result === 'completed'));
      await runtime.close();
      await global.listRows('budgets'); // Borrower must not close its owner's pool.
    } finally { await global.close(); }
  });
});

test('two HTTP replicas enforce one auth limit and fail closed if the shared table is unavailable', gated, async () => {
  const { default: express } = await import('express');
  const { default: rateLimit } = await import('express-rate-limit');
  const { createInternalAuthLimiter } = await import('../../src/server/cashflow-auth-rate-limit.js');
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const a = await createPostgresGlobalStore({ databaseUrl });
    const b = await createPostgresGlobalStore({ databaseUrl });
    const servers = [];
    const errors = [];
    try {
      await a.initialize();
      for (const globalStore of [a, b]) {
        const app = express();
        app.use('/api/auth/internal', createInternalAuthLimiter({ rateLimit, globalStore, logError: (...args) => errors.push(args) }));
        app.post('/api/auth/internal', (req, res) => res.sendStatus(204));
        const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        servers.push(server);
      }
      const attempt = async index => {
        const response = await fetch(`http://127.0.0.1:${servers[index % 2].address().port}/api/auth/internal`, { method: 'POST' });
        await response.text();
        return response.status;
      };
      const statuses = await Promise.all(Array.from({ length: 26 }, (_, i) => attempt(i)));
      assert.equal(statuses.filter(s => s === 204).length, 20);
      assert.equal(statuses.filter(s => s === 429).length, 6);
      await pool.query("UPDATE cashflow_auth_rate_limits SET reset_at = now() - interval '1 second'");
      assert.equal(await attempt(1), 204);
      await pool.query('DROP TABLE cashflow_auth_rate_limits');
      assert.equal(await attempt(0), 503);
      assert.equal(await attempt(1), 503);
      assert.equal(errors.length, 2);
    } finally {
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
      await a.close(); await b.close();
    }
  });
});

test('SIGTERM drains an active Postgres tick, releases its lease and closes application pools', gated, async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-shutdown-'));
    let child;
    let output = '';
    try {
      await global.initialize(); await budget.initialize();
      // Test-only load hook shortens the timer and holds real locked work at a
      // filesystem barrier. Production source and the disposable DB are real.
      const gate = path.join(root, 'continue');
      const loader = path.join(root, 'hold-tick.mjs');
      fs.writeFileSync(loader, `
        import { registerHooks } from 'node:module';
        registerHooks({ load(url, context, nextLoad) {
          const result = nextLoad(url, context);
          if (url.endsWith('/cashflow-background-jobs.js')) {
            result.source = 'import fs from "node:fs";' + String(result.source)
              .replace('}, 60_000);', '}, 20);')
              .replace('const userIds = typeof listCashflowUserIdsAsync',
                'console.log("TEST_TICK_HELD"); while (!fs.existsSync(' + ${JSON.stringify(JSON.stringify(gate))} + ')) await new Promise(r => setTimeout(r, 20)); const userIds = typeof listCashflowUserIdsAsync');
          }
          if (/cashflow-postgres-(global|budget)-db-service\\.js$/.test(url)) {
            result.source = String(result.source).replace('await pool.end();', 'await pool.end(); console.log("TEST_POOL_CLOSED");');
          }
          return result;
        }});
      `);
      const appName = `cashflow-shutdown-${crypto.randomUUID()}`;
      const url = new URL(databaseUrl);
      url.searchParams.set('application_name', appName);
      child = spawn(process.execPath, ['--import', loader, 'server.mjs'], {
        cwd: path.resolve(import.meta.dirname, '../..'),
        env: { ...process.env, PORT: '0', DATA_DIR: path.join(root, 'data'), LOGS_DIR: path.join(root, 'logs'),
          CASHFLOW_DB_BACKEND: 'postgres', CASHFLOW_DATABASE_URL: url.toString(),
          CASHFLOW_RUNTIME_LOCK_BACKEND: 'postgres', CASHFLOW_RUNTIME_LOCK_DATABASE_URL: '',
          CASHFLOW_MIRROR_LOGS_TO_STDOUT: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      const until = async condition => {
        const deadline = Date.now() + 10_000;
        while (!condition()) {
          assert.equal(child.exitCode, null, output);
          assert.ok(Date.now() < deadline, output);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      await until(() => output.includes('TEST_TICK_HELD'));
      const contender = global.createLockService({ ownerId: 'shutdown-contender' });
      child.kill('SIGTERM');
      await until(() => output.includes('server_shutdown_requested'));
      assert.equal((await contender.tryAcquire('background:tick')).acquired, false);
      assert.equal(child.exitCode, null, 'shutdown must wait for the held callback');
      // Startup and the lease establish a global connection; budget pool is lazy.
      const before = await pool.query('SELECT count(*) FROM pg_stat_activity WHERE application_name = $1', [appName]);
      assert.ok(Number(before.rows[0].count) >= 1);
      const exited = once(child, 'exit');
      fs.writeFileSync(gate, 'continue');
      const [code, signal] = await exited;
      assert.equal(code, 0, output);
      assert.equal(signal, null);
      assert.equal((await contender.tryAcquire('background:tick')).acquired, true);
      await contender.release('background:tick');
      const after = await pool.query('SELECT count(*) FROM pg_stat_activity WHERE application_name = $1', [appName]);
      assert.equal(Number(after.rows[0].count), 0);
      assert.match(output, /server_shutdown_complete/);
      assert.equal((output.match(/TEST_POOL_CLOSED/g) || []).length, 2, output);
      assert.doesNotMatch(output, /server_shutdown_timeout|server_shutdown_failed/);
    } finally {
      if (child && child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
      await budget.close(); await global.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test('concurrent separate lock-store startups initialize only coordination schema', gated, async () => {
  const { createCashflowRuntimeLockService } = await import('../../src/server/cashflow-runtime-lock-service.js');
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const runtimes = [];
    try {
      const results = await Promise.allSettled(['a', 'b'].map(owner => createCashflowRuntimeLockService({
        env: { CASHFLOW_RUNTIME_LOCK_BACKEND: 'postgres', CASHFLOW_RUNTIME_LOCK_DATABASE_URL: databaseUrl, CASHFLOW_RUNTIME_LOCK_OWNER_ID: owner }
      })));
      for (const result of results) if (result.status === 'fulfilled') runtimes.push(result.value);
      assert.ok(results.every(result => result.status === 'fulfilled'), 'simultaneous schema initialization must succeed');
      const tables = await pool.query("SELECT to_regclass('cashflow_runtime_locks') AS locks, to_regclass('accounts') AS accounts");
      assert.ok(tables.rows[0].locks);
      assert.equal(tables.rows[0].accounts, null, 'lock startup must not initialize application tables');
      const outcomes = await Promise.all(runtimes.map(runtime => runtime.lockService.tryAcquire('startup:test')));
      assert.equal(outcomes.filter(result => result.acquired).length, 1);
    } finally { await Promise.all(runtimes.map(runtime => runtime.close())); }
  });
});

test('readiness requires additive operational tables and explicit migration preserves existing rows', gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try {
      await global.initialize(); await budget.initialize();
      await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ('retained','retained','Retained',now(),now())");
      await pool.query('DROP TABLE cashflow_auth_rate_limits, cashflow_backup_artifacts');
      await assert.rejects(global.checkReadiness(), error => error.code === '42P01');
      await assert.rejects(budget.checkReadiness(), error => error.code === '42P01');
      const migration = fs.readFileSync(new URL('../../scripts/migrations/postgres-v1.0.1.sql', import.meta.url), 'utf8');
      await pool.query(migration); await pool.query(migration);
      assert.equal((await global.checkReadiness()).ok, true);
      assert.equal((await budget.checkReadiness()).ok, true);
      assert.equal((await global.listRows('budgets'))[0].id, 'retained');
    } finally { await budget.close(); await global.close(); }
  });
});
