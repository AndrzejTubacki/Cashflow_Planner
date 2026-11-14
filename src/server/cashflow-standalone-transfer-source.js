import { POSTGRES_BUDGET_COLUMNS } from './cashflow-postgres-budget-schema.js';
import { refreshLocalSnapshot } from '../engine/local-confirmation.js';
import { validateAndNormalizeSettings } from './cashflow-settings-validation.js';

// Match the existing individual standalone backup bound. This internal reader
// allocates no budget, grants no access and is not registered as an HTTP writer.
export const STANDALONE_TRANSFER_MAX_BYTES = 10 * 1024 * 1024;
const MAX_FACT_EVALUATIONS = 50_000_000;
const TABLES = ['planned_transactions', 'recurring_incomes', 'recurring_expenses', 'one_off_transactions', 'goals', 'flex_transactions'];
const ROOT = ['snapshotVersion', 'budgetId', 'revision', 'name', 'request', 'localOpeningBalance',
  'transferVersion', 'localHistory', 'localAuditVersion', 'localAuditLegacyCount', 'localAudit', 'localLastConfirmationId', 'localIntentions'];
const REQUEST = ['protocolVersion', 'today', 'generationTimestamp', 'idSeed', 'settings', 'tables', 'fxSnapshot',
  'openingBalance', 'predictionRows', 'confirmedRowsAfterToday', 'handledOccurrenceKeys', 'oneOffProgress', 'confirmedFunding'];
const SETTINGS = ['ledger_currency', 'timezone', 'locale', 'holiday_country', 'future_periods',
  'minimum_reserve_enabled', 'minimum_reserve_amount', 'budget_period_income_id', 'fx_buffer_percent',
  'necessary_underfunded_repeat_days', 'manual_fx_rates', 'fx_provider', 'fx_used_currencies'];
const FACT = [...new Set(['ledger_year', ...POSTGRES_BUDGET_COLUMNS.confirmed_transactions,
  ...POSTGRES_BUDGET_COLUMNS.pending_transactions, ...POSTGRES_BUDGET_COLUMNS.future_transactions])];

/** Unknown fields are refused, rather than forwarding credentials, alert
 * destinations or future financial semantics under an older transfer format. */
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported standalone transfer fields');
}

/** Database-shaped financial rows are flat. Scope is checked even for current
 * planning rows whose historical source has already been edited or deleted. */
function row(value, allowed, budgetId) {
  fields(value, allowed);
  if (Object.values(value).some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item))) {
    throw new Error('Standalone transfer requires flat financial rows');
  }
  if (value.budget_id != null && value.budget_id !== budgetId) throw new Error('Foreign standalone transfer source scope');
}

/** Captured source/plan evidence remains in its original local namespace.
 * It does not acquire server permissions by passing this financial reader. */
function evidence(value, budgetId) {
  if (value === null) return; // Reserve halves have no planning source; replay verifies this.
  fields(value, ['table', 'row', 'plan']);
  if (![...TABLES, 'ledger_currency_events'].includes(value.table) || value.table === 'planned_transactions') throw new Error('Invalid standalone transfer source table');
  row(value.row, POSTGRES_BUDGET_COLUMNS[value.table], budgetId);
  if (value.plan !== null) row(value.plan, POSTGRES_BUDGET_COLUMNS.planned_transactions, budgetId);
}

/** Validate a bounded standalone financial source before storage allocation.
 * Host-supplied timing is explicit. Complete audit replay, not supplied balance,
 * progress or funding mirrors, determines the financial result. Returned rows
 * still have local identities and date semantics: this is preflight evidence,
 * not an insert plan, authorization, server audit DTO or transfer receipt. */
