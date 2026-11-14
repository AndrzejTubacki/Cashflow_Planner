import { ENGINE_VERSION } from '../../src/engine/index.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { createCashflowDataPortabilityService } from '../../src/server/cashflow-data-portability-service.js';
import { createPostgresBudgetStore, createSqliteBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createPostgresGlobalSchemaSql } from '../../src/server/cashflow-postgres-global-schema.js';
import { createLedgerCorrectionService } from '../../src/server/cashflow-ledger-correction-service.js';
import { copyLedgerAuditSnapshot } from '../../src/server/cashflow-ledger-audit-store.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createSqliteBudgetStorageExport } from '../../scripts/export-sqlite-budget-storage.mjs';
import { createSqliteMigrationSnapshot } from '../../scripts/create-sqlite-migration-snapshot.mjs';
import { importBudgetStorageCli } from '../../scripts/import-budget-storage-to-postgres.mjs';
import { migrateSqliteToPostgres } from '../../scripts/migrate-sqlite-to-postgres.mjs';
import { migratePostgresToSqlite } from '../../scripts/migrate-postgres-to-sqlite.mjs';
import { verifyPostgresMigration } from '../../scripts/verify-postgres-migration.mjs';
import { verifySqliteMigration } from '../../scripts/verify-sqlite-migration.mjs';
import { importSqliteBudgetStorageToPostgres } from '../../src/server/cashflow-postgres-budget-import.js';
import { createFinancialOperationService } from '../../src/server/cashflow-financial-operation-service.js';

/** State v2 is mandatory so an older client cannot silently ignore audit.
 * Exercise actual transaction-bound, paged bootstrap readers on both stores. */
async function exerciseAuditBootstrap(store, audit) {
  const scope = { protocolVersion: 1, instanceId: '11111111-1111-4111-8111-111111111111', accountId: 'audit-reader', budgetId };
  const host = createFinancialOperationService({ budgetStore: store, authorize: async () => scope, project: async () => {} });
  const offer = { protocolVersions: [1], stateVersions: [3], financialModelVersions: [1],
    engineProtocolVersions: [1], engineVersions: [ENGINE_VERSION] };
  const negotiation = await host.negotiate({ ...scope, offer });
  assert.equal(negotiation.compatibility.stateVersion, 3);
  await assert.rejects(host.negotiate({ ...scope, offer: { ...offer, stateVersions: [1] } }), error => error.code === 'COMPATIBILITY_REQUIRED');
  const manifest = await host.bootstrap({ ...scope, compatibility: negotiation.compatibility });
  assert.equal(manifest.parts.find(part => part.kind === 'ledger-audit').recordCount, 1 + audit.originals.length + audit.corrections.length);
  const records = [];
  let token = manifest.firstPageToken;
  while (token !== null) {
    const page = await host.bootstrapPage({ ...scope, bootstrapId: manifest.bootstrapId, pageToken: token, limit: 1 });
    if (page.part === 'ledger-audit') records.push(...page.records);
    token = page.nextPageToken;
  }
  assert.deepEqual(records.filter(record => record.kind === 'original').map(record => record.value), audit.originals);
  assert.deepEqual(records.filter(record => record.kind === 'correction').map(record => record.value), audit.corrections);
  assert.deepEqual(records.find(record => record.kind === 'state').value,
    { version: 1, budgetId, baselineComplete: true, lastSequence: audit.lastSequence });
}

const budgetId = 'portable-audit';
const stamp = '2026-10-24T12:00:00.000Z';
/** Seed synthetic historical facts with a running balance matching replay. */
function payment(id, amount, type, date, balance) {
  return { id, name: id, amount, type, date, confirmed_date: date, ledger_year: Number(date.slice(0, 4)),
    currency: 'PLN', ledger_currency: 'PLN', fx_rate: 1, buffered_fx_rate: 1, ledger_amount: amount,
    occurrence_key: `manual:${id}`, running_balance_pln: balance,
    created_at: `${date}T12:00:00.000Z`, updated_at: `${date}T12:00:00.000Z` };
}
/** Corrections use the real owning transaction on each supported database. */
async function correct(store, id, extra = {}) {
  const own = store.backend === 'postgres' ? fn => store.transaction(fn) : fn => store.planningTransaction(budgetId, fn);
  return own(async (writer, connection) => {
    if (store.backend === 'postgres') await writer.lockBudgetLedger(budgetId);
    const query = async (sql, values = []) => {
      if (store.backend === 'postgres') {
        let index = 0;
        return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), values)).rows;
      }
      const statement = connection.prepare(sql);
      return statement.reader ? statement.all(...values) : (statement.run(...values), []);
    };
    const service = createLedgerCorrectionService({ budgetId, writer, query });
    await service.audit.ensureLegacyBaseline({ capturedAt: stamp });
    return service.correct({ id, targetId: 'income', expectedCorrectionId: null,
      replacement: { amount: 200, date: '2018-01-01' }, reason: 'Reviewed historical fact',
      actorId: 'historical-reviewer', createdAt: stamp, today: '2026-10-24', ...extra });
  });
}

