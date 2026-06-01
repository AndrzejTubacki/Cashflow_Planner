import {
  getFxRateForCurrency,
  normalizeCurrency
} from "./cashflow-money-utils.js";
import {
  FX_PROVIDER_DISABLED,
  FX_PROVIDER_MANUAL,
  FX_PROVIDER_NBP
} from "./cashflow-fx-provider-utils.js";

export function createCashflowConfirmedFxService({
  fetchProviderRate,
  fetchNbpRate,
  getCachedFxRate,
  getFxProviderSettings,
  getFxSnapshotForDate,
  upsertFxCacheRate
}) {
  async function getConfirmedFxForDate(currency, confirmedDate, settings, input = {}, userId = null) {
    const normalizedCurrency = normalizeCurrency(currency);
    const ledgerCurrency = normalizeCurrency(settings?.ledger_currency || "PLN");

    if (normalizedCurrency === ledgerCurrency) {
      return {
        fxRate: 1,
        bufferedFxRate: 1
      };
    }

    if (typeof getFxSnapshotForDate === "function") {
      const snapshot = await getFxSnapshotForDate(confirmedDate);
      const raw = getFxRateForCurrency(normalizedCurrency, settings, snapshot);

      return {
        fxRate: raw,
        bufferedFxRate: raw
      };
    }

    if (input.fx_rate || input.buffered_fx_rate) {
      const fxRate = Number(input.fx_rate || input.buffered_fx_rate);

      if (!Number.isFinite(fxRate) || fxRate <= 0) {
        throw new Error("Invalid FX rate supplied for confirmation");
      }

      return {
        fxRate,
        bufferedFxRate: Number(input.buffered_fx_rate || input.fx_rate)
      };
    }

    const cached = userId ? getCachedFxRate(userId, normalizedCurrency, confirmedDate) : null;

    if (cached) {
      return {
        fxRate: cached,
        bufferedFxRate: cached
      };
    }

    const providerSettings = userId && typeof getFxProviderSettings === "function"
      ? getFxProviderSettings(userId)
      : { provider: FX_PROVIDER_NBP };
    const provider = providerSettings.provider || FX_PROVIDER_NBP;

    if (provider === FX_PROVIDER_DISABLED) {
      throw new Error(`FX is disabled and no rate is available for ${normalizedCurrency}/${ledgerCurrency}`);
    }

    if (provider === FX_PROVIDER_MANUAL) {
      throw new Error(`Manual FX rate is missing for ${normalizedCurrency}/${ledgerCurrency}`);
    }

    const rateInfo = typeof fetchProviderRate === "function"
      ? await fetchProviderRate(provider, normalizedCurrency, confirmedDate, ledgerCurrency, providerSettings.timezone)
      : await fetchNbpRate(normalizedCurrency, confirmedDate, providerSettings.timezone);

    if (userId) {
      upsertFxCacheRate(userId, rateInfo, confirmedDate);
    }

    return {
      fxRate: rateInfo.rate,
      bufferedFxRate: rateInfo.rate
    };
  }

  return {
    getConfirmedFxForDate
  };
}
