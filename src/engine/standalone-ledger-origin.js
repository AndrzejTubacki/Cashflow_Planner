import { localLinkedOrigin } from "./local-linked-origin.js";
import { canonicalAuditValue } from './ledger-audit-json.js';
import { replayLocalAudit, localAuditBalances } from './local-audit.js';
import { normalizeLedgerAuditFact, LEDGER_AUDIT_FACT_FIELDS } from './ledger-audit-fact.js';
import { validateLedgerCorrectionFact } from './cashflow-ledger-correction-plan.js';
import { sortConfirmedRowsForBalance } from './cashflow-ledger-balance-utils.js';
import { requireIsoDate } from './cashflow-date-utils.js';
import { requireSupportedCurrency } from './cashflow-fx-provider-utils.js';

// A financial proof has no notification destinations, credentials or opaque
// nested metadata. Keep this portable format independent of database drivers.
const common = ['budget_id', 'id', 'name', 'currency', 'amount', 'created_at', 'updated_at'];
const recurring = [...common, 'active', 'prediction_strategy', 'prediction_substitute_missing',
  'prediction_min_recorded_months', 'repeat_every_months', 'start_month_year', 'end_month_year',
  'anchor_type', 'anchor_day_of_month', 'anchor_offset_days', 'anchor_business_day_adjustment', 'anchor_holiday_country'];
export const STANDALONE_ORIGIN_SOURCE_FIELDS = {
  planned_transactions: ['budget_id', 'id', 'type', 'operating_priority', 'goal_priority', 'created_at', 'updated_at'],
  one_off_transactions: [...common, 'type', 'date'],
  recurring_incomes: [...recurring, 'period_setting'],
  recurring_expenses: [...recurring, 'necessary', 'anchor_income_id', 'planned_transaction_id'],
  goals: [...common, 'active', 'due_date', 'planned_transaction_id'],
  flex_transactions: [...common, 'active', 'allow_split', 'min_amount', 'max_amount', 'planned_transaction_id']
};
const FACT = [...LEDGER_AUDIT_FACT_FIELDS, 'status', 'period', 'requested_amount', 'funded_amount',
  'running_balance', 'note', 'generation_timestamp', 'pending_origin'];
const ROOT = ['version', 'sourceBudgetId', 'sourceRevision', 'openingBalance', 'ledgerCurrency',
  'futurePeriods', 'legacyCount', 'reviewDate', 'materializedAt', 'events'];
const PAYMENT = ['kind', 'id', 'row', 'source'];
const CORRECTION = ['kind', 'id', 'targetId', 'expectedCorrectionId', 'reason', 'requested', 'createdAt', 'today',
  'status', 'failureCode', 'before', 'after', 'retryOf', 'source', 'targetLimit'];

/** Exact known fields prevent a future or private value from becoming silently
 * portable under this version. Row values are flat and finite JSON scalars. */
function fields(value, allowed, exact = false) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).some(key => !allowed.includes(key))
    || (exact && Object.keys(value).length !== allowed.length)) throw new Error('Unsupported standalone origin fields');
}
function flat(value, allowed, budgetId) {
  fields(value, allowed);
  if (Object.values(value).some(item => item !== null && (!['string', 'number', 'boolean'].includes(typeof item)
    || (typeof item === 'number' && !Number.isFinite(item))))) throw new Error('Invalid standalone origin row');
  if (value.budget_id != null && value.budget_id !== budgetId) throw new Error('Foreign standalone origin evidence');
}

/** The new server facts express actual payment dates. Complete local evidence
 * stays in its original namespace and retains capture dates and old policies.
 * Updated time truthfully records materialization; creation retains its instant.
 * This function cannot grant access or turn a checksum into authorship proof. */
