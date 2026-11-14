import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { createSqliteBudgetStore, createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createPostgresGlobalSchemaSql } from "../../src/server/cashflow-postgres-global-schema.js";
import { FINANCIAL_JOURNAL_SCHEMA, createFinancialJournal } from "../../src/server/cashflow-financial-journal.js";
import { applyProjectionGenerationPlanToBudgetStore } from "../../src/server/cashflow-projection-engine-service.js";
import { prepareSnapshot } from "../../src/engine/prepare-snapshot.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";
import { createFinancialOperationService } from "../../src/server/cashflow-financial-operation-service.js";
import { createDeviceService } from "../../src/server/cashflow-device-service.js";
import { createDeviceStore } from "../../src/server/cashflow-device-store.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { createSqliteGlobalStore } from "../../src/server/cashflow-sqlite-global-store.js";
import { createFinancialGrantAuthorizer } from "../../src/server/cashflow-financial-operation-service.js";
import path from "node:path";
import { createBudgetStoreSnapshot, restoreBudgetStoreSnapshot } from "../../src/server/cashflow-budget-store-snapshot.js";

/** Build derived financial rows using the same shared calculation as the app. */
async function project(writer, budgetId, revision, idSeed) {
  const tables = {};
  for (const name of ["planned_transactions", "recurring_incomes", "recurring_expenses", "goals", "flex_transactions",
    "one_off_transactions", "pending_transactions", "future_transactions", "projection_snapshots"]) {
    tables[name] = await writer.listPlanningRows(budgetId, name);
  }
  const settings = (await writer.listPlanningRows(budgetId, "settings"))[0];
  const snapshot = prepareSnapshot({ budgetId, revision, settings, tables,
    confirmedRows: [], fxSnapshot: null, today: "2026-06-01", generationTimestamp: "2026-06-01T00:00:00.000Z", idSeed });
  await applyProjectionGenerationPlanToBudgetStore({ budgetId, budgetStore: writer, plan: calculateSnapshot(snapshot).plan });
}

