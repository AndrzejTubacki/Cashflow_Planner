import assert from 'node:assert/strict';
import test from 'node:test';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createPostgresGlobalSchemaSql } from '../../src/server/cashflow-postgres-global-schema.js';
import { createLedgerCorrectionService } from '../../src/server/cashflow-ledger-correction-service.js';
import { createNodeLedgerAuditReplay } from '../../src/server/cashflow-ledger-audit-store.js';
import { createBudgetStoreSnapshot, normalizeBudgetStoreSnapshot, restoreBudgetStoreSnapshot } from '../../src/server/cashflow-budget-store-snapshot.js';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const budgetId = 'server-origin-audit';
const stamp = '2026-06-02T12:00:00.000Z';
const upgraded = { allowStandaloneOrigins: true };
const codec = createNodeLedgerAuditReplay(upgraded);

/** Real financial writer and owning connection; all accounts/data/files are
 * synthetic fixtures. Origin-aware use remains an internal host policy. */
function transaction(store, work) {
  const own = store.backend === 'postgres' ? fn => store.transaction(fn) : fn => store.planningTransaction(budgetId, fn);
  return own(async (writer, connection) => {
    if (store.backend === 'postgres') await writer.lockBudgetLedger(budgetId);
    const query = async (sql, values = []) => {
      if (store.backend === 'postgres') { let index = 0; return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), values)).rows; }
      const statement = connection.prepare(sql);
      return statement.reader ? statement.all(...values) : (statement.run(...values), []);
    };
    return work({ writer, service: createLedgerCorrectionService({ budgetId, writer, query, ...upgraded }) });
  });
}

/** Full backup/replacement keeps offset/proof/facts together. This does not
 * publish a transferred budget or claim authorization/native acceptance. */
