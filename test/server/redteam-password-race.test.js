import test from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { pairRedteamDevice } from '../helpers/redteam-fixture.js';

// Pause the real verifier after success; the independent password-change request
// commits password replacement and all revocations before old login can continue.
test('CFSEC-08 old-password verification cannot issue a session after password replacement', async () => {
  const h = await createCashflowTestHarness({ initializeUser: false, inProcess: true });
  const originalVerify = argon2.verify;
  let release;
  const paused = new Promise(resolve => { release = resolve; });
  let reached;
  const entered = new Promise(resolve => { reached = resolve; });
  try {
    await pairRedteamDevice(h);
    const browser = { ...h.session() };
    let armed = true;
    argon2.verify = async (...args) => {
      const verified = await originalVerify(...args);
      if (armed) { armed = false; reached(); await paused; }
      return verified;
    };
    const login = h.request('/api/auth/internal/login', { method: 'POST', skipUserHeader: true, body: { email: 'fixture@example.test', password: 'fixture correct horse battery staple' } });
    await entered;
    await h.api('/api/account/password', { method: 'POST', useSession: true,
      headers: { cookie: browser.cookie, 'x-cashflow-csrf-token': browser.csrfToken },
      body: { currentPassword: 'fixture correct horse battery staple', newPassword: 'replacement correct horse battery staple' } });
    release();
    const result = await login;
    assert.equal(result.response.status, 401);
    assert.equal(result.response.headers.get('set-cookie'), null);
    const fresh = await h.request('/api/auth/internal/login', { method: 'POST', skipUserHeader: true, body: { email: 'fixture@example.test', password: 'replacement correct horse battery staple' } });
    assert.equal(fresh.response.status, 200);
  } finally { release(); argon2.verify = originalVerify; await h.cleanup(); }
});

// Independently cover the second gap, after authentication returns but before
// the account context is resolved and its session is inserted.
test('CFSEC-08 credential proof is checked atomically at session insertion', async () => {
  const { createCashflowGlobalService } = await import('../../src/server/cashflow-global-service.js');
  const { createCashflowSessionService } = await import('../../src/server/cashflow-session-service.js');
  const { default: Database } = await import('better-sqlite3');
  const { default: path } = await import('node:path');
  const h = await createCashflowTestHarness({ initializeUser: false, inProcess: true });
  try {
    const { budgetId } = await pairRedteamDevice(h);
    const openGlobalDb = () => new Database(path.join(h.dataDir, 'cashflow-global.sqlite'));
    const auth = createCashflowGlobalService({ globalStore: h.cashflow.globalStore, openGlobalDb });
    const verified = await auth.authenticateInternalLogin({ email: 'fixture@example.test', password: 'fixture correct horse battery staple' });
    const issuer = createCashflowSessionService({ globalStore: h.cashflow.globalStore, openGlobalDb,
      resolveAccountContext: async () => {
        await h.api('/api/account/password', { method: 'POST', useSession: true, body: {
          currentPassword: 'fixture correct horse battery staple', newPassword: 'replacement correct horse battery staple'
        } });
        return { account: { id: budgetId }, session: {} };
      }
    });
    await assert.rejects(() => issuer.createInternalAccountSession(budgetId, verified), error => error.status === 401);
  } finally { await h.cleanup(); }
});
