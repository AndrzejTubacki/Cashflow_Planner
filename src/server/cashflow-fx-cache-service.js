import { DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { requireIsoDate, todayInTimezone } from "./cashflow-date-utils.js";
import { fetchWithTimeout, fxFetchTimeoutMs } from "./cashflow-fetch-utils.js";

import {
  FX_PROVIDER_DISABLED,
  FX_PROVIDER_FRANKFURTER,
  FX_PROVIDER_MANUAL,
  FX_PROVIDER_NBP,
  normalizeFxCurrencyList,
  normalizeFxProvider,
  normalizeManualFxPairs,
  normalizeManualFxRates,
  normalizeSupportedCurrency,
  requireSupportedCurrency
} from "./cashflow-fx-provider-utils.js";
import { badRequest } from "./cashflow-user-utils.js";

export function createCashflowFxCacheService({
  getCurrentFxSnapshot,
  listCashflowUserIds,
  logCashflowError,
  logError,
  logServerEvent,
  normalizeCurrency,
  openPlanningDb,
  regenerateProjectionsAfterMutation,
  fetchImpl = fetch
}) {
  let currentFxSnapshotDisabled = false;

  function fxCacheDateKey(date = null, timezone = DEFAULT_TIMEZONE) {
    return String(date || todayInTimezone(timezone)).slice(0, 10);
  }

  function getFxSettings(userId) {
    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare(`
        SELECT ledger_currency, timezone, fx_provider, fx_used_currencies, manual_fx_rates
        FROM settings
        WHERE id = 1
      `).get() || {};
      const ledgerCurrency = normalizeSupportedCurrency(settings.ledger_currency || "PLN");

      return {
        ledgerCurrency,
        timezone: settings.timezone || DEFAULT_TIMEZONE,
        provider: normalizeFxProvider(settings.fx_provider),
        usedCurrencies: normalizeFxCurrencyList(settings.fx_used_currencies, ledgerCurrency),
        manualRates: normalizeManualFxRates(settings.manual_fx_rates),
        manualPairs: normalizeManualFxPairs(settings.manual_fx_rates, ledgerCurrency)
      };
    } finally {
      db.close();
    }
  }

  function upsertFxCacheRate(userId, rateInfo, requestedDate = null) {
    const db = openPlanningDb(userId);

    try {
      const currency = normalizeCurrency(rateInfo.currency || rateInfo.baseCurrency);
      const quoteCurrency = normalizeCurrency(rateInfo.quoteCurrency || "PLN");
      const { timezone } = getFxSettings(userId);
      const rateDate = fxCacheDateKey(requestedDate || rateInfo.effectiveDate, timezone);

      db.prepare(`
        INSERT INTO fx_rates_cache (
          base_currency, quote_currency, currency, rate_date, rate, effective_date, source, raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(base_currency, quote_currency, rate_date) DO UPDATE SET
          currency = excluded.currency,
          rate = excluded.rate,
          effective_date = excluded.effective_date,
          source = excluded.source,
          raw_json = excluded.raw_json,
          updated_at = datetime('now')
      `).run(
        currency,
        quoteCurrency,
        currency,
        rateDate,
        Number(rateInfo.rate),
        rateInfo.effectiveDate || rateDate,
        rateInfo.source || "nbp",
        JSON.stringify(rateInfo)
      );
    } finally {
      db.close();
    }
  }

  function safeGetCurrentFxSnapshot(userId = null) {
    if (userId) {
      const { provider } = getFxSettings(userId);

      if (provider === FX_PROVIDER_DISABLED || provider === FX_PROVIDER_MANUAL) {
        return null;
      }
    }

    if (currentFxSnapshotDisabled || typeof getCurrentFxSnapshot !== "function") {
      return null;
    }

    try {
      const snapshot = getCurrentFxSnapshot();

      if (snapshot && typeof snapshot === "object") {
        return snapshot;
      }

      return null;
    } catch (error) {
      currentFxSnapshotDisabled = true;

      logCashflowError("cashflow_current_fx_snapshot_disabled", error, {
        userId,
        reason: "Host getCurrentFxSnapshot threw. Cashflow will use local FX cache until restart."
      });

      return null;
    }
  }

  function getCachedFxRate(userId, currency, date = null, quoteCurrency = null) {
    const normalized = normalizeCurrency(currency);
    const { provider, manualRates, manualPairs, ledgerCurrency, timezone } = getFxSettings(userId);
    const quote = normalizeCurrency(quoteCurrency || ledgerCurrency || "PLN");
    if (normalized === quote) return 1;


    if (provider === FX_PROVIDER_DISABLED) {
      return null;
    }

    if (provider === FX_PROVIDER_MANUAL) {
      const pairRate = Number(manualPairs[`${normalized}/${quote}`]);
      if (Number.isFinite(pairRate) && pairRate > 0) return pairRate;
      const inversePairRate = Number(manualPairs[`${quote}/${normalized}`]);
      if (Number.isFinite(inversePairRate) && inversePairRate > 0) return 1 / inversePairRate;
      const baseToPln = normalized === "PLN"
        ? 1
        : Number(manualPairs[`${normalized}/PLN`] || manualRates[normalized]);
      const quoteToPln = quote === "PLN"
        ? 1
        : Number(manualPairs[`${quote}/PLN`] || manualRates[quote]);
      if (
        Number.isFinite(baseToPln) &&
        baseToPln > 0 &&
        Number.isFinite(quoteToPln) &&
        quoteToPln > 0
      ) {
        return baseToPln / quoteToPln;
      }
      if (quote !== "PLN") return null;
      return Number(manualRates[normalized]) || null;
    }

    const db = openPlanningDb(userId);

    try {
      const rateDate = fxCacheDateKey(date, timezone);

      const exact = db.prepare(`
        SELECT rate
        FROM fx_rates_cache
        WHERE base_currency = ?
          AND quote_currency = ?
          AND rate_date = ?
        LIMIT 1
      `).get(normalized, quote, rateDate);

      if (exact?.rate) return Number(exact.rate);

      const latestBefore = db.prepare(`
        SELECT rate
        FROM fx_rates_cache
        WHERE base_currency = ?
          AND quote_currency = ?
          AND rate_date <= ?
        ORDER BY rate_date DESC
        LIMIT 1
      `).get(normalized, quote, rateDate);

      if (latestBefore?.rate) return Number(latestBefore.rate);

      if (quote !== "PLN") {
        const baseToPln = normalized === "PLN" ? 1 : getCachedFxRate(userId, normalized, date, "PLN");
        const quoteToPln = quote === "PLN" ? 1 : getCachedFxRate(userId, quote, date, "PLN");

        if (
          Number.isFinite(baseToPln) &&
          baseToPln > 0 &&
          Number.isFinite(quoteToPln) &&
          quoteToPln > 0
        ) {
          return baseToPln / quoteToPln;
        }
      }

      return null;
    } finally {
      db.close();
    }
  }

  function getCachedFxSnapshot(userId, date = null) {
    const { provider, manualRates, manualPairs, ledgerCurrency, timezone } = getFxSettings(userId);
    const rateDate = fxCacheDateKey(date, timezone);
    const snapshot = {
      pln: {
        currency: "PLN",
        rate: 1,
        effectiveDate: rateDate,
        source: provider === FX_PROVIDER_DISABLED ? "disabled" : "static"
      },
      [`${ledgerCurrency.toLowerCase()}/${ledgerCurrency.toLowerCase()}`]: {
        currency: ledgerCurrency,
        baseCurrency: ledgerCurrency,
        quoteCurrency: ledgerCurrency,
        rate: 1,
        effectiveDate: rateDate,
        source: "same-currency"
      }
    };

    if (provider === FX_PROVIDER_DISABLED) {
      return snapshot;
    }

    if (provider === FX_PROVIDER_MANUAL) {
      for (const [currency, rate] of Object.entries(manualRates)) {
        snapshot[currency.toLowerCase()] = {
          currency,
          rate,
          effectiveDate: rateDate,
          source: "manual"
        };
      }

      for (const [pair, rate] of Object.entries(manualPairs)) {
        const [base, quote] = pair.split("/");
        snapshot[`${base.toLowerCase()}/${quote.toLowerCase()}`] = {
          currency: base,
          baseCurrency: base,
          quoteCurrency: quote,
          rate,
          effectiveDate: date || todayInTimezone(timezone),
          source: "manual"
        };
      }

      return snapshot;
    }

    const db = openPlanningDb(userId);

    try {
      const rows = db.prepare(`
        SELECT base_currency, quote_currency, currency, rate, effective_date, source
        FROM fx_rates_cache
        WHERE rate_date <= ?
        ORDER BY base_currency ASC, quote_currency ASC, rate_date DESC
      `).all(rateDate);

      const seen = new Set();

      for (const row of rows) {
        const currency = normalizeCurrency(row.base_currency || row.currency);
        const quote = normalizeCurrency(row.quote_currency || "PLN");
        const pair = `${currency}/${quote}`;
        if (seen.has(pair)) continue;

        seen.add(pair);
        const entry = {
          currency,
          baseCurrency: currency,
          quoteCurrency: quote,
          rate: Number(row.rate),
          effectiveDate: row.effective_date || rateDate,
          source: row.source || "cache"
        };
        snapshot[`${currency.toLowerCase()}/${quote.toLowerCase()}`] = entry;
        if (quote === "PLN") {
          snapshot[currency.toLowerCase()] = entry;
        }
      }

      return snapshot;
    } finally {
      db.close();
    }
  }

  async function refreshNbpFxCacheForUser(userId, date = null) {
    const { provider, manualRates, manualPairs, ledgerCurrency, timezone } = getFxSettings(userId);

    if (provider === FX_PROVIDER_DISABLED) {
      return {
        provider,
        updated_count: 0,
        updated: []
      };
    }

    if (provider === FX_PROVIDER_MANUAL) {
      const manualEntries = Object.keys(manualPairs).length
        ? Object.entries(manualPairs)
        : Object.entries(manualRates).map(([currency, rate]) => [`${currency}/PLN`, rate]);
      const updated = manualEntries.map(([pair, rate]) => {
        const [currency, quoteCurrency] = pair.split("/");
        const rateInfo = {
          currency,
          baseCurrency: currency,
          quoteCurrency,
          rate,
          effectiveDate: date || todayInTimezone(timezone),
          requestedDate: date || todayInTimezone(timezone),
          source: FX_PROVIDER_MANUAL
        };

        upsertFxCacheRate(userId, rateInfo, date);
        return rateInfo;
      });

      return {
        provider,
        updated_count: updated.length,
        updated
      };
    }

    const currencies = collectCurrenciesForFxSnapshot(userId)
      .map(normalizeCurrency)
      .filter(currency => currency && currency !== ledgerCurrency);

    const uniqueCurrencies = [...new Set(currencies)];

    const updated = [];

    for (const currency of uniqueCurrencies) {
      const rateInfo = await fetchProviderRate(provider, currency, date, ledgerCurrency, timezone);
      upsertFxCacheRate(userId, rateInfo, date);
      updated.push(rateInfo);
    }

    return {
      provider,
      updated_count: updated.length,
      updated
    };
  }

  async function refreshNbpFxCacheForAllUsers(date = null) {
    const userIds = listCashflowUserIds();
    const results = [];

    for (const userId of userIds) {
      try {
        const result = await refreshNbpFxCacheForUser(userId, date);
        const projection = regenerateProjectionsAfterMutation(userId);

        logServerEvent("cashflow_fx_cache_refreshed", {
          userId,
          updated_count: result.updated_count,
          projection_ok: projection.projection_ok,
          projection_error: projection.projection_error
        });

        results.push({
          userId,
          ok: true,
          ...result,
          _projection: projection
        });
      } catch (error) {
        logError("cashflow_fx_cache_refresh_user_failed", {
          userId,
          error: error.message
        });

        results.push({
          userId,
          ok: false,
          error: error.message
        });
      }
    }

    return results;
  }

  async function fetchNbpRate(currency, date = null, timezone = DEFAULT_TIMEZONE) {
    const normalizedCurrency = requireSupportedCurrency(currency || "PLN");
    const requestedDate = date ? requireIsoDate(date) : null;
    const code = normalizedCurrency.toLowerCase();

    if (!code || code === "pln") {
      return {
        currency: "PLN",
        rate: 1,
        effectiveDate: requestedDate || todayInTimezone(timezone),
        requestedDate: requestedDate || todayInTimezone(timezone),
        source: "nbp"
      };
    }

    async function fetchExact(targetDate = null) {
      const url = targetDate
        ? `https://api.nbp.pl/api/exchangerates/rates/a/${encodeURIComponent(code)}/${encodeURIComponent(targetDate)}/?format=json`
        : `https://api.nbp.pl/api/exchangerates/rates/a/${encodeURIComponent(code)}/?format=json`;

      const response = await fetchWithTimeout(url, {
        headers: {
          "Accept": "application/json"
        }
      }, fxFetchTimeoutMs(), fetchImpl);

      if (!response.ok) {
        const error = new Error(`NBP FX request failed for ${normalizedCurrency}${targetDate ? ` on ${targetDate}` : ""}: ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }

      const data = await response.json();
      const rate = Number(data?.rates?.[0]?.mid);

      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`NBP FX response missing valid mid rate for ${normalizedCurrency}${targetDate ? ` on ${targetDate}` : ""}`);
      }

      return {
        currency: String(data.code || normalizedCurrency).toUpperCase(),
        rate,
        effectiveDate: data.rates[0].effectiveDate,
        requestedDate: targetDate || data.rates[0].effectiveDate,
        table: data.table,
        no: data.rates[0].no,
        source: "nbp"
      };
    }

    if (!requestedDate) {
      return fetchExact(null);
    }

    let cursor = new Date(`${requestedDate}T00:00:00Z`);

    for (let attempts = 0; attempts < 10; attempts += 1) {
      const targetDate = cursor.toISOString().slice(0, 10);

      try {
        return await fetchExact(targetDate);
      } catch (error) {
        if (![400, 404].includes(Number(error.status))) {
          throw error;
        }

        cursor.setUTCDate(cursor.getUTCDate() - 1);
      }
    }

    throw new Error(`Could not find NBP FX rate for ${normalizedCurrency} on or before ${requestedDate}`);
  }

  async function fetchNbpPairRate(baseCurrency, quoteCurrency = "PLN", date = null, timezone = DEFAULT_TIMEZONE) {
    const base = requireSupportedCurrency(baseCurrency || "PLN", "base");
    const quote = requireSupportedCurrency(quoteCurrency || "PLN", "quote");
    const requestedDate = date ? requireIsoDate(date) : null;

    if (base === quote) {
      return {
        currency: base,
        baseCurrency: base,
        quoteCurrency: quote,
        rate: 1,
        effectiveDate: requestedDate || todayInTimezone(timezone),
        requestedDate: requestedDate || todayInTimezone(timezone),
        source: "same-currency"
      };
    }

    const baseToPln = await fetchNbpRate(base, requestedDate, timezone);
    if (quote === "PLN") {
      return {
        ...baseToPln,
        baseCurrency: base,
        quoteCurrency: quote
      };
    }

    const quoteToPln = await fetchNbpRate(quote, requestedDate, timezone);

    return {
      currency: base,
      baseCurrency: base,
      quoteCurrency: quote,
      rate: Number(baseToPln.rate) / Number(quoteToPln.rate),
      effectiveDate: baseToPln.effectiveDate || quoteToPln.effectiveDate,
      requestedDate: requestedDate || baseToPln.requestedDate || quoteToPln.requestedDate,
      source: "nbp-derived",
      legs: {
        baseToPln,
        quoteToPln
      }
    };
  }

  async function fetchFrankfurterRate(currency, date = null, quoteCurrency = "PLN", timezone = DEFAULT_TIMEZONE) {
    const code = requireSupportedCurrency(currency || quoteCurrency || "PLN", "base");
    const quote = requireSupportedCurrency(quoteCurrency || "PLN", "quote");
    const requestedDate = date ? requireIsoDate(date) : null;

    if (!code || code === quote) {
      return {
        currency: quote,
        baseCurrency: quote,
        quoteCurrency: quote,
        rate: 1,
        effectiveDate: requestedDate || todayInTimezone(timezone),
        requestedDate: requestedDate || todayInTimezone(timezone),
        source: FX_PROVIDER_FRANKFURTER
      };
    }

    const datePart = requestedDate ? encodeURIComponent(requestedDate) : "latest";
    const url = `https://api.frankfurter.app/${datePart}?from=${encodeURIComponent(code)}&to=${encodeURIComponent(quote)}`;
    const response = await fetchWithTimeout(url, {
      headers: {
        "Accept": "application/json"
      }
    }, fxFetchTimeoutMs(), fetchImpl);

    if (!response.ok) {
      const error = new Error(`Frankfurter FX request failed for ${code}${requestedDate ? ` on ${requestedDate}` : ""}: ${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    const rate = Number(data?.rates?.[quote]);

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Frankfurter FX response missing valid ${quote} rate for ${code}${requestedDate ? ` on ${requestedDate}` : ""}`);
    }

    return {
      currency: code,
      baseCurrency: code,
      quoteCurrency: quote,
      rate,
      effectiveDate: data.date || requestedDate || todayInTimezone(timezone),
      requestedDate: requestedDate || data.date || todayInTimezone(timezone),
      source: FX_PROVIDER_FRANKFURTER,
      raw: data
    };
  }

  async function fetchProviderRate(provider, currency, date = null, quoteCurrency = "PLN", timezone = DEFAULT_TIMEZONE) {
    const requestedDate = date ? requireIsoDate(date) : null;
    if (provider === FX_PROVIDER_FRANKFURTER) {
      return fetchFrankfurterRate(currency, requestedDate, quoteCurrency, timezone);
    }

    return fetchNbpPairRate(currency, quoteCurrency, requestedDate, timezone);
  }

  async function getProviderPairRate(userId, baseCurrency, quoteCurrency, date = null) {
    const base = requireSupportedCurrency(baseCurrency, "base");
    const quote = requireSupportedCurrency(quoteCurrency, "quote");
    const requestedDate = date ? requireIsoDate(date, "date") : null;
    const { provider, timezone } = getFxSettings(userId);
    const effectiveDate = requestedDate || todayInTimezone(timezone);

    if (base === quote) {
      return {
        currency: base,
        baseCurrency: base,
        quoteCurrency: quote,
        rate: 1,
        effectiveDate,
        requestedDate: effectiveDate,
        source: "same-currency"
      };
    }

    if (provider === FX_PROVIDER_DISABLED) {
      throw badRequest(`FX provider is disabled; no rate is available for ${base}/${quote}`);
    }

    if (provider === FX_PROVIDER_MANUAL) {
      const rate = Number(getCachedFxRate(userId, base, requestedDate, quote));
      if (!Number.isFinite(rate) || rate <= 0) {
        throw badRequest(`Missing manual FX rate for ${base}/${quote}`);
      }
      return {
        currency: base,
        baseCurrency: base,
        quoteCurrency: quote,
        rate,
        effectiveDate,
        requestedDate: effectiveDate,
        source: FX_PROVIDER_MANUAL
      };
    }

    return fetchProviderRate(provider, base, requestedDate, quote, timezone);
  }

  async function fetchNbpFxSnapshot(currencies, date = null, timezone = DEFAULT_TIMEZONE) {
    const requestedDate = date ? requireIsoDate(date) : null;
    const uniqueCurrencies = [...new Set((currencies || []).map(c => requireSupportedCurrency(c || "PLN")))];

    const snapshot = {};

    for (const currency of uniqueCurrencies) {
      if (!currency || currency === "PLN") {
        snapshot.pln = {
          currency: "PLN",
          rate: 1,
          effectiveDate: requestedDate || todayInTimezone(timezone),
          source: "nbp"
        };
        continue;
      }

      const rate = await fetchNbpRate(currency, requestedDate, timezone);
      snapshot[currency.toLowerCase()] = rate;
    }

    return snapshot;
  }

  function collectCurrenciesForFxSnapshot(userId) {
    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare(`
        SELECT ledger_currency, fx_used_currencies
        FROM settings
        WHERE id = 1
      `).get() || {};

      const rows = [
        ...db.prepare("SELECT currency FROM recurring_expenses").all(),
        ...db.prepare("SELECT currency FROM recurring_incomes").all(),
        ...db.prepare("SELECT currency FROM flex_transactions").all(),
        ...db.prepare("SELECT currency FROM goals").all(),
        ...db.prepare("SELECT currency FROM one_off_transactions").all(),
        ...db.prepare("SELECT currency FROM pending_transactions").all()
      ];

      const ledgerCurrency = normalizeSupportedCurrency(settings.ledger_currency || "PLN");
      const usedCurrencies = normalizeFxCurrencyList(settings.fx_used_currencies, ledgerCurrency);
      const observedCurrencies = rows
        .map(row => String(row.currency || "").toUpperCase())
        .filter(Boolean);

      return [...new Set([...usedCurrencies, ...observedCurrencies])];
    } finally {
      db.close();
    }
  }

  async function ensureFxCacheForMutation(userId, input = {}) {
    const currency = requireSupportedCurrency(input?.currency || "PLN");
    const { provider, manualRates, manualPairs, ledgerCurrency, timezone } = getFxSettings(userId);

    if (!currency || currency === ledgerCurrency) {
      return {
        refreshed: false,
        currency,
        quoteCurrency: ledgerCurrency
      };
    }

    if (provider === FX_PROVIDER_DISABLED) {
      return {
        refreshed: false,
        currency,
        provider,
        disabled: true
      };
    }

    if (provider === FX_PROVIDER_MANUAL) {
      return {
        refreshed: false,
        currency,
        quoteCurrency: ledgerCurrency,
        provider,
        manual_rate: Number(manualPairs[`${currency}/${ledgerCurrency}`] || manualRates[currency]) || null
      };
    }

    const cached = getCachedFxRate(userId, currency, null, ledgerCurrency);

    if (cached) {
      return {
        refreshed: false,
        currency,
        cached_rate: cached
      };
    }

    const rateInfo = await fetchProviderRate(provider, currency, null, ledgerCurrency, timezone);
    upsertFxCacheRate(userId, rateInfo);

    return {
      refreshed: true,
      currency,
      provider,
      rate: rateInfo.rate,
      effectiveDate: rateInfo.effectiveDate
    };
  }
  return {
    collectCurrenciesForFxSnapshot,
    ensureFxCacheForMutation,
    fetchProviderRate,
    fetchNbpFxSnapshot,
    fetchNbpPairRate,
    fetchNbpRate,
    getCachedFxRate,
    getCachedFxSnapshot,
    getFxProviderSettings: getFxSettings,
    getProviderPairRate,
    refreshNbpFxCacheForAllUsers,
    refreshNbpFxCacheForUser,
    safeGetCurrentFxSnapshot,
    upsertFxCacheRate
  };
}

