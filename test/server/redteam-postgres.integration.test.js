import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { pairRedteamDevice, checkNotificationReentry } from '../helpers/redteam-fixture.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';

const gated = { skip: postgresRuntimeTestsEnabled() ? false : 'owner will run owned disposable PostgreSQL fixtures' };
async function fixture(options, work) {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const budget = await createPostgresBudgetStore({ databaseUrl });
    try { await global.initialize(); await budget.initialize(); }
    finally { await global.close(); await budget.close(); }
    const h = await createCashflowTestHarness({ initializeUser: false, inProcess: true, ...options,
      databaseConfig: { backend: 'postgres', supported: true, external: true, databaseUrlConfigured: true } });
    try { await work(h, pool); } finally { await h.cleanup(); }
  });
}
const add = (h, budgetId, name) => h.api('/api/one-off', { method: 'POST', useSession: true,
  headers: { 'x-cashflow-budget-id': budgetId }, body: { name, amount: 10, currency: 'PLN', type: 'income', date: '2026-05-22' } });
async function backup(h, budgetId, headers) {
  await h.api('/api/backup', { method: 'POST', useSession: true, headers: { 'x-cashflow-budget-id': budgetId }, body: {} });
  return (await h.api('/api/backups', { skipUserHeader: true, headers })).backups[0].id;
}

test('CFSEC-02 PostgreSQL restore observes a completed independent revocation', gated, async () => {
  let h, armed = false;
  await fixture({ backupServiceHook: async ({ phase }) => {
    if (!armed || phase !== 'before_restore_apply') return;
    armed = false;
    const devices = await h.api('/api/account/devices', { useSession: true });
    await h.api(`/api/account/devices/${devices.devices[0].id}`, { method: 'DELETE', useSession: true });
  } }, async (harness, pool) => {
    h = harness;
    const { budgetId, headers } = await pairRedteamDevice(h);
    const backupId = await backup(h, budgetId, headers);
    await add(h, budgetId, 'Current');
    armed = true;
    const result = await h.request(`/api/restore/${backupId}`, { method: 'POST', skipUserHeader: true, headers, body: {} });
    assert.equal(result.response.status, 401);
    assert.equal((await pool.query('SELECT name FROM one_off_transactions WHERE budget_id = $1', [budgetId])).rows[0].name, 'Current');
  });
});

test('CFSEC-03 PostgreSQL failed restore rolls back while its ledger lock is still held', gated, async () => {
  let armed = false, entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  try {
    await fixture({ backupServiceHook: async ({ phase }) => {
      if (!armed || phase !== 'after_restore_replace') return;
      armed = false; entered(); await resume;
      throw new Error('fixture post-replacement failure');
    } }, async (h, pool) => {
      const { budgetId, headers } = await pairRedteamDevice(h);
      const backupId = await backup(h, budgetId, headers);
      await add(h, budgetId, 'Current');
      armed = true;
      const restoring = h.request(`/api/restore/${backupId}`, { method: 'POST', skipUserHeader: true, headers, body: {} });
      await reached;
      // This independently proves replacement still owns the financial lock.
      const lock = await pool.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired', [`cashflow:budget-ledger:${budgetId}`]);
      assert.equal(lock.rows[0].acquired, false);
      const peer = add(h, budgetId, 'Accepted peer write');
      release();
      assert.equal((await restoring).response.status, 500);
      await peer;
      const names = (await pool.query('SELECT name FROM one_off_transactions WHERE budget_id = $1 ORDER BY name', [budgetId])).rows.map(row => row.name);
      assert.deepEqual(names, ['Accepted peer write', 'Current']);
    });
  } finally { release(); }
});

test('CFSEC-08 PostgreSQL old-password login cannot cross password revocation', gated, async () => {
  const verify = argon2.verify;
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  try {
    await fixture({}, async h => {
      await pairRedteamDevice(h);
      let armed = true;
      argon2.verify = async (...args) => {
        const result = await verify(...args);
        if (armed) { armed = false; entered(); await resume; }
        return result;
      };
      const pending = h.request('/api/auth/internal/login', { method: 'POST', skipUserHeader: true, body: { email: 'fixture@example.test', password: 'fixture correct horse battery staple' } });
      await reached;
      await h.api('/api/account/password', { method: 'POST', useSession: true, body: { currentPassword: 'fixture correct horse battery staple', newPassword: 'replacement correct horse battery staple' } });
      release();
      const result = await pending;
      assert.equal(result.response.status, 401);
      assert.equal(result.response.headers.get('set-cookie'), null);
    });
  } finally { release(); argon2.verify = verify; }
});

test('CFSEC-01 PostgreSQL browser/device updates and operational imports require token re-entry', gated, async () => {
  await fixture({}, h => checkNotificationReentry(h, assert));
});
