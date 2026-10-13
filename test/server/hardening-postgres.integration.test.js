import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createCashflowBackupService } from '../../src/server/cashflow-backup-service.js';
import {
  createBudgetStoreSnapshot,
  restoreBudgetStoreSnapshot
} from '../../src/server/cashflow-budget-store-snapshot.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const gated = { skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests' };

test('v1.0.1 migration validates pre-existing table and index shapes', () => {
  const migration = fs.readFileSync(new URL('../../scripts/migrations/postgres-v1.0.1.sql', import.meta.url), 'utf8');

  // CREATE IF NOT EXISTS is safe only when existing objects are checked before commit.
  assert.match(migration, /pg_attribute/);
  assert.match(migration, /pg_constraint/);
  assert.match(migration, /pg_index/);
  assert.match(migration, /cashflow_backup_artifacts has an incompatible schema/);
  assert.match(migration, /cashflow_auth_rate_limits has an incompatible schema/);
  assert.match(migration, /idx_cashflow_auth_rate_limits_reset_at has an incompatible definition/);
  assert.match(migration, /END;\s*\$cashflow_schema_validation\$;/);
});

test('v1.0.1 migration constraint checks exclude contype \'n\' so they pass on every Postgres version', () => {
  const migration = fs.readFileSync(new URL('../../scripts/migrations/postgres-v1.0.1.sql', import.meta.url), 'utf8');

  // pg_constraint rows for a plain NOT NULL column (contype 'n') only exist
  // on Postgres 18 (the feature was tried in 16, reverted, then re-added in
  // 18) - 17 and every earlier version never produce them. Comparing
  // pg_constraint against a fixed expected list that includes 'n' rows
  // therefore only matches on 18 and raises "incompatible schema" on every
  // other version, even against a database this exact migration created.
  // NOT NULL itself is already verified separately via attnotnull, so both
  // constraint queries here must exclude contype 'n' rather than expect them.
  const constraintQueries = [...migration.matchAll(
    /FROM pg_constraint\s+WHERE conrelid = '(\w+)'::regclass([^;]*);/g
  )];
  assert.equal(constraintQueries.length, 2, 'expected exactly two pg_constraint lookups (one per operator-migration table)');
  for (const [, tableName, rest] of constraintQueries) {
    assert.match(
      rest,
      /AND contype != 'n'/,
      `pg_constraint lookup for ${tableName} must exclude contype 'n' to stay version-independent`
    );
  }

  // The expected comparison literals must not claim any 'n' rows either -
  // only the query being right isn't enough if a stale literal still lists them.
  assert.doesNotMatch(migration, /"n", "NOT NULL/);
});

test('v1.0.1 migration rejects a pre-existing table with a diverged schema', gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    const client = await pool.connect();
    try {
      await global.initialize();
      await budget.initialize();
      await client.query('ALTER TABLE cashflow_backup_artifacts ALTER COLUMN payload TYPE VARCHAR(20)');
      const migration = fs.readFileSync(new URL('../../scripts/migrations/postgres-v1.0.1.sql', import.meta.url), 'utf8');
      await assert.rejects(
        client.query(migration),
        /cashflow_backup_artifacts has an incompatible schema/
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await budget.close();
      await global.close();
    }
  });
});

test('Postgres snapshot restore preserves a settings period-income reference and budget id', gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try {
      await global.initialize();
      await budget.initialize();
      await pool.query(`
        INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at)
        VALUES ('restore_period_income', 'restore_period_income', 'Restore period income', now(), now())
      `);
      const timestamp = new Date().toISOString();
      await budget.insertPlanningRows('restore_period_income', 'recurring_incomes', [{
        id: 'salary', name: 'Salary', currency: 'PLN', amount: 5000,
        prediction_strategy: 'fixed', prediction_substitute_missing: 'none',
        prediction_min_recorded_months: 6, active: true, repeat_every_months: 1,
        start_month_year: '2026-01', anchor_type: 'day_of_month',
        anchor_day_of_month: 10, anchor_offset_days: 0,
        anchor_business_day_adjustment: 'none', anchor_holiday_country: 'PL',
        period_setting: true, created_at: timestamp, updated_at: timestamp
      }]);
      await budget.insertPlanningRows('restore_period_income', 'settings', [{
        budget_period_income_id: 'salary', updated_at: timestamp
      }]);

      const snapshot = await createBudgetStoreSnapshot({
        budgetIds: ['restore_period_income'],
        budgetStore: budget,
        reason: 'period-income-regression'
      });
      const restored = await restoreBudgetStoreSnapshot({ budgetStore: budget, snapshot });

      assert.equal(restored.ok, true);
      const [settings] = await budget.listPlanningRows('restore_period_income', 'settings');
      assert.equal(settings.budget_id, 'restore_period_income');
      assert.equal(settings.budget_period_income_id, 'salary');
      assert.equal((await budget.listPlanningRows('restore_period_income', 'recurring_incomes'))[0].id, 'salary');
    } finally {
      await budget.close();
      await global.close();
    }
  });
});

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

