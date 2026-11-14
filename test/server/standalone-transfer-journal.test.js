import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStandaloneTransferJournal, STANDALONE_TRANSFER_JOURNAL_SCHEMA } from '../../src/server/cashflow-standalone-transfer-journal.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const grant = { instanceId: '11111111-1111-4111-8111-111111111111', accountId: 'synthetic-owner', deviceId: 'synthetic-device' };
const input = () => ({ version: 1, transferId: randomUUID(), ...grant, name: 'Independent transfer',
  // The journal tests use opaque bytes, not purported accepted financial data.
  // Financial validation has separate real-engine fixtures; no writer is wired.
  sourceJson: '{"syntheticJournalInput":true}' });
const lookup = value => Object.fromEntries(['version', 'transferId', ...Object.keys(grant)].map(key => [key, value[key]]));
const EFFECTS = 'CREATE TABLE transfer_test_effects (budget_id TEXT PRIMARY KEY, name TEXT NOT NULL)';

/** All effects here are test-only SQL rows for journal atomicity. This does not
 * claim financial import, cross-file publication or real-device authorization. */
async function exercise({ backend, transaction, outside, reopen }) {
  let authorized = true, activeGrant = grant, failure = null, prepares = 0, checks = 0;
  const run = (work, overrides = {}) => transaction(async query => work(createStandaloneTransferJournal({ query, backend,
    now: () => Date.parse('2026-10-25T12:00:00.000Z'),
    authorize: async context => {
      assert.equal(context.query, query);
      checks++;
      if (!authorized) throw new Error('Synthetic grant revoked');
      return activeGrant;
    },
    prepare: async ({ query: owningQuery, budgetId, input: accepted, grant: current }) => {
      assert.equal(owningQuery, query); assert.deepEqual(current, grant); prepares++;
      await query('INSERT INTO transfer_test_effects (budget_id, name) VALUES (?, ?)', [budgetId, accepted.name]);
      if (failure === 'prepare') throw new Error('Injected preparation failure');
    },
    afterRecord: async () => { if (failure === 'receipt') throw new Error('Injected receipt failure'); }, ...overrides
  })));
  const original = input();
  assert.equal(await run(journal => journal.lookup(lookup(original))), null);
  await assert.rejects(() => run(journal => journal.publish(original)), { code: 'TRANSFER_NOT_RESERVED' });
  const reserved = await run(journal => journal.reserve(original));
  assert.equal(reserved.state, 'reserved');
  assert.deepEqual(await run(journal => journal.reserve(original)), reserved);
  if (reopen) await reopen();
  assert.deepEqual(await run(journal => journal.lookup(lookup(original))), reserved);
  for (const changed of [{ ...original, name: 'Another destination name' }, { ...original, sourceJson: '{"changed":true}' }]) {
    await assert.rejects(() => run(journal => journal.reserve(changed)), { code: 'TRANSFER_ID_REUSED' });
    await assert.rejects(() => run(journal => journal.publish(changed)), { code: 'TRANSFER_ID_REUSED' });
  }
  assert.deepEqual(await outside('SELECT * FROM transfer_test_effects'), []);
  for (const phase of ['prepare', 'receipt']) {
    failure = phase;
    await assert.rejects(() => run(journal => journal.publish(original)), /Injected/);
    assert.deepEqual(await run(journal => journal.lookup(lookup(original))), reserved);
    assert.deepEqual(await outside('SELECT * FROM transfer_test_effects'), []);
  }
  failure = null;
  const accepted = await run(journal => journal.publish(original));
  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.budgetId, reserved.budgetId);
  assert.equal(accepted.acceptedAt, '2026-10-25T12:00:00.000Z');
  const count = prepares;
  // Lost response/restart: use the same frozen input and recover the same receipt.
  if (reopen) await reopen();
  assert.deepEqual(await run(journal => journal.publish(original)), accepted);
  assert.deepEqual(await run(journal => journal.reserve(original)), accepted);
  assert.deepEqual(await run(journal => journal.lookup(lookup(original))), accepted);
  assert.equal(prepares, count);
  assert.equal((await outside('SELECT * FROM transfer_test_effects')).length, 1);
  const wrongDestination = `budget_${randomUUID()}`;
  await outside('UPDATE cashflow_standalone_transfers SET budget_id = ?, receipt_json = ? WHERE transfer_id = ?',
    [wrongDestination, JSON.stringify({ ...accepted, budgetId: wrongDestination }), original.transferId]);
  try {
    await assert.rejects(() => run(journal => journal.lookup(lookup(original))), { code: 'TRANSFER_RECORD_INVALID' });
  } finally {
    await outside('UPDATE cashflow_standalone_transfers SET budget_id = ?, receipt_json = ? WHERE transfer_id = ?',
      [accepted.budgetId, JSON.stringify(accepted), original.transferId]);
  }
  authorized = false;
  const beforeDenied = checks;
  for (const method of ['reserve', 'publish', 'lookup']) {
    await assert.rejects(() => run(journal => journal[method](method === 'lookup' ? lookup(original) : original)), /revoked/);
  }
  assert.equal(checks - beforeDenied, 3);
  authorized = true;
  for (const key of Object.keys(grant)) {
    activeGrant = { ...grant, [key]: key === 'instanceId' ? randomUUID() : 'different-current-grant' };
    await assert.rejects(() => run(journal => journal.reserve(original)), { code: 'TRANSFER_BINDING_MISMATCH' });
    await assert.rejects(() => run(journal => journal.lookup(lookup(original))), { code: 'TRANSFER_BINDING_MISMATCH' });
  }
  activeGrant = grant;
  assert.equal((await outside('SELECT * FROM cashflow_standalone_transfers')).length, 1);
  const race = input();
  const reservations = await Promise.all([run(journal => journal.reserve(race)), run(journal => journal.reserve(race))]);
  assert.deepEqual(reservations[0], reservations[1]);
  const beforeRace = prepares;
  const outcomes = await Promise.all([run(journal => journal.publish(race)), run(journal => journal.publish(race))]);
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(prepares, beforeRace + 1);
  // Global metadata can be restored separately from newer financial storage.
  // Losing a receipt must never allocate another destination or authorize an
  // overwrite of surviving storage. The future publisher needs origin recovery;
  // this test-only preparer's unique key safely refuses an existing target.
  await outside('DELETE FROM cashflow_standalone_transfers WHERE transfer_id = ?', [race.transferId]);
  const restoredReservation = await run(journal => journal.reserve(race));
  assert.equal(restoredReservation.budgetId, outcomes[0].budgetId);
  await assert.rejects(() => run(journal => journal.publish(race)));
  assert.equal((await outside('SELECT * FROM transfer_test_effects')).length, 2);
  const ignored = input();
  const ignoredReservation = await run(journal => journal.reserve(ignored));
  const effectCount = (await outside('SELECT * FROM transfer_test_effects')).length;
  // A successful SQL call is insufficient evidence if a trigger/rule ignored
  // the receipt write. Verify stored state before allowing the owner to commit.
  await outside(backend === 'sqlite'
    ? "CREATE TRIGGER ignore_transfer_receipt BEFORE UPDATE ON cashflow_standalone_transfers BEGIN SELECT RAISE(IGNORE); END"
    : 'CREATE RULE ignore_transfer_receipt AS ON UPDATE TO cashflow_standalone_transfers DO INSTEAD NOTHING');
  try {
    await assert.rejects(() => run(journal => journal.publish(ignored)), { code: 'TRANSFER_OUTCOME_NOT_RECORDED' });
  } finally { await outside(backend === 'sqlite' ? 'DROP TRIGGER ignore_transfer_receipt' : 'DROP RULE ignore_transfer_receipt ON cashflow_standalone_transfers'); }
  assert.deepEqual(await run(journal => journal.lookup(lookup(ignored))), ignoredReservation);
  assert.equal((await outside('SELECT * FROM transfer_test_effects')).length, effectCount);
  for (const changed of [{ ...original, version: 2 }, { ...original, sourceHash: accepted.inputHash },
    { ...original, transferId: 'not-a-uuid' }, { ...original, name: 'Unreviewed\nname' }]) {
    await assert.rejects(() => run(journal => journal.reserve(changed)), { code: 'INVALID_TRANSFER_REQUEST' });
  }
  // Durable file seals may restore an old decision time, but never another
  // scope, input or budget. Receipt recovery is trusted host code, not an
  // uploaded claimed outcome or a preparation callback return value.
  const recovering = input();
  const pending = await run(journal => journal.reserve(recovering));
  const candidate = { ...pending, state: 'accepted', acceptedAt: '2026-10-25T11:59:00.000Z' };
  for (const change of [{ budgetId: `budget_${randomUUID()}` }, { inputHash: '0'.repeat(64) },
    { accountId: 'different' }, { transferId: randomUUID() }, { state: 'reserved' },
    { acceptedAt: '2026-10-25 11:59:00' }, { unexpected: true }]) {
    await assert.rejects(run(journal => journal.publish(recovering), { recoverReceipt: async () => ({ ...candidate, ...change }) }),
      { code: 'TRANSFER_RECORD_INVALID' });
    assert.deepEqual(await run(journal => journal.lookup(lookup(recovering))), pending);
  }
  const recovered = await run(journal => journal.publish(recovering), {
    recoverReceipt: async () => candidate,
    prepare: async ({ query, budgetId, input: frozen, receipt }) => {
      assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(frozen));
      assert.deepEqual(receipt, candidate);
      await query('INSERT INTO transfer_test_effects (budget_id, name) VALUES (?, ?)', [budgetId, frozen.name]);
      return { ...receipt, budgetId: 'ignored-preparer-outcome' };
    }
  });
  assert.deepEqual(recovered, candidate);
  authorized = false;
  await assert.rejects(run(journal => journal.publish(recovering), {
    recoverReceipt: async () => assert.fail('A revoked caller must not read a durable seal')
  }), /revoked/);
  authorized = true;
  // Awaited authorization cannot change the journal's already captured scalar
  // source/name identity by mutating the caller's original object.
  const mutable = input(), frozen = { ...mutable };
  const immutable = await run(journal => journal.reserve(mutable), { authorize: async () => {
    mutable.name = 'Changed during authorization'; return grant;
  } });
  assert.deepEqual(await run(journal => journal.reserve(frozen)), immutable);
  await assert.rejects(run(journal => journal.reserve(mutable)), { code: 'TRANSFER_ID_REUSED' });
  const beforeCancel = prepares;
  for (const reserveFirst of [false, true]) {
    const cancelledInput = input();
    if (reserveFirst) await run(journal => journal.reserve(cancelledInput));
    const cancelled = await run(journal => journal.cancel(cancelledInput));
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.cancelledAt, '2026-10-25T12:00:00.000Z');
    assert.deepEqual(await run(journal => journal.cancel(cancelledInput)), cancelled);
    assert.deepEqual(await run(journal => journal.publish(cancelledInput)), cancelled);
    assert.deepEqual(await run(journal => journal.reserve(cancelledInput)), cancelled);
    assert.deepEqual(await run(journal => journal.lookup(lookup(cancelledInput))), cancelled);
    await assert.rejects(run(journal => journal.cancel({ ...cancelledInput, sourceJson: '{}' })), { code: 'TRANSFER_ID_REUSED' });
  }
  assert.equal(prepares, beforeCancel, 'a delayed publisher must never run after cancellation');
  assert.deepEqual(await run(journal => journal.cancel(original)), accepted, 'cancellation cannot delete an accepted budget');
  const raced = input();
  await run(journal => journal.reserve(raced));
  const final = await Promise.all([run(journal => journal.publish(raced)), run(journal => journal.cancel(raced))]);
  assert.deepEqual(final[0], final[1]);
  assert.ok(['accepted', 'cancelled'].includes(final[0].state));
  const interruptedCancel = input();
  await assert.rejects(run(journal => journal.cancel(interruptedCancel), { afterRecord: async () => { throw new Error('Injected cancellation failure'); } }), /Injected/);
  assert.equal(await run(journal => journal.lookup(lookup(interruptedCancel))), null);
  const ignoredCancel = input();
  const stillPending = await run(journal => journal.reserve(ignoredCancel));
  await outside(backend === 'sqlite'
    ? 'CREATE TRIGGER ignore_cancel_receipt BEFORE UPDATE ON cashflow_standalone_transfers BEGIN SELECT RAISE(IGNORE); END'
    : 'CREATE RULE ignore_cancel_receipt AS ON UPDATE TO cashflow_standalone_transfers DO INSTEAD NOTHING');
  try { await assert.rejects(run(journal => journal.cancel(ignoredCancel)), { code: 'TRANSFER_OUTCOME_NOT_RECORDED' }); }
  finally { await outside(backend === 'sqlite' ? 'DROP TRIGGER ignore_cancel_receipt' : 'DROP RULE ignore_cancel_receipt ON cashflow_standalone_transfers'); }
  assert.deepEqual(await run(journal => journal.lookup(lookup(ignoredCancel))), stillPending);
}

