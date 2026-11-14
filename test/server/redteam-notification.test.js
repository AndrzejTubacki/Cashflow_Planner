import test from 'node:test';
import assert from 'node:assert/strict';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { pairRedteamDevice, checkNotificationReentry } from '../helpers/redteam-fixture.js';
import { createCashflowNotificationService } from '../../src/server/cashflow-notification-service.js';

// Literal public addresses only reach validation and the injected transport;
// neither DNS nor an actual outbound connection is used.
test('CFSEC-01 a device cannot forward the retained ntfy secret to a changed destination', async () => {
  const h = await createCashflowTestHarness({ initializeUser: false, inProcess: true });
  try {
    const { budgetId, headers } = await pairRedteamDevice(h);
    await h.cashflow.updateSettings(budgetId, { ntfy_url: 'https://93.184.216.34/topic', ntfy_auth_token: 'tk_fixture_only', notification_channels: 'ntfy' });
    const changed = await h.request('/api/settings', { method: 'PUT', skipUserHeader: true, headers,
      body: { ntfy_url: 'https://93.184.216.35/topic' } });
    assert.equal(changed.response.status, 409, JSON.stringify(changed.body));
    assert.equal(changed.body.ntfy_auth_token, undefined, 'the device still cannot read the secret');
    const sent = [];
    const service = createCashflowNotificationService({ openPlanningDb: id => h.openPlanningDb(id),
      generateId: () => 'fixture-notification',
      fetchImpl: async (url, options) => { sent.push({ url: String(url), authorization: options.headers.Authorization }); return { ok: true }; }
    });
    await service.queueNotificationAsync(budgetId, 'goal_funded', 'Fixture', 'Synthetic notification', 'default', null, 'fixture-only');
    await service.sendQueuedNotifications(budgetId);
    assert.ok(sent.length > 0);
    assert.equal(sent.some(request => request.url === 'https://93.184.216.35/topic' && request.authorization === 'Bearer tk_fixture_only'), false,
      'changed destination received the retained write-only secret');
  } finally { await h.cleanup(); }
});

test('CFSEC-01 browser/device updates and operational imports require explicit token re-entry or clearing', async () => {
  const h = await createCashflowTestHarness({ initializeUser: false, inProcess: true });
  try { await checkNotificationReentry(h, assert); } finally { await h.cleanup(); }
});
