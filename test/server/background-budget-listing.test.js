import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCashflowGlobalService } from '../../src/server/cashflow-global-service.js';
import { initializeGlobalSchema } from '../../src/server/cashflow-global-schema.js';
import { createSqliteGlobalRepository } from '../../src/server/cashflow-global-repository.js';

// PostgreSQL budgets have no per-budget SQLite folder. Background jobs (FX
// refresh, ledger checks, backups) must still see them.
test('PostgreSQL background jobs list active budgets without on-disk storage folders', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-budget-listing-'));
  const filename = path.join(directory, 'global.sqlite');
  const db = new Database(filename);
  try {
    initializeGlobalSchema(db);
    const repo = createSqliteGlobalRepository(db);
    repo.accounts.insert({ id: 'owner', displayName: 'Owner' });
    for (const id of ['budget-a', 'budget-b']) {
      repo.budgets.insert({ id, displayName: id, storageKey: id, createdByAccountId: 'owner' });
      repo.memberships.insertOwner({ budgetId: id, accountId: 'owner' });
    }
    const service = createCashflowGlobalService({
      listCashflowUserIds: () => [],
      cashflowUserStorageExists: () => false,
      openGlobalDb: () => new Database(filename),
      // An awaitable repository exercises the PostgreSQL branch without a server.
      globalStore: { backend: 'postgres', withRepository: fn => fn(repo) }
    });
    assert.deepEqual((await service.listActiveBudgetIdsAsync()).sort(), ['budget-a', 'budget-b']);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
