import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createLedgerAuditStore, LEDGER_AUDIT_SCHEMA, LEDGER_ORIGIN_SCHEMA } from '../../src/server/cashflow-ledger-audit-store.js';
import { readSqliteFinancialExportAudit } from '../../src/server/cashflow-ledger-audit-export.js';
import { createLedgerAuditReplay } from '../../src/engine/ledger-audit-replay.js';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { completeSnapshot } from '../engine/fixtures.js';
import { refreshLocalSnapshot } from '../../src/engine/local-confirmation.js';
import { standaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
import { normalizeLedgerAuditFact } from '../../src/engine/ledger-audit-fact.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const codec = createLedgerAuditReplay({ digestText: hash, utf8ByteLength: text => Buffer.byteLength(text), allowStandaloneOrigins: true });
const budgetId = 'server-origin-audit';

/** File/reconnection and rollback acceptance for the internal origin-aware
 * store. The facts table is a test ledger adapter, not the production publisher. */
async function exercise(pool = null) {
  const directory = pool ? null : mkdtempSync(join(tmpdir(), 'cashflow-origin-store-'));
  const filename = directory && join(directory, 'owned.sqlite');
  let connection = pool ? await pool.connect() : new Database(filename);
  const raw = text => pool ? connection.query(text) : connection.exec(text);
  const query = async (text, values = []) => {
    if (pool) { let index = 0; return (await connection.query(text.replace(/\?/g, () => `$${++index}`), values)).rows; }
    const statement = connection.prepare(text);
    return statement.reader ? statement.all(...values) : (statement.run(...values), []);
  };
  const transaction = async action => {
    await raw('BEGIN');
    try { const result = await action(); await raw('COMMIT'); return result; } catch (error) { await raw('ROLLBACK'); throw error; }
  };
  const load = async scope => (await query('SELECT data_json FROM origin_test_facts WHERE budget_id = ? ORDER BY id', [scope])).map(row => JSON.parse(row.data_json));
  const store = (scope = budgetId, allowStandaloneOrigins = true) => createLedgerAuditStore({ budgetId: scope, query,
    loadEffectiveRows: () => load(scope), allowStandaloneOrigins });
  const put = row => query(`INSERT INTO origin_test_facts (budget_id, id, data_json) VALUES (?, ?, ?)
    ON CONFLICT (budget_id, id) DO UPDATE SET data_json = excluded.data_json`, [row.budget_id, row.id, JSON.stringify(row)]);
  const seed = async audit => {
    const state = codec.replayLedgerAuditSnapshot(audit, audit.budgetId);
    for (const row of state.rows) await put(row);
    await store(audit.budgetId).restoreSnapshot(audit);
  };
  try {
    if (!pool) connection.pragma('foreign_keys = ON');
    await raw(LEDGER_AUDIT_SCHEMA + LEDGER_ORIGIN_SCHEMA);
    await raw('CREATE TABLE origin_test_facts (budget_id TEXT NOT NULL, id TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY (budget_id, id))');
    const audit = standaloneOriginAuditFixture().audit;
    await assert.rejects(transaction(() => store(budgetId, false).restoreSnapshot(audit)), /upgraded host/);
    assert.deepEqual(await query('SELECT * FROM cashflow_ledger_audit_state'), []);
    await transaction(() => seed(audit));
    assert.equal((await query('SELECT * FROM cashflow_ledger_originals')).length, 1);
    assert.deepEqual(await query('SELECT * FROM cashflow_ledger_corrections'), []);
    const retained = (await query('SELECT * FROM cashflow_ledger_origins WHERE budget_id = ?', [budgetId]))[0];
    if (pool) { connection.release(); connection = await pool.connect(); }
    else { connection.close(); connection = new Database(filename); connection.pragma('foreign_keys = ON'); }
    assert.deepEqual(await store().exportSnapshot(), audit);
    await assert.rejects(store(budgetId, false).exportSnapshot(), /upgraded host/);
    const original = await store().original('confirmed-original'); original.row.amount = 1;
    assert.equal((await store().original('confirmed-original')).row.amount, 400);
    const correct = (id, expectedCorrectionId, replacement, retryOf = null) => transaction(async () => {
      const current = store();
      const result = await current.appendCorrection({ id, targetId: 'confirmed-original', expectedCorrectionId, replacement,
        reason: 'Explicit server review', today: '2026-06-02', createdAt: '2026-06-02T12:01:00.000Z', actorId: 'synthetic-reviewer', retryOf });
      if (!result.replayed && result.event.status === 'accepted') {
        await query('DELETE FROM origin_test_facts WHERE budget_id = ?', [budgetId]);
        for (const row of result.plan.balances) await put(row);
      }
      await current.exportSnapshot();
      return result;
    });
    const first = await correct('server-review', null, { amount: 450, date: '2026-06-02' });
    assert.equal(first.event.status, 'accepted');
    assert.equal(first.plan.balances[0].running_balance_pln, 50);
    assert.equal((await correct('server-review', null, { amount: 450, date: '2026-06-02' })).replayed, true);
    assert.equal((await correct('server-void', 'server-review', null)).event.status, 'accepted');
    assert.deepEqual(await load(budgetId), []);
    assert.equal((await store().originalOneOffCounts()).get('source'), 1);
    assert.equal((await correct('server-restore', 'server-void', { amount: 500, date: '2026-06-02' })).event.status, 'accepted');
    assert.equal((await correct('server-blocked', 'server-restore', { amount: 600, date: '2026-06-02' })).event.status, 'blocked');
    assert.equal((await correct('server-retry', 'server-restore', { amount: 450, date: '2026-06-02' }, 'server-blocked')).event.status, 'accepted');
    await transaction(async () => {
      const stamp = '2026-06-02T12:02:00.000Z';
      const later = normalizeLedgerAuditFact({ id: 'later-income', name: 'Later accepted income', amount: 20, type: 'income',
        currency: 'PLN', ledger_currency: 'PLN', date: '2026-06-02', confirmed_date: '2026-06-02', ledger_year: 2026,
        fx_rate: 1, buffered_fx_rate: 1, ledger_amount: 20, running_balance_pln: 70,
        created_at: stamp, updated_at: stamp, occurrence_key: 'manual:later-income:income:2026-06-02' }, budgetId);
      await put(later);
      const current = store();
      await current.capturePayment({ paymentId: later.id, actorId: 'synthetic-later-writer', capturedAt: stamp });
      await current.exportSnapshot();
    });
    const exported = await store().exportSnapshot();
    assert.equal(exported.version, 2);
    assert.equal(exported.originals.length, 1);
    assert.equal(exported.originals[0].row.id, 'later-income');
    assert.equal(exported.originals[0].captureKind, 'payment');
    assert.equal(exported.lastSequence, 7);
    assert.equal(exported.corrections.length, 5);
    assert.deepEqual(exported.origin, audit.origin);
    assert.deepEqual((await query('SELECT * FROM cashflow_ledger_origins WHERE budget_id = ?', [budgetId]))[0], retained);
    await assert.rejects(transaction(() => store().restoreSnapshot(audit)), /empty destination/);

    const indexed = (await query('SELECT * FROM cashflow_ledger_originals WHERE budget_id = ? AND payment_id = ?', [budgetId, 'confirmed-original']))[0];
    const alteredIndex = JSON.parse(indexed.data_json);
    alteredIndex.row.amount = alteredIndex.row.ledger_amount = 399;
    await query('UPDATE cashflow_ledger_originals SET data_json = ?, record_hash = ? WHERE budget_id = ? AND payment_id = ?',
      [codec.encoded(alteredIndex), codec.digest(alteredIndex), budgetId, indexed.payment_id]);
    try { await assert.rejects(store().exportSnapshot(), /original index differs/); }
    finally { await query('UPDATE cashflow_ledger_originals SET data_json = ?, record_hash = ? WHERE budget_id = ? AND payment_id = ?',
      [indexed.data_json, indexed.record_hash, budgetId, indexed.payment_id]); }
    const disguised = JSON.parse(indexed.data_json);
    Object.assign(disguised, { version: 1, captureKind: 'payment', actorId: 'synthetic-forged-actor' });
    await query('UPDATE cashflow_ledger_originals SET data_json = ?, record_hash = ? WHERE budget_id = ? AND payment_id = ?',
      [codec.encoded(disguised), codec.digest(disguised), budgetId, indexed.payment_id]);
    try { await assert.rejects(store().original('confirmed-original'), /original index differs/); }
    finally { await query('UPDATE cashflow_ledger_originals SET data_json = ?, record_hash = ? WHERE budget_id = ? AND payment_id = ?',
      [indexed.data_json, indexed.record_hash, budgetId, indexed.payment_id]); }
    await assert.rejects(transaction(async () => {
      const current = store();
      await current.original('confirmed-original'); // cache the verified proof
      const changed = JSON.parse(retained.data_json); changed.openingBalance = 600;
      const json = JSON.stringify(changed);
      await query('UPDATE cashflow_ledger_origins SET data_json = ?, record_hash = ? WHERE budget_id = ?', [json, hash(json), budgetId]);
      await current.exportSnapshot();
    }), /changed within its owning transaction/);
    assert.deepEqual((await query('SELECT * FROM cashflow_ledger_origins WHERE budget_id = ?', [budgetId]))[0], retained);

    // SQL can report success after an ignored insert. A missing proof must
    // refuse the owning commit rather than publish an incomplete audit group.
    await raw(pool ? 'CREATE RULE ignore_origin_insert AS ON INSERT TO cashflow_ledger_origins DO INSTEAD NOTHING'
      : 'CREATE TRIGGER ignore_origin_insert BEFORE INSERT ON cashflow_ledger_origins BEGIN SELECT RAISE(IGNORE); END');
    const ignored = codec.copyLedgerAuditSnapshot(audit, 'ignored-origin');
    try { await assert.rejects(transaction(() => seed(ignored)), /origin evidence/); }
    finally { await raw(pool ? 'DROP RULE ignore_origin_insert ON cashflow_ledger_origins' : 'DROP TRIGGER ignore_origin_insert'); }
    assert.deepEqual(await load('ignored-origin'), []);
    assert.deepEqual(await query('SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = ?', ['ignored-origin']), []);
    await raw(pool ? 'CREATE RULE ignore_origin_index AS ON INSERT TO cashflow_ledger_originals DO INSTEAD NOTHING'
      : 'CREATE TRIGGER ignore_origin_index BEFORE INSERT ON cashflow_ledger_originals BEGIN SELECT RAISE(IGNORE); END');
    const ignoredIndex = codec.copyLedgerAuditSnapshot(audit, 'ignored-origin-index');
    try { await assert.rejects(transaction(() => seed(ignoredIndex)), /original index is missing/); }
    finally { await raw(pool ? 'DROP RULE ignore_origin_index ON cashflow_ledger_originals' : 'DROP TRIGGER ignore_origin_index'); }
    assert.deepEqual(await load('ignored-origin-index'), []);
    assert.deepEqual(await query('SELECT * FROM cashflow_ledger_origins WHERE budget_id = ?', ['ignored-origin-index']), []);
    const late = codec.copyLedgerAuditSnapshot(exported, 'late-failed-origin');
    await assert.rejects(transaction(async () => {
      await seed(late);
      await query('INSERT INTO origin_test_facts (budget_id, id, data_json) VALUES (?, ?, NULL)', ['late-failed-origin', 'injected-failure']);
    }));
    for (const table of ['origin_test_facts', 'cashflow_ledger_origins', 'cashflow_ledger_audit_state', 'cashflow_ledger_originals', 'cashflow_ledger_corrections']) {
      assert.deepEqual(await query(`SELECT * FROM ${table} WHERE budget_id = ?`, ['late-failed-origin']), []);
    }
    for (const coherentHash of [false, true]) {
      const changed = JSON.parse(retained.data_json); changed.events[0].row.ledger_amount = 1;
      const json = JSON.stringify(changed);
      await query('UPDATE cashflow_ledger_origins SET data_json = ?, record_hash = ? WHERE budget_id = ?', [json, coherentHash ? hash(json) : retained.record_hash, budgetId]);
      try { await assert.rejects(store().exportSnapshot()); }
      finally { await query('UPDATE cashflow_ledger_origins SET data_json = ?, record_hash = ? WHERE budget_id = ?', [retained.data_json, retained.record_hash, budgetId]); }
    }

    // No-payment signed openings especially need an independent state marker:
    // loss of the sole origin row must not export as a normal zero ledger.
    const empty = completeSnapshot();
    Object.assign(empty, { budgetId: 'local-empty-origin', name: 'Signed empty origin' });
    empty.request.tables.one_off_transactions = [];
    Object.assign(empty.request, { openingBalance: -50, today: '2026-06-02', generationTimestamp: '2026-06-02T12:00:00.000Z', idSeed: 'empty-origin' });
    const proof = refreshLocalSnapshot({ snapshot: empty, ...empty.request });
    const emptyAudit = { version: 2, budgetId: 'empty-origin-store', baselineComplete: true, lastSequence: 0,
      origin: standaloneLedgerOrigin(proof, empty.request.generationTimestamp), originals: [], corrections: [] };
    await transaction(() => seed(emptyAudit));
    if (!pool) assert.throws(() => readSqliteFinancialExportAudit(connection, emptyAudit.budgetId), /upgraded export host/);
    const emptyRow = (await query('SELECT * FROM cashflow_ledger_origins WHERE budget_id = ?', [emptyAudit.budgetId]))[0];
    await query('DELETE FROM cashflow_ledger_origins WHERE budget_id = ?', [emptyAudit.budgetId]);
    await assert.rejects(store(emptyAudit.budgetId).exportSnapshot(), /missing or unregistered/);
    await assert.rejects(store(emptyAudit.budgetId, false).exportSnapshot(), /upgraded host/);
    await query('INSERT INTO cashflow_ledger_origins (budget_id, data_json, record_hash) VALUES (?, ?, ?)', [emptyRow.budget_id, emptyRow.data_json, emptyRow.record_hash]);
    assert.deepEqual(await store(emptyAudit.budgetId).exportSnapshot(), emptyAudit);
    assert.deepEqual(await store().exportSnapshot(), exported);
  } finally {
    if (pool) {
      try { await raw('DROP TABLE IF EXISTS cashflow_ledger_origins, cashflow_ledger_corrections, cashflow_ledger_originals, cashflow_ledger_audit_state, origin_test_facts'); }
      finally { connection.release(); }
    } else { connection.close(); rmSync(directory, { recursive: true, force: true }); }
  }
}

test('SQLite origin-aware audit storage survives reopen, later corrections and rollback without losing signed openings', () => exercise());
test('PostgreSQL origin-aware audit storage retains proof and rolls back incomplete restores', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(({ pool }) => exercise(pool)));
