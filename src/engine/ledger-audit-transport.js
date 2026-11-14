import { canonicalAuditValue } from './ledger-audit-json.js';
import { auditUtf8ByteLength } from './ledger-audit-host.js';

const ORIGIN_BYTES = 10 * 1024 * 1024;
const SNAPSHOT_BYTES = 64 * 1024 * 1024;
const CHUNK_CHARACTERS = 32768;
const MAX_CHUNKS = Math.ceil(ORIGIN_BYTES / CHUNK_CHARACTERS) + 1;
const AUDIT_RECORDS = 200000;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Structural, bounded transport only. Financial authority comes from full
 * replay and current authorization, never a header, chunk or imported flag. */
function policy(allowStandaloneOrigins) {
  if (typeof allowStandaloneOrigins !== 'boolean') throw new Error('Invalid linked audit host capability');
}

/** Serialize already replayed evidence. Ordinary v1 keeps its exact wire shape.
 * A v2 origin is canonical JSON in ordered bounded fragments, so even one large
 * source/event cannot turn the namespace header into a multi-megabyte record.
 * This format is internal until a new native state version is integrated. */
export function encodeLedgerAuditRecords(audit, { allowStandaloneOrigins = false } = {}) {
  policy(allowStandaloneOrigins);
  if (audit === null) return [];
  if (!exact(audit, ['version', 'budgetId', 'baselineComplete', 'lastSequence', 'originals', 'corrections',
    ...(audit?.version === 2 ? ['origin'] : [])]) || ![1, 2].includes(audit.version)
    || !Array.isArray(audit.originals) || !Array.isArray(audit.corrections)
    || audit.originals.length + audit.corrections.length > AUDIT_RECORDS) throw new Error('Invalid linked audit snapshot');
  if (audit.version === 2 && !allowStandaloneOrigins) throw new Error('Standalone ledger origins need an upgraded host');
  const { originals, corrections, origin, ...state } = audit;
  const chunks = [];
  if (origin !== undefined) {
    const text = JSON.stringify(canonicalAuditValue(origin));
    if (auditUtf8ByteLength(text) > ORIGIN_BYTES) throw new Error('Standalone origin exceeds 10 MB');
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(offset + CHUNK_CHARACTERS, text.length);
      // Keep a Unicode scalar together across native JSON/UTF-8 boundaries.
      if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
      chunks.push({ kind: 'origin-chunk', value: { index: chunks.length, text: text.slice(offset, end) } });
      offset = end;
    }
    if (!chunks.length || chunks.length > MAX_CHUNKS) throw new Error('Invalid linked origin chunk count');
    state.originChunks = chunks.length;
  }
  const records = [{ kind: 'state', value: state }, ...chunks,
    ...originals.map(value => ({ kind: 'original', value })), ...corrections.map(value => ({ kind: 'correction', value }))];
  // Apply identical aggregate/record bounds to encoder and decoder. This does
  // not substitute for financial replay by the writer or the receiving host.
  decodeLedgerAuditRecords(records, audit.budgetId, { allowStandaloneOrigins });
  return records;
}

/** Reassemble only known fields and ordered complete origin fragments. Bounds
 * apply before joining or parsing the proof; subsequent financial replay still
 * verifies every original, correction, scope, balance and recorded outcome. */
export function decodeLedgerAuditRecords(records, budgetId, { allowStandaloneOrigins = false } = {}) {
  policy(allowStandaloneOrigins);
  if (!Array.isArray(records)) throw new Error('Linked replica is missing ledger-audit');
  if (!records.length) return null;
  if (records.length > AUDIT_RECORDS + MAX_CHUNKS + 1) throw new Error('Linked audit has too many records');
  let header = null, bytes = 0, originBytes = 0;
  const originals = [], corrections = [], chunks = [];
  for (const record of records) {
    if (!exact(record, ['kind', 'value']) || !record.value || typeof record.value !== 'object' || Array.isArray(record.value)) throw new Error('Invalid linked audit record');
    const size = auditUtf8ByteLength(JSON.stringify(canonicalAuditValue(record)));
    bytes += size;
    if (size > 1024 * 1024 || bytes > SNAPSHOT_BYTES) throw new Error('Linked audit transport exceeds size limit');
    if (record.kind === 'state') {
      if (header || ![1, 2].includes(record.value.version) || !exact(record.value,
        ['baselineComplete', 'budgetId', 'lastSequence', 'version', ...(record.value.version === 2 ? ['originChunks'] : [])])) throw new Error('Invalid linked audit state');
      header = record.value;
      if (header.version === 2 && !allowStandaloneOrigins) throw new Error('Standalone ledger origins need an upgraded host');
      if (header.version === 2 && (records[0] !== record || !Number.isInteger(header.originChunks)
        || header.originChunks < 1 || header.originChunks > MAX_CHUNKS)) throw new Error('Invalid linked origin chunk count');
    } else if (record.kind === 'origin-chunk') {
      if (!allowStandaloneOrigins || header?.version !== 2 || originals.length || corrections.length
        || !exact(record.value, ['index', 'text']) || record.value.index !== chunks.length
        || typeof record.value.text !== 'string' || !record.value.text.length || record.value.text.length > CHUNK_CHARACTERS
        || chunks.length >= header.originChunks) throw new Error('Invalid linked origin chunk');
      originBytes += auditUtf8ByteLength(record.value.text);
      if (originBytes > ORIGIN_BYTES) throw new Error('Standalone origin exceeds 10 MB');
      chunks.push(record.value.text);
    } else if (record.kind === 'original') originals.push(record.value);
    else if (record.kind === 'correction') corrections.push(record.value);
    else throw new Error('Unsupported linked audit record');
  }
  if (!header || header.budgetId !== budgetId) throw new Error('Linked audit scope differs');
  if (originals.length + corrections.length > AUDIT_RECORDS) throw new Error('Linked audit has too many records');
  if (header.version === 1) {
    if (chunks.length) throw new Error('Unexpected linked origin');
    return { ...header, originals, corrections };
  }
  if (chunks.length !== header.originChunks) throw new Error('Linked origin chunks are incomplete');
  let origin;
  try { origin = JSON.parse(chunks.join('')); } catch { throw new Error('Invalid linked origin JSON'); }
  const { originChunks: _count, ...state } = header;
  return { ...state, origin, originals, corrections };
}
