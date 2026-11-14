import assert from 'node:assert/strict';
import test from 'node:test';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { setTodayOverrideForTests } from '../../src/server/cashflow-date-utils.js';
import { createCashflowBudgetService } from '../../src/server/cashflow-budget-service.js';

// Exercise the losing-write branch without requiring a PostgreSQL fixture.
test('rename losing conditional update reloads metadata and rechecks permission before conflict', async () => {
  for (const outcome of ['conflict', 'removed', 'revoked']) {
    const calls = [];
    const repo = {
      budgets: {
        get: async () => {
          calls.push('get');
          if (calls.filter(call => call === 'get').length === 1) {
            return { display_name: 'Before', revision: 1 };
          }
          return outcome === 'removed' ? undefined : { display_name: 'Winning rename', revision: 2 };
        },
        updateDisplayName: async (id, name, revision) => {
          calls.push('update');
          assert.deepEqual([id, name, revision], ['race_budget', 'Losing rename', 1]);
          return undefined;
        }
      },
      memberships: {
        getRole: async () => {
          calls.push('permission');
          return outcome === 'revoked' && calls.includes('update') ? null : { role: 'owner' };
        }
      },
      audit: { insertSecurityEvent: async () => assert.fail('a losing rename must not be audited') }
    };
    const service = createCashflowBudgetService({
      globalStore: { backend: 'postgres', transaction: async fn => fn(repo) },
      openGlobalDb: () => assert.fail('must use the transaction repository')
    });
    await assert.rejects(service.renameBudgetAsync('owner', 'race_budget', {
      displayName: 'Losing rename', expectedRevision: 1
    }), error => {
      assert.equal(error.status, outcome === 'removed' ? 404 : outcome === 'revoked' ? 403 : 409);
      if (outcome === 'conflict') {
        assert.equal(error.code, 'budget_rename_conflict');
        assert.equal(error.currentName, 'Winning rename');
        assert.equal(error.currentRevision, 2);
      } else {
        assert.equal(error.currentName, undefined);
        assert.equal(error.currentRevision, undefined);
      }
      return true;
    });
    assert.deepEqual(calls, outcome === 'removed'
      ? ['get', 'permission', 'update', 'get']
      : ['get', 'permission', 'update', 'get', 'permission']);
  }
});

// Device writes now own an authorization transaction through withRepository.
// Two device requests serialize on its advisory lock; forcing both past that
// lock would defeat CFSEC-02. Browser/device races can still meet before UPDATE,
// because the browser's metadata read does not acquire the device SHARE lock.
async function verifyConcurrentRenames(harness, budgetId, deviceHeaders) {
  const store = harness.cashflow.globalStore;
  for (const competitor of ['device', 'browser with revision', 'browser without revision']) {
    const before = (await harness.api('/api/budgets', { useSession: true }))
      .budgets.find(b => b.id === budgetId);
    const auditBefore = (await store.listRows('security_audit_log'))
      .filter(row => row.action === 'budget_rename' && row.target_id === budgetId).length;
    const readers = [];
    let release;
    let reject;
    const gate = new Promise((resolve, fail) => { release = resolve; reject = fail; });
    const timer = setTimeout(() => reject(new Error('rename reader barrier timed out')), 10000);
    const originalTransaction = store.transaction;
    const originalWithRepository = store.withRepository;
    const instrument = fn => async (repo, client) => {
      const get = repo.budgets.get.bind(repo.budgets);
      const update = repo.budgets.updateDisplayName.bind(repo.budgets);
      let read;
      repo.budgets.get = async id => {
        const row = await get(id);
        if (id === budgetId) read = row;
        return row;
      };
      repo.budgets.updateDisplayName = async (...args) => {
        if (args[0] === budgetId) {
          const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
          readers.push({ revision: read.revision, pid: rows[0].pid });
          if (competitor !== 'device') {
            if (readers.length === 2) release();
            await gate;
          }
        }
        return update(...args);
      };
      return fn(repo, client);
    };
    // Observe both owning paths; wrapping transaction alone misses device writes.
    store.transaction = fn => originalTransaction(instrument(fn));
    store.withRepository = fn => originalWithRepository(instrument(fn));
    const names = [`Phone racing ${competitor}`, `Competing ${competitor}`];
    let results;
    try {
      results = await Promise.all([
        harness.request(`/api/budgets/${budgetId}`, {
          method: 'PUT', headers: deviceHeaders, skipUserHeader: true,
          body: { displayName: names[0], expectedRevision: before.revision }
        }),
        harness.request(`/api/budgets/${budgetId}`, {
          method: 'PUT',
          ...(competitor === 'device'
            ? { headers: deviceHeaders, skipUserHeader: true }
            : { useSession: true }),
          body: {
            displayName: names[1],
            ...(competitor === 'browser without revision' ? {} : { expectedRevision: before.revision })
          }
        })
      ]);
    } finally {
      clearTimeout(timer);
      store.transaction = originalTransaction;
      store.withRepository = originalWithRepository;
    }
    if (competitor === 'device') {
      // The second writer sees the committed revision and rejects before UPDATE.
      assert.deepEqual(readers.map(row => row.revision), [before.revision]);
    } else {
      assert.deepEqual(readers.map(row => row.revision), [before.revision, before.revision]);
      assert.equal(new Set(readers.map(row => row.pid)).size, 2);
    }
    assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409], competitor);
    const winner = results.find(result => result.response.status === 200).body.budget;
    const loser = results.find(result => result.response.status === 409).body;
    assert.ok(names.includes(winner.display_name));
    assert.equal(winner.revision, before.revision + 1);
    assert.deepEqual(loser, {
      error: 'budget_rename_conflict', code: 'budget_rename_conflict',
      currentName: winner.display_name, currentRevision: winner.revision,
      name: winner.display_name, displayName: winner.display_name, revision: winner.revision,
      details: { code: 'budget_rename_conflict', currentName: winner.display_name, currentRevision: winner.revision }
    });
    const stored = (await harness.api('/api/budgets', { useSession: true }))
      .budgets.find(b => b.id === budgetId);
    assert.equal(stored.display_name, winner.display_name);
    assert.equal(stored.revision, winner.revision);
    const auditAfter = (await store.listRows('security_audit_log'))
      .filter(row => row.action === 'budget_rename' && row.target_id === budgetId).length;
    assert.equal(auditAfter, auditBefore + 1, 'only the accepted rename is audited');
  }
}

