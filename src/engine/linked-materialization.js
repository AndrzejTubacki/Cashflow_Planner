import { materializationCheck } from './materialization-rejection.js';
import { localLinkedOrigin } from './local-linked-origin.js';
import { isReserveTransferOccurrenceKey } from './cashflow-occurrence-utils.js';
import { confirmLocalOccurrence } from './local-confirmation.js';
import { prepareLinkedSnapshot } from './linked-snapshot.js';
import { verifyLinkedLedgerAudit } from './linked-ledger-audit.js';
import { rebuildLocalAuditMutation } from './local-audited-snapshot.js';
import { STANDALONE_ORIGIN_SOURCE_FIELDS } from './standalone-ledger-origin.js';
import { ENGINE_AUDIT_HOST_OPTIONS } from './engine-host-capabilities.js';

/** Versioned KEEP: accepted proof is authority; queued, refused and unknown
 * operations remain recoverable intentions, never invented accepted payments.
 * They must receive a fresh local review/identity before any future application. */
export function materializeLinkedStandalone(input, options = ENGINE_AUDIT_HOST_OPTIONS) {
  const invalidInput = reason => Object.assign(new Error('Invalid linked materialization identity'),
    { reason, recordKind: 'command', check: 'INPUT' });
  if (input?.version !== 1) throw invalidInput('MATERIALIZATION_VERSION_UNSUPPORTED');
  if (typeof input.identity !== 'string' || !/^local-[A-Za-z0-9_-]{1,58}$/.test(input.identity)) throw invalidInput('MATERIALIZATION_IDENTITY_INVALID');
  if (typeof input.name !== 'string' || !input.name.trim()) throw invalidInput('MATERIALIZATION_NAME_REQUIRED');
  if (!input.parts || typeof input.parts !== 'object') throw invalidInput('MATERIALIZATION_REPLICA_REQUIRED');
  const retained = materializationCheck('VERIFY_AUDIT', 'ledger-audit', () => verifyLinkedLedgerAudit(input, options));
  if (!retained) throw Object.assign(new Error('Complete accepted audit is required for KEEP'),
    { reason: 'COMPLETE_ACCEPTED_AUDIT_REQUIRED', recordKind: 'ledger-audit', check: 'VERIFY_AUDIT' });
  // Bootstrap can represent an uninitialized server budget as [{}]. Reject
  // absent required settings before linked preview defaults hide the cause;
  // KEEP must retain accepted settings rather than invent standalone defaults.
  const settings = input.parts.settings;
  const missingSettings = reason => Object.assign(new Error('Linked materialization requires complete replica settings'),
    { reason, recordKind: 'settings', check: 'PREPARE_REPLICA' });
  if (!Array.isArray(settings) || settings.length !== 1 || !settings[0] || typeof settings[0] !== 'object'
    || Array.isArray(settings[0]) || !Object.keys(settings[0]).length) throw missingSettings('REPLICA_SETTINGS_REQUIRED');
  for (const [field, reason] of [['future_periods', 'REPLICA_FUTURE_PERIODS_REQUIRED'], ['ledger_currency', 'REPLICA_LEDGER_CURRENCY_REQUIRED']]) {
    if (settings[0][field] == null) throw missingSettings(reason);
  }
  const accepted = materializationCheck('PREPARE_REPLICA', 'replica', () => prepareLinkedSnapshot({ ...input, pending: [] }, options));
  const scope = value => {
    if (Array.isArray(value)) return value.map(scope);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, key === 'budget_id' ? input.identity : scope(item)]));
    return value;
  };
  const snapshot = { ...accepted, budgetId: input.identity, revision: 0, snapshotVersion: 2, name: input.name,
    request: scope(accepted.request), localOpeningBalance: retained.replay.opening?.amount || 0,
    localAuditVersion: 1, localAuditLegacyCount: 0,
    localAudit: [{ kind: 'linked-origin', version: 2, id: `origin-${input.identity}`, audit: retained.audit,
      ledgerCurrency: accepted.request.settings.ledger_currency, currencyEvents: input.parts['currency-events'], pending: accepted.request.tables.pending_transactions }],
    localIntentions: (input.intentions || []).map(operation => ({ ...operation, reviewRequired: true,
      outcome: operation.state === 'sent' || operation.state === 'accepted' ? 'unknown-in-replica' : 'unapplied' })) };
  // Remove server-only notification/auth metadata while retaining the financial
  // settings and captured source evidence in their immutable proof namespace.
  const allowedSettings = ['ledger_currency', 'timezone', 'locale', 'holiday_country', 'future_periods',
    'minimum_reserve_enabled', 'minimum_reserve_amount', 'budget_period_income_id', 'fx_buffer_percent',
    'necessary_underfunded_repeat_days', 'manual_fx_rates', 'fx_provider', 'fx_used_currencies'];
  snapshot.request.settings = Object.fromEntries(Object.entries(snapshot.request.settings).filter(([key]) => allowedSettings.includes(key)));
  for (const [table, fields] of Object.entries(STANDALONE_ORIGIN_SOURCE_FIELDS)) snapshot.request.tables[table] =
    snapshot.request.tables[table].map(row => Object.fromEntries(Object.entries(row).filter(([key]) => fields.includes(key))));
  if (snapshot.request.fxSnapshot) snapshot.request.fxSnapshot = Object.fromEntries(Object.entries(snapshot.request.fxSnapshot)
    // The server cache also carries identity quotes and legacy currency aliases.
    // They are cache helpers, not standalone foreign planning rates.
    .filter(([pair]) => pair.endsWith('/' + snapshot.request.settings.ledger_currency.toLowerCase())
      && pair.split('/')[0] !== snapshot.request.settings.ledger_currency.toLowerCase())
    .map(([pair, entry]) => [pair, Object.fromEntries(Object.entries(entry).filter(([key]) => ['rate', 'source', 'effectiveDate', 'fetchedAt'].includes(key)))]));
  delete snapshot.linked;
  snapshot.request.tables.future_transactions = [];
  const timing = { today: input.today, generationTimestamp: input.generationTimestamp, idSeed: input.idSeed };
  let result = materializationCheck('REBUILD_JOURNAL', 'linked-origin', () => rebuildLocalAuditMutation(snapshot, timing));
  let blocked = false;
  for (let index = 0; index < result.localIntentions.length; index++) {
    const intention = result.localIntentions[index];
    if (intention.state !== 'queued') continue;
    if (blocked) { intention.reason = 'EARLIER_INTENTION_NEEDS_REVIEW'; continue; }
    // Currency selection, corrections and dismissals require fresh explicit
    // financial review. Unknown/SENT outcomes are never included in this path.
    if (intention.kind === 'ledger.correct' || intention.kind === 'one-off.dismiss-remainder'
      || intention.kind === 'settings.update') {
      intention.reason = 'EXPLICIT_REVIEW_REQUIRED'; blocked = true; continue;
    }
    try {
      let next;
      if (intention.kind === 'occurrence.confirm') {
        next = confirmLocalOccurrence({ snapshot: result, ...timing, idSeed: `keep-${input.idSeed}-${index}`,
          occurrenceKey: intention.payload.occurrenceKey, amount: intention.payload.amount,
          actualDate: intention.payload.confirmedDate, fxRate: intention.payload.fxRate ?? undefined });
      } else {
        const parts = { ...input.parts, settings: [result.request.settings],
          planning: Object.entries(result.request.tables).filter(([table]) => !['ledger_currency_events', 'future_transactions', 'projection_snapshots'].includes(table))
            .flatMap(([table, rows]) => rows.map(row => ({ table, row }))), ledger: input.parts.ledger };
        // Preview planning only; the current local journal remains authoritative
        // for accepted money. Financial validation below may retain a refusal.
        const preview = prepareLinkedSnapshot({ ...input, parts, pending: [intention] }, options);
        if (preview.linked.unapplied.length) throw new Error('INTENTION_NOT_APPLICABLE');
        next = rebuildLocalAuditMutation({ ...result, request: { ...result.request,
          settings: preview.request.settings, tables: preview.request.tables } }, timing);
      }
      result = next;
      const retained = result.localIntentions[index];
      retained.outcome = 'applied-locally'; retained.reviewRequired = false;
    } catch (_) { result.localIntentions[index].reason = 'LOCAL_REVIEW_REQUIRED'; blocked = true; }
  }
  // Some accepted server workflow rows have no standalone command (for
  // example first-run opening decisions or a deleted historical source).
  // Preserve them visibly for fresh review instead of guessing acceptance.
  const seed = localLinkedOrigin(result.localAudit[0], result.budgetId);
  const sources = new Set(['one_off_transactions', 'recurring_incomes', 'recurring_expenses', 'goals', 'flex_transactions']
    .flatMap(table => result.request.tables[table]).map(row => row.id));
  for (const row of result.request.tables.pending_transactions) {
    const refs = ['source_one_off_id', 'source_recurring_income_id', 'source_recurring_expense_id', 'source_goal_id', 'source_flex_id']
      .map(field => row[field]).filter(Boolean);
    const conversion = String(row.occurrence_key).startsWith('ledger_currency_conversion:');
    const available = conversion ? seed.conversions.has(row.occurrence_key)
      : isReserveTransferOccurrenceKey(row.occurrence_key) || (refs.length === 1 && sources.has(refs[0]));
    if (!available) result.localIntentions.push({ kind: 'pending-decision', payload: row, state: 'retained',
      outcome: 'unapplied', reviewRequired: true, reason: 'LOCAL_REVIEW_REQUIRED' });
  }
  return result;
}
export function materializeLinkedStandaloneJson(json) {
  try { return JSON.stringify({ ok: true, snapshot: materializeLinkedStandalone(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: 'LINKED_MATERIALIZATION_REJECTED', message: 'Linked materialization rejected', reason: error.reason || 'INVALID_MATERIALIZATION_INPUT',
    recordKind: error.recordKind || 'command', check: error.check || 'INPUT' } }); }
}
