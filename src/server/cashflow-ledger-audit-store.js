import { canonicalAuditValue } from '../engine/ledger-audit-json.js';
import { createLedgerAuditReplay } from '../engine/ledger-audit-replay.js';
import { createHash } from 'node:crypto';
import { requireIsoDate } from './cashflow-date-utils.js';
import { badRequest, conflict } from './cashflow-user-utils.js';
import { planLedgerCorrection, validateLedgerCorrectionFact } from './cashflow-ledger-correction-plan.js';
import { replayStandaloneLedgerOrigin } from '../engine/standalone-ledger-origin.js';

// Origin storage is registered by planning schema 22. Financial use remains
// opt-in until backup/balance/native state consumers are upgraded together.
export const LEDGER_ORIGIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS cashflow_ledger_origins (
  budget_id TEXT PRIMARY KEY REFERENCES cashflow_ledger_audit_state(budget_id) ON DELETE CASCADE,
  data_json TEXT NOT NULL, record_hash TEXT NOT NULL
);
`;
// Apply once in the future owning schema migration, on the same transaction as
// origin-table creation. A marker in the parent state prevents a missing proof
// from silently becoming an ordinary zero-opening ledger, even with no rows.
export const LEDGER_ORIGIN_STATE_MIGRATION = `ALTER TABLE cashflow_ledger_audit_state
  ADD COLUMN origin_version INTEGER NOT NULL DEFAULT 0 CHECK (origin_version IN (0, 1));`;

// Runtime schema registers these tables, but correction writes remain internal
// until confirmation hooks, backup replay and client support are integrated.
export const LEDGER_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS cashflow_ledger_audit_state (
  budget_id TEXT PRIMARY KEY,
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence BETWEEN 0 AND 9007199254740991),
  baseline_complete INTEGER NOT NULL DEFAULT 0 CHECK (baseline_complete IN (0, 1)),
  origin_version INTEGER NOT NULL DEFAULT 0 CHECK (origin_version IN (0, 1))
);
CREATE TABLE IF NOT EXISTS cashflow_ledger_originals (
  budget_id TEXT NOT NULL, payment_id TEXT NOT NULL, sequence_number BIGINT NOT NULL,
  data_json TEXT NOT NULL, record_hash TEXT NOT NULL,
  PRIMARY KEY (budget_id, payment_id), UNIQUE (budget_id, sequence_number),
  FOREIGN KEY (budget_id) REFERENCES cashflow_ledger_audit_state(budget_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS cashflow_ledger_corrections (
  budget_id TEXT NOT NULL, id TEXT NOT NULL, payment_id TEXT NOT NULL,
  sequence_number BIGINT NOT NULL, status TEXT NOT NULL CHECK (status IN ('accepted', 'blocked')),
  data_json TEXT NOT NULL, record_hash TEXT NOT NULL,
  PRIMARY KEY (budget_id, id), UNIQUE (budget_id, sequence_number),
  FOREIGN KEY (budget_id, payment_id) REFERENCES cashflow_ledger_originals(budget_id, payment_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ledger_corrections_payment
  ON cashflow_ledger_corrections(budget_id, payment_id, sequence_number);
`;
export const POSTGRES_LEDGER_AUDIT_SCHEMA = LEDGER_AUDIT_SCHEMA.replace(
  'budget_id TEXT PRIMARY KEY,', 'budget_id TEXT PRIMARY KEY REFERENCES budgets(id) ON DELETE CASCADE,');
// Storage keeps its existing Node crypto implementation; all financial replay
// and validation is shared with portable hosts through explicit primitives.
const nodePrimitives = {
  digestText: text => createHash('sha256').update(text).digest('hex'),
  utf8ByteLength: text => Buffer.byteLength(text)
};
/** Node supplies its own hash/byte primitives. Origin support is an explicit
 * owning-host policy, never an option read from imported financial JSON. */
export function createNodeLedgerAuditReplay({ allowStandaloneOrigins = false } = {}) {
  return createLedgerAuditReplay({ ...nodePrimitives, allowStandaloneOrigins });
}
const { replayLedgerAuditSnapshot, copyLedgerAuditSnapshot, originalOneOffCountsFromEvidence,
  encoded, digest, identifier, timestamp, sequence, sourceEvidence } = createNodeLedgerAuditReplay();