function projectedFact(row, budgetId, materializedAt) {
  return validateLedgerCorrectionFact(normalizeLedgerAuditFact({ ...row, budget_id: budgetId,
    confirmed_date: row.date, ledger_year: Number(row.date.slice(0, 4)), updated_at: materializedAt }, budgetId), budgetId);
}

/** Replay a versioned immutable standalone origin before accepting its mapped
 * financial facts. Native/server hosts supply UTF-8 counting, never input data.
 * All legacy/blocked/retry outcomes are checked under the recorded local rules;
 * they are not submitted as new server corrections. An origin alone is not a
 * server audit snapshot, transfer receipt, database write or authorization.
 * Bounds are checked before quadratic financial replay or canonical encoding. */
export function replayStandaloneLedgerOrigin({ origin, budgetId, utf8ByteLength }) {
  const v2 = origin?.version === 2;
  fields(origin, [...ROOT, ...(v2 ? ['openingBalances'] : [])], true);
  if (![1, 2].includes(origin.version) || typeof origin.sourceBudgetId !== 'string' || !/^local-[A-Za-z0-9_-]{1,58}$/.test(origin.sourceBudgetId)
    || typeof budgetId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(budgetId) || budgetId.startsWith('local-')
    || !Number.isSafeInteger(origin.sourceRevision) || origin.sourceRevision < 0
    || typeof utf8ByteLength !== 'function' || !Array.isArray(origin.events) || origin.events.length > 200000
    || !Number.isInteger(origin.futurePeriods) || origin.futurePeriods < 1 || origin.futurePeriods > 24
    || typeof origin.ledgerCurrency !== 'string' || requireSupportedCurrency(origin.ledgerCurrency) !== origin.ledgerCurrency
    || typeof origin.openingBalance !== 'number' || !Number.isFinite(origin.openingBalance)
    || !Number.isSafeInteger(Math.round(origin.openingBalance * 100))
    || Math.abs(origin.openingBalance * 100 - Math.round(origin.openingBalance * 100)) >= 0.00001
    || !Number.isSafeInteger(origin.legacyCount) || origin.legacyCount < 0 || origin.legacyCount > origin.events.length) throw new Error('Invalid standalone origin scope or version');
  requireIsoDate(origin.reviewDate);
  const instant = origin.materializedAt;
  if (typeof instant !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant)
    || !Number.isFinite(Date.parse(instant)) || new Date(instant).toISOString() !== instant) throw new Error('Invalid standalone origin materialization instant');
  const payments = origin.events.filter(event => event?.kind === 'payment').length;
  if (Math.max(1, payments) * origin.events.length > 50000000) throw new Error('Standalone origin exceeds replay work limit');
  for (const event of origin.events) {
    if (v2 && event?.kind === 'linked-origin') {
      localLinkedOrigin(event, origin.sourceBudgetId);
      continue; // Independent replay verifies complete original linked lineage.
    }
    if (v2 && event?.kind === 'ledger-currency') {
      fields(event, ['kind', 'id', 'event', 'pending'], true);
      flat(event.event, ['id', 'old_currency', 'new_currency', 'old_balance', 'converted_opening_balance', 'fx_rate', 'rate_date', 'source', 'details', 'created_at'], origin.sourceBudgetId);
      flat(event.pending, FACT, origin.sourceBudgetId);
      continue; // replayLocalAudit verifies exact records and accepted prefix balances.
    }
    const keys = event?.kind === 'payment' ? PAYMENT : event?.kind === 'correction' ? CORRECTION : null;
    if (!keys) throw new Error('Unsupported standalone origin event');
    fields(event, [...keys, ...(Object.hasOwn(event, 'policyVersion') ? ['policyVersion'] : []), ...(v2 && Object.hasOwn(event, 'conversionReview') ? ['conversionReview'] : [])], true);
    for (const [key, value] of Object.entries(event)) if (!['row', 'source', 'before', 'after', 'requested', ...(v2 ? ['conversionReview'] : [])].includes(key)
      && value !== null && (!['string', 'number', 'boolean'].includes(typeof value)
        || (typeof value === 'number' && !Number.isFinite(value)))) throw new Error('Invalid standalone origin event value');
    if (event.kind === 'payment') flat(event.row, FACT, origin.sourceBudgetId);
    else {
      for (const value of [event.before, event.after]) if (value !== null) flat(value, FACT, origin.sourceBudgetId);
      if (event.requested !== null) flat(event.requested, ['amount', 'date', 'fx_rate'], origin.sourceBudgetId);
    }
    // Reserve payments carry null source evidence; financial replay below
    // rejects null evidence for every other payment kind.
    if (event.source !== null) {
      fields(event.source, ['table', 'row', 'plan'], true);
      if (v2 && event.source.table === 'ledger_currency_events') {
        flat(event.source.row, ['id', 'old_currency', 'new_currency', 'old_balance', 'converted_opening_balance', 'fx_rate', 'rate_date', 'source', 'details', 'created_at'], origin.sourceBudgetId);
        if (event.source.plan !== null) throw new Error('Invalid conversion source plan');
        continue;
      }
      if (typeof event.source.table !== 'string' || !Object.hasOwn(STANDALONE_ORIGIN_SOURCE_FIELDS, event.source.table)
        || event.source.table === 'planned_transactions') throw new Error('Invalid standalone origin source');
      flat(event.source.row, STANDALONE_ORIGIN_SOURCE_FIELDS[event.source.table], origin.sourceBudgetId);
      if (event.source.plan !== null) flat(event.source.plan, STANDALONE_ORIGIN_SOURCE_FIELDS.planned_transactions, origin.sourceBudgetId);
    }
  }
  if (utf8ByteLength(JSON.stringify(origin)) > 10 * 1024 * 1024) throw new Error('Standalone origin exceeds 10 MB');
  const proof = canonicalAuditValue(origin);
  const state = replayLocalAudit({ events: proof.events, opening: proof.openingBalance,
    settings: { ledger_currency: proof.ledgerCurrency, future_periods: proof.futurePeriods },
    today: proof.reviewDate, budgetId: proof.sourceBudgetId, legacyCount: proof.legacyCount });
  const initialCurrency = originOpenings(proof.events, proof.openingBalance, proof.ledgerCurrency)[0].ledgerCurrency;
  const openings = originOpenings(proof.events, proof.openingBalance, proof.ledgerCurrency);
  if (v2 && JSON.stringify(proof.openingBalances) !== JSON.stringify(canonicalAuditValue(openings))) throw new Error('Altered standalone per-currency opening evidence');
  const project = row => projectedFact(row, budgetId, proof.materializedAt);
  const scope = row => row === null ? null : { ...row, ...(Object.hasOwn(row, 'budget_id') ? { budget_id: budgetId } : {}) };
  const originals = new Map();
  const corrections = new Map();
  for (const [index, event] of proof.events.entries()) {
    if (event.kind === 'linked-origin') {
      const seed = localLinkedOrigin(event, proof.sourceBudgetId);
      for (const [id, item] of seed.originals) originals.set(id, { version: 2, budgetId, sequence: index + 1,
        captureKind: 'standalone', actorId: null, capturedAt: proof.materializedAt, row: project(item.row),
        sourceAtAcceptance: item.source == null || item.source.table === 'ledger_currency_events' ? null : { table: item.source.table, row: scope(item.source.row), plan: scope(item.source.plan) } });
      for (const [id, item] of seed.replay.corrections) corrections.set(id, { ...item, budgetId,
        before: item.before == null ? null : project(item.before), after: item.after == null ? null : project(item.after) });
    }
    else if (event.kind === 'payment') originals.set(event.id, { version: 2, budgetId, sequence: index + 1,
      captureKind: 'standalone', actorId: null, capturedAt: proof.materializedAt, row: project(event.row),
      // Server system conversions have no mutable planning source. Their exact
      // transition evidence remains in the origin, verified by local replay.
      sourceAtAcceptance: event.source === null || event.source.table === 'ledger_currency_events' ? null : { table: event.source.table, row: scope(event.source.row), plan: scope(event.source.plan) } });
    else if (event.kind === 'correction') corrections.set(event.id, { version: 3, budgetId, sequence: index + 1, captureKind: 'standalone',
      actorId: null, id: event.id, targetId: event.targetId, previousAcceptedId: event.expectedCorrectionId,
      retryOf: event.retryOf, reason: event.reason, requested: event.requested,
      reviewDate: event.today, createdAt: event.createdAt, status: event.status, failureCode: event.failureCode,
      // Earlier standalone records did not retain blocking IDs. Preserve that
      // absence explicitly; do not invent a new historical dependency review.
      blockingIds: [],
      before: event.before === null ? null : project(event.before), after: event.after === null ? null : project(event.after) });
  }
  const rows = state.rows.map(project);
  // Server timestamp precision may not silently replace financial order with
  // an opaque-ID tie-break. Keep local proof intact and refuse a lossy mapping.
  for (const [before, after] of [[[...state.originals.values()].map(event => event.row), [...originals.values()].map(item => item.row)],
    [state.rows, rows]]) {
    const ids = sortConfirmedRowsForBalance(before).map(row => row.id);
    if (sortConfirmedRowsForBalance(after).some((row, index) => row.id !== ids[index])) throw new Error('Standalone transfer timestamp normalization changes financial order');
  }
  return { origin: proof, rows, originals, corrections, heads: state.heads,
    opening: { ledgerCurrency: initialCurrency, amount: proof.openingBalance },
    currencyEvents: state.currencyEvents, pendingConversions: state.pendingConversions,
    balances: localAuditBalances(rows, { currency: initialCurrency, amount: proof.openingBalance }),
    lastSequence: proof.events.length, evaluations: Math.max(1, payments) * proof.events.length };
}

