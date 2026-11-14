import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createPostgresGlobalSchemaSql } from "../../src/server/cashflow-postgres-global-schema.js";
import { applyProjectionGenerationPlanToBudgetStore, createCashflowProjectionEngineService } from "../../src/server/cashflow-projection-engine-service.js";
import { createCashflowProjectionStateService } from "../../src/server/cashflow-projection-state-service.js";
import { createCashflowPredictionService } from "../../src/server/cashflow-prediction-service.js";
import { createCashflowFxCacheService } from "../../src/server/cashflow-fx-cache-service.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";
import { completeSnapshot } from "../engine/fixtures.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { todayInTimezone } from "../../src/server/cashflow-date-utils.js";
import { createCashflowPlanMutationService } from "../../src/server/cashflow-plan-mutation-service.js";
import { createCashflowProjectionCoordinatorService } from "../../src/server/cashflow-projection-coordinator-service.js";
import { createCashflowPendingConfirmationService } from "../../src/server/cashflow-pending-confirmation-service.js";
import { createCashflowLedgerService } from "../../src/server/cashflow-ledger-service.js";
import { createCashflowSettingsService } from "../../src/server/cashflow-settings-service.js";
import { createCashflowPendingTransitionService } from "../../src/server/cashflow-pending-transition-service.js";

/** Record connection ownership without simulating PostgreSQL data semantics. */
function recordingDriver() {
  const queries = [];
  let connections = 0;
  let releases = 0;
  class Pool {
    async connect() {
      connections++;
      return {
        async query(sql) { queries.push(sql); return { rows: [], rowCount: 0 }; },
        release() { releases++; }
      };
    }
    async end() {}
  }
  return { module: { Pool }, queries, connections: () => connections, releases: () => releases };
}

test("bound PostgreSQL writers compose projections without a second checkout or early commit", async () => {
  const driver = recordingDriver();
  const store = await createPostgresBudgetStore({ databaseUrl: "postgres://example.invalid/test", pgModule: driver.module });
  const failure = new Error("late financial boundary failure");
  try {
    await assert.rejects(() => store.transaction(async writer => {
      await applyProjectionGenerationPlanToBudgetStore({ budgetId: "budget", budgetStore: writer,
        afterWrite: async nested => { assert.equal(typeof nested.transaction, "function"); } });
      assert.equal(driver.queries.includes("COMMIT"), false);
      throw failure;
    }), error => error === failure);
    assert.equal(driver.connections(), 1);
    assert.equal(driver.releases(), 1);
    assert.equal(driver.queries.filter(sql => sql === "BEGIN").length, 1);
    assert.equal(driver.queries.includes("COMMIT"), false);
    assert.ok(driver.queries.some(sql => sql.startsWith("SAVEPOINT ")));
    assert.ok(driver.queries.some(sql => sql.startsWith("RELEASE SAVEPOINT ")));
    assert.equal(driver.queries.at(-1), "ROLLBACK");
  } finally { await store.close(); }
});

test("nested PostgreSQL failures release their savepoint and leave outer work usable", async () => {
  const driver = recordingDriver();
  const store = await createPostgresBudgetStore({ databaseUrl: "postgres://example.invalid/test", pgModule: driver.module });
  try {
    const result = await store.transaction(async writer => {
      await assert.rejects(() => writer.transaction(async () => { throw new Error("nested failure"); }), /nested failure/);
      return writer.transaction(async () => "accepted");
    });
    assert.equal(result, "accepted");
    const savepoints = driver.queries.filter(sql => sql.startsWith("SAVEPOINT "));
    assert.equal(new Set(savepoints).size, 2);
    assert.ok(driver.queries.includes(`ROLLBACK TO ${savepoints[0]}`));
    assert.equal(driver.queries.at(-1), "COMMIT");
    assert.equal(driver.connections(), 1);
  } finally { await store.close(); }
});

test("PostgreSQL notification batches preserve repeated-key order on bound and default writers", async () => {
  const driver = recordingDriver();
  const store = await createPostgresBudgetStore({ databaseUrl: "postgres://example.invalid/test", pgModule: driver.module });
  const rows = ["same", "other", "same", null, null].map((key, index) => ({
    id: `notice-${index}`, notification_type: "funding_shortfall", title: `Title ${index}`,
    message: "Synthetic notice", dedupe_key: key
  }));
  try {
    await store.upsertNotifications("budget", rows);
    await store.transaction(writer => writer.upsertNotifications("budget", rows));
    const inserts = driver.queries.filter(sql => sql.includes("INSERT INTO notification_queue"));
    assert.equal(inserts.length, 4);
    assert.ok(inserts.every(sql => sql.includes("ON CONFLICT (budget_id, dedupe_key)")));
  } finally { await store.close(); }
});

