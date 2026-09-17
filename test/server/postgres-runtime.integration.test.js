import assert from "node:assert/strict";

import Database from "better-sqlite3";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateSqliteToPostgres } from "../../scripts/migrate-sqlite-to-postgres.mjs";
import { verifyPostgresMigration } from "../../scripts/verify-postgres-migration.mjs";
import { migratePostgresToSqlite } from "../../scripts/migrate-postgres-to-sqlite.mjs";
import { verifySqliteMigration } from "../../scripts/verify-sqlite-migration.mjs";
import { createPostgresBudgetStore, createSqliteBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createPostgresBudgetDbService } from "../../src/server/cashflow-postgres-budget-db-service.js";
import { createPostgresGlobalDbService } from "../../src/server/cashflow-postgres-global-db-service.js";
import {
  POSTGRES_BUDGET_TABLES,
  POSTGRES_LEDGER_SCHEMA_VERSION,
  POSTGRES_PLANNING_SCHEMA_VERSION
} from "../../src/server/cashflow-postgres-budget-schema.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import {
  POSTGRES_COORDINATION_TABLES,
  POSTGRES_GLOBAL_SCHEMA_VERSION,
  POSTGRES_GLOBAL_TABLES
} from "../../src/server/cashflow-postgres-global-schema.js";
import { createCashflowBackupService } from "../../src/server/cashflow-backup-service.js";
import { createCashflowBudgetService } from "../../src/server/cashflow-budget-service.js";
import { createCashflowConfirmedFxService } from "../../src/server/cashflow-confirmed-fx-service.js";
import { createCashflowDataPortabilityService } from "../../src/server/cashflow-data-portability-service.js";
import { createCashflowFxCacheService } from "../../src/server/cashflow-fx-cache-service.js";
import { createCashflowGlobalService } from "../../src/server/cashflow-global-service.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { createSqliteGlobalStore } from "../../src/server/cashflow-sqlite-global-store.js";
import {
  createCashflowStorageSnapshot,
  restoreCashflowStorageSnapshot
} from "../../src/server/cashflow-storage-snapshot.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { createCashflowLedgerService } from "../../src/server/cashflow-ledger-service.js";
import { createCashflowProjectionCoordinatorService } from "../../src/server/cashflow-projection-coordinator-service.js";
import { BUDGET_RUNTIME_LOCK_JOBS, budgetRuntimeLockName } from "../../src/server/cashflow-runtime-locks.js";
import {
  createCashflowNotificationService,
  notificationEnabled,
  notificationPriority
} from "../../src/server/cashflow-notification-service.js";
import { createCashflowPendingConfirmationService } from "../../src/server/cashflow-pending-confirmation-service.js";
import { createCashflowPendingTransitionService } from "../../src/server/cashflow-pending-transition-service.js";
import { createCashflowPlanMutationService } from "../../src/server/cashflow-plan-mutation-service.js";
import { createCashflowPredictionService } from "../../src/server/cashflow-prediction-service.js";
import { createCashflowProjectionEngineService } from "../../src/server/cashflow-projection-engine-service.js";
import { createCashflowProjectionStateService } from "../../src/server/cashflow-projection-state-service.js";
import { createCashflowSettingsService } from "../../src/server/cashflow-settings-service.js";
import { createCashflowSetupService } from "../../src/server/cashflow-setup-service.js";
import {
  initializeGlobalSchema
} from "../../src/server/cashflow-global-schema.js";
import {
  initializeLedgerSchema,
  initializePlanningSchema
} from "../../src/server/cashflow-schema.js";
import {
  postgresRuntimeTestsEnabled,
  withDisposablePostgresDb
} from "../helpers/postgres-test-db.js";

const POSTGRES_TEST_SKIP_REASON = "set CASHFLOW_ENABLE_POSTGRES_TESTS=1 and CASHFLOW_DATABASE_URL to run disposable Postgres tests";

async function withTempDirs(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "cashflow-postgres-runtime-test-"));
  const dataDir = path.join(root, "data");
  const outputDir = path.join(root, "exports");
  fs.mkdirSync(dataDir, { recursive: true });

  try {
    return await fn({ dataDir, outputDir, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createGlobalSource(dataDir) {
  const db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
  try {
    initializeGlobalSchema(db, { storageProfileIds: ["household"] });
    db.prepare(`
      INSERT INTO accounts (
        id, email, display_name, status, created_at, updated_at
      )
      VALUES (
        'alice', 'alice@example.com', 'Alice', 'active',
        '2026-01-03T04:00:00Z', '2026-01-03T04:00:00Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO budget_memberships (
        budget_id, account_id, role, created_at, updated_at
      )
      VALUES (
        'household', 'alice', 'editor',
        '2026-01-03T04:00:00Z', '2026-01-03T04:00:00Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO auth_sessions (
        id, account_id, token_hash, csrf_token_hash, selected_budget_id,
        auth_method, created_at, last_seen_at, idle_expires_at,
        absolute_expires_at
      )
      VALUES (
        'session_private', 'alice', 'secret-token-hash', 'secret-csrf-hash',
        'household', 'none', '2026-01-03T04:00:00Z',
        '2026-01-03T04:01:00Z', '2026-01-03T05:00:00Z',
        '2026-01-04T04:00:00Z'
      )
    `).run();
  } finally {
    db.close();
  }
}

function createBudgetStorageSource(dataDir) {
  const budgetDir = path.join(dataDir, "household");
  fs.mkdirSync(budgetDir, { recursive: true });

  const planning = new Database(path.join(budgetDir, "planning.sqlite"));
  try {
    initializePlanningSchema(planning);
    planning.prepare(`
      INSERT INTO one_off_transactions (
        id, name, currency, amount, type, date, created_at, updated_at
      )
      VALUES (
        'oneoff_desk', 'Desk', 'PLN', 120, 'expense', '2026-01-20',
        '2026-01-03T04:00:00Z', '2026-01-03T04:00:00Z'
      )
    `).run();
    planning.prepare(`
      INSERT INTO pending_transactions (
        id, name, currency, amount, type, date, ledger_currency, status,
        pending_origin, created_at, updated_at
      )
      VALUES (
        'pending_income', 'Pending income', 'PLN', 300, 'income',
        '2026-01-04', 'PLN', 'pending', 'manual',
        '2026-01-03T04:00:00Z', '2026-01-03T04:00:00Z'
      )
    `).run();
  } finally {
    planning.close();
  }

  const ledger = new Database(path.join(budgetDir, "ledger_2026.sqlite"));
  try {
    initializeLedgerSchema(ledger);
    ledger.prepare(`
      INSERT INTO confirmed_transactions (
        id, name, currency, amount, type, date, confirmed_date, fx_rate,
        buffered_fx_rate, ledger_currency, running_balance_pln, ledger_amount,
        occurrence_key, created_at, updated_at
      )
      VALUES (
        'confirmed_income', 'Confirmed income', 'PLN', 500, 'income',
        '2026-01-05', '2026-01-05', 1, 1, 'PLN', 500, 500,
        'manual:confirmed_income:income:2026-01-05',
        '2026-01-05T04:00:00Z', '2026-01-05T04:00:00Z'
      )
    `).run();
  } finally {
    ledger.close();
  }
}

function dateKey(value) {
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return String(value || "").slice(0, 10);
}

test("Postgres schema readiness and runtime locks work against a disposable database", {
  skip: postgresRuntimeTestsEnabled() ? false : POSTGRES_TEST_SKIP_REASON
}, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl }) => {
    const globalDb = await createPostgresGlobalDbService({ databaseUrl });
    const budgetDb = await createPostgresBudgetDbService({ databaseUrl });
    const globalStore = await createPostgresGlobalStore({ databaseUrl });
    try {
      await globalDb.initializeGlobalSchema();
      await budgetDb.initializeBudgetSchema();

      assert.deepEqual(await globalDb.checkReadiness(), {
        ok: true,
        backend: "postgres",
        globalSchemaVersion: POSTGRES_GLOBAL_SCHEMA_VERSION
      });
      assert.deepEqual(await budgetDb.checkReadiness(), {
        ok: true,
        backend: "postgres",
        ledgerSchemaVersion: POSTGRES_LEDGER_SCHEMA_VERSION,
        planningSchemaVersion: POSTGRES_PLANNING_SCHEMA_VERSION
      });

      const ownedTables = await globalDb.withClient(async client => {
        const result = await client.query(`
          SELECT tablename
          FROM pg_catalog.pg_tables
          WHERE schemaname = current_schema()
            AND tablename = ANY($1::text[])
          ORDER BY tablename
        `, [[
          "cashflow_budget_schema_version",
          "cashflow_global_schema_version",
          ...POSTGRES_BUDGET_TABLES,
          ...POSTGRES_COORDINATION_TABLES,
          ...POSTGRES_GLOBAL_TABLES
        ]]);
        return result.rows.map(row => row.tablename);
      });
      assert.equal(ownedTables.includes("accounts"), true);
      assert.equal(ownedTables.includes("confirmed_transactions"), true);
      assert.equal(ownedTables.includes("cashflow_runtime_locks"), true);

      const workerA = globalStore.createLockService({ ownerId: "postgres_runtime_test_a" });
      const workerB = globalStore.createLockService({ ownerId: "postgres_runtime_test_b" });
      assert.equal((await workerA.tryAcquire("test:postgres-runtime", { ttlMs: 10_000 })).acquired, true);
      assert.equal((await workerB.tryAcquire("test:postgres-runtime", { ttlMs: 10_000 })).acquired, false);
      assert.equal(await workerA.release("test:postgres-runtime"), 1);
      assert.equal((await workerB.tryAcquire("test:postgres-runtime", { ttlMs: 10_000 })).acquired, true);
      assert.equal(await workerB.release("test:postgres-runtime"), 1);
    } finally {
      await globalStore.close();
      await globalDb.close();
      await budgetDb.close();
    }
  });
});

