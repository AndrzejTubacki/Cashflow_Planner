import { materializationCheck } from './materialization-rejection.js';
import { originalOneOffCountsFromEvidence } from './ledger-audit-progress.js';
import { requireIsoDate } from './cashflow-date-utils.js';
import { badRequest } from './cashflow-user-utils.js';
import { planLedgerCorrection, validateLedgerCorrectionFact } from './cashflow-ledger-correction-plan.js';
import { canonicalAuditValue } from './ledger-audit-json.js';
import { replayStandaloneLedgerOrigin } from './standalone-ledger-origin.js';

/** Shared, deterministic audit replay. The owning host supplies synchronous
 * SHA-256/UTF-8 primitives; Node uses its crypto API, Android can use its platform
 * hashing API. No storage, credentials, clock, network or module loader enters
 * financial replay. Host primitives never come from an imported audit file. */
export function createLedgerAuditReplay({ digestText, utf8ByteLength, allowStandaloneOrigins = false }) {
  if (typeof digestText !== 'function' || typeof utf8ByteLength !== 'function') {
    throw new Error('Trusted audit hashing and UTF-8 length primitives required');
  }
  if (typeof allowStandaloneOrigins !== 'boolean') throw new Error('Explicit standalone-origin host policy required');
  const MAX_RECORD_BYTES = 1024 * 1024;
  const SOURCE_FIELDS = { one_off_transactions: 'source_one_off_id', recurring_incomes: 'source_recurring_income_id',
    recurring_expenses: 'source_recurring_expense_id', goals: 'source_goal_id', flex_transactions: 'source_flex_id' };
  const clone = canonicalAuditValue;

  function encoded(value) {
    const json = JSON.stringify(canonicalAuditValue(value));
    if (utf8ByteLength(json) > MAX_RECORD_BYTES) throw badRequest('Ledger audit record is too large');
    return json;
  }
  const digest = value => digestText(encoded(value));

  /** IDs are SQL parameters, never paths; control characters are not audit IDs. */
  function identifier(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw badRequest('Invalid ledger audit identity');
    }
    return value;
  }
  function timestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw badRequest('Invalid ledger audit timestamp');
    requireIsoDate(value.slice(0, 10));
  }
  function sequence(value) {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 1) throw badRequest('Invalid ledger audit sequence');
    return result;
  }
  /** Versioned audit DTOs are lossless: reject fields an older reader cannot keep. */
  function exactKeys(value, keys) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw badRequest('Unsupported ledger audit fields');
  }

  /** Capture only known source evidence; legacy rows explicitly retain null.
   * Later planning edits must never be passed off as their historical authority. */
  function sourceEvidence(row, source, budgetId, legacy) {
    if (legacy && source !== null) throw badRequest('Legacy source evidence is unknown');
    if (source === null) {
      if (!legacy && Object.values(SOURCE_FIELDS).some(field => row[field])) throw badRequest('Accepted source evidence required');
      return null;
    }
    const keys = Object.keys(source || {}).sort().join(',');
    if (!['row,table', 'plan,row,table'].includes(keys) || !SOURCE_FIELDS[source.table]
      || !source.row || Object.getPrototypeOf(source.row) !== Object.prototype
      || source.row?.id !== row[SOURCE_FIELDS[source.table]] || source.row.currency !== row.currency) {
      throw badRequest('Captured source differs from its payment');
    }
    const expectedType = source.table === 'one_off_transactions' ? source.row.type
      : source.table === 'recurring_incomes' ? 'income' : 'expense';
    if (expectedType !== row.type) throw badRequest('Captured source type differs from its payment');
    for (const value of [source.row, source.plan]) {
      if (value && Object.hasOwn(value, 'budget_id') && value.budget_id !== budgetId) throw badRequest('Foreign captured source');
    }
    if (source.row.planned_transaction_id != null && source.plan == null) throw badRequest('Captured source plan is missing');
    if (source.plan != null && (Object.getPrototypeOf(source.plan) !== Object.prototype
      || typeof source.plan.id !== 'string' || !source.plan.id || source.row.planned_transaction_id !== source.plan.id)) {
      throw badRequest('Captured source plan differs');
    }
    if (source.table === 'goals') requireIsoDate(source.row.due_date);
    return canonicalAuditValue(source);
  }

  /** Validate portable retained evidence by replaying every correction, rather
   * than trusting claimed outcomes or checksums. This is an internal backup/import
   * building block, not authorization or proof of who authored an imported file.
   * Legacy originals form one initial group with explicitly unknown sources.
   * Replay is bounded in size and total fact evaluations to reject costly input. */
  function replayLedgerAuditSnapshot(snapshot, expectedBudgetId) {
    identifier(expectedBudgetId);
    const transferred = snapshot?.version === 2;
    // Keep current storage/import/download hosts closed until they also retain
    // origins, apply offsets and negotiate the new state format. Opt-in is a
    // host construction choice, never a field supplied by imported audit JSON.
    if (transferred && !allowStandaloneOrigins) throw badRequest('Standalone ledger origins need an upgraded host');
    exactKeys(snapshot, ['version', 'budgetId', 'baselineComplete', 'lastSequence', 'originals', 'corrections', ...(transferred ? ['origin'] : [])]);
    const origin = transferred ? replayStandaloneLedgerOrigin({ origin: snapshot.origin, budgetId: expectedBudgetId, utf8ByteLength }) : null;
    const baseline = origin?.lastSequence ?? 0;
    if (![1, 2].includes(snapshot.version) || snapshot.budgetId !== expectedBudgetId || snapshot.baselineComplete !== true
      || !Array.isArray(snapshot.originals) || !Array.isArray(snapshot.corrections)
      || baseline + snapshot.originals.length + snapshot.corrections.length > 200000
      || !Number.isSafeInteger(snapshot.lastSequence) || snapshot.lastSequence !== baseline + snapshot.originals.length + snapshot.corrections.length) {
      throw badRequest('Complete scoped ledger audit snapshot required');
    }
    const entries = [...snapshot.originals.map(value => ({ kind: 'original', value })),
      ...snapshot.corrections.map(value => ({ kind: 'correction', value }))];
    let bytes = origin ? utf8ByteLength(JSON.stringify(origin.origin)) : 0;
    for (const { value } of entries) {
      bytes += utf8ByteLength(encoded(value));
      if (bytes > 64 * 1024 * 1024) throw badRequest('Ledger audit snapshot is too large');
    }
    entries.sort((a, b) => sequence(a.value.sequence) - sequence(b.value.sequence));
    const active = new Map(origin?.rows.map(row => [row.id, row]) ?? []);
    const retained = new Map(origin?.originals ?? []), heads = new Map(origin?.heads ?? []), events = new Map(origin?.corrections ?? []);
    // Existing local retry branches replay under their recorded policy. New
    // server reviews consume only unreviewed leaves; no old outcome is changed.
    const reviewed = new Set(origin?.origin.events.filter(event => event.kind === 'correction' && event.retryOf !== null).map(event => event.retryOf) ?? []);
    let legacyClosed = origin !== null;
    let evaluations = origin?.evaluations ?? 0;
    for (const [index, { kind, value }] of entries.entries()) {
      try {
      if (!(kind === 'original' ? value.version === 1 : [1, 2].includes(value.version)) || value.budgetId !== expectedBudgetId || value.sequence !== baseline + index + 1) {
        throw badRequest('Incomplete or foreign ledger audit sequence');
      }
      if (kind === 'original') {
        exactKeys(value, ['version', 'budgetId', 'sequence', 'captureKind', 'actorId', 'capturedAt', 'row', 'sourceAtAcceptance']);
        timestamp(value.capturedAt);
        if (!['legacy', 'payment'].includes(value.captureKind)) throw badRequest('Unsupported original capture kind');
        const legacy = value.captureKind === 'legacy';
        if (legacy && (legacyClosed || value.actorId !== null)) throw badRequest('Invalid legacy audit boundary');
        if (!legacy) { identifier(value.actorId); legacyClosed = true; }
        const row = validateLedgerCorrectionFact(value.row, expectedBudgetId);
        identifier(row.id);
        if (encoded(row) !== encoded(value.row) || retained.has(row.id)) throw badRequest('Duplicate or derived original evidence');
        sourceEvidence(row, value.sourceAtAcceptance, expectedBudgetId, legacy);
        retained.set(row.id, value); active.set(row.id, row); heads.set(row.id, null);
      } else {
        legacyClosed = true;
        exactKeys(value, ['version', 'budgetId', 'id', 'targetId', 'actorId', 'sequence', 'originalHash',
          'previousAcceptedId', 'retryOf', 'requestHash', 'requested', 'reason', 'reviewDate', 'createdAt',
          'status', 'failureCode', 'blockingIds', 'before', 'after']);
        identifier(value.id); identifier(value.targetId); identifier(value.actorId); timestamp(value.createdAt);
        requireIsoDate(value.reviewDate);
        const original = retained.get(value.targetId);
        if (!original || events.has(value.id) || value.originalHash !== digest(original)
          || value.previousAcceptedId !== heads.get(value.targetId)) throw badRequest('Invalid correction evidence chain');
        if (value.retryOf !== null) {
          identifier(value.retryOf);
          const prior = events.get(value.retryOf);
          if (!prior || prior.targetId !== value.targetId || prior.status !== 'blocked' || reviewed.has(value.retryOf)) {
            throw badRequest('Invalid retained intention review');
          }
          reviewed.add(value.retryOf);
        }
        if (value.requestHash !== digest({ targetId: value.targetId, expectedCorrectionId: value.previousAcceptedId,
          replacement: value.requested, reason: value.reason, actorId: value.actorId, retryOf: value.retryOf })) {
          throw badRequest('Correction request differs from its retained evidence');
        }
        evaluations += active.size;
        if (evaluations > 50000000) throw badRequest('Ledger audit replay exceeds its work limit');
        const plan = planLedgerCorrection({ budgetId: expectedBudgetId, rows: [...active.values()], original: original.row,
          currentCorrectionId: heads.get(value.targetId), expectedCorrectionId: value.previousAcceptedId,
          replacement: value.requested, reason: value.reason, today: value.reviewDate, createdAt: value.createdAt,
          sourceAtAcceptance: original.sourceAtAcceptance, policyVersion: value.version,
          openingBalance: origin?.opening.ledgerCurrency === original.row.ledger_currency ? origin.opening.amount : 0 });
        for (const key of ['status', 'failureCode', 'blockingIds', 'before', 'after']) {
          if (encoded(value[key]) !== encoded(plan[key])) throw badRequest('Correction result differs from financial replay');
        }
        if (plan.status === 'accepted') {
          if (plan.after) active.set(value.targetId, plan.after); else active.delete(value.targetId);
          heads.set(value.targetId, value.id);
        }
        events.set(value.id, value);
      }
      } catch (error) {
        // Label the record kind, never the record ID or captured financial value.
        materializationCheck('VERIFY_AUDIT_RECORD', kind === 'original' ? 'audit-original' : 'audit-correction', () => { throw error; });
      }
    }
    return { rows: [...active.values()].map(clone), heads, originals: new Map([...retained].map(([id, value]) => [id, clone(value)])),
      corrections: new Map([...events].map(([id, value]) => [id, clone(value)])),
      ...(origin ? { origin: clone(origin.origin), opening: clone(origin.opening) } : {}) };
  }

  /** Explicit independent-copy import only. First verify the original lineage,
   * then re-scope ownership metadata and its integrity hashes. Financial facts,
   * actors, timestamps, reasons, event IDs and review dependencies stay intact.
   * Imported actors are historical claims, never authorization on the destination. */
  function copyLedgerAuditSnapshot(snapshot, destinationBudgetId) {
    replayLedgerAuditSnapshot(snapshot, snapshot.budgetId);
    identifier(destinationBudgetId);
    const copied = clone(snapshot);
    const scope = row => { if (row && Object.hasOwn(row, 'budget_id')) row.budget_id = destinationBudgetId; };
    copied.budgetId = destinationBudgetId;
    const hashes = new Map();
    if (copied.version === 2) {
      // The source proof keeps its original local namespace. Re-derive mapped
      // originals in the new server namespace before rebuilding integrity links.
      const origin = replayStandaloneLedgerOrigin({ origin: copied.origin, budgetId: destinationBudgetId, utf8ByteLength });
      for (const [id, item] of origin.originals) hashes.set(id, digest(item));
    }
    for (const item of copied.originals) {
      item.budgetId = destinationBudgetId; scope(item.row);
      if (item.sourceAtAcceptance) { scope(item.sourceAtAcceptance.row); scope(item.sourceAtAcceptance.plan); }
      hashes.set(item.row.id, digest(item));
    }
    for (const event of copied.corrections) {
      event.budgetId = destinationBudgetId;
      event.originalHash = hashes.get(event.targetId);
      scope(event.before); scope(event.after);
    }
    replayLedgerAuditSnapshot(copied, destinationBudgetId);
    return copied;
  }

  return { replayLedgerAuditSnapshot, copyLedgerAuditSnapshot, originalOneOffCountsFromEvidence, encoded, digest, identifier, timestamp, sequence, sourceEvidence };
}
