export function normalizeCurrency(currency) {
  return String(currency || "PLN").trim().toUpperCase() || "PLN";
}

export const MONEY_DECIMAL_PLACES = 2;
export const MONEY_SCALE = 10 ** MONEY_DECIMAL_PLACES;
export const MONEY_EPSILON = 1 / MONEY_SCALE / 2;
const MONEY_ROUNDING_EPSILON = 1e-8;

export function roundMoneyAmount(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return number;

  const rounded = Math.sign(number) * Math.round((Math.abs(number) * MONEY_SCALE) + MONEY_ROUNDING_EPSILON) / MONEY_SCALE;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function addMoneyAmounts(...values) {
  return roundMoneyAmount(values.reduce((sum, value) => sum + Number(value || 0), 0));
}

export function subtractMoneyAmounts(value, ...subtractValues) {
  return roundMoneyAmount(Number(value || 0) - subtractValues.reduce((sum, item) => sum + Number(item || 0), 0));
}

export function multiplyMoney(value, multiplier) {
  return roundMoneyAmount(Number(value || 0) * Number(multiplier || 0));
}

function pairKey(base, quote) {
  return `${normalizeCurrency(base).toLowerCase()}/${normalizeCurrency(quote).toLowerCase()}`;
}

function snapshotRate(snapshot, base, quote) {
  const normalizedBase = normalizeCurrency(base);
  const normalizedQuote = normalizeCurrency(quote);
  const direct = snapshot?.[pairKey(normalizedBase, normalizedQuote)];

  if (direct?.rate) {
    return direct;
  }

  if (normalizedQuote === "PLN") {
    const legacy = snapshot?.[normalizedBase.toLowerCase()];
    if (legacy?.rate) return legacy;
  }

  return null;
}

export function getFxRateInfoForPair(baseCurrency, quoteCurrency, fxSnapshot) {
  const base = normalizeCurrency(baseCurrency);
  const quote = normalizeCurrency(quoteCurrency);

  if (base === quote) {
    return {
      baseCurrency: base,
      quoteCurrency: quote,
      rate: 1,
      source: "same-currency",
      effectiveDate: null
    };
  }

  const direct = snapshotRate(fxSnapshot, base, quote);
  const directRate = Number(direct?.rate);

  if (Number.isFinite(directRate) && directRate > 0) {
    return {
      baseCurrency: base,
      quoteCurrency: quote,
      rate: directRate,
      source: direct.source || "cache",
      effectiveDate: direct.effectiveDate || null,
      details: direct
    };
  }

  const basePln = snapshotRate(fxSnapshot, base, "PLN");
  const quotePln = snapshotRate(fxSnapshot, quote, "PLN");
  const basePlnRate = Number(basePln?.rate);
  const quotePlnRate = Number(quotePln?.rate);

  if (
    Number.isFinite(basePlnRate) &&
    basePlnRate > 0 &&
    Number.isFinite(quotePlnRate) &&
    quotePlnRate > 0
  ) {
    return {
      baseCurrency: base,
      quoteCurrency: quote,
      rate: basePlnRate / quotePlnRate,
      source: "derived",
      effectiveDate: basePln?.effectiveDate || quotePln?.effectiveDate || null,
      details: {
        baseToPln: basePln,
        quoteToPln: quotePln
      }
    };
  }

  throw new Error(`Missing FX rate for ${base}/${quote}. Refresh FX cache first.`);
}

export function getFxRateForPair(baseCurrency, quoteCurrency, fxSnapshot) {
  return getFxRateInfoForPair(baseCurrency, quoteCurrency, fxSnapshot).rate;
}

export function getFxRateForCurrency(currency, settings, fxSnapshot) {
  return getFxRateForPair(currency, settings?.ledger_currency || "PLN", fxSnapshot);
}

export function applyFxBuffer(rate, settings, type) {
  const buffer = (Number(settings?.fx_buffer_percent) || 0) / 100;

  if (type === "income") {
    return rate * (1 - buffer);
  }

  return rate * (1 + buffer);
}

export function getBufferedFxForCurrency(currency, settings, fxSnapshot, type) {
  const normalized = normalizeCurrency(currency);
  const ledgerCurrency = normalizeCurrency(settings?.ledger_currency || "PLN");
  const fx = getFxRateForPair(normalized, ledgerCurrency, fxSnapshot);

  if (normalized === ledgerCurrency) {
    return {
      fx,
      buffered: 1
    };
  }

  return {
    fx,
    buffered: applyFxBuffer(fx, settings, type)
  };
}

export function nullablePositiveAmount(value) {
  if (value === "" || value === null || value === undefined) {
    return null;
  }

  const n = Number(value);

  if (!Number.isFinite(n) || n < 0) {
    return null;
  }

  return roundMoneyAmount(n);
}

export function toLedgerAmount(amount, currency, settings, fxSnapshot, type) {
  const rates = getBufferedFxForCurrency(
    currency,
    settings,
    fxSnapshot,
    type === "income" ? "income" : "expense"
  );

  return {
    rawRate: rates.fx,
    effectiveRate: rates.buffered,
    ledgerAmount: multiplyMoney(amount, rates.buffered)
  };
}