/** Exercise the public full-JSON service against actual stores. Snapshot replay
 * recalculates balances; injected projection hooks also verify rollback after
 * the transactional restore has committed. */
async function exercise(store, harness = null) {
  for (const row of [payment('income', 500, 'income', '2018-01-01', 500),
    payment('expense', 400, 'expense', '2019-01-01', 100)]) {
    await store.insertConfirmedTransactions(budgetId, [row]);
  }
  await correct(store, 'blocked');
  await correct(store, 'resolve', { targetId: 'expense', replacement: { amount: 100, date: '2019-01-01' } });
  await correct(store, 'retry', { retryOf: 'blocked' });
  await correct(store, 'void', { targetId: 'expense', expectedCorrectionId: 'resolve', replacement: null });
  let failProjection = false;
  const logs = [];
  const service = createCashflowDataPortabilityService({ budgetStore: store,
    ...(harness ? { openPlanningDb: harness.openPlanningDb, openLedgerDb: (id, year) => harness.openLedgerDb(year, id),
      listLedgerYears: () => [2018] } : {}),
    recalculateLedgerRunningBalanceAsync: async () => {},
    regenerateProjectionsAfterMutationAsync: async () => {
      if (failProjection) throw new Error('Injected projection failure');
      return { projection_ok: true };
    },
    logError: (kind, details) => logs.push({ kind, details }),
    logServerEvent: (kind, details) => logs.push({ kind, details }) });
  const exported = await service.exportFullDataAsync(budgetId);
  assert.equal(exported.version, 2);
  assert.equal(exported.ledgerAudit.originals.length, 2);
  assert.equal(exported.ledgerAudit.corrections.length, 4);
  assert.equal(Object.values(exported.ledgers).flat().length, 1);
  if (harness) {
    assert.deepEqual(service.exportFullData(budgetId).ledgerAudit, exported.ledgerAudit);
    assert.deepEqual((await harness.api('/api/export/full')).ledgerAudit, exported.ledgerAudit);
    assert.throws(() => service.importFullData(budgetId, exported), /asynchronous runtime/);
  }
  const audit = structuredClone(exported.ledgerAudit);
  await exerciseAuditBootstrap(store, audit);
  const checksumChanged = structuredClone(exported);
  checksumChanged.ledgerAudit.originals[0].capturedAt = '2026-10-24T12:00:01.000Z';
  await assert.rejects(service.prepareFullImportPlanAsync(budgetId, checksumChanged), /checksum/i);
  const copy = copyLedgerAuditSnapshot(audit, 'independent-copy');
  assert.deepEqual(exported.ledgerAudit, audit, 'copy does not mutate source');
  assert.equal(copy.budgetId, 'independent-copy');
  assert.ok(copy.corrections.every(event => event.actorId === 'historical-reviewer'));
  for (const method of ['prepareFullImportPlanAsync', 'previewFullImportAsync', 'importFullDataAsync']) {
    await assert.rejects(service[method](budgetId, exported, 'merge'), /correction history|cannot be merged/i);
  }
  const legacy = structuredClone(exported);
  legacy.version = 1; delete legacy.ledgerAudit; delete legacy.checksum;
  for (const method of ['prepareFullImportPlanAsync', 'previewFullImportAsync', 'importFullDataAsync']) {
    await assert.rejects(service[method](budgetId, legacy, 'merge'), /correction history/i);
  }
  if (harness) assert.throws(() => service.previewFullImport(budgetId, legacy, 'merge'), /correction history/i);
  for (const mutate of [
    value => { value.ledgerAudit.corrections[0].status = 'accepted'; },
    value => { value.ledgerAudit.budgetId = 'foreign-budget'; },
    value => { delete value.ledgerAudit; },
    value => { value.version = 1; },
    value => { value.ledgers['2018'][0].amount = 999; }
  ]) {
    const damaged = structuredClone(exported); delete damaged.checksum; mutate(damaged);
    await assert.rejects(service.prepareFullImportPlanAsync(budgetId, damaged));
    assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), audit);
  }
  await correct(store, 'restore', { targetId: 'expense', expectedCorrectionId: 'void', replacement: { amount: 50, date: '2021-01-01' } });
  const before = await store.exportLedgerAuditSnapshot(budgetId);
  failProjection = true;
  await assert.rejects(service.importFullDataAsync(budgetId, exported), /rolled back/i);
  failProjection = false;
  assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), before);
  assert.ok(logs.some(entry => entry.kind === 'cashflow_async_import_rolled_back'));
  assert.ok(!logs.some(entry => entry.kind === 'cashflow_async_import_rollback_failed'));
  await service.importFullDataAsync(budgetId, exported);
  assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), audit);
  assert.equal((await correct(store, 'blocked')).replayed, true);
  if (harness) {
    const merged = await harness.request('/api/import/full', { method: 'POST', body: { mode: 'merge', export: exported } });
    assert.equal(merged.response.status, 400);
    await harness.api('/api/import/full', { method: 'POST', body: { mode: 'replace', export: exported } });
    assert.deepEqual((await harness.api('/api/export/full')).ledgerAudit, audit);
    const mismatched = structuredClone(exported); delete mismatched.checksum;
    mismatched.ledgers['2018'][0].name = 'Changed outside the audit';
    const rejected = await harness.request('/api/import/full', { method: 'POST', body: { mode: 'replace', export: mismatched } });
    assert.equal(rejected.response.status, 400, 'invalid audit/fact pair is a client validation error');
    assert.deepEqual((await harness.api('/api/export/full')).ledgerAudit, audit);
  }
  await service.importFullDataAsync('independent-copy', exported);
  assert.deepEqual(await store.exportLedgerAuditSnapshot('independent-copy'), copy);
  assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), audit);
  assert.equal((await store.listConfirmedTransactions('independent-copy'))[0].running_balance_pln, 200);
  const beforeLegacy = await service.createBudgetSafetySnapshotAsync(budgetId);
  await service.importFullDataAsync(budgetId, legacy);
  assert.equal(await store.exportLedgerAuditSnapshot(budgetId), null);
  assert.deepEqual(beforeLegacy.ledgerAudits[0], audit);
  return exported;
}

