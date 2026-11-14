import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { createSqliteBudgetStore, createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createPostgresGlobalSchemaSql } from "../../src/server/cashflow-postgres-global-schema.js";
import { FINANCIAL_JOURNAL_SCHEMA } from "../../src/server/cashflow-financial-journal.js";
import { createFinancialOperationService } from "../../src/server/cashflow-financial-operation-service.js";
import { negotiateAppSync } from "../../src/server/cashflow-app-sync-contract.js";
import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "../../src/engine/index.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

const budgetId = "bootstrap-budget";
const instanceId = "12345678-1234-4234-8234-123456789abc";
const binding = { protocolVersion: 1, instanceId, accountId: "owner", budgetId };
const compatibility = negotiateAppSync({ protocolVersions: [1], stateVersions: [3], financialModelVersions: [1],
  engineProtocolVersions: [ENGINE_PROTOCOL_VERSION], engineVersions: [ENGINE_VERSION] });
const stamp = "2026-06-01T00:00:00.000Z";
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const host = store => createFinancialOperationService({ budgetStore: store, project: async () => {},
  authorize: async () => ({ instanceId, accountId: "owner", budgetId }) });

/** One consistent head, paged; stale, forged and expired tokens refused. */
async function exerciseBootstrap(store) {
  await store.insertPlanningRows(budgetId, "one_off_transactions", ["a", "b", "c"].map(id => ({ id: `one-${id}`, name: id, amount: 10, currency: "PLN",
    type: "expense", date: "2026-06-10", created_at: stamp, updated_at: stamp })));
  await store.insertConfirmedTransactions(budgetId, ["x", "y"].map(id => ({ id: `paid-${id}`, name: id, currency: "PLN", amount: 5, type: "income",
    date: "2026-05-01", confirmed_date: "2026-05-01", fx_rate: 1, buffered_fx_rate: 1, ledger_currency: "PLN", ledger_amount: 5,
    running_balance_pln: 0, ledger_year: 2026, occurrence_key: `manual:${id}`, created_at: stamp, updated_at: stamp })));
  const service = host(store);
  const manifest = await service.bootstrap({ ...binding, compatibility }, { now: 1000 });
  assert.deepEqual(manifest.parts.map(part => [part.kind, part.recordCount]),
    [["settings", 1], ["planning", 3], ["ledger", 2], ["currency-events", 0], ["fx", 0], ["ledger-audit", 0], ["fx-snapshot", 1]]);
  assert.equal(manifest.revision, 0);
  assert.match(manifest.firstPageToken, /^[A-Za-z0-9_-]{16,256}$/);
  const received = {};
  let token = manifest.firstPageToken, index = 0;
  while (token) {
    const page = await service.bootstrapPage({ ...binding, bootstrapId: manifest.bootstrapId, pageToken: token, limit: 2 }, { now: 2000 });
    assert.equal(page.pageIndex, index++);
    assert.equal(page.epoch, manifest.epoch);
    const { pageHash, protocolVersion, instanceId: _i, accountId: _a, budgetId: _b, ...body } = page;
    // The hash covers the page as a device receives it over the wire.
    assert.equal(pageHash, createHash("sha256").update(JSON.stringify(canonical(JSON.parse(JSON.stringify(body))))).digest("hex"));
    (received[page.part] ||= []).push(...page.records);
    token = page.nextPageToken;
  }
  // Completion is signalled on a final (possibly empty) page of the last part.
  assert.deepEqual(Object.fromEntries(Object.entries(received).filter(([, rows]) => rows.length).map(([kind, rows]) => [kind, rows.length])),
    { settings: 1, planning: 3, ledger: 2, "fx-snapshot": 1 });
  // Without an FX source wired, the snapshot record is an explicit null.
  assert.deepEqual(received["fx-snapshot"], [{ snapshot: null }]);
  assert.equal(received.settings[0].future_periods, 4);
  assert.equal(Object.hasOwn(received.settings[0], "ntfy_auth_token"), false);
  // Forged, foreign and expired tokens are refused.
  const second = await service.bootstrap({ ...binding, compatibility }, { now: 1000 });
  const flipped = second.firstPageToken.slice(0, -2) + (second.firstPageToken.endsWith("AA") ? "BB" : "AA");
  await assert.rejects(() => service.bootstrapPage({ ...binding, bootstrapId: second.bootstrapId, pageToken: flipped, limit: 2 }, { now: 2000 }),
    /SYNC_BINDING_MISMATCH|INVALID_BOOTSTRAP_TOKEN/);
  await assert.rejects(() => service.bootstrapPage({ ...binding, bootstrapId: randomUUID(), pageToken: second.firstPageToken, limit: 2 }, { now: 2000 }),
    /SYNC_BINDING_MISMATCH/);
  await assert.rejects(() => service.bootstrapPage({ ...binding, bootstrapId: second.bootstrapId, pageToken: second.firstPageToken, limit: 2 },
    { now: second.expiresAtMs + 1 }), /BOOTSTRAP_EXPIRED/);
  // Any accepted change after the manifest makes the bootstrap stale.
  await service.apply({ version: 1, operationId: randomUUID(), budgetId, epoch: second.epoch, baseRevision: 0, kind: "one-off.create",
    payload: { id: randomUUID(), name: "Later", currency: "PLN", amount: 1, type: "income", date: "2026-06-11" } });
  await assert.rejects(() => service.bootstrapPage({ ...binding, bootstrapId: second.bootstrapId, pageToken: second.firstPageToken, limit: 2 },
    { now: 2000 }), /BOOTSTRAP_STALE/);
}