/** Exercise real source/derived rows, never a shadow journal source table. */
async function exercise({ store, transaction, initialize, queryOutside }) {
  const budgetId = "journal-budget";
  await initialize();
  let authorized = true;
  let fail = null;
  let mutationCalls = 0;
  const run = work => transaction(async (writer, connection) => {
    const query = async (sql, args = []) => {
      if (store.backend === "postgres") {
        let index = 0;
        return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), args)).rows;
      }
      const statement = connection.prepare(sql);
      return statement.reader ? statement.all(...args) : (statement.run(...args), []);
    };
    if (store.backend === "postgres") await writer.lockBudgetLedger(budgetId);
    const journal = createFinancialJournal({ query,
      authorize: async () => { if (!authorized) throw new Error("Device revoked"); },
      mutate: async operation => {
        mutationCalls++;
        const timestamp = "2026-06-01T00:00:00.000Z";
        await writer.insertPlanningRows(budgetId, "one_off_transactions", [{ ...operation.payload,
          created_at: timestamp, updated_at: timestamp }]);
        await project(writer, budgetId, operation.baseRevision, operation.operationId);
        if (fail === "projection") throw new Error("Projection boundary failure");
      }, afterRecord: () => { if (fail === "receipt") throw new Error("Receipt boundary failure"); } });
    return work(journal, query);
  });
  const initial = await run(journal => journal.bootstrap(budgetId));
  const operation = { version: 1, operationId: randomUUID(), budgetId, epoch: initial.epoch, baseRevision: 0,
    kind: "one-off.create", payload: { id: randomUUID(), name: "Real source", amount: 10, currency: "PLN", type: "income", date: "2026-06-10" } };
  for (const phase of ["projection", "receipt"]) {
    fail = phase;
    await assert.rejects(() => run(journal => journal.apply(operation)), /boundary failure/);
    assert.deepEqual(await store.listPlanningRows(budgetId, "one_off_transactions"), []);
    assert.deepEqual(await store.listPlanningRows(budgetId, "future_transactions"), []);
    assert.deepEqual(await store.listPlanningRows(budgetId, "projection_snapshots"), []);
    assert.equal((await run(journal => journal.head(budgetId))).revision, 0);
    assert.equal((await queryOutside("SELECT * FROM cashflow_sync_operations")).length, 0);
  }
  fail = null;
  const accepted = await run(journal => journal.apply(operation));
  assert.equal(accepted.revision, 1);
  const lookup = { budgetId, epoch: initial.epoch, operationId: operation.operationId };
  assert.deepEqual(await run(journal => journal.lookup(lookup)), accepted);
  assert.equal(await run(journal => journal.lookup({ ...lookup, operationId: randomUUID() })), null);
  const calls = mutationCalls;
  const replayed = await run(journal => journal.apply(operation));
  assert.equal(replayed.replayed, true);
  assert.equal(mutationCalls, calls);
  assert.equal((await store.listPlanningRows(budgetId, "one_off_transactions")).length, 1);
  assert.ok((await store.listPlanningRows(budgetId, "future_transactions")).some(row => row.source_one_off_id === operation.payload.id));
  await assert.rejects(() => run(journal => journal.apply({ ...operation, payload: { ...operation.payload, amount: 11 } })), /OPERATION_ID_REUSED/);
  await assert.rejects(() => run(journal => journal.apply({ ...operation, operationId: randomUUID() })), /REVISION_CONFLICT/);
  authorized = false;
  await assert.rejects(() => run(journal => journal.apply(operation)), /Device revoked/);
  await assert.rejects(() => run(journal => journal.changes({ budgetId, epoch: initial.epoch, afterRevision: 0, limit: 1 })), /Device revoked/);
  await assert.rejects(() => run(journal => journal.lookup(lookup)), /Device revoked/);
  authorized = true;
  const request = { budgetId, epoch: initial.epoch, afterRevision: 0, limit: 1 };
  const page = await run(journal => journal.changes(request));
  assert.equal(page.changes[0].payload.id, operation.payload.id);
  assert.equal(page.nextRevision, 1);
  assert.equal(page.hasMore, false);
  const second = { ...operation, operationId: randomUUID(), baseRevision: 1,
    payload: { ...operation.payload, id: randomUUID(), name: "Second source" } };
  assert.equal((await run(journal => journal.apply(second))).revision, 2);
  const bounded = await run(journal => journal.changes(request));
  assert.equal(bounded.changes.length, 1);
  assert.equal(bounded.hasMore, true);
  const last = await run(journal => journal.changes({ ...request, afterRevision: bounded.nextRevision }));
  assert.equal(last.changes[0].operationId, second.operationId);
  assert.equal(last.hasMore, false);
  assert.equal((await run(journal => journal.apply(operation))).revision, 1);
  // A late reset failure must retain both the old epoch and original receipts.
  await assert.rejects(() => run(async journal => {
    await journal.rotateEpoch(budgetId);
    throw new Error("Reset boundary failure");
  }), /Reset boundary failure/);
  assert.equal((await run(journal => journal.apply(operation))).replayed, true);
  await store.updatePlanningRowsById(budgetId, "one_off_transactions", [{ id: operation.payload.id, name: "Current name" }]);
  assert.equal((await run(journal => journal.changes(request))).changes[0].payload.name, "Real source");
  await run(async (_journal, query) => { await query("UPDATE cashflow_sync_operations SET result_json = ? WHERE budget_id = ?", ["{}", budgetId]); });
  await assert.rejects(() => run(journal => journal.apply(operation)), /JOURNAL_INCOMPLETE/);
  await assert.rejects(() => run(journal => journal.changes(request)), /JOURNAL_INCOMPLETE/);
  await assert.rejects(() => run(journal => journal.lookup(lookup)), /JOURNAL_INCOMPLETE/);
  await run(journal => journal.rotateEpoch(budgetId));
  await assert.rejects(() => run(journal => journal.apply(operation)), /RESYNC_REQUIRED/);
  await assert.rejects(() => run(journal => journal.changes(request)), /RESYNC_REQUIRED/);
  await assert.rejects(() => run(journal => journal.lookup(lookup)), /RESYNC_REQUIRED/);
  // The actual operation host must require authorization for reads and retries,
  // validate domain fields, and never perform projection after committing sources.
  const current = await run(journal => journal.head(budgetId));
  const actions = [];
  let rejectHostProjection = false;
  const service = createFinancialOperationService({ budgetStore: store,
    authorize: async context => {
      assert.ok(context.connection); assert.equal(context.budgetId, budgetId);
      actions.push(context.action);
      if (!authorized) throw new Error("Device revoked");
    }, project: async ({ writer }) => {
      await project(writer, budgetId, current.revision, "host-projection");
      if (rejectHostProjection) throw new Error("Host projection failure");
    } });
  const hostOperation = { ...operation, operationId: randomUUID(), epoch: current.epoch,
    baseRevision: current.revision, payload: { ...operation.payload, id: randomUUID(), name: "Hosted source" } };
  rejectHostProjection = true;
  await assert.rejects(() => service.apply(hostOperation), /Host projection failure/);
  assert.equal((await store.listPlanningRows(budgetId, "one_off_transactions")).some(row => row.id === hostOperation.payload.id), false);
  rejectHostProjection = false;
  assert.equal((await service.apply(hostOperation)).revision, 1);
  assert.equal((await service.apply(hostOperation)).replayed, true);
  const hostLookup = { budgetId, epoch: current.epoch, operationId: hostOperation.operationId };
  assert.equal((await service.lookup(hostLookup)).sourceId, hostOperation.payload.id);
  authorized = false;
  await assert.rejects(() => service.apply(hostOperation), /Device revoked/);
  await assert.rejects(() => service.changes({ ...request, epoch: current.epoch }), /Device revoked/);
  await assert.rejects(() => service.lookup(hostLookup), /Device revoked/);
  authorized = true;
  assert.equal((await service.changes({ ...request, epoch: current.epoch })).changes[0].payload.name, "Hosted source");
  assert.ok(actions.includes("read"));
  // A web/background invalidation must advance CAS without impersonating a
  // device source operation, and a late error must undo both effects and feed.
  const { recordFinancialChange } = await import("../../src/server/cashflow-financial-journal.js");
  await assert.rejects(() => run(async (_journal, query) => {
    await recordFinancialChange(query, budgetId, "planner");
    throw new Error("Server revision rollback");
  }), /Server revision rollback/);
  assert.equal((await run(journal => journal.head(budgetId))).revision, 1);
  await run((_journal, query) => recordFinancialChange(query, budgetId, "planner"));
  const invalidationPage = await service.changes({ budgetId, epoch: current.epoch, afterRevision: 1, limit: 1 });
  assert.deepEqual(invalidationPage.changes[0].payload, { reason: "planner" });
  assert.equal(invalidationPage.changes[0].kind, "budget.invalidate");
  assert.equal(invalidationPage.headRevision, 2);
  const serverRecord = (await queryOutside("SELECT * FROM cashflow_sync_operations WHERE revision = 2"))[0];
  await run((_journal, query) => query("UPDATE cashflow_sync_operations SET fingerprint = ? WHERE revision = 2", ["tampered"]));
  await assert.rejects(() => service.changes({ budgetId, epoch: current.epoch, afterRevision: 1, limit: 1 }), /JOURNAL_INCOMPLETE/);
  await run((_journal, query) => query("UPDATE cashflow_sync_operations SET fingerprint = ? WHERE revision = 2", [serverRecord.fingerprint]));
  await assert.rejects(() => service.apply({ ...hostOperation, operationId: randomUUID(),
    baseRevision: 1, payload: { ...hostOperation.payload, id: randomUUID() } }), /REVISION_CONFLICT/);
  assert.equal((await service.apply(hostOperation)).replayed, true);
  const saved = await createBudgetStoreSnapshot({ budgetStore: store, budgetIds: [budgetId] });
  await restoreBudgetStoreSnapshot({ budgetStore: store, snapshot: saved });
  const restored = await run(journal => journal.head(budgetId));
  assert.notEqual(restored.epoch, current.epoch);
  assert.equal(restored.revision, 0);
  assert.equal((await store.listPlanningRows(budgetId, "one_off_transactions")).some(row => row.id === hostOperation.payload.id), true);
  await assert.rejects(() => service.apply(hostOperation), /RESYNC_REQUIRED/);
  // FX cache commits must fence device baselines even if no projection follows.
  if (store.backend === "postgres") {
    const { createCashflowFxCacheService } = await import("../../src/server/cashflow-fx-cache-service.js");
    const fxService = createCashflowFxCacheService({ budgetStore: store,
      normalizeCurrency: value => String(value).toUpperCase() });
    await fxService.upsertFxCacheRateAsync(budgetId, { currency: "EUR", rate: 4.2,
      effectiveDate: "2026-06-01" }, "2026-06-01", { timezone: "UTC" });
    assert.equal((await run(journal => journal.head(budgetId))).revision, 1);
    assert.equal((await store.listPlanningRows(budgetId, "fx_rates_cache")).some(row => row.rate === 4.2), true);
  }
}

