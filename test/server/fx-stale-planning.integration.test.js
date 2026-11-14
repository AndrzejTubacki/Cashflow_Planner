import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { createSqliteBudgetStore, createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { createCashflowFxCacheService } from "../../src/server/cashflow-fx-cache-service.js";
import { createCashflowSettingsService } from "../../src/server/cashflow-settings-service.js";
import { createFinancialOperationService } from "../../src/server/cashflow-financial-operation-service.js";
import { ENGINE_VERSION, ENGINE_PROTOCOL_VERSION } from "../../src/engine/index.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

const budgetId = "stale-fx-test";
const today = "2026-11-14";
const stamp = `${today}T12:00:00.000Z`;
const stale = [{ pair: "EUR/PLN", rateDate: "2026-10-13", ageDays: 32 }];

/** Exercise real stores and public routes with identical data on both backends.
 * Provider requests are always stubbed, including the initial refresh failure. */
async function exercise(h, store, provider) {
  await store.updatePlanningRowsById(budgetId, "settings", [{ id: 1, fx_provider: "nbp",
    ledger_currency: "PLN", fx_used_currencies: '["EUR"]', fx_buffer_percent: 0 }]);
  await store.upsertFxRates(budgetId, ["EUR", "USD", "PLN"].map(currency => ({
    base_currency: currency, quote_currency: "PLN", currency, rate_date: "2026-10-13",
    rate: currency === "EUR" ? 4.5 : 1, effective_date: "2026-10-13", source: "nbp", updated_at: stamp
  })));
  await store.insertPlanningRows(budgetId, "one_off_transactions", [{ id: "due", name: "Foreign income",
    amount: 25, currency: "EUR", type: "income", date: today, created_at: stamp, updated_at: stamp },
  { id: "due-past", name: "Earlier foreign income", amount: 25, currency: "EUR", type: "income",
    date: "2026-11-02", created_at: stamp, updated_at: stamp }]);
  const pending = (id, currency, date = today, source = "due") => ({ id, name: id, amount: 25, funded_amount: 25, requested_amount: 25,
    currency, type: "income", date, status: "pending", occurrence_key: `manual:${id}`,
    ...(currency === "EUR" ? { source_one_off_id: source } : {}), created_at: stamp, updated_at: stamp });
  await store.insertPlanningRows(budgetId, "pending_transactions", [pending("foreign", "EUR"), pending("native", "PLN"),
    // Dated while refreshes were not running: today's rate alone cannot confirm it.
    pending("foreign-past", "EUR", "2026-11-02", "due-past")]);

  const snapshot = await h.api("/api");
  assert.deepEqual(snapshot.staleFxRates, stale, "unused USD and identity pairs are not warnings");
  assert.equal(snapshot.missingFxRates.length, 0);
  if (store.backend === "sqlite") assert.deepEqual(h.cashflow.getSnapshot(budgetId).staleFxRates, stale);

  // Planning edits and regeneration keep using the last observation offline.
  await h.api("/api/one-off", { method: "POST", body: { name: "Future foreign income", amount: 10,
    currency: "EUR", type: "income", date: "2026-12-01" } });
  const projection = await h.api("/api/run-jobs", { method: "POST", body: {} });
  assert.equal(projection._projection.projection_ok, true);
  assert.equal(projection._projection.fx_refresh.provider_refresh_failed, true);
  assert.deepEqual(projection.staleFxRates, stale);
  assert.ok(projection.futureTransactions.some(row => row.currency === "EUR" && row.ledger_amount === 45));

  const failedRefresh = await h.request("/api/fx/refresh", { method: "POST", body: {} });
  assert.equal(failedRefresh.response.status, 503);
  assert.deepEqual((await h.api("/api")).staleFxRates, stale);

  await h.api("/api/pending/native/confirm", { method: "POST", body: { confirmed_date: today } });
  const before = await store.listConfirmedTransactions(budgetId);
  const auditBefore = await store.exportLedgerAuditSnapshot(budgetId);
  const pendingBefore = await store.listPlanningRows(budgetId, "pending_transactions");
  const refused = await h.request("/api/pending/foreign/confirm", { method: "POST", body: { confirmed_date: today } });
  assert.equal(refused.response.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.details.code, "stale_fx_rate");
  assert.equal(refused.body.details.ageDays, 32);
  assert.match(refused.body.error, /EUR\/PLN.*32 days old.*Refresh exchange rates/);
  assert.deepEqual(await store.listConfirmedTransactions(budgetId), before);
  assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), auditBefore);
  assert.deepEqual(await store.listPlanningRows(budgetId, "pending_transactions"), pendingBefore);

  const switchRefused = await h.request("/api/settings", { method: "PUT", body: { ledger_currency: "EUR" } });
  assert.equal(switchRefused.response.status, 409, JSON.stringify(switchRefused.body));
  assert.equal(switchRefused.body.details.code, "stale_fx_rate");
  assert.equal((await store.listPlanningRows(budgetId, "settings"))[0].ledger_currency, "PLN");
  assert.equal((await store.listPlanningRows(budgetId, "ledger_currency_events")).length, 0);

  await refuseSyncConversion(h, store);

  provider.available = true;
  const refreshed = await h.api("/api/fx/refresh", { method: "POST", body: {} });
  assert.equal(refreshed._projection.projection_ok, true);
  assert.deepEqual(refreshed.staleFxRates, []);
  assert.deepEqual((await h.api("/api")).staleFxRates, []);
  await h.api("/api/pending/foreign/confirm", { method: "POST", body: { confirmed_date: today } });
  // Refresh also fetched the rate for the past-dated pending row's own date.
  await h.api("/api/pending/foreign-past/confirm", { method: "POST", body: { confirmed_date: "2026-11-02" } });
  assert.ok((await store.listConfirmedTransactions(budgetId)).some(row => row.id === "foreign-past"));
  const confirmed = (await store.listConfirmedTransactions(budgetId)).find(row => row.id === "foreign");
  assert.equal(confirmed.fx_rate, 4.6);
  assert.equal(confirmed.ledger_amount, 115);

  // Switching to manual policy never expires the user's explicit observation.
  await store.updatePlanningRowsById(budgetId, "settings", [{ id: 1, fx_provider: "manual", manual_fx_rates: '{"EUR":4}' }]);
  await store.insertPlanningRows(budgetId, "pending_transactions", [{ ...pending("manual", "EUR"), source_one_off_id: null }]);
  assert.deepEqual((await h.api("/api")).staleFxRates, []);
  await h.api("/api/pending/manual/confirm", { method: "POST", body: { confirmed_date: today } });
  assert.equal((await store.listConfirmedTransactions(budgetId)).find(row => row.id === "manual").fx_rate, 4);
  assert.ok(provider.calls > 0);
}