async function exercise(store, legacyStore) {
  const audit = standaloneOriginAuditFixture().audit;
  const state = codec.replayLedgerAuditSnapshot(audit, budgetId);
  await store.insertPlanningRows(budgetId, 'one_off_transactions', [{ id: 'source', name: 'Source payment', amount: 400,
    type: 'expense', currency: 'PLN', date: '2026-06-02', created_at: stamp, updated_at: stamp }]);
  await transaction(store, async ({ writer, service }) => {
    await writer.insertConfirmedTransactions(budgetId, state.rows.map(row => ({ ...row, running_balance_pln: 100 })));
    await service.audit.restoreSnapshot(audit);
  });
  const makeBackup = () => createBudgetStoreSnapshot({ budgetIds: [budgetId], budgetStore: store, now: new Date(stamp), ...upgraded });
  const backup = await makeBackup();
  assert.deepEqual(backup.ledgerAudits, [audit]);
  assert.equal(backup.payload.tables.confirmed_transactions[0].running_balance_pln, 100);
  assert.throws(() => normalizeBudgetStoreSnapshot(backup), /upgraded host/);
  assert.throws(() => normalizeBudgetStoreSnapshot({ ...backup, allowStandaloneOrigins: true }), /upgraded host/);
  await assert.rejects(createBudgetStoreSnapshot({ budgetIds: [budgetId], budgetStore: legacyStore }), /upgraded host/);
  const tamperedTotals = structuredClone(backup);
  tamperedTotals.payload.tables.confirmed_transactions[0].running_balance_pln = 999999;
  const checked = normalizeBudgetStoreSnapshot(tamperedTotals, upgraded);
  assert.equal(checked.payload.tables.confirmed_transactions[0].running_balance_pln, 100);
  assert.equal(tamperedTotals.payload.tables.confirmed_transactions[0].running_balance_pln, 999999);
  await transaction(store, ({ service }) => service.correct({ id: 'new-server-review', targetId: 'confirmed-original',
    expectedCorrectionId: null, replacement: { amount: 450, date: '2026-06-02' }, reason: 'Later correction',
    today: '2026-06-02', createdAt: '2026-06-02T12:01:00.000Z', actorId: 'synthetic-reviewer' }));
  const newer = await makeBackup();
  assert.equal(newer.ledgerAudits[0].corrections.length, 1);
  assert.equal(newer.payload.tables.confirmed_transactions[0].running_balance_pln, 50);
  // Even an opted-in normalizer cannot make an old writer discard this proof.
  await assert.rejects(restoreBudgetStoreSnapshot({ budgetStore: legacyStore, snapshot: backup, ...upgraded }), /upgraded host/);
  assert.deepEqual((await makeBackup()).ledgerAudits, newer.ledgerAudits);
  assert.deepEqual((await makeBackup()).payload.tables.confirmed_transactions, newer.payload.tables.confirmed_transactions);
  await assert.rejects(restoreBudgetStoreSnapshot({ budgetStore: store, snapshot: backup, ...upgraded,
    onBatch(batch) { if (batch.tableName === 'ledger-audit') throw new Error('Injected origin backup failure'); }
  }), /Injected origin backup failure/);
  assert.deepEqual((await makeBackup()).ledgerAudits, newer.ledgerAudits);
  assert.deepEqual((await makeBackup()).payload.tables.confirmed_transactions, newer.payload.tables.confirmed_transactions);
  await restoreBudgetStoreSnapshot({ budgetStore: store, snapshot: tamperedTotals, ...upgraded });
  assert.deepEqual((await makeBackup()).ledgerAudits, [audit]);
  assert.equal((await store.listConfirmedTransactions(budgetId))[0].running_balance_pln, 100);
  for (const mutate of [value => { value.ledgerAudits[0].origin.events[0].row.ledger_amount = 1; },
    value => { value.ledgerAudits[0].origin.events[0].source.row.budget_id = 'local-other'; },
    value => { value.payload.tables.confirmed_transactions[0].amount = 1; }]) {
    const damaged = structuredClone(backup); mutate(damaged);
    await assert.rejects(restoreBudgetStoreSnapshot({ budgetStore: store, snapshot: damaged, ...upgraded }));
    assert.deepEqual((await makeBackup()).ledgerAudits, [audit]);
  }
  // An explicit full replacement may have a signed opening and no payment
  // rows at all. Its proof must survive another backup and restore as-is.
  const empty = structuredClone(backup);
  empty.payload.tables.confirmed_transactions = [];
  empty.ledgerAudits = [{ ...audit, lastSequence: 0,
    origin: { ...audit.origin, openingBalance: -50, sourceRevision: 0, legacyCount: 0, events: [] } }];
  await restoreBudgetStoreSnapshot({ budgetStore: store, snapshot: empty, ...upgraded });
  const emptyBackup = await makeBackup();
  assert.deepEqual(emptyBackup.payload.tables.confirmed_transactions, []);
  assert.deepEqual(emptyBackup.ledgerAudits, empty.ledgerAudits);
  assert.equal(emptyBackup.ledgerAudits[0].origin.openingBalance, -50);
  await restoreBudgetStoreSnapshot({ budgetStore: store, snapshot: emptyBackup, ...upgraded });
  assert.deepEqual((await makeBackup()).ledgerAudits, empty.ledgerAudits);
}

test('SQLite full backup preserves origin offsets and rolls back unsupported or failed replacement', async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId });
  try {
    const db = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
    await exercise(createSqliteBudgetStore({ ...db, ...upgraded }), createSqliteBudgetStore(db));
  } finally { await harness.cleanup(); }
});

test('PostgreSQL full backup preserves origin offsets and shares owning replacement transactions', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Synthetic origin backup',now(),now())", [budgetId]);
  const store = await createPostgresBudgetStore({ databaseUrl, ...upgraded });
  const legacy = await createPostgresBudgetStore({ databaseUrl });
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, 'settings', [{ id: 1, updated_at: stamp }]);
    await exercise(store, legacy);
  } finally { await store.close(); await legacy.close(); }
}));
