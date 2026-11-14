import test from 'node:test';
import assert from 'node:assert/strict';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { pairRedteamDevice } from '../helpers/redteam-fixture.js';

async function providerFixture(work) {
  process.env.CASHFLOW_REDTEAM_PROVIDER_SECRET = 'fixture-secret';
  const h = await createCashflowTestHarness({ initializeUser: false, inProcess: true,
    authProviderHook: async ({ action, state }) => action === 'authorization_url'
      ? { authorizationUrl: `https://provider.example.test/authorize?state=${encodeURIComponent(state)}` }
      : { profile: { sub: 'fixture-subject', email: 'fixture@example.test', email_verified: true, name: 'Fixture' } }
  });
  try {
    const { budgetId } = await pairRedteamDevice(h);
    await h.api('/api/admin/auth/providers/google', { method: 'PUT', useSession: true, body: {
      kind: 'google', displayName: 'Fixture Google', enabled: true, issuer: 'https://accounts.google.com', clientId: 'fixture-client',
      secretEnv: 'CASHFLOW_REDTEAM_PROVIDER_SECRET', redirectUri: `${h.baseUrl()}/api/auth/providers/google/callback`
    } });
    await work(h, budgetId);
  } finally { await h.cleanup(); delete process.env.CASHFLOW_REDTEAM_PROVIDER_SECRET; }
}

for (const purpose of ['login', 'link']) {
  test(`CFSEC-04 ${purpose} callback requires the initiating browser`, async () => providerFixture(async (h, budgetId) => {
    if (purpose === 'login') await h.api(`/api/admin/accounts/${budgetId}/provider-identities/google`, { method: 'PUT', useSession: true, body: { subject: 'fixture-subject', email: 'fixture@example.test', emailVerified: true } });
    const started = await h.request(`/api/auth/providers/google/${purpose}/start`, { method: 'POST', useSession: purpose === 'link', skipUserHeader: true, body: {} });
    const initiatingSession = h.session().cookie;
    assert.equal(started.response.status, 200);
    const state = new URL(started.body.authorizationUrl).searchParams.get('state');
    // Browser B has neither A's transaction cookie nor A's authenticated session.
    const result = await h.request(`/api/auth/providers/google/callback?state=${encodeURIComponent(state)}&code=fixture`, { skipUserHeader: true, headers: { cookie: '' }, redirect: 'manual' });
    assert.match(result.response.headers.get('location'), /cashflow_auth_error=/);
    assert.equal(result.response.headers.get('set-cookie'), null);
    if (purpose === 'link') {
      const identities = await h.cashflow.globalStore.withRepository(repo => repo.identities.listForAccount(budgetId));
      assert.equal(identities.length, 0);
    }
    const transactionCookie = started.response.headers.get('set-cookie').split(';')[0];
    if (purpose === 'link') {
      // A different valid session for the same account must also fail.
      await h.api('/api/auth/internal/login', { method: 'POST', skipUserHeader: true, body: { email: 'fixture@example.test', password: 'fixture correct horse battery staple' } });
      const swapped = await h.request(`/api/auth/providers/google/callback?state=${encodeURIComponent(state)}&code=fixture`, {
        skipUserHeader: true, headers: { cookie: `${transactionCookie}; ${h.session().cookie}` }, redirect: 'manual'
      });
      assert.match(swapped.response.headers.get('location'), /cashflow_auth_error=/);
    }
    const sameBrowser = await h.request(`/api/auth/providers/google/callback?state=${encodeURIComponent(state)}&code=fixture`, {
      skipUserHeader: true, headers: { cookie: `${transactionCookie}; ${initiatingSession}` }, redirect: 'manual'
    });
    assert.equal(sameBrowser.response.headers.get('location'), purpose === 'login' ? '/?cashflow_auth=provider' : '/?cashflow_auth=linked#account');
    const replay = await h.request(`/api/auth/providers/google/callback?state=${encodeURIComponent(state)}&code=fixture`, {
      skipUserHeader: true, headers: { cookie: `${transactionCookie}; ${initiatingSession}` }, redirect: 'manual'
    });
    assert.match(replay.response.headers.get('location'), /cashflow_auth_error=/);

  }));
}

test('CFSEC-05 cross-origin form login never issues or replaces a session', async () => {
  const h = await createCashflowTestHarness({ initializeUser: false, inProcess: true });
  try {
    await pairRedteamDevice(h);
    const victimCookie = h.session().cookie;
    for (const cookie of ['', victimCookie]) {
      const result = await h.request('/api/auth/internal/login', { method: 'POST', skipUserHeader: true,
        headers: { origin: 'https://untrusted.example.test', cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'fixture@example.test', password: 'fixture correct horse battery staple' }).toString() });
      assert.equal(result.response.status, 403);
      assert.equal(result.response.headers.get('set-cookie'), null);
    }
  } finally { await h.cleanup(); }
});

test('CFSEC-05 originless forms and cross-site JSON fail while same-origin forms work', async () => {
  const h = await createCashflowTestHarness({ initializeUser: false, inProcess: true });
  try {
    await pairRedteamDevice(h);
    const form = new URLSearchParams({ email: 'fixture@example.test', password: 'fixture correct horse battery staple' }).toString();
    for (const headers of [{}, { origin: 'null' }, { origin: 'http://cashflow.test', 'sec-fetch-site': 'cross-site' }]) {
      const result = await h.request('/api/auth/internal/login', { method: 'POST', skipUserHeader: true,
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form });
      assert.equal(result.response.status, 403);
      assert.equal(result.response.headers.get('set-cookie'), null);
    }
    const same = await h.request('/api/auth/internal/login', { method: 'POST', skipUserHeader: true,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://cashflow.test' }, body: form });
    assert.equal(same.response.status, 200);
  } finally { await h.cleanup(); }
});

test('CFSEC-04 HTTPS transaction cookies resist sibling-domain cookie injection', async () => providerFixture(async h => {
  const started = await h.request('/api/auth/providers/google/login/start', { method: 'POST', skipUserHeader: true,
    headers: { 'x-forwarded-proto': 'https' }, body: {} });
  assert.equal(started.response.status, 200);
  const cookie = started.response.headers.get('set-cookie');
  assert.match(cookie, /^__Host-cashflow_oauth_/);
  assert.match(cookie, /; Path=\/;/);
  assert.match(cookie, /; HttpOnly;/);
  assert.match(cookie, /; Secure$/);
  assert.equal(cookie.includes('Domain='), false);
}));
