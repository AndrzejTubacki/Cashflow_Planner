import { assertFxRateFresh } from "./cashflow-fx-freshness.js";
import { refreshLocalSnapshot } from './local-confirmation.js';
import { rebuildLocalAuditMutation } from './local-audited-snapshot.js';
import { normalizeManualFxPairs, requireSupportedCurrency } from './cashflow-fx-provider-utils.js';
import { ledgerConversionBalances, ledgerConversionRecords } from './ledger-currency-change.js';

/** Standalone settings intent. Rates are explicit phone data, never fetched.
 * cachedRates uses the fxSnapshot pair/entry shape and may contain both quotes;
 * manualRates uses the settings manual_fx_rates shape. All writes are returned
 * as one immutable snapshot for the host to persist atomically. */
export function changeLocalLedgerCurrency({ snapshot, newCurrency, manualRates, cachedRates = {}, today, generationTimestamp, idSeed }) {
  newCurrency = requireSupportedCurrency(newCurrency);
  snapshot = refreshLocalSnapshot({ snapshot, today, generationTimestamp, idSeed });
  const oldCurrency = snapshot.request.settings.ledger_currency;
  if (newCurrency === oldCurrency) return snapshot;
  if (snapshot.request.tables.pending_transactions.some(row => String(row.occurrence_key || '').startsWith('ledger_currency_conversion:'))) {
    throw new Error('Confirm or clear the pending ledger currency conversion before changing ledger currency again');
  }
  const pairs = normalizeManualFxPairs(manualRates ?? snapshot.request.settings.manual_fx_rates, newCurrency);
  const valid = value => Number.isFinite(Number(value)) && Number(value) > 0;
  const cache = { ...snapshot.request.fxSnapshot, ...cachedRates };
  const direct = `${oldCurrency}/${newCurrency}`, inverse = `${newCurrency}/${oldCurrency}`;
  let rate = null, source = 'cache';
  if (valid(pairs[direct])) { rate = Number(pairs[direct]); source = 'manual'; }
  else if (valid(pairs[inverse])) { rate = 1 / Number(pairs[inverse]); source = 'manual-inverse'; }
  else if (valid(cache[direct.toLowerCase()]?.rate)) rate = Number(cache[direct.toLowerCase()].rate);
  else if (valid(cache[inverse.toLowerCase()]?.rate)) { rate = 1 / Number(cache[inverse.toLowerCase()].rate); source = 'inverse-cache'; }
  const observation = cache[(source === 'inverse-cache' ? inverse : direct).toLowerCase()];
  if ((source === 'cache' && rate) || source === 'inverse-cache') {
    const pair = source === 'inverse-cache' ? inverse : direct;
    assertFxRateFresh(today, observation.effectiveDate, ...pair.split('/'), observation.source);
  }
  const oldBalance = snapshot.request.openingBalance;
  if (!valid(rate)) {
    if (Math.abs(oldBalance) < 0.0001) { rate = 1; source = 'zero-balance'; }
    else throw new Error(`Missing FX rate for ${direct}. Refresh FX cache first.`);
  }
  const change = { oldCurrency, newCurrency, ...ledgerConversionBalances(oldBalance, rate), rate, rateDate: today, source };
  const records = ledgerConversionRecords(change, { eventId: `ledger-currency-${idSeed}`,
    pendingId: `pending-ledger-currency-${idSeed}`, timestamp: generationTimestamp });
  // Keep only rates quoted in the new ledger currency. The chosen conversion
  // also supplies the old-currency planning rate; earlier payments stay intact.
  const fxSnapshot = Object.fromEntries(Object.entries(cache).filter(([key]) => key.endsWith(`/${newCurrency.toLowerCase()}`)
    && !key.startsWith(`${newCurrency.toLowerCase()}/`)));
  for (const [pair, value] of Object.entries(pairs)) {
    const [base, quote] = pair.split('/');
    if (quote === newCurrency && base !== quote) fxSnapshot[pair.toLowerCase()] = { rate: value, source: 'manual', effectiveDate: today };
    else if (base === newCurrency && quote !== base) fxSnapshot[`${quote}/${base}`.toLowerCase()] = { rate: 1 / value, source: 'manual', effectiveDate: today };
  }
  if (source !== 'zero-balance') fxSnapshot[direct.toLowerCase()] = { rate, source: source.startsWith('manual') ? 'manual'
    : observation.source, effectiveDate: source.startsWith('manual') ? today : observation.effectiveDate };
  const next = JSON.parse(JSON.stringify(snapshot));
  next.revision++;
  next.request.settings.ledger_currency = newCurrency;
  if (manualRates !== undefined) next.request.settings.manual_fx_rates = JSON.stringify(pairs);
  next.request.fxSnapshot = fxSnapshot;
  next.localAudit.push({ kind: 'ledger-currency', id: records.event.id, ...records });
  return rebuildLocalAuditMutation(next, { today, generationTimestamp, idSeed });
}

/** Native string bridge: failure contains no partially changed snapshot. */
export function changeLocalLedgerCurrencyJson(json) {
  try { return JSON.stringify({ ok: true, snapshot: changeLocalLedgerCurrency(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: 'LOCAL_LEDGER_CURRENCY_REJECTED', message: error.message } }); }
}