test('SQLite transfer journal retains destination across reopen, refuses retargeting and rolls back publication failures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cashflow-transfer-journal-'));
  let db = new Database(path.join(directory, 'journal.sqlite'));
  db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('synthetic-owner')");
  db.exec(STANDALONE_TRANSFER_JOURNAL_SCHEMA); db.exec(EFFECTS);
  let queue = Promise.resolve();
  const query = async (sql, values = []) => {
    const statement = db.prepare(sql);
    return statement.reader ? statement.all(...values) : (statement.run(...values), []);
  };
  const transaction = work => {
    const result = queue.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const value = await work(query); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    queue = result.catch(() => {});
    return result;
  };
  try {
    await exercise({ backend: 'sqlite', transaction, outside: query,
      reopen: async () => { db.close(); db = new Database(path.join(directory, 'journal.sqlite')); } });
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('PostgreSQL transfer journal serializes competing replicas and preserves atomic immutable outcomes', { skip: !postgresRuntimeTestsEnabled() }, async () => {
  await withDisposablePostgresDb(async ({ pool }) => {
    const queryFor = client => async (sql, values = []) => {
      let index = 0;
      return (await client.query(sql.replace(/\?/g, () => `$${++index}`), values)).rows || [];
    };
    await pool.query("CREATE TABLE accounts (id TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('synthetic-owner')");
    await pool.query(STANDALONE_TRANSFER_JOURNAL_SCHEMA); await pool.query(EFFECTS);
    try {
      await exercise({ backend: 'postgres', outside: queryFor(pool), transaction: async work => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(queryFor(client));
          await client.query('COMMIT'); return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      } });
    } finally { await pool.query('DROP TABLE IF EXISTS transfer_test_effects, cashflow_standalone_transfers'); }
  });
});