test("SQLite snapshot migrates into disposable Postgres and verifies counts without live data mutation", {
  skip: postgresRuntimeTestsEnabled() ? false : POSTGRES_TEST_SKIP_REASON
}, async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      const result = await migrateSqliteToPostgres({
        databaseUrl,
        dataDir,
        dryRun: false,
        outputDir,
        sourceIsSnapshot: true
      });

      assert.equal(result.ok, true);
      assert.equal(result.applied, true);
      assert.equal(result.dryRun, false);
      assert.equal(result.inserted.budget.confirmed_transactions, 1);
      assert.equal(result.inserted.budget.pending_transactions, 1);
      assert.equal(result.inserted.global.accounts, 2);

      const verification = await verifyPostgresMigration({
        budgetExportPath: result.artifacts.budgetExportPath,
        databaseUrl,
        globalExportPath: result.artifacts.globalExportPath
      });
      assert.equal(verification.ok, true);
      assert.deepEqual(verification.mismatches, []);
      assert.equal(verification.budget.rowCounts.confirmed_transactions, 1);

      const budgetStore = await createPostgresBudgetStore({ databaseUrl });
      const globalStore = await createPostgresGlobalStore({ databaseUrl });
      try {
        assert.equal(await budgetStore.countRows("household", "one_off_transactions"), 1);
        assert.equal(await budgetStore.countRows("household", "pending_transactions"), 1);
        assert.equal(await budgetStore.countRows("household", "confirmed_transactions", {
          ledgerYear: 2026
        }), 1);
        assert.deepEqual(await budgetStore.listLedgerYears("household"), [2026]);

        const accounts = await globalStore.listRows("accounts");
        assert.equal(accounts.length, 2);
        assert.equal(accounts.some(account => account.id === "alice"), true);

        await budgetStore.insertPlanningRows("household", "notification_queue", [
          {
            dedupe_key: "postgres-notification-a",
            id: "postgres-notification-a",
            message: "First notification",
            notification_type: "pending_summary",
            priority: "default",
            queued_at: "2026-01-05T00:00:00Z",
            title: "First"
          },
          {
            dedupe_key: "postgres-notification-b",
            id: "postgres-notification-b",
            message: "Second notification",
            notification_type: "pending_summary",
            priority: "default",
            queued_at: "2026-01-05T00:00:01Z",
            title: "Second"
          }
        ]);

        let releaseFirstClaim = () => {};
        const firstClaimRelease = new Promise(resolve => {
          releaseFirstClaim = resolve;
        });
        let resolveFirstClaimed = () => {};
        const firstClaimed = new Promise(resolve => {
          resolveFirstClaimed = resolve;
        });

        const firstTransaction = budgetStore.transaction(async writer => {
          const rows = await writer.claimUnsentNotifications("household", { limit: 1 });
          resolveFirstClaimed(rows);
          await firstClaimRelease;
          await writer.markNotificationsSent(
            "household",
            rows.map(row => row.id),
            "2026-01-05T00:01:00Z"
          );
          return rows;
        });

        const firstRows = await firstClaimed;
        assert.deepEqual(firstRows.map(row => row.id), ["postgres-notification-a"]);

        const secondRows = await budgetStore.transaction(async writer =>
          await writer.claimUnsentNotifications("household", { limit: 2 })
        );
        assert.deepEqual(secondRows.map(row => row.id), ["postgres-notification-b"]);

        releaseFirstClaim();
        const completedFirstRows = await firstTransaction;
        assert.deepEqual(completedFirstRows.map(row => row.id), ["postgres-notification-a"]);
        const notificationRows = await budgetStore.listPlanningRows("household", "notification_queue");
        assert.equal(
          notificationRows.find(row => row.id === "postgres-notification-a")?.sent_at instanceof Date
            || Boolean(notificationRows.find(row => row.id === "postgres-notification-a")?.sent_at),
          true
        );

        await budgetStore.updatePlanningRowsById("household", "settings", [{
          discord_webhook_url: "https://discord.example.test/api/webhooks/test",
          id: 1,
          notification_channel: "discord"
        }]);
        const sentCalls = [];
        let generatedNotificationCount = 0;
        const notifications = createCashflowNotificationService({
          budgetStore,
          fetchImpl: async (url, options) => {
            sentCalls.push({ url, options });
            return { ok: true, status: 204, statusText: "No Content" };
          },
          generateId: prefix => `${prefix}_test_${++generatedNotificationCount}`,
          listLedgerYears: () => [],
          openLedgerDb: () => {
            throw new Error("Postgres notification path must not open SQLite ledger files");
          },
          openPlanningDb: () => {
            throw new Error("Postgres notification path must not open SQLite planning files");
          }
        });

        assert.equal(await notifications.sendQueuedNotifications("household"), 1);
        assert.deepEqual(sentCalls.map(call => call.url), [
          "https://discord.example.test/api/webhooks/test"
        ]);
        const afterServiceRows = await budgetStore.listPlanningRows("household", "notification_queue");
        assert.equal(
          afterServiceRows.find(row => row.id === "postgres-notification-b")?.sent_at instanceof Date
            || Boolean(afterServiceRows.find(row => row.id === "postgres-notification-b")?.sent_at),
          true
        );

        const pendingConfirmation = createCashflowPendingConfirmationService({
          budgetStore,
          deletePendingOccurrence: () => {
            throw new Error("Postgres pending confirmation path must not delete through SQLite");
          },
          findConfirmedOccurrence: () => {
            throw new Error("Postgres pending confirmation path must not search SQLite ledgers");
          },
          getConfirmedFxForDate: async () => ({
            bufferedFxRate: 1,
            fxRate: 1
          }),
          newestConfirmedTransactionDate: () => {
            throw new Error("Postgres pending confirmation path must not read SQLite ledger dates");
          },
          newestConfirmedTransactionDateAsync: async budgetId => {
            const rows = await budgetStore.listConfirmedTransactions(budgetId);
            return rows.reduce((newest, row) =>
              row.date && (!newest || row.date > newest) ? row.date : newest,
            null);
          },
          openLedgerDb: () => {
            throw new Error("Postgres pending confirmation path must not open SQLite ledger files");
          },
          openPlanningDb: () => {
            throw new Error("Postgres pending confirmation path must not open SQLite planning files");
          },
          recalculateLedgerRunningBalance: () => {
            throw new Error("Postgres pending confirmation path recalculates through the budget store");
          },
          runRecoverableUserMutation: async (_budgetId, _operation, work) => await work(),
          withProjectionStatus: (_budgetId, result) => result,
          wouldLedgerGoNegativeAfterInsert: () => {
            throw new Error("Postgres pending confirmation path must not use SQLite balance checks");
          },
          wouldLedgerGoNegativeAfterInsertAsync: async () => false
        });

        const confirmed = await pendingConfirmation.confirmPendingTransaction("household", "pending_income", {
          confirmed_date: "2026-01-06"
        });
        assert.equal(confirmed.id, "pending_income");
        assert.equal(confirmed.running_balance_pln, 800);
        assert.equal(
          (await budgetStore.listPlanningRows("household", "pending_transactions"))
            .some(row => row.id === "pending_income"),
          false
        );
        assert.equal(
          (await budgetStore.listConfirmedTransactions("household"))
            .some(row => row.id === "pending_income"),
          true
        );

        await budgetStore.insertPlanningRows("household", "future_transactions", [{
          amount: 125,
          buffered_fx_rate: 1,
          created_at: "2026-01-06T05:00:00Z",
          currency: "PLN",
          date: "2026-01-07",
          funded_amount: 125,
          fx_rate: 1,
          generation_timestamp: "2026-01-06T05:00:00Z",
          id: "future_postgres_transition",
          ledger_amount: 125,
          ledger_currency: "PLN",
          name: "Future Postgres Transition",
          occurrence_key: "manual:future_postgres_transition:expense:2026-01-07",
          period: "2026-01",
          requested_amount: 125,
          status: "funded",
          type: "expense"
        }]);
        const pendingTransition = createCashflowPendingTransitionService({
          budgetStore,
          normalizePendingStatus: status => status === "partial" || status === "underfunded" ? status : "pending",
          openPlanningDb: () => {
            throw new Error("Postgres pending transition path must not open SQLite planning files");
          },
          recalculatePlanningRunningBalances: () => {
            throw new Error("Postgres pending transition path recalculates through the budget store");
          },
          withProjectionStatus: (_budgetId, result) => result
        });

        const moved = await pendingTransition.moveFutureTransactionToPending(
          "household",
          "future_postgres_transition"
        );
        assert.equal(moved.moved, true);
        assert.equal(moved.futureTransactionId, "future_postgres_transition");
        assert.equal(
          (await budgetStore.listPlanningRows("household", "future_transactions"))
            .some(row => row.id === "future_postgres_transition"),
          false
        );
        const movedPending = (await budgetStore.listPlanningRows("household", "pending_transactions"))
          .find(row => row.occurrence_key === "manual:future_postgres_transition:expense:2026-01-07");
        assert.equal(Boolean(movedPending), true);
        assert.equal(movedPending.pending_origin, "manual");
        assert.equal(Number(movedPending.running_balance), 675);

        const pendingSummaryCount = await notifications.queueDailyPendingSummary("household");
        assert.equal(pendingSummaryCount, 1);

        await budgetStore.insertPlanningRows("household", "recurring_incomes", [{
          active: true,
          amount: 1000,
          anchor_business_day_adjustment: "none",
          anchor_day_of_month: 1,
          anchor_holiday_country: "PL",
          anchor_offset_days: 0,
          anchor_type: "day_of_month",
          created_at: "2026-01-06T05:00:00Z",
          currency: "PLN",
          id: "income_missing_postgres",
          name: "Missing Postgres Income",
          period_setting: false,
          prediction_min_recorded_months: 6,
          prediction_strategy: "fixed",
          prediction_substitute_missing: "none",
          repeat_every_months: 1,
          start_month_year: null,
          updated_at: "2026-01-06T05:00:00Z"
        }]);
        const missingIncomeCount = await notifications.queueMissingIncomeNotifications("household");
        assert.equal(missingIncomeCount, 1);

        const queuedNotifications = await budgetStore.listPlanningRows("household", "notification_queue");
        assert.equal(
          queuedNotifications.some(row => row.notification_type === "pending_summary"),
          true
        );
        assert.equal(
          queuedNotifications.some(row =>
            row.notification_type === "income_missing"
            && row.entity_id === "income_missing_postgres"
          ),
          true
        );

        await budgetStore.updatePlanningRowsById("household", "settings", [{
          fx_provider: "manual",
          id: 1,
          manual_fx_rates: JSON.stringify({
            "EUR/PLN": 4.2,
            "USD/PLN": 3.9
          })
        }]);
        const manualFxCache = createCashflowFxCacheService({
          budgetStore,
          fetchImpl: async () => {
            throw new Error("Manual Postgres FX refresh must not call the network");
          },
          getCurrentFxSnapshot: () => null,
          listCashflowUserIds: () => ["household"],
          logCashflowError: () => {},
          logError: () => {},
          logServerEvent: () => {},
          normalizeCurrency: currency => String(currency || "PLN").toUpperCase(),
          openPlanningDb: () => {
            throw new Error("Postgres FX refresh path must not open SQLite planning files");
          },
          regenerateProjectionsAfterMutation: () => ({ projection_ok: true })
        });
        const manualRefresh = await manualFxCache.refreshNbpFxCacheForUser("household", "2026-01-08");
        assert.equal(manualRefresh.updated_count, 2);
        const manualFxRows = await budgetStore.listPlanningRows("household", "fx_rates_cache");
        assert.equal(
          manualFxRows.some(row =>
            row.base_currency === "EUR"
            && row.quote_currency === "PLN"
            && Number(row.rate) === 4.2
          ),
          true
        );

        await budgetStore.updatePlanningRowsById("household", "settings", [{
          fx_provider: "frankfurter",
          fx_used_currencies: JSON.stringify(["GBP"]),
          id: 1,
          manual_fx_rates: "{}"
        }]);
        const frankfurterFxCache = createCashflowFxCacheService({
          budgetStore,
          fetchImpl: async url => {
            assert.equal(String(url).includes("from=GBP"), true);
            return {
              json: async () => ({
                date: "2026-01-09",
                rates: {
                  PLN: 4.33
                }
              }),
              ok: true,
              status: 200,
              statusText: "OK"
            };
          },
          getCurrentFxSnapshot: () => null,
          listCashflowUserIds: () => ["household"],
          logCashflowError: () => {},
          logError: () => {},
          logServerEvent: () => {},
          normalizeCurrency: currency => String(currency || "PLN").toUpperCase(),
          openPlanningDb: () => {
            throw new Error("Postgres FX mutation path must not open SQLite planning files");
          },
          regenerateProjectionsAfterMutation: () => ({ projection_ok: true })
        });
        const ensuredFx = await frankfurterFxCache.ensureFxCacheForMutation("household", {
          currency: "GBP"
        });
        assert.equal(ensuredFx.refreshed, true);
        const frankfurterFxRows = await budgetStore.listPlanningRows("household", "fx_rates_cache");
        assert.equal(
          frankfurterFxRows.some(row =>
            row.base_currency === "GBP"
            && row.quote_currency === "PLN"
            && Number(row.rate) === 4.33
          ),
          true
        );

        const confirmedFx = createCashflowConfirmedFxService({
          fetchProviderRate: async (_provider, currency, confirmedDate, quoteCurrency) => ({
            baseCurrency: currency,
            currency,
            effectiveDate: confirmedDate,
            quoteCurrency,
            rate: 4.44,
            source: "test-postgres-confirmed-fx"
          }),
          fetchNbpRate: async () => {
            throw new Error("Postgres confirmed FX path should use provider-aware fetch");
          },
          getCachedFxRate: () => {
            throw new Error("Postgres confirmed FX path must not use sync SQLite cache reads");
          },
          getCachedFxRateAsync: frankfurterFxCache.getCachedFxRateAsync,
          getFxProviderSettings: () => {
            throw new Error("Postgres confirmed FX path must not use sync SQLite settings reads");
          },
          getFxProviderSettingsAsync: frankfurterFxCache.getFxProviderSettingsAsync,
          getFxSnapshotForDate: null,
          upsertFxCacheRate: () => {
            throw new Error("Postgres confirmed FX path must not use sync SQLite cache writes");
          },
          upsertFxCacheRateAsync: frankfurterFxCache.upsertFxCacheRateAsync
        });
        const confirmedFxResult = await confirmedFx.getConfirmedFxForDate(
          "EUR",
          "2026-01-07",
          { ledger_currency: "PLN" },
          {},
          "household"
        );
        assert.equal(confirmedFxResult.fxRate, 4.44);
        const confirmedFxRows = await budgetStore.listPlanningRows("household", "fx_rates_cache");
        const confirmedFxRow = confirmedFxRows.find(row =>
          row.base_currency === "EUR"
          && row.quote_currency === "PLN"
          && dateKey(row.rate_date) === "2026-01-07"
        );
        assert.ok(confirmedFxRow, "expected confirmed FX lookup to cache the fetched pair/date rate");
        assert.equal(Number(confirmedFxRow.rate), 4.44);
        assert.equal(
          confirmedFxRows.some(row =>
            row.base_currency === "EUR"
            && row.quote_currency === "PLN"
            && dateKey(row.rate_date) === "2026-01-07"
            && Number(row.rate) === 4.44
          ),
          true
        );

        await budgetStore.insertConfirmedTransactions("household", [
          {
            amount: 1000,
            buffered_fx_rate: 1,
            confirmed_date: "2024-01-10",
            created_at: "2024-01-10T00:00:00.000Z",
            currency: "PLN",
            date: "2024-01-10",
            fx_rate: 1,
            id: "old_income_for_compaction",
            ledger_amount: 1000,
            ledger_currency: "PLN",
            ledger_year: 2024,
            name: "Old income for compaction",
            occurrence_key: "manual:old_income_for_compaction:income:2024-01-10",
            running_balance_pln: 1000,
            type: "income",
            updated_at: "2024-01-10T00:00:00.000Z"
          },
          {
            amount: 250,
            buffered_fx_rate: 1,
            confirmed_date: "2024-02-10",
            created_at: "2024-02-10T00:00:00.000Z",
            currency: "PLN",
            date: "2024-02-10",
            fx_rate: 1,
            id: "old_expense_for_compaction",
            ledger_amount: 250,
            ledger_currency: "PLN",
            ledger_year: 2024,
            name: "Old expense for compaction",
            occurrence_key: "manual:old_expense_for_compaction:expense:2024-02-10",
            running_balance_pln: 750,
            type: "expense",
            updated_at: "2024-02-10T00:00:00.000Z"
          }
        ]);
        let generatedCompactionCount = 0;
        const ledgerService = createCashflowLedgerService({
          budgetStore,
          generateId: prefix => `${prefix}_postgres_${++generatedCompactionCount}`,
          listLedgerYears: () => {
            throw new Error("Postgres ledger compaction path must not list SQLite ledger years");
          },
          openLedgerDb: () => {
            throw new Error("Postgres ledger compaction path must not open SQLite ledgers");
          },
          openPlanningDb: () => {
            throw new Error("Postgres ledger compaction path must not open SQLite planning storage");
          }
        });
        const compactionPlan = await ledgerService.historicalLedgerCompactionPlanAsync("household", {
          months: 12,
          today: "2026-05-20"
        });
        assert.equal(compactionPlan.needsCompaction, true);
        assert.equal(compactionPlan.eligibleRows, 2);
        const compaction = await ledgerService.compactHistoricalLedgerAsync("household", {
          months: 12,
          now: "2026-05-20T00:00:00.000Z",
          plan: compactionPlan
        });
        assert.equal(compaction.compactedRows, 2);
        assert.equal(compaction.createdRows, 1);
        const compactedConfirmedRows = await budgetStore.listConfirmedTransactions("household");
        assert.equal(
          compactedConfirmedRows.some(row => row.id === "old_income_for_compaction"),
          false
        );
        const compactedRow = compactedConfirmedRows.find(row =>
          row.occurrence_key === "ledger_history_compaction:PLN:2025-05-20"
        );
        assert.ok(compactedRow, "expected compacted historical balance row");
        assert.equal(Number(compactedRow.amount), 750);
        assert.equal(Number(compactedRow.running_balance_pln), 750);
        assert.equal(
          Number(compactedConfirmedRows.find(row => row.id === "confirmed_income")?.running_balance_pln),
          1250
        );

        const setupService = createCashflowSetupService({
          budgetStore,
          hasAnyConfirmedTransactionsAsync: async () => false,
          normalizeLocale: value => String(value || "en"),
          openPlanningDb: () => {
            throw new Error("Postgres setup path must not open SQLite planning storage");
          },
          regenerateProjectionsAfterMutation: async () => ({ projection_ok: true })
        });
        assert.equal(await setupService.setupRequiredAsync("household"), true);
        const setupResult = await setupService.completeSetup("household", {
          currency: "EUR",
          future_periods: 6,
          holiday_country: "DE",
          income_anchor_day: 15,
          income_amount: 2200,
          income_enabled: true,
          income_name: "Salary",
          locale: "en",
          opening_balance: 150,
          timezone: "Europe/Berlin"
        });
        assert.equal(setupResult.ok, true);
        assert.equal(setupResult.settings.setup_completed, true);
        assert.equal(setupResult.settings.ledger_currency, "EUR");
        assert.equal(Boolean(setupResult.created.openingBalanceId), true);
        assert.equal(Boolean(setupResult.created.incomeId), true);
        const setupPendingRows = await budgetStore.listPlanningRows("household", "pending_transactions");
        assert.equal(
          setupPendingRows.some(row =>
            row.id === setupResult.created.openingBalanceId
            && row.currency === "EUR"
            && Number(row.amount) === 150
            && row.pending_origin === "system"
          ),
          true
        );
        const setupIncomeRows = await budgetStore.listPlanningRows("household", "recurring_incomes");
        assert.equal(
          setupIncomeRows.some(row =>
            row.id === setupResult.created.incomeId
            && row.currency === "EUR"
            && Number(row.amount) === 2200
            && row.period_setting === true
          ),
          true
        );

        await budgetStore.insertConfirmedTransactions("household", [{
          amount: 300,
          buffered_fx_rate: 1,
          confirmed_date: "2026-03-15",
          created_at: "2026-03-15T00:00:00.000Z",
          currency: "EUR",
          date: "2026-03-15",
          fx_rate: 1,
          id: "confirmed_eur_projection_state",
          ledger_amount: 300,
          ledger_currency: "EUR",
          ledger_year: 2026,
          name: "Confirmed EUR projection state",
          occurrence_key: "manual:confirmed_eur_projection_state:income:2026-03-15",
          running_balance_pln: 300,
          type: "income",
          updated_at: "2026-03-15T00:00:00.000Z"
        }]);
        await budgetStore.insertPlanningRows("household", "future_transactions", [{
          amount: 40,
          buffered_fx_rate: 1,
          created_at: "2026-03-16T00:00:00.000Z",
          currency: "EUR",
          date: "2999-01-02",
          funded_amount: 40,
          fx_rate: 1,
          generation_timestamp: "2026-03-16T00:00:00.000Z",
          id: "future_eur_projection_state",
          ledger_amount: 40,
          ledger_currency: "EUR",
          name: "Future EUR projection state",
          occurrence_key: "manual:future_eur_projection_state:expense:2999-01-02",
          period: "2999-01",
          requested_amount: 40,
          status: "funded",
          type: "expense"
        }]);
        const projectionState = createCashflowProjectionStateService({
          budgetStore,
          latestConfirmedBalance: () => {
            throw new Error("Postgres projection-state path must not read SQLite balances");
          },
          listLedgerYears: () => {
            throw new Error("Postgres projection-state path must not list SQLite ledger years");
          },
          loadAllConfirmedTransactions: () => {
            throw new Error("Postgres projection-state path must not read SQLite ledgers");
          },
          openLedgerDb: () => {
            throw new Error("Postgres projection-state path must not open SQLite ledgers");
          }
        });
        assert.equal(await projectionState.confirmedBalanceAsOfAsync("household", "2026-04-01"), 300);
        assert.equal(await projectionState.pendingNetBalanceAsync("household"), 150);
        assert.equal(await projectionState.planningOpeningBalanceAsync("household"), 450);
        assert.deepEqual(
          (await projectionState.confirmedRowsAfterDateAsync("household", "2026-04-01")).map(row => row.id),
          []
        );
        const projectionBalance = await projectionState.recalculatePlanningRunningBalancesAsync("household");
        assert.equal(projectionBalance.plan.ledgerCurrency, "EUR");
        const projectionPendingRows = await budgetStore.listPlanningRows("household", "pending_transactions");
        assert.equal(
          Number(projectionPendingRows.find(row => row.id === setupResult.created.openingBalanceId)?.running_balance),
          450
        );
        assert.equal(
          Number((await budgetStore.listPlanningRows("household", "future_transactions"))
            .find(row => row.id === "future_eur_projection_state")?.running_balance),
          410
        );

        const settingsService = createCashflowSettingsService({
          budgetStore,
          fetchProviderRate: async () => {
            throw new Error("Postgres settings test uses manual FX and must not fetch provider rates");
          },
          latestConfirmedBalance: () => {
            throw new Error("Postgres settings path must not use sync SQLite confirmed balances");
          },
          normalizeLocale: value => String(value || "en").trim().toLowerCase(),
          openPlanningDb: () => {
            throw new Error("Postgres settings path must not open SQLite planning storage");
          },
          recalculatePlanningRunningBalances: () => {
            throw new Error("Postgres settings path recalculates through the budget store");
          },
          recalculatePlanningRunningBalancesAsync: projectionState.recalculatePlanningRunningBalancesAsync
        });

        const planMutations = createCashflowPlanMutationService({
          budgetStore,
          listLedgerYears: () => {
            throw new Error("Postgres one-off mutation path must not list SQLite ledger years");
          },
          loadAllConfirmedTransactions: () => {
            throw new Error("Postgres one-off mutation path must not read SQLite confirmed rows");
          },
          newestConfirmedTransactionDate: () => {
            throw new Error("Postgres one-off mutation path must not read SQLite ledger dates");
          },
          normalizeRecurringInput: projectionState.normalizeRecurringInput,
          openLedgerDb: () => {
            throw new Error("Postgres one-off mutation path must not open SQLite ledgers");
          },
          openPlanningDb: () => {
            throw new Error("Postgres one-off mutation path must not open SQLite planning storage");
          },
          recalculatePlanningRunningBalances: () => {
            throw new Error("Postgres one-off mutation path recalculates through the budget store");
          },
          requireStartMonthYearIfNeeded: projectionState.requireStartMonthYearIfNeeded,
          runRecoverableUserMutation: async () => {
            throw new Error("Postgres one-off delete path should use one store transaction");
          },
          withProjectionStatus: (_budgetId, result) => ({
            ...result,
            _projection: { projection_ok: true }
          })
        });
        const recurringExpense = await planMutations.createRecurringExpense("household", {
          amount: 55,
          currency: "EUR",
          name: "Postgres recurring expense",
          necessary: 1,
          priority: 1
        });
        assert.equal(recurringExpense.name, "Postgres recurring expense");
        assert.equal(Number(recurringExpense.amount), 55);
        assert.equal(recurringExpense.necessary, true);
        assert.equal(recurringExpense.priority, 1);
        const updatedRecurringExpense = await planMutations.updateRecurringExpense(
          "household",
          recurringExpense.id,
          {
            amount: 65,
            name: "Postgres recurring expense updated",
            necessary: 0
          }
        );
        assert.equal(updatedRecurringExpense.name, "Postgres recurring expense updated");
        assert.equal(Number(updatedRecurringExpense.amount), 65);
        assert.equal(updatedRecurringExpense.necessary, false);
        await budgetStore.insertPlanningRows("household", "pending_transactions", [{
          amount: 15,
          buffered_fx_rate: 1,
          created_at: "2026-03-20T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-05",
          funded_amount: 15,
          fx_rate: 1,
          id: "pending_postgres_rec_exp_delete",
          ledger_amount: 15,
          ledger_currency: "EUR",
          name: "Pending Postgres recurring expense delete",
          occurrence_key: `recurring_expense:${recurringExpense.id}:2026-04-05`,
          pending_origin: "projection",
          requested_amount: 15,
          source_recurring_expense_id: recurringExpense.id,
          status: "pending",
          type: "expense",
          updated_at: "2026-03-20T00:00:00.000Z"
        }]);
        await budgetStore.insertPlanningRows("household", "future_transactions", [{
          amount: 20,
          buffered_fx_rate: 1,
          created_at: "2026-03-20T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-12",
          funded_amount: 20,
          fx_rate: 1,
          generation_timestamp: "2026-03-20T00:00:00.000Z",
          id: "future_postgres_rec_exp_delete",
          ledger_amount: 20,
          ledger_currency: "EUR",
          name: "Future Postgres recurring expense delete",
          occurrence_key: `recurring_expense:${recurringExpense.id}:2026-04-12`,
          period: "2026-04",
          requested_amount: 20,
          source_recurring_expense_id: recurringExpense.id,
          status: "funded",
          type: "expense"
        }]);
        await budgetStore.insertConfirmedTransactions("household", [{
          amount: 55,
          buffered_fx_rate: 1,
          confirmed_date: "2026-03-25",
          created_at: "2026-03-25T00:00:00.000Z",
          currency: "EUR",
          date: "2026-03-25",
          fx_rate: 1,
          id: "confirmed_postgres_rec_exp_delete",
          ledger_amount: 55,
          ledger_currency: "EUR",
          ledger_year: 2026,
          name: "Confirmed Postgres recurring expense delete",
          occurrence_key: "recurring_expense:postgres-delete:expense:2026-03-25",
          running_balance_pln: 355,
          source_recurring_expense_id: recurringExpense.id,
          type: "expense",
          updated_at: "2026-03-25T00:00:00.000Z"
        }]);
        const deletedRecurringExpense = await planMutations.deleteRecurringExpense(
          "household",
          recurringExpense.id
        );
        assert.equal(deletedRecurringExpense.ok, true);
        assert.equal(
          (await budgetStore.listPlanningRows("household", "recurring_expenses"))
            .some(row => row.id === recurringExpense.id),
          false
        );
        assert.equal(
          (await budgetStore.listPlanningRows("household", "pending_transactions"))
            .some(row => row.id === "pending_postgres_rec_exp_delete"),
          false
        );
        assert.equal(
          (await budgetStore.listPlanningRows("household", "future_transactions"))
            .some(row => row.id === "future_postgres_rec_exp_delete"),
          false
        );
        assert.equal(
          (await budgetStore.listConfirmedTransactions("household"))
            .find(row => row.id === "confirmed_postgres_rec_exp_delete")?.source_recurring_expense_id,
          recurringExpense.id
        );

        const recurringIncome = await planMutations.createRecurringIncome("household", {
          amount: 900,
          currency: "EUR",
          name: "Postgres recurring income",
          period_setting: 1
        });
        assert.equal(recurringIncome.name, "Postgres recurring income");
        assert.equal(recurringIncome.period_setting, true);
        assert.equal(
          (await budgetStore.listPlanningRows("household", "settings"))?.[0]?.budget_period_income_id,
          recurringIncome.id
        );
        const updatedRecurringIncome = await planMutations.updateRecurringIncome(
          "household",
          recurringIncome.id,
          {
            amount: 950,
            name: "Postgres recurring income updated",
            period_setting: 0
          }
        );
        assert.equal(updatedRecurringIncome.name, "Postgres recurring income updated");
        assert.equal(updatedRecurringIncome.period_setting, false);
        assert.equal(
          (await budgetStore.listPlanningRows("household", "settings"))?.[0]?.budget_period_income_id,
          null
        );
        await planMutations.updateRecurringIncome("household", recurringIncome.id, { period_setting: 1 });
        const settingsUpdate = await settingsService.updateSettings("household", {
          budget_period_income_id: recurringIncome.id,
          locale: "pl",
          minimum_reserve_enabled: 1,
          minimum_reserve_amount: 25
        });
        assert.equal(settingsUpdate.locale, "pl");
        assert.equal(settingsUpdate.minimum_reserve_enabled, true);
        assert.equal(Number(settingsUpdate.minimum_reserve_amount), 25);
        assert.equal(settingsUpdate.budget_period_income_id, recurringIncome.id);
        assert.deepEqual(
          (await budgetStore.listPlanningRows("household", "recurring_incomes"))
            .filter(row => row.period_setting)
            .map(row => row.id),
          [recurringIncome.id]
        );

        await budgetStore.insertPlanningRows("household", "pending_transactions", [{
          amount: 900,
          buffered_fx_rate: 1,
          created_at: "2026-03-26T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-01",
          funded_amount: 900,
          fx_rate: 1,
          id: "pending_postgres_rec_inc_delete",
          ledger_amount: 900,
          ledger_currency: "EUR",
          name: "Pending Postgres recurring income delete",
          occurrence_key: `recurring_income:${recurringIncome.id}:2026-04-01`,
          pending_origin: "projection",
          requested_amount: 900,
          source_recurring_income_id: recurringIncome.id,
          status: "pending",
          type: "income",
          updated_at: "2026-03-26T00:00:00.000Z"
        }]);
        await budgetStore.insertPlanningRows("household", "future_transactions", [{
          amount: 900,
          buffered_fx_rate: 1,
          created_at: "2026-03-26T00:00:00.000Z",
          currency: "EUR",
          date: "2026-05-01",
          funded_amount: 900,
          fx_rate: 1,
          generation_timestamp: "2026-03-26T00:00:00.000Z",
          id: "future_postgres_rec_inc_delete",
          ledger_amount: 900,
          ledger_currency: "EUR",
          name: "Future Postgres recurring income delete",
          occurrence_key: `recurring_income:${recurringIncome.id}:2026-05-01`,
          period: "2026-05",
          requested_amount: 900,
          source_recurring_income_id: recurringIncome.id,
          status: "funded",
          type: "income"
        }]);
        await budgetStore.insertConfirmedTransactions("household", [{
          amount: 900,
          buffered_fx_rate: 1,
          confirmed_date: "2026-03-28",
          created_at: "2026-03-28T00:00:00.000Z",
          currency: "EUR",
          date: "2026-03-28",
          fx_rate: 1,
          id: "confirmed_postgres_rec_inc_delete",
          ledger_amount: 900,
          ledger_currency: "EUR",
          ledger_year: 2026,
          name: "Confirmed Postgres recurring income delete",
          occurrence_key: "recurring_income:postgres-delete:income:2026-03-28",
          running_balance_pln: 1255,
          source_recurring_income_id: recurringIncome.id,
          type: "income",
          updated_at: "2026-03-28T00:00:00.000Z"
        }]);
        const deletedRecurringIncome = await planMutations.deleteRecurringIncome(
          "household",
          recurringIncome.id
        );
        assert.equal(deletedRecurringIncome.ok, true);
        assert.equal(
          (await budgetStore.listPlanningRows("household", "recurring_incomes"))
            .some(row => row.id === recurringIncome.id),
          false
        );
        assert.equal(
          (await budgetStore.listPlanningRows("household", "settings"))?.[0]?.budget_period_income_id,
          null
        );
        assert.equal(
          (await budgetStore.listConfirmedTransactions("household"))
            .find(row => row.id === "confirmed_postgres_rec_inc_delete")?.source_recurring_income_id,
          recurringIncome.id
        );

        const createdFlex = await planMutations.createFlexTransaction("household", {
          active: 1,
          allow_split: 1,
          amount: 75,
          currency: "EUR",
          max_amount: 80,
          min_amount: 20,
          name: "Postgres flex",
          priority: 1
        });
        assert.equal(createdFlex.name, "Postgres flex");
        assert.equal(Number(createdFlex.amount), 75);
        assert.equal(createdFlex.priority, 1);
        assert.equal(createdFlex._projection.projection_ok, true);
        const updatedFlex = await planMutations.updateFlexTransaction("household", createdFlex.id, {
          amount: 65,
          max_amount: 70,
          min_amount: 15,
          name: "Postgres flex updated"
        });
        assert.equal(updatedFlex.name, "Postgres flex updated");
        assert.equal(Number(updatedFlex.amount), 65);
        assert.equal(Number(updatedFlex.min_amount), 15);
        assert.equal(Number(updatedFlex.max_amount), 70);
        await budgetStore.insertPlanningRows("household", "pending_transactions", [{
          amount: 15,
          buffered_fx_rate: 1,
          created_at: "2026-04-01T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-15",
          funded_amount: 15,
          fx_rate: 1,
          id: "pending_postgres_flex_delete",
          ledger_amount: 15,
          ledger_currency: "EUR",
          name: "Pending Postgres flex delete",
          occurrence_key: `flex:${createdFlex.id}:2026-04-15`,
          pending_origin: "projection",
          requested_amount: 15,
          source_flex_id: createdFlex.id,
          status: "pending",
          type: "expense",
          updated_at: "2026-04-01T00:00:00.000Z"
        }]);
        await budgetStore.insertPlanningRows("household", "future_transactions", [{
          amount: 20,
          buffered_fx_rate: 1,
          created_at: "2026-04-01T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-20",
          funded_amount: 20,
          fx_rate: 1,
          generation_timestamp: "2026-04-01T00:00:00.000Z",
          id: "future_postgres_flex_delete",
          ledger_amount: 20,
          ledger_currency: "EUR",
          name: "Future Postgres flex delete",
          occurrence_key: `flex:${createdFlex.id}:2026-04-20`,
          period: "2026-04",
          requested_amount: 20,
          source_flex_id: createdFlex.id,
          status: "funded",
          type: "expense"
        }]);
        const deletedFlex = await planMutations.deleteFlexTransaction("household", createdFlex.id);
        assert.equal(deletedFlex.ok, true);
        assert.equal(
          (await budgetStore.listPlanningRows("household", "flex_transactions"))
            .some(row => row.id === createdFlex.id),
          false
        );
        assert.equal(
          (await budgetStore.listPlanningRows("household", "pending_transactions"))
            .some(row => row.id === "pending_postgres_flex_delete"),
          false
        );
        assert.equal(
          (await budgetStore.listPlanningRows("household", "future_transactions"))
            .some(row => row.id === "future_postgres_flex_delete"),
          false
        );
        const confirmedFlex = await planMutations.createFlexTransaction("household", {
          amount: 25,
          currency: "EUR",
          name: "Postgres confirmed flex"
        });
        await budgetStore.insertConfirmedTransactions("household", [{
          amount: 25,
          buffered_fx_rate: 1,
          confirmed_date: "2026-04-09",
          created_at: "2026-04-09T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-09",
          fx_rate: 1,
          id: "confirmed_postgres_flex",
          ledger_amount: 25,
          ledger_currency: "EUR",
          ledger_year: 2026,
          name: "Confirmed Postgres flex",
          occurrence_key: "flex:postgres-confirmed:expense:2026-04-09",
          running_balance_pln: 250,
          source_flex_id: confirmedFlex.id,
          type: "expense",
          updated_at: "2026-04-09T00:00:00.000Z"
        }]);
        await assert.rejects(
          () => planMutations.deleteFlexTransaction("household", confirmedFlex.id),
          /Cannot delete confirmed flex transaction/
        );

        const createdGoal = await planMutations.createGoal("household", {
          amount: 120,
          currency: "EUR",
          due_date: "2026-05-30",
          name: "Postgres goal",
          priority: 1
        });
        assert.equal(createdGoal.name, "Postgres goal");
        assert.equal(Number(createdGoal.amount), 120);
        assert.equal(createdGoal.priority, 1);
        const updatedGoal = await planMutations.updateGoal("household", createdGoal.id, {
          amount: 110,
          due_date: "2026-05-31",
          name: "Postgres goal updated"
        });
        assert.equal(updatedGoal.name, "Postgres goal updated");
        assert.equal(Number(updatedGoal.amount), 110);
        assert.equal(updatedGoal.due_date, "2026-05-31");
        await budgetStore.insertPlanningRows("household", "pending_transactions", [{
          amount: 10,
          buffered_fx_rate: 1,
          created_at: "2026-04-10T00:00:00.000Z",
          currency: "EUR",
          date: "2026-05-01",
          funded_amount: 10,
          fx_rate: 1,
          id: "pending_postgres_goal_delete",
          ledger_amount: 10,
          ledger_currency: "EUR",
          name: "Pending Postgres goal delete",
          occurrence_key: `goal:${createdGoal.id}:2026-05-01`,
          pending_origin: "projection",
          requested_amount: 10,
          source_goal_id: createdGoal.id,
          status: "pending",
          type: "expense",
          updated_at: "2026-04-10T00:00:00.000Z"
        }]);
        await budgetStore.insertPlanningRows("household", "future_transactions", [{
          amount: 20,
          buffered_fx_rate: 1,
          created_at: "2026-04-10T00:00:00.000Z",
          currency: "EUR",
          date: "2026-05-15",
          funded_amount: 20,
          fx_rate: 1,
          generation_timestamp: "2026-04-10T00:00:00.000Z",
          id: "future_postgres_goal_delete",
          ledger_amount: 20,
          ledger_currency: "EUR",
          name: "Future Postgres goal delete",
          occurrence_key: `goal:${createdGoal.id}:2026-05-15`,
          period: "2026-05",
          requested_amount: 20,
          source_goal_id: createdGoal.id,
          status: "funded",
          type: "expense"
        }]);
        await budgetStore.insertConfirmedTransactions("household", [{
          amount: 100,
          buffered_fx_rate: 1,
          confirmed_date: "2026-04-12",
          created_at: "2026-04-12T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-12",
          fx_rate: 1,
          id: "confirmed_postgres_goal_delete",
          ledger_amount: 100,
          ledger_currency: "EUR",
          ledger_year: 2026,
          name: "Confirmed Postgres goal delete",
          occurrence_key: "goal:postgres-delete:expense:2026-04-12",
          running_balance_pln: 150,
          source_goal_id: createdGoal.id,
          type: "expense",
          updated_at: "2026-04-12T00:00:00.000Z"
        }]);
        await assert.rejects(
          () => planMutations.deleteGoal("household", createdGoal.id),
          /fully funded/
        );
        await planMutations.updateGoal("household", createdGoal.id, { amount: 100 });
        const deletedGoal = await planMutations.deleteGoal("household", createdGoal.id);
        assert.equal(deletedGoal.ok, true);
        assert.equal(
          (await budgetStore.listPlanningRows("household", "goals"))
            .some(row => row.id === createdGoal.id),
          false
        );
        assert.equal(
          (await budgetStore.listPlanningRows("household", "pending_transactions"))
            .some(row => row.id === "pending_postgres_goal_delete"),
          false
        );
        assert.equal(
          (await budgetStore.listPlanningRows("household", "future_transactions"))
            .some(row => row.id === "future_postgres_goal_delete"),
          false
        );
        assert.equal(
          (await budgetStore.listConfirmedTransactions("household"))
            .find(row => row.id === "confirmed_postgres_goal_delete")?.source_goal_id,
          null
        );

        const createdOneOff = await planMutations.createOneOffTransaction("household", {
          amount: 180,
          currency: "EUR",
          date: "2026-04-10",
          name: "Postgres one-off",
          type: "expense"
        });
        assert.equal(createdOneOff.currency, "EUR");
        assert.equal(Number(createdOneOff.amount), 180);
        assert.equal(createdOneOff._projection.projection_ok, true);

        const updatedOneOff = await planMutations.updateOneOffTransaction("household", createdOneOff.id, {
          amount: 220,
          date: "2026-04-11",
          name: "Postgres one-off updated"
        });
        assert.equal(updatedOneOff.name, "Postgres one-off updated");
        assert.equal(Number(updatedOneOff.amount), 220);
        assert.equal(updatedOneOff.date, "2026-04-11");

        const pendingEditOneOff = await planMutations.createOneOffTransaction("household", {
          amount: 50,
          currency: "EUR",
          date: "2026-04-18",
          name: "Postgres pending edit one-off",
          type: "expense"
        });
        await budgetStore.insertConfirmedTransactions("household", [{
          amount: 25,
          buffered_fx_rate: 1,
          confirmed_date: "2026-04-13",
          created_at: "2026-04-13T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-13",
          fx_rate: 1,
          id: "confirmed_postgres_pending_edit_oneoff",
          ledger_amount: 25,
          ledger_currency: "EUR",
          ledger_year: 2026,
          name: "Confirmed Postgres pending edit one-off",
          occurrence_key: "one_off:postgres-pending-edit:expense:2026-04-13",
          running_balance_pln: 175,
          source_one_off_id: pendingEditOneOff.id,
          type: "expense",
          updated_at: "2026-04-13T00:00:00.000Z"
        }]);
        await budgetStore.insertPlanningRows("household", "pending_transactions", [{
          amount: 25,
          buffered_fx_rate: 1,
          created_at: "2026-04-14T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-18",
          funded_amount: 25,
          fx_rate: 1,
          id: "pending_postgres_edit_oneoff",
          ledger_amount: 25,
          ledger_currency: "EUR",
          name: "Pending Postgres edit one-off",
          occurrence_key: `one_off_remainder:${pendingEditOneOff.id}:2`,
          pending_origin: "projection",
          requested_amount: 25,
          source_one_off_id: pendingEditOneOff.id,
          status: "pending",
          type: "expense",
          updated_at: "2026-04-14T00:00:00.000Z"
        }]);
        const editedPending = await planMutations.updatePendingTransaction(
          "household",
          "pending_postgres_edit_oneoff",
          {
            amount: 15,
            date: "2026-04-19",
            name: "Edited Postgres pending one-off"
          }
        );
        assert.equal(editedPending.name, "Edited Postgres pending one-off");
        assert.equal(editedPending.date, "2026-04-19");
        assert.equal(Number(editedPending.amount), 15);
        assert.equal(Number(editedPending.ledger_amount), 15);
        assert.equal(editedPending._projection.projection_ok, true);
        assert.equal(
          Number((await budgetStore.listPlanningRows("household", "one_off_transactions"))
            .find(row => row.id === pendingEditOneOff.id)?.amount),
          40
        );

        await budgetStore.insertPlanningRows("household", "pending_transactions", [{
          amount: 20,
          buffered_fx_rate: 1,
          created_at: "2026-04-11T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-11",
          funded_amount: 20,
          fx_rate: 1,
          id: "pending_postgres_oneoff_delete",
          ledger_amount: 20,
          ledger_currency: "EUR",
          name: "Pending Postgres one-off delete",
          occurrence_key: "one_off:postgres-delete:expense:2026-04-11",
          pending_origin: "projection",
          requested_amount: 20,
          source_one_off_id: createdOneOff.id,
          status: "pending",
          type: "expense",
          updated_at: "2026-04-11T00:00:00.000Z"
        }]);
        await budgetStore.insertPlanningRows("household", "future_transactions", [{
          amount: 30,
          buffered_fx_rate: 1,
          created_at: "2026-04-11T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-20",
          funded_amount: 30,
          fx_rate: 1,
          generation_timestamp: "2026-04-11T00:00:00.000Z",
          id: "future_postgres_oneoff_delete",
          ledger_amount: 30,
          ledger_currency: "EUR",
          name: "Future Postgres one-off delete",
          occurrence_key: "one_off:postgres-delete:expense:2026-04-20",
          period: "2026-04",
          requested_amount: 30,
          source_one_off_id: createdOneOff.id,
          status: "funded",
          type: "expense"
        }]);
        await budgetStore.insertConfirmedTransactions("household", [{
          amount: 100,
          buffered_fx_rate: 1,
          confirmed_date: "2026-04-12",
          created_at: "2026-04-12T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-12",
          fx_rate: 1,
          id: "confirmed_postgres_oneoff_delete",
          ledger_amount: 100,
          ledger_currency: "EUR",
          ledger_year: 2026,
          name: "Confirmed Postgres one-off delete",
          occurrence_key: "one_off:postgres-delete:expense:2026-04-12",
          running_balance_pln: 200,
          source_one_off_id: createdOneOff.id,
          type: "expense",
          updated_at: "2026-04-12T00:00:00.000Z"
        }]);
        await assert.rejects(
          () => planMutations.updateOneOffTransaction("household", createdOneOff.id, { amount: 50 }),
          /already confirmed amount/
        );

        const deletedOneOff = await planMutations.deleteOneOffTransaction("household", createdOneOff.id);
        assert.equal(deletedOneOff.ok, true);
        assert.equal(
          (await budgetStore.listPlanningRows("household", "one_off_transactions"))
            .some(row => row.id === createdOneOff.id),
          false
        );
        assert.equal(
          (await budgetStore.listPlanningRows("household", "pending_transactions"))
            .some(row => row.id === "pending_postgres_oneoff_delete"),
          false
        );
        assert.equal(
          (await budgetStore.listPlanningRows("household", "future_transactions"))
            .some(row => row.id === "future_postgres_oneoff_delete"),
          false
        );
        assert.equal(
          (await budgetStore.listConfirmedTransactions("household"))
            .find(row => row.id === "confirmed_postgres_oneoff_delete")?.source_one_off_id,
          null
        );

        const remainderOneOff = await planMutations.createOneOffTransaction("household", {
          amount: 125,
          currency: "EUR",
          date: "2026-04-30",
          name: "Postgres one-off remainder",
          type: "expense"
        });
        await budgetStore.insertConfirmedTransactions("household", [{
          amount: 90,
          buffered_fx_rate: 1,
          confirmed_date: "2026-04-22",
          created_at: "2026-04-22T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-22",
          fx_rate: 1,
          id: "confirmed_postgres_oneoff_remainder",
          ledger_amount: 90,
          ledger_currency: "EUR",
          ledger_year: 2026,
          name: "Confirmed Postgres one-off remainder",
          occurrence_key: "one_off:postgres-remainder:expense:2026-04-22",
          running_balance_pln: 110,
          source_one_off_id: remainderOneOff.id,
          type: "expense",
          updated_at: "2026-04-22T00:00:00.000Z"
        }]);
        await budgetStore.insertPlanningRows("household", "pending_transactions", [{
          amount: 35,
          buffered_fx_rate: 1,
          created_at: "2026-04-23T00:00:00.000Z",
          currency: "EUR",
          date: "2026-04-30",
          funded_amount: 35,
          fx_rate: 1,
          id: "pending_postgres_oneoff_remainder",
          ledger_amount: 35,
          ledger_currency: "EUR",
          name: "Pending Postgres one-off remainder",
          occurrence_key: `one_off_remainder:${remainderOneOff.id}:2`,
          pending_origin: "projection",
          requested_amount: 35,
          source_one_off_id: remainderOneOff.id,
          status: "pending",
          type: "expense",
          updated_at: "2026-04-23T00:00:00.000Z"
        }]);
        await budgetStore.insertPlanningRows("household", "future_transactions", [{
          amount: 10,
          buffered_fx_rate: 1,
          created_at: "2026-04-23T00:00:00.000Z",
          currency: "EUR",
          date: "2026-05-01",
          funded_amount: 10,
          fx_rate: 1,
          generation_timestamp: "2026-04-23T00:00:00.000Z",
          id: "future_postgres_oneoff_remainder",
          ledger_amount: 10,
          ledger_currency: "EUR",
          name: "Future Postgres one-off remainder",
          occurrence_key: "one_off:postgres-remainder:expense:2026-05-01",
          period: "2026-05",
          requested_amount: 10,
          source_one_off_id: remainderOneOff.id,
          status: "funded",
          type: "expense"
        }]);
        const dismissedRemainder = await planMutations.dismissPendingOneOffRemainder(
          "household",
          "pending_postgres_oneoff_remainder"
        );
        assert.equal(dismissedRemainder.ok, true);
        assert.equal(dismissedRemainder.dismissedPendingId, "pending_postgres_oneoff_remainder");
        assert.equal(Number(dismissedRemainder.oneOff.amount), 90);
        assert.equal(
          (await budgetStore.listPlanningRows("household", "pending_transactions"))
            .some(row => row.id === "pending_postgres_oneoff_remainder"),
          false
        );
        assert.equal(
          (await budgetStore.listPlanningRows("household", "future_transactions"))
            .some(row => row.id === "future_postgres_oneoff_remainder"),
          false
        );
        assert.equal(
          (await budgetStore.listConfirmedTransactions("household"))
            .find(row => row.id === "confirmed_postgres_oneoff_remainder")?.source_one_off_id,
          remainderOneOff.id
        );

        const ledgerSwitchSettings = await settingsService.updateSettings("household", {
          ledger_currency: "USD",
          manual_fx_rates: JSON.stringify({
            "EUR/USD": 1.1
          })
        });
        assert.equal(ledgerSwitchSettings.ledger_currency, "USD");
        const conversionRows = (await budgetStore.listPlanningRows("household", "pending_transactions"))
          .filter(row => String(row.occurrence_key || "").startsWith("ledger_currency_conversion:"));
        assert.equal(conversionRows.length, 1);
        assert.equal(conversionRows[0].currency, "USD");
        assert.equal(conversionRows[0].ledger_currency, "USD");
        assert.equal(Number(conversionRows[0].fx_rate), 1);
        assert.equal(Number(conversionRows[0].buffered_fx_rate), 1);
        assert.equal(
          (await budgetStore.listPlanningRows("household", "ledger_currency_events"))
            .some(row =>
              row.old_currency === "EUR"
              && row.new_currency === "USD"
              && Number(row.fx_rate) === 1.1
            ),
          true
        );
        await assert.rejects(
          () => settingsService.updateSettings("household", {
            ledger_currency: "PLN",
            manual_fx_rates: JSON.stringify({
              "USD/PLN": 4
            })
          }),
          /pending ledger currency conversion/
        );
        assert.equal(
          (await budgetStore.listPlanningRows("household", "pending_transactions"))
            .filter(row => String(row.occurrence_key || "").startsWith("ledger_currency_conversion:")).length,
          1
        );
      } finally {
        await budgetStore.close();
        await globalStore.close();
      }
    });
  });
});

