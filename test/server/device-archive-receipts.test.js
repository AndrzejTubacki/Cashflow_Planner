import test from 'node:test';
import assert from 'node:assert/strict';
import { withStandaloneTransferPublisherFixture } from '../helpers/standalone-transfer-publisher-fixture.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createDeviceService } from '../../src/server/cashflow-device-service.js';

/** Real global transactions on both stores; receipt tests never bind a server. */
async function exercise(f) {
  const token = f.tokens.accessToken;
  const budgetId = 'transfer-existing';
  const peer = await f.enroll();
  const alreadyRevoked = await f.enroll();
  await f.device.revoke('transfer-owner', alreadyRevoked.deviceId);
  assert.deepEqual(await f.device.archiveReceipt(token, budgetId, 'removal-1'), { state: 'not-found' });
  const receipt = await f.device.archiveBudget(token, budgetId, 'removal-1');
  assert.equal(receipt.receipt.expiresMs - Date.parse(receipt.receipt.archivedAt), 86400000);
  assert.equal(receipt.receipt.status, 'archived');
  assert.deepEqual(await f.device.archiveBudget(token, budgetId, 'removal-1'), receipt);
  await assert.rejects(f.device.archiveBudget(token, budgetId, 'removal-2'));
  await assert.rejects(f.device.archiveBudget(token, 'other-budget', 'removal-1'));
  await assert.rejects(f.device.archiveReceipt(token, budgetId, 'removal-2'));
  await assert.rejects(f.device.archiveReceipt(token, 'other-budget', 'removal-1'));
  assert.deepEqual(await f.device.archiveReceipt(peer.accessToken, budgetId, 'removal-1'), { state: 'not-found' });
  for (const action of [
    () => f.device.authorize(token, budgetId),
    () => f.device.authorize(token, 'other-budget'),
    () => f.device.authorizeBudgetAccess(token, budgetId, false),
    () => f.device.authorizeBudgetAccess(token, budgetId, true),
    () => f.device.listBudgetNames(token),
    () => f.device.authorizeBudgetCreation(token),
    () => f.store.transaction(tx => f.device.authorizeFinancialWrite(tx, token, budgetId, 'budget:read')),
    () => f.store.transaction(tx => f.device.authorizeFinancialWrite(tx, token, budgetId, 'planner:write')),
    () => f.store.transaction(tx => f.device.authorizeTransferRecoveryInTransaction(tx, token)),
    () => f.device.renew(f.tokens.renewalToken),
    () => f.device.revokeWithRenewal(f.tokens.renewalToken)
  ]) await assert.rejects(action, error => error.status === 401);
  // Receipt capability survives normal access expiry, without rotation/renewal.
  f.advance(16 * 60000);
  assert.deepEqual((await f.device.archiveReceipt(token, budgetId, 'removal-1')).receipt, receipt.receipt);
  assert.deepEqual(await f.device.archiveBudget(token, budgetId, 'removal-1'), receipt);
  assert.equal((await f.device.archiveReceipt(token, budgetId, 'removal-1', true)).revoked, true);
  await assert.rejects(f.device.archiveReceipt(token, budgetId, 'removal-1'), error => error.status === 401);
  await assert.rejects(f.device.archiveBudget(token, budgetId, 'removal-1'), error => error.status === 401);
  const states = await f.sql('SELECT id, revoked_ms FROM app_devices');
  assert.notEqual(states.find(row => row.id === f.tokens.deviceId).revoked_ms, null);
  assert.equal(states.find(row => row.id === peer.deviceId).revoked_ms, null);
  assert.notEqual(states.find(row => row.id === alreadyRevoked.deviceId).revoked_ms, null);
  assert.ok(!JSON.stringify(receipt).includes('tokenHash'));
}
/** Configurable timeout revokes without an acknowledgement, even if access
 * token is still within its ordinary lifetime. Failed lookup commits revocation. */
async function timeout(f) {
  let clock = Date.parse('2026-06-02T12:00:00Z');
  const service = createDeviceService({ store: f.store, now: () => clock, archiveReceiptTimeoutMs: 60000 });
  const receipt = await service.archiveBudget(f.tokens.accessToken, 'transfer-existing', 'timeout-removal');
  clock += 60000;
  await assert.rejects(service.archiveReceipt(f.tokens.accessToken, 'transfer-existing', 'timeout-removal'), error => error.status === 401);
  assert.notEqual((await f.sql('SELECT revoked_ms FROM app_devices WHERE id = ?', [f.tokens.deviceId]))[0].revoked_ms, null);
  await assert.rejects(service.archiveBudget(f.tokens.accessToken, 'transfer-existing', 'timeout-removal'));
  assert.equal(receipt.receipt.expiresMs, clock);
}
for (const [name, run] of [['receipt window and ack', exercise], ['configured timeout', timeout]]) {
  test(`SQLite device archive ${name}`, () => withStandaloneTransferPublisherFixture(run));
  test(`PostgreSQL device archive ${name}`, { skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable PostgreSQL tests' },
    () => withDisposablePostgresDb(({ databaseUrl }) => withStandaloneTransferPublisherFixture(run, databaseUrl)));
}

test('SQLite archive restriction write failure rolls back archival with no receipt', () => withStandaloneTransferPublisherFixture(async f => {
  await f.sql("CREATE TRIGGER ignore_archive_restriction BEFORE UPDATE OF state_json ON app_devices BEGIN SELECT RAISE(IGNORE); END");
  await assert.rejects(f.device.archiveBudget(f.tokens.accessToken, 'transfer-existing', 'failed-checkpoint'), /not recorded atomically/);
  assert.equal((await f.sql("SELECT status FROM budgets WHERE id = 'transfer-existing'"))[0].status, 'active');
  assert.deepEqual(await f.device.archiveReceipt(f.tokens.accessToken, 'transfer-existing', 'failed-checkpoint'), { state: 'not-found' });
  assert.equal((await f.device.authorize(f.tokens.accessToken, 'transfer-existing')).deviceId, f.tokens.deviceId);
}));

test('archive requires an explicit financial write grant', () => withStandaloneTransferPublisherFixture(async f => {
  const pairing = await f.device.createPairing('Read only phone');
  await f.device.approve({ verificationCode: pairing.verificationCode, accountId: 'transfer-owner', sessionId: 'transfer-session', budgetIds: ['transfer-existing'] });
  const reader = await f.device.poll(pairing.deviceCode);
  await assert.rejects(f.device.archiveBudget(reader.accessToken, 'transfer-existing', 'read-only-removal'), error => error.status === 401);
  assert.equal((await f.sql("SELECT status FROM budgets WHERE id = 'transfer-existing'"))[0].status, 'active');
}));

test('receipt capability binds the exact archival token and independent revocation wins', () => withStandaloneTransferPublisherFixture(async f => {
  const rotated = await f.device.renew(f.tokens.renewalToken);
  await f.device.archiveBudget(f.tokens.accessToken, 'transfer-existing', 'exact-token-removal');
  await assert.rejects(f.device.archiveReceipt(rotated.accessToken, 'transfer-existing', 'exact-token-removal'), error => error.status === 401);
  assert.equal((await f.device.archiveReceipt(f.tokens.accessToken, 'transfer-existing', 'exact-token-removal')).state, 'archived');
  await f.device.revoke('transfer-owner', f.tokens.deviceId);
  await assert.rejects(f.device.archiveReceipt(f.tokens.accessToken, 'transfer-existing', 'exact-token-removal'), error => error.status === 401);
}));
