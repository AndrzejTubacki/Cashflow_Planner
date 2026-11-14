import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyGlobalMigrations, GLOBAL_SCHEMA_VERSION, initializeGlobalSchema } from '../../src/server/cashflow-global-schema.js';
import { STANDALONE_TRANSFER_JOURNAL_SCHEMA } from '../../src/server/cashflow-standalone-transfer-schema.js';
import { createStandaloneTransferJournal } from '../../src/server/cashflow-standalone-transfer-journal.js';
import { createSqliteGlobalStore } from '../../src/server/cashflow-sqlite-global-store.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createDeviceStore } from '../../src/server/cashflow-device-store.js';
import { createGlobalStoreExport } from '../../src/server/cashflow-global-store-export.js';
import { applyGlobalStoreImportPlan } from '../../src/server/cashflow-global-store-import-plan.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const TABLE = 'cashflow_standalone_transfers';
const grant = { instanceId: '11111111-1111-4111-8111-111111111111', accountId: 'metadata-owner', deviceId: 'historical-device' };
const normalized = rows => rows.map(row => ({ ...row, created_ms: Number(row.created_ms) })).sort((a,b) => a.transfer_id.localeCompare(b.transfer_id));

/** Seed journal metadata only, with an explicitly synthetic authorization host.
 * A no-op preparer does not represent accepted financial import. No real token,
 * reusable credential, financial budget or live device is created here. */
async function seed(store) {
  await store.insertRows('accounts', [{ id: grant.accountId, display_name: 'Retained account', status: 'active',
    created_at: '2026-10-25T12:00:00.000Z', updated_at: '2026-10-25T12:00:00.000Z' }]);
  await store.insertRows('app_device_instance', [{ id: 1, instance_id: grant.instanceId }]);
  await store.insertRows('app_devices', [{ id: grant.deviceId, account_id: grant.accountId, state_json: '{}', revoked_ms: null }]);
  await store.insertRows('app_device_tokens', [{ token_hash: 'synthetic-hash-only', device_id: grant.deviceId, kind: 'access', expires_ms: 123456 }]);
  const deviceStore = createDeviceStore(store);
  for (const state of ['reserved', 'accepted', 'cancelled']) {
    const input = { version: 1, transferId: randomUUID(), ...grant, name: 'Metadata fixture', sourceJson: '{"journalFixture":true}' };
    await deviceStore.transaction(async ({ query, backend }) => {
      const journal = createStandaloneTransferJournal({ query, backend, authorize: async () => grant,
        prepare: async () => {}, now: () => Date.parse('2026-10-25T12:00:00.000Z') });
      await journal.reserve(input);
      if (state === 'accepted') await journal.publish(input);
      if (state === 'cancelled') await journal.cancel(input);
    });
  }
}

test('SQLite global 7 to 8 transfer-schema migration rolls back late DDL failure and preserves existing accounts', () => {
  const db = new Database(':memory:');
  try {
    initializeGlobalSchema(db);
    db.exec(`DROP TABLE ${TABLE}; PRAGMA user_version = 7;
      INSERT INTO accounts (id, display_name, created_at, updated_at) VALUES ('kept', 'Retained account', '2026-01-01', '2026-01-01')`);
    assert.throws(() => applyGlobalMigrations(db, { beforeStep: (version, connection) => {
      assert.equal(version, 8);
      connection.exec(STANDALONE_TRANSFER_JOURNAL_SCHEMA);
      throw new Error('Injected transfer DDL failure');
    } }), /Injected/);
    assert.equal(db.pragma('user_version', { simple: true }), 7);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE), undefined);
    assert.equal(db.prepare("SELECT display_name FROM accounts WHERE id = 'kept'").get().display_name, 'Retained account');
    applyGlobalMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), GLOBAL_SCHEMA_VERSION);
    assert.deepEqual(db.prepare(`SELECT * FROM ${TABLE}`).all(), []);
  } finally { db.close(); }
});

