import assert from 'node:assert/strict';
import test from 'node:test';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';

/** Advance a private injected clock; never alter wall time or token/database metadata. */
async function verifyExtendedOffline(databaseConfig) {
  const day = 86_400_000;
  let offset = 0;
  const now = () => Date.now() + offset;
  const harness = await createCashflowTestHarness({ initializeUser: false, databaseConfig, deviceNow: now });
  try {
    await harness.api('/api/users', { method: 'POST', skipUserHeader: true,
      body: { userId: 'offline-owner', displayName: 'Offline fixture', email: 'offline@example.test' } });
    await harness.api('/api/account/password', { method: 'POST', useSession: true, body: { newPassword: 'synthetic offline correct horse' } });
    await harness.api('/api/admin/auth/draft', { method: 'PUT', useSession: true, body: { draftMode: 'internal' } });
    await harness.api('/api/admin/auth/activate', { method: 'POST', useSession: true, body: {} });
    await harness.api('/api/auth/internal/login', { method: 'POST', skipUserHeader: true,
      body: { email: 'offline@example.test', password: 'synthetic offline correct horse' } });
    const challenge = await harness.api('/api/device/pairings', { method: 'POST', skipUserHeader: true, body: { label: 'Offline clock' } });
    await harness.api('/api/account/device-pairings/approve', { method: 'POST', useSession: true,
      body: { verificationCode: challenge.verificationCode, budgetIds: ['offline-owner'] } });
    const initial = await harness.api('/api/device/pairings/poll', { method: 'POST', skipUserHeader: true, body: { deviceCode: challenge.deviceCode } });
    const snapshot = token => harness.request('/api/app/snapshot', { skipUserHeader: true,
      headers: { authorization: `Bearer ${token}`, 'x-cashflow-budget-id': 'offline-owner' } });
    const renew = token => harness.request('/api/device/renew', { method: 'POST', skipUserHeader: true, body: { renewalToken: token } });
    assert.equal((await snapshot(initial.accessToken)).response.status, 200);
    offset += 45 * day;
    assert.equal((await snapshot(initial.accessToken)).response.status, 401, 'Access really expires while the device is offline');
    const renewed = await renew(initial.renewalToken);
    assert.equal(renewed.response.status, 200);
    assert.ok(renewed.body.accessExpiresMs > now());
    assert.ok(renewed.body.renewalExpiresMs > initial.renewalExpiresMs);
    assert.equal(renewed.body.absoluteExpiresMs, initial.absoluteExpiresMs);
    assert.equal(renewed.body.deviceId, initial.deviceId);
    assert.equal((await snapshot(renewed.body.accessToken)).response.status, 200);
    offset += 91 * day;
    assert.equal((await snapshot(renewed.body.accessToken)).response.status, 401);
    assert.equal((await renew(renewed.body.renewalToken)).response.status, 401, 'Inactivity expiry requires a new browser approval');
  } finally { await harness.cleanup(); }
}

test('real device routes renew after 45 offline days and refuse after 91 further inactive days', () => verifyExtendedOffline());
test('PostgreSQL extended-offline device expiry uses the same route clock', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, async () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try { await global.initialize(); await budget.initialize(); }
  finally { await global.close(); await budget.close(); }
  await verifyExtendedOffline({ backend: 'postgres', supported: true, external: true, databaseUrlConfigured: true });
}));
