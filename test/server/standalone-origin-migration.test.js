import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createSqliteGlobalStore } from '../../src/server/cashflow-sqlite-global-store.js';
import { createPostgresGlobalSchemaSql } from '../../src/server/cashflow-postgres-global-schema.js';
import { createLedgerCorrectionService } from '../../src/server/cashflow-ledger-correction-service.js';
import { createNodeLedgerAuditReplay } from '../../src/server/cashflow-ledger-audit-store.js';
import { createCashflowStorageSnapshot, normalizeCashflowStorageSnapshot, restoreCashflowStorageSnapshot } from '../../src/server/cashflow-storage-snapshot.js';
import { importSqliteBudgetStorageToPostgres } from '../../src/server/cashflow-postgres-budget-import.js';
import { importPostgresStorageToSqlite } from '../../scripts/import-postgres-storage-to-sqlite.mjs';
import { createSqliteMigrationSnapshot } from '../../scripts/create-sqlite-migration-snapshot.mjs';
import { createSqliteBudgetStorageExport } from '../../scripts/export-sqlite-budget-storage.mjs';
import { importBudgetStorageCli } from '../../scripts/import-budget-storage-to-postgres.mjs';
import { migrateSqliteToPostgres } from '../../scripts/migrate-sqlite-to-postgres.mjs';
import { verifyPostgresMigration } from '../../scripts/verify-postgres-migration.mjs';
import { verifySqliteMigration } from '../../scripts/verify-sqlite-migration.mjs';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const budgetId = 'server-origin-audit', stamp = '2026-06-02T12:00:00.000Z';
const upgraded = { allowStandaloneOrigins: true };
const codec = createNodeLedgerAuditReplay(upgraded);

/** Exercise installed command defaults, not a programmatic opt-in. All file
 * arguments are owned synthetic fixtures; PG URLs come only from the guarded
 * disposable helper and are never printed in command arguments or summaries. */
async function cli(name, args, databaseUrl = null) {
  const { stdout } = await promisify(execFile)(process.execPath, [`scripts/${name}.mjs`, ...args], {
    cwd: new URL('../..', import.meta.url), timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, ...(databaseUrl ? { CASHFLOW_DATABASE_URL: databaseUrl } : {}) }
  });
  return JSON.parse(stdout);
}


/** All source files and metadata are created here under one owned temporary
 * directory. No harness server, browser, real account or environment URL is used. */
async function withSource(work) {
  const root = await mkdtemp(path.join(tmpdir(), 'cashflow-origin-migration-'));
  const dataDir = path.join(root, 'source');
  const paths = createCashflowStoragePaths(dataDir);
  const db = createCashflowDbService(paths);
  const store = createSqliteBudgetStore({ ...db, ...upgraded });
  const global = createSqliteGlobalStore({ dataDir, listCashflowUserIds: () => [] });
  try {
    global.initialize();
    await global.insertRows('accounts', [{ id: 'origin-owner', display_name: 'Synthetic migration owner', status: 'active', created_at: stamp, updated_at: stamp }]);
    await global.insertRows('budgets', [{ id: budgetId, storage_key: budgetId, display_name: 'Origin migration', status: 'active',
      created_by_account_id: 'origin-owner', created_at: stamp, updated_at: stamp }]);
    await global.insertRows('budget_memberships', [{ budget_id: budgetId, account_id: 'origin-owner', role: 'owner', created_at: stamp, updated_at: stamp }]);
    db.openPlanningDb(budgetId).close();
    const audit = standaloneOriginAuditFixture().audit;
    const replay = codec.replayLedgerAuditSnapshot(audit, budgetId);
    await store.insertPlanningRows(budgetId, 'one_off_transactions', [{ id: 'source', name: 'Source payment', amount: 400,
      currency: 'PLN', type: 'expense', date: '2026-06-02', created_at: stamp, updated_at: stamp }]);
    await store.planningTransaction(budgetId, async (writer, connection) => {
      const query = async (sql, values = []) => {
        const statement = connection.prepare(sql);
        return statement.reader ? statement.all(...values) : (statement.run(...values), []);
      };
      const service = createLedgerCorrectionService({ budgetId, writer, query, ...upgraded });
      await writer.insertConfirmedTransactions(budgetId, replay.rows.map(row => ({ ...row, running_balance_pln: 100 })));
      await service.audit.restoreSnapshot(audit);
      for (const [id, amount, retryOf] of [['blocked', 600, null], ['retry', 450, 'blocked']]) {
        const result = await service.correct({ id, targetId: 'confirmed-original', expectedCorrectionId: null,
          replacement: { amount, date: '2026-06-02' }, reason: 'Reviewed synthetic migration', actorId: 'synthetic-reviewer',
          today: '2026-06-02', createdAt: '2026-06-02T12:01:00.000Z', retryOf });
        assert.equal(result.event.status, id === 'blocked' ? 'blocked' : 'accepted');
      }
    });
    const snapshot = await createCashflowStorageSnapshot({ budgetIds: [budgetId], budgetStore: store, globalStore: global,
      now: new Date(stamp), ...upgraded });
    const input = path.join(root, 'source.json'); fs.writeFileSync(input, JSON.stringify(snapshot));
    return await work({ root, dataDir, db, store, global, snapshot, input });
  } finally { await store.close(); await global.close?.(); await rm(root, { recursive: true, force: true }); }
}

