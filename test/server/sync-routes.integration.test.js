import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "../../src/engine/index.js";

const offer = { protocolVersions: [1], stateVersions: [3], financialModelVersions: [1],
  engineProtocolVersions: [ENGINE_PROTOCOL_VERSION], engineVersions: [ENGINE_VERSION] };

/** Browser-approved financial-sync device using the real HTTP routes end to end. */
async function verifySyncRoutes(databaseConfig) {
  const harness = await createCashflowTestHarness({ initializeUser: false, databaseConfig });
  try {
    await harness.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: "sync-owner", displayName: "Owner", email: "sync@example.test" } });
    await harness.api("/api/account/password", { method: "POST", useSession: true, body: { newPassword: "sync owner correct horse" } });
    await harness.api("/api/admin/auth/draft", { method: "PUT", useSession: true, body: { draftMode: "internal" } });
    await harness.api("/api/admin/auth/activate", { method: "POST", useSession: true, body: {} });
    await harness.api("/api/auth/internal/login", { method: "POST", skipUserHeader: true,
      body: { email: "sync@example.test", password: "sync owner correct horse" } });
    const pairing = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true,
      body: { label: "Sync phone", scope: "app:financial:sync" } });
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: pairing.verificationCode, budgetIds: ["sync-owner"], writeBudgetIds: ["sync-owner"] } });
    const tokens = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true, body: { deviceCode: pairing.deviceCode } });
    const binding = { protocolVersion: 1, instanceId: tokens.instanceId, accountId: "sync-owner", budgetId: "sync-owner" };
    const headers = { authorization: `Bearer ${tokens.accessToken}` };
    const post = (path, body, extra = {}) => harness.request(`/api/app/sync/v1/${path}`, { method: "POST", skipUserHeader: true,
      headers: { ...headers, ...extra.headers }, body, useSession: extra.useSession });
    const negotiated = await post("negotiate", { ...binding, offer });
    assert.equal(negotiated.response.status, 200);
    assert.equal(negotiated.response.headers.get("cache-control"), "no-store");
    assert.equal(negotiated.body.enabled, true);
    assert.ok(negotiated.body.supportedOperationKinds.includes("occurrence.confirm"));
    const compatibility = negotiated.body.compatibility;
    // Authentication and binding are enforced before any work.
    assert.equal((await harness.request("/api/app/sync/v1/negotiate", { method: "POST", skipUserHeader: true, body: { ...binding, offer } })).response.status, 401);
    assert.equal((await post("negotiate", { ...binding, offer }, { headers: { authorization: "Bearer cfda1_" + "A".repeat(43) } })).response.status, 401);
    assert.equal((await post("negotiate", { ...binding, offer }, { useSession: true })).response.status, 401);
    const foreign = await post("negotiate", { ...binding, instanceId: randomUUID(), offer });
    assert.deepEqual([foreign.response.status, foreign.body], [403, { error: { code: "SYNC_BINDING_MISMATCH" } }]);
    const malformed = await post("operations", { ...binding, compatibility, operation: { kind: "ledger.replace" } });
    assert.deepEqual([malformed.response.status, malformed.body], [400, { error: { code: "INVALID_SYNC_REQUEST" } }]);
    const manifest = await post("bootstrap", { ...binding, compatibility });
    assert.equal(manifest.response.status, 200);
    const { epoch, revision } = manifest.body;
    const operation = { version: 1, operationId: randomUUID(), budgetId: "sync-owner", epoch, baseRevision: revision, kind: "recurring-income.create",
      payload: { id: randomUUID(), name: "Salary", currency: "PLN", amount: 5000, anchor_type: "day_of_month", anchor_day_of_month: 10 } };
    const submitted = await post("operations", { ...binding, compatibility, operation });
    assert.equal(submitted.response.status, 200);
    assert.deepEqual([submitted.body.replayed, submitted.body.receipt.revision, submitted.body.receipt.sourceId], [false, revision + 1, operation.payload.id]);
    assert.equal((await post("operations", { ...binding, compatibility, operation })).body.replayed, true);
    const conflict = await post("operations", { ...binding, compatibility, operation: { ...operation, operationId: randomUUID() } });
    assert.deepEqual([conflict.response.status, conflict.body], [409, { error: { code: "REVISION_CONFLICT" } }]);
    // A server validation refusal is a safe, explicit rejection: no message, nothing committed.
    const refused = await post("operations", { ...binding, compatibility, operation: { ...operation, operationId: randomUUID(),
      baseRevision: revision + 1, kind: "recurring-expense.create", payload: { id: randomUUID(), name: "Rent", currency: "PLN", amount: 10,
        anchor_income_id: "missing-income" } } });
    assert.deepEqual([refused.response.status, refused.body], [422, { error: { code: "OPERATION_REJECTED" } }]);
    const found = await post("results", { ...binding, epoch, operationId: operation.operationId });
    assert.deepEqual([found.body.status, found.body.receipt.revision], ["accepted", revision + 1]);
    const changes = await post("changes", { ...binding, epoch, afterRevision: revision, limit: 10 });
    assert.deepEqual(changes.body.changes.map(change => change.kind), ["recurring-income.create"]);
    // Confirm an old actual payment through the real server actions, then
    // correct it through the paired device. Both remain visible in full export.
    const snapshot = await harness.api('/api', { useSession: true, headers: { 'x-cashflow-budget-id': 'sync-owner' } });
    const due = [...snapshot.pendingTransactions, ...snapshot.futureTransactions]
      .find(row => row.source_recurring_income_id === operation.payload.id);
    assert.ok(due);
    const confirm = { version: 1, operationId: randomUUID(), budgetId: 'sync-owner', epoch, baseRevision: revision + 1,
      kind: 'occurrence.confirm', payload: { occurrenceKey: due.occurrence_key, amount: 100, confirmedDate: '2018-01-01', fxRate: null } };
    assert.equal((await post('operations', { ...binding, compatibility, operation: confirm })).response.status, 200);
    const captured = await harness.api('/api/export/full', { useSession: true, headers: { 'x-cashflow-budget-id': 'sync-owner' } });
    const payment = Object.values(captured.ledgers).flat().find(row => row.occurrence_key === due.occurrence_key);
    assert.ok(payment);
    const original = captured.ledgerAudit.originals.find(item => item.row.id === payment.id);
    assert.equal(original.actorId, binding.accountId);
    assert.equal(original.captureKind, 'payment');
    const correction = { version: 1, operationId: randomUUID(), budgetId: 'sync-owner', epoch, baseRevision: revision + 2,
      kind: 'ledger.correct', payload: { targetId: payment.id, expectedCorrectionId: null, retryOf: null,
        replacement: { amount: 75, date: '2018-01-01' }, reason: 'Reviewed actual historical income' } };
    const corrected = await post('operations', { ...binding, compatibility, operation: correction });
    assert.equal(corrected.response.status, 200, JSON.stringify(corrected.body));
    assert.equal(corrected.body.receipt.revision, revision + 3);
    assert.equal((await post('operations', { ...binding, compatibility, operation: correction })).body.replayed, true);
    const forged = await post('operations', { ...binding, compatibility, operation: { ...correction,
      operationId: randomUUID(), baseRevision: revision + 3, payload: { ...correction.payload, actorId: 'forged-account' } } });
    assert.deepEqual([forged.response.status, forged.body], [400, { error: { code: 'INVALID_SYNC_REQUEST' } }]);
    // The web app sees the synchronized source through its own routes.
    const exported = await harness.api("/api/export/full", { useSession: true, headers: { "x-cashflow-budget-id": "sync-owner" } });
    assert.ok(JSON.stringify(exported).includes(operation.payload.id));
    assert.equal(exported.ledgers['2018'].find(row => row.id === payment.id).amount, 75);
    assert.equal(exported.ledgerAudit.originals.find(item => item.row.id === payment.id).row.amount, 100);
    assert.equal(exported.ledgerAudit.corrections.length, 1);
    assert.equal(exported.ledgerAudit.corrections[0].id, correction.operationId);
    assert.equal(exported.ledgerAudit.corrections[0].actorId, binding.accountId);
  } finally { await harness.cleanup(); }
}

test("financial sync routes run a device journey over HTTP on SQLite", () => verifySyncRoutes());

test("financial sync routes run a device journey over HTTP on PostgreSQL", {
  skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests"
}, async () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl });
  try { await global.initialize(); await budget.initialize(); } finally { await global.close(); await budget.close(); }
  await verifySyncRoutes({ backend: "postgres", supported: true, external: true, databaseUrlConfigured: true });
}));