test("regenerateProjectionsAsync writes real projection output against a disposable Postgres database", {
  skip: postgresRuntimeTestsEnabled() ? false : POSTGRES_TEST_SKIP_REASON
}, async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      const migration = await migrateSqliteToPostgres({
        databaseUrl,
        dataDir,
        dryRun: false,
        outputDir,
        sourceIsSnapshot: true
      });
      assert.equal(migration.ok, true);

      const budgetStore = await createPostgresBudgetStore({ databaseUrl });
      const globalStore = await createPostgresGlobalStore({ databaseUrl });
      try {
        await budgetStore.insertPlanningRows("household", "one_off_transactions", [{
          amount: 200,
          created_at: "2026-01-10T00:00:00.000Z",
          currency: "PLN",
          date: "2027-01-15",
          id: "oneoff_future_projection_async",
          name: "Future one-off for async projection engine",
          type: "expense",
          updated_at: "2026-01-10T00:00:00.000Z"
        }]);

        const projectionState = createCashflowProjectionStateService({
          budgetStore,
          latestConfirmedBalance: () => {
            throw new Error("Postgres async projection path must not read SQLite balances");
          },
          listLedgerYears: () => {
            throw new Error("Postgres async projection path must not list SQLite ledger years");
          },
          loadAllConfirmedTransactions: () => {
            throw new Error("Postgres async projection path must not read SQLite ledgers");
          },
          openLedgerDb: () => {
            throw new Error("Postgres async projection path must not open SQLite ledgers");
          }
        });

        const prediction = createCashflowPredictionService({
          budgetStore,
          listLedgerYears: () => {
            throw new Error("Postgres async projection path must not list SQLite ledger years for prediction");
          },
          openLedgerDb: () => {
            throw new Error("Postgres async projection path must not open SQLite ledgers for prediction");
          }
        });

        const projectionEngine = createCashflowProjectionEngineService({
          budgetStore,
          confirmedBalanceAsOfAsync: projectionState.confirmedBalanceAsOfAsync,
          confirmedOccurrenceKeys: () => {
            throw new Error("Postgres async projection path must not read SQLite occurrence keys");
          },
          confirmedOccurrenceKeysAsync: projectionState.confirmedOccurrenceKeysAsync,
          confirmedOneOffProgress: () => {
            throw new Error("Postgres async projection path must not read SQLite one-off progress");
          },
          confirmedOneOffProgressAsync: projectionState.confirmedOneOffProgressAsync,
          confirmedRowsAfterDate: () => {
            throw new Error("Postgres async projection path must not read SQLite confirmed rows");
          },
          confirmedRowsAfterDateAsync: projectionState.confirmedRowsAfterDateAsync,
          confirmedRowsForPrediction: () => {
            throw new Error("Postgres async projection path must not read SQLite prediction rows");
          },
          confirmedRowsForPredictionAsync: prediction.confirmedRowsForPredictionAsync,
          deletePendingOccurrence: () => {
            throw new Error("Postgres async projection path must not delete through SQLite");
          },
          getCachedFxSnapshot: () => {
            throw new Error("Postgres async projection path must not read a cached SQLite FX snapshot");
          },
          getCachedFxSnapshotAsync: async () => null,
          logServerEvent: () => {},
          notificationEnabled,
          notificationPriority,
          openPlanningDb: () => {
            throw new Error("Postgres async projection path must not open SQLite planning storage");
          },
          planningOpeningBalance: () => {
            throw new Error("Postgres async projection path must not read SQLite opening balance");
          },
          predictedAmountForRecurringExpense: () => {
            throw new Error("Postgres async projection path must not predict through SQLite");
          },
          predictedAmountForRecurringIncome: () => {
            throw new Error("Postgres async projection path must not predict through SQLite");
          },
          queueNotification: () => {
            throw new Error("Postgres async projection path must queue notifications through the budget store");
          },
          recalculatePlanningRunningBalances: () => {
            throw new Error("Postgres async projection path recalculates through the budget store");
          },
          recalculatePlanningRunningBalancesAsync: projectionState.recalculatePlanningRunningBalancesAsync,
          refreshPendingOccurrence: () => {
            throw new Error("Postgres async projection path must not refresh through SQLite");
          },
          safeGetCurrentFxSnapshot: () => {
            throw new Error("Postgres async projection path must not read a live SQLite FX snapshot");
          },
          safeGetCurrentFxSnapshotAsync: async () => null,
          sumConfirmedFunding: () => {
            throw new Error("Postgres async projection path must not sum SQLite confirmed funding");
          },
          sumPendingFunding: () => {
            throw new Error("Postgres async projection path must not sum SQLite pending funding");
          }
        });

        const applyResult = await projectionEngine.regenerateProjectionsAsync("household");
        assert.ok(applyResult, "expected regenerateProjectionsAsync to return an apply summary");

        const futureRows = await budgetStore.listPlanningRows("household", "future_transactions");
        assert.equal(
          futureRows.some(row =>
            row.occurrence_key === "one_off:oneoff_future_projection_async:expense:2027-01-15"
          ),
          true
        );

        const snapshotRows = await budgetStore.listPlanningRows("household", "projection_snapshots");
        assert.ok(snapshotRows.length > 0, "expected regenerateProjectionsAsync to write a projection snapshot");

        // No period-anchor income is configured yet, so buildBudgetPeriods()
        // uses plain calendar-month period keys ("YYYY-MM") here — one of
        // two legitimate period shapes (see cashflow-postgres-budget-
        // schema.js's future_transactions.period CHECK constraint comment).
        assert.ok(
          futureRows.every(row => /^\d{4}-\d{2}$/.test(row.period)),
          "expected calendar-month period keys with no period-anchor income configured"
        );

        const secondApplyResult = await projectionEngine.regenerateProjectionsAsync("household");
        assert.ok(secondApplyResult, "expected regenerateProjectionsAsync to be safely re-runnable");
        const futureRowsAfterRerun = await budgetStore.listPlanningRows("household", "future_transactions");
        assert.equal(
          futureRowsAfterRerun.filter(row =>
            row.occurrence_key === "one_off:oneoff_future_projection_async:expense:2027-01-15"
          ).length,
          1
        );

        // Now configure a period-anchor income: buildBudgetPeriods() switches
        // to anchor-date period keys ("YYYY-MM-DD", from calculateNextDate())
        // instead of calendar months — the other legitimate period shape,
        // and the one a first attempt at the CHECK constraint fix broke by
        // assuming every period was one shape or the other, not both.
        await budgetStore.insertPlanningRows("household", "recurring_incomes", [{
          active: true,
          amount: 4000,
          anchor_business_day_adjustment: "none",
          anchor_day_of_month: 25,
          anchor_offset_days: 0,
          anchor_type: "day_of_month",
          created_at: "2026-01-10T00:00:00.000Z",
          currency: "PLN",
          id: "recurring_income_period_anchor",
          name: "Anchor income for period-format coverage",
          period_setting: true,
          prediction_min_recorded_months: 6,
          prediction_strategy: "fixed",
          prediction_substitute_missing: "none",
          repeat_every_months: 1,
          start_month_year: "2026-01",
          updated_at: "2026-01-10T00:00:00.000Z"
        }]);
        await budgetStore.updatePlanningRowsById("household", "settings", [{
          budget_period_income_id: "recurring_income_period_anchor",
          id: 1
        }]);

        const thirdApplyResult = await projectionEngine.regenerateProjectionsAsync("household");
        assert.ok(thirdApplyResult, "expected regenerateProjectionsAsync to handle anchor-date periods");
        const futureRowsWithAnchor = await budgetStore.listPlanningRows("household", "future_transactions");
        assert.ok(futureRowsWithAnchor.length > 0);
        assert.ok(
          futureRowsWithAnchor.every(row => /^\d{4}-\d{2}-\d{2}$/.test(row.period)),
          "expected full anchor-date period keys once a period-anchor income is configured"
        );
      } finally {
        await budgetStore.close();
        await globalStore.close();
      }
    });
  });
});

