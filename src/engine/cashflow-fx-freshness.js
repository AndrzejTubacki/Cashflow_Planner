import { getFxRateInfoForPair } from "./cashflow-money-utils.js";

/** Provider observations expire after 14 days; user-entered manual rates do not.
 * Cache readers use the capture date, while portable observations use their
 * effective date. Never replace an old observation's date with today's date. */
export function fxRateAgeDays(requestedDate, rateDate, source) {
  if (source === "manual") return 0;
  return (Date.parse(`${String(requestedDate).slice(0, 10)}T00:00:00Z`)
    - Date.parse(`${String(rateDate).slice(0, 10)}T00:00:00Z`)) / 86400000;
}

/** Read/planning paths tolerate stale rates; money-recording paths must call
 * this before using a cached observation. Explicit actual/manual rates and
 * same-currency payments do not consume an expiring provider observation. */
export function assertFxRateFresh(requestedDate, rateDate, base, quote, source) {
  if (base === quote) return;
  const ageDays = fxRateAgeDays(requestedDate, rateDate, source);
  if (ageDays <= 14 || !Number.isFinite(ageDays)) return;
  const pair = `${base}/${quote}`;
  const error = new Error(`The ${pair} exchange rate is ${ageDays} days old. Refresh exchange rates before confirming this transaction or recording a currency conversion.`);
  error.status = 409;
  error.details = { code: "stale_fx_rate", pair, rateDate, ageDays };
  throw error;
}

/** Validate only the observation(s) actually selected, including both PLN
 * legs of a derived rate; unrelated stale pairs must never block a payment. */
export function assertSnapshotFxRateFresh(snapshot, requestedDate, base, quote) {
  const info = getFxRateInfoForPair(base, quote, snapshot);
  if (info.source === "same-currency") return;
  const check = (entry, from, to) => assertFxRateFresh(requestedDate,
    entry.rateDate || entry.effectiveDate, from, to, entry.source);
  if (info.source === "derived") {
    check(info.details.baseToPln, base, "PLN");
    check(info.details.quoteToPln, quote, "PLN");
  } else {
    check(info.details, base, quote);
  }
}