export { replayLedgerAuditSnapshot, copyLedgerAuditSnapshot, originalOneOffCountsFromEvidence };
const clone = canonicalAuditValue;

/** Decode a scoped immutable proof with its independent parent marker. This
 * is financial replay/integrity, never authorization from an imported row. */
export function decodeStandaloneLedgerOrigin(budgetId, row, version) {
  const marker = Number(version ?? 0);
  if (![0, 1].includes(marker)) throw badRequest('Unsupported retained standalone origin version');
  if (marker !== (row ? 1 : 0)) throw badRequest('Standalone origin evidence is missing or unregistered');
  if (!row) return null;
  if (row.budget_id !== budgetId || typeof row.data_json !== 'string' || Buffer.byteLength(row.data_json) > 10 * 1024 * 1024
    || nodePrimitives.digestText(row.data_json) !== row.record_hash) throw badRequest('Standalone origin evidence is damaged');
  let value;
  try { value = JSON.parse(row.data_json); } catch { throw badRequest('Standalone origin evidence is damaged'); }
  return replayStandaloneLedgerOrigin({ origin: value, budgetId, utf8ByteLength: nodePrimitives.utf8ByteLength });
}

/** Compare complete ledgers one bounded fact at a time. A whole history uses
 * the 64 MiB snapshot allowance, not the 1 MiB allowance for one audit record.
 * Avoid building another large aggregate string merely to compare mirrors. */
function sameLedgerRows(actual, expected) {
  if (actual.length !== expected.length) return false;
  const ordered = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  const left = ordered(actual), right = ordered(expected);
  let bytes = 0;
  for (let index = 0; index < left.length; index++) {
    const value = encoded(left[index]);
    bytes += Buffer.byteLength(value);
    if (bytes > 64 * 1024 * 1024) throw badRequest('Ledger audit snapshot is too large');
    if (value !== encoded(right[index])) return false;
  }
  return true;
}

/** Shared record decoder for async runtime readers and synchronous SQLite full
 * exports. Verify both stored scope/index metadata and the retained JSON hash;
 * a checksum is integrity evidence, never authorization. */
export function decodeLedgerAuditRecord(budgetId, row, kind, standaloneOriginal = null) {
    let data;
    try { data = JSON.parse(row.data_json); } catch { throw badRequest('Ledger audit evidence is damaged'); }
    // Only an independently replayed origin may supply this expected original.
    // Stored/imported captureKind or a reproducible checksum is insufficient.
    if (kind === 'original' && (standaloneOriginal !== null || data?.version === 2)) {
      if (!standaloneOriginal || standaloneOriginal.version !== 2 || standaloneOriginal.captureKind !== 'standalone'
        || standaloneOriginal.actorId !== null || standaloneOriginal.budgetId !== budgetId || standaloneOriginal.row?.budget_id !== budgetId
        || row.budget_id !== budgetId || row.payment_id !== standaloneOriginal.row.id
        || sequence(row.sequence_number) !== standaloneOriginal.sequence || digest(data) !== row.record_hash
        || encoded(data) !== encoded(standaloneOriginal)) throw badRequest('Standalone original index differs from origin evidence');
      return clone(standaloneOriginal);
    }
    if (row.budget_id !== budgetId || digest(data) !== row.record_hash
      || !(kind === 'original' ? data.version === 1 : [1, 2].includes(data.version)) || data.budgetId !== budgetId
      || data.sequence !== sequence(row.sequence_number)) throw badRequest('Ledger audit evidence differs from its retained record');
    if (kind === 'original') {
      if (data.row?.id !== row.payment_id || !['legacy', 'payment'].includes(data.captureKind)) throw badRequest('Invalid original ledger evidence');
      validateLedgerCorrectionFact(data.row, budgetId);
      sourceEvidence(data.row, data.sourceAtAcceptance, budgetId, data.captureKind === 'legacy');
    } else if (data.id !== row.id || data.targetId !== row.payment_id || data.status !== row.status) {
      throw badRequest('Invalid correction ledger evidence');
    }
    return data;
  }

