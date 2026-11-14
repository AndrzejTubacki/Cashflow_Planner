import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCashflowGlobalService } from '../../src/server/cashflow-global-service.js';
import { applyGlobalMigrations, ensureLegacyBudget, GLOBAL_SCHEMA_VERSION, initializeGlobalSchema } from '../../src/server/cashflow-global-schema.js';
import { createSqliteGlobalRepository } from '../../src/server/cashflow-global-repository.js';
import { createPostgresGlobalRepository } from '../../src/server/cashflow-postgres-global-repository.js';

for (const backend of ['sqlite', 'postgres']) {
  test(`${backend} users list leaves unclaimed folders without metadata and adopts active accounts only`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-users-list-'));
    const filename = path.join(directory, 'global.sqlite');
    const db = new Database(filename);
    try {
      initializeGlobalSchema(db);
      const repo = createSqliteGlobalRepository(db);
      for (const id of ['active', 'disabled']) repo.accounts.insert({ id, displayName: id });
      db.exec("UPDATE accounts SET status = 'disabled' WHERE id = 'disabled'");
      // Old discovery may already have left metadata without an account.
      repo.users.ensureMetadata('stale');
      const service = createCashflowGlobalService({
        listCashflowUserIds: () => ['unclaimed', 'active', 'disabled', 'stale'],
        cashflowUserStorageExists: () => true,
        openGlobalDb: () => new Database(filename),
        // An awaitable repository exercises the PostgreSQL service branch without a server.
        globalStore: backend === 'postgres' ? { backend, withRepository: fn => fn(repo) } : null
      });
      const users = backend === 'sqlite' ? service.listUsers() : await service.listUsersAsync();
      assert.deepEqual(users.map(user => user.id), ['active']);
      assert.equal(repo.users.getMetadata('unclaimed'), undefined);
      assert.equal(repo.users.getMetadata('disabled'), undefined);
      assert.equal(repo.accounts.count(), 2);
      assert.equal(repo.memberships.ownerAccountId('active'), 'active');
      for (const id of ['unclaimed', 'disabled', 'stale']) assert.equal(repo.budgets.get(id), undefined);
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

// A global-7 install whose first account owns budgets stored under other keys.
function oldDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeGlobalSchema(db);
  const repo = createSqliteGlobalRepository(db);
  for (const id of ['first', 'alice', 'bob']) repo.accounts.insert({ id, displayName: id });
  repo.roles.insertSystemAdmin({ accountId: 'first' });
  for (const [id, storageKey, owner] of [
    ['shared', 'alice', 'first'],
    ['other-key', 'unknown', 'first'],
    ['real-owner', 'unknown-real', 'bob']
  ]) {
    repo.budgets.insert({ id, storageKey, displayName: id, createdByAccountId: owner });
    repo.memberships.insertOwner({ budgetId: id, accountId: owner });
  }
  db.exec(`INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at)
    VALUES ('shared', 'alice', 'viewer', datetime('now'), datetime('now')),
      ('real-owner', 'first', 'viewer', datetime('now'), datetime('now'))`);
  db.pragma('user_version = 7');
  return { db, repo };
}

test('SQLite global 8 upgrade keeps existing accounts, roles and owners regardless of storage key', () => {
  const { db } = oldDatabase();
  try {
    const snapshot = () => Object.fromEntries(['accounts', 'account_global_roles', 'budget_memberships']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const budgets = () => db.prepare('SELECT id, storage_key, display_name, status, created_by_account_id FROM budgets ORDER BY id').all();
    const prior = { ...snapshot(), budgets: budgets() };
    applyGlobalMigrations(db);
    assert.equal(db.pragma('user_version', { simple: true }), GLOBAL_SCHEMA_VERSION);
    assert.deepEqual({ ...snapshot(), budgets: budgets() }, prior);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    applyGlobalMigrations(db);
    assert.throws(() => db.exec("DELETE FROM budget_memberships WHERE budget_id = 'shared'"), /last_budget_owner/);
  } finally { db.close(); }
});

test('SQLite setup and compatibility discovery create no accounts or implicit owners', () => {
  const db = new Database(':memory:');
  try {
    initializeGlobalSchema(db, { storageProfileIds: ['alice'] });
    const repo = createSqliteGlobalRepository(db);
    assert.equal(repo.accounts.count(), 0);
    assert.equal(repo.budgets.get('alice'), undefined);
    repo.accounts.insert({ id: 'alice', displayName: 'Alice' });
    ensureLegacyBudget(db, { budgetId: 'renamed-budget', storageKey: 'alice' });
    assert.equal(repo.memberships.ownerAccountId('renamed-budget'), 'alice');
    assert.equal(repo.accounts.count(), 1);
  } finally { db.close(); }
});

test('Postgres compatibility discovery cannot implicitly create an account or budget', async () => {
  const queries = [];
  const repo = createPostgresGlobalRepository({ query: async sql => {
    queries.push(sql);
    return { rows: [], rowCount: 0 };
  } });
  await repo.budgets.ensureLegacy({ id: 'unclaimed' });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /FROM accounts/);
  assert.ok(queries.every(sql => !/INSERT/.test(sql)));
});

test('none-mode session creation requires the selected actor instead of assuming the owner', async () => {
  const { createCashflowSessionService } = await import('../../src/server/cashflow-session-service.js');
  const db = new Database(':memory:');
  try {
    initializeGlobalSchema(db);
    const repo = createSqliteGlobalRepository(db);
    repo.accounts.insert({ id: 'alice', displayName: 'Alice' });
    ensureLegacyBudget(db, { budgetId: 'alice' });
    const service = createCashflowSessionService({
      globalStore: { withRepository: fn => fn(repo, db) },
      resolveBudgetContext: (budgetId, { accountId }) => ({
        account: { id: accountId }, budget: { id: budgetId }, session: { accountId }
      })
    });
    await assert.rejects(service.createNoneSession('alice'), /Budget access denied/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
    const issued = await service.createNoneSession('alice', { accountId: 'alice' });
    assert.equal(issued.context.account.id, 'alice');
  } finally { db.close(); }
});
