export const FX_PROVIDER_DISABLED = "disabled";
export const FX_PROVIDER_MANUAL = "manual";
export const FX_PROVIDER_NBP = "nbp";
export const FX_PROVIDER_FRANKFURTER = "frankfurter";

export const FX_PROVIDER_IDS = [
  FX_PROVIDER_DISABLED,
  FX_PROVIDER_MANUAL,
  FX_PROVIDER_NBP,
  FX_PROVIDER_FRANKFURTER
];

export const SUPPORTED_FX_CURRENCIES = [
  "AUD",
  "BGN",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "HUF",
  "IDR",
  "ILS",
  "INR",
  "ISK",
  "JPY",
  "KRW",
  "MXN",
  "MYR",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "RON",
  "SEK",
  "SGD",
  "THB",
  "TRY",
  "USD",
  "ZAR"
];

export function normalizeFxProvider(value) {
  const provider = String(value || FX_PROVIDER_NBP).trim().toLowerCase();
  return FX_PROVIDER_IDS.includes(provider) ? provider : FX_PROVIDER_NBP;
}

export function parseJsonSetting(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

export function normalizeFxCurrencyList(value, ledgerCurrency = "PLN") {
  const parsed = Array.isArray(value)
    ? value
    : parseJsonSetting(value, typeof value === "string" ? value.split(",") : []);

  const supported = new Set(SUPPORTED_FX_CURRENCIES);
  const normalizedLedgerCurrency = normalizeSupportedCurrency(ledgerCurrency);
  const normalized = (Array.isArray(parsed) ? parsed : [])
    .map(currency => String(currency || "").trim().toUpperCase())
    .filter(currency => currency && currency !== normalizedLedgerCurrency && supported.has(currency));

  return [...new Set(normalized)].sort();
}

export function normalizeSupportedCurrency(value, fallback = "PLN") {
  const normalized = String(value || fallback).trim().toUpperCase();
  return SUPPORTED_FX_CURRENCIES.includes(normalized) ? normalized : fallback;
}

export function normalizeManualFxRates(value) {
  const parsed = parseJsonSetting(value, {});
  const rates = {};
  const supported = new Set(SUPPORTED_FX_CURRENCIES);

  for (const [currency, rate] of Object.entries(parsed || {})) {
    const normalizedCurrency = String(currency || "").trim().toUpperCase();
    const normalizedRate = Number(rate);

    if (
      normalizedCurrency &&
      normalizedCurrency !== "PLN" &&
      supported.has(normalizedCurrency) &&
      Number.isFinite(normalizedRate) &&
      normalizedRate > 0
    ) {
      rates[normalizedCurrency] = normalizedRate;
    }
  }

  return rates;
}

export function normalizeManualFxPairs(value, ledgerCurrency = "PLN") {
  const parsed = parseJsonSetting(value, {});
  const supported = new Set(SUPPORTED_FX_CURRENCIES);
  const quote = normalizeSupportedCurrency(ledgerCurrency);
  const pairs = {};

  for (const [key, rate] of Object.entries(parsed || {})) {
    const normalizedRate = Number(rate);
    const [rawBase, rawQuote] = String(key || "").includes("/")
      ? String(key).split("/")
      : [key, quote];
    const base = String(rawBase || "").trim().toUpperCase();
    const pairQuote = String(rawQuote || quote).trim().toUpperCase();

    if (
      base &&
      pairQuote &&
      base !== pairQuote &&
      supported.has(base) &&
      supported.has(pairQuote) &&
      Number.isFinite(normalizedRate) &&
      normalizedRate > 0
    ) {
      pairs[`${base}/${pairQuote}`] = normalizedRate;
    }
  }

  return pairs;
}