test('origin storage migration previews retain proof and refuse old hosts before global/file changes', () => withSource(async f => {
  assert.equal(normalizeCashflowStorageSnapshot(f.snapshot, upgraded).budget.ledgerAudits[0].origin.openingBalance, 500);
  assert.throws(() => normalizeCashflowStorageSnapshot({ ...f.snapshot, allowStandaloneOrigins: true }), /upgraded host/);
  let writes = 0;
  await assert.rejects(importSqliteBudgetStorageToPostgres({ dryRun: false, payload: f.snapshot.budget,
    client: { query() { writes++; throw new Error('Unexpected database write'); } } }), /upgraded host/);
  assert.equal(writes, 0);
  const preview = await importSqliteBudgetStorageToPostgres({ payload: f.snapshot.budget, ...upgraded });
  assert.equal(preview.dryRun, true);
  await assert.rejects(restoreCashflowStorageSnapshot({ snapshot: f.snapshot, ...upgraded,
    budgetStore: createSqliteBudgetStore(f.db), globalStore: { replaceAllRows() { writes++; } } }), /upgraded storage host/);
  assert.equal(writes, 0);
  const destination = path.join(f.root, 'not-published');
  await assert.rejects(importPostgresStorageToSqlite({ input: f.input, dataDir: destination, apply: true }), /upgraded host/);
  assert.equal(fs.existsSync(destination), false);
  const dry = await importPostgresStorageToSqlite({ input: f.input, dataDir: destination, ...upgraded });
  assert.equal(dry.apply, false);
  assert.equal(fs.existsSync(destination), false);
  const exports = path.join(f.root, 'budget-exports');
  await assert.rejects(createSqliteBudgetStorageExport({ dataDir: f.dataDir, outputDir: exports }), /upgraded export host/);
  assert.deepEqual(fs.readdirSync(exports), []);
  const artifact = await createSqliteBudgetStorageExport({ dataDir: f.dataDir, outputDir: exports, ...upgraded });
  await assert.rejects(importBudgetStorageCli({ input: artifact.exportPath, dryRun: true }), /upgraded host/);
  const cliPreview = await importBudgetStorageCli({ input: artifact.exportPath, dryRun: true, ...upgraded });
  assert.equal(cliPreview.budgetCount, 1);
  assert.equal(cliPreview.dryRun, true);
  const cliExport = await cli('export-sqlite-budget-storage', ['--data-dir', f.dataDir, '--output-dir', path.join(f.root, 'cli-export')]);
  const cliPlan = await cli('import-budget-storage-to-postgres', ['--input', cliExport.exportPath]);
  assert.equal(cliPlan.dryRun, true);
  assert.equal(cliPlan.budgetCount, 1);
  const cliReturn = await cli('import-postgres-storage-to-sqlite', ['--input', f.input, '--data-dir', destination]);
  assert.equal(cliReturn.apply, false);
  assert.equal(fs.existsSync(destination), false);
}));

