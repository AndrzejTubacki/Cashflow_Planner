import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { copyLedgerAuditSnapshot, createLedgerAuditStore, LEDGER_AUDIT_SCHEMA, replayLedgerAuditSnapshot } from '../../src/server/cashflow-ledger-audit-store.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const budgetId = 'owned-budget';
const capturedAt = '2026-10-23T10:00:00.000Z';
/** Normalized facts deliberately predate review by several years. */
function fact(id, amount, type, date, extra = {}) {
  return { id, budget_id: budgetId, name: id, amount, type, date, confirmed_date: date,
    currency: 'PLN', ledger_currency: 'PLN', fx_rate: 1, buffered_fx_rate: 1,
    ledger_amount: amount, ledger_year: Number(date.slice(0, 4)), occurrence_key: `manual:${id}:${type}:${date}`,
    created_at: `${date}T12:00:00.000Z`, updated_at: `${date}T12:00:00.000Z`, ...extra };
}
const income = fact('income', 500, 'income', '2018-12-30');
const expense = fact('expense', 400, 'expense', '2019-01-02');
function request(id, extra = {}) {
  return { id, targetId: income.id, expectedCorrectionId: null,
    replacement: { amount: 200, date: income.date }, reason: 'Review actual receipt',
    today: '2026-10-23', createdAt: capturedAt, actorId: 'reviewer', ...extra };
}
/** A checksum is reproducible by an importer and must not confer authority. */
function recordHash(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Each fixture owns its files or disposable database connection. The small
 * facts table models the host's transaction-bound normalized ledger adapter;
 * this is storage acceptance, not a claim that runtime writers are integrated. */
async function fixture(backend, body) {
  const run = async pool => {
    const directory = pool ? null : mkdtempSync(join(tmpdir(), 'cashflow-audit-test-'));
    let connection = pool ? await pool.connect() : new Database(join(directory, 'ledger.sqlite'));
    const raw = sql => pool ? connection.query(sql) : connection.exec(sql);
    const query = async (sql, parameters = []) => {
      if (pool) {
        let index = 0;
        return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), parameters)).rows;
      }
      const statement = connection.prepare(sql);
      return statement.reader ? statement.all(...parameters) : (statement.run(...parameters), []);
    };
    const reopen = async () => {
      if (pool) { connection.release(); connection = await pool.connect(); }
      else { connection.close(); connection = new Database(join(directory, 'ledger.sqlite')); connection.pragma('foreign_keys = ON'); }
    };
    const transaction = async action => {
      await raw('BEGIN');
      try { const result = await action(); await raw('COMMIT'); return result; }
      catch (error) { await raw('ROLLBACK'); throw error; }
    };
    const put = row => query(`INSERT INTO audit_test_facts (budget_id, id, data_json) VALUES (?, ?, ?)
      ON CONFLICT (budget_id, id) DO UPDATE SET data_json = excluded.data_json`, [row.budget_id, row.id, JSON.stringify(row)]);
    const load = async (scope = budgetId) => (await query('SELECT data_json FROM audit_test_facts WHERE budget_id = ? ORDER BY id', [scope]))
      .map(row => JSON.parse(row.data_json));
    const store = (scope = budgetId) => createLedgerAuditStore({ budgetId: scope, query, loadEffectiveRows: () => load(scope) });
    const apply = async result => {
      if (result.replayed || result.event.status !== 'accepted') return;
      await query('DELETE FROM audit_test_facts WHERE budget_id = ? AND id = ?', [budgetId, result.event.targetId]);
      for (const row of result.plan.balances) await put({ ...row, budget_id: budgetId });
    };
    const correct = input => transaction(async () => {
      const result = await store().appendCorrection(input); await apply(result); return result;
    });
    try {
      if (!pool) connection.pragma('foreign_keys = ON');
      await raw(`${LEDGER_AUDIT_SCHEMA}
        CREATE TABLE audit_test_facts (budget_id TEXT NOT NULL, id TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY (budget_id, id));`);
      await put(income); await put(expense);
      await transaction(() => store().ensureLegacyBaseline({ capturedAt }));
      await body({ query, transaction, put, load, store, correct, apply, reopen });
    } finally {
      if (pool) {
        try { await raw('DROP TABLE IF EXISTS cashflow_ledger_corrections, cashflow_ledger_originals, cashflow_ledger_audit_state, audit_test_facts'); }
        finally { connection.release(); }
      } else { connection.close(); rmSync(directory, { recursive: true, force: true }); }
    }
  };
  return backend === 'postgres' ? withDisposablePostgresDb(({ pool }) => run(pool)) : run(null);
}

