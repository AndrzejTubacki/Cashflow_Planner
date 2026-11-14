import { assertFxRateFresh as assertCachedRateFresh } from "../engine/cashflow-fx-freshness.js";
import { recordSqliteFinancialChange } from "./cashflow-financial-journal.js";
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
  budgetStore = null,
  getCurrentFxSnapshot,
  listCashflowUserIds,
  listCashflowUserIdsAsync = null,
  logCashflowError,
  logError,
  logServerEvent,
  normalizeCurrency,
  openPlanningDb,
  regenerateProjectionsAfterMutation,
  regenerateProjectionsAfterMutationAsync = null,
  fetchImpl = fetch
}) {
  let currentFxSnapshotDisabledUntil = 0;

  function fxCacheDateKey(date = null, timezone = DEFAULT_TIMEZONE) {
    return String(date || todayInTimezone(timezone)).slice(0, 10);
  }

  function fxSettingsFromRow(settings = {}) {
    const ledgerCurrency = normalizeSupportedCurrency(settings.ledger_currency || "PLN");

    return {
      ledgerCurrency,
      timezone: settings.timezone || DEFAULT_TIMEZONE,
      provider: normalizeFxProvider(settings.fx_provider),
      usedCurrencies: normalizeFxCurrencyList(settings.fx_used_currencies, ledgerCurrency),
      manualRates: normalizeManualFxRates(settings.manual_fx_rates),
      manualPairs: normalizeManualFxPairs(settings.manual_fx_rates, ledgerCurrency)
    };
  }

  // Atomic SQLite mutations borrow provider policy from their own connection.
  function getFxSettings(userId, transactionDb = null) {
    const db = transactionDb || openPlanningDb(userId);

    try {
      const settings = db.prepare(`
        SELECT ledger_currency, timezone, fx_provider, fx_used_currencies, manual_fx_rates
        FROM settings
        WHERE id = 1
      `).get() || {};
      return fxSettingsFromRow(settings);
    } finally {
      if (!transactionDb) db.close();
    }
  }

  // Provider policy may be edited inside the same transaction as financial sources.
  async function getFxSettingsAsync(userId, store = budgetStore) {
    if (store && typeof store.listPlanningRows === "function") {
      const rows = await store.listPlanningRows(userId, "settings");
      return fxSettingsFromRow(rows.find(row => Number(row.id) === 1) || rows[0] || {});
    }

    return getFxSettings(userId);
  }

  function manualRateForPair({
    manualPairs = {},
    manualRates = {}
  } = {}, base, quote) {
    const pairRate = Number(manualPairs[`${base}/${quote}`]);
    if (Number.isFinite(pairRate) && pairRate > 0) return pairRate;

    const inversePairRate = Number(manualPairs[`${quote}/${base}`]);
    if (Number.isFinite(inversePairRate) && inversePairRate > 0) return 1 / inversePairRate;

    const baseToPln = base === "PLN"
      ? 1
      : Number(manualPairs[`${base}/PLN`] || manualRates[base]);
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
    return Number(manualRates[base]) || null;
  }

  function fxCacheRowFromRateInfo(rateInfo, requestedDate = null, timezone = DEFAULT_TIMEZONE) {
    const currency = normalizeCurrency(rateInfo.currency || rateInfo.baseCurrency);
    const quoteCurrency = normalizeCurrency(rateInfo.quoteCurrency || "PLN");
    const rateDate = fxCacheDateKey(requestedDate || rateInfo.effectiveDate, timezone);

    return {
      base_currency: currency,
      quote_currency: quoteCurrency,
      currency,
      rate_date: rateDate,
      rate: Number(rateInfo.rate),
      effective_date: rateInfo.effectiveDate || rateDate,
      source: rateInfo.source || "nbp",
      raw_json: JSON.stringify(rateInfo),
      updated_at: new Date().toISOString()
    };
  }

  function upsertFxCacheRate(userId, rateInfo, requestedDate = null) {
    const db = openPlanningDb(userId);

    try {
      const { timezone } = getFxSettings(userId, db);
      const row = fxCacheRowFromRateInfo(rateInfo, requestedDate, timezone);

      // FX can affect the next projection even if its later refresh fails.
      // Commit cache state and cursor invalidation together, never afterward.
      db.transaction(() => {
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
          row.base_currency,
          row.quote_currency,
          row.currency,
          row.rate_date,
          row.rate,
          row.effective_date,
          row.source,
          row.raw_json
        );
        recordSqliteFinancialChange(db, userId, "fx");
      }).immediate();
    } finally {
      db.close();
    }
  }

  async function upsertFxCacheRateAsync(userId, rateInfo, requestedDate = null, settingsOverride = null) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.upsertFxRates === "function") {
      const { timezone } = settingsOverride || await getFxSettingsAsync(userId);
      await budgetStore.transaction(async writer => {
        await writer.lockBudgetLedger(userId);
        await writer.upsertFxRates(userId, [fxCacheRowFromRateInfo(rateInfo, requestedDate, timezone)]);
        await writer.recordFinancialChange(userId, "fx");
      });
      return;
    }

    upsertFxCacheRate(userId, rateInfo, requestedDate);
  }

  function safeGetCurrentFxSnapshot(userId = null, transactionDb = null) {
    if (userId) {
      const { provider } = getFxSettings(userId, transactionDb);

      if (provider === FX_PROVIDER_DISABLED || provider === FX_PROVIDER_MANUAL) {
        return null;
      }
    }

    if (Date.now() < currentFxSnapshotDisabledUntil || typeof getCurrentFxSnapshot !== "function") {
      return null;
    }

    try {
      const snapshot = getCurrentFxSnapshot();

      if (snapshot && typeof snapshot === "object") {
        return snapshot;
      }

      return null;
    } catch (error) {
      currentFxSnapshotDisabledUntil = Date.now() + 5 * 60 * 1000;

      logCashflowError("cashflow_current_fx_snapshot_disabled", error, {
        userId,
        reason: "Host getCurrentFxSnapshot threw. Cashflow will use local FX cache until restart."
      });

      return null;
    }
  }

  // Read provider policy through the caller's transaction when composing a mutation.
  async function safeGetCurrentFxSnapshotAsync(userId = null, store = budgetStore) {
    if (userId) {
      const { provider } = await getFxSettingsAsync(userId, store);

      if (provider === FX_PROVIDER_DISABLED || provider === FX_PROVIDER_MANUAL) {
        return null;
      }
    }

    if (Date.now() < currentFxSnapshotDisabledUntil || typeof getCurrentFxSnapshot !== "function") {
      return null;
    }

    try {
      // Await host hooks here so asynchronous failures reach the same circuit breaker as sync throws.
      const snapshot = await getCurrentFxSnapshot();

      if (snapshot && typeof snapshot === "object") {
        return snapshot;
      }

      return null;
    } catch (error) {
      currentFxSnapshotDisabledUntil = Date.now() + 5 * 60 * 1000;

      logCashflowError("cashflow_current_fx_snapshot_disabled", error, {
        userId,
        reason: "Host getCurrentFxSnapshot threw. Cashflow will use local FX cache until restart."
      });

      return null;
    }
  }

  function getCachedFxRate(userId, currency, date = null, quoteCurrency = null, { allowStale = false } = {}) {
    const normalized = normalizeCurrency(currency);
    const { provider, manualRates, manualPairs, ledgerCurrency, timezone } = getFxSettings(userId);
    const quote = normalizeCurrency(quoteCurrency || ledgerCurrency || "PLN");
    if (normalized === quote) return 1;


    if (provider === FX_PROVIDER_DISABLED) {
      return null;
    }

    if (provider === FX_PROVIDER_MANUAL) {
      return manualRateForPair({ manualPairs, manualRates }, normalized, quote);
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
        SELECT rate, rate_date, source
        FROM fx_rates_cache
        WHERE base_currency = ?
          AND quote_currency = ?
          AND rate_date <= ?
        ORDER BY rate_date DESC
        LIMIT 1
      `).get(normalized, quote, rateDate);

      if (latestBefore?.rate) {
        if (!allowStale) assertCachedRateFresh(rateDate, latestBefore.rate_date, normalized, quote, latestBefore.source);
        return Number(latestBefore.rate);
      }

      if (quote !== "PLN") {
        const baseToPln = normalized === "PLN" ? 1 : getCachedFxRate(userId, normalized, date, "PLN", { allowStale });
        const quoteToPln = quote === "PLN" ? 1 : getCachedFxRate(userId, quote, date, "PLN", { allowStale });

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

  function getCachedFxSnapshot(userId, date = null, transactionDb = null) {
    const { provider, manualRates, manualPairs, ledgerCurrency, timezone } = getFxSettings(userId, transactionDb);
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

    const db = transactionDb || openPlanningDb(userId);

    try {
      const rows = db.prepare(`
        SELECT base_currency, quote_currency, currency, rate, rate_date, effective_date, source
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

        // Planning snapshots retain stale rates; financial single-rate readers refuse them.
        seen.add(pair);
        const entry = {
          currency,
          baseCurrency: currency,
          quoteCurrency: quote,
          rate: Number(row.rate),
          rateDate: row.rate_date,
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
      if (!transactionDb) db.close();
    }
  }

  function cachedFxRateFromRows(settings, rows, currency, date = null, quoteCurrency = null, { allowStale = false } = {}) {
    const normalized = normalizeCurrency(currency);
    const quote = normalizeCurrency(quoteCurrency || settings.ledgerCurrency || "PLN");
    if (normalized === quote) return 1;

    if (settings.provider === FX_PROVIDER_DISABLED) {
      return null;
    }

    if (settings.provider === FX_PROVIDER_MANUAL) {
      return manualRateForPair(settings, normalized, quote);
    }

    const rateDate = fxCacheDateKey(date, settings.timezone);
    const pairRows = rows
      .filter(row => String(row.base_currency || row.currency || "").toUpperCase() === normalized)
      .filter(row => String(row.quote_currency || "PLN").toUpperCase() === quote)
      .filter(row => String(row.rate_date || "").slice(0, 10) <= rateDate)
      .sort((a, b) => String(b.rate_date || "").localeCompare(String(a.rate_date || "")));

    if (pairRows.length > 0) {
      const bestRow = pairRows[0];
      if (!allowStale) assertCachedRateFresh(rateDate, bestRow.rate_date, normalized, quote, bestRow.source);
      const direct = Number(bestRow.rate);
      if (Number.isFinite(direct) && direct > 0) return direct;
    }

    if (quote !== "PLN") {
      const baseToPln = normalized === "PLN" ? 1 : cachedFxRateFromRows(settings, rows, normalized, date, "PLN", { allowStale });
      const quoteToPln = quote === "PLN" ? 1 : cachedFxRateFromRows(settings, rows, quote, date, "PLN", { allowStale });

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
  }

  async function getCachedFxRateAsync(userId, currency, date = null, quoteCurrency = null) {
    if (!(budgetStore?.backend === "postgres") || typeof budgetStore.listPlanningRows !== "function") {
      return getCachedFxRate(userId, currency, date, quoteCurrency);
    }

    const settings = await getFxSettingsAsync(userId);
    const rows = settings.provider === FX_PROVIDER_DISABLED || settings.provider === FX_PROVIDER_MANUAL
      ? []
      : await budgetStore.listPlanningRows(userId, "fx_rates_cache");
    return cachedFxRateFromRows(settings, rows, currency, date, quoteCurrency);
  }

  function buildCachedFxSnapshotFromRows({
    date = null,
    ledgerCurrency,
    manualPairs,
    manualRates,
    provider,
    rows = [],
    timezone
  }) {
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
      for (const [currency, rate] of Object.entries(manualRates || {})) {
        snapshot[currency.toLowerCase()] = {
          currency,
          rate,
          effectiveDate: rateDate,
          source: "manual"
        };
      }

      for (const [pair, rate] of Object.entries(manualPairs || {})) {
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

    const sortedRows = [...(rows || [])]
      .filter(row => String(row.rate_date || "") <= rateDate)
      .sort((a, b) => {
        const baseCompare = String(a.base_currency || a.currency || "").localeCompare(String(b.base_currency || b.currency || ""));
        if (baseCompare !== 0) return baseCompare;
        const quoteCompare = String(a.quote_currency || "PLN").localeCompare(String(b.quote_currency || "PLN"));
        if (quoteCompare !== 0) return quoteCompare;
        return String(b.rate_date || "").localeCompare(String(a.rate_date || ""));
      });

    const seen = new Set();

    for (const row of sortedRows) {
      const currency = normalizeCurrency(row.base_currency || row.currency);
      const quote = normalizeCurrency(row.quote_currency || "PLN");
      const pair = `${currency}/${quote}`;
      if (seen.has(pair)) continue;

      // Planning snapshots retain stale rates; financial single-rate readers refuse them.
      seen.add(pair);
      const entry = {
        currency,
        baseCurrency: currency,
        quoteCurrency: quote,
        rate: Number(row.rate),
        rateDate: row.rate_date,
        effectiveDate: row.effective_date || rateDate,
        source: row.source || "cache"
      };
      snapshot[`${currency.toLowerCase()}/${quote.toLowerCase()}`] = entry;
      if (quote === "PLN") {
        snapshot[currency.toLowerCase()] = entry;
      }
    }

    return snapshot;
  }

  // Cache rows and provider settings must come from the same injected reader.
  async function getCachedFxSnapshotAsync(userId, date = null, store = budgetStore) {
    if (!store || typeof store.listPlanningRows !== "function") {
      return getCachedFxSnapshot(userId, date);
    }

    const settings = await getFxSettingsAsync(userId, store);
    const rows = settings.provider === FX_PROVIDER_DISABLED || settings.provider === FX_PROVIDER_MANUAL
      ? []
      : await store.listPlanningRows(userId, "fx_rates_cache");

    return buildCachedFxSnapshotFromRows({
      date,
      ledgerCurrency: settings.ledgerCurrency,
      manualPairs: settings.manualPairs,
      manualRates: settings.manualRates,
      provider: settings.provider,
      rows,
      timezone: settings.timezone
    });
  }

  async function refreshNbpFxCacheForUser(userId, date = null) {
    const useBudgetStoreFxWrites = budgetStore?.backend === "postgres"
      && typeof budgetStore.upsertFxRates === "function";
    const { provider, manualRates, manualPairs, ledgerCurrency, timezone } = useBudgetStoreFxWrites
      ? await getFxSettingsAsync(userId)
      : getFxSettings(userId);

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
      const updated = [];
      for (const [pair, rate] of manualEntries) {
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

        await upsertFxCacheRateAsync(userId, rateInfo, date, { timezone });
        updated.push(rateInfo);
      }

      return {
        provider,
        updated_count: updated.length,
        updated
      };
    }

    const currencies = (useBudgetStoreFxWrites
      ? await collectCurrenciesForFxSnapshotAsync(userId)
      : collectCurrenciesForFxSnapshot(userId))
      .map(normalizeCurrency)
      .filter(currency => currency && currency !== ledgerCurrency);

    const uniqueCurrencies = [...new Set(currencies)];

    const updated = [];

    for (const currency of uniqueCurrencies) {
      const rateInfo = await fetchProviderRate(provider, currency, date, ledgerCurrency, timezone);
      await upsertFxCacheRateAsync(userId, rateInfo, date, { timezone });
      updated.push(rateInfo);
    }

    // Pending rows are confirmed at their own date, so today's rate alone
    // cannot unblock a row dated while refreshes were not running.
    const today = date || todayInTimezone(timezone);
    for (const needed of await pendingDatesNeedingFxRates(userId, { provider, ledgerCurrency, timezone }, today)) {
      try {
        const rateInfo = await fetchProviderRate(provider, needed.currency, needed.date, ledgerCurrency, timezone);
        await upsertFxCacheRateAsync(userId, rateInfo, needed.date, { timezone });
        updated.push(rateInfo);
      } catch (error) {
        logError("cashflow_fx_pending_backfill_failed", { userId, currency: needed.currency, date: needed.date, error: error.message });
      }
    }

    return {
      provider,
      updated_count: updated.length,
      updated
    };
  }

  /** Foreign-currency pending rows dated up to today whose cached rate for that
   * date is missing or stale. Bounded so one refresh cannot flood the provider. */
  async function pendingDatesNeedingFxRates(userId, { provider, ledgerCurrency, timezone }, today) {
    let pendingRows;
    let cacheRows;
    if (budgetStore && typeof budgetStore.listPlanningRows === "function") {
      [pendingRows, cacheRows] = await Promise.all([
        budgetStore.listPlanningRows(userId, "pending_transactions"),
        budgetStore.listPlanningRows(userId, "fx_rates_cache")
      ]);
    } else {
      const db = openPlanningDb(userId);
      try {
        pendingRows = db.prepare("SELECT currency, date FROM pending_transactions").all();
        cacheRows = db.prepare("SELECT * FROM fx_rates_cache").all();
      } finally {
        db.close();
      }
    }
    const settings = { provider, manualRates: {}, manualPairs: {}, ledgerCurrency, timezone };
    const needed = new Map();
    for (const row of pendingRows) {
      const currency = normalizeCurrency(row.currency);
      const rowDate = String(row.date || "").slice(0, 10);
      if (!currency || currency === ledgerCurrency || !/^\d{4}-\d{2}-\d{2}$/.test(rowDate) || rowDate > today) continue;
      try {
        if (cachedFxRateFromRows(settings, cacheRows, currency, rowDate, ledgerCurrency)) continue;
      } catch (error) {
        if (error?.details?.code !== "stale_fx_rate") throw error;
      }
      needed.set(`${currency}|${rowDate}`, { currency, date: rowDate });
    }
    return [...needed.values()].slice(0, 60);
  }

  async function refreshNbpFxCacheForAllUsers(date = null) {
    const userIds = typeof listCashflowUserIdsAsync === "function"
      ? await listCashflowUserIdsAsync()
      : listCashflowUserIds();
    const results = [];

    for (const userId of userIds) {
      try {
        const result = await refreshNbpFxCacheForUser(userId, date);
        const projection = typeof regenerateProjectionsAfterMutationAsync === "function"
          ? await regenerateProjectionsAfterMutationAsync(userId)
          : regenerateProjectionsAfterMutation(userId);

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
    const fxSettings = await getFxSettingsAsync(userId);
    const { provider, timezone } = fxSettings;
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
      const rate = Number(manualRateForPair(fxSettings, base, quote));
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

  function currenciesForSnapshotFromRows(settings = {}, rows = []) {
    const ledgerCurrency = normalizeSupportedCurrency(settings.ledger_currency || "PLN");
    const usedCurrencies = normalizeFxCurrencyList(settings.fx_used_currencies, ledgerCurrency);
    const observedCurrencies = rows
      .map(row => String(row.currency || "").toUpperCase())
      .filter(Boolean);

    return [...new Set([...usedCurrencies, ...observedCurrencies])];
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

      return currenciesForSnapshotFromRows(settings, rows);
    } finally {
      db.close();
    }
  }

  async function collectCurrenciesForFxSnapshotAsync(userId) {
    if (budgetStore && typeof budgetStore.listPlanningRows === "function") {
      const [
        settingsRows,
        recurringExpenses,
        recurringIncomes,
        flexTransactions,
        goals,
        oneOffTransactions,
        pendingTransactions
      ] = await Promise.all([
        budgetStore.listPlanningRows(userId, "settings"),
        budgetStore.listPlanningRows(userId, "recurring_expenses"),
        budgetStore.listPlanningRows(userId, "recurring_incomes"),
        budgetStore.listPlanningRows(userId, "flex_transactions"),
        budgetStore.listPlanningRows(userId, "goals"),
        budgetStore.listPlanningRows(userId, "one_off_transactions"),
        budgetStore.listPlanningRows(userId, "pending_transactions")
      ]);

      return currenciesForSnapshotFromRows(
        settingsRows.find(row => Number(row.id) === 1) || settingsRows[0] || {},
        [
          ...recurringExpenses,
          ...recurringIncomes,
          ...flexTransactions,
          ...goals,
          ...oneOffTransactions,
          ...pendingTransactions
        ]
      );
    }

    return collectCurrenciesForFxSnapshot(userId);
  }

  async function ensureFxCacheForMutation(userId, input = {}) {
    const currency = requireSupportedCurrency(input?.currency || "PLN");
    const useBudgetStoreFxWrites = budgetStore?.backend === "postgres"
      && typeof budgetStore.upsertFxRates === "function";
    const { provider, manualRates, manualPairs, ledgerCurrency, timezone } = useBudgetStoreFxWrites
      ? await getFxSettingsAsync(userId)
      : getFxSettings(userId);

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

    // This preflight creates/edits planning sources, never actual ledger money.
    const cached = useBudgetStoreFxWrites
      ? cachedFxRateFromRows(
          { provider, manualRates, manualPairs, ledgerCurrency, timezone },
          await budgetStore.listPlanningRows(userId, "fx_rates_cache"),
          currency,
          null,
          ledgerCurrency,
          { allowStale: true }
        )
      : getCachedFxRate(userId, currency, null, ledgerCurrency, { allowStale: true });

    if (cached) {
      return {
        refreshed: false,
        currency,
        cached_rate: cached
      };
    }

    const rateInfo = await fetchProviderRate(provider, currency, null, ledgerCurrency, timezone);
    await upsertFxCacheRateAsync(userId, rateInfo, null, { timezone });

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
    collectCurrenciesForFxSnapshotAsync,
    ensureFxCacheForMutation,
    fetchProviderRate,
    fetchNbpFxSnapshot,
    fetchNbpPairRate,
    fetchNbpRate,
    getCachedFxRate,
    getCachedFxRateAsync,
    getCachedFxSnapshot,
    getCachedFxSnapshotAsync,
    getFxProviderSettings: getFxSettings,
    getFxProviderSettingsAsync: getFxSettingsAsync,
    getProviderPairRate,
    refreshNbpFxCacheForAllUsers,
    refreshNbpFxCacheForUser,
    safeGetCurrentFxSnapshot,
    safeGetCurrentFxSnapshotAsync,
    upsertFxCacheRate,
    upsertFxCacheRateAsync
  };
}

