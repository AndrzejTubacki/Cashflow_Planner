import { canonicalAuditValue } from './ledger-audit-json.js';
import { requireIsoDate } from './cashflow-date-utils.js';
import { requireSupportedCurrency } from './cashflow-fx-provider-utils.js';
import { confirmedRowsWithRunningBalances } from './cashflow-ledger-balance-utils.js';
import { multiplyMoney } from './cashflow-money-utils.js';
import { badRequest, conflict } from './cashflow-user-utils.js';

const SOURCES = ['source_one_off_id', 'source_recurring_income_id', 'source_recurring_expense_id', 'source_goal_id', 'source_flex_id'];
const copy = canonicalAuditValue;

/** Monetary facts use safe integer cents; running balances may include zero. */
function money(value, signed = false) {
  return typeof value === 'number' && Number.isFinite(value) && (signed || value > 0)
    && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001;
}

/** Audit facts come from the normalized writer, which emits canonical UTC
 * millisecond instants. Reject rollover dates and ambiguous/local timestamps
 * before they can influence financial ordering or become portable authority. */
function requireRecordedTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw badRequest('Recorded payment timestamp must be a normalized UTC instant');
  }
}

/** Keep original accepted metadata; running balances are rebuilt, not evidence.
 * Accepted system/history facts may be zero; new replacement amounts stay positive. */
function fact(row, budgetId) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id
    || !['income', 'expense'].includes(row.type) || !money(row.amount, true) || row.amount < 0
    || (row.budget_id !== undefined && row.budget_id !== budgetId)) throw badRequest('Invalid recorded payment facts');
  requireIsoDate(row.date); requireIsoDate(row.confirmed_date);
  if (!Number.isInteger(row.ledger_year) || row.ledger_year < 1 || row.ledger_year > 9999
    || row.ledger_year !== Number(row.confirmed_date.slice(0, 4))) {
    throw badRequest('Recorded payment ledger year differs from its actual date');
  }
  requireRecordedTimestamp(row.created_at); requireRecordedTimestamp(row.updated_at);

  if (requireSupportedCurrency(row.currency) !== row.currency || requireSupportedCurrency(row.ledger_currency) !== row.ledger_currency) {
    throw badRequest('Recorded payment currencies must be normalized');
  }
  const foreign = row.currency !== row.ledger_currency;
  if (foreign && row.fx_rate == null) throw badRequest('Recorded foreign payment has no exchange rate');
  if (SOURCES.some(key => row[key] != null && (typeof row[key] !== 'string' || !row[key]))
    || SOURCES.filter(key => row[key] != null).length > 1) throw badRequest('Ambiguous recorded payment source');
  const rate = row.fx_rate ?? 1;
  const buffered = row.buffered_fx_rate ?? rate;
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(buffered) || buffered <= 0
    || (row.currency === row.ledger_currency && (rate !== 1 || buffered !== 1))) throw badRequest('Invalid recorded payment exchange rate');
  const amount = multiplyMoney(row.amount, buffered);
  if (!money(amount, true) || amount < 0 || (row.ledger_amount != null && row.ledger_amount !== amount)) throw badRequest('Recorded payment amount differs from its exchange rate');
  const value = copy(row);
  delete value.running_balance_pln;
  return value;
}

/** Validate a normalized database fact before retaining immutable audit evidence.
 * This is not user-input normalization; recorded dates/rates must already be exact. */
export function validateLedgerCorrectionFact(row, budgetId) {
  if (typeof budgetId !== 'string' || !budgetId) throw badRequest('Recorded payment scope required');
  return fact(row, budgetId);
}

/** Pure reviewed-correction preparation. The caller must supply complete scoped
 * effective history, the immutable original and its accepted correction head,
 * then atomically append audit evidence and apply accepted changes under the
 * budget lock. This function does not authorize, persist or reproject anything.
 *
 * Currency-conversion opening entries remain independently accepted ledger facts,
 * matching the existing server model. Only the target's ledger currency is
 * rebalanced. Captured source evidence, never prospectively edited planning,
 * supplies the historical deadline for version-1 replay only. Version 2
 * allows actual payment dates after deadlines; allocation schedules stay separate.
 * An origin-aware caller may supply the target currency's verified signed
 * opening offset. It must come from replayed immutable evidence, never a client
 * aggregate. Ordinary ledgers retain their zero offset. No current FX provider/rate is consulted. */
