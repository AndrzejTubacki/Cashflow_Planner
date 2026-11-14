import { ENGINE_AUDIT_HOST_OPTIONS } from './engine-host-capabilities.js';
import { createLedgerAuditReplay } from './ledger-audit-replay.js';
import { replayStandaloneLedgerOrigin } from './standalone-ledger-origin.js';

/** UTF-8 length without platform globals. Unpaired UTF-16 surrogates count as
 * replacement characters, matching standard host UTF-8 encoders. JSON evidence
 * is stringified before this boundary, so lone surrogates are escaped already. */
export function auditUtf8ByteLength(text) {
  if (typeof text !== 'string') throw new Error('Audit UTF-8 input must be text');
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length
      && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4; index++;
    } else bytes += 3;
  }
  return bytes;
}

/** Only the owning native host computes these digests. Preparation bounds and
 * canonicalizes hash inputs; it does not claim the history has passed replay. */
export function prepareLedgerAuditHashes({ audit, budgetId }, { allowStandaloneOrigins = false } = {}) {
  if (typeof allowStandaloneOrigins !== 'boolean' || (audit?.version === 2 && !allowStandaloneOrigins)) throw new Error('Standalone ledger origins need an upgraded host');
  const codec = createLedgerAuditReplay({ utf8ByteLength: auditUtf8ByteLength,
    digestText: () => { throw new Error('Hash preparation cannot validate evidence'); } });
  codec.identifier(budgetId);
  if (!audit || audit.budgetId !== budgetId || !Array.isArray(audit.originals) || !Array.isArray(audit.corrections)
    || audit.originals.length + audit.corrections.length > 200000) throw new Error('Complete scoped ledger audit required');
  const origin = audit.version === 2 ? replayStandaloneLedgerOrigin({ origin: audit.origin, budgetId, utf8ByteLength: auditUtf8ByteLength }) : null;
  if ((origin?.lastSequence ?? 0) + audit.originals.length + audit.corrections.length > 200000) throw new Error('Ledger audit has too many records');
  const texts = new Set();
  let bytes = origin ? auditUtf8ByteLength(JSON.stringify(origin.origin)) : 0;
  for (const item of [...audit.originals, ...audit.corrections]) {
    bytes += auditUtf8ByteLength(codec.encoded(item));
    if (bytes > 64 * 1024 * 1024) throw new Error('Ledger audit snapshot is too large');
  }
  for (const original of [...(origin?.originals.values() ?? []), ...audit.originals]) texts.add(codec.encoded(original));
  for (const event of audit.corrections) texts.add(codec.encoded({ targetId: event.targetId,
    expectedCorrectionId: event.previousAcceptedId, replacement: event.requested, reason: event.reason,
    actorId: event.actorId, retryOf: event.retryOf }));
  return { budgetId, texts: [...texts] };
}

/** Replay using digests calculated by the native host over the engine's exact
 * canonical strings. Digests are integrity links, never signatures or authority.
 * Imported files supply only audit data; native code supplies this hash receipt
 * map itself. The server independently uses its own crypto on every write. */
export function replayLedgerAuditFromHost({ audit, budgetId, hashes }, { allowStandaloneOrigins = false } = {}) {
  if (!Array.isArray(hashes) || hashes.length > 200000) throw new Error('Native audit hashes required');
  const receipts = new Map();
  let bytes = 0;
  for (const item of hashes) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string'
      || typeof item[1] !== 'string' || !/^[0-9a-f]{64}$/.test(item[1]) || receipts.has(item[0])) {
      throw new Error('Invalid native audit hash receipt');
    }
    bytes += auditUtf8ByteLength(item[0]);
    if (bytes > 64 * 1024 * 1024) throw new Error('Native audit hashes are too large');
    receipts.set(item[0], item[1]);
  }
  const codec = createLedgerAuditReplay({ utf8ByteLength: auditUtf8ByteLength, allowStandaloneOrigins,
    digestText: text => {
      if (!receipts.has(text)) throw new Error('Native audit hash receipt missing');
      return receipts.get(text);
    } });
  const replay = codec.replayLedgerAuditSnapshot(audit, budgetId);
  return { budgetId, rows: replay.rows, heads: [...replay.heads], originals: [...replay.originals.values()],
    corrections: [...replay.corrections.values()], oneOffCounts: [...codec.originalOneOffCountsFromEvidence(replay.originals.values())],
    ...(replay.origin ? { origin: replay.origin, opening: replay.opening } : {}) };
}

/** Transport adapters return safe error envelopes; no persistence or writes. */
export function prepareLedgerAuditHashesJson(json) {
  try { return JSON.stringify({ ok: true, ...prepareLedgerAuditHashes(JSON.parse(json), ENGINE_AUDIT_HOST_OPTIONS) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: 'LEDGER_AUDIT_REPLAY_REJECTED', message: error.message } }); }
}
export function replayLedgerAuditFromHostJson(json) {
  try { return JSON.stringify({ ok: true, replay: replayLedgerAuditFromHost(JSON.parse(json), ENGINE_AUDIT_HOST_OPTIONS) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: 'LEDGER_AUDIT_REPLAY_REJECTED', message: error.message } }); }
}
