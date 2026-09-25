import test from "node:test";
import assert from "node:assert";
import { createCashflowFxCacheService } from "../../src/server/cashflow-fx-cache-service.js";

test("FX Cache stale rate bounding", async (t) => {
  await t.test("rejects rates older than 14 days with stale_fx_rate error", async () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const mockDb = {
      prepare: (sql) => {
        if (sql.includes("FROM settings")) {
          return { get: () => ({ fx_provider: "nbp", ledger_currency: "PLN" }) };
        }
        if (sql.includes("LIMIT 1") && sql.includes("ORDER BY rate_date DESC")) {
          return {
            get: () => ({ rate: 4.5, rate_date: fifteenDaysAgo })
          };
        }
        return { get: () => undefined };
      },
      close: () => {}
    };

    const fxService = createCashflowFxCacheService({
      budgetStore: null,
      openPlanningDb: () => mockDb,
      normalizeCurrency: value => String(value || "").trim().toUpperCase()
    });

    let err = null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      fxService.getCachedFxRate("test-user", "EUR", today, "PLN");
    } catch (e) {
      err = e;
    }

    assert.ok(err, "Should throw an error for stale FX rate");
    assert.strictEqual(err.status, 409, "Error status should be 409");
    assert.strictEqual(err.details?.code, "stale_fx_rate", "Error code should be stale_fx_rate");
    assert.strictEqual(Math.floor(err.details?.ageDays), 15, "Error ageDays should be 15");
  });

  await t.test("rejects rates older than 14 days in cachedFxRateFromRows with stale_fx_rate error", async () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rows = [{
      base_currency: 'EUR',
      quote_currency: 'PLN',
      rate: 4.5,
      rate_date: fifteenDaysAgo
    }];

    const fxService = createCashflowFxCacheService({
      budgetStore: {
        backend: "postgres",
        async listPlanningRows(userId, table) {
          if (table === "settings") return [{ id: 1, fx_provider: "nbp", ledger_currency: "PLN" }];
          if (table === "fx_rates_cache") return rows;
          return [];
        }
      },
      normalizeCurrency: value => String(value || "").trim().toUpperCase()
    });

    let err = null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      await fxService.getCachedFxRateAsync("test-user", "EUR", today, "PLN");
    } catch (e) {
      err = e;
    }

    assert.ok(err, "Should throw an error for stale FX rate");
    assert.strictEqual(err.status, 409, "Error status should be 409");
    assert.strictEqual(err.details?.code, "stale_fx_rate", "Error code should be stale_fx_rate");
    assert.strictEqual(Math.floor(err.details?.ageDays), 15, "Error ageDays should be 15");
  });
});