/** Persistence inside an already-authorized, owning financial transaction and
 * budget lock. query returns rows and accepts portable ? parameters; the host
 * maps them to PostgreSQL placeholders. loadEffectiveRows reads COMPLETE scoped
 * normalized facts on that same connection, never client-supplied ledger rows.
 * The caller applies an accepted, non-replayed plan in this same transaction.
 * This store deliberately has no mutation/delete method for original evidence. */
export function createLedgerAuditStore({ budgetId, query, loadEffectiveRows, allowStandaloneOrigins = false }) {
  identifier(budgetId);
  if (typeof allowStandaloneOrigins !== 'boolean') throw new Error('Explicit standalone-origin host policy required');
  if (typeof query !== 'function' || typeof loadEffectiveRows !== 'function') throw new Error('Transaction-bound ledger audit storage required');
  const replaySnapshot = allowStandaloneOrigins
    ? createNodeLedgerAuditReplay({ allowStandaloneOrigins: true }).replayLedgerAuditSnapshot
    : replayLedgerAuditSnapshot;
  let retainedOrigin;
  let retainedOriginRecord;
  /** Cache only within this owning, budget-locked transaction. The origin is
   * immutable; sequence/fact mutations are still read from the same connection.
   * No cached proof is exposed as mutable caller-owned original evidence. */
  async function origin() {
    if (!allowStandaloneOrigins) { await state(); return null; }
    if (retainedOrigin !== undefined) return retainedOrigin;
    const marker = Number((await state())?.origin_version ?? 0);
    const row = (await query('SELECT * FROM cashflow_ledger_origins WHERE budget_id = ?', [budgetId]))[0];
    if (retainedOriginRecord && (!row || row.data_json !== retainedOriginRecord.data_json || row.record_hash !== retainedOriginRecord.record_hash)) {
      throw conflict('Standalone origin evidence changed within its owning transaction');
    }
    retainedOrigin = decodeStandaloneLedgerOrigin(budgetId, row, marker);
    if (!retainedOrigin) return null;
    retainedOriginRecord = { data_json: row.data_json, record_hash: row.record_hash };
    return retainedOrigin;
  }
  async function rows() {
    const result = await loadEffectiveRows();
    if (!Array.isArray(result) || result.length > 200000) throw badRequest('Complete bounded ledger history required');
    const ids = new Set();
    return result.map(row => {
      const value = validateLedgerCorrectionFact(row, budgetId);
      identifier(value.id);
      if (ids.has(value.id)) throw badRequest('Duplicate recorded payment identity');
      ids.add(value.id);
      return value;
    });
  }
  async function state() {
    const current = (await query('SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]))[0] || null;
    const marker = Number(current?.origin_version ?? 0);
    if (![0, 1].includes(marker)) throw badRequest('Unsupported retained standalone origin version');
    if (marker && !allowStandaloneOrigins) throw badRequest('Standalone ledger origins need an upgraded host');
    return current;
  }
  async function allocateSequence() {
    const result = await query(`UPDATE cashflow_ledger_audit_state SET last_sequence = last_sequence + 1
      WHERE budget_id = ? AND last_sequence < 9007199254740991 RETURNING last_sequence`, [budgetId]);
    if (!result.length) throw conflict('Ledger audit sequence exhausted or baseline missing');
    return sequence(result[0].last_sequence);
  }
  const decode = (row, kind) => decodeLedgerAuditRecord(budgetId, row, kind);

  /** Imported original index rows retain the existing correction foreign key.
   * They are checked against the replayed proof, never accepted independently
   * from their hash or a purported standalone capture kind in stored JSON. */
  function importedOriginal(row, expected) {
    return decodeLedgerAuditRecord(budgetId, row, 'original', expected);
  }

  async function original(paymentId) {
    const imported = await origin();
    const row = (await query('SELECT * FROM cashflow_ledger_originals WHERE budget_id = ? AND payment_id = ?', [budgetId, identifier(paymentId)]))[0];
    const expected = imported?.originals.get(paymentId);
    if (expected && !row) throw badRequest('Standalone original index is missing');
    return row ? expected ? importedOriginal(row, expected) : decode(row, 'original') : null;
  }
  async function storedOriginals() {
    const imported = await origin();
    const rows = await query('SELECT * FROM cashflow_ledger_originals WHERE budget_id = ? ORDER BY sequence_number', [budgetId]);
    const ids = new Set(rows.map(row => row.payment_id));
    if (imported && [...imported.originals.keys()].some(id => !ids.has(id))) throw badRequest('Standalone original index is missing');
    return rows.map(row => {
      const expected = imported?.originals.get(row.payment_id);
      return expected ? importedOriginal(row, expected) : decode(row, 'original');
    });
  }
  async function originals() {
    return storedOriginals();
  }
  async function storedCorrections(paymentId = null) {
    const records = paymentId === null
      ? await query('SELECT * FROM cashflow_ledger_corrections WHERE budget_id = ? ORDER BY sequence_number', [budgetId])
      : await query('SELECT * FROM cashflow_ledger_corrections WHERE budget_id = ? AND payment_id = ? ORDER BY sequence_number', [budgetId, identifier(paymentId)]);
    return records.map(row => decode(row, 'correction'));
  }
  async function corrections(paymentId = null) {
    const imported = [...((await origin())?.corrections.values() ?? [])]
      .filter(event => paymentId === null || event.targetId === paymentId).map(clone);
    return imported.concat(await storedCorrections(paymentId));
  }
  /** Refuse untracked writers before planning against their changed facts.
   * Running balances are derived and already stripped by rows(); every other
   * normalized fact must match its original or latest accepted audit event. */
  async function verifiedRows() {
    const effective = await rows();
    // Origin replay includes indirect conversion adjustments from H5 reviews.
    // Reapplying its direct correction DTOs would discard those checked effects.
    const imported = await origin();
    const expected = new Map((await originals()).map(item => [item.row.id,
      imported?.originals.has(item.row.id) ? null : item.row]));
    for (const row of imported?.rows || []) expected.set(row.id, row);
    for (const event of await storedCorrections()) {
      if (!expected.has(event.targetId)) throw conflict('Correction has no retained original evidence');
      if (event.status === 'accepted') expected.set(event.targetId, event.after);
    }
    const actual = new Map(effective.map(row => [row.id, row]));
    for (const [id, row] of expected) {
      if (row === null ? actual.has(id) : !actual.has(id) || encoded(row) !== encoded(actual.get(id))) {
        throw conflict('Effective payment differs from its retained audit evidence');
      }
    }
    if (effective.some(row => !expected.has(row.id))) throw conflict('Accepted payment has no retained original evidence');
    return effective;
  }
  async function capture(row, source, capturedAt, captureKind, actorId) {
    const current = await original(row.id);
    const sourceAtAcceptance = sourceEvidence(row, source, budgetId, captureKind === 'legacy');
    if (current) {
      if (encoded(current.row) !== encoded(row) || encoded(current.sourceAtAcceptance) !== encoded(sourceAtAcceptance)
        || current.captureKind !== captureKind || current.actorId !== actorId) throw conflict('Original payment evidence is immutable');
      return { replayed: true, original: current };
    }
    const data = { version: 1, budgetId, sequence: await allocateSequence(), captureKind, actorId, capturedAt,
      row: clone(row), sourceAtAcceptance };
    await query(`INSERT INTO cashflow_ledger_originals (budget_id, payment_id, sequence_number, data_json, record_hash)
      VALUES (?, ?, ?, ?, ?)`, [budgetId, row.id, data.sequence, encoded(data), digest(data)]);
    return { replayed: false, original: data };
  }
  /** Seed every already accepted fact once, with unknown historical sources.
   * Later untracked inserts are an integrity gap, never a new invented baseline. */
  async function ensureLegacyBaseline({ capturedAt }) {
    timestamp(capturedAt);
    const accepted = await rows();
    const current = await state();
    if (Number(current?.baseline_complete) === 1) {
      const retained = new Set((await originals()).map(value => value.row.id));
      if (accepted.some(row => !retained.has(row.id))) throw conflict('Accepted payment has no retained original evidence');
      return;
    }
    if ((await corrections()).length) throw conflict('Cannot seed legacy evidence after corrections');
    await query('INSERT INTO cashflow_ledger_audit_state (budget_id, last_sequence, baseline_complete) VALUES (?, 0, 0) ON CONFLICT (budget_id) DO NOTHING', [budgetId]);
    for (const row of accepted) await capture(row, null, capturedAt, 'legacy', null);
    await query('UPDATE cashflow_ledger_audit_state SET baseline_complete = 1 WHERE budget_id = ?', [budgetId]);
  }
  /** Called after a new confirmation is inserted, before the owning commit. */
  async function capturePayment({ paymentId, sourceAtAcceptance = null, actorId, capturedAt }) {
    identifier(actorId); timestamp(capturedAt);
    if (Number((await state())?.baseline_complete) !== 1) throw conflict('Complete legacy baseline required');
    const row = (await rows()).find(row => row.id === paymentId);
    if (!row) throw badRequest('Accepted payment is missing from its owning ledger');
    return capture(row, sourceAtAcceptance, capturedAt, 'payment', actorId);
  }
  /** Persist blocked intentions too. Replaying an old ID never re-plans it or
   * applies cached balances after later history changes; retry needs a new ID. */
  async function appendCorrection(input) {
    const required = ['id', 'targetId', 'expectedCorrectionId', 'replacement', 'reason', 'today', 'createdAt', 'actorId'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || required.some(key => !Object.hasOwn(input, key))
      || Object.keys(input).some(key => ![...required, 'retryOf'].includes(key))) throw badRequest('Unsupported correction request fields');
    const { id, targetId, expectedCorrectionId, replacement, reason, today, createdAt, actorId, retryOf = null } = input;
    identifier(id); identifier(targetId); identifier(actorId); timestamp(createdAt); requireIsoDate(today);
    if (retryOf !== null) identifier(retryOf);
    const request = { targetId, expectedCorrectionId, replacement, reason, actorId, retryOf };
    const requestHash = digest(request);
    const existing = (await query('SELECT * FROM cashflow_ledger_corrections WHERE budget_id = ? AND id = ?', [budgetId, id]))[0];
    if (existing) {
      const event = decode(existing, 'correction');
      if (event.requestHash !== requestHash) throw conflict('Correction identity reused for different work');
      return { replayed: true, event, plan: null };
    }
    if (Number((await state())?.baseline_complete) !== 1) throw conflict('Complete legacy baseline required');
    const retained = await original(targetId);
    if (!retained) throw badRequest('Recorded payment has no original audit evidence');
    const history = await corrections(targetId);
    const head = history.filter(value => value.status === 'accepted').at(-1)?.id ?? null;
    if (retryOf !== null) {
      const prior = history.find(value => value.id === retryOf);
      if (!prior || prior.status !== 'blocked' || history.some(value => value.retryOf === retryOf)) {
        throw conflict('Retained intention is missing, foreign or already reviewed');
      }
    }
    const plan = planLedgerCorrection({ budgetId, rows: await verifiedRows(), original: retained.row,
      currentCorrectionId: head, expectedCorrectionId, replacement, reason, today, createdAt,
      sourceAtAcceptance: retained.sourceAtAcceptance, policyVersion: 2,
      openingBalance: (await origin())?.opening.ledgerCurrency === retained.row.ledger_currency ? (await origin()).opening.amount : 0 });
    const event = { version: 2, budgetId, id, targetId, actorId, sequence: await allocateSequence(),
      originalHash: digest(retained), previousAcceptedId: head, retryOf, requestHash,
      requested: clone(replacement), reason, reviewDate: today, createdAt,
      status: plan.status, failureCode: plan.failureCode, blockingIds: clone(plan.blockingIds),
      before: clone(plan.before), after: clone(plan.after) };
    await query(`INSERT INTO cashflow_ledger_corrections (budget_id, id, payment_id, sequence_number, status, data_json, record_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [budgetId, id, targetId, event.sequence, event.status, encoded(event), digest(event)]);
    return { replayed: false, event, plan };
  }
  /** Original installment identities remain counted after their effective rows
   * are voided. Future planning must not reuse an earlier payment identity. */
  async function originalOneOffCounts() {
    return originalOneOffCountsFromEvidence(await originals());
  }
  /** Export only complete, financially replayed evidence consistent with the
   * owning ledger. Runtime backup and confirmation writers use this same replay gate. */
  async function exportSnapshot() {
    const current = await state();
    if (Number(current?.baseline_complete) !== 1) throw conflict('Complete legacy baseline required');
    // Re-read the proof at the final gate, even when earlier methods cached
    // its replay. A faulty writer/trigger cannot hide a changed origin behind
    // a transaction-local cache, including a coherently altered opening/hash.
    retainedOrigin = undefined;
    const imported = await origin();
    const snapshot = { version: imported ? 2 : 1, budgetId, baselineComplete: true, lastSequence: Number(current.last_sequence),
      originals: (await storedOriginals()).filter(item => item.sequence > (imported?.lastSequence ?? 0)),
      corrections: await storedCorrections(), ...(imported ? { origin: clone(imported.origin) } : {}) };
    const replayed = replaySnapshot(snapshot, budgetId);
    const effective = await verifiedRows();
    if (!sameLedgerRows(effective, replayed.rows)) throw conflict('Ledger audit replay differs from effective payments');
    return snapshot;
  }
  /** Restore into an empty audit namespace only, after the host restores the
   * matching effective ledger on this same owning transaction. There is no merge
   * or overwrite of current audit history. Whole-budget snapshot replacement
   * clears only its explicitly replaced namespace on the owning transaction. */
  async function restoreSnapshot(snapshot) {
    const replayed = replaySnapshot(snapshot, budgetId);
    const lastSequence = snapshot.lastSequence;
    const originSequence = replayed.origin?.events.length ?? 0;
    if (await state() || (await originals()).length || (await corrections()).length) {
      throw conflict('Ledger audit restore requires an empty destination');
    }
    const effective = await rows();
    if (!sameLedgerRows(effective, replayed.rows)) throw conflict('Restored ledger differs from retained audit evidence');
    await query(`INSERT INTO cashflow_ledger_audit_state (budget_id, last_sequence, baseline_complete${replayed.origin ? ', origin_version' : ''})
      VALUES (?, ?, 1${replayed.origin ? ', 1' : ''})`,
      [budgetId, lastSequence]);
    if (replayed.origin) {
      const json = JSON.stringify(clone(replayed.origin));
      await query('INSERT INTO cashflow_ledger_origins (budget_id, data_json, record_hash) VALUES (?, ?, ?)',
        [budgetId, json, nodePrimitives.digestText(json)]);
      retainedOrigin = undefined;
      const restored = await origin();
      if (!restored || JSON.stringify(restored.origin) !== json) throw conflict('Standalone origin evidence was not retained');
    }
    // Imported original index rows preserve the correction FK and are verified
    // against the immutable proof on every read. Imported corrections remain
    // derived views; only subsequent server corrections enter their table.
    for (const item of replayed.originals.values()) {
      await query(`INSERT INTO cashflow_ledger_originals (budget_id, payment_id, sequence_number, data_json, record_hash)
        VALUES (?, ?, ?, ?, ?)`, [budgetId, item.row.id, item.sequence, encoded(item), digest(item)]);
    }
    for (const event of replayed.corrections.values()) {
      if (event.sequence <= originSequence) continue;
      await query(`INSERT INTO cashflow_ledger_corrections (budget_id, id, payment_id, sequence_number, status, data_json, record_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [budgetId, event.id, event.targetId, event.sequence, event.status, encoded(event), digest(event)]);
    }
    if (replayed.origin) {
      const expected = { version: 2, budgetId, baselineComplete: true, lastSequence, origin: replayed.origin,
        originals: [...replayed.originals.values()].filter(item => item.sequence > originSequence),
        corrections: [...replayed.corrections.values()].filter(event => event.sequence > originSequence) };
      if (JSON.stringify(clone(await exportSnapshot())) !== JSON.stringify(clone(expected))) throw conflict('Standalone origin restore was not retained completely');
    }
  }
  /** Read only verified immutable proof, including during an uncommitted new
   * confirmation. Current settings cannot redefine its historical currency. */
  async function openingBalance(ledgerCurrency) {
    const retained = await origin();
    return retained?.opening.ledgerCurrency === ledgerCurrency ? retained.opening.amount : 0;
  }
  return { ensureLegacyBaseline, capturePayment, appendCorrection, original, originals, corrections, originalOneOffCounts, exportSnapshot, restoreSnapshot, openingBalance };
}