test("importFullDataAsync, createBackupAsync/restoreBackupAsync, and purgeBudgetAsync work against a disposable Postgres database", {
  skip: postgresRuntimeTestsEnabled() ? false : POSTGRES_TEST_SKIP_REASON
}, async () => {
  await withTempDirs(async ({ dataDir, outputDir, root }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);
    const backupRoot = path.join(root, "backups");
    fs.mkdirSync(backupRoot, { recursive: true });

    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      const migration = await migrateSqliteToPostgres({
        databaseUrl,
        dataDir,
        dryRun: false,
        outputDir,
        sourceIsSnapshot: true
      });
      assert.equal(migration.ok, true);

      const budgetStore = await createPostgresBudgetStore({ databaseUrl });
      const globalStore = await createPostgresGlobalStore({ databaseUrl });
      try {
        const projectionState = createCashflowProjectionStateService({
          budgetStore,
          latestConfirmedBalance: () => {
            throw new Error("Postgres async import/backup/purge path must not read SQLite balances");
          },
          listLedgerYears: () => {
            throw new Error("Postgres async import/backup/purge path must not list SQLite ledger years");
          },
          loadAllConfirmedTransactions: () => {
            throw new Error("Postgres async import/backup/purge path must not read SQLite ledgers");
          },
          openLedgerDb: () => {
            throw new Error("Postgres async import/backup/purge path must not open SQLite ledgers");
          }
        });

        const prediction = createCashflowPredictionService({
          budgetStore,
          listLedgerYears: () => {
            throw new Error("Postgres async import/backup/purge path must not list SQLite ledger years for prediction");
          },
          openLedgerDb: () => {
            throw new Error("Postgres async import/backup/purge path must not open SQLite ledgers for prediction");
          }
        });

        const projectionEngine = createCashflowProjectionEngineService({
          budgetStore,
          confirmedBalanceAsOfAsync: projectionState.confirmedBalanceAsOfAsync,
          confirmedOccurrenceKeys: () => {
            throw new Error("must not read SQLite occurrence keys");
          },
          confirmedOccurrenceKeysAsync: projectionState.confirmedOccurrenceKeysAsync,
          confirmedOneOffProgress: () => {
            throw new Error("must not read SQLite one-off progress");
          },
          confirmedOneOffProgressAsync: projectionState.confirmedOneOffProgressAsync,
          confirmedRowsAfterDate: () => {
            throw new Error("must not read SQLite confirmed rows");
          },
          confirmedRowsAfterDateAsync: projectionState.confirmedRowsAfterDateAsync,
          confirmedRowsForPrediction: () => {
            throw new Error("must not read SQLite prediction rows");
          },
          confirmedRowsForPredictionAsync: prediction.confirmedRowsForPredictionAsync,
          deletePendingOccurrence: () => {
            throw new Error("must not delete through SQLite");
          },
          getCachedFxSnapshot: () => {
            throw new Error("must not read a cached SQLite FX snapshot");
          },
          getCachedFxSnapshotAsync: async () => null,
          logServerEvent: () => {},
          notificationEnabled,
          notificationPriority,
          openPlanningDb: () => {
            throw new Error("must not open SQLite planning storage");
          },
          planningOpeningBalance: () => {
            throw new Error("must not read SQLite opening balance");
          },
          predictedAmountForRecurringExpense: () => {
            throw new Error("must not predict through SQLite");
          },
          predictedAmountForRecurringIncome: () => {
            throw new Error("must not predict through SQLite");
          },
          queueNotification: () => {
            throw new Error("must queue notifications through the budget store");
          },
          recalculatePlanningRunningBalances: () => {
            throw new Error("recalculates through the budget store");
          },
          recalculatePlanningRunningBalancesAsync: projectionState.recalculatePlanningRunningBalancesAsync,
          refreshPendingOccurrence: () => {
            throw new Error("must not refresh through SQLite");
          },
          safeGetCurrentFxSnapshot: () => {
            throw new Error("must not read a live SQLite FX snapshot");
          },
          safeGetCurrentFxSnapshotAsync: async () => null,
          sumConfirmedFunding: () => {
            throw new Error("must not sum SQLite confirmed funding");
          },
          sumPendingFunding: () => {
            throw new Error("must not sum SQLite pending funding");
          }
        });

        const ledgerService = createCashflowLedgerService({
          budgetStore,
          generateId: prefix => `${prefix}_pg_test`,
          listLedgerYears: () => {
            throw new Error("Postgres async ledger path must not list SQLite ledger years");
          },
          openLedgerDb: () => {
            throw new Error("Postgres async ledger path must not open SQLite ledgers");
          },
          openPlanningDb: () => {
            throw new Error("Postgres async ledger path must not open SQLite planning storage");
          }
        });

        const coordinator = createCashflowProjectionCoordinatorService({
          budgetStore,
          collectCurrenciesForFxSnapshot: () => {
            throw new Error("must not collect currencies through SQLite");
          },
          confirmedBalanceAsOfAsync: projectionState.confirmedBalanceAsOfAsync,
          ensureFxCacheForMutation: () => {
            throw new Error("must not refresh FX cache through SQLite");
          },
          getCachedFxSnapshot: () => {
            throw new Error("must not read a cached SQLite FX snapshot");
          },
          getCachedFxSnapshotAsync: async () => null,
          latestConfirmedBalance: () => {
            throw new Error("must not read SQLite confirmed balance");
          },
          listCashflowUserIds: () => {
            throw new Error("must not list SQLite user ids");
          },
          lockService: null,
          logCashflowError: () => {},
          logError: () => {},
          logServerEvent: () => {},
          openPlanningDb: () => {
            throw new Error("must not open SQLite planning storage");
          },
          pendingNetBalance: () => {
            throw new Error("must not read SQLite pending balance");
          },
          pendingNetBalanceAsync: projectionState.pendingNetBalanceAsync,
          refreshNbpFxCacheForUser: () => {
            throw new Error("must not refresh FX through SQLite");
          },
          regenerateProjections: () => {
            throw new Error("must not regenerate through the sync SQLite engine");
          },
          regenerateProjectionsAsync: projectionEngine.regenerateProjectionsAsync,
          safeGetCurrentFxSnapshot: () => {
            throw new Error("must not read a live SQLite FX snapshot");
          },
          safeGetCurrentFxSnapshotAsync: async () => null
        });

        const dataPortability = createCashflowDataPortabilityService({
          budgetStore,
          createBackup: () => {
            throw new Error("Postgres async import path must not use the sync SQLite backup helper");
          },
          generateId: prefix => `${prefix}_pg_import_test`,
          listLedgerYears: () => {
            throw new Error("must not list SQLite ledger years");
          },
          loadAllConfirmedTransactions: () => {
            throw new Error("must not read SQLite ledgers");
          },
          openLedgerDb: () => {
            throw new Error("must not open SQLite ledgers");
          },
          openPlanningDb: () => {
            throw new Error("must not open SQLite planning storage");
          },
          recalculateLedgerRunningBalance: () => {
            throw new Error("recalculates through the budget store");
          },
          recalculateLedgerRunningBalanceAsync: ledgerService.recalculateLedgerRunningBalanceAsync,
          regenerateProjectionsAfterMutation: () => {
            throw new Error("must regenerate through the async engine");
          },
          regenerateProjectionsAfterMutationAsync: coordinator.regenerateProjectionsAfterMutationAsync,
          restoreBackupFromPath: () => {
            throw new Error("Postgres async import path must not use the sync SQLite restore helper");
          }
        });

        const exportedPayload = await dataPortability.exportFullDataAsync("household", "1.0.0-test");
        const exportedOneOff = exportedPayload.planning.one_off_transactions.find(row => row.id === "oneoff_desk");
        assert.ok(exportedOneOff, "expected the seeded one-off transaction in the export");
        exportedOneOff.amount = 321;

        const importResult = await dataPortability.importFullDataAsync("household", exportedPayload, "replace");
        assert.equal(importResult.ok, true);
        assert.equal(importResult.mode, "replace");
        const oneOffRowsAfterImport = await budgetStore.listPlanningRows("household", "one_off_transactions");
        assert.equal(
          Number(oneOffRowsAfterImport.find(row => row.id === "oneoff_desk")?.amount),
          321
        );

        let generatedBackupCount = 0;
        const backupService = createCashflowBackupService({
          backupDir: () => {
            throw new Error("Postgres async backup path must not use the SQLite backup directory helper");
          },
          backupRootDir: () => backupRoot,
          budgetStore,
          directorySizeBytes: () => {
            throw new Error("Postgres async backup path must not measure a SQLite backup directory");
          },
          generateId: prefix => `${prefix}_pg_backup_test_${++generatedBackupCount}`,
          getSettings: () => {
            throw new Error("Postgres async backup path must not read SQLite settings");
          },
          getSettingsAsync: async userId =>
            (await budgetStore.listPlanningRows(userId, "settings"))?.[0] || null,
          initReadOnlyPragmas: () => {
            throw new Error("Postgres async backup path must not open SQLite in read-only mode");
          },
          listLedgerYears: () => {
            throw new Error("must not list SQLite ledger years");
          },
          logError: () => {},
          logServerEvent: () => {},
          openLedgerDb: () => {
            throw new Error("must not open SQLite ledgers");
          },
          openPlanningDb: () => {
            throw new Error("must not open SQLite planning storage");
          },
          recalculateLedgerRunningBalance: () => {
            throw new Error("recalculates through the budget store");
          },
          recalculateLedgerRunningBalanceAsync: ledgerService.recalculateLedgerRunningBalanceAsync,
          regenerateProjectionsAfterMutation: () => {
            throw new Error("must regenerate through the async engine");
          },
          regenerateProjectionsAfterMutationAsync: coordinator.regenerateProjectionsAfterMutationAsync
        });

        const backupPath = await backupService.createBackupAsync("household");
        assert.equal(fs.existsSync(backupPath), true);
        const backupMetadataRows = await budgetStore.listPlanningRows("household", "backup_metadata");
        const backupRow = backupMetadataRows.find(row => row.backup_path === backupPath);
        assert.ok(backupRow, "expected a backup_metadata row recorded in Postgres");
        assert.equal(backupRow.success, true);

        await budgetStore.updatePlanningRowsById("household", "one_off_transactions", [{
          amount: 999,
          id: "oneoff_desk"
        }]);
        assert.equal(
          Number((await budgetStore.listPlanningRows("household", "one_off_transactions"))
            .find(row => row.id === "oneoff_desk")?.amount),
          999
        );

        const restoreResult = await backupService.restoreBackupAsync("household", backupRow.id);
        assert.equal(restoreResult.ok, true);
        const oneOffRowsAfterRestore = await budgetStore.listPlanningRows("household", "one_off_transactions");
        assert.equal(
          Number(oneOffRowsAfterRestore.find(row => row.id === "oneoff_desk")?.amount),
          321
        );

        // "household" already has "legacy-admin" as its owner (inserted by
        // initializeGlobalSchema's migrateLegacyProfiles bootstrap for any
        // storage profile id passed to createGlobalSource) — a budget can
        // only have one owner (idx_budget_memberships_single_owner), so the
        // purge actor here is the existing owner, not "alice" (an editor).
        await globalStore.transaction(async repo => {
          await repo.budgets.markArchived("household");
        });

        const deletedStorageCalls = [];
        const budgetService = createCashflowBudgetService({
          createBudgetBackupAsync: async () => ({ note: "stub-safety-backup-for-purge-test" }),
          deleteBudgetStorage: budgetId => {
            deletedStorageCalls.push(budgetId);
          },
          globalStore,
          initializeBudgetStorage: () => {
            throw new Error("purgeBudgetAsync must not initialize SQLite budget storage");
          },
          openGlobalDb: () => {
            throw new Error("purgeBudgetAsync must not open the SQLite global database");
          }
        });

        const purgeResult = await budgetService.purgeBudgetAsync("legacy-admin", "household");
        assert.equal(purgeResult.status, "deleted");
        assert.deepEqual(deletedStorageCalls, ["household"]);
        assert.equal(
          (await globalStore.listRows("budget_memberships")).some(row => row.budget_id === "household"),
          false
        );
        assert.equal(
          (await globalStore.listRows("auth_sessions")).some(row => row.selected_budget_id === "household"),
          false
        );
      } finally {
        await budgetStore.close();
        await globalStore.close();
      }
    });
  });
});

