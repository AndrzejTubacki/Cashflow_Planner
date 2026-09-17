import assert from "node:assert/strict";
import test from "node:test";

import {
  createCashflowFxCacheService
} from "../../src/server/cashflow-fx-cache-service.js";

function createFxServiceWithSettings(settings, calls = [], tableRows = {}) {
  return createCashflowFxCacheService({
    budgetStore: {
      async listPlanningRows(budgetId, tableName) {
        calls.push({ budgetId, tableName });
        if (tableName === "settings") return [{ id: 1, ...settings }];
        return tableRows[tableName] || [];
      }
    },
    getCurrentFxSnapshot: null,
    listCashflowUserIds: () => [],
    logCashflowError: () => {},
    logError: () => {},
    logServerEvent: () => {},
    normalizeCurrency: value => String(value || "").trim().toUpperCase(),
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async pair-rate lookup");
    },
    regenerateProjectionsAfterMutation: () => {}
  });
}

test("provider pair-rate lookup reads manual direct pairs through the budget-store settings seam", async () => {
  const calls = [];
  const fx = createFxServiceWithSettings({
    fx_provider: "manual",
    ledger_currency: "USD",
    manual_fx_rates: JSON.stringify({
      "EUR/USD": 1.25
    }),
    timezone: "UTC"
  }, calls);

  assert.deepEqual(await fx.getProviderPairRate("household", "EUR", "USD", "2026-01-03"), {
    baseCurrency: "EUR",
    currency: "EUR",
    effectiveDate: "2026-01-03",
    quoteCurrency: "USD",
    rate: 1.25,
    requestedDate: "2026-01-03",
    source: "manual"
  });
  assert.deepEqual(calls, [{
    budgetId: "household",
    tableName: "settings"
  }]);
});

test("provider pair-rate lookup derives legacy manual PLN rates without opening SQLite", async () => {
  const fx = createFxServiceWithSettings({
    fx_provider: "manual",
    ledger_currency: "PLN",
    manual_fx_rates: JSON.stringify({
      EUR: 4,
      USD: 2
    }),
    timezone: "UTC"
  });

  const result = await fx.getProviderPairRate("household", "EUR", "USD", "2026-01-03");
  assert.equal(result.rate, 2);
  assert.equal(result.source, "manual");
});

test("FX snapshot currency collection reads planning rows through the budget-store facade", async () => {
  const calls = [];
  const fx = createFxServiceWithSettings({
    fx_provider: "nbp",
    fx_used_currencies: JSON.stringify(["EUR"]),
    ledger_currency: "PLN",
    timezone: "UTC"
  }, calls, {
    flex_transactions: [{ currency: "USD" }],
    goals: [{ currency: "EUR" }],
    one_off_transactions: [{ currency: "GBP" }],
    pending_transactions: [{ currency: "USD" }],
    recurring_expenses: [{ currency: "PLN" }],
    recurring_incomes: [{ currency: "CHF" }]
  });

  assert.deepEqual(await fx.collectCurrenciesForFxSnapshotAsync("household"), [
    "EUR",
    "PLN",
    "CHF",
    "USD",
    "GBP"
  ]);
  assert.deepEqual(calls.map(call => call.tableName), [
    "settings",
    "recurring_expenses",
    "recurring_incomes",
    "flex_transactions",
    "goals",
    "one_off_transactions",
    "pending_transactions"
  ]);
});

test("cached FX snapshot reads cache rows through the budget-store facade", async () => {
  const calls = [];
  const fx = createFxServiceWithSettings({
    fx_provider: "nbp",
    ledger_currency: "PLN",
    timezone: "UTC"
  }, calls, {
    fx_rates_cache: [
      {
        base_currency: "EUR",
        quote_currency: "PLN",
        currency: "EUR",
        effective_date: "2026-01-01",
        rate: 4.1,
        rate_date: "2026-01-01",
        source: "nbp"
      },
      {
        base_currency: "EUR",
        quote_currency: "PLN",
        currency: "EUR",
        effective_date: "2026-01-02",
        rate: 4.2,
        rate_date: "2026-01-02",
        source: "nbp"
      },
      {
        base_currency: "USD",
        quote_currency: "PLN",
        currency: "USD",
        effective_date: "2026-01-03",
        rate: 3.9,
        rate_date: "2026-01-03",
        source: "future"
      }
    ]
  });

  const snapshot = await fx.getCachedFxSnapshotAsync("household", "2026-01-02");

  assert.equal(snapshot.eur.rate, 4.2);
  assert.equal(snapshot["eur/pln"].rate, 4.2);
  assert.equal(snapshot.usd, undefined);
  assert.deepEqual(calls.map(call => call.tableName), ["settings", "fx_rates_cache"]);
});

test("cached FX snapshot builds manual pairs through the budget-store settings seam", async () => {
  const calls = [];
  const fx = createFxServiceWithSettings({
    fx_provider: "manual",
    ledger_currency: "USD",
    manual_fx_rates: JSON.stringify({
      "EUR/USD": 1.25,
      PLN: 0.25
    }),
    timezone: "UTC"
  }, calls, {
    fx_rates_cache: [{
      base_currency: "EUR",
      quote_currency: "USD",
      currency: "EUR",
      rate: 1.1,
      rate_date: "2026-01-02"
    }]
  });

  const snapshot = await fx.getCachedFxSnapshotAsync("household", "2026-01-02");

  assert.equal(snapshot["eur/usd"].rate, 1.25);
  assert.equal(snapshot["pln/usd"].rate, 0.25);
  assert.deepEqual(calls.map(call => call.tableName), ["settings"]);
});