/** The wire submission layer must preserve the stale-rate conflict instead of
 * turning it into OPERATION_REJECTED. A failed operation creates no receipt. */
async function refuseSyncConversion(h, store) {
  const binding = { protocolVersion: 1, instanceId: randomUUID(), accountId: budgetId, budgetId };
  const fx = createCashflowFxCacheService({ budgetStore: store,
    normalizeCurrency: value => String(value).toUpperCase(), openPlanningDb: () => h.openPlanningDb() });
  const host = createFinancialOperationService({ budgetStore: store, authorize: async () => binding, project: async () => {},
    ledgerActions: ({ store: writer }) => createCashflowSettingsService({ budgetStore: writer,
      getCachedFxRate: fx.getCachedFxRate, getCachedFxRateAsync: fx.getCachedFxRateAsync,
      withProjectionStatus: (_id, row) => row }) });
  const negotiated = await host.negotiate({ ...binding, offer: { protocolVersions: [1], stateVersions: [3],
    financialModelVersions: [1], engineProtocolVersions: [ENGINE_PROTOCOL_VERSION], engineVersions: [ENGINE_VERSION] } });
  const request = { ...binding, compatibility: negotiated.compatibility };
  const manifest = await host.bootstrap(request);
  const operation = { version: 1, operationId: randomUUID(), budgetId, epoch: manifest.epoch,
    baseRevision: manifest.revision, kind: "settings.update", payload: { ledger_currency: "EUR" } };
  await assert.rejects(host.submit({ ...request, operation }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.details.code, "stale_fx_rate");
    assert.equal(error.details.ageDays, 32);
    assert.match(error.message, /Refresh exchange rates/);
    return true;
  });
  assert.equal((await host.bootstrap(request)).revision, manifest.revision);
  assert.equal((await host.results({ ...binding, epoch: manifest.epoch, operationId: operation.operationId })).status, "not-found");
  assert.equal((await store.listPlanningRows(budgetId, "settings"))[0].ledger_currency, "PLN");
  assert.equal((await store.listPlanningRows(budgetId, "ledger_currency_events")).length, 0);
}

