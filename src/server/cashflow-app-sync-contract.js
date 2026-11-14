import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "../engine/index.js";
import { APP_OPERATION_KINDS, normalizeAppOperation, normalizeAppChangesRequest, appOperationError } from "./cashflow-app-operation-contract.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPE = ["protocolVersion", "instanceId", "accountId", "budgetId"];

/** Exact JSON envelopes prevent previews, unknown fields or generated plans
 * from being mistaken for an operation supported by this protocol revision. */
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw appOperationError("INVALID_SYNC_REQUEST");
}
/** The immutable server/account/budget triple is present on every sync request,
 * including retries and result lookup. Names/origins never supply identity. */
function scope(input) {
  if (input.protocolVersion !== 1 || typeof input.instanceId !== "string" || !UUID.test(input.instanceId)
    || typeof input.accountId !== "string" || !ID.test(input.accountId)
    || typeof input.budgetId !== "string" || !ID.test(input.budgetId)) throw appOperationError("INVALID_SYNC_REQUEST");
  return { protocolVersion: 1, instanceId: input.instanceId.toLowerCase(), accountId: input.accountId, budgetId: input.budgetId };
}
/** Bounded offers allow future versions without coercing malformed values or
 * choosing an engine whose financial behavior the client cannot reproduce. */
export function normalizeSyncOffer(input) {
  exact(input, ["protocolVersions", "stateVersions", "financialModelVersions", "engineProtocolVersions", "engineVersions"]);
  const result = {};
  for (const field of ["protocolVersions", "stateVersions", "financialModelVersions", "engineProtocolVersions", "engineVersions"]) {
    const values = input[field];
    if (!Array.isArray(values) || values.length < 1 || values.length > 8 || new Set(values).size !== values.length
      || values.some(value => field === "engineVersions"
        ? typeof value !== "string" || value.length > 64 || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value)
        : !Number.isSafeInteger(value) || value < 1)) throw appOperationError("INVALID_SYNC_REQUEST");
    result[field] = [...values];
  }
  return result;
}
/** State v3 includes bounded standalone origins. Advertising a format is not enabling a route or granting permission. Keep
 * this internal-only descriptor honest until the full financial host is wired. */
export const APP_SYNC_STATE_VERSION = 3;
export function appSyncCapabilities() {
  // Enabled only through an authenticated, bound negotiation on a host with routes.
  return { enabled: false, status: "negotiated-per-device", protocolVersion: 1, financialModelVersion: 1,
    stateVersion: APP_SYNC_STATE_VERSION, engineProtocolVersion: ENGINE_PROTOCOL_VERSION, engineVersion: ENGINE_VERSION,
    implementedOperationKinds: [...APP_OPERATION_KINDS], maximumPageRecords: 100 };
}
/** Exact current-engine agreement is conservative. Compatibility migrations
 * require explicit future rules; timestamps/fingerprints never act as versions. */
export function negotiateAppSync(input) {
  const offer = normalizeSyncOffer(input);
  if (!offer.protocolVersions.includes(1) || !offer.stateVersions.includes(APP_SYNC_STATE_VERSION) || !offer.financialModelVersions.includes(1)
    || !offer.engineProtocolVersions.includes(ENGINE_PROTOCOL_VERSION)
    || !offer.engineVersions.includes(ENGINE_VERSION)) throw appOperationError("COMPATIBILITY_REQUIRED");
  return { protocolVersion: 1, financialModelVersion: 1, stateVersion: APP_SYNC_STATE_VERSION, engineProtocolVersion: ENGINE_PROTOCOL_VERSION, engineVersion: ENGINE_VERSION };
}
/** Validate a previously negotiated selection against current server rules. */
export function normalizeSyncSelection(input) {
  exact(input, ["protocolVersion", "financialModelVersion", "stateVersion", "engineProtocolVersion", "engineVersion"]);
  const chosen = negotiateAppSync({ protocolVersions: [input.protocolVersion], stateVersions: [input.stateVersion],
    financialModelVersions: [input.financialModelVersion], engineProtocolVersions: [input.engineProtocolVersion], engineVersions: [input.engineVersion] });
  return chosen;
}
/** Syntax normalization is separate from authorization. Hosts compare binding
 * only after obtaining the current device/account/budget permission on their tx. */
export function assertAppSyncBinding(request, authorized) {
  if (!authorized || request.instanceId !== authorized.instanceId || request.accountId !== authorized.accountId
    || request.budgetId !== authorized.budgetId) throw appOperationError("SYNC_BINDING_MISMATCH");
}
/** Negotiation request does not initialize a head, bootstrap or write grant. */
export function normalizeSyncNegotiation(input) {
  exact(input, [...SCOPE, "offer"]);
  return { ...scope(input), offer: normalizeSyncOffer(input.offer) };
}
/** Bootstrap creates a bounded, authorized read session at one epoch/revision;
 * it must never import the read-only preview endpoint's revision fingerprint. */
export function normalizeSyncBootstrapStart(input) {
  exact(input, [...SCOPE, "compatibility"]);
  return { ...scope(input), compatibility: normalizeSyncSelection(input.compatibility) };
}
/** Opaque page tokens are authenticated/bound by the host, not by this shape
 * check. The client commits only contiguous, source-bound page indexes. */
export function normalizeSyncBootstrapPage(input) {
  exact(input, [...SCOPE, "bootstrapId", "pageToken", "limit"]);
  if (typeof input.bootstrapId !== "string" || !UUID.test(input.bootstrapId)
    || typeof input.pageToken !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(input.pageToken)
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw appOperationError("INVALID_SYNC_REQUEST");
  return { ...scope(input), bootstrapId: input.bootstrapId.toLowerCase(), pageToken: input.pageToken, limit: input.limit };
}
/** One operation per atomic submission. Normalization never promotes an
 * unimplemented operation kind or accepts a calculated-plan replacement. */
export function normalizeSyncSubmission(input) {
  exact(input, [...SCOPE, "compatibility", "operation"]);
  const binding = scope(input);
  const operation = normalizeAppOperation(input.operation);
  if (operation.budgetId !== binding.budgetId) throw appOperationError("SYNC_BINDING_MISMATCH");
  return { ...binding, compatibility: normalizeSyncSelection(input.compatibility), operation };
}
/** Outcome lookup remains possible after an engine upgrade. It never applies
 * financial changes, and NOT_FOUND never authorizes regenerating an op ID. */
export function normalizeSyncResultLookup(input) {
  exact(input, [...SCOPE, "epoch", "operationId"]);
  if (typeof input.epoch !== "string" || !UUID.test(input.epoch) || typeof input.operationId !== "string" || !UUID.test(input.operationId)) {
    throw appOperationError("INVALID_SYNC_REQUEST");
  }
  return { ...scope(input), epoch: input.epoch.toLowerCase(), operationId: input.operationId.toLowerCase() };
}
/** Changes use a durable journal revision and epoch, never a clock or preview
 * hash. Authentication and current permission apply to every page. */
export function normalizeSyncChanges(input) {
  exact(input, [...SCOPE, "epoch", "afterRevision", "limit"]);
  const binding = scope(input);
  const cursor = normalizeAppChangesRequest({ budgetId: binding.budgetId, epoch: input.epoch, afterRevision: input.afterRevision, limit: input.limit });
  return { ...binding, epoch: cursor.epoch, afterRevision: cursor.afterRevision, limit: cursor.limit };
}
