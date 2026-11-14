import { requireIsoDate } from './cashflow-date-utils.js';

/** Refuse omitted/unknown fields at the shared reviewed-intent boundary. */
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error(`Invalid ${label} fields`);
}
/** Financial intent amounts use finite bounded cent precision. */
function money(value) {
  if (!Number.isFinite(value) || value < 0 || value > 9999999999.99 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) {
    throw new Error('Invalid correction amount');
  }
  return Math.round(value * 100) / 100;
}

/** Correction intents name the history the user actually reviewed. Actor,
 * review time, original evidence and financial outcomes belong to the host. */
export function normalizeLedgerCorrectionPayload(payload) {
  exact(payload, ['targetId', 'expectedCorrectionId', 'replacement', 'reason', 'retryOf'], 'correction payload');
  const identity = value => {
    if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error('Invalid correction history identity');
    }
    return value;
  };
  const targetId = identity(payload.targetId);
  const expectedCorrectionId = payload.expectedCorrectionId === null ? null : identity(payload.expectedCorrectionId);
  const retryOf = payload.retryOf === null ? null : identity(payload.retryOf);
  if (typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.length > 500) throw new Error('Invalid correction reason');
  let replacement = null;
  if (payload.replacement !== null) {
    const value = payload.replacement;
    const hasRate = value && Object.hasOwn(value, 'fx_rate');
    exact(value, ['amount', 'date', ...(hasRate ? ['fx_rate'] : [])], 'correction replacement');
    const amount = money(value.amount);
    if (amount <= 0) throw new Error('Invalid correction amount');
    requireIsoDate(value.date);
    if (hasRate && (!Number.isFinite(value.fx_rate) || value.fx_rate <= 0 || value.fx_rate > 1000000)) throw new Error('Invalid correction exchange rate');
    replacement = { amount, date: value.date, ...(hasRate ? { fx_rate: value.fx_rate } : {}) };
  }
  return { targetId, expectedCorrectionId, replacement, reason: payload.reason, retryOf };
}