/** All migration artifacts and targets contain only this synthetic scenario;
 * migration reads the actual read-only SQLite snapshot, never live user files. */
async function withMigrationSource(work) {
  const harness = await createCashflowTestHarness({ userId: budgetId });
  const root = await mkdtemp(path.join(tmpdir(), 'cashflow-audit-migration-'));
  try {
    const store = createSqliteBudgetStore(createCashflowDbService(createCashflowStoragePaths(harness.dataDir)));
    const exported = await exercise(store, harness);
    await harness.api('/api/import/full', { method: 'POST', body: { mode: 'replace', export: exported } });
    const snapshot = createSqliteMigrationSnapshot({ dataDir: harness.dataDir, outputDir: path.join(root, 'snapshots') });
    return await work({ harness, root, dataDir: snapshot.snapshotPath, audit: exported.ledgerAudit });
  } finally { await harness.cleanup(); await rm(root, { recursive: true, force: true }); }
}

test('read-only SQLite migration export keeps a complete v2 audit and previews without PostgreSQL', async () => withMigrationSource(async ({ root, dataDir, audit }) => {
  const result = await createSqliteBudgetStorageExport({ dataDir, outputDir: path.join(root, 'exports') });
  const artifact = JSON.parse(fs.readFileSync(result.exportPath, 'utf8'));
  assert.equal(artifact.format, 'cashflow-budget-store-snapshot');
  assert.equal(artifact.version, 2);
  assert.deepEqual(artifact.ledgerAudits, [audit]);
  await assert.rejects(importSqliteBudgetStorageToPostgres({ payload: { ...artifact.payload, ledgerAudits: artifact.ledgerAudits } }), /v1 storage exports/i);
  const preview = await importBudgetStorageCli({ input: result.exportPath, dryRun: true });
  assert.equal(preview.ok, true);
  assert.ok(preview.budgetIds.includes(budgetId));
  assert.doesNotMatch(JSON.stringify(preview), /historical-reviewer|Reviewed historical fact/);
}));

