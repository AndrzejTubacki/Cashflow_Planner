import { createHash } from 'node:crypto';
import { STANDALONE_TRANSFER_TABLE_COLUMNS } from './cashflow-standalone-transfer-schema.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const COLUMNS = STANDALONE_TRANSFER_TABLE_COLUMNS.cashflow_standalone_transfers;
const invalid = () => Object.assign(new Error('Invalid standalone transfer metadata'), { code: 'TRANSFER_RECORD_INVALID' });
const identity = value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);

/** Deterministic, domain-separated UUIDv8 destination. Identity alone never
 * grants access or authorizes overwriting a surviving target after restore. */
export function standaloneTransferDestination(input) {
  const bytes = createHash('sha256').update(JSON.stringify(['cashflow-standalone-transfer-budget-v1',
    input.instanceId, input.accountId, input.deviceId, input.transferId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `budget_${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/** Fixed receipt identity comes from the owning row, never from JSON claims. */
function base(row) {
  return { version: 1, transferId: row.transfer_id, instanceId: row.instance_id,
    accountId: row.account_id, deviceId: row.device_id, budgetId: row.budget_id, inputHash: row.input_hash };
}

/** Fail closed on damaged/imported journal metadata before replacement writes.
 * This structural check confers no device grant, financial trust or permission
 * to recover an existing budget. Portable metadata retains only historical IDs. */
export function validateStandaloneTransferRecord(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== COLUMNS.length
    || COLUMNS.some(key => !Object.hasOwn(value, key)) || !UUID.test(value.instance_id) || !UUID.test(value.transfer_id)
    || !identity(value.account_id) || !identity(value.device_id) || !/^[a-f0-9]{64}$/.test(value.input_hash)
    || !['reserved', 'accepted', 'cancelled'].includes(value.state)) throw invalid();
  const receiptBase = base(value);
  if (value.budget_id !== standaloneTransferDestination(receiptBase)) throw invalid();
  if (!['number', 'string'].includes(typeof value.created_ms)
    || (typeof value.created_ms === 'string' && !/^(0|[1-9][0-9]{0,15})$/.test(value.created_ms))) throw invalid();
  const createdMs = Number(value.created_ms);
  if (!Number.isSafeInteger(createdMs) || createdMs < 0 || createdMs > 8640000000000000) throw invalid();
  if (value.state === 'reserved') {
    if (value.receipt_json !== null) throw invalid();
  } else {
    if (typeof value.receipt_json !== 'string' || value.receipt_json.length > 16384) throw invalid();
    let receipt;
    try { receipt = JSON.parse(value.receipt_json); }
    catch { throw invalid(); }
    const timestamp = value.state === 'accepted' ? 'acceptedAt' : 'cancelledAt';
    if (!receipt || Object.getPrototypeOf(receipt) !== Object.prototype
      || Object.keys(receipt).length !== Object.keys(receiptBase).length + 2 || receipt.state !== value.state
      || Object.keys(receiptBase).some(key => receipt[key] !== receiptBase[key])
      || typeof receipt[timestamp] !== 'string' || !Number.isFinite(Date.parse(receipt[timestamp]))
      || new Date(receipt[timestamp]).toISOString() !== receipt[timestamp]) throw invalid();
  }
  return { ...value, created_ms: createdMs };
}

/** Read the immutable outcome only after validating the full owning row. */
export function standaloneTransferOutcome(value) {
  const row = validateStandaloneTransferRecord(value);
  return row.state === 'reserved' ? { ...base(row), state: 'reserved' } : JSON.parse(row.receipt_json);
}
