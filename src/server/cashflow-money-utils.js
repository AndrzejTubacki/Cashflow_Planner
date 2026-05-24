export function normalizeCurrency(currency) {
  return String(currency || "PLN").trim().toUpperCase() || "PLN";
}

export function getFxRateForCurrency(currency, settings, fxSnapshot) {
  if (settings?.ledger_currency && settings.ledger_currency !== "PLN") {
    throw new Error("Only PLN ledger currency is supported");
  }

  const normalized = normalizeCurrency(currency);
  if (normalized === "PLN") return 1;

  const key = normalized.toLowerCase();
  const rate = Number(fxSnapshot?.[key]?.rate);

  if (Number.isFinite(rate) && rate > 0) {
    return rate;
  }

  throw new Error(`Missing FX rate for ${normalized}/PLN. Refresh FX cache first.`);
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
  const fx = getFxRateForCurrency(normalized, settings, fxSnapshot);

  if (normalized === "PLN") {
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

  return n;
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
    ledgerAmount: Number(amount || 0) * rates.buffered
  };
}