for (const backend of ['sqlite', 'postgres']) {
  const options = { skip: backend === 'postgres' && !postgresRuntimeTestsEnabled() };
  test(`${backend}: complete audit histories larger than one record retain their snapshot allowance`, options, () => fixture(backend, async f => {
    const scope = 'large-audit-aggregate';
    const accepted = Array.from({ length: 4000 }, (_, index) => fact(`synthetic-income-${String(index).padStart(4, '0')}`, 1,
      'income', '2020-01-01', { budget_id: scope }));
    assert.ok(Buffer.byteLength(JSON.stringify(accepted)) > 1024 * 1024);
    await f.transaction(async () => {
      for (const row of accepted) await f.put(row);
      await f.store(scope).ensureLegacyBaseline({ capturedAt });
    });
    const snapshot = await f.store(scope).exportSnapshot();
    assert.equal(snapshot.originals.length, accepted.length);
    const destination = 'large-audit-restored';
    const independent = copyLedgerAuditSnapshot(snapshot, destination);
    await f.transaction(async () => {
      for (const row of accepted) await f.put({ ...row, budget_id: destination });
      await f.store(destination).restoreSnapshot(independent);
    });
    assert.deepEqual(await f.store(destination).exportSnapshot(), independent);
  }));
  test(`${backend}: independent audit copy re-scopes captured source and plan without mutating provenance`, options, () => fixture(backend, async f => {
    const payment = fact('captured', 10, 'expense', '2026-01-01', { source_one_off_id: 'source' });
    const source = { table: 'one_off_transactions', row: { id: 'source', budget_id: budgetId,
      currency: 'PLN', type: 'expense', planned_transaction_id: 'plan' },
    plan: { id: 'plan', budget_id: budgetId, name: 'Accepted plan' } };
    await f.transaction(async () => {
      await f.put(payment);
      await f.store().capturePayment({ paymentId: payment.id, actorId: 'original-writer', capturedAt, sourceAtAcceptance: source });
    });
    await f.correct(request('correct-captured', { targetId: payment.id, replacement: { amount: 9, date: payment.date } }));
    const snapshot = await f.store().exportSnapshot();
    const before = structuredClone(snapshot);
    const copy = copyLedgerAuditSnapshot(snapshot, 'separate-budget');
    assert.deepEqual(snapshot, before);
    const copied = copy.originals.find(item => item.row.id === payment.id);
    assert.equal(copied.sourceAtAcceptance.row.budget_id, 'separate-budget');
    assert.equal(copied.sourceAtAcceptance.plan.budget_id, 'separate-budget');
    assert.equal(copied.actorId, 'original-writer');
    assert.equal(copied.capturedAt, capturedAt);
    assert.equal(copy.corrections[0].requestHash, snapshot.corrections[0].requestHash);
    assert.notEqual(copy.corrections[0].originalHash, snapshot.corrections[0].originalHash);
    assert.equal(replayLedgerAuditSnapshot(copy, 'separate-budget').rows.find(row => row.id === payment.id).amount, 9);
    const damaged = structuredClone(snapshot); damaged.corrections[0].after.amount = 8;
    assert.throws(() => copyLedgerAuditSnapshot(damaged, 'separate-budget'));
  }));
  test(`${backend}: immutable legacy originals survive restart and repeated baseline`, options, () => fixture(backend, async f => {
    const before = await f.store().originals();
    assert.equal(before.length, 2);
    assert.ok(before.every(row => row.sourceAtAcceptance === null && row.actorId === null && row.captureKind === 'legacy'));
    await f.reopen();
    await f.transaction(() => f.store().ensureLegacyBaseline({ capturedAt: '2026-10-24T10:00:00Z' }));
    assert.deepEqual(await f.store().originals(), before);
    await f.put(fact('untracked', 1, 'income', '2020-01-01'));
    await assert.rejects(f.transaction(() => f.store().ensureLegacyBaseline({ capturedAt })), /no retained original/);
    assert.equal((await f.store().originals()).length, 2);
  }));

  test(`${backend}: capture reads the accepted ledger and retains scoped source evidence`, options, () => fixture(backend, async f => {
    const payment = fact('new', 10, 'expense', '2026-01-01', { source_one_off_id: 'source' });
    const source = { table: 'one_off_transactions', row: { id: 'source', budget_id: budgetId, currency: 'PLN', type: 'expense' } };
    const capture = extra => f.store().capturePayment({ paymentId: payment.id, actorId: 'writer', capturedAt, sourceAtAcceptance: source, ...extra });
    await assert.rejects(f.transaction(() => capture()), /missing from its owning ledger/);
    await f.transaction(async () => { await f.put(payment); assert.equal((await capture()).replayed, false); });
    await f.reopen();
    assert.equal((await f.transaction(() => capture())).replayed, true);
    assert.deepEqual((await f.store().original(payment.id)).sourceAtAcceptance, source);
    for (const changed of [null, { ...source, row: { ...source.row, budget_id: 'foreign' } },
      { ...source, row: null }, { ...source, plan: {} }, { ...source, row: { ...source.row, planned_transaction_id: 'missing-plan' } },
      { ...source, row: { ...source.row, id: 'foreign-source' } }, { ...source, row: { ...source.row, type: 'income' } }]) {
      await assert.rejects(f.transaction(() => capture({ sourceAtAcceptance: changed })));
    }
    await assert.rejects(f.transaction(() => capture({ actorId: 'different-writer' })), /immutable/);
    await f.put({ ...payment, amount: 11, ledger_amount: 11 });
    await assert.rejects(f.transaction(() => capture()), /immutable/);
    assert.equal((await f.store().original(payment.id)).row.amount, 10);
  }));

  test(`${backend}: blocked work is durable; explicit dependency resolution and new retry preserve its history`, options, () => fixture(backend, async f => {
    const originals = await f.store().originals();
    const blocked = await f.correct(request('blocked'));
    assert.equal(blocked.event.status, 'blocked');
    assert.equal(blocked.event.failureCode, 'history_overdraft');
    assert.deepEqual(blocked.event.blockingIds, [expense.id]);
    assert.deepEqual(blocked.event.requested, request('blocked').replacement);
    assert.equal((await f.load()).find(row => row.id === income.id).amount, 500);
    await f.reopen();
    assert.deepEqual(await f.store().corrections(income.id), [blocked.event]);
    const dependent = await f.correct(request('resolve-expense', { targetId: expense.id, replacement: { amount: 100, date: expense.date } }));
    assert.equal(dependent.event.status, 'accepted');
    const replay = await f.correct(request('blocked', { today: '2026-10-24', createdAt: '2026-10-24T10:00:00Z' }));
    assert.equal(replay.replayed, true); assert.equal(replay.plan, null);
    assert.deepEqual(replay.event, blocked.event);
    const retry = await f.correct(request('retry', { retryOf: 'blocked' }));
    assert.equal(retry.event.status, 'accepted'); assert.equal(retry.event.previousAcceptedId, null);
    assert.deepEqual(retry.plan.balances.map(row => row.running_balance_pln), [200, 100]);
    await assert.rejects(f.correct(request('duplicate-review', { retryOf: 'blocked', expectedCorrectionId: 'retry' })), /already reviewed/);
    assert.deepEqual(await f.store().originals(), originals);
    await f.reopen();
    assert.deepEqual((await f.store().corrections()).map(row => row.id), ['blocked', 'resolve-expense', 'retry']);
    assert.equal((await f.load()).find(row => row.id === income.id).amount, 200);
  }));

  test(`${backend}: event identity, reviewed head, target and budget scope are enforced`, options, () => fixture(backend, async f => {
    const accepted = request('accepted', { replacement: { amount: 450, date: income.date } });
    assert.equal((await f.correct(accepted)).event.status, 'accepted');
    for (const extra of [{ actorId: 'someone-else' }, { reason: 'different' }, { targetId: expense.id },
      { replacement: { amount: 460, date: income.date } }]) {
      await assert.rejects(f.correct({ ...accepted, ...extra }), /identity reused/);
    }
    await assert.rejects(f.correct(request('stale')), /review its current history/);
    await assert.rejects(f.correct(request('missing', { targetId: 'foreign-payment' })), /no original audit evidence/);
    await assert.rejects(f.correct(request('foreign-retry', { targetId: expense.id, retryOf: 'accepted' })), /missing, foreign/);
    await assert.rejects(f.correct({ ...request('injected'), rows: [] }), /Unsupported correction request fields/);
    assert.equal(await f.store('other-budget').original(income.id), null);
    assert.deepEqual(await f.store('other-budget').corrections(), []);
    assert.equal((await f.store().original(income.id)).row.amount, 500);
    assert.equal((await f.load()).find(row => row.id === income.id).amount, 450);
  }));

  test(`${backend}: void and restore retain original identity and installment count`, options, () => fixture(backend, async f => {
    const payment = fact('installment', 10, 'expense', '2020-01-01', { source_one_off_id: 'installment-source' });
    await f.transaction(async () => {
      await f.put(payment);
      await f.store().capturePayment({ paymentId: payment.id, actorId: 'writer', capturedAt,
        sourceAtAcceptance: { table: 'one_off_transactions', row: { id: 'installment-source', type: 'expense', currency: 'PLN' } } });
    });
    await f.correct(request('void', { targetId: payment.id, replacement: null }));
    assert.ok(!(await f.load()).some(row => row.id === payment.id));
    assert.equal((await f.store().originalOneOffCounts()).get('installment-source'), 1);
    const restored = await f.correct(request('restore', { targetId: payment.id, expectedCorrectionId: 'void',
      replacement: { amount: 20, date: '2021-01-02' } }));
    assert.equal(restored.event.after.id, payment.id);
    assert.equal(restored.event.after.occurrence_key, payment.occurrence_key);
    assert.equal(restored.event.after.ledger_year, 2021);
    assert.deepEqual((await f.store().original(payment.id)).row, payment);
    assert.equal((await f.store().originalOneOffCounts()).get('installment-source'), 1);
  }));

  test(`${backend}: audit, money and sequence roll back together on host failure`, options, () => fixture(backend, async f => {
    const before = await f.load();
    const sequenceBefore = await f.query('SELECT last_sequence FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]);
    await assert.rejects(f.transaction(async () => {
      const result = await f.store().appendCorrection(request('atomic', { replacement: { amount: 450, date: income.date } }));
      await f.apply(result);
      throw new Error('injected owning-transaction failure');
    }), /injected owning/);
    await f.reopen();
    assert.deepEqual(await f.load(), before);
    assert.deepEqual(await f.store().corrections(), []);
    assert.deepEqual(await f.query('SELECT last_sequence FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]), sequenceBefore);
    assert.equal((await f.correct(request('atomic', { replacement: { amount: 450, date: income.date } }))).event.status, 'accepted');
  }));

  test(`${backend}: damaged immutable evidence fails closed`, options, () => fixture(backend, async f => {
    await f.query('UPDATE cashflow_ledger_originals SET data_json = ? WHERE budget_id = ? AND payment_id = ?', ['{}', budgetId, income.id]);
    await assert.rejects(f.store().original(income.id), /differs from its retained record/);
    await assert.rejects(f.correct(request('damaged')), /differs from its retained record/);
    assert.deepEqual(await f.store().corrections(), []);
  }));

  test(`${backend}: untracked changes cannot become correction authority`, options, () => fixture(backend, async f => {
    await f.put({ ...expense, amount: 100, ledger_amount: 100 });
    await assert.rejects(f.correct(request('changed-fact')), /differs from its retained audit/);
    await f.put(expense);
    await f.put(fact('untracked', 20, 'income', '2020-01-01'));
    await assert.rejects(f.correct(request('untracked-fact')), /no retained original/);
    await f.query('DELETE FROM audit_test_facts WHERE budget_id = ? AND id = ?', [budgetId, 'untracked']);
    await f.query('DELETE FROM audit_test_facts WHERE budget_id = ? AND id = ?', [budgetId, expense.id]);
    await assert.rejects(f.correct(request('missing-fact')), /differs from its retained audit/);
    assert.deepEqual(await f.store().corrections(), []);
  }));

  test(`${backend}: portable snapshot replays blocked, retried, voided and restored history across new payments`, options, () => fixture(backend, async f => {
    await f.correct(request('blocked'));
    await f.correct(request('resolved', { targetId: expense.id, replacement: { amount: 100, date: expense.date } }));
    await f.correct(request('retry', { retryOf: 'blocked' }));
    const extra = fact('later-payment', 20, 'income', '2026-01-01');
    await f.transaction(async () => {
      await f.put(extra);
      await f.store().capturePayment({ paymentId: extra.id, actorId: 'writer', capturedAt });
    });
    await f.correct(request('void', { targetId: expense.id, expectedCorrectionId: 'resolved', replacement: null }));
    await f.correct(request('restore', { targetId: expense.id, expectedCorrectionId: 'void', replacement: { amount: 50, date: '2020-01-01' } }));
    await f.reopen();
    const snapshot = await f.store().exportSnapshot();
    const replayed = replayLedgerAuditSnapshot(JSON.parse(JSON.stringify(snapshot)), budgetId);
    const withoutBalance = row => { const result = { ...row }; delete result.running_balance_pln; return result; };
    const sorted = rows => rows.sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(sorted(replayed.rows), sorted((await f.load()).map(withoutBalance)));
    assert.equal(replayed.heads.get(income.id), 'retry');
    assert.equal(replayed.heads.get(expense.id), 'restore');
    assert.equal(replayed.originals.get(income.id).row.amount, 500);
    assert.equal(replayed.corrections.get('blocked').status, 'blocked');
    assert.equal(snapshot.lastSequence, 8);
    replayed.rows[0].amount = 999;
    replayed.originals.get(income.id).row.amount = 999;
    assert.equal(snapshot.originals.find(row => row.row.id === income.id).row.amount, 500);
    assert.deepEqual(await f.store().exportSnapshot(), snapshot);
  }));

  test(`${backend}: snapshot replay rejects forged outcomes, scope, chains and unknown fields`, options, () => fixture(backend, async f => {
    await f.correct(request('blocked'));
    const snapshot = await f.store().exportSnapshot();
    const forged = mutate => { const value = structuredClone(snapshot); mutate(value); return value; };
    const mutations = [
      s => { s.version = 2; }, s => { s.budgetId = 'foreign'; }, s => { s.baselineComplete = false; },
      s => { s.lastSequence++; }, s => { s.unknown = true; }, s => { s.originals.pop(); s.lastSequence--; },
      s => { s.originals[1].sequence = 1; }, s => { s.originals[0].budgetId = 'foreign'; },
      s => { s.originals[0].row.budget_id = 'foreign'; }, s => { s.originals[0].row.running_balance_pln = 400; },
      s => { s.originals[0].actorId = 'invented-legacy-actor'; },
      s => { s.originals[0].row.ledger_year += 1; },
      s => { s.originals[0].row.created_at = '2018-12-30T24:00:00.000Z'; },
      s => { s.originals[0].row.updated_at = '2018-02-30T12:00:00.000Z'; },

      s => { s.originals[0].captureKind = 'payment'; s.originals[0].actorId = 'writer'; },
      s => { s.originals[0].sourceAtAcceptance = { table: 'goals', row: { id: 'invented' } }; },
      s => { s.corrections[0].status = 'accepted'; }, s => { s.corrections[0].failureCode = null; },
      s => { s.corrections[0].blockingIds = []; }, s => { s.corrections[0].before.amount = 999; },
      s => { s.corrections[0].originalHash = 'invented'; }, s => { s.corrections[0].previousAcceptedId = 'invented'; },
      s => { s.corrections[0].retryOf = 'missing'; }, s => { s.corrections[0].extra = 'silently-lost'; },
      s => { s.corrections[0].createdAt = '2026-02-30T10:00:00Z'; },
      s => { s.corrections.push({ ...s.corrections[0], sequence: 4 }); s.lastSequence++; },
      s => { s.corrections[0].requested.amount = 450; s.corrections[0].requestHash = recordHash({ targetId: income.id,
        expectedCorrectionId: null, replacement: s.corrections[0].requested, reason: s.corrections[0].reason, actorId: 'reviewer', retryOf: null }); }
    ];
    for (const mutate of mutations) assert.throws(() => replayLedgerAuditSnapshot(forged(mutate), budgetId));
    assert.throws(() => replayLedgerAuditSnapshot(snapshot, 'foreign'));
    assert.throws(() => replayLedgerAuditSnapshot({ ...snapshot, originals: Array(200001).fill(snapshot.originals[0]), corrections: [], lastSequence: 200001 }, budgetId), /Complete scoped/);
    assert.throws(() => replayLedgerAuditSnapshot(forged(s => { s.originals[0].row.name = 'x'.repeat(1024 * 1024); }), budgetId), /too large/);
  }));

  test(`${backend}: recomputed storage checksums cannot turn blocked work into accepted money`, options, () => fixture(backend, async f => {
    const blocked = await f.correct(request('blocked'));
    const forged = { ...blocked.event, status: 'accepted', failureCode: null, blockingIds: [],
      after: { ...income, amount: 200, ledger_amount: 200, updated_at: capturedAt } };
    await f.query('UPDATE cashflow_ledger_corrections SET status = ?, data_json = ?, record_hash = ? WHERE budget_id = ? AND id = ?',
      ['accepted', JSON.stringify(forged), recordHash(forged), budgetId, 'blocked']);
    await assert.rejects(f.store().exportSnapshot(), /differs from financial replay/);
    assert.equal((await f.load()).find(row => row.id === income.id).amount, 500);
  }));

  test(`${backend}: surviving legacy installment ordinals are never recycled after history gaps`, options, () => fixture(backend, async f => {
    const legacyBudget = 'legacy-gap-budget';
    const surviving = fact('fifth-installment', 10, 'income', '2019-01-01', { budget_id: legacyBudget,
      source_one_off_id: 'legacy-source', occurrence_key: 'one_off_remainder:legacy-source:5' });
    await f.put(surviving);
    await f.transaction(() => f.store(legacyBudget).ensureLegacyBaseline({ capturedAt }));
    assert.equal((await f.store(legacyBudget).originalOneOffCounts()).get('legacy-source'), 5);
    const original = await f.store(legacyBudget).original(surviving.id);
    assert.equal(original.sourceAtAcceptance, null);
    assert.equal(original.captureKind, 'legacy');
    assert.equal((await f.store(legacyBudget).originals()).length, 1);
    assert.equal((await f.store(legacyBudget).exportSnapshot()).lastSequence, 1);
  }));

  test(`${backend}: restore preserves blocked work, immutable originals and next sequence atomically`, options, () => fixture(backend, async f => {
    await f.correct(request('blocked'));
    await f.correct(request('resolved', { targetId: expense.id, replacement: null }));
    const snapshot = await f.store().exportSnapshot();
    const effective = await f.load();
    await assert.rejects(f.transaction(() => f.store().restoreSnapshot(snapshot)), /empty destination/);
    // Model the host's explicitly selected whole-budget restore: only the
    // synthetic owning budget is cleared. The store itself offers no delete.
    const clear = async () => {
      await f.query('DELETE FROM cashflow_ledger_corrections WHERE budget_id = ?', [budgetId]);
      await f.query('DELETE FROM cashflow_ledger_originals WHERE budget_id = ?', [budgetId]);
      await f.query('DELETE FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]);
    };
    await f.transaction(clear);
    await assert.rejects(f.transaction(async () => {
      await f.store().restoreSnapshot(snapshot);
      throw new Error('injected restore failure');
    }), /injected restore failure/);
    await f.reopen();
    assert.equal((await f.store().originals()).length, 0);
    assert.equal((await f.store().corrections()).length, 0);
    assert.deepEqual(await f.load(), effective);
    assert.deepEqual(await f.query('SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]), []);
    await f.transaction(() => f.store().restoreSnapshot(JSON.parse(JSON.stringify(snapshot))));
    await f.reopen();
    assert.deepEqual(await f.store().exportSnapshot(), snapshot);
    const replay = await f.correct(request('blocked'));
    assert.equal(replay.replayed, true); assert.equal(replay.plan, null); assert.equal(replay.event.status, 'blocked');
    const retry = await f.correct(request('retry-after-restore', { retryOf: 'blocked' }));
    assert.equal(retry.event.status, 'accepted');
    assert.equal(retry.event.sequence, snapshot.lastSequence + 1);
    assert.equal((await f.store().original(income.id)).row.amount, 500);
    assert.equal((await f.store().original(expense.id)).row.amount, 400);
  }));

  test(`${backend}: restore refuses mismatched effective facts and foreign scope without writes`, options, () => fixture(backend, async f => {
    const snapshot = await f.store().exportSnapshot();
    await f.query('DELETE FROM cashflow_ledger_originals WHERE budget_id = ?', [budgetId]);
    await f.query('DELETE FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]);
    const assertEmpty = async () => {
      assert.deepEqual(await f.query('SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]), []);
      assert.deepEqual(await f.store().originals(), []);
      assert.deepEqual(await f.store().corrections(), []);
    };
    await assert.rejects(f.transaction(() => f.store('foreign').restoreSnapshot(snapshot)), /Complete scoped/);
    await assertEmpty();
    await f.put({ ...expense, amount: 1, ledger_amount: 1 });
    await assert.rejects(f.transaction(() => f.store().restoreSnapshot(snapshot)), /Restored ledger differs/);
    await assertEmpty();
    await f.put(expense);
    const damaged = structuredClone(snapshot); damaged.originals[0].sequence = 100;
    await assert.rejects(f.transaction(() => f.store().restoreSnapshot(damaged)), /Incomplete or foreign/);
    await assertEmpty();
    await f.transaction(() => f.store().restoreSnapshot(snapshot));
    assert.deepEqual(await f.store().exportSnapshot(), snapshot);
  }));
}
