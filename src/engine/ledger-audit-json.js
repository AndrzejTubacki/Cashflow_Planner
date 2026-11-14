import { badRequest } from './cashflow-user-utils.js';

/** Canonical JSON refuses values that JSON would silently drop or rewrite. */
export function canonicalAuditValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))
      || Object.getOwnPropertySymbols(value).length) throw badRequest('Unsupported ledger audit value');
    return value.map(canonicalAuditValue);
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype && !Object.getOwnPropertySymbols(value).length) return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalAuditValue(value[key])]));
  throw badRequest('Unsupported ledger audit value');
}