function options(provider) {
  return { userId: budgetId, today, fxSnapshot: null, getFxSnapshotForDate: null, inProcess: true,
    fetchImpl: async url => {
      provider.calls++;
      assert.match(String(url), /api\.nbp\.pl/);
      if (!provider.available) return { ok: false, status: 503, statusText: "Synthetic provider unavailable" };
      return { ok: true, json: async () => ({ code: "EUR", rates: [{ mid: 4.6, effectiveDate: today }] }) };
    } };
}

test("SQLite stale FX permits opening/projection, refuses actual money, and recovers after refresh", async () => {
  const provider = { available: false, calls: 0 };
  const h = await createCashflowTestHarness(options(provider));
  try {
    const store = createSqliteBudgetStore(createCashflowDbService(createCashflowStoragePaths(h.dataDir)));
    await exercise(h, store, provider);
  } finally { await h.cleanup(); }
});

test("SQLite snapshot warns about both stale cross-rate legs, then ignores them once a fresh direct pair exists", async () => {
  const h = await createCashflowTestHarness(options({ available: false, calls: 0 }));
  try {
    const store = createSqliteBudgetStore(createCashflowDbService(createCashflowStoragePaths(h.dataDir)));
    await store.updatePlanningRowsById(budgetId, "settings", [{ id: 1, fx_provider: "nbp", ledger_currency: "USD", fx_used_currencies: '["EUR"]' }]);
    const observation = (base, quote, rate, rateDate) => ({ base_currency: base, quote_currency: quote,
      currency: base, rate, rate_date: rateDate, effective_date: rateDate, source: "nbp", updated_at: stamp });
    await store.upsertFxRates(budgetId, [observation("EUR", "PLN", 4.5, "2026-10-13"), observation("USD", "PLN", 4, "2026-10-13")]);
    assert.deepEqual((await h.api("/api")).staleFxRates, [
      ...stale, { pair: "USD/PLN", rateDate: "2026-10-13", ageDays: 32 }
    ]);
    await store.upsertFxRates(budgetId, [observation("EUR", "USD", 1.2, today)]);
    assert.deepEqual((await h.api("/api")).staleFxRates, [], "obsolete PLN fallback observations do not leave an unrefreshable warning");
  } finally { await h.cleanup(); }
});

test("PostgreSQL stale FX permits opening/projection, refuses actual money, and recovers after refresh", {
  skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests with CASHFLOW_ENABLE_POSTGRES_TESTS"
}, () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const store = await createPostgresBudgetStore({ databaseUrl });
  let h;
  try {
    await global.initialize(); await store.initialize();
    const provider = { available: false, calls: 0 };
    h = await createCashflowTestHarness({ ...options(provider), initializeUser: false,
      databaseConfig: { backend: "postgres", supported: true, external: true, databaseUrlConfigured: true } });
    await h.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: budgetId, displayName: "Synthetic FX owner" } });
    await exercise(h, store, provider);
  } finally { await h?.cleanup(); await store.close(); await global.close(); }
}));
