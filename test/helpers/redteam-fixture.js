/** Synthetic internal owner and browser-approved write device; no external services. */
export async function pairRedteamDevice(h) {
  const budgetId = 'fixture-owner';
  await h.api('/api/users', { method: 'POST', skipUserHeader: true, body: { userId: budgetId, displayName: 'Fixture', email: 'fixture@example.test' } });
  await h.api('/api/account/password', { method: 'POST', useSession: true, body: { newPassword: 'fixture correct horse battery staple' } });
  await h.api('/api/admin/auth/draft', { method: 'PUT', useSession: true, body: { draftMode: 'internal' } });
  await h.api('/api/admin/auth/activate', { method: 'POST', useSession: true, body: {} });
  await h.api('/api/auth/internal/login', { method: 'POST', skipUserHeader: true, body: { email: 'fixture@example.test', password: 'fixture correct horse battery staple' } });
  const pairing = await h.api('/api/device/pairings', { method: 'POST', skipUserHeader: true, body: { label: 'Fixture phone', scope: 'app:financial:sync' } });
  await h.api('/api/account/device-pairings/approve', { method: 'POST', useSession: true, body: { verificationCode: pairing.verificationCode, budgetIds: [budgetId], writeBudgetIds: [budgetId] } });
  const tokens = await h.api('/api/device/pairings/poll', { method: 'POST', skipUserHeader: true, body: { deviceCode: pairing.deviceCode } });
  return { budgetId, tokens, headers: { authorization: `Bearer ${tokens.accessToken}`, 'x-cashflow-budget-id': budgetId } };
}

/** Exercise the same notification policy on either real storage backend. */
export async function checkNotificationReentry(h, assert) {
  const { budgetId, headers } = await pairRedteamDevice(h);
  const original = 'https://93.184.216.34/topic';
  const changed = 'https://93.184.216.35/topic';
  const settings = async () => (await h.api('/api/export/full?includeOperationalSettings=1', {
    useSession: true, headers: { 'x-cashflow-budget-id': budgetId }
  })).planning.settings[0];
  for (const device of [false, true]) {
    await h.cashflow.updateSettings(budgetId, { ntfy_url: original, ntfy_auth_token: 'tk_fixture_only', locale: 'en' });
    const put = body => h.request('/api/settings', { method: 'PUT',
      ...(device ? { skipUserHeader: true, headers } : { useSession: true, headers: { 'x-cashflow-budget-id': budgetId } }), body });
    const rejected = await put({ ntfy_url: changed });
    assert.equal(rejected.response.status, 409, JSON.stringify(rejected.body));
    assert.match(rejected.body.error, /re-entering or clearing/);
    assert.equal((await settings()).ntfy_url, original);
    assert.equal((await put({ ntfy_url: original })).response.status, 200);
    assert.equal((await settings()).ntfy_auth_token, 'tk_fixture_only');
    const replaced = await put({ ntfy_url: changed, ntfy_auth_token: 'tk_reentered_fixture' });
    assert.equal(replaced.response.status, 200, JSON.stringify(replaced.body));
    if (device) assert.equal(replaced.body.ntfy_auth_token, undefined);
    assert.equal((await settings()).ntfy_auth_token, 'tk_reentered_fixture');
    assert.equal((await put({ ntfy_url: original, ntfy_auth_token: null })).response.status, 200);
    assert.equal((await settings()).ntfy_auth_token, null);
  }
  await h.cashflow.updateSettings(budgetId, { ntfy_url: original, ntfy_auth_token: 'tk_fixture_only', locale: 'pl' });
  const localized = await h.request('/api/settings', { method: 'PUT', skipUserHeader: true, headers, body: { ntfy_url: changed } });
  assert.equal(localized.response.status, 409);
  assert.match(localized.body.error, /ponownego podania lub wyczyszczenia/);
  const browser = { useSession: true, headers: { 'x-cashflow-budget-id': budgetId } };
  const exported = await h.api('/api/export/full?includeOperationalSettings=1', browser);
  delete exported.checksum;
  delete exported.planning.settings[0].ntfy_auth_token;
  // An unchanged destination keeps the omitted token even in an operational import.
  const importBody = { mode: 'replace', export: exported, includeOperationalSettings: true };
  assert.equal((await h.request('/api/import/full', { ...browser, method: 'POST', body: importBody })).response.status, 200);
  assert.equal((await settings()).ntfy_auth_token, 'tk_fixture_only');
  exported.planning.settings[0].ntfy_url = changed;
  const rejectedImport = await h.request('/api/import/full', { ...browser, method: 'POST', body: importBody });
  assert.equal(rejectedImport.response.status, 409, JSON.stringify(rejectedImport.body));
  assert.equal((await settings()).ntfy_url, original);
  assert.equal((await settings()).ntfy_auth_token, 'tk_fixture_only');
  for (const token of ['tk_import_fixture', null]) {
    exported.planning.settings[0].ntfy_auth_token = token;
    exported.planning.settings[0].ntfy_url = token ? changed : original;
    assert.equal((await h.request('/api/import/full', { ...browser, method: 'POST', body: importBody })).response.status, 200);
    assert.equal((await settings()).ntfy_auth_token, token);
  }
}