test("financial SQLite journal rolls real source/projection/receipt/feed back together", async () => {
  const harness = await createCashflowTestHarness({ userId: "journal-budget", today: "2026-06-01", initializeUser: false });
  const service = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
  const store = createSqliteBudgetStore(service);
  try {
    await exercise({ store, transaction: work => store.planningTransaction(harness.userId, work),
      initialize: async () => { const db = service.openPlanningDb(harness.userId); try { db.exec(FINANCIAL_JOURNAL_SCHEMA); } finally { db.close(); } },
      queryOutside: async sql => { const db = service.openPlanningDb(harness.userId); try { return db.prepare(sql).all(); } finally { db.close(); } } });
    const { createCashflowFxCacheService } = await import("../../src/server/cashflow-fx-cache-service.js");
    const fx = createCashflowFxCacheService({ openPlanningDb: service.openPlanningDb,
      normalizeCurrency: value => String(value).toUpperCase() });
    const rate = { currency: "EUR", rate: 4.2, effectiveDate: "2026-06-01" };
    fx.upsertFxCacheRate(harness.userId, rate, "2026-06-01");
    let db = service.openPlanningDb(harness.userId);
    try {
      assert.equal(db.prepare("SELECT revision FROM cashflow_sync_heads").get().revision, 1);
      db.exec("CREATE TRIGGER reject_fx_revision BEFORE INSERT ON cashflow_sync_operations BEGIN SELECT RAISE(ABORT, 'FX revision failure'); END");
    } finally { db.close(); }
    assert.throws(() => fx.upsertFxCacheRate(harness.userId, { ...rate, rate: 4.3 }, "2026-06-01"), /FX revision failure/);
    db = service.openPlanningDb(harness.userId);
    try { assert.equal(db.prepare("SELECT rate FROM fx_rates_cache WHERE currency = 'EUR'").get().rate, 4.2); }
    finally { db.close(); }
  } finally { await harness.cleanup(); }
});