test("concurrent confirmPendingTransaction calls for the same pending row do not double-confirm against a disposable Postgres database", {
  skip: postgresRuntimeTestsEnabled() ? false : POSTGRES_TEST_SKIP_REASON
}, async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      const migration = await migrateSqliteToPostgres({
        databaseUrl,
        dataDir,
        dryRun: false,
        outputDir,
        sourceIsSnapshot: true
      });
      assert.equal(migration.ok, true);

      const budgetStore = await createPostgresBudgetStore({ databaseUrl });
      const globalStore = await createPostgresGlobalStore({ databaseUrl });
      try {
        // "pending_income" is seeded once by createBudgetStorageSource. Two
        // concurrent confirms race between the pre-transaction "does this
        // pending row still exist" read (both can see it exists before
        // either has deleted it) and the `pg_advisory_xact_lock`-guarded
        // insert inside budgetStore.transaction. The lock only serializes
        // the second half — it does not stop both calls from reading a
        // stale "still pending" view first — so this proves whichever
        // safety net (confirmed_transactions' primary key, or the
        // already-confirmed check) actually prevents a double-confirm.
        const pendingConfirmation = createCashflowPendingConfirmationService({
          budgetStore,
          deletePendingOccurrence: () => {
            throw new Error("Postgres concurrent confirm path must not delete through SQLite");
          },
          findConfirmedOccurrence: () => {
            throw new Error("Postgres concurrent confirm path must not search SQLite ledgers");
          },
          getConfirmedFxForDate: async () => ({
            bufferedFxRate: 1,
            fxRate: 1
          }),
          newestConfirmedTransactionDate: () => {
            throw new Error("Postgres concurrent confirm path must not read SQLite ledger dates");
          },
          newestConfirmedTransactionDateAsync: async () => null,
          openLedgerDb: () => {
            throw new Error("Postgres concurrent confirm path must not open SQLite ledger files");
          },
          openPlanningDb: () => {
            throw new Error("Postgres concurrent confirm path must not open SQLite planning files");
          },
          recalculateLedgerRunningBalance: () => {
            throw new Error("Postgres concurrent confirm path recalculates through the budget store");
          },
          runRecoverableUserMutation: async (_budgetId, _operation, work) => await work(),
          withProjectionStatus: (_budgetId, result) => result,
          wouldLedgerGoNegativeAfterInsert: () => {
            throw new Error("Postgres concurrent confirm path must not use SQLite balance checks");
          },
          wouldLedgerGoNegativeAfterInsertAsync: async () => false
        });

        const outcomes = await Promise.allSettled([
          pendingConfirmation.confirmPendingTransaction("household", "pending_income", {
            confirmed_date: "2026-01-06"
          }),
          pendingConfirmation.confirmPendingTransaction("household", "pending_income", {
            confirmed_date: "2026-01-06"
          })
        ]);

        const fulfilled = outcomes.filter(outcome => outcome.status === "fulfilled");
        assert.ok(fulfilled.length >= 1, "expected at least one concurrent confirm call to succeed");

        const confirmedRows = (await budgetStore.listConfirmedTransactions("household"))
          .filter(row => row.id === "pending_income");
        assert.equal(confirmedRows.length, 1, "expected exactly one confirmed row, not zero or two");
        assert.equal(
          (await budgetStore.listPlanningRows("household", "pending_transactions"))
            .some(row => row.id === "pending_income"),
          false
        );
      } finally {
        await budgetStore.close();
        await globalStore.close();
      }
    });
  });
});