test("bootstrap pages one consistent head and refuses stale, forged or expired tokens on PostgreSQL", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
  const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, "settings", [{ id: 1, ledger_currency: "PLN", future_periods: 4, ntfy_auth_token: "synthetic-secret", updated_at: stamp }]);
    await pool.query(FINANCIAL_JOURNAL_SCHEMA);
    await exerciseBootstrap(store);
  } finally { await store.close(); }
}));

test("bootstrap pages one consistent head and refuses stale, forged or expired tokens on SQLite", async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId, today: "2026-06-01" });
  const service = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
  try {
    const db = service.openPlanningDb(budgetId);
    try {
      db.exec(FINANCIAL_JOURNAL_SCHEMA);
      db.prepare("UPDATE settings SET ledger_currency = 'PLN', future_periods = 4, ntfy_auth_token = 'synthetic-secret'").run();
    } finally { db.close(); }
    await exerciseBootstrap(createSqliteBudgetStore(service));
  } finally { await harness.cleanup(); }
});

test("an epoch rotation forces safe full resynchronization on PostgreSQL", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
  const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, "settings", [{ id: 1, ledger_currency: "PLN", updated_at: stamp }]);
    await pool.query(FINANCIAL_JOURNAL_SCHEMA);
    const service = host(store);
    const first = await service.bootstrap({ ...binding, compatibility });
    const operation = { version: 1, operationId: randomUUID(), budgetId, epoch: first.epoch, baseRevision: 0, kind: "one-off.create",
      payload: { id: randomUUID(), name: "Before restore", currency: "PLN", amount: 5, type: "income", date: "2026-06-10" } };
    await service.submit({ ...binding, compatibility, operation });
    // Restore/import/compaction rotate the epoch (here directly, as they do).
    await store.rotateSyncEpoch(budgetId);
    for (const call of [
      () => service.submit({ ...binding, compatibility, operation: { ...operation, operationId: randomUUID(), baseRevision: 1 } }),
      () => service.results({ ...binding, epoch: first.epoch, operationId: operation.operationId }),
      () => service.syncChanges({ ...binding, epoch: first.epoch, afterRevision: 0, limit: 10 })
    ]) await assert.rejects(call, /RESYNC_REQUIRED/);
    await assert.rejects(() => service.bootstrapPage({ ...binding, bootstrapId: first.bootstrapId, pageToken: first.firstPageToken, limit: 10 }),
      /BOOTSTRAP_STALE/);
    const fresh = await service.bootstrap({ ...binding, compatibility });
    assert.notEqual(fresh.epoch, first.epoch);
    assert.equal(fresh.revision, 0);
    const page = await service.bootstrapPage({ ...binding, bootstrapId: fresh.bootstrapId, pageToken: fresh.firstPageToken, limit: 100 });
    assert.equal(page.epoch, fresh.epoch);
    // The accepted source survives the rotation as baseline state, not as a replayable receipt.
    let token = fresh.firstPageToken, planning = [];
    while (token) {
      const next = await service.bootstrapPage({ ...binding, bootstrapId: fresh.bootstrapId, pageToken: token, limit: 100 });
      if (next.part === "planning") planning.push(...next.records);
      token = next.nextPageToken;
    }
    assert.ok(planning.some(record => record.row.id === operation.payload.id));
    assert.equal((await service.results({ ...binding, epoch: fresh.epoch, operationId: operation.operationId })).status, "not-found");
  } finally { await store.close(); }
}));
