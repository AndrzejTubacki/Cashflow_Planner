import { orderedLinkedTimeline, currencyOrderFromReceipts } from "./linked-currency-order.js";
import { materializationCheck } from './materialization-rejection.js';
import { canonicalAuditValue } from './ledger-audit-json.js';
import { createLedgerAuditReplay } from './ledger-audit-replay.js';
import { auditUtf8ByteLength } from './ledger-audit-host.js';
import { auditSha256 } from './audit-sha256.js';
import { ledgerConversionBalances, ledgerConversionRecords } from './ledger-currency-change.js';

/** Re-scope materialized facts only. The immutable linked proof retains its
 * original namespace, actors, hashes and decisions through subsequent copies. */
export function localLinkedOrigin(event, budgetId) {
  if (![1, 2].includes(event.version) || Object.keys(event).sort().join(',') !== 'audit,currencyEvents,id,kind,ledgerCurrency,pending,version'
    || !Array.isArray(event.pending) || !Array.isArray(event.currencyEvents)) throw new Error('Unsupported linked origin');
  let count = 0;
  const inspect = (value, depth) => {
    if (depth > 64 || ++count > 2000000) throw new Error('Linked proof exceeds replay work limit');
    if (value && typeof value === 'object') for (const child of Object.values(value)) inspect(child, depth + 1);
  };
  inspect(event, 0);
  const codec = createLedgerAuditReplay({ digestText: auditSha256, utf8ByteLength: auditUtf8ByteLength, allowStandaloneOrigins: true });
  const replay = codec.replayLedgerAuditSnapshot(event.audit, event.audit.budgetId);
  const scope = row => row == null ? null : { ...row, ...(Object.hasOwn(row, 'budget_id') ? { budget_id: budgetId } : {}) };
  const row = value => ({ ...scope(value), status: 'confirmed' });
  const originals = new Map([...replay.originals].map(([id, original]) => [id, { kind: 'payment', id, row: row(original.row),
    source: original.sourceAtAcceptance == null ? null : { ...original.sourceAtAcceptance,
      row: scope(original.sourceAtAcceptance.row), plan: scope(original.sourceAtAcceptance.plan ?? null) } }]));
  const currencyEvents = event.currencyEvents.map(value => { const clean = scope(value); delete clean.orderResolution; return clean; });
  const conversions = new Map();
  for (const change of currencyEvents) {
    try {
    const originEvents = event.audit.origin?.events || [];
    const captured = originEvents.find(value => value.kind === 'ledger-currency' && value.id === change.id);
    const financial = value => {
      const result = { ...value }; delete result.budget_id; delete result.orderResolution;
      // JSONB returns parsed details while SQLite/retained origins keep JSON
      // text. Compare the same JSON value without rewriting immutable proof.
      if (typeof result.details === 'string') {
        try { result.details = JSON.parse(result.details); }
        catch (_) { throw new Error('Invalid captured currency event details'); }
      }
      if (typeof result.created_at === 'string') result.created_at = new Date(result.created_at.includes('T') ? result.created_at : result.created_at.replace(' ', 'T') + 'Z').toISOString();
      return JSON.stringify(canonicalAuditValue(result));
    };
    if (captured && financial(captured.event) !== financial(change)) throw new Error('Altered captured currency event');
    const details = typeof change.details === 'string' ? JSON.parse(change.details) : change.details;
    const order = event.version === 2 ? details?.acceptanceOrder || currencyOrderFromReceipts(change, event.currencyEvents, event.audit,
      event.currencyEvents.find(value => value.id === change.id)?.orderResolution) : null;
    const amounts = ledgerConversionBalances(change.old_balance, change.fx_rate);
    if (amounts.convertedOpeningBalance !== change.converted_opening_balance) throw new Error('Altered conversion amount');
    const utc = text => Date.parse(typeof text === 'string' && /^\d{4}-\d{2}-\d{2} /.test(text) ? text.replace(' ', 'T') + 'Z' : text);
    const candidates = [...(captured ? [captured.pending] : []), ...event.pending].filter(value =>
      String(value.occurrence_key).startsWith('ledger_currency_conversion:') && value.ledger_currency === change.new_currency
      && utc(value.created_at) === utc(change.created_at));
    const ids = captured ? [captured.pending.occurrence_key] : order ? [`ledger_currency_conversion:${order.conversionId}`] : [...new Set(candidates.map(value => value.occurrence_key))];
    // Older server events did not retain the generated conversion ID. Keep
    // those complete historical facts without guessing a relationship from
    // later confirmation timestamps, amounts or names.
    if (ids.length !== 1) continue;
    const pendingId = ids[0].slice('ledger_currency_conversion:'.length);
    const generated = ledgerConversionRecords({ oldCurrency: change.old_currency, newCurrency: change.new_currency,
      oldBalance: change.old_balance, convertedOpeningBalance: change.converted_opening_balance, rate: change.fx_rate,
      rateDate: change.rate_date, source: change.source }, { eventId: change.id, pendingId, timestamp: change.created_at });
    conversions.set(ids[0], { kind: 'ledger-currency', id: change.id, event: change, pending: generated.pending });
    for (const original of originals.values()) if (original.row.occurrence_key === ids[0]) {
      original.source = { table: 'ledger_currency_events', row: change, plan: null };
      original.row.note = generated.pending.note;
    }
    } catch (error) {
      materializationCheck('VERIFY_CURRENCY_EVENT', 'ledger_currency_events', () => { throw error; });
    }
  }
  return { replay, originals, rows: replay.rows.map(row), currencyEvents, conversions,
    pending: event.pending.map(scope), opening: replay.opening || { ledgerCurrency: currencyEvents[0]?.old_currency, amount: 0 } };
}