test('SQLite portable global metadata retains transfer outcomes without restoring devices or tokens and rolls back a failed replacement', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cashflow-transfer-storage-'));
  const source = createSqliteGlobalStore({ dataDir: path.join(directory, 'source'), listCashflowUserIds: () => [] });
  const target = createSqliteGlobalStore({ dataDir: path.join(directory, 'target'), listCashflowUserIds: () => [] });
  try {
    source.initialize(); target.initialize(); await seed(source);
    const payload = await createGlobalStoreExport({ globalStore: source });
    assert.equal(payload.sourceGlobalSchemaVersion, GLOBAL_SCHEMA_VERSION);
    assert.equal(payload.tables[TABLE].length, 3);
    assert.ok(payload.tables[TABLE].some(row => row.state === 'reserved' && row.receipt_json === null));
    assert.ok(payload.tables[TABLE].some(row => row.state === 'accepted' && JSON.parse(row.receipt_json).budgetId === row.budget_id));
    assert.ok(payload.tables[TABLE].some(row => row.state === 'cancelled' && JSON.parse(row.receipt_json).cancelledAt));
    for (const name of ['app_device_instance', 'app_devices', 'app_device_tokens']) assert.deepEqual(payload.tables[name], []);
    await applyGlobalStoreImportPlan({ globalStore: target, payload, mode: 'replace' });
    assert.deepEqual(normalized(await target.listRows(TABLE)), normalized(await source.listRows(TABLE)));
    assert.deepEqual(await target.listRows('app_devices'), []);
    assert.deepEqual(await target.listRows('app_device_tokens'), []);
    const damaged = structuredClone(payload);
    damaged.tables.accounts[0].display_name = 'Must not publish';
    const wrong = damaged.tables[TABLE].find(row => row.state === 'accepted');
    wrong.budget_id = `budget_${randomUUID()}`;
    wrong.receipt_json = JSON.stringify({ ...JSON.parse(wrong.receipt_json), budgetId: wrong.budget_id });
    await assert.rejects(() => applyGlobalStoreImportPlan({ globalStore: target, payload: damaged, mode: 'replace' }), { code: 'TRANSFER_RECORD_INVALID' });
    assert.equal((await target.listRows('accounts'))[0].display_name, 'Retained account');
    assert.deepEqual(normalized(await target.listRows(TABLE)), normalized(await source.listRows(TABLE)));
    target.withRepository((_repo, db) => db.exec(`CREATE TRIGGER fail_transfer_restore BEFORE INSERT ON ${TABLE}
      BEGIN SELECT RAISE(ABORT, 'injected_transfer_restore'); END`));
    const changed = structuredClone(payload);
    changed.tables.accounts[0].display_name = 'Should roll back';
    await assert.rejects(() => applyGlobalStoreImportPlan({ globalStore: target, payload: changed, mode: 'replace' }), /injected_transfer_restore/);
    assert.equal((await target.listRows('accounts'))[0].display_name, 'Retained account');
    assert.deepEqual(normalized(await target.listRows(TABLE)), normalized(await source.listRows(TABLE)));
    target.withRepository((_repo, db) => db.exec('DROP TRIGGER fail_transfer_restore'));
    const legacy = structuredClone(payload); delete legacy.tables[TABLE]; legacy.sourceGlobalSchemaVersion = 7;
    await applyGlobalStoreImportPlan({ globalStore: target, payload: legacy, mode: 'replace' });
    assert.deepEqual(await target.listRows(TABLE), []);
    assert.deepEqual(await target.listRows('app_devices'), []);
  } finally { await source.close(); await target.close(); await rm(directory, { recursive: true, force: true }); }
});

