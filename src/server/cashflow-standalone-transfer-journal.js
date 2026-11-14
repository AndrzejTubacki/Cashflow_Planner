import { createHash } from 'node:crypto';
import { STANDALONE_TRANSFER_MAX_BYTES } from './cashflow-standalone-transfer-source.js';
import { standaloneTransferDestination as destination, validateStandaloneTransferRecord,
  standaloneTransferOutcome } from './cashflow-standalone-transfer-record.js';

export { STANDALONE_TRANSFER_JOURNAL_SCHEMA } from './cashflow-standalone-transfer-schema.js';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SCOPE = ['instanceId', 'accountId', 'deviceId'];
const LOOKUP = ['version', 'transferId', ...SCOPE];
const INPUT = [...LOOKUP, 'name', 'sourceJson'];

/** Errors contain fixed state descriptions, never source JSON or credentials. */
function refused(code, message) { return Object.assign(new Error(message), { code }); }
function identity(value) {
  return typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
/** Transfer IDs and immutable binding are explicit, including result lookup.
 * Re-pairing cannot silently retarget saved work to a different device grant. */
export function normalizeStandaloneTransferRequest(value, lookup = false) {
  const keys = lookup ? LOOKUP : INPUT;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
    || value.version !== 1 || !UUID.test(value.transferId) || !UUID.test(value.instanceId)
    || !identity(value.accountId) || !identity(value.deviceId)) throw refused('INVALID_TRANSFER_REQUEST', 'Invalid standalone transfer request');
  if (!lookup && (!identity(value.name) || value.name.length > 100 || value.name !== value.name.trim()
    || typeof value.sourceJson !== 'string' || Buffer.byteLength(value.sourceJson, 'utf8') > STANDALONE_TRANSFER_MAX_BYTES)) {
    throw refused('INVALID_TRANSFER_REQUEST', 'Invalid standalone transfer source or name');
  }
  // Freeze scalar request identity before any awaited authorization or disk IO.
  return Object.freeze({ ...value });
}
/** Hash server-observed frozen source bytes and the chosen destination name.
 * A client-supplied digest is never accepted in place of the actual input. */
export function standaloneTransferFingerprint(input) {
  return createHash('sha256').update(JSON.stringify({ name: input.name, sourceJson: input.sourceJson })).digest('hex');
}

/** Caller owns a serialized global transaction and current grant authorization
 * on query's connection. Source financial preflight happens before that lock.
 * prepare must publish the complete new financial budget, membership and grant
 * within the host's approved transaction/file-publication design. It receives
 * the stable reserved identity, never permission to overwrite an existing budget.
 * This primitive alone does not implement that financial publisher. */