export function validateStandaloneTransferSource(json, timing) {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > STANDALONE_TRANSFER_MAX_BYTES) {
    throw new Error('Standalone transfer source exceeds 10 MB');
  }
  const source = JSON.parse(json);
  fields(source, ROOT);
  const version = source.transferVersion ?? 1;
  if (![1, 2, 3].includes(version)) throw new Error('Unsupported standalone transfer version');
  if (source.localAudit?.some(event => event?.kind === 'linked-origin') && version < 3) throw new Error('Linked history requires standalone transfer version 3');
  const transitions = source.localAudit?.some(event => event?.kind === 'ledger-currency' || event?.kind === 'linked-origin' || event?.conversionReview);
  if (transitions && version < 2) throw new Error('Currency history requires standalone transfer version 2');
  if (!/^local-[A-Za-z0-9_-]{1,58}$/.test(source.budgetId) || typeof source.name !== 'string'
    || !source.name.trim() || source.name.length > 100) throw new Error('Invalid standalone transfer identity or name');
  fields(source.request, REQUEST);
  fields(source.request.settings, SETTINGS);
  for (const [key, value] of Object.entries(source.request.settings)) {
    if (!['manual_fx_rates', 'fx_used_currencies'].includes(key) && value !== null
      && !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('Invalid standalone transfer setting');
  }
  const serverSettings = validateAndNormalizeSettings(source.request.settings, { allowedKeys: new Set(SETTINGS), allowedKeysOnly: true });
  fields(source.request.tables, [...TABLES, 'pending_transactions', 'future_transactions', 'projection_snapshots', ...(version >= 2 ? ['ledger_currency_events'] : [])]);
  for (const table of TABLES) {
    if (!Array.isArray(source.request.tables[table])) throw new Error('Complete standalone transfer planning required');
    for (const item of source.request.tables[table]) row(item, POSTGRES_BUDGET_COLUMNS[table], source.budgetId);
  }
  for (const table of ['pending_transactions', 'future_transactions', 'projection_snapshots']) {
    if (!Array.isArray(source.request.tables[table]) || ((table !== 'pending_transactions' || version < 2) && source.request.tables[table].length)) {
      throw new Error('Generated workflow rows cannot be transferred as financial authority');
    }
  }
  if (version >= 2) {
    for (const item of source.request.tables.ledger_currency_events || []) row(item, POSTGRES_BUDGET_COLUMNS.ledger_currency_events, source.budgetId);
    for (const item of source.request.tables.pending_transactions) row(item, FACT, source.budgetId);
  }
  if (source.localHistory !== undefined && !Array.isArray(source.localHistory)) throw new Error('Complete standalone transfer history required');
  for (const item of source.localHistory || []) row(item, FACT, source.budgetId);
  if (!Array.isArray(source.request.predictionRows) || source.request.predictionRows.length !== (source.localHistory || []).length
    || !Array.isArray(source.request.confirmedRowsAfterToday) || source.request.confirmedRowsAfterToday.length) {
    throw new Error('Complete matching standalone transfer history required');
  }
  const audit = source.localAudit || [];
  if (!Array.isArray(audit)) throw new Error('Complete standalone transfer audit required');
  // Local replay examines prior facts when checking each event. Bound work
  // before replay, including legacy upgrade, rather than just bounding bytes.
  const payments = source.snapshotVersion === 2 ? audit.filter(event => event?.kind === 'payment').length : (source.localHistory || []).length;
  const events = source.snapshotVersion === 2 ? audit.length : payments;
  if (Math.max(1, payments) * events > MAX_FACT_EVALUATIONS) throw new Error('Standalone transfer audit exceeds replay work limit');
  for (const event of audit) {
    if (version >= 2 && event?.kind === 'linked-origin') continue; // Shared replay validates the versioned proof.
    if (version >= 2 && event?.kind === 'ledger-currency') {
      row(event.event, POSTGRES_BUDGET_COLUMNS.ledger_currency_events, source.budgetId);
      row(event.pending, FACT, source.budgetId);
      continue; // Exact event structure and conversion money are checked by replay.
    }
    if (event?.kind === 'payment') row(event.row, FACT, source.budgetId);
    else if (event?.kind === 'correction') {
      if (event.before !== null) row(event.before, FACT, source.budgetId);
      if (event.after !== null) row(event.after, FACT, source.budgetId);
    } else throw new Error('Unsupported standalone transfer audit event');
    evidence(event.source, source.budgetId);
  }
  const snapshot = refreshLocalSnapshot({ snapshot: source, today: timing.today,
    generationTimestamp: timing.generationTimestamp, idSeed: timing.idSeed });
  if (version >= 2) snapshot.transferVersion = version;
  // Refresh has already replayed and verified every event and rebuilt these
  // rows. Reuse that result rather than doubling the bounded replay work.
  const confirmedBalance = snapshot.request.openingBalance;
  return { snapshot, serverSettings, sourceBudgetId: snapshot.budgetId, sourceRevision: snapshot.revision,
    originalOpeningBalance: snapshot.localOpeningBalance, confirmedBalance,
    originalPayments: snapshot.localAudit.filter(event => event.kind === 'payment'), effectivePayments: snapshot.localHistory,
    // Retained original count includes voided installment identities. Paid
    // totals and funding still come exclusively from effective accepted facts.
    oneOffProgress: snapshot.request.oneOffProgress, confirmedFunding: snapshot.request.confirmedFunding };
}
