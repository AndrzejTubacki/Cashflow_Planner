import test from 'node:test';
import assert from 'node:assert/strict';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';

/** Exercise the real Express boundary in-process, without starting a listener. */
async function exercise(databaseConfig) {
  let offset = 0;
  const harness = await createCashflowTestHarness({ inProcess: true, initializeUser: false, databaseConfig, deviceNow: () => Date.now() + offset });
  try {
    await harness.api('/api/users', { method: 'POST', skipUserHeader: true,
      body: { userId: 'archive-owner', displayName: 'Owner', email: 'archive@example.test' } });
    await harness.api('/api/account/password', { method: 'POST', useSession: true, body: { newPassword: 'synthetic archive correct horse' } });
    await harness.api('/api/admin/auth/draft', { method: 'PUT', useSession: true, body: { draftMode: 'internal' } });
    await harness.api('/api/admin/auth/activate', { method: 'POST', useSession: true, body: {} });
    await harness.api('/api/auth/internal/login', { method: 'POST', skipUserHeader: true,
      body: { email: 'archive@example.test', password: 'synthetic archive correct horse' } });
    async function enroll() {
      const pair = await harness.api('/api/device/pairings', { method: 'POST', skipUserHeader: true, body: { label: 'Archive phone', scope: 'app:financial:sync' } });
      await harness.api('/api/account/device-pairings/approve', { method: 'POST', useSession: true,
        body: { verificationCode: pair.verificationCode, budgetIds: ['archive-owner'], writeBudgetIds: ['archive-owner'], mayCreateBudgets: true } });
      return harness.api('/api/device/pairings/poll', { method: 'POST', skipUserHeader: true, body: { deviceCode: pair.deviceCode } });
    }
    const tokens = await enroll(), peer = await enroll();
    const bearer = { authorization: `Bearer ${tokens.accessToken}` };
    const created = await harness.api('/api/device/budgets', { method: 'POST', skipUserHeader: true, headers: bearer,
      body: { name: 'Archive target', currency: 'PLN', openingBalance: 0 } });
    const budgetId = created.budgetId, key = 'durable-removal-1';
    const request = (path, body, headers = bearer, method = body === undefined ? 'GET' : 'POST') =>
      harness.request(path, { method, skipUserHeader: true, headers, ...(body === undefined ? {} : { body }) });
    const archive = () => request(`/api/budgets/${budgetId}/archive`, { idempotencyKey: key }, { ...bearer, 'x-cashflow-budget-id': budgetId });
    const archived = await archive();
    assert.equal(archived.response.status, 200, JSON.stringify(archived.body));
    assert.equal(archived.body.receipt.idempotencyKey, key);
    assert.deepEqual((await archive()).body, archived.body);
    const lookup = (id = budgetId, idempotencyKey = key, headers = bearer) => request('/api/device/archive-receipts/lookup', { budgetId: id, idempotencyKey }, headers);
    assert.deepEqual((await lookup()).body.receipt, archived.body.receipt);
    assert.equal((await lookup('archive-owner')).response.status, 401);
    assert.equal((await lookup(budgetId, 'wrong-key')).response.status, 401);
    assert.equal((await lookup(budgetId, key, { ...bearer, cookie: 'synthetic=1' })).response.status, 401);
    for (const [path, body, headers, method] of [
      ['/api/device/budgets'], ['/api/device/budgets', { name: 'Refused creation', currency: 'PLN', openingBalance: 0 }],
      ['/api/app/snapshot', undefined, { ...bearer, 'x-cashflow-budget-id': 'archive-owner' }],
      ['/api/export/full', undefined, { ...bearer, 'x-cashflow-budget-id': budgetId }],
      [`/api/budgets/${budgetId}/members`, undefined, { ...bearer, 'x-cashflow-budget-id': budgetId }],
      ['/api/settings', { future_periods: 4 }, { ...bearer, 'x-cashflow-budget-id': 'archive-owner' }, 'PUT'],
      ['/api/app/sync/v1/negotiate', { protocolVersion: 1, instanceId: tokens.instanceId, accountId: tokens.accountId, budgetId: 'archive-owner',
        offer: { protocolVersions: [1], stateVersions: [3], financialModelVersions: [1], engineProtocolVersions: [1], engineVersions: ['0.5.0'] } }],
      ['/api/account/devices'],
      ['/api/device/renew', { renewalToken: tokens.renewalToken }, {}],
      ['/api/device/revoke', { renewalToken: tokens.renewalToken }, {}]
    ]) {
      const refused = await request(path, body, headers ?? bearer, method ?? (body === undefined ? 'GET' : 'POST'));
      assert.equal(refused.response.status, 401, path + ' ' + JSON.stringify(refused.body));
    }
    // Another device of this account keeps its still-active budget grant.
    assert.equal((await request('/api/device/budgets', undefined, { authorization: `Bearer ${peer.accessToken}` })).response.status, 200);
    offset += 16 * 60000;
    assert.equal((await lookup()).response.status, 200, 'expired ordinary access still permits the archive receipt');
    const ack = await request('/api/device/archive-receipts/ack', { budgetId, idempotencyKey: key });
    assert.equal(ack.response.status, 200, JSON.stringify(ack.body));
    assert.equal(ack.body.revoked, true);
    assert.equal((await lookup()).response.status, 401);
  } finally { await harness.cleanup(); }
}
test('SQLite archive routes restrict recovery to one receipt then acknowledge revocation', () => exercise());
test('PostgreSQL archive routes restrict recovery to one receipt then acknowledge revocation', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable PostgreSQL tests'
}, () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl }), budget = await createPostgresBudgetStore({ databaseUrl });
  try { await global.initialize(); await budget.initialize(); } finally { await global.close(); await budget.close(); }
  await exercise({ backend: 'postgres', supported: true, external: true, databaseUrlConfigured: true });
}));
