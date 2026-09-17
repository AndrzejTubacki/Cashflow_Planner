import { cashflowErrorMessage, cashflowErrorStack } from "./cashflow-error-utils.js";
import { DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { todayInTimezone } from "./cashflow-date-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { addMoneyAmounts, roundMoneyAmount } from "./cashflow-money-utils.js";
import {
  BUDGET_RUNTIME_LOCK_JOBS,
  budgetRuntimeLockName
} from "./cashflow-runtime-locks.js";

export function createCashflowProjectionCoordinatorService({
  budgetStore = null,
  collectCurrenciesForFxSnapshot,
  confirmedBalanceAsOf = null,
  confirmedBalanceAsOfAsync = null,
  ensureFxCacheForMutation,
  getCachedFxSnapshot,
  getCachedFxSnapshotAsync = null,
  latestConfirmedBalance,
  listCashflowUserIds,
  listCashflowUserIdsAsync = null,
  lockService = null,
  logCashflowError,
  logError,
  logServerEvent,
  openPlanningDb,
  pendingNetBalance,
  pendingNetBalanceAsync = null,
  refreshNbpFxCacheForUser,
  regenerateProjections,
  regenerateProjectionsAsync = null,
  safeGetCurrentFxSnapshot,
  safeGetCurrentFxSnapshotAsync = null
}) {
  function canUseAsyncProjectionEngine() {
    return budgetStore?.backend === "postgres" && typeof regenerateProjectionsAsync === "function";
  }

  async function runProjectionEngine(userId) {
    if (canUseAsyncProjectionEngine()) {
      await regenerateProjectionsAsync(userId);
      return;
    }

    regenerateProjections(userId);
  }
  function regenerateAllUsersAfterFxChange() {
    const userIds = listCashflowUserIds();
    return regenerateUsersAfterFxChange(userIds);
  }

  async function regenerateAllUsersAfterFxChangeAsync() {
    const userIds = typeof listCashflowUserIdsAsync === "function"
      ? await listCashflowUserIdsAsync()
      : listCashflowUserIds();
    return regenerateUsersAfterFxChange(userIds);
  }

  function regenerateUsersAfterFxChange(userIds = []) {
    const results = [];

    for (const userId of userIds) {
      try {
        const projection = regenerateProjectionsAfterMutation(userId);

        logServerEvent("cashflow_fx_change_regenerated", {
          userId,
          projection_ok: projection.projection_ok,
          projection_error: projection.projection_error
        });

        results.push({
          userId,
          ok: projection.projection_ok,
          _projection: projection
        });
      } catch (error) {
        // This should rarely run, because regenerateProjectionsAfterMutation()
        // catches projection errors itself. Keep it as a hard-failure guard.
        logError("cashflow_fx_change_regenerate_failed", {
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

    return {
      users: userIds.length,
      results
    };
  }


  function attachProjection(result, projection) {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return {
        ...result,
        _projection: projection
      };
    }

    return {
      result,
      _projection: projection
    };
  }

  // Every planner mutation (SQLite and Postgres) ends by calling this to
  // regenerate projections and attach the outcome as `_projection`. The
  // Postgres branch must go through the async engine — falling through to
  // the sync branch would silently open SQLite from inside a Postgres
  // mutation, defeating the whole point of the isolated Postgres write path.
  function withProjectionStatus(userId, result, options = {}) {
    if (canUseAsyncProjectionEngine()) {
      const projectionPromise = options.preservePending
        ? regenerateProjectionsPreservingPendingAfterMutationAsync(userId)
        : regenerateProjectionsAfterMutationAsync(userId);

      return projectionPromise.then(projection => attachProjection(result, projection));
    }

    const projection = options.preservePending
      ? regenerateProjectionsPreservingPendingAfterMutation(userId)
      : regenerateProjectionsAfterMutation(userId);

    return attachProjection(result, projection);
  }

  async function regenerateProjectionsWithFxRefresh(userId, options = {}) {
    const {
      date = null,
      allowCachedFxOnRefreshFailure = false,
      refreshFxFirst = true,
      skipProjectionLock = false
    } = options;

    let fxRefresh = null;

    if (refreshFxFirst) {
      try {
        fxRefresh = await refreshNbpFxCacheForUser(userId, date);
      } catch (error) {
        if (!allowCachedFxOnRefreshFailure) {
          throw error;
        }

        logCashflowError("cashflow_fx_refresh_failed_using_cache", error, {
          userId
        });

        fxRefresh = {
          ok: false,
          provider_refresh_failed: true,
          status: Number(error.status || 500),
          error: cashflowErrorMessage(error)
        };
      }
    }

    const projectionWork = async () => {
      await clearPendingIfItCausesNegativeOpeningBalanceAsync(userId);
      await runProjectionEngine(userId);
      return {
        projection_ok: true,
        projection_error: null
      };
    };
    const projection = skipProjectionLock
      ? await projectionWork()
      : await runProjectionWithOptionalLock(userId, projectionWork);

    return {
      ...projection,
      fx_refresh: fxRefresh
    };
  }

  async function runProjectionWithOptionalLock(userId, work) {
    if (!lockService || typeof lockService.withLock !== "function") {
      return work();
    }

    const lockName = budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.projection);
    const lockResult = await lockService.withLock(lockName, work, {
      ttlMs: 120_000
    });
    if (!lockResult?.acquired) {
      logServerEvent("cashflow_projection_lock_skipped", {
        lockName,
        userId
      });
      return {
        projection_ok: false,
        projection_error: "Projection is already running",
        projection_skipped: true
      };
    }

    return lockResult.result;
  }

  function regenerateProjectionsAfterMutation(userId) {
    return projectionStatusFor(userId, () => regenerateProjectionsAfterClearingNegativePending(userId), {
      logKind: "cashflow_projection_after_mutation_failed"
    });
  }

  async function regenerateProjectionsAfterMutationAsync(userId) {
    return await projectionStatusForAsync(
      userId,
      () => runProjectionWithOptionalLock(userId, async () => {
        await clearPendingIfItCausesNegativeOpeningBalanceAsync(userId);
        await runProjectionEngine(userId);
        return {
          projection_ok: true,
          projection_error: null
        };
      }),
      {
        logKind: "cashflow_projection_after_mutation_failed"
      }
    );
  }

  function regenerateProjectionsPreservingPendingAfterMutation(userId) {
    return projectionStatusFor(userId, () => regenerateProjections(userId), {
      logKind: "cashflow_projection_preserve_pending_after_mutation_failed"
    });
  }

  async function regenerateProjectionsPreservingPendingAfterMutationAsync(userId) {
    return await projectionStatusForAsync(userId, () => runProjectionEngine(userId), {
      logKind: "cashflow_projection_preserve_pending_after_mutation_failed"
    });
  }

  function projectionStatusFor(userId, regenerateFn, { logKind }) {
    try {
      regenerateFn();

      return {
        projection_ok: true,
        projection_error: null
      };
    } catch (error) {
      logCashflowError(logKind, error, {
        userId
      });

      const db = openPlanningDb(userId);

      try {
        recordProjectionFailure(
          db,
          userId,
          error,
          safeGetCurrentFxSnapshot(userId) || getCachedFxSnapshot(userId)
        );
      } finally {
        db.close();
      }

      return {
        projection_ok: false,
        projection_error: cashflowErrorMessage(error)
      };
    }
  }

  async function projectionStatusForAsync(userId, regenerateFn, { logKind }) {
    try {
      const result = await regenerateFn();
      if (
        result &&
        typeof result === "object" &&
        Object.prototype.hasOwnProperty.call(result, "projection_ok")
      ) {
        return result;
      }

      return {
        projection_ok: true,
        projection_error: null
      };
    } catch (error) {
      logCashflowError(logKind, error, {
        userId
      });

      try {
        const currentSnapshot = typeof safeGetCurrentFxSnapshotAsync === "function"
          ? await safeGetCurrentFxSnapshotAsync(userId)
          : safeGetCurrentFxSnapshot(userId);
        const fxSnapshot = currentSnapshot || (
          typeof getCachedFxSnapshotAsync === "function"
            ? await getCachedFxSnapshotAsync(userId)
            : getCachedFxSnapshot(userId)
        );

        await recordProjectionFailureAsync(
          userId,
          error,
          fxSnapshot
        );
      } catch (recordError) {
        logCashflowError("cashflow_projection_failure_record_failed", recordError, {
          userId
        });
      }

      return {
        projection_ok: false,
        projection_error: cashflowErrorMessage(error)
      };
    }
  }

  function clearPendingIfItCausesNegativeOpeningBalance(userId) {
    if (typeof latestConfirmedBalance !== "function" || typeof pendingNetBalance !== "function") {
      return null;
    }

    const db = openPlanningDb(userId);
    try {
      const settings = db.prepare("SELECT timezone FROM settings WHERE id = 1").get() || {};
      const today = todayInTimezone(settings.timezone || DEFAULT_TIMEZONE);
      const confirmedBalance = roundMoneyAmount(typeof confirmedBalanceAsOf === "function"
        ? confirmedBalanceAsOf(db, userId, today)
        : latestConfirmedBalance(userId));
      const pendingBalance = roundMoneyAmount(pendingNetBalance(db));
      const clearablePendingBalance = roundMoneyAmount(db.prepare(`
        SELECT COALESCE(SUM(
          CASE
            WHEN type = 'income' THEN COALESCE(ledger_amount, 0)
            ELSE -COALESCE(ledger_amount, 0)
          END
        ), 0) AS value
        FROM pending_transactions
        WHERE COALESCE(pending_origin, 'projection') IN ('projection', 'scheduled')
      `).get().value);
      const openingBalance = addMoneyAmounts(confirmedBalance, pendingBalance);
      const clearableOpeningBalance = addMoneyAmounts(confirmedBalance, clearablePendingBalance);

      if (
        confirmedBalance >= 0 &&
        pendingBalance < 0 &&
        openingBalance < 0 &&
        clearablePendingBalance < 0 &&
        clearableOpeningBalance < 0
      ) {
        const result = db.prepare(`
          DELETE FROM pending_transactions
          WHERE COALESCE(pending_origin, 'projection') IN ('projection', 'scheduled')
        `).run();
        logServerEvent("cashflow_pending_cleared_negative_opening_balance", {
          userId,
          confirmedBalance,
          pendingBalance,
          clearablePendingBalance,
          deletedPendingCount: result.changes || 0
        });
        return result.changes || 0;
      }

      return null;
    } finally {
      db.close();
    }
  }

  async function clearPendingIfItCausesNegativeOpeningBalanceAsync(userId) {
    if (
      !budgetStore ||
      typeof budgetStore.listPlanningRows !== "function" ||
      typeof budgetStore.deletePlanningRowsById !== "function" ||
      typeof confirmedBalanceAsOfAsync !== "function" ||
      typeof pendingNetBalanceAsync !== "function"
    ) {
      return clearPendingIfItCausesNegativeOpeningBalance(userId);
    }

    const work = async store => {
      const settingsRows = await store.listPlanningRows(userId, "settings");
      const settings = settingsRows?.[0] || {};
      const today = todayInTimezone(settings.timezone || DEFAULT_TIMEZONE);
      const confirmedBalance = roundMoneyAmount(await confirmedBalanceAsOfAsync(userId, today, settings, store));
      const pendingRows = await store.listPlanningRows(userId, "pending_transactions");
      const pendingBalance = roundMoneyAmount(await pendingNetBalanceAsync(userId, settings, store));
      const clearableRows = pendingRows.filter(row => {
        const origin = row.pending_origin || "projection";
        return origin === "projection" || origin === "scheduled";
      });
      const clearablePendingBalance = roundMoneyAmount(clearableRows.reduce((total, row) => {
        const amount = roundMoneyAmount(row.ledger_amount);
        return row.type === "income"
          ? addMoneyAmounts(total, amount)
          : addMoneyAmounts(total, -amount);
      }, 0));
      const openingBalance = addMoneyAmounts(confirmedBalance, pendingBalance);
      const clearableOpeningBalance = addMoneyAmounts(confirmedBalance, clearablePendingBalance);

      if (
        confirmedBalance >= 0 &&
        pendingBalance < 0 &&
        openingBalance < 0 &&
        clearablePendingBalance < 0 &&
        clearableOpeningBalance < 0
      ) {
        const result = await store.deletePlanningRowsById(
          userId,
          "pending_transactions",
          clearableRows.map(row => row.id)
        );
        const deletedPendingCount = Number(result?.deleted || 0);
        logServerEvent("cashflow_pending_cleared_negative_opening_balance", {
          userId,
          confirmedBalance,
          pendingBalance,
          clearablePendingBalance,
          deletedPendingCount
        });
        return deletedPendingCount;
      }

      return null;
    };

    if (typeof budgetStore.transaction === "function") {
      return await budgetStore.transaction(work);
    }

    return await work(budgetStore);
  }

  function regenerateProjectionsAfterClearingNegativePending(userId) {
    clearPendingIfItCausesNegativeOpeningBalance(userId);
    return regenerateProjections(userId);
  }

  async function countPendingTransactions(userId) {
    if (budgetStore && typeof budgetStore.listPlanningRows === "function") {
      return (await budgetStore.listPlanningRows(userId, "pending_transactions")).length;
    }

    const db = openPlanningDb(userId);
    try {
      return db.prepare("SELECT COUNT(*) AS count FROM pending_transactions").get().count || 0;
    } finally {
      db.close();
    }
  }

  async function clearPendingTransactions(userId) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return await budgetStore.transaction(async writer => {
        if (typeof writer.lockBudgetLedger === "function") {
          await writer.lockBudgetLedger(userId);
        }
        const ids = (await writer.listPlanningRows(userId, "pending_transactions"))
          .map(row => row.id);
        if (!ids.length) return 0;

        const result = await writer.deletePlanningRowsById(userId, "pending_transactions", ids);
        return Number(result?.deleted || 0);
      });
    }

    const db = openPlanningDb(userId);

    try {
      return db.transaction(() => {
        const result = db.prepare("DELETE FROM pending_transactions").run();
        return result.changes || 0;
      })();
    } finally {
      db.close();
    }
  }

  function recordProjectionFailure(db, userId, error, fxSnapshot = null) {
    const now = new Date().toISOString();
    const settings = db.prepare("SELECT ledger_currency FROM settings WHERE id = 1").get() || {};

    db.prepare(`
      INSERT INTO projection_snapshots (
        id,
        snapshot_timestamp,
        total_projected_income,
        total_projected_expenses,
        available_balance,
        fx_rates_used,
        ledger_currency,
        generation_succeeded,
        warning_count,
        created_at
      ) VALUES (?, ?, 0, 0, 0, ?, ?, 0, 1, datetime('now'))
    `).run(
      generateId("snapshot"),
      now,
      JSON.stringify(fxSnapshot || {}),
      settings.ledger_currency || "PLN"
    );

    db.prepare(`
      INSERT INTO event_log (
        id,
        action,
        entity_type,
        entity_id,
        details,
        timestamp
      ) VALUES (?, 'projection_failed', 'cashflow', ?, ?, datetime('now'))
    `).run(
      generateId("event"),
      userId,
      JSON.stringify({
        message: cashflowErrorMessage(error),
        stack: cashflowErrorStack(error)
      })
    );
  }

  async function recordProjectionFailureAsync(userId, error, fxSnapshot = null) {
    if (!userId) return { recorded: false };

    if (
      budgetStore &&
      (
        typeof budgetStore.insertPlanningRows === "function" ||
        typeof budgetStore.transaction === "function"
      )
    ) {
      const writeFailureRows = async writer => {
        if (typeof writer.insertPlanningRows !== "function") {
          throw new Error("Budget-store projection failure recorder requires insertPlanningRows");
        }
        const now = new Date().toISOString();
        const settingsRows = typeof writer.listPlanningRows === "function"
          ? await writer.listPlanningRows(userId, "settings")
          : await budgetStore.listPlanningRows(userId, "settings");
        const settings = settingsRows?.[0] || {};

        await writer.insertPlanningRows(userId, "projection_snapshots", [{
          id: generateId("snapshot"),
          snapshot_timestamp: now,
          total_projected_income: 0,
          total_projected_expenses: 0,
          available_balance: 0,
          fx_rates_used: JSON.stringify(fxSnapshot || {}),
          ledger_currency: settings.ledger_currency || "PLN",
          generation_succeeded: false,
          warning_count: 1,
          created_at: now
        }]);

        await writer.insertPlanningRows(userId, "event_log", [{
          id: generateId("event"),
          action: "projection_failed",
          entity_type: "cashflow",
          entity_id: userId,
          details: JSON.stringify({
            message: cashflowErrorMessage(error),
            stack: cashflowErrorStack(error)
          }),
          timestamp: now
        }]);

        return { recorded: true };
      };

      if (typeof budgetStore.transaction === "function") {
        return await budgetStore.transaction(writeFailureRows);
      }

      return await writeFailureRows(budgetStore);
    }

    const db = openPlanningDb(userId);

    try {
      recordProjectionFailure(db, userId, error, fxSnapshot);
      return { recorded: true };
    } finally {
      db.close();
    }
  }

  return {
    clearPendingTransactions,
    countPendingTransactions,
    recordProjectionFailure,
    recordProjectionFailureAsync,
    regenerateAllUsersAfterFxChange,
    regenerateAllUsersAfterFxChangeAsync,
    regenerateProjectionsAfterMutation,
    regenerateProjectionsAfterMutationAsync,
    regenerateProjectionsWithFxRefresh,
    withProjectionStatus
  };
}