/** Create only from the already validated canonical standalone source. Replay
 * remains mandatory before mapped facts become financial authority. Planning,
 * credentials and local saved forms do not enter this immutable audit proof. */
export function standaloneLedgerOrigin(snapshot, materializedAt) {
  const version = snapshot.transferVersion === 2 || snapshot.localAudit.some(event => event.kind === 'ledger-currency' || event.kind === 'linked-origin' || event.conversionReview) ? 2 : 1;
  return canonicalAuditValue({ version, sourceBudgetId: snapshot.budgetId, sourceRevision: snapshot.revision,
    openingBalance: snapshot.localOpeningBalance, ledgerCurrency: snapshot.request.settings.ledger_currency,
    futurePeriods: snapshot.request.settings.future_periods, legacyCount: snapshot.localAuditLegacyCount,
    reviewDate: snapshot.request.today, materializedAt, events: snapshot.localAudit,
    ...(version === 2 ? { openingBalances: originOpenings(snapshot.localAudit, snapshot.localOpeningBalance, snapshot.request.settings.ledger_currency) } : {}) });
}

/** Only the original currency owns a pre-audit offset. Conversion payments are
 * ordinary retained facts, so subsequent currencies start at zero even on return. */
function originOpenings(events, amount, current) {
  const seed = events[0]?.kind === 'linked-origin' ? localLinkedOrigin(events[0], events[0].audit.budgetId) : null;
  const initial = seed?.opening.ledgerCurrency || events.find(event => event.kind === 'ledger-currency')?.event.old_currency || current;
  const currencies = [...new Set([initial, ...(seed?.currencyEvents.map(event => event.new_currency) || []), ...events.filter(event => event.kind === 'ledger-currency').map(event => event.event.new_currency)])];
  return currencies.map(ledgerCurrency => ({ ledgerCurrency, amount: ledgerCurrency === initial ? amount : 0 }));
}