export function planLedgerCorrection({ budgetId, rows, original, currentCorrectionId, expectedCorrectionId,
  replacement, reason, today, createdAt, sourceAtAcceptance = null, policyVersion = 2, openingBalance = 0 }) {
  if (![1, 2].includes(policyVersion)) throw badRequest('Unsupported correction policy version');
  if (!money(openingBalance, true)) throw badRequest('Verified opening offset must use safe monetary precision');
  if (typeof budgetId !== 'string' || !budgetId || !Array.isArray(rows) || rows.length > 200000) throw badRequest('Complete bounded ledger history required');
  requireIsoDate(today);
  if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(createdAt)
    || !Number.isFinite(Date.parse(createdAt))) throw badRequest('Invalid correction timestamp');
  requireIsoDate(createdAt.slice(0, 10));
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw badRequest('Correction reason required (up to 500 characters)');
  if (currentCorrectionId !== null && (typeof currentCorrectionId !== 'string' || !currentCorrectionId)) throw badRequest('Invalid correction head');
  if (expectedCorrectionId !== currentCorrectionId) throw conflict('Recorded payment changed; review its current history');
  const acceptedOriginal = fact(original, budgetId);
  const effective = rows.map(row => fact(row, budgetId));
  const ids = new Set();
  for (const row of effective) {
    if (ids.has(row.id)) throw badRequest('Duplicate recorded payment identity');
    ids.add(row.id);
  }
  const before = effective.find(row => row.id === original.id) ?? null;
  if (!before && currentCorrectionId === null) throw badRequest('Recorded payment no longer exists');
  if (sourceAtAcceptance !== null) {
    const fields = { one_off_transactions: 'source_one_off_id', recurring_incomes: 'source_recurring_income_id',
      recurring_expenses: 'source_recurring_expense_id', goals: 'source_goal_id', flex_transactions: 'source_flex_id' };
    const field = fields[sourceAtAcceptance.table];
    if (!field || !original[field] || sourceAtAcceptance.row?.id !== original[field]) throw badRequest('Captured correction source differs from its payment');
  }
  if (before && ['type', 'currency', 'ledger_currency', 'occurrence_key', 'created_at', ...SOURCES]
    .some(key => (before[key] ?? null) !== (acceptedOriginal[key] ?? null))) throw badRequest('Recorded payment identity differs from its original');
  let proposed = null;
  if (replacement !== null) {
    if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)
      || Object.keys(replacement).sort().join(',') !== (Object.hasOwn(replacement, 'fx_rate') ? 'amount,date,fx_rate' : 'amount,date')) throw badRequest('Unsupported correction fields');
    requireIsoDate(replacement.date);
    if (replacement.date > today || !money(replacement.amount) || replacement.amount > 9999999999.99) throw badRequest('Invalid correction amount or date');
    const foreign = original.currency !== original.ledger_currency;
    if (!foreign && Object.hasOwn(replacement, 'fx_rate')) throw badRequest('Same-currency corrections have no exchange rate');
    const explicitRate = Object.hasOwn(replacement, 'fx_rate');
    if (explicitRate && (!Number.isFinite(replacement.fx_rate) || replacement.fx_rate <= 0 || replacement.fx_rate > 1000000)) throw badRequest('Invalid correction exchange rate');
    const rate = explicitRate ? replacement.fx_rate : acceptedOriginal.fx_rate ?? 1;
    const buffered = explicitRate ? replacement.fx_rate : acceptedOriginal.buffered_fx_rate ?? rate;
    const ledgerAmount = multiplyMoney(replacement.amount, buffered);
    if (!money(ledgerAmount, true) || ledgerAmount < 0) throw badRequest('Correction amount exceeds safe monetary precision');
    proposed = { ...acceptedOriginal, amount: replacement.amount, date: replacement.date,
      // Server year partitions follow the actual payment date. Review time is
      // recorded by the new audit event rather than redefining confirmed_date.
      confirmed_date: replacement.date, ledger_year: Number(replacement.date.slice(0, 4)),
      fx_rate: rate, buffered_fx_rate: buffered, ledger_amount: ledgerAmount, updated_at: new Date(createdAt).toISOString() };
  }
  const candidate = effective.filter(row => row.id !== original.id && row.ledger_currency === original.ledger_currency);
  if (proposed) candidate.push(proposed);
  let failureCode = null;
  let blockingIds = [];
  const balances = confirmedRowsWithRunningBalances(candidate, { openingBalance });
  const unsafe = balances.filter(row => !money(row.running_balance_pln, true));
  const negative = balances.filter(row => row.running_balance_pln < -0.005);
  if (unsafe.length) { failureCode = 'unsafe_balance'; blockingIds = unsafe.map(row => row.id); }
  else if (negative.length) { failureCode = 'history_overdraft'; blockingIds = negative.map(row => row.id); }
  const occurrences = new Set();
  for (const row of candidate) {
    if (!row.occurrence_key) continue;
    if (occurrences.has(row.occurrence_key) && !failureCode) { failureCode = 'duplicate_occurrence'; blockingIds = [row.id]; }
    occurrences.add(row.occurrence_key);
  }
  if (sourceAtAcceptance?.table === 'goals') {
    if (sourceAtAcceptance.row?.id !== original.source_goal_id) throw badRequest('Captured correction source differs from its payment');
    requireIsoDate(sourceAtAcceptance.row.due_date);
    if (policyVersion === 1 && proposed && proposed.date > sourceAtAcceptance.row.due_date && !failureCode) { failureCode = 'source_date'; blockingIds = [original.id]; }
  }
  return { before, after: failureCode ? null : proposed, requested: copy(replacement), reason,
    status: failureCode ? 'blocked' : 'accepted', failureCode, blockingIds,
    balances: failureCode ? [] : balances };
}