test("safe current FX snapshot can read provider settings through the budget-store seam", async () => {
  const calls = [];
  let currentSnapshotCalls = 0;
  const fx = createCashflowFxCacheService({
    budgetStore: {
      async listPlanningRows(budgetId, tableName) {
        calls.push({ budgetId, tableName });
        assert.equal(budgetId, "household");
        assert.equal(tableName, "settings");
        return [{
          id: 1,
          fx_provider: "nbp",
          ledger_currency: "PLN",
          timezone: "UTC"
        }];
      }
    },
    getCurrentFxSnapshot: () => {
      currentSnapshotCalls += 1;
      return {
        eur: {
          currency: "EUR",
          rate: 4.2
        }
      };
    },
    listCashflowUserIds: () => [],
    logCashflowError: () => {},
    logError: () => {},
    logServerEvent: () => {},
    normalizeCurrency: value => String(value || "").trim().toUpperCase(),
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async safe FX snapshots");
    },
    regenerateProjectionsAfterMutation: () => {}
  });

  const snapshot = await fx.safeGetCurrentFxSnapshotAsync("household");

  assert.equal(currentSnapshotCalls, 1);
  assert.equal(snapshot.eur.rate, 4.2);
  assert.deepEqual(calls, [{
    budgetId: "household",
    tableName: "settings"
  }]);
});

test("all-user FX refresh can use the async projection status hook", async () => {
  let asyncProjectionCalls = 0;
  let syncProjectionCalls = 0;

  const fx = createCashflowFxCacheService({
    budgetStore: {
      backend: "postgres",
      async listPlanningRows(budgetId, tableName) {
        assert.equal(budgetId, "household");
        assert.equal(tableName, "settings");
        return [{
          id: 1,
          fx_provider: "disabled",
          ledger_currency: "PLN",
          timezone: "UTC"
        }];
      },
      async upsertFxRates() {
        throw new Error("Disabled FX provider should not write cache rows");
      }
    },
    getCurrentFxSnapshot: null,
    listCashflowUserIds: () => {
      throw new Error("Async user listing should be used");
    },
    listCashflowUserIdsAsync: async () => ["household"],
    logCashflowError: () => {},
    logError: () => {},
    logServerEvent: () => {},
    normalizeCurrency: value => String(value || "").trim().toUpperCase(),
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async FX refresh-all");
    },
    regenerateProjectionsAfterMutation: () => {
      syncProjectionCalls += 1;
      return {
        projection_ok: true,
        projection_error: null
      };
    },
    regenerateProjectionsAfterMutationAsync: async budgetId => {
      assert.equal(budgetId, "household");
      asyncProjectionCalls += 1;
      return {
        projection_ok: true,
        projection_error: null
      };
    }
  });

  const result = await fx.refreshNbpFxCacheForAllUsers("2026-01-01");

  assert.equal(asyncProjectionCalls, 1);
  assert.equal(syncProjectionCalls, 0);
  assert.equal(result.length, 1);
  assert.equal(result[0].userId, "household");
  assert.equal(result[0].provider, "disabled");
  assert.equal(result[0]._projection.projection_ok, true);
});

test("mutation FX preflight can fetch and upsert through the budget-store facade", async () => {
  const calls = [];
  const upserts = [];
  const fx = createCashflowFxCacheService({
    budgetStore: {
      backend: "postgres",
      async listPlanningRows(budgetId, tableName) {
        calls.push({ budgetId, tableName });
        assert.equal(budgetId, "household");
        if (tableName === "settings") {
          return [{
            id: 1,
            fx_provider: "frankfurter",
            ledger_currency: "USD",
            timezone: "UTC"
          }];
        }
        if (tableName === "fx_rates_cache") return [];
        return [];
      },
      async upsertFxRates(budgetId, rows) {
        assert.equal(budgetId, "household");
        upserts.push(...rows);
        return { upserted: rows.length };
      }
    },
    fetchImpl: async url => {
      assert.match(url, /frankfurter\.app/);
      assert.match(url, /from=EUR/);
      assert.match(url, /to=USD/);
      return {
        ok: true,
        async json() {
          return {
            date: "2026-01-02",
            rates: {
              USD: 1.2
            }
          };
        }
      };
    },
    getCurrentFxSnapshot: null,
    listCashflowUserIds: () => [],
    logCashflowError: () => {},
    logError: () => {},
    logServerEvent: () => {},
    normalizeCurrency: value => String(value || "").trim().toUpperCase(),
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for mutation FX preflight");
    },
    regenerateProjectionsAfterMutation: () => {}
  });

  const result = await fx.ensureFxCacheForMutation("household", {
    currency: "EUR"
  });

  assert.equal(result.refreshed, true);
  assert.equal(result.provider, "frankfurter");
  assert.equal(result.rate, 1.2);
  assert.deepEqual(calls.map(call => call.tableName), ["settings", "fx_rates_cache"]);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].base_currency, "EUR");
  assert.equal(upserts[0].quote_currency, "USD");
  assert.equal(upserts[0].rate, 1.2);
});