test("two replicas racing regenerateProjectionsAfterMutationAsync for the same budget are serialized by the real Postgres lock against a disposable database", {
  skip: postgresRuntimeTestsEnabled() ? false : POSTGRES_TEST_SKIP_REASON
}, async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      const migration = await migrateSqliteToPostgres({
        databaseUrl,
        dataDir,
        dryRun: false,
        outputDir,
        sourceIsSnapshot: true
      });
      assert.equal(migration.ok, true);

      const budgetStore = await createPostgresBudgetStore({ databaseUrl });
      const globalStore = await createPostgresGlobalStore({ databaseUrl });
      try {
        await budgetStore.insertPlanningRows("household", "one_off_transactions", [{
          amount: 75,
          created_at: "2026-01-10T00:00:00.000Z",
          currency: "PLN",
          date: "2027-02-20",
          id: "oneoff_lock_race",
          name: "Future one-off for the projection lock race test",
          type: "expense",
          updated_at: "2026-01-10T00:00:00.000Z"
        }]);

        const projectionState = createCashflowProjectionStateService({
          budgetStore,
          latestConfirmedBalance: () => {
            throw new Error("Postgres lock-race path must not read SQLite balances");
          },
          listLedgerYears: () => {
            throw new Error("Postgres lock-race path must not list SQLite ledger years");
          },
          loadAllConfirmedTransactions: () => {
            throw new Error("Postgres lock-race path must not read SQLite ledgers");
          },
          openLedgerDb: () => {
            throw new Error("Postgres lock-race path must not open SQLite ledgers");
          }
        });

        const prediction = createCashflowPredictionService({
          budgetStore,
          listLedgerYears: () => {
            throw new Error("Postgres lock-race path must not list SQLite ledger years for prediction");
          },
          openLedgerDb: () => {
            throw new Error("Postgres lock-race path must not open SQLite ledgers for prediction");
          }
        });

        // One projection engine instance is shared between both simulated
        // replicas below — it holds no per-call state of its own, only the
        // lockService differs per replica, which is exactly what real
        // multi-replica deployments share (the same code, different lock
        // ownership).
        const projectionEngine = createCashflowProjectionEngineService({
          budgetStore,
          confirmedBalanceAsOfAsync: projectionState.confirmedBalanceAsOfAsync,
          confirmedOccurrenceKeys: () => {
            throw new Error("must not read SQLite occurrence keys");
          },
          confirmedOccurrenceKeysAsync: projectionState.confirmedOccurrenceKeysAsync,
          confirmedOneOffProgress: () => {
            throw new Error("must not read SQLite one-off progress");
          },
          confirmedOneOffProgressAsync: projectionState.confirmedOneOffProgressAsync,
          confirmedRowsAfterDate: () => {
            throw new Error("must not read SQLite confirmed rows");
          },
          confirmedRowsAfterDateAsync: projectionState.confirmedRowsAfterDateAsync,
          confirmedRowsForPrediction: () => {
            throw new Error("must not read SQLite prediction rows");
          },
          confirmedRowsForPredictionAsync: prediction.confirmedRowsForPredictionAsync,
          deletePendingOccurrence: () => {
            throw new Error("must not delete through SQLite");
          },
          getCachedFxSnapshot: () => {
            throw new Error("must not read a cached SQLite FX snapshot");
          },
          getCachedFxSnapshotAsync: async () => null,
          logServerEvent: () => {},
          notificationEnabled,
          notificationPriority,
          openPlanningDb: () => {
            throw new Error("must not open SQLite planning storage");
          },
          planningOpeningBalance: () => {
            throw new Error("must not read SQLite opening balance");
          },
          predictedAmountForRecurringExpense: () => {
            throw new Error("must not predict through SQLite");
          },
          predictedAmountForRecurringIncome: () => {
            throw new Error("must not predict through SQLite");
          },
          queueNotification: () => {
            throw new Error("must queue notifications through the budget store");
          },
          recalculatePlanningRunningBalances: () => {
            throw new Error("recalculates through the budget store");
          },
          recalculatePlanningRunningBalancesAsync: projectionState.recalculatePlanningRunningBalancesAsync,
          refreshPendingOccurrence: () => {
            throw new Error("must not refresh through SQLite");
          },
          safeGetCurrentFxSnapshot: () => {
            throw new Error("must not read a live SQLite FX snapshot");
          },
          safeGetCurrentFxSnapshotAsync: async () => null,
          sumConfirmedFunding: () => {
            throw new Error("must not sum SQLite confirmed funding");
          },
          sumPendingFunding: () => {
            throw new Error("must not sum SQLite pending funding");
          }
        });

        function buildCoordinatorForReplica(lockService) {
          return createCashflowProjectionCoordinatorService({
            budgetStore,
            collectCurrenciesForFxSnapshot: () => {
              throw new Error("must not collect currencies through SQLite");
            },
            confirmedBalanceAsOfAsync: projectionState.confirmedBalanceAsOfAsync,
            ensureFxCacheForMutation: () => {
              throw new Error("must not refresh FX cache through SQLite");
            },
            getCachedFxSnapshot: () => {
              throw new Error("must not read a cached SQLite FX snapshot");
            },
            getCachedFxSnapshotAsync: async () => null,
            latestConfirmedBalance: () => {
              throw new Error("must not read SQLite confirmed balance");
            },
            listCashflowUserIds: () => {
              throw new Error("must not list SQLite user ids");
            },
            lockService,
            logCashflowError: () => {},
            logError: () => {},
            logServerEvent: () => {},
            openPlanningDb: () => {
              throw new Error("must not open SQLite planning storage");
            },
            pendingNetBalance: () => {
              throw new Error("must not read SQLite pending balance");
            },
            pendingNetBalanceAsync: projectionState.pendingNetBalanceAsync,
            refreshNbpFxCacheForUser: () => {
              throw new Error("must not refresh FX through SQLite");
            },
            regenerateProjections: () => {
              throw new Error("must not regenerate through the sync SQLite engine");
            },
            regenerateProjectionsAsync: projectionEngine.regenerateProjectionsAsync,
            safeGetCurrentFxSnapshot: () => {
              throw new Error("must not read a live SQLite FX snapshot");
            },
            safeGetCurrentFxSnapshotAsync: async () => null
          });
        }

        const replicaA = buildCoordinatorForReplica(globalStore.createLockService({ ownerId: "replica_a" }));
        const replicaB = buildCoordinatorForReplica(globalStore.createLockService({ ownerId: "replica_b" }));

        const [resultA, resultB] = await Promise.all([
          replicaA.regenerateProjectionsAfterMutationAsync("household"),
          replicaB.regenerateProjectionsAfterMutationAsync("household")
        ]);

        const skippedCount = [resultA, resultB].filter(result => result?.projection_skipped === true).length;
        const succeededCount = [resultA, resultB].filter(result =>
          result?.projection_ok === true && !result?.projection_skipped
        ).length;
        assert.equal(succeededCount, 1, "expected exactly one replica to actually run the projection");
        assert.equal(skippedCount, 1, "expected exactly one replica to be skipped by the real Postgres lock");

        // The lock itself must not be left held after both calls settle —
        // a fresh acquire by a third replica should succeed immediately.
        // (cashflow_runtime_locks is a coordination table, not one of the
        // globalStore.listRows allowlisted tables, so the lock service's
        // own API is the right way to observe this, not a raw row read.)
        const replicaC = globalStore.createLockService({ ownerId: "replica_c" });
        const postRaceAcquire = await replicaC.tryAcquire(
          budgetRuntimeLockName("household", BUDGET_RUNTIME_LOCK_JOBS.projection),
          { ttlMs: 10_000 }
        );
        assert.equal(postRaceAcquire.acquired, true, "expected the projection lock to be released after the race settles");
        await replicaC.release(budgetRuntimeLockName("household", BUDGET_RUNTIME_LOCK_JOBS.projection));

        const futureRows = await budgetStore.listPlanningRows("household", "future_transactions");
        assert.equal(
          futureRows.some(row => row.occurrence_key === "one_off:oneoff_lock_race:expense:2027-02-20"),
          true
        );
      } finally {
        await budgetStore.close();
        await globalStore.close();
      }
    });
  });
});

