import { validateStandaloneTransferSource } from './cashflow-standalone-transfer-source.js';
import { refreshLocalSnapshot } from '../engine/local-confirmation.js';
import { requireSupportedCurrency } from './cashflow-fx-provider-utils.js';
import { canonicalAuditValue } from '../engine/ledger-audit-json.js';

const json = value => JSON.stringify(canonicalAuditValue(value));
const DAY = 86400000;

/** Review-stage provider refresh, before any reservation or publication lock.
 * Only planning observations are replaced. Payment FX and complete local audit
 * remain byte-equivalent, and manual observations retain their dates/metadata.
 * The host injects the existing allowlisted HTTPS provider implementation; its
 * callback receives currency codes/provider only, never a budget or credential.
 * A failed refresh returns no partial replacement and leaves the source intact.
 * The caller must review/freeze the returned source before submitting a job. */
export async function prepareStandaloneTransferRates({ sourceJson, fetchRate, ...timing }) {
  if (typeof fetchRate !== 'function') throw new Error('Standalone transfer provider reader required');
  const source = validateStandaloneTransferSource(sourceJson, timing).snapshot;
  const snapshot = structuredClone(source);
  const pairs = new Map();
  for (const [key, entry] of Object.entries(snapshot.request.fxSnapshot || {})) {
    if (!/^[a-z]{3}(\/[a-z]{3})?$/.test(key) || !entry || Array.isArray(entry)
      || typeof entry !== 'object' || !Number.isFinite(entry.rate) || entry.rate <= 0) throw new Error('Invalid standalone planning exchange rate');
    const [baseCurrency, quoteCurrency = 'PLN'] = key.toUpperCase().split('/');
    requireSupportedCurrency(baseCurrency); requireSupportedCurrency(quoteCurrency);
    if (baseCurrency === quoteCurrency) {
      if (entry.rate !== 1) throw new Error('Invalid same-currency exchange rate');
      continue;
    }
    const provider = entry.source;
    if (!['manual', 'nbp', 'frankfurter'].includes(provider)) throw new Error('Review the source of the planning exchange rate before uploading');
    const pair = `${baseCurrency}/${quoteCurrency}`;
    const previous = pairs.get(pair);
    if (previous && (previous.provider !== provider || json(previous.entry) !== json(entry))) {
      throw new Error('Conflicting standalone planning exchange-rate aliases');
    }
    if (previous) previous.keys.push(key);
    else pairs.set(pair, { provider, baseCurrency, quoteCurrency, entry, keys: [key] });
  }
  const refreshed = [];
  for (const pair of pairs.values()) {
    if (pair.provider === 'manual') continue;
    // Refresh provider observations even if the saved observation is recent.
    // The only request metadata given to the provider seam is this fixed tuple.
    const request = { provider: pair.provider, baseCurrency: pair.baseCurrency, quoteCurrency: pair.quoteCurrency };
    let observation;
    try { observation = await fetchRate(Object.freeze(request)); }
    catch {
      // Provider errors may contain response bodies or transport details. The
      // owning HTTP/UI host can log this fixed code without forwarding them.
      throw Object.assign(new Error('Could not refresh a planning exchange rate; upload has not started'),
        { code: 'TRANSFER_RATE_REFRESH_FAILED' });
    }
    const date = observation?.effectiveDate;
    const timestamp = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
    const age = (Date.parse(`${timing.today}T00:00:00.000Z`) - timestamp) / DAY;
    if (!observation || typeof observation.rate !== 'number' || !Number.isFinite(observation.rate) || observation.rate <= 0
      || !Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date || age < 0 || age > 14
      || observation.source !== pair.provider
      || (observation.baseCurrency !== undefined && observation.baseCurrency !== pair.baseCurrency)
      || (observation.currency !== undefined && observation.currency !== pair.baseCurrency)
      || (observation.quoteCurrency !== undefined && observation.quoteCurrency !== pair.quoteCurrency)) {
      throw new Error('Provider returned an unusable planning exchange rate; upload has not started');
    }
    const after = { ...pair.entry, rate: observation.rate, effectiveDate: date, source: pair.provider,
      fetchedAt: timing.generationTimestamp };
    for (const key of pair.keys) snapshot.request.fxSnapshot[key] = structuredClone(after);
    refreshed.push({ ...request, before: structuredClone(pair.entry), after: structuredClone(after) });
  }
  const reviewed = refreshLocalSnapshot({ snapshot, ...timing });
  if (source.transferVersion >= 2) reviewed.transferVersion = source.transferVersion;
  if (json(reviewed.localAudit) !== json(source.localAudit) || json(reviewed.localHistory) !== json(source.localHistory)
    || reviewed.localOpeningBalance !== source.localOpeningBalance || reviewed.revision !== source.revision) {
    throw new Error('Planning exchange-rate refresh changed confirmed evidence');
  }
  return { sourceJson: JSON.stringify(reviewed), refreshed,
    sourceBudgetId: source.budgetId, sourceRevision: source.revision };
}