async function verifyBudgetRename(databaseConfig) {
  const previousToday = setTodayOverrideForTests('2026-05-20');
  const harness = await createCashflowTestHarness({ initializeUser: false, inProcess: true, databaseConfig });
  try {
    const budgetId = 'rename-test-budget';
    // Create user and setup internal auth
    await harness.api('/api/users', {
      method: 'POST',
      skipUserHeader: true,
      body: { userId: budgetId, displayName: 'Owner', email: 'rename@example.test' }
    });
    await harness.api('/api/account/password', {
      method: 'POST',
      useSession: true,
      body: { newPassword: 'rename owner correct horse' }
    });
    await harness.api('/api/admin/auth/draft', {
      method: 'PUT',
      useSession: true,
      body: { draftMode: 'internal' }
    });
    await harness.api('/api/admin/auth/activate', {
      method: 'POST',
      useSession: true,
      body: {}
    });
    await harness.api('/api/auth/internal/login', {
      method: 'POST',
      skipUserHeader: true,
      body: { email: 'rename@example.test', password: 'rename owner correct horse' }
    });

    // 1. Initial revision in budget list
    const list = await harness.api('/api/budgets', { useSession: true });
    const target = list.budgets.find(b => b.id === budgetId);
    assert.ok(target, 'Budget must exist in list');
    assert.equal(target.revision, 1);
    assert.equal(target.display_name, 'Owner');

    // 2. Pair a sync device
    const pairing = await harness.api('/api/device/pairings', {
      method: 'POST',
      skipUserHeader: true,
      body: { label: 'Rename phone', scope: 'app:financial:sync' }
    });
    await harness.api('/api/account/device-pairings/approve', {
      method: 'POST',
      useSession: true,
      body: {
        verificationCode: pairing.verificationCode,
        budgetIds: [budgetId],
        writeBudgetIds: [budgetId]
      }
    });
    const deviceTokens = await harness.api('/api/device/pairings/poll', {
      method: 'POST',
      skipUserHeader: true,
      body: { deviceCode: pairing.deviceCode }
    });
    const deviceHeaders = {
      authorization: `Bearer ${deviceTokens.accessToken}`,
      'x-cashflow-budget-id': budgetId
    };

    // 3. Device budget list returns revision
    const deviceBudgetList = await harness.api('/api/device/budgets', {
      headers: { authorization: `Bearer ${deviceTokens.accessToken}` },
      skipUserHeader: true
    });
    const deviceBudget = deviceBudgetList.budgets.find(b => b.id === budgetId);
    assert.ok(deviceBudget, 'Budget must exist in device budget list');
    assert.equal(deviceBudget.revision, 1);
    assert.equal(deviceBudget.name, 'Owner');

    // 4. Device without expectedRevision gets 400
    const noRevisionDeviceReq = await harness.request(`/api/budgets/${budgetId}`, {
      method: 'PUT',
      headers: deviceHeaders,
      skipUserHeader: true,
      body: { displayName: 'Device Rename Fail' }
    });
    assert.equal(noRevisionDeviceReq.response.status, 400);

    // 5. Competing renames: client 1 succeeds, client 2 with stale revision gets 409
    const rename1 = await harness.request(`/api/budgets/${budgetId}`, {
      method: 'PUT',
      headers: deviceHeaders,
      skipUserHeader: true,
      body: { displayName: 'Name By Client 1', expectedRevision: 1 }
    });
    assert.equal(rename1.response.status, 200);
    assert.equal(rename1.body.budget.display_name, 'Name By Client 1');
    assert.equal(rename1.body.budget.revision, 2);

    const rename2 = await harness.request(`/api/budgets/${budgetId}`, {
      method: 'PUT',
      headers: deviceHeaders,
      skipUserHeader: true,
      body: { displayName: 'Name By Client 2', expectedRevision: 1 }
    });
    assert.equal(rename2.response.status, 409);
    assert.equal(rename2.body.error, 'budget_rename_conflict');
    assert.equal(rename2.body.code, 'budget_rename_conflict');
    assert.equal(rename2.body.currentName, 'Name By Client 1');
    assert.equal(rename2.body.currentRevision, 2);

    // Verify name was unchanged after failed competing rename
    const checkAfterCompeting = await harness.api('/api/budgets', { useSession: true });
    const budgetAfterCompeting = checkAfterCompeting.budgets.find(b => b.id === budgetId);
    assert.equal(budgetAfterCompeting.display_name, 'Name By Client 1');
    assert.equal(budgetAfterCompeting.revision, 2);

    // 6. Lost-response retry with the same expected revision after success
    // Initial call succeeds
    const retryInitial = await harness.request(`/api/budgets/${budgetId}`, {
      method: 'PUT',
      headers: deviceHeaders,
      skipUserHeader: true,
      body: { displayName: 'Name By Retry Client', expectedRevision: 2 }
    });
    assert.equal(retryInitial.response.status, 200);
    assert.equal(retryInitial.body.budget.display_name, 'Name By Retry Client');
    assert.equal(retryInitial.body.budget.revision, 3);

    // Retry with expectedRevision: 2 gets 409 with currentName so client sees own rename won
    const retryStale = await harness.request(`/api/budgets/${budgetId}`, {
      method: 'PUT',
      headers: deviceHeaders,
      skipUserHeader: true,
      body: { displayName: 'Name By Retry Client', expectedRevision: 2 }
    });
    assert.equal(retryStale.response.status, 409);
    assert.equal(retryStale.body.error, 'budget_rename_conflict');
    assert.equal(retryStale.body.code, 'budget_rename_conflict');
    assert.equal(retryStale.body.currentName, 'Name By Retry Client');
    assert.equal(retryStale.body.currentRevision, 3);

    // 7. Browser without expectedRevision still works
    const browserRename = await harness.request(`/api/budgets/${budgetId}`, {
      method: 'PUT',
      useSession: true,
      body: { displayName: 'Browser Renamed Budget' }
    });
    assert.equal(browserRename.response.status, 200);
    assert.equal(browserRename.body.budget.display_name, 'Browser Renamed Budget');
    assert.equal(browserRename.body.budget.revision, 4);

    const checkBrowser = await harness.api('/api/budgets', { useSession: true });
    const budgetBrowser = checkBrowser.budgets.find(b => b.id === budgetId);
    assert.equal(budgetBrowser.display_name, 'Browser Renamed Budget');
    assert.equal(budgetBrowser.revision, 4);

    // 8. Browser with stale expectedRevision gets 409
    const browserStale = await harness.request(`/api/budgets/${budgetId}`, {
      method: 'PUT',
      useSession: true,
      body: { displayName: 'Browser Should Fail', expectedRevision: 2 }
    });
    assert.equal(browserStale.response.status, 409);
    assert.equal(browserStale.body.code, 'budget_rename_conflict');
    assert.equal(browserStale.body.currentName, 'Browser Renamed Budget');
    assert.equal(browserStale.body.currentRevision, 4);

    if (databaseConfig?.backend === 'postgres') {
      await verifyConcurrentRenames(harness, budgetId, deviceHeaders);
    }
  } finally {
    await harness.cleanup();
    setTodayOverrideForTests(previousToday);
  }
}

test('SQLite budget rename stale-write check, retry and device validation', () => verifyBudgetRename());
test('PostgreSQL budget rename stale-write check, retry, and simultaneous device/browser renames on two connections', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, async () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try {
    await global.initialize();
    await budget.initialize();
  } finally {
    await global.close();
    await budget.close();
  }
  await verifyBudgetRename({ backend: 'postgres', supported: true, external: true, databaseUrlConfigured: true });
}));
