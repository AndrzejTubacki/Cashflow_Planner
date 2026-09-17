import assert from "node:assert/strict";
import test from "node:test";

import {
  createCashflowConfirmedFxService
} from "../../src/server/cashflow-confirmed-fx-service.js";

test("confirmed FX fetch uses async provider settings for cache upsert", async () => {
  let settingsReads = 0;
  let upsertSettings = null;
  const providerSettings = {
    provider: "frankfurter",
    timezone: "UTC"
  };
  const service = createCashflowConfirmedFxService({
    fetchProviderRate: async (provider, currency, date, quoteCurrency, timezone) => {
      assert.equal(provider, "frankfurter");
      assert.equal(currency, "EUR");
      assert.equal(date, "2026-01-02");
      assert.equal(quoteCurrency, "USD");
      assert.equal(timezone, "UTC");
      return {
        baseCurrency: "EUR",
        currency: "EUR",
        effectiveDate: date,
        quoteCurrency: "USD",
        rate: 1.2,
        source: "test"
      };
    },
    fetchNbpRate: async () => {
      throw new Error("Provider-aware fetch should be used");
    },
    getCachedFxRate: () => {
      throw new Error("Sync cache lookup should not be used");
    },
    getCachedFxRateAsync: async () => null,
    getFxProviderSettings: () => {
      throw new Error("Sync provider settings should not be used");
    },
    getFxProviderSettingsAsync: async () => {
      settingsReads += 1;
      return providerSettings;
    },
    getFxSnapshotForDate: null,
    upsertFxCacheRate: () => {
      throw new Error("Sync cache upsert should not be used");
    },
    upsertFxCacheRateAsync: async (_userId, rateInfo, requestedDate, settingsOverride) => {
      assert.equal(requestedDate, "2026-01-02");
      assert.equal(rateInfo.rate, 1.2);
      upsertSettings = settingsOverride;
    }
  });

  const result = await service.getConfirmedFxForDate(
    "EUR",
    "2026-01-02",
    { ledger_currency: "USD" },
    {},
    "household"
  );

  assert.equal(result.fxRate, 1.2);
  assert.equal(settingsReads, 1);
  assert.equal(upsertSettings, providerSettings);
});