test('transfer metadata survives SQLite to PostgreSQL to SQLite while live device grants stay absent', { skip: !postgresRuntimeTestsEnabled() }, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cashflow-transfer-storage-pg-'));
    const source = createSqliteGlobalStore({ dataDir: path.join(directory, 'source'), listCashflowUserIds: () => [] });
    const target = createSqliteGlobalStore({ dataDir: path.join(directory, 'target'), listCashflowUserIds: () => [] });
    const postgres = await createPostgresGlobalStore({ databaseUrl });
    try {
      source.initialize(); target.initialize(); await postgres.initialize(); await seed(source);
      const exported = await createGlobalStoreExport({ globalStore: source });
      await applyGlobalStoreImportPlan({ globalStore: postgres, payload: exported, mode: 'replace' });
      assert.deepEqual(normalized(await postgres.listRows(TABLE)), normalized(await source.listRows(TABLE)));
      for (const name of ['app_device_instance', 'app_devices', 'app_device_tokens']) assert.deepEqual(await postgres.listRows(name), []);
      const returned = await createGlobalStoreExport({ globalStore: postgres });
      await applyGlobalStoreImportPlan({ globalStore: target, payload: returned, mode: 'replace' });
      assert.deepEqual(normalized(await target.listRows(TABLE)), normalized(await source.listRows(TABLE)));
      for (const name of ['app_device_instance', 'app_devices', 'app_device_tokens']) assert.deepEqual(await target.listRows(name), []);
    } finally { await postgres.close(); await source.close(); await target.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

/** Rebuild the earlier constraints with populated outcomes, then fail during
 * the combined step row copy to prove the table rename and version bump roll back too. */
test('SQLite global 7 to 8 preserves receipts atomically and enables cancellation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cashflow-transfer-upgrade-'));
  const store = createSqliteGlobalStore({ dataDir: directory, listCashflowUserIds: () => [] });
  try {
    store.initialize(); await seed(store);
    store.withRepository((_repo, db) => {
      // The pre-cancellation table accepts only reserved/accepted outcomes.
      db.exec(`DELETE FROM ${TABLE} WHERE state = 'cancelled'; ALTER TABLE ${TABLE} RENAME TO prior_transfer;
        ${STANDALONE_TRANSFER_JOURNAL_SCHEMA.replaceAll("'accepted', 'cancelled'", "'accepted'")}
        INSERT INTO ${TABLE} SELECT * FROM prior_transfer;
        DROP TABLE prior_transfer; PRAGMA user_version = 7`);
      const prior = db.prepare(`SELECT * FROM ${TABLE}`).all();
      const exec = db.exec;
      let schemaCalls = 0;
      // Inject after the new table exists, so failure occurs during row copy.
      db.exec = function(sql) {
        const result = exec.call(this, sql);
        if (sql === STANDALONE_TRANSFER_JOURNAL_SCHEMA && ++schemaCalls === 2) exec.call(this, `CREATE TRIGGER fail_new_copy BEFORE INSERT ON ${TABLE}
          BEGIN SELECT RAISE(ABORT, 'injected migration row-copy failure'); END`);
        return result;
      };
      try { assert.throws(() => applyGlobalMigrations(db), /injected migration row-copy failure/); }
      finally { db.exec = exec; }
      assert.equal(db.pragma('user_version', { simple: true }), 7);
      assert.deepEqual(db.prepare(`SELECT * FROM ${TABLE}`).all(), prior);
      assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'cashflow_standalone_transfers_old'").get(), undefined);
      applyGlobalMigrations(db);
      assert.equal(db.pragma('user_version', { simple: true }), GLOBAL_SCHEMA_VERSION);
      assert.deepEqual(db.prepare(`SELECT * FROM ${TABLE}`).all(), prior);
    });
    const rows = await store.listRows(TABLE);
    assert.equal(rows.length, 2);
    const deviceStore = createDeviceStore(store);
    const input = { version: 1, transferId: randomUUID(), ...grant, name: 'Cancel after upgrade', sourceJson: '{}' };
    const receipt = await deviceStore.transaction(tx => createStandaloneTransferJournal({ ...tx,
      authorize: async () => grant, prepare: async () => {} }).cancel(input));
    assert.equal(receipt.state, 'cancelled');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});
