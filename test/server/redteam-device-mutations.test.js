import test from 'node:test';
import assert from 'node:assert/strict';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { pairRedteamDevice } from '../helpers/redteam-fixture.js';

for (const operation of ['renameBudget', 'updateSettings', 'createInvitation']) {
  test(`CFSEC-02 ${operation} rechecks a cached actor at the owning commit`, async () => {
    let h, armed = false;
    h = await createCashflowTestHarness({ initializeUser: false, inProcess: true, deviceMutationHook: async () => {
      if (!armed) return;
      armed = false;
      const devices = await h.api('/api/account/devices', { useSession: true });
      await h.api(`/api/account/devices/${devices.devices[0].id}`, { method: 'DELETE', useSession: true });
    } });
    try {
      const { budgetId, headers } = await pairRedteamDevice(h);
      const path = operation === 'renameBudget' ? `/api/budgets/${budgetId}` : operation === 'updateSettings' ? '/api/settings' : `/api/budgets/${budgetId}/invitations`;
      const body = operation === 'renameBudget' ? { displayName: 'Renamed fixture', expectedRevision: 1 }
        : operation === 'updateSettings' ? { notify_goal_funded: false } : { role: 'viewer', email: 'invite@example.test' };
      const method = operation === 'createInvitation' ? 'POST' : 'PUT';
      // Happy path also detects accidentally falling back to an independent DB.
      let result = await h.request(path, { method, skipUserHeader: true, headers, body });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      if (operation === 'renameBudget') body.expectedRevision = result.body.budget.revision;
      armed = true;
      result = await h.request(path, { method, skipUserHeader: true, headers, body });
      assert.equal(result.response.status, 401, JSON.stringify(result.body));
    } finally { await h.cleanup(); }
  });
}
