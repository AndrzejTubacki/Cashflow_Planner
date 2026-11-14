import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { pairRedteamDevice } from '../helpers/redteam-fixture.js';

// The synchronous hook models a completed revocation on an independent connection.
test('CFSEC-02 restore must observe revocation completed after initial authorization', async () => {
  let h, armed = false;
  h = await createCashflowTestHarness({ initializeUser: false, inProcess: true, backupServiceHook: ({ phase }) => {
    if (armed && phase === 'before_restore_apply') {
      armed = false;
      const db = new Database(path.join(h.dataDir, 'cashflow-global.sqlite'));
      try { assert.ok(db.prepare('UPDATE app_devices SET revoked_ms = ?').run(Date.now()).changes > 0); }
      finally { db.close(); }
    }
  } });
  try {
    const { budgetId, headers } = await pairRedteamDevice(h);
    await h.api('/api/one-off', { method: 'POST', useSession: true, headers: { 'x-cashflow-budget-id': budgetId }, body: { name: 'Earlier', amount: 10, currency: 'PLN', type: 'income', date: '2026-05-22' } });
    await h.api('/api/backup', { method: 'POST', useSession: true, headers: { 'x-cashflow-budget-id': budgetId }, body: {} });
    const { backups } = await h.api('/api/backups', { skipUserHeader: true, headers });
    await h.api('/api/one-off', { method: 'POST', useSession: true, headers: { 'x-cashflow-budget-id': budgetId }, body: { name: 'Current', amount: 20, currency: 'PLN', type: 'income', date: '2026-05-23' } });
    const db = h.openPlanningDb(budgetId);
    const before = db.prepare('SELECT epoch FROM cashflow_sync_heads').get()?.epoch;
    db.close();
    armed = true;
    const result = await h.request(`/api/restore/${backups[0].id}`, { method: 'POST', skipUserHeader: true, headers, body: {} });
    assert.equal(result.response.status, 401, JSON.stringify(result.body));
    const check = h.openPlanningDb(budgetId);
    try { assert.equal(check.prepare("SELECT count(*) AS n FROM one_off_transactions WHERE name = 'Current'").get().n, 1); assert.equal(check.prepare('SELECT epoch FROM cashflow_sync_heads').get()?.epoch, before); }
    finally { check.close(); }
  } finally { await h.cleanup(); }
});

for (const failAfterReplacement of [false, true]) {
  test(`CFSEC-03 SQLite restore ${failAfterReplacement ? 'rolls back replacement, projections and epoch on failure' : 'commits a complete snapshot and keeps backup metadata'}`, async () => {
    let armed = false;
    const h = await createCashflowTestHarness({ inProcess: true, backupServiceHook: ({ phase }) => {
      if (armed && phase === 'after_restore_replace') { armed = false; throw new Error('fixture late restore failure'); }
    } });
    try {
      await h.api('/api/one-off', { method: 'POST', body: { name: 'Earlier', amount: 10, currency: 'PLN', type: 'income', date: '2026-05-22' } });
      await h.api('/api/backup', { method: 'POST', body: {} });
      const db = h.openPlanningDb();
      const id = db.prepare('SELECT id FROM backup_metadata WHERE success = 1').get().id;
      db.close();
      await h.api('/api/one-off', { method: 'POST', body: { name: 'Current', amount: 20, currency: 'PLN', type: 'income', date: '2026-05-23' } });
      const before = h.openPlanningDb();
      const head = before.prepare('SELECT * FROM cashflow_sync_heads').all();
      const projections = before.prepare('SELECT * FROM future_transactions ORDER BY id').all();
      before.close();
      armed = failAfterReplacement;
      const result = await h.request(`/api/restore/${id}`, { method: 'POST', body: {} });
      assert.equal(result.response.status, failAfterReplacement ? 500 : 200, JSON.stringify(result.body));
      const check = h.openPlanningDb();
      try {
        assert.equal(check.prepare("SELECT count(*) AS n FROM one_off_transactions WHERE name = 'Current'").get().n, failAfterReplacement ? 1 : 0);
        assert.equal(check.prepare('SELECT count(*) AS n FROM backup_metadata WHERE success = 1').get().n, 2);
        if (failAfterReplacement) {
          assert.deepEqual(check.prepare('SELECT * FROM cashflow_sync_heads').all(), head);
          assert.deepEqual(check.prepare('SELECT * FROM future_transactions ORDER BY id').all(), projections);
        }
      } finally { check.close(); }
    } finally { await h.cleanup(); }
  });
}

test('CFSEC-03 synchronous helper also rolls back a post-replacement projection failure', async () => {
  const { createCashflowBackupService } = await import('../../src/server/cashflow-backup-service.js');
  const { createCashflowLedgerService } = await import('../../src/server/cashflow-ledger-service.js');
  const h = await createCashflowTestHarness({ inProcess: true });
  try {
    await h.api('/api/backup', { method: 'POST', body: {} });
    const db = h.openPlanningDb();
    const artifact = db.prepare('SELECT backup_path FROM backup_metadata WHERE success = 1').get().backup_path;
    db.close();
    await h.api('/api/one-off', { method: 'POST', body: { name: 'Current', amount: 10, currency: 'PLN', type: 'income', date: '2026-05-22' } });
    const ledger = createCashflowLedgerService({ allowStandaloneOrigins: true,
      openPlanningDb: h.openPlanningDb, openLedgerDb: (id, year) => h.openLedgerDb(year, id), listLedgerYears: () => [2026] });
    const service = createCashflowBackupService({ allowStandaloneOrigins: true,
      openPlanningDb: h.openPlanningDb, initReadOnlyPragmas: () => {}, generateId: () => 'fixture-restore-event',
      recalculateLedgerRunningBalance: ledger.recalculateLedgerRunningBalance,
      regenerateProjectionsAfterMutation: () => { throw new Error('fixture sync projection failure'); }
    });
    assert.throws(() => service.restoreBackupFromPath('local', artifact), /fixture sync projection failure/);
    const check = h.openPlanningDb();
    try { assert.equal(check.prepare("SELECT count(*) AS n FROM one_off_transactions WHERE name = 'Current'").get().n, 1); }
    finally { check.close(); }
  } finally { await h.cleanup(); }
});
