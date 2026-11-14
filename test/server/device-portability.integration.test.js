import assert from 'node:assert/strict';
import test from 'node:test';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { setTodayOverrideForTests } from '../../src/server/cashflow-date-utils.js';
import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from '../../src/engine/index.js';

/** Exercise real pairing, grants, preview, source writes and recovery over HTTP. */
async function verifyPortability(databaseConfig) {
  const previousToday = setTodayOverrideForTests('2026-05-20');
  const harness = await createCashflowTestHarness({ initializeUser: false, inProcess: true, databaseConfig });
  try {
    const budgetId = 'port-owner';
    await harness.api('/api/users', { method: 'POST', skipUserHeader: true,
      body: { userId: budgetId, displayName: 'Owner', email: 'port@example.test' } });
    await harness.api('/api/account/password', { method: 'POST', useSession: true, body: { newPassword: 'portability owner correct horse' } });
    await harness.api('/api/admin/auth/draft', { method: 'PUT', useSession: true, body: { draftMode: 'internal' } });
    await harness.api('/api/admin/auth/activate', { method: 'POST', useSession: true, body: {} });
    await harness.api('/api/auth/internal/login', { method: 'POST', skipUserHeader: true,
      body: { email: 'port@example.test', password: 'portability owner correct horse' } });
    const pair = async (write, scope = 'app:financial:sync') => {
      const pairing = await harness.api('/api/device/pairings', { method: 'POST', skipUserHeader: true,
        body: { label: 'Portability phone', scope } });
      await harness.api('/api/account/device-pairings/approve', { method: 'POST', useSession: true,
        body: { verificationCode: pairing.verificationCode, budgetIds: [budgetId], writeBudgetIds: write ? [budgetId] : [] } });
      return harness.api('/api/device/pairings/poll', { method: 'POST', skipUserHeader: true, body: { deviceCode: pairing.deviceCode } });
    };
    const tokens = await pair(true);
    const readTokens = await pair(false);
    const snapshotTokens = await pair(false, 'app:snapshot:read');
    const otherDevice = await pair(true);
    const headers = { authorization: `Bearer ${tokens.accessToken}`, 'x-cashflow-budget-id': budgetId };
    const request = (path, body, extraHeaders = {}) => harness.request(path, { method: 'POST', skipUserHeader: true, headers: { ...headers, ...extraHeaders }, body });
    const binding = { protocolVersion: 1, instanceId: tokens.instanceId, accountId: budgetId, budgetId };
    const offer = { protocolVersions: [1], stateVersions: [3], financialModelVersions: [1], engineProtocolVersions: [ENGINE_PROTOCOL_VERSION], engineVersions: [ENGINE_VERSION] };
    const negotiation = await request('/api/app/sync/v1/negotiate', { ...binding, offer });
    const compatibility = negotiation.body.compatibility;
    const bootstrap = async () => {
      const result = await request('/api/app/sync/v1/bootstrap', { ...binding, compatibility });
      assert.equal(result.response.status, 200);
      return { expectedEpoch: result.body.epoch, expectedRevision: result.body.revision };
    };
    let expected = await bootstrap();
    const csv = 'name,type,amount,currency,date\nImported,income,500,PLN,2026-05-21';
    const csvBody = { ...expected, csv, mode: 'append' };
    const routes = ['/api/import/full/preview', '/api/import/full', '/api/import/one-offs-csv/preview', '/api/import/one-offs-csv'];
    for (const path of routes) {
      // Both valid read scopes are permission refusals, unlike missing/invalid credentials.
      for (const reader of [readTokens, snapshotTokens]) {
        assert.equal((await request(path, csvBody, { authorization: `Bearer ${reader.accessToken}` })).response.status, 403);
      }
      assert.equal((await request(path, csvBody, { 'x-cashflow-budget-id': 'not-granted' })).response.status, 401);
      assert.equal((await request(path, csvBody, { authorization: 'Bearer invalid' })).response.status, 401);
      assert.equal((await request(path, csvBody, { authorization: '' })).response.status, 401);
    }
    for (const reader of [readTokens, snapshotTokens]) {
      assert.equal((await request('/api/restore/missing', {}, { authorization: `Bearer ${reader.accessToken}` })).response.status, 403);
      assert.equal((await harness.request('/api/export/full', { skipUserHeader: true,
        headers: { ...headers, authorization: `Bearer ${reader.accessToken}` } })).response.status, 200);
    }
    for (const authorization of ['', 'Bearer invalid']) {
      assert.equal((await request('/api/restore/missing', {}, { authorization })).response.status, 401);
    }
    assert.equal((await request('/api/restore/missing', {}, { 'x-cashflow-budget-id': 'not-granted' })).response.status, 401);
    const preview = await request('/api/import/one-offs-csv/preview', csvBody);
    assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.response.headers.get('cache-control'), 'no-store');
    assert.equal((await request('/api/import/one-offs-csv', { ...csvBody, previewToken: preview.body.previewToken },
      { authorization: `Bearer ${otherDevice.accessToken}` })).body.details[0].code, 'IMPORT_PREVIEW_MISMATCH');
    assert.equal((await request('/api/import/one-offs-csv', { ...csvBody, mode: 'replace', previewToken: preview.body.previewToken })).body.details[0].code, 'IMPORT_PREVIEW_MISMATCH');
    assert.equal(preview.body.rows.length, 1);
    assert.deepEqual(preview.body.deleteOneOffIds, []);
    assert.deepEqual(preview.body.validationErrors, []);
    assert.equal((await request('/api/import/one-offs-csv', csvBody)).body.details[0].code, 'IMPORT_PREVIEW_MISMATCH');
    assert.equal((await request('/api/import/one-offs-csv', { ...csvBody, previewToken: preview.body.previewToken, csv: csv.replace('500', '501') })).body.details[0].code, 'IMPORT_PREVIEW_MISMATCH');
    assert.equal((await request('/api/import/one-offs-csv/preview', { ...csvBody, expectedEpoch: 'stale' })).body.details[0].code, 'IMPORT_EPOCH_CONFLICT');
    assert.equal((await request('/api/import/one-offs-csv/preview', { ...csvBody, expectedRevision: expected.expectedRevision + 1 })).body.details[0].code, 'IMPORT_REVISION_CONFLICT');
    assert.equal((await request('/api/import/one-offs-csv/preview', { csv })).body.details[0].code, 'IMPORT_SYNC_STATE_REQUIRED');
    const invalid = await request('/api/import/one-offs-csv/preview', { ...csvBody, csv: csv.replace('500', 'broken') });
    assert.equal(invalid.response.status, 400);
    assert.ok(invalid.body.details.length);
    assert.equal(invalid.body.previewToken, undefined);
    const appended = await request('/api/import/one-offs-csv', { ...csvBody, previewToken: preview.body.previewToken });
    assert.equal(appended.response.status, 200, JSON.stringify(appended.body));
    assert.equal(appended.body.rebootstrapRequired, true);
    assert.notEqual(appended.body.epoch, expected.expectedEpoch);
    assert.equal(appended.body.safetyBackupId, null);
    assert.equal((await request('/api/import/one-offs-csv', { ...csvBody, previewToken: preview.body.previewToken })).body.details[0].code, 'IMPORT_EPOCH_CONFLICT');
    expected = await bootstrap();
    const exported = await harness.api('/api/export/full', { skipUserHeader: true, headers });
    assert.equal(exported.planning.one_off_transactions[0].id, preview.body.rows[0].id);
    const replaceBody = { ...expected, csv: csv.replace('Imported', 'Replacement'), mode: 'replace' };
    const replacementPreview = await request('/api/import/one-offs-csv/preview', replaceBody);
    assert.deepEqual(replacementPreview.body.deleteOneOffIds, [preview.body.rows[0].id]);
    const replaced = await request('/api/import/one-offs-csv', { ...replaceBody, previewToken: replacementPreview.body.previewToken });
    assert.equal(replaced.response.status, 200, JSON.stringify(replaced.body));
    assert.match(replaced.body.safetyBackupId, /^backup-[0-9a-f-]{36}$/);
    const backups = await harness.api('/api/backups', { skipUserHeader: true, headers });
    assert.ok(backups.backups.some(row => row.id === replaced.body.safetyBackupId));
    assert.ok(backups.backups.every(row => !('backup_path' in row)));
    for (const row of backups.backups) assert.match(row.id, /^backup-[0-9a-f-]{36}$/);
    const restored = await request(`/api/restore/${replaced.body.safetyBackupId}`, {});
    assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.rebootstrapRequired, true);
    assert.match(restored.body.safetyBackupId, /^backup-[0-9a-f-]{36}$/);
    const afterRestore = await harness.api('/api/export/full', { skipUserHeader: true, headers });
    assert.equal(afterRestore.planning.one_off_transactions[0].name, 'Imported');
    expected = await bootstrap();
    const fullBody = { ...expected, export: exported, mode: 'replace', includeOperationalSettings: true };
    const fullPreview = await request('/api/import/full/preview', fullBody);
    assert.equal(fullPreview.response.status, 200, JSON.stringify(fullPreview.body));
    const changedFile = structuredClone(exported);
    changedFile.exportedAt = '2000-01-01';
    assert.equal((await request('/api/import/full', { ...fullBody, export: changedFile, previewToken: fullPreview.body.previewToken })).body.details[0].code, 'IMPORT_PREVIEW_MISMATCH');
    const imported = await request('/api/import/full', { ...fullBody, previewToken: fullPreview.body.previewToken });
    assert.equal(imported.response.status, 200, JSON.stringify(imported.body));
    assert.match(imported.body.safetyBackupId, /^backup-[0-9a-f-]{36}$/);
    assert.equal((await request(`/api/restore/${imported.body.safetyBackupId}`, {})).response.status, 200);
    assert.notEqual(imported.body.epoch, expected.expectedEpoch);
    assert.equal(imported.body.rebootstrapRequired, true);
    assert.ok((await harness.api('/api/backups', { skipUserHeader: true, headers })).backups.some(row => row.id === imported.body.safetyBackupId));
    // A browser write between review and confirmation must invalidate the token.
    expected = await bootstrap();
    const reviewed = await request('/api/import/one-offs-csv/preview', { ...csvBody, ...expected });
    await harness.api('/api/one-off', { method: 'POST', useSession: true, headers: { 'x-cashflow-budget-id': budgetId },
      body: { name: 'Browser change', type: 'income', amount: 10, currency: 'PLN', date: '2026-05-22' } });
    const stale = await request('/api/import/one-offs-csv', { ...csvBody, ...expected, previewToken: reviewed.body.previewToken });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.details[0].code, 'IMPORT_REVISION_CONFLICT');
    await harness.cashflow.globalStore.transaction(repo => repo.accounts.insert({ id: 'recovery-owner', displayName: 'Recovery owner' }));
    await harness.cashflow.globalStore.transaction(repo => repo.memberships.updateOwnerAccount({ budgetId, fromAccountId: budgetId, toAccountId: 'recovery-owner' }));
    await harness.cashflow.globalStore.transaction(repo => repo.memberships.insert({ budgetId, accountId: budgetId, role: 'manager' }));
    // The grant never overrides the account's current role.
    for (const path of routes) assert.equal((await request(path, csvBody)).response.status, 403);
  } finally {
    await harness.cleanup();
    setTodayOverrideForTests(previousToday);
  }
}

test('SQLite device portability validates, binds previews, rotates epochs and restores safety backups', () => verifyPortability());
test('PostgreSQL device portability validates, binds previews, rotates epochs and restores safety backups', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, async () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try { await global.initialize(); await budget.initialize(); }
  finally { await global.close(); await budget.close(); }
  await verifyPortability({ backend: 'postgres', supported: true, external: true, databaseUrlConfigured: true });
}));