test("createUserAsync and selectUserAsync run the none-mode bootstrap path against a disposable Postgres database", {
  skip: postgresRuntimeTestsEnabled() ? false : POSTGRES_TEST_SKIP_REASON
}, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl }) => {
    const globalDb = await createPostgresGlobalDbService({ databaseUrl });
    const budgetDb = await createPostgresBudgetDbService({ databaseUrl });
    await globalDb.initializeGlobalSchema();
    await budgetDb.initializeBudgetSchema();

    const budgetStore = await createPostgresBudgetStore({ databaseUrl });
    const globalStore = await createPostgresGlobalStore({ databaseUrl });
    try {
      const globalService = createCashflowGlobalService({
        budgetStore,
        cashflowUserStorageExists: () => false,
        dataDir: "/unused-in-postgres-mode",
        deleteCashflowUserStorage: () => {},
        globalStore,
        listCashflowUserIds: () => [],
        logError: () => {},
        logServerEvent: () => {},
        normalizeLocale: value => String(value || "en").trim().toLowerCase(),
        openGlobalDb: () => {
          throw new Error("Postgres createUserAsync/selectUserAsync path must not open the SQLite global database");
        },
        openPlanningDb: () => {
          throw new Error("Postgres createUserAsync/selectUserAsync path must not open SQLite planning storage");
        }
      });

      const firstSession = await globalService.createUserAsync({
        userId: "postgres_first_user",
        displayName: "Postgres First User",
        email: "postgres-first@example.test"
      });
      assert.equal(firstSession.authenticated, true);
      assert.equal(firstSession.userId, "postgres_first_user");
      assert.deepEqual(firstSession.permissions, ["admin"]);
      assert.ok(firstSession.globalRoles.includes("system_admin"));
      assert.equal(firstSession.budgetRole, "owner");

      // The very first account on an empty install becomes the system
      // admin — verify the real rows, not just the returned session.
      const adminRoles = await globalStore.listRows("account_global_roles");
      assert.equal(
        adminRoles.filter(row => row.role === "system_admin").length,
        1
      );
      const authConfigRows = await globalStore.listRows("auth_config");
      assert.ok(authConfigRows[0]?.bootstrap_completed_at, "expected bootstrap_completed_at to be set");

      const firstSettingsRows = await budgetStore.listPlanningRows("postgres_first_user", "settings");
      assert.equal(firstSettingsRows.length, 1);
      assert.equal(firstSettingsRows[0].ledger_currency, "PLN");
      assert.equal(firstSettingsRows[0].setup_completed, false);

      const secondSession = await globalService.createUserAsync({
        userId: "postgres_second_user",
        displayName: "Postgres Second User"
      });
      assert.equal(secondSession.authenticated, true);
      assert.deepEqual(secondSession.permissions, [], "expected the second account to not receive admin");
      const adminRolesAfterSecond = await globalStore.listRows("account_global_roles");
      assert.equal(
        adminRolesAfterSecond.filter(row => row.role === "system_admin").length,
        1,
        "expected exactly one system admin after a second account is created"
      );

      await assert.rejects(
        () => globalService.createUserAsync({ userId: "postgres_first_user" }),
        /already exists/
      );
      // A rejected duplicate create must not have touched anything.
      const budgetsAfterConflict = await globalStore.listRows("budgets");
      assert.equal(budgetsAfterConflict.filter(row => row.id === "postgres_first_user").length, 1);

      // selectUserAsync on an existing Postgres-native budget exercises the
      // resolveBudgetContextAsync fix directly: without it, this call would
      // incorrectly 404 because cashflowUserStorageExists() (a filesystem
      // check) can never see a budget that only exists in Postgres.
      const reselected = await globalService.selectUserAsync("postgres_second_user");
      assert.equal(reselected.authenticated, true);
      assert.equal(reselected.userId, "postgres_second_user");
      assert.equal(reselected.budgetRole, "owner");

      await assert.rejects(
        () => globalService.selectUserAsync("postgres_does_not_exist"),
        /not found/i
      );

      // createBudgetAsync shares initializeBudgetStorageAsync with
      // createUserAsync above, but was reordered (budgets row before
      // settings insert, not after) to avoid the same FK-ordering bug —
      // verify that reordering directly against a second, explicitly
      // created budget rather than only the implicit one createUserAsync
      // makes for its owner.
      const budgetService = createCashflowBudgetService({
        deleteBudgetStorage: () => {},
        globalStore,
        initializeBudgetStorage: () => {
          throw new Error("createBudgetAsync must use initializeBudgetStorageAsync under Postgres");
        },
        initializeBudgetStorageAsync: globalService.initializeBudgetStorageAsync,
        openGlobalDb: () => {
          throw new Error("createBudgetAsync must not open the SQLite global database");
        }
      });
      const secondBudget = await budgetService.createBudgetAsync("postgres_first_user", {
        displayName: "Postgres First User's Second Budget"
      });
      assert.equal(secondBudget.role, "owner");
      const secondBudgetSettings = await budgetStore.listPlanningRows(secondBudget.id, "settings");
      assert.equal(secondBudgetSettings.length, 1);
      assert.equal(secondBudgetSettings[0].ledger_currency, "PLN");
    } finally {
      await budgetStore.close();
      await globalStore.close();
      await globalDb.close();
      await budgetDb.close();
    }
  });
});

