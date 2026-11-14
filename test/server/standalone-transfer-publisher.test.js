import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { withStandaloneTransferPublisherFixture } from '../helpers/standalone-transfer-publisher-fixture.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { standaloneTransferDestination } from '../../src/server/cashflow-standalone-transfer-record.js';
import { createCashflowGlobalDbService } from '../../src/server/cashflow-global-db-service.js';
import Database from 'better-sqlite3';
import { createStandaloneTransferHttpHost } from '../../src/server/cashflow-standalone-transfer-http.js';
import { appSyncCapabilities } from '../../src/server/cashflow-app-sync-contract.js';

/** Observe actual stored ownership, grant and financial proof after commit,
 * rather than accepting the publisher's success response as evidence. */
async function accepted(f, input, receipt) {
  assert.equal(receipt.state, 'accepted');
  const budgetId = standaloneTransferDestination(input);
  assert.equal(receipt.budgetId, budgetId);
  assert.equal((await f.sql('SELECT display_name FROM budgets WHERE id = ?', [budgetId]))[0].display_name, input.name);
  assert.equal((await f.sql('SELECT role FROM budget_memberships WHERE budget_id = ? AND account_id = ?', [budgetId, input.accountId]))[0].role, 'owner');
  const state = JSON.parse((await f.sql('SELECT state_json FROM app_devices WHERE id = ?', [input.deviceId]))[0].state_json);
  assert.ok(state.budgetIds.includes(budgetId)); assert.ok(state.writeBudgetIds.includes(budgetId));
  assert.equal((await f.budget.listConfirmedTransactions(budgetId))[0].running_balance_pln, 100);
  const audit = await f.budget.exportLedgerAuditSnapshot(budgetId);
  assert.deepEqual(audit.origin.events, JSON.parse(input.sourceJson).localAudit);
  assert.equal(audit.origin.openingBalance, 500);
  assert.equal((await f.sql("SELECT count(*) AS n FROM budgets WHERE id <> 'transfer-existing'"))[0].n, f.budget.backend === 'postgres' ? '1' : 1);
}

async function exercise(f) {
  const input = f.input(), source = input.sourceJson;
  const publisher = f.publisher();
  assert.equal(await publisher.lookup(f.tokens.accessToken, f.lookup(input)), null);
  const receipt = await publisher.submit(f.tokens.accessToken, input);
  await accepted(f, input, receipt);
  f.advance(60000);
  const reopened = f.publisher();
  assert.deepEqual(await reopened.lookup(f.tokens.accessToken, f.lookup(input)), receipt);
  const details = await reopened.result(f.tokens.accessToken, f.lookup(input));
  assert.deepEqual(details.receipt, receipt);
  assert.equal(details.grant.deviceId, input.deviceId);
  assert.ok(details.grant.writeBudgetIds.includes(receipt.budgetId));
  assert.equal(Object.hasOwn(details.grant, 'accessToken'), false);
  const results = await Promise.all([reopened.submit(f.tokens.accessToken, input), reopened.submit(f.tokens.accessToken, input)]);
  assert.deepEqual(results, [receipt, receipt]);
  await accepted(f, input, receipt);
  for (const change of [{ name: 'Changed name' }, { sourceJson: `${source} ` }]) {
    await assert.rejects(reopened.submit(f.tokens.accessToken, { ...input, ...change }), { code: 'TRANSFER_ID_REUSED' });
  }
  assert.equal(input.sourceJson, source);
  assert.equal(f.logs.filter(row => row.kind === 'cashflow_standalone_transfer_accepted').length, 1);
}

test('SQLite publishes retained finances, ownership, device grant and one immutable transfer outcome', () => withStandaloneTransferPublisherFixture(exercise));
test('PostgreSQL publishes retained finances, ownership, device grant and one immutable transfer outcome', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(({ databaseUrl }) => withStandaloneTransferPublisherFixture(exercise, databaseUrl)));