test("financial PostgreSQL journal rolls real source/projection/receipt/feed back together", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ('journal-budget','journal-budget','Synthetic',now(),now())");
  const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 1 });
  try {
    await store.initialize();
    await store.insertPlanningRows("journal-budget", "settings", [{ id: 1, updated_at: "2026-06-01T00:00:00Z" }]);
    await exercise({ store, transaction: store.transaction,
      initialize: () => pool.query(FINANCIAL_JOURNAL_SCHEMA), queryOutside: async sql => (await pool.query(sql)).rows });
  } finally { await store.close(); }
}));

/** Same grant journey on one PostgreSQL connection or a read-only attached
 * SQLite global database; all financial writes remain in the planning file. */
async function exerciseRealGrant(global, budget, authorizationDbPath = null) {
    const devices = createDeviceStore(global);
    const service = createDeviceService({ store: devices });
    const sql = (text, args = []) => devices.transaction(tx => tx.query(text, args));
    const stamp = new Date().toISOString();
    await sql("INSERT INTO accounts (id, display_name, status, created_at, updated_at) VALUES ('host-owner','Owner','active',?,?)", [stamp, stamp]);
    await sql("INSERT INTO budgets (id, storage_key, display_name, status, created_by_account_id, created_at, updated_at) VALUES ('journal-budget','journal-budget','Budget','active','host-owner',?,?)", [stamp, stamp]);
    await sql("INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at) VALUES ('journal-budget','host-owner','owner',?,?)", [stamp, stamp]);
    await sql("UPDATE auth_config SET active_mode='internal' WHERE id=1");
    await sql("INSERT INTO auth_sessions (id, account_id, token_hash, csrf_token_hash, auth_method, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES ('host-session','host-owner','synthetic','synthetic','internal',?,?,?,?)",
      [stamp, stamp, new Date(Date.now() + 3600000).toISOString(), new Date(Date.now() + 86400000).toISOString()]);
    if (budget.backend === "postgres") await budget.insertPlanningRows("journal-budget", "settings", [{ id: 1, updated_at: stamp }]);
    const pairing = await service.createPairing("Financial host", "app:financial:sync");
    await service.approve({ verificationCode: pairing.verificationCode, accountId: "host-owner", sessionId: "host-session",
      budgetIds: ["journal-budget"], writeBudgetIds: ["journal-budget"] });
    const tokens = await service.poll(pairing.deviceCode);
    if (budget.backend === "sqlite") {
      const invalidAttachment = createFinancialOperationService({ budgetStore: budget,
        authorize: createFinancialGrantAuthorizer({ deviceService: service, token: tokens.accessToken, backend: "sqlite" }),
        project: async () => { throw new Error("Must not project without attached authorization"); } });
      await assert.rejects(() => invalidAttachment.changes({ budgetId: "journal-budget", epoch: randomUUID(), afterRevision: 0, limit: 1 }), /cashflow_authorization/);
    }
    let epoch;
    const transaction = budget.backend === "postgres" ? budget.transaction
      : work => budget.planningTransaction("journal-budget", work);
    await transaction(async (_writer, connection) => {
      epoch = randomUUID();
      if (budget.backend === "postgres") await connection.query("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ('journal-budget',$1,0)", [epoch]);
      else connection.prepare("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ('journal-budget',?,0)").run(epoch);
    });
    const host = createFinancialOperationService({ budgetStore: budget, authorizationDbPath,
      authorize: createFinancialGrantAuthorizer({ deviceService: service, token: tokens.accessToken, backend: budget.backend }),
      project: ({ writer }) => project(writer, "journal-budget", 0, "real-grant") });
    const operation = { version: 1, budgetId: "journal-budget", epoch, baseRevision: 0, operationId: randomUUID(),
      kind: "one-off.create", payload: { id: randomUUID(), name: "Authorized source", amount: 10, currency: "PLN", type: "income", date: "2026-06-10" } };
    assert.equal((await host.apply(operation)).revision, 1);
    assert.equal((await host.apply(operation)).replayed, true);
    const lookup = { budgetId: operation.budgetId, epoch, operationId: operation.operationId };
    assert.equal((await host.lookup(lookup)).sourceId, operation.payload.id);
    // Protocol v1: the immutable binding must match the grant on this transaction.
    const instanceId = (await sql("SELECT instance_id FROM app_device_instance WHERE id = 1"))[0].instance_id;
    const binding = { protocolVersion: 1, instanceId, accountId: "host-owner", budgetId: "journal-budget" };
    const { negotiateAppSync } = await import("../../src/server/cashflow-app-sync-contract.js");
    const { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } = await import("../../src/engine/index.js");
    const compatibility = negotiateAppSync({ protocolVersions: [1], stateVersions: [3], financialModelVersions: [1],
      engineProtocolVersions: [ENGINE_PROTOCOL_VERSION], engineVersions: [ENGINE_VERSION] });
    const second = { ...operation, operationId: randomUUID(), baseRevision: 1, payload: { ...operation.payload, id: randomUUID(), name: "Protocol source" } };
    for (const wrong of [{ instanceId: randomUUID() }, { accountId: "someone-else" }]) {
      await assert.rejects(() => host.submit({ ...binding, ...wrong, compatibility, operation: second }), /SYNC_BINDING_MISMATCH/);
      await assert.rejects(() => host.results({ ...binding, ...wrong, epoch, operationId: operation.operationId }), /SYNC_BINDING_MISMATCH/);
      await assert.rejects(() => host.syncChanges({ ...binding, ...wrong, epoch, afterRevision: 0, limit: 10 }), /SYNC_BINDING_MISMATCH/);
    }
    await assert.rejects(() => host.submit({ ...binding, compatibility, operation: { ...second, budgetId: "other-budget" } }), /SYNC_BINDING_MISMATCH/);
    assert.equal((await budget.listPlanningRows("journal-budget", "one_off_transactions")).length, 1);
    const submitted = await host.submit({ ...binding, compatibility, operation: second });
    assert.deepEqual(submitted, { ...binding, replayed: false, receipt: { version: 1, operationId: second.operationId,
      budgetId: "journal-budget", epoch, revision: 2, sourceId: second.payload.id } });
    assert.equal((await host.submit({ ...binding, compatibility, operation: second })).replayed, true);
    const found = await host.results({ ...binding, epoch, operationId: second.operationId });
    assert.deepEqual([found.status, found.receipt.revision], ["accepted", 2]);
    const missing = await host.results({ ...binding, epoch, operationId: randomUUID() });
    assert.deepEqual([missing.status, missing.receipt], ["not-found", null]);
    const page = await host.syncChanges({ ...binding, epoch, afterRevision: 0, limit: 10 });
    assert.deepEqual([page.headRevision, page.nextRevision, page.hasMore, page.changes.map(change => change.revision)], [2, 2, false, [1, 2]]);
    // Capabilities follow the web routes: an editor plans but cannot change settings; a viewer only reads.
    const deviceFor = async (accountId, role) => {
      const at = new Date().toISOString();
      await sql("INSERT INTO accounts (id, display_name, status, created_at, updated_at) VALUES (?,?,'active',?,?)", [accountId, accountId, at, at]);
      await sql("INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at) VALUES ('journal-budget',?,?,?,?)", [accountId, role, at, at]);
      await sql("INSERT INTO auth_sessions (id, account_id, token_hash, csrf_token_hash, auth_method, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?,?,?,?,'internal',?,?,?,?)",
        [`${accountId}-session`, accountId, `${accountId}-hash`, `${accountId}-csrf`, at, at, new Date(Date.now() + 3600000).toISOString(), new Date(Date.now() + 86400000).toISOString()]);
      const pairing = await service.createPairing(`${role} host`, "app:financial:sync");
      await service.approve({ verificationCode: pairing.verificationCode, accountId, sessionId: `${accountId}-session`,
        budgetIds: ["journal-budget"], writeBudgetIds: ["journal-budget"] });
      const issued = await service.poll(pairing.deviceCode);
      return createFinancialOperationService({ budgetStore: budget, authorizationDbPath,
        authorize: createFinancialGrantAuthorizer({ deviceService: service, token: issued.accessToken, backend: budget.backend }),
        project: ({ writer }) => project(writer, "journal-budget", 2, `${role}-grant`) });
    };
    const settings = { version: 1, budgetId: "journal-budget", epoch, baseRevision: 2, operationId: randomUUID(), kind: "settings.update",
      payload: { future_periods: 6 } };
    const third = { ...second, operationId: randomUUID(), baseRevision: 2, payload: { ...second.payload, id: randomUUID(), name: "Third source" } };
    const editor = await deviceFor("host-editor", "editor");
    const editorBinding = { ...binding, accountId: "host-editor" };
    await assert.rejects(() => editor.submit({ ...editorBinding, compatibility, operation: settings }), /permission/i);
    // A viewer cannot even be granted financial writes in the browser.
    await assert.rejects(() => deviceFor("host-viewer", "viewer"), /permission|budget/i);
    assert.equal((await editor.submit({ ...editorBinding, compatibility, operation: third })).receipt.revision, 3);
    const fourth = { ...third, operationId: randomUUID(), baseRevision: 3, payload: { ...third.payload, id: randomUUID(), name: "Fourth source" } };
    // Renewal issues a working token; replaying the consumed renewal token revokes the device.
    const renewed = await service.renew(tokens.renewalToken);
    const renewedHost = createFinancialOperationService({ budgetStore: budget, authorizationDbPath,
      authorize: createFinancialGrantAuthorizer({ deviceService: service, token: renewed.accessToken, backend: budget.backend }),
      project: ({ writer }) => project(writer, "journal-budget", 3, "renewed-grant") });
    assert.equal((await renewedHost.submit({ ...binding, compatibility, operation: fourth })).receipt.revision, 4);
    await assert.rejects(() => service.renew(tokens.renewalToken));
    await assert.rejects(() => renewedHost.syncChanges({ ...binding, epoch, afterRevision: 0, limit: 10 }));
    await assert.rejects(() => host.submit({ ...binding, compatibility, operation: second }));
    await service.revoke("host-owner", tokens.deviceId);
    await assert.rejects(() => host.submit({ ...binding, compatibility, operation: second }));
    await assert.rejects(() => host.results({ ...binding, epoch, operationId: second.operationId }));
    await assert.rejects(() => host.apply(operation));
    await assert.rejects(() => host.lookup(lookup));
    await assert.rejects(() => host.apply({ ...operation, operationId: randomUUID(), baseRevision: 1,
      payload: { ...operation.payload, id: randomUUID() } }));
    assert.equal((await budget.listPlanningRows("journal-budget", "one_off_transactions")).length, 4);
    await transaction(async (_writer, connection) => {
      const rows = budget.backend === "postgres"
        ? (await connection.query("SELECT revision FROM cashflow_sync_heads WHERE budget_id='journal-budget'")).rows
        : connection.prepare("SELECT revision FROM cashflow_sync_heads WHERE budget_id='journal-budget'").all();
      assert.equal(Number(rows[0].revision), 4);
    });
}

test("PostgreSQL financial host authorizes actual browser-reviewed device grants on its write connection", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl }) => {
  const global = await createPostgresGlobalStore({ databaseUrl });
  const budget = await createPostgresBudgetStore({ databaseUrl, poolMax: 1 });
  try {
    await global.initialize(); await budget.initialize();
    await exerciseRealGrant(global, budget);
  } finally { await budget.close(); await global.close(); }
}));

test("SQLite financial host holds attached read-only authorization through its planning commit", async () => {
  const harness = await createCashflowTestHarness({ userId: "journal-budget", today: "2026-06-01", initializeUser: false });
  const budget = createSqliteBudgetStore(createCashflowDbService(createCashflowStoragePaths(harness.dataDir)));
  const global = createSqliteGlobalStore({ dataDir: harness.dataDir, listCashflowUserIds: () => [] });
  try {
    await global.initialize();
    await exerciseRealGrant(global, budget, path.join(harness.dataDir, "cashflow-global.sqlite"));
  } finally { await global.close(); await harness.cleanup(); }
});
