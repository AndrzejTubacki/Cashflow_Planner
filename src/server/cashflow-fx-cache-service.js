import { todayWarsaw } from "./cashflow-date-utils.js";

import {
  FX_PROVIDER_DISABLED,
  FX_PROVIDER_FRANKFURTER,
  FX_PROVIDER_MANUAL,
  FX_PROVIDER_NBP,
  normalizeFxCurrencyList,
  normalizeFxProvider,
  normalizeManualFxRates
} from "./cashflow-fx-provider-utils.js";

export function createCashflowFxCacheService({
  getCurrentFxSnapshot,
  listCashflowUserIds,
  logCashflowError,
  logError,
  logServerEvent,
  normalizeCurrency,
  openPlanningDb,
  regenerateProjectionsAfterMutation
}) {
  let currentFxSnapshotDisabled = false;

  function fxCacheDateKey(date = null) {
    return String(date || todayWarsaw()).slice(0, 10);
  }

  function getFxSettings(userId) {
    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare(`
        SELECT fx_provider, fx_used_currencies, manual_fx_rates
        FROM settings
        WHERE id = 1
      `).get() || {};

      return {
        provider: normalizeFxProvider(settings.fx_provider),
        usedCurrencies: normalizeFxCurrencyList(settings.fx_used_currencies),
        manualRates: normalizeManualFxRates(settings.manual_fx_rates)
      };
    } finally {
      db.close();
    }
  }

  function upsertFxCacheRate(userId, rateInfo, requestedDate = null) {
    const db = openPlanningDb(userId);

    try {
      const currency = normalizeCurrency(rateInfo.currency);
      const rateDate = fxCacheDateKey(requestedDate || rateInfo.effectiveDate || todayWarsaw());

      db.prepare(`
        INSERT INTO fx_rates_cache (
          currency, rate_date, rate, effective_date, source, raw_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(currency, rate_date) DO UPDATE SET
          rate = excluded.rate,
          effective_date = excluded.effective_date,
          source = excluded.source,
          raw_json = excluded.raw_json,
          updated_at = datetime('now')
      `).run(
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

  function getCachedFxRate(userId, currency, date = null) {
    const normalized = normalizeCurrency(currency);
    if (normalized === "PLN") return 1;

    const { provider, manualRates } = getFxSettings(userId);

    if (provider === FX_PROVIDER_DISABLED) {
      return null;
    }

    if (provider === FX_PROVIDER_MANUAL) {
      return Number(manualRates[normalized]) || null;
    }

    const db = openPlanningDb(userId);

    try {
      const rateDate = fxCacheDateKey(date);

      const exact = db.prepare(`
        SELECT rate
        FROM fx_rates_cache
        WHERE currency = ?
          AND rate_date = ?
        LIMIT 1
      `).get(normalized, rateDate);

      if (exact?.rate) return Number(exact.rate);

      const latestBefore = db.prepare(`
        SELECT rate
        FROM fx_rates_cache
        WHERE currency = ?
          AND rate_date <= ?
        ORDER BY rate_date DESC
        LIMIT 1
      `).get(normalized, rateDate);

      if (latestBefore?.rate) return Number(latestBefore.rate);

      return null;
    } finally {
      db.close();
    }
  }

  function getCachedFxSnapshot(userId, date = null) {
    const { provider, manualRates } = getFxSettings(userId);
    const rateDate = fxCacheDateKey(date);
    const snapshot = {
      pln: {
        currency: "PLN",
        rate: 1,
        effectiveDate: rateDate,
        source: provider === FX_PROVIDER_DISABLED ? "disabled" : "static"
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

      return snapshot;
    }

    const db = openPlanningDb(userId);

    try {
      const rows = db.prepare(`
        SELECT currency, rate, effective_date, source
        FROM fx_rates_cache
        WHERE rate_date <= ?
        ORDER BY currency ASC, rate_date DESC
      `).all(rateDate);

      const seen = new Set();

      for (const row of rows) {
        const currency = normalizeCurrency(row.currency);
        if (seen.has(currency)) continue;

        seen.add(currency);
        snapshot[currency.toLowerCase()] = {
          currency,
          rate: Number(row.rate),
          effectiveDate: row.effective_date || rateDate,
          source: row.source || "cache"
        };
      }

      return snapshot;
    } finally {
      db.close();
    }
  }

  async function refreshNbpFxCacheForUser(userId, date = null) {
    const { provider, manualRates } = getFxSettings(userId);

    if (provider === FX_PROVIDER_DISABLED) {
      return {
        provider,
        updated_count: 0,
        updated: []
      };
    }

    if (provider === FX_PROVIDER_MANUAL) {
      const updated = Object.entries(manualRates).map(([currency, rate]) => {
        const rateInfo = {
          currency,
          rate,
          effectiveDate: date || todayWarsaw(),
          requestedDate: date || todayWarsaw(),
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
      .filter(currency => currency && currency !== "PLN");

    const uniqueCurrencies = [...new Set(currencies)];

    const updated = [];

    for (const currency of uniqueCurrencies) {
      const rateInfo = await fetchProviderRate(provider, currency, date);
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

  async function fetchNbpRate(currency, date = null) {
    const code = String(currency || "").trim().toLowerCase();

    if (!code || code === "pln") {
      return {
        currency: "PLN",
        rate: 1,
        effectiveDate: date || todayWarsaw(),
        requestedDate: date || todayWarsaw(),
        source: "nbp"
      };
    }

    async function fetchExact(targetDate = null) {
      const url = targetDate
        ? `https://api.nbp.pl/api/exchangerates/rates/a/${encodeURIComponent(code)}/${encodeURIComponent(targetDate)}/?format=json`
        : `https://api.nbp.pl/api/exchangerates/rates/a/${encodeURIComponent(code)}/?format=json`;

      const response = await fetch(url, {
        headers: {
          "Accept": "application/json"
        }
      });

      if (!response.ok) {
        const error = new Error(`NBP FX request failed for ${currency}${targetDate ? ` on ${targetDate}` : ""}: ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }

      const data = await response.json();
      const rate = Number(data?.rates?.[0]?.mid);

      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`NBP FX response missing valid mid rate for ${currency}${targetDate ? ` on ${targetDate}` : ""}`);
      }

      return {
        currency: String(data.code || currency).toUpperCase(),
        rate,
        effectiveDate: data.rates[0].effectiveDate,
        requestedDate: targetDate || data.rates[0].effectiveDate,
        table: data.table,
        no: data.rates[0].no,
        source: "nbp"
      };
    }

    if (!date) {
      return fetchExact(null);
    }

    let cursor = new Date(`${date}T00:00:00Z`);

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

    throw new Error(`Could not find NBP FX rate for ${currency} on or before ${date}`);
  }

  async function fetchFrankfurterRate(currency, date = null) {
    const code = String(currency || "").trim().toUpperCase();

    if (!code || code === "PLN") {
      return {
        currency: "PLN",
        rate: 1,
        effectiveDate: date || todayWarsaw(),
        requestedDate: date || todayWarsaw(),
        source: FX_PROVIDER_FRANKFURTER
      };
    }

    const datePart = date ? encodeURIComponent(date) : "latest";
    const url = `https://api.frankfurter.app/${datePart}?from=${encodeURIComponent(code)}&to=PLN`;
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      const error = new Error(`Frankfurter FX request failed for ${code}${date ? ` on ${date}` : ""}: ${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    const rate = Number(data?.rates?.PLN);

    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`Frankfurter FX response missing valid PLN rate for ${code}${date ? ` on ${date}` : ""}`);
    }

    return {
      currency: code,
      rate,
      effectiveDate: data.date || date || todayWarsaw(),
      requestedDate: date || data.date || todayWarsaw(),
      source: FX_PROVIDER_FRANKFURTER,
      raw: data
    };
  }

  async function fetchProviderRate(provider, currency, date = null) {
    if (provider === FX_PROVIDER_FRANKFURTER) {
      return fetchFrankfurterRate(currency, date);
    }

    return fetchNbpRate(currency, date);
  }

  async function fetchNbpFxSnapshot(currencies, date = null) {
    const uniqueCurrencies = [...new Set((currencies || []).map(c => String(c || "").toUpperCase()))];

    const snapshot = {};

    for (const currency of uniqueCurrencies) {
      if (!currency || currency === "PLN") {
        snapshot.pln = {
          currency: "PLN",
          rate: 1,
          effectiveDate: date || todayWarsaw(),
          source: "nbp"
        };
        continue;
      }

      const rate = await fetchNbpRate(currency, date);
      snapshot[currency.toLowerCase()] = rate;
    }

    return snapshot;
  }

  function collectCurrenciesForFxSnapshot(userId) {
    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare(`
        SELECT fx_used_currencies
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

      const usedCurrencies = normalizeFxCurrencyList(settings.fx_used_currencies);
      const observedCurrencies = rows
        .map(row => String(row.currency || "").toUpperCase())
        .filter(Boolean);

      return [...new Set([...usedCurrencies, ...observedCurrencies])];
    } finally {
      db.close();
    }
  }

  async function ensureFxCacheForMutation(userId, input = {}) {
    const currency = normalizeCurrency(input?.currency);

    if (!currency || currency === "PLN") {
      return {
        refreshed: false,
        currency: "PLN"
      };
    }

    const { provider, manualRates } = getFxSettings(userId);

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
        provider,
        manual_rate: Number(manualRates[currency]) || null
      };
    }

    const cached = getCachedFxRate(userId, currency);

    if (cached) {
      return {
        refreshed: false,
        currency,
        cached_rate: cached
      };
    }

    const rateInfo = await fetchProviderRate(provider, currency);
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
    fetchNbpRate,
    getCachedFxRate,
    getCachedFxSnapshot,
    getFxProviderSettings: getFxSettings,
    refreshNbpFxCacheForAllUsers,
    refreshNbpFxCacheForUser,
    safeGetCurrentFxSnapshot,
    upsertFxCacheRate
  };
}