async function failureJourneys(f) {
  for (const phase of ['afterFinancial', 'afterMetadata', 'afterGrant', 'afterRecord']) {
    const input = f.input(), budgetId = standaloneTransferDestination(input);
    const original = (await f.sql('SELECT state_json FROM app_devices WHERE id = ?', [input.deviceId]))[0].state_json;
    await assert.rejects(f.publisher({ [phase]: () => { throw new Error(`Injected ${phase}`); } }).submit(f.tokens.accessToken, input), /Injected/);
    assert.deepEqual(await f.sql('SELECT id FROM budgets WHERE id = ?', [budgetId]), []);
    assert.equal((await f.sql('SELECT state_json FROM app_devices WHERE id = ?', [input.deviceId]))[0].state_json, original);
    assert.equal((await f.publisher().lookup(f.tokens.accessToken, f.lookup(input))).state, 'reserved');
    // A recreated host retries the frozen original input. SQLite may recover
    // durable unpublished files; PG must have rolled its financial rows back.
    f.advance(1000);
    const receipt = await f.publisher().submit(f.tokens.accessToken, input);
    assert.equal(receipt.state, 'accepted');
    assert.equal((await f.budget.listConfirmedTransactions(budgetId))[0].running_balance_pln, 100);
  }
  const lost = f.input();
  await assert.rejects(f.publisher({ afterCommit: () => { throw new Error('Injected lost acknowledgement'); } }).submit(f.tokens.accessToken, lost), /lost acknowledgement/);
  const recovered = await f.publisher().lookup(f.tokens.accessToken, f.lookup(lost));
  assert.equal(recovered.state, 'accepted');
  assert.deepEqual(await f.publisher().submit(f.tokens.accessToken, lost), recovered);
}
test('SQLite recovers interrupted private/metadata/grant/receipt publication and a lost acknowledgement', () => withStandaloneTransferPublisherFixture(failureJourneys));
test('PostgreSQL rolls back interrupted publication and recovers a lost acknowledgement', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(({ databaseUrl }) => withStandaloneTransferPublisherFixture(failureJourneys, databaseUrl)));

async function refusals(f) {
  const input = f.input();
  const noCreate = await f.enroll(false);
  await assert.rejects(f.publisher().submit(noCreate.accessToken, input));
  const altered = JSON.parse(input.sourceJson); altered.localHistory[0].amount = 1;
  await assert.rejects(f.publisher().submit(f.tokens.accessToken, { ...input, sourceJson: JSON.stringify(altered) }));
  assert.equal(await f.publisher().lookup(f.tokens.accessToken, f.lookup(input)), null);
  // Revocation after reservation, before owning publication, must leave only a
  // recoverable reservation; no budget, membership or grant may be published.
  const original = (await f.sql('SELECT state_json FROM app_devices WHERE id = ?', [input.deviceId]))[0].state_json;
  await assert.rejects(f.publisher({ afterReservation: () => f.sql('UPDATE app_devices SET state_json = ? WHERE id = ?',
    [JSON.stringify({ ...JSON.parse(original), mayCreateBudgets: false }), input.deviceId]) }).submit(f.tokens.accessToken, input));
  assert.deepEqual(await f.sql('SELECT id FROM budgets WHERE id = ?', [standaloneTransferDestination(input)]), []);
  await f.sql('UPDATE app_devices SET state_json = ? WHERE id = ?', [original, input.deviceId]);
  const receipt = await f.publisher().submit(f.tokens.accessToken, input);
  assert.equal(receipt.state, 'accepted');
}
test('SQLite refuses unapproved, altered or revoked transfer work without publishing a budget', () => withStandaloneTransferPublisherFixture(refusals));
test('PostgreSQL refuses unapproved, altered or revoked transfer work without publishing a budget', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(({ databaseUrl }) => withStandaloneTransferPublisherFixture(refusals, databaseUrl)));

test('SQLite seals survive rename interruption and cannot enroll an orphan as a legacy account', () => withStandaloneTransferPublisherFixture(async f => {
  const input = f.input(), budgetId = standaloneTransferDestination(input);
  await assert.rejects(f.publisher({ afterRename: () => { throw new Error('Injected after rename'); } }).submit(f.tokens.accessToken, input), /Injected/);
  const target = path.join(f.dataDir, budgetId);
  const seal = JSON.parse(fs.readFileSync(path.join(target, 'standalone-transfer.json'), 'utf8'));
  assert.deepEqual(await f.sql('SELECT id FROM budgets WHERE id = ?', [budgetId]), []);
  f.advance(60000);
  const receipt = await f.publisher().submit(f.tokens.accessToken, input);
  assert.deepEqual(receipt, seal.receipt);
  await accepted(f, input, receipt);
  // Missing global metadata must never invent a different legacy account from
  // a sealed transfer directory. Existing financial bytes remain untouched.
  const planning = path.join(target, 'planning.sqlite');
  const hash = () => createHash('sha256').update(fs.readFileSync(planning)).digest('hex');
  const previousHash = hash();
  assert.ok(f.paths.listCashflowUserIds().includes(budgetId));
  fs.renameSync(path.join(f.dataDir, 'cashflow-global.sqlite'), path.join(f.dataDir, 'saved-global.sqlite'));
  const fresh = createCashflowGlobalDbService({ dataDir: f.dataDir, listCashflowUserIds: f.paths.listCashflowUserIds });
  const connection = fresh.openGlobalDb();
  try {
    assert.deepEqual(connection.prepare('SELECT id FROM accounts WHERE id = ?').all(budgetId), []);
    assert.deepEqual(connection.prepare('SELECT id FROM budgets WHERE id = ?').all(budgetId), []);
    // Ordinary folders also stay unclaimed when their real account metadata is missing.
    assert.equal(connection.prepare("SELECT id FROM budgets WHERE id = 'transfer-existing'").get(), undefined);
    assert.deepEqual(connection.prepare('SELECT id FROM accounts').all(), []);
  } finally { connection.close(); }
  assert.equal(hash(), previousHash);
}));