test("real PostgreSQL composes source and projection rollback, including caught inner failures", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await pool.query(createPostgresGlobalSchemaSql());
    await pool.query(`INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at)
      VALUES ('budget', 'budget', 'Synthetic budget', now(), now())`);
    const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 1 });
    try {
      await store.initialize();
      const source = id => ({ id, name: "Synthetic bill", currency: "PLN", amount: 10,
        type: "expense", date: "2026-06-01", created_at: "2026-06-01T00:00:00.000Z", updated_at: "2026-06-01T00:00:00.000Z" });
      const { plan } = calculateSnapshot(completeSnapshot());
      assert.ok(plan.futureRows.length > 0);
      assert.ok(plan.projectionSnapshotRows.length > 0);
      await assert.rejects(() => store.transaction(async writer => {
        await writer.insertPlanningRows("budget", "one_off_transactions", [source("rolled-back")]);
        await applyProjectionGenerationPlanToBudgetStore({ budgetId: "budget", budgetStore: writer, plan,
          afterWrite: nested => nested.insertPlanningRows("budget", "one_off_transactions", [source("projection-hook")]) });
        assert.equal((await writer.listPlanningRows("budget", "future_transactions")).length, plan.futureRows.length);
        throw new Error("late failure");
      }), /late failure/);
      assert.deepEqual(await store.listPlanningRows("budget", "one_off_transactions"), []);
      assert.deepEqual(await store.listPlanningRows("budget", "future_transactions"), []);
      assert.deepEqual(await store.listPlanningRows("budget", "projection_snapshots"), []);
      await store.transaction(async writer => {
        await writer.insertPlanningRows("budget", "one_off_transactions", [source("retained")]);
        await assert.rejects(() => writer.transaction(async nested => {
          await nested.insertPlanningRows("budget", "one_off_transactions", [source("discarded")]);
          // An actual SQL error must be recoverable, not just a JavaScript throw.
          await nested.insertPlanningRows("budget", "one_off_transactions", [source("retained")]);
        }), /duplicate key/);
        await writer.transaction(nested => nested.insertPlanningRows("budget", "one_off_transactions", [source("after-failure")]));
      });
      assert.deepEqual((await store.listPlanningRows("budget", "one_off_transactions")).map(row => row.id).sort(),
        ["after-failure", "retained"]);
      await store.insertPlanningRows("budget", "settings", [{ id: 1, ledger_currency: "PLN",
        fx_provider: "disabled", updated_at: "2026-06-01T00:00:00.000Z" }]);
      // A single-connection pool plus rejecting defaults catches any hidden read
      // escaping the caller's transaction, rather than accepting stale inputs.
      const forbidden = new Proxy({}, { get: () => () => { throw new Error("Unbound storage access"); } });
      const state = createCashflowProjectionStateService({ budgetStore: forbidden });
      const prediction = createCashflowPredictionService({ budgetStore: forbidden });
      const fx = createCashflowFxCacheService({ budgetStore: forbidden,
        getCurrentFxSnapshot: () => { throw new Error("Disabled FX provider must not call host"); } });
      const engine = createCashflowProjectionEngineService({ budgetStore: forbidden,
        confirmedBalanceAsOfAsync: state.confirmedBalanceAsOfAsync,
        confirmedOccurrenceKeysAsync: state.confirmedOccurrenceKeysAsync,
        confirmedOneOffProgressAsync: state.confirmedOneOffProgressAsync,
        confirmedRowsAfterDateAsync: state.confirmedRowsAfterDateAsync,
        confirmedRowsForPredictionAsync: prediction.confirmedRowsForPredictionAsync,
        getCachedFxSnapshotAsync: fx.getCachedFxSnapshotAsync,
        safeGetCurrentFxSnapshotAsync: fx.safeGetCurrentFxSnapshotAsync,
        recalculatePlanningRunningBalancesAsync: state.recalculatePlanningRunningBalancesAsync,
        logServerEvent: () => {}
      });
      await assert.rejects(() => store.transaction(async writer => {
        const future = { ...source("uncommitted-projection-source"), type: "income", date: todayInTimezone("Europe/Warsaw") };
        await writer.insertPlanningRows("budget", "one_off_transactions", [future]);
        const result = await engine.regenerateProjectionsAsync("budget", writer);
        assert.equal(result.ok, true);
        const pending = await writer.listPlanningRows("budget", "pending_transactions");
        const projected = await writer.listPlanningRows("budget", "future_transactions");
        assert.ok([...pending, ...projected].some(row => row.source_one_off_id === future.id));
        assert.ok((await writer.listPlanningRows("budget", "projection_snapshots")).length > 0);
        throw new Error("composed engine rollback");
      }), /composed engine rollback/);
      assert.equal((await store.listPlanningRows("budget", "one_off_transactions")).some(row => row.id === "uncommitted-projection-source"), false);
      assert.deepEqual(await store.listPlanningRows("budget", "projection_snapshots"), []);
      // Exercise the real mutation/coordinator boundary, not merely a manually
      // composed writer. A late projection failure must reject the source edit.
      let rejectProjection = false;
      const coordinator = createCashflowProjectionCoordinatorService({ budgetStore: store,
        confirmedBalanceAsOfAsync: state.confirmedBalanceAsOfAsync,
        pendingNetBalanceAsync: state.pendingNetBalanceAsync,
        regenerateProjectionsAsync: async (id, writer) => {
          // Independent coordinator refresh uses the default store; composed
          // mutations must still pass their borrowed writer to the engine.
          await engine.regenerateProjectionsAsync(id, writer || store);
          if (rejectProjection) throw new Error("mutation projection rollback");
        }, logCashflowError: () => {}, logServerEvent: () => {} });
      const mutations = createCashflowPlanMutationService({ budgetStore: store,
        requireStartMonthYearIfNeeded: state.requireStartMonthYearIfNeeded,
        normalizeRecurringInput: state.normalizeRecurringInput,
        withProjectionStatus: coordinator.withProjectionStatus });
      await pool.query("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ('budget', $1, 0)", [randomUUID()]);
      const revision = async () => Number((await pool.query("SELECT revision FROM cashflow_sync_heads WHERE budget_id = 'budget'")).rows[0].revision);
      const sourcesBefore = await store.listPlanningRows("budget", "one_off_transactions");
      rejectProjection = true;
      await assert.rejects(() => mutations.createOneOffTransaction("budget", {
        name: "Failed create", amount: 5, currency: "PLN", type: "income", date: todayInTimezone("Europe/Warsaw")
      }), /mutation projection rollback/);
      assert.deepEqual(await store.listPlanningRows("budget", "one_off_transactions"), sourcesBefore);
      assert.equal(await revision(), 0);
      assert.deepEqual(await store.listPlanningRows("budget", "projection_snapshots"), []);
      rejectProjection = false;
      const created = await mutations.createOneOffTransaction("budget", {
        name: "Accepted create", amount: 5, currency: "PLN", type: "income", date: todayInTimezone("Europe/Warsaw")
      });
      assert.equal(created._projection.projection_ok, true);
      const snapshotsBefore = await store.listPlanningRows("budget", "projection_snapshots");
      rejectProjection = true;
      await assert.rejects(() => mutations.updateOneOffTransaction("budget", created.id, { amount: 99 }), /mutation projection rollback/);
      assert.equal((await store.listPlanningRows("budget", "one_off_transactions")).find(row => row.id === created.id).amount, 5);
      assert.deepEqual(await store.listPlanningRows("budget", "projection_snapshots"), snapshotsBefore);
      await assert.rejects(() => mutations.deleteOneOffTransaction("budget", created.id), /mutation projection rollback/);
      assert.ok((await store.listPlanningRows("budget", "one_off_transactions")).some(row => row.id === created.id));
      assert.deepEqual(await store.listPlanningRows("budget", "projection_snapshots"), snapshotsBefore);
      rejectProjection = false;
      const updated = await mutations.updateOneOffTransaction("budget", created.id, { amount: 7 });
      assert.equal(await revision(), 2);
      assert.equal(updated.amount, 7);
      assert.equal(updated._projection.projection_ok, true);
      assert.equal((await mutations.deleteOneOffTransaction("budget", created.id)).ok, true);
      assert.equal(await revision(), 3);
      assert.equal((await store.listPlanningRows("budget", "one_off_transactions")).some(row => row.id === created.id), false);
      // Every planner source family must preserve sources, priority rows,
      // settings and generated state on create/edit/delete projection failures.
      const families = [
        { table: "recurring_incomes", create: "createRecurringIncome", update: "updateRecurringIncome", remove: "deleteRecurringIncome",
          input: { anchor_type: "day_of_month", anchor_day_of_month: 15, period_setting: true } },
        { table: "recurring_expenses", create: "createRecurringExpense", update: "updateRecurringExpense", remove: "deleteRecurringExpense",
          input: { anchor_type: "day_of_month", anchor_day_of_month: 16, necessary: true } },
        { table: "goals", create: "createGoal", update: "updateGoal", remove: "deleteGoal",
          input: { due_date: todayInTimezone("Europe/Warsaw") } },
        { table: "flex_transactions", create: "createFlexTransaction", update: "updateFlexTransaction", remove: "deleteFlexTransaction", input: {} }
      ];
      const tracked = ["recurring_incomes", "recurring_expenses", "goals", "flex_transactions", "planned_transactions",
        "settings", "pending_transactions", "future_transactions", "projection_snapshots"];
      const capture = async () => {
        const result = {};
        for (const table of tracked) result[table] = await store.listPlanningRows("budget", table);
        return result;
      };
      for (const family of families) {
        const beforeRevision = await revision();
        const input = { name: `Atomic ${family.table}`, currency: "PLN", amount: 10, active: true, ...family.input };
        const beforeCreate = await capture();
        rejectProjection = true;
        await assert.rejects(() => mutations[family.create]("budget", input), /mutation projection rollback/);
        assert.deepEqual(await capture(), beforeCreate, family.create);
        assert.equal(await revision(), beforeRevision);
        rejectProjection = false;
        const source = await mutations[family.create]("budget", input);
        assert.equal(source._projection.projection_ok, true);
        const beforeEdit = await capture();
        rejectProjection = true;
        await assert.rejects(() => mutations[family.update]("budget", source.id, { name: "Rejected" }), /mutation projection rollback/);
        assert.deepEqual(await capture(), beforeEdit, family.update);
        await assert.rejects(() => mutations[family.remove]("budget", source.id), /mutation projection rollback/);
        assert.deepEqual(await capture(), beforeEdit, family.remove);
        assert.equal(await revision(), beforeRevision + 1);
        rejectProjection = false;
        assert.equal((await mutations[family.update]("budget", source.id, { name: "Accepted" })).name, "Accepted");
        assert.equal((await mutations[family.remove]("budget", source.id)).ok, true);
        assert.equal(await revision(), beforeRevision + 3);
      }
      const ledger = createCashflowLedgerService({ budgetStore: store });
      const confirmation = createCashflowPendingConfirmationService({ budgetStore: store,
        getConfirmedFxForDate: async () => ({ fxRate: 1, bufferedFxRate: 1 }),
        runRecoverableUserMutation: () => { throw new Error("Atomic confirmation must not restore snapshots"); },
        wouldLedgerGoNegativeAfterInsertAsync: ledger.wouldLedgerGoNegativeAfterInsertAsync,
        newestConfirmedTransactionDateAsync: async () => null,
        withProjectionStatus: coordinator.withProjectionStatus });
      const pendingIncome = { id: "atomic-income", name: "Income", amount: 50, funded_amount: 50,
        currency: "PLN", type: "income", date: todayInTimezone("Europe/Warsaw"), occurrence_key: "atomic-income",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      await store.insertPlanningRows("budget", "pending_transactions", [pendingIncome]);
      const beforeConfirmation = await capture();
      const confirmationRevision = await revision();
      const ledgerBefore = await store.listConfirmedTransactions("budget");
      rejectProjection = true;
      await assert.rejects(() => confirmation.confirmPendingTransaction("budget", pendingIncome.id), /mutation projection rollback/);
      assert.deepEqual(await capture(), beforeConfirmation);
      assert.deepEqual(await store.listConfirmedTransactions("budget"), ledgerBefore);
      assert.equal(await revision(), confirmationRevision);
      rejectProjection = false;
      const receipt = await confirmation.confirmPendingTransaction("budget", pendingIncome.id);
      assert.equal(receipt.amount, 50);
      assert.equal(receipt._projection.projection_ok, true);
      assert.equal(await revision(), confirmationRevision + 1);
      assert.equal((await store.listPlanningRows("budget", "pending_transactions")).some(row => row.id === pendingIncome.id), false);
      assert.equal((await store.listConfirmedTransactions("budget")).filter(row => row.id === pendingIncome.id).length, 1);
      // Two callers may preflight the same pending row; serialization must
      // return the accepted occurrence without a duplicate insert or restore.
      const raceIncome = { ...pendingIncome, id: "atomic-race-income", occurrence_key: "atomic-race-income" };
      await store.insertPlanningRows("budget", "pending_transactions", [raceIncome]);
      const outcomes = await Promise.allSettled([
        confirmation.confirmPendingTransaction("budget", raceIncome.id),
        confirmation.confirmPendingTransaction("budget", raceIncome.id)
      ]);
      assert.ok(outcomes.some(outcome => outcome.status === "fulfilled"));
      assert.equal((await store.listConfirmedTransactions("budget")).filter(row => row.id === raceIncome.id).length, 1);
      assert.equal(await revision(), confirmationRevision + 2);
      // Mutating pending data during the asynchronous FX phase must reject the
      // stale intent and retain both the newer source and existing ledger.
      const editedPending = { ...pendingIncome, id: "atomic-stale-income", occurrence_key: "atomic-stale-income" };
      await store.insertPlanningRows("budget", "pending_transactions", [editedPending]);
      const staleConfirmation = createCashflowPendingConfirmationService({ budgetStore: store,
        getConfirmedFxForDate: async () => {
          await store.updatePlanningRowsById("budget", "pending_transactions", [{ id: editedPending.id, amount: 70 }]);
          return { fxRate: 1, bufferedFxRate: 1 };
        }, wouldLedgerGoNegativeAfterInsertAsync: ledger.wouldLedgerGoNegativeAfterInsertAsync,
        withProjectionStatus: coordinator.withProjectionStatus });
      await assert.rejects(() => staleConfirmation.confirmPendingTransaction("budget", editedPending.id), /changed; retry/);
      assert.equal((await store.listPlanningRows("budget", "pending_transactions")).find(row => row.id === editedPending.id).amount, 70);
      assert.equal((await store.listConfirmedTransactions("budget")).some(row => row.id === editedPending.id), false);
      const settingsService = createCashflowSettingsService({ budgetStore: store,
        withProjectionStatus: coordinator.withProjectionStatus });
      const beforeSettings = await capture();
      const settingsRevision = await revision();
      rejectProjection = true;
      await assert.rejects(() => settingsService.updateSettings("budget", { future_periods: 3 }), /mutation projection rollback/);
      assert.deepEqual(await capture(), beforeSettings);
      assert.equal(await revision(), settingsRevision);
      rejectProjection = false;
      const savedSettings = await settingsService.updateSettings("budget", { future_periods: 3 });
      assert.equal(savedSettings.future_periods, 3);
      assert.equal(savedSettings._projection.projection_ok, true);
      assert.equal(await revision(), settingsRevision + 1);
      const transition = createCashflowPendingTransitionService({ budgetStore: store,
        normalizePendingStatus: state.normalizePendingStatus, withProjectionStatus: coordinator.withProjectionStatus });
      const { updated_at: _updatedAt, ...futureInput } = pendingIncome;
      await store.insertPlanningRows("budget", "future_transactions", [{ ...futureInput,
        id: "atomic-manual-future", occurrence_key: "atomic-manual-future", period: plan.futureRows[0].period,
        generation_timestamp: new Date().toISOString() }]);
      const beforeMove = await capture();
      rejectProjection = true;
      await assert.rejects(() => transition.moveFutureTransactionToPending("budget", "atomic-manual-future"), /mutation projection rollback/);
      assert.deepEqual(await capture(), beforeMove);
      assert.equal(await revision(), settingsRevision + 1);
      rejectProjection = false;
      assert.equal((await transition.moveFutureTransactionToPending("budget", "atomic-manual-future")).moved, true);
      assert.equal(await revision(), settingsRevision + 2);
      // Automatic due transitions participate too; an empty rerun is not a write.
      await store.insertPlanningRows("budget", "future_transactions", [{ ...futureInput,
        id: "atomic-scheduled-future", occurrence_key: "atomic-scheduled-future", period: plan.futureRows[0].period,
        generation_timestamp: new Date().toISOString() }]);
      assert.ok(await transition.moveDueFutureTransactionsToPending("budget", "9999-12-31") > 0);
      assert.equal(await revision(), settingsRevision + 3);
      assert.equal(await transition.moveDueFutureTransactionsToPending("budget", "9999-12-31"), 0);
      assert.equal(await revision(), settingsRevision + 3);
      await engine.regenerateProjectionsAsync("budget", store);
      assert.equal(await revision(), settingsRevision + 4);
      await store.insertPlanningRows("budget", "pending_transactions", [{ ...pendingIncome,
        id: "negative-cleanup", type: "expense", amount: 9999, ledger_amount: 9999,
        funded_amount: 9999, requested_amount: 9999, occurrence_key: "negative-cleanup", pending_origin: "projection" }]);
      await coordinator.regenerateProjectionsWithFxRefresh("budget", { refreshFxFirst: false, skipProjectionLock: true });
      assert.ok(await revision() > settingsRevision + 4);
      assert.equal((await store.listPlanningRows("budget", "pending_transactions")).some(row => row.id === "negative-cleanup"), false);
    } finally { await store.close(); }
  });
});