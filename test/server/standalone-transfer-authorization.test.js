import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { initializeGlobalSchema, applyGlobalMigrations } from '../../src/server/cashflow-global-schema.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createDeviceStore } from '../../src/server/cashflow-device-store.js';
import { createDeviceService } from '../../src/server/cashflow-device-service.js';
import { createStandaloneTransferJournal } from '../../src/server/cashflow-standalone-transfer-journal.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

/** Real browser-approved synthetic credentials authorize a journal transaction.
 * Publication effects remain a test-only row, not accepted financial import. */
async function exercise(globalStore, pool = null) {
  let clock = Date.parse('2026-10-25T12:00:00.000Z');
  const store = createDeviceStore(globalStore);
  const service = createDeviceService({ store, now: () => clock });
  const sql = (statement, values = []) => store.transaction(tx => tx.query(statement, values));
  const stamp = new Date(clock).toISOString();
  await sql("INSERT INTO accounts (id, display_name, status, created_at, updated_at) VALUES ('transfer-owner', 'Synthetic owner', 'active', ?, ?)", [stamp, stamp]);
  await sql("INSERT INTO budgets (id, storage_key, display_name, status, created_by_account_id, created_at, updated_at) VALUES ('transfer-existing', 'transfer-existing', 'Existing budget', 'active', 'transfer-owner', ?, ?)", [stamp, stamp]);
  await sql("INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at) VALUES ('transfer-existing', 'transfer-owner', 'owner', ?, ?)", [stamp, stamp]);
  await sql("UPDATE auth_config SET active_mode = 'internal' WHERE id = 1");
  await sql("INSERT INTO auth_sessions (id, account_id, token_hash, csrf_token_hash, auth_method, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES ('transfer-session', 'transfer-owner', 'synthetic-no-browser-token', 'synthetic-no-csrf', 'internal', ?, ?, ?, ?)",
    [stamp, stamp, new Date(clock + 3600000).toISOString(), new Date(clock + 86400000).toISOString()]);
  async function enroll(scope = 'app:financial:sync', mayCreateBudgets = true) {
    const pairing = await service.createPairing('Synthetic transfer phone', scope);
    await service.approve({ verificationCode: pairing.verificationCode, accountId: 'transfer-owner', sessionId: 'transfer-session',
      budgetIds: ['transfer-existing'], writeBudgetIds: scope === 'app:financial:sync' ? ['transfer-existing'] : [], mayCreateBudgets });
    return service.poll(pairing.deviceCode);
  }
  const tokens = await enroll();
  const binding = { instanceId: tokens.instanceId, accountId: tokens.accountId, deviceId: tokens.deviceId };
  const input = { version: 1, transferId: randomUUID(), ...binding, name: 'Synthetic transfer', sourceJson: '{"journalTest":true}' };
  const lookup = Object.fromEntries(Object.entries(input).filter(([key]) => !['name', 'sourceJson'].includes(key)));
  await sql('CREATE TABLE transfer_auth_test_effects (budget_id TEXT PRIMARY KEY)');
  // Any accidental nested service transaction fails instead of hanging on the
  // store queue; authorization must use exactly the journal owner's query.
  const authorizer = createDeviceService({ now: () => clock, store: { transaction() { throw new Error('Nested authorization transaction'); } } });
  let prepareCount = 0;
  const run = (method, token = tokens.accessToken, request = method === 'lookup' ? lookup : input) => store.transaction(async tx => {
    const journal = createStandaloneTransferJournal({ ...tx, now: () => clock,
      authorize: () => authorizer.authorizeBudgetCreationInTransaction(tx, token),
      prepare: async ({ budgetId }) => {
        await authorizer.authorizeBudgetCreationInTransaction(tx, token, { requireCapacity: true });
        prepareCount++;
        await tx.query('INSERT INTO transfer_auth_test_effects (budget_id) VALUES (?)', [budgetId]);
      } });
    return journal[method](request);
  });
  assert.deepEqual(await store.transaction(tx => authorizer.authorizeBudgetCreationInTransaction(tx, tokens.accessToken)), binding);
  assert.equal(await run('lookup'), null);
  const reservation = await run('reserve');
  assert.equal(reservation.state, 'reserved');
  const accepted = await run('publish');
  assert.equal(accepted.state, 'accepted');
  assert.equal(prepareCount, 1);
  assert.deepEqual(await run('publish'), accepted);
  assert.deepEqual(await run('lookup'), accepted);
  const original = (await sql('SELECT state_json FROM app_devices WHERE id = ?', [tokens.deviceId]))[0].state_json;
  const state = JSON.parse(original);
  // Financial publication must grant the fresh target on its owning
  // transaction, never by independently committing through the service store.
  const createAndGrant = async tx => {
    await tx.query("INSERT INTO budgets (id, storage_key, display_name, status, created_by_account_id, created_at, updated_at) VALUES ('atomic-grant', 'atomic-grant', 'Atomic grant', 'active', 'transfer-owner', ?, ?)", [stamp, stamp]);
    await tx.query("INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at) VALUES ('atomic-grant', 'transfer-owner', 'owner', ?, ?)", [stamp, stamp]);
    const result = await authorizer.grantCreatedBudgetInTransaction(tx, tokens.accessToken, 'atomic-grant');
    assert.ok(result.budgetIds.includes('atomic-grant'));
    assert.ok(result.writeBudgetIds.includes('atomic-grant'));
    return result;
  };
  await assert.rejects(store.transaction(async tx => {
    await createAndGrant(tx);
    throw new Error('Injected late financial publication failure');
  }), /Injected late financial publication failure/);
  assert.deepEqual(await sql("SELECT id FROM budgets WHERE id = 'atomic-grant'"), []);
  assert.equal((await sql('SELECT state_json FROM app_devices WHERE id = ?', [tokens.deviceId]))[0].state_json, original);
  // An ignored write must refuse before a creation receipt could be accepted.
  const postgres = pool !== null;
  await sql(postgres
    ? 'CREATE RULE ignore_created_grant AS ON UPDATE TO app_devices DO INSTEAD NOTHING'
    : 'CREATE TRIGGER ignore_created_grant BEFORE UPDATE ON app_devices BEGIN SELECT RAISE(IGNORE); END');
  try { await assert.rejects(store.transaction(createAndGrant), /grant was not recorded/); }
  finally { await sql(postgres ? 'DROP RULE ignore_created_grant ON app_devices' : 'DROP TRIGGER ignore_created_grant'); }
  assert.deepEqual(await sql("SELECT id FROM budgets WHERE id = 'atomic-grant'"), []);
  assert.equal((await sql('SELECT state_json FROM app_devices WHERE id = ?', [tokens.deviceId]))[0].state_json, original);
  await assert.rejects(store.transaction(tx => authorizer.grantCreatedBudgetInTransaction(tx, tokens.accessToken, 'not-owned')));
  for (const change of [{ mayCreateBudgets: false }, { mayCreateBudgets: undefined },
    { scope: 'app:snapshot:read', writeBudgetIds: [], mayCreateBudgets: false }]) {
    await sql('UPDATE app_devices SET state_json = ? WHERE id = ?', [JSON.stringify({ ...state, ...change }), tokens.deviceId]);
    for (const method of ['reserve', 'publish', 'lookup']) await assert.rejects(() => run(method));
    if (change.scope === 'app:snapshot:read') {
      await assert.rejects(store.transaction(tx => authorizer.authorizeTransferRecoveryInTransaction(tx, tokens.accessToken)));
    } else {
      assert.deepEqual(await store.transaction(tx => authorizer.authorizeTransferRecoveryInTransaction(tx, tokens.accessToken)), binding);
    }
  }
  await sql('UPDATE app_devices SET state_json = ? WHERE id = ?', [original, tokens.deviceId]);
  for (const field of Object.keys(binding)) {
    const changed = { ...lookup, [field]: field === 'instanceId' ? randomUUID() : 'different-binding' };
    await assert.rejects(() => run('lookup', tokens.accessToken, changed), { code: 'TRANSFER_BINDING_MISMATCH' });
  }
  const noCreate = await enroll('app:financial:sync', false);
  const readonly = await enroll('app:snapshot:read', false);
  for (const token of [noCreate.accessToken, readonly.accessToken, tokens.renewalToken, 'malformed']) await assert.rejects(() => run('lookup', token));
  for (const [disable, restore] of [
    ["UPDATE accounts SET status = 'disabled' WHERE id = 'transfer-owner'", "UPDATE accounts SET status = 'active' WHERE id = 'transfer-owner'"],
    ["UPDATE auth_config SET active_mode = 'none' WHERE id = 1", "UPDATE auth_config SET active_mode = 'internal' WHERE id = 1"],
    ["UPDATE auth_sessions SET revoked_at = '2026-10-25T12:00:00.000Z' WHERE id = 'transfer-session'", "UPDATE auth_sessions SET revoked_at = NULL WHERE id = 'transfer-session'"],
    [`UPDATE app_devices SET revoked_ms = ${clock} WHERE id = '${tokens.deviceId}'`, `UPDATE app_devices SET revoked_ms = NULL WHERE id = '${tokens.deviceId}'`]
  ]) {
    await sql(disable);
    try { await assert.rejects(() => run('lookup')); } finally { await sql(restore); }
  }
  // No auth read may create a new instance identity after restore.
  await sql('DELETE FROM app_device_instance');
  await assert.rejects(() => run('lookup'));
  assert.deepEqual(await sql('SELECT * FROM app_device_instance'), []);
  await sql('INSERT INTO app_device_instance (id, instance_id) VALUES (1, ?)', [binding.instanceId]);

  // Capacity limits new allocation, not recovery of an already accepted job.
  const budgets = Array.from({ length: 100 }, (_, index) => index ? `synthetic-grant-${index}` : 'transfer-existing');
  await sql('UPDATE app_devices SET state_json = ? WHERE id = ?', [JSON.stringify({ ...state, budgetIds: budgets }), tokens.deviceId]);
  assert.deepEqual(await run('lookup'), accepted);
  assert.deepEqual(await run('publish'), accepted);
  assert.equal(prepareCount, 1);
  await assert.rejects(store.transaction(tx => authorizer.authorizeBudgetCreationInTransaction(tx, tokens.accessToken, { requireCapacity: true })), /budget limit/);
  const next = { ...input, transferId: randomUUID() };
  await run('reserve', tokens.accessToken, next);
  await assert.rejects(() => run('publish', tokens.accessToken, next), /budget limit/);
  assert.equal((await sql('SELECT * FROM transfer_auth_test_effects')).length, 1);
  // Ordinary creation has two transactions. Another request can fill the
  // final grant slot after its first check; never persist a 101-entry device
  // that active() would reject on every later request.
  await sql("INSERT INTO budgets (id, storage_key, display_name, status, created_by_account_id, created_at, updated_at) VALUES ('capacity-race', 'capacity-race', 'Capacity race', 'active', 'transfer-owner', ?, ?)", [stamp, stamp]);
  await sql("INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at) VALUES ('capacity-race', 'transfer-owner', 'owner', ?, ?)", [stamp, stamp]);
  const atCapacity = (await sql('SELECT state_json FROM app_devices WHERE id = ?', [tokens.deviceId]))[0].state_json;
  await assert.rejects(service.grantCreatedBudget(tokens.accessToken, 'capacity-race'), /budget limit/);
  assert.equal((await sql('SELECT state_json FROM app_devices WHERE id = ?', [tokens.deviceId]))[0].state_json, atCapacity);
  assert.deepEqual(await run('lookup'), accepted);
  // Replaying an already granted target at capacity needs no new slot.
  await service.grantCreatedBudget(tokens.accessToken, 'transfer-existing');
  assert.deepEqual(await run('lookup'), accepted);
  await sql('UPDATE app_devices SET state_json = ? WHERE id = ?', [original, tokens.deviceId]);

  if (pool) {
    // Observe actual cross-connection blocking. Browser account/session/mode
    // changes and device revocation cannot cross an authorized publication.
    for (const statement of ["UPDATE accounts SET display_name = 'Changed' WHERE id = 'transfer-owner'",
      "UPDATE auth_sessions SET last_seen_at = last_seen_at WHERE id = 'transfer-session'",
      'UPDATE auth_config SET active_mode = active_mode WHERE id = 1',
      'UPDATE app_devices SET state_json = state_json WHERE id = $1']) {
      const owner = await pool.connect(), contender = await pool.connect();
      let pending;
      try {
        await owner.query('BEGIN');
        const query = async (text, values = []) => {
          let position = 0;
          return (await owner.query(text.replace(/\?/g, () => `$${++position}`), values)).rows;
        };
        await authorizer.authorizeBudgetCreationInTransaction({ query, backend: 'postgres' }, tokens.accessToken);
        const pid = (await contender.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        pending = contender.query(statement, statement.includes('$1') ? [tokens.deviceId] : []);
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await pool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, 'permission state change must wait for the transfer transaction');
      } finally {
        await owner.query('ROLLBACK');
        if (pending) await pending;
        owner.release(); contender.release();
      }
    }
  }
  clock += 16 * 60000;
  await assert.rejects(() => run('lookup'));
  assert.equal((await sql('SELECT * FROM transfer_auth_test_effects')).length, 1);
}

test('SQLite standalone journal uses current creation permission on its owning transaction', async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    initializeGlobalSchema(db); applyGlobalMigrations(db);
    await exercise({ withRepository: callback => callback({ backend: 'sqlite' }, db) });
  } finally { db.close(); }
});

test('PostgreSQL standalone journal fences current permission and recovers accepted outcomes at capacity', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const store = await createPostgresGlobalStore({ databaseUrl });
    try { await store.initialize(); await exercise(store, pool); } finally { await store.close(); }
  });
});