for (const phase of ['afterFinancial', 'afterFilesReady', 'afterRename', 'afterCommit']) {
  test(`SQLite resumes the same transfer after actual process death at ${phase}`, { timeout: 20000 }, async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'cashflow-transfer-publisher-'));
    const child = fork(new URL('../helpers/standalone-transfer-crash-child.mjs', import.meta.url), [dataDir, phase],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    const exited = once(child, 'exit');
    let timer;
    try {
      const ready = await Promise.race([
        once(child, 'message').then(([message]) => message),
        exited.then(() => { throw new Error('Owned crash fixture exited before reaching its barrier'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned crash fixture barrier timed out')), 10000); })
      ]);
      assert.equal(ready.phase, phase);
      child.kill('SIGKILL');
      const [, signal] = await exited;
      assert.equal(signal, 'SIGKILL');
      await withStandaloneTransferPublisherFixture(async f => {
        const receipt = await f.publisher().submit(f.tokens.accessToken, ready.input);
        await accepted(f, ready.input, receipt);
        const seal = JSON.parse(fs.readFileSync(path.join(dataDir, receipt.budgetId, 'standalone-transfer.json'), 'utf8'));
        assert.deepEqual(receipt, seal.receipt);
        assert.deepEqual(await f.publisher().lookup(f.tokens.accessToken, f.lookup(ready.input)), receipt);
      }, null, { dataDir, tokens: ready.tokens });
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

async function ignoredWrites(f) {
  for (const table of ['app_devices', 'cashflow_standalone_transfers']) {
    const input = f.input(), budgetId = standaloneTransferDestination(input);
    const state = (await f.sql('SELECT state_json FROM app_devices WHERE id = ?', [input.deviceId]))[0].state_json;
    const postgres = f.budget.backend === 'postgres';
    await f.sql(postgres ? `CREATE RULE ignore_publication_write AS ON UPDATE TO ${table} DO INSTEAD NOTHING`
      : `CREATE TRIGGER ignore_publication_write BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(IGNORE); END`);
    try { await assert.rejects(f.publisher().submit(f.tokens.accessToken, input), /not recorded/); }
    finally { await f.sql(postgres ? `DROP RULE ignore_publication_write ON ${table}` : 'DROP TRIGGER ignore_publication_write'); }
    assert.deepEqual(await f.sql('SELECT id FROM budgets WHERE id = ?', [budgetId]), []);
    assert.deepEqual(await f.sql('SELECT role FROM budget_memberships WHERE budget_id = ?', [budgetId]), []);
    assert.equal((await f.sql('SELECT state_json FROM app_devices WHERE id = ?', [input.deviceId]))[0].state_json, state);
    assert.equal((await f.publisher().lookup(f.tokens.accessToken, f.lookup(input))).state, 'reserved');
    const receipt = await f.publisher().submit(f.tokens.accessToken, input);
    assert.equal(receipt.state, 'accepted');
    assert.equal((await f.budget.listConfirmedTransactions(budgetId)).length, 1);
  }
}
test('SQLite rolls back ignored device/journal writes and recovers sealed finances without duplicating payment', () => withStandaloneTransferPublisherFixture(ignoredWrites));
test('PostgreSQL rolls back ignored device/journal writes with all financial and ownership effects', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(({ databaseUrl }) => withStandaloneTransferPublisherFixture(ignoredWrites, databaseUrl)));

test('SQLite refuses unowned target files and tampered sealed planning without overwriting either', () => withStandaloneTransferPublisherFixture(async f => {
  const input = f.input(), budgetId = standaloneTransferDestination(input);
  const target = path.join(f.dataDir, budgetId);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'retained.txt'), 'Synthetic unrelated retained storage');
  await assert.rejects(f.publisher().submit(f.tokens.accessToken, input), { code: 'TRANSFER_STORAGE_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(target, 'retained.txt'), 'utf8'), 'Synthetic unrelated retained storage');
  assert.deepEqual(await f.sql('SELECT id FROM budgets WHERE id = ?', [budgetId]), []);
  // Remove only this test's known synthetic conflicting target, then produce a
  // real sealed private file and alter one planning value after interruption.
  fs.rmSync(target, { recursive: true });
  await assert.rejects(f.publisher({ afterRename: () => { throw new Error('Injected rename interruption'); } }).submit(f.tokens.accessToken, input), /Injected/);
  const db = new Database(path.join(target, 'planning.sqlite'));
  try { db.prepare("UPDATE one_off_transactions SET name = 'Changed retained planning'").run(); }
  finally { db.close(); }
  await assert.rejects(f.publisher().submit(f.tokens.accessToken, input), { code: 'TRANSFER_STORAGE_CONFLICT' });
  const retained = new Database(path.join(target, 'planning.sqlite'), { readonly: true });
  try { assert.equal(retained.prepare('SELECT name FROM one_off_transactions').get().name, 'Changed retained planning'); }
  finally { retained.close(); }
  assert.deepEqual(await f.sql('SELECT id FROM budgets WHERE id = ?', [budgetId]), []);
}));

/** Cancellation races the actual publisher, including its committed reservation,
 * rather than only exercising the SQL journal with a no-op financial writer. */
async function cancellationJourneys(f) {
  const publisher = f.publisher(), token = f.tokens.accessToken;
  const fresh = f.input();
  const cancelled = await publisher.cancel(token, fresh);
  assert.equal(cancelled.state, 'cancelled');
  f.advance(1000);
  assert.deepEqual(await f.publisher().cancel(token, fresh), cancelled);
  assert.deepEqual(await publisher.submit(token, fresh), cancelled);
  assert.deepEqual((await publisher.result(token, f.lookup(fresh))).receipt, cancelled);
  for (const change of [{ name: 'Different' }, { sourceJson: '{}' }]) {
    await assert.rejects(publisher.cancel(token, { ...fresh, ...change }), { code: 'TRANSFER_ID_REUSED' });
    await assert.rejects(publisher.submit(token, { ...fresh, ...change }), { code: 'TRANSFER_ID_REUSED' });
  }
  const delayed = f.input();
  let fenced;
  const result = await f.publisher({ afterReservation: async () => {
    fenced = await publisher.cancel(token, delayed);
  } }).submit(token, delayed);
  assert.deepEqual(result, fenced);
  assert.deepEqual(await f.sql('SELECT id FROM budgets WHERE id = ?', [result.budgetId]), []);
  assert.equal(f.logs.filter(row => row.kind === 'cashflow_standalone_transfer_accepted').length, 0);

  const published = f.input(), receipt = await publisher.submit(token, published);
  assert.deepEqual(await publisher.cancel(token, published), receipt);
  await accepted(f, published, receipt);
  const original = (await f.sql('SELECT state_json FROM app_devices WHERE id = ?', [published.deviceId]))[0].state_json;
  await f.sql('UPDATE app_devices SET state_json = ? WHERE id = ?',
    [JSON.stringify({ ...JSON.parse(original), mayCreateBudgets: false }), published.deviceId]);
  // Recovery remains available with creation disabled, including cancellation
  // of a request that never reached the server; review/submit remain privileged.
  assert.deepEqual(await publisher.lookup(token, f.lookup(published)), receipt);
  assert.deepEqual(await publisher.cancel(token, published), receipt);
  const withdrawn = f.input();
  assert.equal((await publisher.cancel(token, withdrawn)).state, 'cancelled');
  for (const input of [published, withdrawn, f.input()]) {
    await assert.rejects(publisher.reviewState(token, f.lookup(input)));
    await assert.rejects(publisher.submit(token, input));
  }
  await f.sql('UPDATE app_devices SET state_json = ? WHERE id = ?', [original, published.deviceId]);
  await f.device.revokeWithRenewal(f.tokens.renewalToken);
  await assert.rejects(publisher.cancel(token, withdrawn));
  await assert.rejects(publisher.lookup(token, f.lookup(published)));
}
test('SQLite cancellation fences delayed publication and preserves accepted budgets with recovery-only authorization', () => withStandaloneTransferPublisherFixture(cancellationJourneys));
test('PostgreSQL cancellation fences delayed publication and preserves accepted budgets with recovery-only authorization', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(({ databaseUrl }) => withStandaloneTransferPublisherFixture(cancellationJourneys, databaseUrl)));

test('SQLite cancellation commits before cleanup and retains unknown or altered storage', () => withStandaloneTransferPublisherFixture(async f => {
  const token = f.tokens.accessToken;
  for (const phase of ['afterFinancial', 'afterFilesReady', 'afterRename']) {
    const input = f.input(), budgetId = standaloneTransferDestination(input);
    await assert.rejects(f.publisher({ [phase]: () => { throw new Error('Injected interruption'); } }).submit(token, input), /Injected/);
    const location = path.join(f.dataDir, ...(phase === 'afterRename' ? [] : ['.standalone-transfers']), budgetId);
    assert.ok(fs.existsSync(location));
    await assert.rejects(f.publisher({ afterRecord: () => { throw new Error('Injected cancellation rollback'); } }).cancel(token, input), /Injected/);
    assert.ok(fs.existsSync(location), 'uncommitted cancellation must not clean up');
    assert.equal((await f.publisher().lookup(token, f.lookup(input))).state, 'reserved');
    await assert.rejects(f.publisher({ afterCancellationCommit: () => { throw new Error('Injected lost acknowledgement'); } }).cancel(token, input), /Injected/);
    const committed = await f.publisher().lookup(token, f.lookup(input));
    assert.equal(committed.state, 'cancelled');
    assert.ok(fs.existsSync(location), 'tombstone must survive interrupted cleanup');
    assert.deepEqual(await f.publisher().cancel(token, input), committed);
    assert.equal(fs.existsSync(location), false);
    assert.deepEqual(await f.publisher().submit(token, input), committed);
    assert.equal(fs.existsSync(location), false);
  }
  for (const alteration of ['unknown', 'tampered']) {
    const input = f.input(), target = path.join(f.dataDir, standaloneTransferDestination(input));
    await assert.rejects(f.publisher({ afterRename: () => { throw new Error('Injected interruption'); } }).submit(token, input), /Injected/);
    if (alteration === 'unknown') fs.writeFileSync(path.join(target, 'retained.txt'), 'Synthetic retained storage');
    else {
      const db = new Database(path.join(target, 'planning.sqlite'));
      try { db.prepare("UPDATE one_off_transactions SET name = 'Retained alteration'").run(); }
      finally { db.close(); }
    }
    assert.equal((await f.publisher().cancel(token, input)).state, 'cancelled');
    assert.ok(fs.existsSync(target));
    assert.equal((await f.publisher().submit(token, input)).state, 'cancelled');
    assert.ok(fs.existsSync(target));
  }
  assert.equal(f.errors.filter(row => row.kind === 'cashflow_standalone_transfer_cleanup_deferred').length, 2);
}));

// This exercises the real wire adapter and authorization without a listening
// socket, so the cancellation contract is also checked in restricted runners.
test('HTTP host cancellation uses recovery permission and canonical input without compatibility or rate IO', () => withStandaloneTransferPublisherFixture(async f => {
  const token = f.tokens.accessToken;
  const host = createStandaloneTransferHttpHost({ publisher: f.publisher(),
    fetchRate: () => { throw new Error('Unexpected provider IO'); } });
  const { sourceJson, ...identity } = f.input();
  const body = { ...identity, source: JSON.parse(sourceJson) };
  const { protocolVersion, financialModelVersion, stateVersion, engineProtocolVersion, engineVersion } = appSyncCapabilities();
  const compatibility = { protocolVersion, financialModelVersion, stateVersion, engineProtocolVersion, engineVersion };
  const receipt = await host.cancel(token, body);
  assert.equal(receipt.state, 'cancelled');
  assert.deepEqual(await host.cancel(token, body), receipt);
  assert.deepEqual(await host.submit(token, { ...body, compatibility }), receipt);
  await assert.rejects(host.review(token, { ...body, compatibility }), { code: 'TRANSFER_ALREADY_STARTED' });
  await assert.rejects(host.cancel(token, { ...body, name: 'Different name' }), { code: 'TRANSFER_ID_REUSED' });
  await assert.rejects(host.cancel(token, { ...body, compatibility }), { code: 'INVALID_TRANSFER_REQUEST' });
  const original = (await f.sql('SELECT state_json FROM app_devices WHERE id = ?', [body.deviceId]))[0].state_json;
  await f.sql('UPDATE app_devices SET state_json = ? WHERE id = ?',
    [JSON.stringify({ ...JSON.parse(original), mayCreateBudgets: false }), body.deviceId]);
  assert.deepEqual(await host.cancel(token, body), receipt);
  assert.deepEqual((await host.result(token, f.lookup(body))).receipt, receipt);
  await assert.rejects(host.submit(token, { ...body, compatibility }));
  await assert.rejects(host.review(token, { ...body, compatibility }));
}));