/** Combine captured origins with durable native switch boundaries. Legacy
 * receipts participate only in an explicitly requested correction review. */
export function linkedOriginTimeline(event, resolve = false) {
  const origin = event.audit.origin;
  const flatten = events => events.flatMap(value => value.kind === 'linked-origin' ? linkedOriginTimeline(value, resolve) || [] : [value]);
  const prefix = origin ? flatten(origin.events) : [];
  // Version 1 keeps its historical replay rules, including recorded blocked
  // reviews. New version-2 KEEP origins opt into native acceptance boundaries.
  if (event.version === 1 && !resolve) {
    if (!origin) return null;
    const payments = new Set(prefix.filter(value => value.kind === 'payment').map(value => value.id));
    const currencies = new Set(prefix.filter(value => value.kind === 'ledger-currency').map(value => value.id));
    if (event.audit.originals.some(value => !payments.has(value.row.id))
      || event.currencyEvents.some(value => !currencies.has(value.id))) return null;
    return prefix;
  }
  const seed = localLinkedOrigin({ ...event, version: 2 }, event.audit.budgetId);
  const timeline = orderedLinkedTimeline(event, prefix, seed.originals, resolve);
  if (!timeline) return null;
  return timeline.map(value => value.kind === 'ledger-currency'
    ? { ...value, pending: seed.conversions.get(value.pending.occurrence_key)?.pending || value.pending } : value);
}

/** Opening currency is explicit even through repeated upload/KEEP cycles. */
export function linkedOriginOpeningCurrency(event, fallback) {
  const origin = event.audit.origin;
  if (origin?.events[0]?.kind === 'linked-origin') return linkedOriginOpeningCurrency(origin.events[0], origin.ledgerCurrency);
  return origin?.events.find(value => value.kind === 'ledger-currency')?.event.old_currency
    || origin?.ledgerCurrency || event.currencyEvents[0]?.old_currency || fallback;
}

/** Display counts include inherited originals, including voided payments. The
 * caller first validates replay; this helper does not authorize financial facts. */
export function retainedLocalPaymentCount(events) {
  return events.reduce((count, event) => count + (event.kind === 'payment' ? 1 : event.kind === 'linked-origin'
    ? event.audit.originals.length + retainedLocalPaymentCount(event.audit.origin?.events || []) : 0), 0);
}