test("a Postgres storage snapshot round-trips back into fresh SQLite files against a disposable database", {
  skip: postgresRuntimeTestsEnabled() ? false : POSTGRES_TEST_SKIP_REASON
}, async () => {
  await withTempDirs(async ({ dataDir, outputDir, root }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      const migration = await migrateSqliteToPostgres({
        databaseUrl,
        dataDir,
        dryRun: false,
        outputDir,
        sourceIsSnapshot: true
      });
      assert.equal(migration.ok, true);

      const budgetStore = await createPostgresBudgetStore({ databaseUrl });
      const globalStore = await createPostgresGlobalStore({ databaseUrl });
      try {
        // Give the settings row real boolean/JSON values (Postgres returns
        // native booleans and parsed JSONB objects for these when read back
        // — better-sqlite3 can only bind numbers/strings/bigints/buffers/
        // null, so this exercises normalizeSqliteBindValue rather than only
        // columns that happen to already be primitives). JSONB columns are
        // written as JSON strings here, matching how every real write path
        // in this codebase writes them (e.g. validateAndNormalizeSettings
        // JSON.stringifies before the pg driver ever sees the value — it
        // does not auto-serialize plain JS objects/arrays itself).
        await budgetStore.updatePlanningRowsById("household", "settings", [{
          fx_used_currencies: JSON.stringify(["EUR", "GBP"]),
          id: 1,
          manual_fx_rates: JSON.stringify({ "EUR/PLN": 4.3 }),
          minimum_reserve_enabled: true
        }]);

        const snapshot = await createCashflowStorageSnapshot({
          budgetIds: ["household"],
          budgetStore,
          globalStore,
          reason: "postgres_to_sqlite_round_trip_test"
        });
        assert.equal(snapshot.budgetCount, 1);

        const sqliteTargetDir = path.join(root, "sqlite-target");
        const paths = createCashflowStoragePaths(sqliteTargetDir);
        const dbService = createCashflowDbService({
          ledgerDbPath: paths.ledgerDbPath,
          planningDbPath: paths.planningDbPath,
          userDataDir: paths.userDataDir
        });
        const sqliteBudgetStore = createSqliteBudgetStore({
          listLedgerYears: dbService.listLedgerYears,
          openLedgerDb: dbService.openLedgerDb,
          openPlanningDb: dbService.openPlanningDb
        });
        const sqliteGlobalStore = createSqliteGlobalStore({
          dataDir: sqliteTargetDir,
          listCashflowUserIds: paths.listCashflowUserIds
        });

        const restoreResult = await restoreCashflowStorageSnapshot({
          budgetStore: sqliteBudgetStore,
          globalStore: sqliteGlobalStore,
          snapshot
        });
        assert.equal(restoreResult.ok, true);
        assert.equal(restoreResult.budgetCount, 1);

        const restoredDb = new Database(path.join(sqliteTargetDir, "household", "planning.sqlite"), {
          readonly: true
        });
        try {
          assert.equal(restoredDb.pragma("integrity_check", { simple: true }), "ok");
          const restoredSettings = restoredDb.prepare("SELECT * FROM settings WHERE id = 1").get();
          assert.equal(restoredSettings.ledger_currency, "PLN");
          // Postgres boolean true must become SQLite's integer 1, not fail
          // to bind or silently become NULL/0.
          assert.equal(restoredSettings.minimum_reserve_enabled, 1);
          assert.deepEqual(JSON.parse(restoredSettings.fx_used_currencies), ["EUR", "GBP"]);
          assert.deepEqual(JSON.parse(restoredSettings.manual_fx_rates), { "EUR/PLN": 4.3 });
        } finally {
          restoredDb.close();
        }

        const restoredGlobalDb = new Database(path.join(sqliteTargetDir, "cashflow-global.sqlite"), {
          readonly: true
        });
        try {
          assert.equal(restoredGlobalDb.pragma("integrity_check", { simple: true }), "ok");
          const budgetRow = restoredGlobalDb.prepare("SELECT id, display_name, status FROM budgets WHERE id = ?")
            .get("household");
          assert.equal(budgetRow?.status, "active");
          // auth_sessions.absolute_expires_at is a TIMESTAMPTZ in Postgres
          // (a real Date object coming back), which must become a plain
          // ISO string in SQLite's TEXT column, not fail to bind.
          const sessionRow = restoredGlobalDb.prepare("SELECT id, absolute_expires_at FROM auth_sessions WHERE id = ?")
            .get("session_private");
          assert.equal(typeof sessionRow?.absolute_expires_at, "string");
          assert.ok(!Number.isNaN(Date.parse(sessionRow.absolute_expires_at)));
        } finally {
          restoredGlobalDb.close();
        }
      } finally {
        await budgetStore.close();
        await globalStore.close();
      }
    });
  });
});

test("migrate-postgres-to-sqlite.mjs moves real data from a disposable Postgres database into fresh SQLite files", {
  skip: postgresRuntimeTestsEnabled() ? false : POSTGRES_TEST_SKIP_REASON
}, async () => {
  await withTempDirs(async ({ dataDir, outputDir, root }) => {
    createGlobalSource(dataDir);
    createBudgetStorageSource(dataDir);

    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      const forwardMigration = await migrateSqliteToPostgres({
        databaseUrl,
        dataDir,
        dryRun: false,
        outputDir,
        sourceIsSnapshot: true
      });
      assert.equal(forwardMigration.ok, true);

      const reverseOutputDir = path.join(root, "reverse-exports");
      const targetDataDir = path.join(root, "reverse-sqlite-target");

      const dryRun = await migratePostgresToSqlite({
        databaseUrl,
        dataDir: targetDataDir,
        outputDir: reverseOutputDir
      });
      assert.equal(dryRun.apply, false);
      assert.deepEqual(dryRun.budgetIds, ["household"]);
      assert.equal(fs.existsSync(targetDataDir), false, "dry run must not touch the target data dir");

      const applied = await migratePostgresToSqlite({
        databaseUrl,
        dataDir: targetDataDir,
        dryRun: false,
        outputDir: reverseOutputDir
      });
      assert.equal(applied.ok, true);
      assert.equal(applied.apply, true);
      assert.equal(applied.budget.budgetCount, 1);

      // Applying again into the same, now-occupied directory must refuse
      // without --force, so this can never silently overwrite real data.
      await assert.rejects(
        () => migratePostgresToSqlite({
          databaseUrl,
          dataDir: targetDataDir,
          dryRun: false,
          outputDir: reverseOutputDir
        }),
        /already has a cashflow-global\.sqlite file/
      );

      const verification = verifySqliteMigration({
        dataDir: targetDataDir,
        input: applied.artifacts.exportPath
      });
      assert.equal(verification.ok, true);
      assert.deepEqual(verification.mismatches, []);

      const restoredPlanning = new Database(
        path.join(targetDataDir, "household", "planning.sqlite"),
        { readonly: true }
      );
      try {
        assert.equal(restoredPlanning.pragma("integrity_check", { simple: true }), "ok");
        const oneOff = restoredPlanning.prepare(
          "SELECT name, amount, type, date FROM one_off_transactions WHERE id = ?"
        ).get("oneoff_desk");
        assert.equal(oneOff?.name, "Desk");
        assert.equal(Number(oneOff?.amount), 120);
      } finally {
        restoredPlanning.close();
      }

      const restoredLedger = new Database(
        path.join(targetDataDir, "household", "ledger_2026.sqlite"),
        { readonly: true }
      );
      try {
        assert.equal(restoredLedger.pragma("integrity_check", { simple: true }), "ok");
        const confirmed = restoredLedger.prepare(
          "SELECT name, amount, running_balance_pln FROM confirmed_transactions WHERE id = ?"
        ).get("confirmed_income");
        assert.equal(confirmed?.name, "Confirmed income");
        assert.equal(Number(confirmed?.amount), 500);
        assert.equal(Number(confirmed?.running_balance_pln), 500);
      } finally {
        restoredLedger.close();
      }
    });
  });
});
