import assert from "node:assert/strict";
import test from "node:test";
import { ENGINE_VERSION } from "../../src/engine/index.js";
import { appSyncCapabilities, assertAppSyncBinding, negotiateAppSync, normalizeSyncOffer, normalizeSyncNegotiation,
  normalizeSyncBootstrapStart, normalizeSyncBootstrapPage, normalizeSyncSubmission, normalizeSyncResultLookup,
  normalizeSyncChanges } from "../../src/server/cashflow-app-sync-contract.js";

const instanceId = "12345678-1234-4234-8234-123456789abc";
const epoch = "23456789-1234-4234-8234-123456789abc";
const operationId = "34567890-1234-4234-8234-123456789abc";
const binding = { protocolVersion: 1, instanceId, accountId: "opaque-account", budgetId: "budget-one" };
const offer = { protocolVersions: [2, 1], stateVersions: [1, 2, 3], financialModelVersions: [1], engineProtocolVersions: [1], engineVersions: ["0.1.0-poc", ENGINE_VERSION] };
const compatibility = negotiateAppSync(offer);

test("negotiation selects reproducible financial rules without enabling writes", () => {
  const input = structuredClone(offer);
  assert.equal(compatibility.engineVersion, ENGINE_VERSION);
  assert.equal(compatibility.stateVersion, 3);
  assert.deepEqual(normalizeSyncNegotiation({ ...binding, offer }), { ...binding, offer });
  assert.deepEqual(offer, input);
  const descriptor = appSyncCapabilities();
  // The static descriptor never enables sync; only an authenticated negotiation does.
  assert.equal(descriptor.enabled, false);
  assert.equal(descriptor.status, "negotiated-per-device");
  descriptor.implementedOperationKinds.push("ledger.replace");
  assert.equal(appSyncCapabilities().implementedOperationKinds.includes("ledger.replace"), false);
  assert.ok(appSyncCapabilities().implementedOperationKinds.includes("occurrence.confirm"));
});

test("unknown engines/schema versions require compatibility instead of optimistic fallback", () => {
  for (const change of [{ protocolVersions: [9] }, { stateVersions: [1] }, { stateVersions: [2] }, { financialModelVersions: [2] }, { engineProtocolVersions: [2] }, { engineVersions: ["99.0.0"] }]) {
    assert.throws(() => negotiateAppSync({ ...offer, ...change }), error => error.code === "COMPATIBILITY_REQUIRED");
  }
  for (const change of [{ protocolVersions: ["1"] }, { stateVersions: [1, 1] }, { engineVersions: [] },
    { engineVersions: [ENGINE_VERSION, ENGINE_VERSION] }, { financialModelVersions: [1.5] }, { engineVersions: ["latest"] }]) {
    assert.throws(() => normalizeSyncOffer({ ...offer, ...change }), error => error.code === "INVALID_SYNC_REQUEST");
  }
});

test("every request binds immutable instance/account/budget identity without coercion", () => {
  const requests = [
    [normalizeSyncBootstrapStart, { ...binding, compatibility }],
    [normalizeSyncBootstrapPage, { ...binding, bootstrapId: operationId, pageToken: "opaque_page_token_123", limit: 100 }],
    [normalizeSyncResultLookup, { ...binding, epoch, operationId }],
    [normalizeSyncChanges, { ...binding, epoch, afterRevision: 0, limit: 1 }]
  ];
  for (const [normalize, input] of requests) {
    const normalized = normalize(input);
    assertAppSyncBinding(normalized, binding);
    for (const field of ["instanceId", "accountId", "budgetId"]) {
      const wrong = { ...binding, [field]: field === "instanceId" ? epoch : "another-identity" };
      assert.throws(() => assertAppSyncBinding(normalized, wrong), error => error.code === "SYNC_BINDING_MISMATCH");
      assert.throws(() => normalize({ ...input, [field]: 12 }));
    }
    assert.throws(() => normalize({ ...input, snapshotToken: "preview-fingerprint" }));
    assert.throws(() => normalize({ ...input, protocolVersion: "1" }));
  }
});

test("operation envelopes reuse strict financial normalization and reject foreign targets/plans", () => {
  const operation = { version: 1, operationId, budgetId: binding.budgetId, epoch, baseRevision: 0, kind: "one-off.create",
    payload: { id: "45678901-1234-4234-8234-123456789abc", name: "Synthetic source", currency: "PLN", amount: 10, type: "expense", date: "2026-06-01" } };
  const input = { ...binding, compatibility, operation };
  assert.equal(normalizeSyncSubmission(input).operation.operationId, operationId);
  assert.throws(() => normalizeSyncSubmission({ ...input, budgetId: "another-budget" }), error => error.code === "SYNC_BINDING_MISMATCH");
  assert.throws(() => normalizeSyncSubmission({ ...input, operation: { ...operation, kind: "ledger.replace" } }));
  assert.throws(() => normalizeSyncSubmission({ ...input, operation: { ...operation, payload: { ...operation.payload, plan: {} } } }));
});

test("opaque bootstrap pagination is bounded and lookup stays independent of engine upgrades", () => {
  const input = { ...binding, bootstrapId: operationId, pageToken: "opaque_page_token_123", limit: 100 };
  for (const change of [{ pageToken: "short" }, { pageToken: "x".repeat(257) }, { limit: 101 }, { limit: "100" }, { limit: 0 }]) {
    assert.throws(() => normalizeSyncBootstrapPage({ ...input, ...change }));
  }
  const lookup = normalizeSyncResultLookup({ ...binding, epoch, operationId });
  assert.equal(lookup.operationId, operationId);
  assert.equal(Object.hasOwn(lookup, "compatibility"), false);
  assert.throws(() => normalizeSyncChanges({ ...binding, epoch, afterRevision: "0", limit: 1 }));
});