test('origin history survives SQLite to PostgreSQL to staged SQLite without importing device authority', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => withSource(async f => {
  await pool.query(createPostgresGlobalSchemaSql());
  const pg = await createPostgresBudgetStore({ databaseUrl, ...upgraded });
  try {
    await pg.initialize();
    // A stopped fixture snapshot, not the mutable source directory, is supplied
    // to the complete forward orchestrator, including its atomic metadata work.
    const stopped = createSqliteMigrationSnapshot({ dataDir: f.dataDir, outputDir: path.join(f.root, 'stopped') });
    const forwardOptions = { databaseUrl, dataDir: stopped.snapshotPath, outputDir: path.join(f.root, 'forward'),
      dryRun: false, sourceIsSnapshot: true, ...upgraded };
    await pool.query('CREATE RULE ignore_migrated_origin AS ON INSERT TO cashflow_ledger_origins DO INSTEAD NOTHING');
    try { await assert.rejects(migrateSqliteToPostgres(forwardOptions), /origin evidence/); }
    finally { await pool.query('DROP RULE ignore_migrated_origin ON cashflow_ledger_origins'); }
    for (const table of ['accounts', 'budgets', 'budget_memberships', 'confirmed_transactions', 'cashflow_ledger_audit_state', 'cashflow_ledger_origins', 'cashflow_ledger_originals']) {
      assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n), 0, `${table} must roll back`);
    }
    const forward = await cli('migrate-sqlite-to-postgres', ['--data-dir', stopped.snapshotPath,
      '--output-dir', forwardOptions.outputDir, '--source-is-snapshot', '--apply'], databaseUrl);
    assert.equal(forward.applied, true);
    const verification = { databaseUrl, ...forward.artifacts, ...upgraded };
    assert.equal((await verifyPostgresMigration(verification)).ok, true);
    assert.equal((await cli('verify-postgres-migration', ['--global-export', forward.artifacts.globalExportPath,
      '--budget-export', forward.artifacts.budgetExportPath], databaseUrl)).ok, true);
    const pgExport = await cli('export-postgres-storage', ['--output-dir', path.join(f.root, 'cli-pg-export')], databaseUrl);
    assert.deepEqual(JSON.parse(fs.readFileSync(pgExport.exportPath, 'utf8')).budget.ledgerAudits, f.snapshot.budget.ledgerAudits);
    // Equal financial row counts are insufficient: changing only the audit
    // sequence must fail actual target verification and recover after repair.
    await pool.query('UPDATE cashflow_ledger_audit_state SET last_sequence = last_sequence + 1 WHERE budget_id = $1', [budgetId]);
    const damaged = await verifyPostgresMigration(verification);
    assert.equal(damaged.ok, false);
    assert.ok(damaged.mismatches.some(item => item.scope === 'ledger-audit'));
    await pool.query('UPDATE cashflow_ledger_audit_state SET last_sequence = last_sequence - 1 WHERE budget_id = $1', [budgetId]);
    assert.equal((await verifyPostgresMigration(verification)).ok, true);
    const client = await pool.connect();
    try {
      await assert.rejects(importSqliteBudgetStorageToPostgres({ client, dryRun: false, initializeSchema: false,
        payload: f.snapshot.budget, ...upgraded }), /audited destination/);
    } finally { client.release(); }
    const expected = f.snapshot.budget.ledgerAudits[0];
    assert.deepEqual(await pg.exportLedgerAuditSnapshot(budgetId), expected);
    assert.equal((await pg.listConfirmedTransactions(budgetId))[0].running_balance_pln, 50);
    for (const table of ['app_devices', 'app_device_tokens', 'app_device_pairings', 'app_device_instance']) {
      assert.equal(Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n), 0);
    }
    const destination = path.join(f.root, 'restored');
    const restored = await cli('migrate-postgres-to-sqlite', ['--data-dir', destination,
      '--output-dir', path.join(f.root, 'reverse'), '--apply'], databaseUrl);
    assert.equal(restored.ok, true);
    assert.equal(fs.existsSync(path.join(destination, '.import-tmp')), false);
    const artifact = JSON.parse(fs.readFileSync(restored.artifacts.exportPath, 'utf8'));
    assert.deepEqual(artifact.budget.ledgerAudits, [expected]);
    const sqliteVerification = { dataDir: destination, input: restored.artifacts.exportPath, ...upgraded };
    assert.equal(verifySqliteMigration(sqliteVerification).ok, true);
    assert.equal((await cli('verify-sqlite-migration', ['--input', restored.artifacts.exportPath, '--data-dir', destination])).ok, true);
    const returned = createSqliteBudgetStore({ ...createCashflowDbService(createCashflowStoragePaths(destination)), ...upgraded });
    try {
      assert.deepEqual(await returned.exportLedgerAuditSnapshot(budgetId), expected);
      assert.equal((await returned.listConfirmedTransactions(budgetId))[0].running_balance_pln, 50);
      const connection = createCashflowDbService(createCashflowStoragePaths(destination)).openPlanningDb(budgetId);
      try { connection.prepare('DELETE FROM cashflow_ledger_origins WHERE budget_id = ?').run(budgetId); }
      finally { connection.close(); }
      const damagedSqlite = verifySqliteMigration(sqliteVerification);
      assert.equal(damagedSqlite.ok, false);
      assert.ok(damagedSqlite.mismatches.some(item => item.scope === 'ledger-audit'));
    } finally { await returned.close(); }
  } finally { await pg.close(); }
})));