test('v1.0.1 migration makes a pre-existing v1.0.0 database\'s non-deferrable FKs deferrable', gated, async () => {
  // v1.0.0 (git 91d6f56) never added DEFERRABLE to the global schema's FKs.
  // Build its exact schema SQL from that commit, rather than guessing at a
  // hand-written approximation, so this test tracks what v1.0.0 actually
  // shipped instead of what someone later assumed it shipped.
  const repoRoot = new URL('../..', import.meta.url);
  const gitShow = relPath => execFileSync('git', ['show', `91d6f56:${relPath}`], { cwd: repoRoot, encoding: 'utf8' });
  const v100SchemaSource = gitShow('src/server/cashflow-postgres-global-schema.js');
  assert.doesNotMatch(v100SchemaSource, /DEFERRABLE/, 'v1.0.0 schema must genuinely have no DEFERRABLE FKs for this test to mean anything');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-v100-schema-'));
  // Pulled from the same commit since the schema module imports from it;
  // it only supplies metadata (version/table-name constants) the DDL itself
  // doesn't depend on, so this doesn't affect what's actually being tested.
  fs.writeFileSync(path.join(tempDir, 'cashflow-global-schema.js'), gitShow('src/server/cashflow-global-schema.js'));
  const tempModulePath = path.join(tempDir, 'schema.mjs');
  fs.writeFileSync(tempModulePath, v100SchemaSource);
  const { createPostgresGlobalSchemaSql: createV100GlobalSchemaSql } = await import(`file://${tempModulePath}`);
  const v100Sql = createV100GlobalSchemaSql({});

  // The migration also touches a budget-schema table (recurring_expenses),
  // so this needs the real v1.0.0 budget schema too, not just the global
  // one - a real Postgres deployment always has both, since one backend
  // connection string is used for both stores (cashflow-storage-backend.js).
  fs.writeFileSync(path.join(tempDir, 'cashflow-constants.js'), gitShow('src/server/cashflow-constants.js'));
  fs.writeFileSync(path.join(tempDir, 'cashflow-schema.js'), gitShow('src/server/cashflow-schema.js'));
  const budgetModulePath = path.join(tempDir, 'budget-schema.mjs');
  fs.writeFileSync(budgetModulePath, gitShow('src/server/cashflow-postgres-budget-schema.js'));
  const { createPostgresBudgetStorageSchemaSql: createV100BudgetSchemaSql } = await import(`file://${budgetModulePath}`);
  const v100BudgetSql = createV100BudgetSchemaSql({});

  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await pool.query(v100Sql);
    await pool.query(v100BudgetSql);
    await pool.query("INSERT INTO accounts (id,display_name,status,created_at,updated_at) VALUES ('acct_1','Test','active',now(),now())");
    await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ('fk_test','fk_test','FK Test',now(),now())");

    const fkConstraintsFor = async tableName => (await pool.query(
      "SELECT conname, condeferrable, condeferred FROM pg_constraint WHERE contype = 'f' AND conrelid = $1::regclass",
      [tableName]
    )).rows;

    const before = await fkConstraintsFor('budget_memberships');
    assert.ok(before.length > 0, 'expected at least one FK on budget_memberships from the v1.0.0 schema');
    assert.ok(before.every(row => row.condeferrable === false), 'v1.0.0 FKs must genuinely start non-deferrable for this test to mean anything');

    // Out-of-order FK insertion fails without deferrable constraints: a
    // membership row referencing a budget inserted later in the same
    // transaction cannot be validated until the reference actually exists.
    await assert.rejects(pool.query(`
      BEGIN;
      INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at)
        VALUES ('fk_test_2', 'acct_1', 'owner', now(), now());
      INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at)
        VALUES ('fk_test_2', 'fk_test_2', 'FK Test 2', now(), now());
      COMMIT;
    `), error => error.code === '23503', 'expected a foreign key violation before the migration');
    await pool.query('ROLLBACK').catch(() => {});

    const migration = fs.readFileSync(new URL('../../scripts/migrations/postgres-v1.0.1.sql', import.meta.url), 'utf8');
    await pool.query(migration);
    await pool.query(migration); // idempotency: must not error or fail validation the second time

    const after = await fkConstraintsFor('budget_memberships');
    assert.deepEqual(after.map(row => row.conname).sort(), before.map(row => row.conname).sort(),
      'the migration must alter the existing constraints in place, not drop/recreate them under new names');
    assert.ok(after.every(row => row.condeferrable === true && row.condeferred === false),
      'expected every FK to now be DEFERRABLE INITIALLY IMMEDIATE');

    // The same out-of-order insert that failed before the migration must
    // now succeed inside a single transaction with SET CONSTRAINTS
    // DEFERRED, since that's the whole point of replaceRows relying on it.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(`
        INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at)
          VALUES ('fk_test_3', 'acct_1', 'owner', now(), now())
      `);
      await client.query(`
        INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at)
          VALUES ('fk_test_3', 'fk_test_3', 'FK Test 3', now(), now())
      `);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const membership = await pool.query("SELECT 1 FROM budget_memberships WHERE budget_id = 'fk_test_3'");
    assert.equal(membership.rowCount, 1, 'expected the out-of-order insert to have succeeded and committed after the migration');
  });
});

test('v1.0.1 migration replaces the historical period-income SET NULL action once', gated, async () => {
  const repoRoot = new URL('../..', import.meta.url);
  const gitShow = relPath => execFileSync('git', ['show', `91d6f56:${relPath}`], { cwd: repoRoot, encoding: 'utf8' });
  const v100BudgetSchemaSource = gitShow('src/server/cashflow-postgres-budget-schema.js');
  assert.match(
    v100BudgetSchemaSource,
    /settings_budget_period_income_fk[\s\S]*REFERENCES recurring_incomes\(budget_id, id\) ON DELETE SET NULL/,
    'v1.0.0 must genuinely contain the broken composite SET NULL action'
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-v100-period-income-schema-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'cashflow-global-schema.js'), gitShow('src/server/cashflow-global-schema.js'));
    fs.writeFileSync(path.join(tempDir, 'cashflow-constants.js'), gitShow('src/server/cashflow-constants.js'));
    fs.writeFileSync(path.join(tempDir, 'cashflow-schema.js'), gitShow('src/server/cashflow-schema.js'));
    fs.writeFileSync(path.join(tempDir, 'global-schema.mjs'), gitShow('src/server/cashflow-postgres-global-schema.js'));
    fs.writeFileSync(path.join(tempDir, 'budget-schema.mjs'), v100BudgetSchemaSource);
    const { createPostgresGlobalSchemaSql: createV100GlobalSchemaSql } = await import(`file://${path.join(tempDir, 'global-schema.mjs')}`);
    const { createPostgresBudgetStorageSchemaSql: createV100BudgetSchemaSql } = await import(`file://${path.join(tempDir, 'budget-schema.mjs')}`);

    await withDisposablePostgresDb(async ({ pool }) => {
      await pool.query(createV100GlobalSchemaSql({}));
      await pool.query(createV100BudgetSchemaSql({}));

      const periodIncomeConstraint = async () => (await pool.query(`
        SELECT oid::text AS oid, conname, confdeltype, condeferrable, condeferred
        FROM pg_constraint
        WHERE conrelid = 'settings'::regclass
          AND conname = 'settings_budget_period_income_fk'
      `)).rows[0];
      const surroundingConstraintOids = async () => (await pool.query(`
        SELECT oid::text AS oid, conrelid::regclass::text AS table_name, conname
        FROM pg_constraint
        WHERE conrelid IN ('settings'::regclass, 'recurring_incomes'::regclass)
          AND conname != 'settings_budget_period_income_fk'
        ORDER BY table_name, conname
      `)).rows;

      const before = await periodIncomeConstraint();
      const untouchedBefore = await surroundingConstraintOids();
      assert.equal(before.confdeltype, 'n', 'historical constraint must start as ON DELETE SET NULL');
      assert.equal(before.condeferrable, true);
      assert.equal(before.condeferred, true);

      const migration = fs.readFileSync(new URL('../../scripts/migrations/postgres-v1.0.1.sql', import.meta.url), 'utf8');
      await pool.query(migration);
      const afterFirstRun = await periodIncomeConstraint();
      assert.equal(afterFirstRun.conname, before.conname);
      assert.equal(afterFirstRun.confdeltype, 'a', 'migration must change the action to NO ACTION');
      assert.equal(afterFirstRun.condeferrable, true);
      assert.equal(afterFirstRun.condeferred, true);
      assert.deepEqual(await surroundingConstraintOids(), untouchedBefore,
        'migration must not recreate surrounding constraints');

      await pool.query(migration);
      assert.deepEqual(await periodIncomeConstraint(), afterFirstRun,
        'the corrected constraint must not be dropped and recreated on a second run');
      assert.deepEqual(await surroundingConstraintOids(), untouchedBefore);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('v1.0.1 migration adds income anchors to the real v1.0.0 budget schema', gated, async () => {
  // Load both schemas exactly as shipped at git 91d6f56. The budget schema
  // references the global budgets table, so testing it in isolation would
  // be a hand-written approximation of an upgrade rather than the real one.
  const repoRoot = new URL('../..', import.meta.url);
  const gitShow = relPath => execFileSync('git', ['show', `91d6f56:${relPath}`], { cwd: repoRoot, encoding: 'utf8' });
  const v100BudgetSchemaSource = gitShow('src/server/cashflow-postgres-budget-schema.js');
  assert.doesNotMatch(v100BudgetSchemaSource, /anchor_income_id/,
    'v1.0.0 budget schema must genuinely predate income-anchored expenses');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-v100-anchor-schema-'));
  let budgetStore;
  try {
    fs.writeFileSync(path.join(tempDir, 'cashflow-global-schema.js'), gitShow('src/server/cashflow-global-schema.js'));
    fs.writeFileSync(path.join(tempDir, 'cashflow-constants.js'), gitShow('src/server/cashflow-constants.js'));
    fs.writeFileSync(path.join(tempDir, 'cashflow-schema.js'), gitShow('src/server/cashflow-schema.js'));
    fs.writeFileSync(path.join(tempDir, 'global-schema.mjs'), gitShow('src/server/cashflow-postgres-global-schema.js'));
    fs.writeFileSync(path.join(tempDir, 'budget-schema.mjs'), v100BudgetSchemaSource);
    const { createPostgresGlobalSchemaSql: createV100GlobalSchemaSql } = await import(`file://${path.join(tempDir, 'global-schema.mjs')}`);
    const { createPostgresBudgetStorageSchemaSql: createV100BudgetSchemaSql } = await import(`file://${path.join(tempDir, 'budget-schema.mjs')}`);

    await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
      await pool.query(createV100GlobalSchemaSql({}));
      await pool.query(createV100BudgetSchemaSql({}));

      const columnShape = async () => (await pool.query(`
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'recurring_expenses'
          AND column_name = 'anchor_income_id'
      `)).rows;
      assert.deepEqual(await columnShape(), [],
        'v1.0.0 schema must genuinely lack anchor_income_id before migration');

      const migration = fs.readFileSync(new URL('../../scripts/migrations/postgres-v1.0.1.sql', import.meta.url), 'utf8');
      await pool.query(migration);
      assert.deepEqual(await columnShape(), [{ data_type: 'text', is_nullable: 'YES' }]);
      await pool.query(migration); // idempotency: the additive column step must remain repeatable

      await pool.query(`
        INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at)
        VALUES ('anchor_upgrade', 'anchor_upgrade', 'Anchor upgrade', now(), now())
      `);
      budgetStore = await createPostgresBudgetStore({ databaseUrl });
      const timestamp = new Date().toISOString();
      await budgetStore.insertPlanningRows('anchor_upgrade', 'planned_transactions', [{
        id: 'planned_expense', type: 'recurring_expense', operating_priority: 1,
        goal_priority: null, created_at: timestamp, updated_at: timestamp
      }]);
      await budgetStore.insertPlanningRows('anchor_upgrade', 'recurring_incomes', [{
        id: 'income_anchor', name: 'Salary', currency: 'PLN', amount: 5000,
        prediction_strategy: 'fixed', prediction_substitute_missing: 'none',
        prediction_min_recorded_months: 6, active: true, repeat_every_months: 1,
        start_month_year: '2026-01', anchor_type: 'day_of_month',
        anchor_day_of_month: 10, anchor_offset_days: 0,
        anchor_business_day_adjustment: 'none', anchor_holiday_country: 'PL',
        period_setting: true, created_at: timestamp, updated_at: timestamp
      }]);
      await budgetStore.insertPlanningRows('anchor_upgrade', 'recurring_expenses', [{
        id: 'expense_anchored', name: 'Rent', currency: 'PLN', amount: 1800,
        prediction_strategy: 'fixed', prediction_substitute_missing: 'none',
        prediction_min_recorded_months: 6, necessary: true, active: true,
        repeat_every_months: 1, start_month_year: '2026-01',
        anchor_type: 'day_of_month', anchor_day_of_month: 1,
        anchor_offset_days: 2, anchor_business_day_adjustment: 'none',
        anchor_holiday_country: 'PL', anchor_income_id: 'income_anchor',
        planned_transaction_id: 'planned_expense', created_at: timestamp, updated_at: timestamp
      }]);

      const inserted = await budgetStore.listPlanningRows('anchor_upgrade', 'recurring_expenses');
      assert.equal(inserted[0].anchor_income_id, 'income_anchor');
      await budgetStore.close();
      budgetStore = null;
    });
  } finally {
    if (budgetStore) await budgetStore.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
