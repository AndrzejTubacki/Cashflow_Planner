import { currencyTransferFixture } from '../helpers/currency-transfer-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { appSyncCapabilities } from '../../src/server/cashflow-app-sync-contract.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { decodeLedgerAuditRecords } from '../../src/engine/ledger-audit-transport.js';

/** Full actual HTTP/module/device journeys on synthetic storage. Provider
 * responses are injected; no Internet, live account or private budget is used. */
async function exercise(databaseConfig) {
  const calls = [];
  const harness = await createCashflowTestHarness({ initializeUser: false, databaseConfig, today: '2026-06-02',
    fetchImpl: async url => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ base: 'EUR', date: '2026-06-01', rates: { PLN: 5 } }) };
    } });
  try {
    await harness.api('/api/users', { method: 'POST', skipUserHeader: true,
      body: { userId: 'transfer-owner', displayName: 'Synthetic owner', email: 'transfer-owner@example.test' } });
    await harness.api('/api/account/password', { method: 'POST', useSession: true, body: { newPassword: 'synthetic transfer correct horse' } });
    await harness.api('/api/admin/auth/draft', { method: 'PUT', useSession: true, body: { draftMode: 'internal' } });
    await harness.api('/api/admin/auth/activate', { method: 'POST', useSession: true, body: {} });
    await harness.api('/api/auth/internal/login', { method: 'POST', skipUserHeader: true,
      body: { email: 'transfer-owner@example.test', password: 'synthetic transfer correct horse' } });
    const enroll = async mayCreateBudgets => {
      const pairing = await harness.api('/api/device/pairings', { method: 'POST', skipUserHeader: true,
        body: { label: 'Synthetic transfer Android', scope: 'app:financial:sync' } });
      await harness.api('/api/account/device-pairings/approve', { method: 'POST', useSession: true,
        body: { verificationCode: pairing.verificationCode, budgetIds: ['transfer-owner'], writeBudgetIds: ['transfer-owner'], mayCreateBudgets } });
      return harness.api('/api/device/pairings/poll', { method: 'POST', skipUserHeader: true, body: { deviceCode: pairing.deviceCode } });
    };
    const tokens = await enroll(true), noCreate = await enroll(false);
    const { protocolVersion, financialModelVersion, stateVersion, engineProtocolVersion, engineVersion } = appSyncCapabilities();
    const compatibility = { protocolVersion, financialModelVersion, stateVersion, engineProtocolVersion, engineVersion };
    const source = standaloneOriginAuditFixture({ currency: 'EUR', amount: 50 }).snapshot;
    source.request.fxSnapshot['eur/pln'].source = 'frankfurter';
    source.request.fxSnapshot['eur/pln'].effectiveDate = '2026-05-01';
    source.request.fxSnapshot['usd/pln'] = { rate: 3.5, source: 'manual', effectiveDate: '2020-01-01' };
    const input = { version: 1, transferId: randomUUID(), instanceId: tokens.instanceId, accountId: tokens.accountId,
      deviceId: tokens.deviceId, name: 'Reviewed uploaded budget', source, compatibility };
    const lookup = Object.fromEntries(['version', 'transferId', 'instanceId', 'accountId', 'deviceId'].map(key => [key, input[key]]));
    const request = (method, body, headers = {}, token = tokens.accessToken) => harness.request(`/api/device/standalone-transfers/${method}`,
      { method: 'POST', skipUserHeader: true, headers: { authorization: `Bearer ${token}`, ...headers }, body });
    const budgets = async () => (await harness.api('/api/budgets', { useSession: true })).budgets.map(row => row.id).sort();
    const before = await budgets();
    const formats = await request('formats', lookup);
    assert.equal(formats.response.status, 200);
    assert.deepEqual(formats.body, { ...lookup, sourceVersions: [1, 2, 3] });
    assert.equal((await request('formats', lookup, {}, noCreate.accessToken)).response.status, 401);
    assert.equal((await request('review', input, {}, noCreate.accessToken)).response.status, 401);
    assert.deepEqual(calls, []);
    for (const headers of [{ cookie: 'synthetic-forbidden' }, { 'x-cashflow-user-id': 'transfer-owner' }, { 'x-cashflow-budget-id': 'transfer-owner' }]) {
      for (const method of ['review', 'submit', 'result', 'cancel']) {
        const rejected = await request(method, input, headers);
        assert.equal(rejected.response.status, 401);
        assert.equal(rejected.response.headers.get('cache-control'), 'no-store');
      }
    }
    const old = await request('review', { ...input, compatibility: { ...compatibility, stateVersion: 2 } });
    assert.equal(old.response.status, 409);
    assert.deepEqual(old.body, { error: { code: 'COMPATIBILITY_REQUIRED' } });
    const invalid = structuredClone(input); invalid.source.localHistory[0].amount = 1;
    const refused = await request('submit', invalid);
    assert.equal(refused.response.status, 400);
    assert.deepEqual(refused.body, { error: { code: 'INVALID_TRANSFER_SOURCE' } });
    assert.deepEqual(await budgets(), before);
    const reviewed = await request('review', input);
    assert.equal(reviewed.response.status, 200);
    assert.equal(reviewed.response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls, ['https://api.frankfurter.app/latest?from=EUR&to=PLN']);
    assert.deepEqual(reviewed.body.source.localAudit, input.source.localAudit);
    assert.equal(reviewed.body.source.request.fxSnapshot['eur/pln'].rate, 5);
    assert.deepEqual(reviewed.body.source.request.fxSnapshot['usd/pln'], input.source.request.fxSnapshot['usd/pln']);
    assert.deepEqual(await budgets(), before, 'review must not allocate a budget');
    assert.equal((await request('result', lookup)).body.receipt, null);
    const frozen = { ...input, source: reviewed.body.source };
    const submitted = await request('submit', frozen);
    assert.equal(submitted.response.status, 200);
    const receipt = submitted.body;
    assert.equal(receipt.state, 'accepted');
    assert.deepEqual((await request('submit', frozen)).body, receipt);
    assert.deepEqual((await request('result', lookup)).body.receipt, receipt);
    assert.ok((await request('result', lookup)).body.grant.writeBudgetIds.includes(receipt.budgetId));
    assert.equal((await request('review', frozen)).response.status, 409);
    assert.equal((await budgets()).length, before.length + 1);
    const scope = { protocolVersion: 1, instanceId: input.instanceId, accountId: input.accountId, budgetId: receipt.budgetId };
    const sync = async (method, body) => harness.api(`/api/app/sync/v1/${method}`, { method: 'POST', skipUserHeader: true,
      headers: { authorization: `Bearer ${tokens.accessToken}` }, body });
    const manifest = await sync('bootstrap', { ...scope, compatibility });
    const auditRecords = [], ledger = [];
    for (let token = manifest.firstPageToken; token;) {
      const page = await sync('bootstrap/page', { ...scope, bootstrapId: manifest.bootstrapId, pageToken: token, limit: 100 });
      if (page.part === 'ledger-audit') auditRecords.push(...page.records);
      if (page.part === 'ledger') ledger.push(...page.records);
      token = page.nextPageToken;
    }
    assert.deepEqual(decodeLedgerAuditRecords(auditRecords, receipt.budgetId, { allowStandaloneOrigins: true }).origin.events, input.source.localAudit);
    assert.equal(ledger[0].fx_rate, 4.2);
    assert.equal(ledger[0].running_balance_pln, 290);
    // New origin proof survives publication, accepted download and H5 replay.
    for (const stage of ['pending', 'confirmed', 'voided', 'returned']) {
      const currencySource = currencyTransferFixture(stage, true);
      const upload = { ...input, transferId: randomUUID(), source: currencySource };
      const review = await request('review', upload);
      assert.equal(review.response.status, 200);
      assert.equal(review.body.source.transferVersion, 2);
      const accepted = await request('submit', { ...upload, source: review.body.source });
      assert.equal(accepted.response.status, 200);
      const currencyScope = { ...scope, budgetId: accepted.body.budgetId };
      const manifest = await sync('bootstrap', { ...currencyScope, compatibility });
      const parts = {};
      for (let token = manifest.firstPageToken; token;) {
        const page = await sync('bootstrap/page', { ...currencyScope, bootstrapId: manifest.bootstrapId, pageToken: token, limit: 100 });
        (parts[page.part] ??= []).push(...page.records); token = page.nextPageToken;
      }
      const origin = decodeLedgerAuditRecords(parts['ledger-audit'], accepted.body.budgetId, { allowStandaloneOrigins: true }).origin;
      assert.equal(origin.version, 2);
      assert.deepEqual(origin.events, currencySource.localAudit);
      assert.equal(parts['currency-events'].length, stage === 'returned' ? 2 : 1);
      assert.equal(parts.planning.filter(record => record.table === 'pending_transactions' && record.row.occurrence_key?.startsWith('ledger_currency_conversion:')).length, stage === 'pending' ? 1 : 0);
    }
    const names = await harness.api('/api/device/budgets', { skipUserHeader: true, headers: { authorization: `Bearer ${tokens.accessToken}` } });
    assert.ok(names.budgets.some(budget => budget.id === receipt.budgetId));
    const { compatibility: _compatibility, ...cancellation } = frozen;
    assert.deepEqual((await request('cancel', cancellation)).body, receipt);
    assert.equal((await budgets()).length, before.length + 5);
    const withdrawn = { ...cancellation, transferId: randomUUID() };
    for (const authorization of ['', 'Basic synthetic', `bearer ${tokens.accessToken}`]) {
      assert.equal((await request('cancel', withdrawn, { authorization })).response.status, 401);
    }
    const cancelled = await request('cancel', withdrawn);
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.response.headers.get('cache-control'), 'no-store');
    assert.equal(cancelled.body.state, 'cancelled');
    assert.deepEqual((await request('cancel', withdrawn)).body, cancelled.body);
    assert.deepEqual((await request('submit', { ...withdrawn, compatibility })).body, cancelled.body);
    assert.equal((await request('review', { ...withdrawn, compatibility })).response.status, 409);
    const withdrawnLookup = { ...lookup, transferId: withdrawn.transferId };
    assert.deepEqual((await request('result', withdrawnLookup)).body.receipt, cancelled.body);
    const reused = await request('cancel', { ...withdrawn, name: 'Different input' });
    assert.equal(reused.response.status, 409);
    assert.equal(reused.body.error.code, 'TRANSFER_ID_REUSED');
    // A financial device without creation permission can withdraw its own job
    // without engine compatibility or provider IO, but cannot review/submit it.
    const recovery = { ...withdrawn, transferId: randomUUID(), deviceId: noCreate.deviceId };
    const beforeRecovery = calls.length;
    const recovered = await request('cancel', recovery, {}, noCreate.accessToken);
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.body.state, 'cancelled');
    assert.equal((await request('cancel', recovery)).response.status, 403);
    for (const method of ['review', 'submit']) {
      assert.equal((await request(method, { ...recovery, compatibility }, {}, noCreate.accessToken)).response.status, 401);
    }
    assert.deepEqual((await request('result', { ...lookup, transferId: recovery.transferId, deviceId: noCreate.deviceId }, {}, noCreate.accessToken)).body.receipt, recovered.body);
    assert.equal(calls.length, beforeRecovery);
    assert.equal((await budgets()).length, before.length + 5);
    assert.ok(!harness.errors.some(row => /rollback_failed|projection_failed/.test(row.kind)));
  } finally {
    await harness.cleanup();
    // Regression: cleanup previously referenced a nonexistent public
    // budgetStore property, leaving the actual financial PG pool usable.
    if (databaseConfig?.backend === 'postgres') await assert.rejects(harness.cashflow.getSnapshotAsync('transfer-owner'), /pool after calling end/);
  }
}

test('SQLite standalone transfer HTTP review/submit/result preserves history and creates a grant usable by actual bootstrap', () => exercise());
test('PostgreSQL standalone transfer HTTP review/submit/result preserves history and creates a grant usable by actual bootstrap', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try { await global.initialize(); await budget.initialize(); }
  finally { await global.close(); await budget.close(); }
  await exercise({ backend: 'postgres', supported: true, external: true, databaseUrlConfigured: true });
}));