export function createStandaloneTransferJournal({ query, authorize, prepare, backend, now = Date.now, afterRecord = null, recoverReceipt = null }) {
  if (typeof query !== 'function' || typeof authorize !== 'function' || typeof prepare !== 'function'
    || !['sqlite', 'postgres'].includes(backend) || typeof now !== 'function'
    || (afterRecord !== null && typeof afterRecord !== 'function')
    || (recoverReceipt !== null && typeof recoverReceipt !== 'function')) throw new Error('Transaction-bound transfer host required');

  /** Authorize before reading even an existing outcome. The callback must check
   * the live device/account/grant on the supplied owning transaction. */
  async function scope(input, action) {
    const grant = await authorize({ query, action, transferId: input.transferId });
    if (!grant || SCOPE.some(key => grant[key] !== input[key])) throw refused('TRANSFER_BINDING_MISMATCH', 'Transfer belongs to another server, account or device');
    // The host also serializes revocation/grant changes. This per-transfer lock
    // prevents two PostgreSQL replicas preparing the same new budget together.
    if (backend === 'postgres') await query('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
      [JSON.stringify([...SCOPE.map(key => input[key]), input.transferId])]);
    return grant;
  }
  const bindings = input => [...SCOPE.map(key => input[key]), input.transferId];
  async function record(input) {
    const result = (await query(`SELECT * FROM cashflow_standalone_transfers
      WHERE instance_id = ? AND account_id = ? AND device_id = ? AND transfer_id = ?`, bindings(input)))[0];
    if (!result) return null;
    return validateStandaloneTransferRecord(result);
  }
  /** The receipt is journal-owned. A preparation callback cannot return a
   * replacement budget, binding, input hash or fabricated acceptance response. */
  function outcome(input, stored) {
    if (stored?.instance_id !== input.instanceId || stored?.account_id !== input.accountId || stored?.device_id !== input.deviceId
      || stored?.transfer_id !== input.transferId) throw refused('TRANSFER_RECORD_INVALID', 'Stored transfer scope is invalid');
    return standaloneTransferOutcome(stored);
  }
  function matching(input, stored) {
    if (stored.input_hash !== standaloneTransferFingerprint(input)) throw refused('TRANSFER_ID_REUSED', 'Transfer ID was already used for different input');
  }
  /** Allocate only the immutable control-plane identity, on the current
   * authorized transaction. Cancellation may fence a not-yet-reserved request. */
  async function ensureRecord(input) {
    let stored = await record(input);
    if (!stored) {
      const createdMs = now();
      if (!Number.isSafeInteger(createdMs) || createdMs < 0) throw new Error('Invalid transfer host clock');
      await query(`INSERT INTO cashflow_standalone_transfers
        (instance_id, account_id, device_id, transfer_id, budget_id, input_hash, state, receipt_json, created_ms)
        VALUES (?, ?, ?, ?, ?, ?, 'reserved', NULL, ?)`,
      [...bindings(input), destination(input), standaloneTransferFingerprint(input), createdMs]);
      stored = await record(input);
    }
    matching(input, stored);
    return stored;
  }
  return {
    /** Commit this reservation before financial preparation. A restart then
     * reuses its destination even when a prior unpublished file needs recovery. */
    async reserve(value) {
      const input = normalizeStandaloneTransferRequest(value);
      await scope(input, 'reserve');
      const stored = await ensureRecord(input);
      return outcome(input, stored);
    },
    /** A repeated accepted publication returns its immutable receipt without
     * invoking preparation again. Late failures roll back the host transaction. */
    async publish(value) {
      const input = normalizeStandaloneTransferRequest(value);
      const grant = await scope(input, 'publish');
      const stored = await record(input);
      if (!stored) throw refused('TRANSFER_NOT_RESERVED', 'Reserve the transfer before publication');
      matching(input, stored);
      if (stored.state !== 'reserved') return outcome(input, stored);
      const acceptedMs = now();
      if (!Number.isSafeInteger(acceptedMs) || acceptedMs < 0 || acceptedMs > 8640000000000000) throw new Error('Invalid transfer host clock');
      let receipt = { ...outcome(input, stored), state: 'accepted', acceptedAt: new Date(acceptedMs).toISOString() };
      // Only a trusted host may recover its own durable file-publication seal.
      // Validate the entire namespace/hash before using its old decision time;
      // uploaded claims and preparation callback return values cannot replace it.
      if (recoverReceipt) {
        const recovered = await recoverReceipt({ query, grant, budgetId: stored.budget_id, input });
        if (recovered !== null) receipt = standaloneTransferOutcome({ ...stored, state: 'accepted', receipt_json: JSON.stringify(recovered) });
      }
      receipt = Object.freeze(receipt);
      await prepare({ query, grant, budgetId: stored.budget_id, input, receipt });
      await query(`UPDATE cashflow_standalone_transfers SET state = 'accepted', receipt_json = ?
        WHERE instance_id = ? AND account_id = ? AND device_id = ? AND transfer_id = ? AND state = 'reserved'`,
      [JSON.stringify(receipt), ...bindings(input)]);
      if (afterRecord) await afterRecord();
      const persisted = outcome(input, await record(input));
      if (Object.keys(receipt).some(key => persisted[key] !== receipt[key])) {
        throw refused('TRANSFER_OUTCOME_NOT_RECORDED', 'Transfer receipt was not recorded with publication');
      }
      return persisted;
    },
    /** A durable negative outcome fences delayed/in-flight submissions under
     * the same job ID. Accepted budgets are never deleted or revoked by cancel.
     * The host serializes this transaction against publication before commit. */
    async cancel(value) {
      const input = normalizeStandaloneTransferRequest(value);
      await scope(input, 'cancel');
      const stored = await ensureRecord(input);
      if (stored.state !== 'reserved') return outcome(input, stored);
      const cancelledMs = now();
      if (!Number.isSafeInteger(cancelledMs) || cancelledMs < 0 || cancelledMs > 8640000000000000) throw new Error('Invalid transfer host clock');
      const receipt = { ...outcome(input, stored), state: 'cancelled', cancelledAt: new Date(cancelledMs).toISOString() };
      await query(`UPDATE cashflow_standalone_transfers SET state = 'cancelled', receipt_json = ?
        WHERE instance_id = ? AND account_id = ? AND device_id = ? AND transfer_id = ? AND state = 'reserved'`,
      [JSON.stringify(receipt), ...bindings(input)]);
      if (afterRecord) await afterRecord();
      const persisted = outcome(input, await record(input));
      if (Object.keys(receipt).some(key => persisted[key] !== receipt[key])) throw refused('TRANSFER_OUTCOME_NOT_RECORDED', 'Transfer cancellation was not recorded');
      return persisted;
    },
    /** Lookup needs the original binding but does not require re-uploading the
     * financial source. It never creates a reservation or grants a budget. */
    async lookup(value) {
      const input = normalizeStandaloneTransferRequest(value, true);
      await scope(input, 'lookup');
      const stored = await record(input);
      return stored ? outcome(input, stored) : null;
    }
  };
}