test('audited migration roundtrip preserves blocked/retried/voided history and verifies retained evidence', {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => withMigrationSource(async ({ root, dataDir, audit }) => {
  const forwardOptions = { databaseUrl, dataDir, outputDir: path.join(root, 'forward'), dryRun: false, sourceIsSnapshot: true };
  await pool.query(createPostgresGlobalSchemaSql());
  const bootstrap = await createPostgresBudgetStore({ databaseUrl });
  try { await bootstrap.initialize(); } finally { await bootstrap.close(); }
  await pool.query(`CREATE FUNCTION cashflow_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Injected audit migration failure'; END; $$;
    CREATE TRIGGER reject_migrated_audit BEFORE INSERT ON cashflow_ledger_corrections
    FOR EACH ROW EXECUTE FUNCTION cashflow_test_reject_audit();`);
  try {
    await assert.rejects(migrateSqliteToPostgres(forwardOptions), /Injected audit migration failure/);
    for (const table of ['budgets', 'confirmed_transactions', 'cashflow_ledger_originals', 'cashflow_ledger_audit_state']) {
      assert.equal(Number((await pool.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count), 0, `${table} rolls back with late audit failure`);
    }
  } finally {
    await pool.query('DROP TRIGGER reject_migrated_audit ON cashflow_ledger_corrections; DROP FUNCTION cashflow_test_reject_audit()');
  }
  const forward = await migrateSqliteToPostgres(forwardOptions);
  assert.equal(forward.ok, true);
  const verificationOptions = { databaseUrl, globalExportPath: forward.artifacts.globalExportPath,
    budgetExportPath: forward.artifacts.budgetExportPath };
  assert.equal((await verifyPostgresMigration(verificationOptions)).ok, true);
  const incoming = JSON.parse(fs.readFileSync(forward.artifacts.budgetExportPath, 'utf8'));
  const importClient = await pool.connect();
  try {
    await assert.rejects(importSqliteBudgetStorageToPostgres({ client: importClient, dryRun: false,
      payload: incoming.payload }), /audited destination/i);
  } finally { importClient.release(); }
  const pgStore = await createPostgresBudgetStore({ databaseUrl });
  try { assert.deepEqual(await pgStore.exportLedgerAuditSnapshot(budgetId), audit); }
  finally { await pgStore.close(); }
  // Same financial row counts must not conceal missing audit records.
  const saved = await pool.query('SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = $1', [budgetId]);
  await pool.query('UPDATE cashflow_ledger_audit_state SET last_sequence = last_sequence + 1 WHERE budget_id = $1', [budgetId]);
  const damaged = await verifyPostgresMigration(verificationOptions);
  assert.equal(damaged.ok, false);
  assert.ok(damaged.mismatches.some(item => item.scope === 'ledger-audit'));
  await pool.query('UPDATE cashflow_ledger_audit_state SET last_sequence = $2 WHERE budget_id = $1', [budgetId, saved.rows[0].last_sequence]);
  const target = path.join(root, 'restored');
  const reverse = await migratePostgresToSqlite({ databaseUrl, dataDir: target, dryRun: false,
    outputDir: path.join(root, 'reverse') });
  assert.equal(reverse.ok, true);
  assert.equal(verifySqliteMigration({ dataDir: target, input: reverse.artifacts.exportPath }).ok, true);
  const restored = createSqliteBudgetStore(createCashflowDbService(createCashflowStoragePaths(target)));
  assert.deepEqual(await restored.exportLedgerAuditSnapshot(budgetId), audit);
  assert.equal((await correct(restored, 'blocked')).replayed, true);
  const db = createCashflowDbService(createCashflowStoragePaths(target)).openPlanningDb(budgetId);
  try { db.prepare('DELETE FROM cashflow_ledger_corrections WHERE budget_id = ? AND id = ?').run(budgetId, 'blocked'); }
  finally { db.close(); }
  assert.equal(verifySqliteMigration({ dataDir: target, input: reverse.artifacts.exportPath }).ok, false);
})));

test('SQLite full JSON retains audited history, refuses merges and supports independent copies', async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId });
  try { await exercise(createSqliteBudgetStore(createCashflowDbService(createCashflowStoragePaths(harness.dataDir))), harness); }
  finally { await harness.cleanup(); }
});

test('PostgreSQL full JSON retains the same audited replacement and independent-copy contract', {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  for (const id of [budgetId, 'independent-copy']) {
    await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [id]);
  }
  const store = await createPostgresBudgetStore({ databaseUrl });
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, 'settings', [{ id: 1, updated_at: stamp }]);
    await exercise(store);
  } finally { await store.close(); }
}));
