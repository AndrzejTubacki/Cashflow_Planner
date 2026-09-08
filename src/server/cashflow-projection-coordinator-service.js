import { cashflowErrorMessage, cashflowErrorStack } from "./cashflow-error-utils.js";
import { DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { todayInTimezone } from "./cashflow-date-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { addMoneyAmounts, roundMoneyAmount } from "./cashflow-money-utils.js";

export function createCashflowProjectionCoordinatorService({
  collectCurrenciesForFxSnapshot,
  confirmedBalanceAsOf = null,
  ensureFxCacheForMutation,
  getCachedFxSnapshot,
  latestConfirmedBalance,
  listCashflowUserIds,
  logCashflowError,
  logError,
  logServerEvent,
  openPlanningDb,
  pendingNetBalance,
  refreshNbpFxCacheForUser,
  regenerateProjections,
  safeGetCurrentFxSnapshot
}) {
  function regenerateAllUsersAfterFxChange() {
    const userIds = listCashflowUserIds();
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


  function withProjectionStatus(userId, result, options = {}) {
    const projection = options.preservePending
      ? regenerateProjectionsPreservingPendingAfterMutation(userId)
      : regenerateProjectionsAfterMutation(userId);

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

  async function regenerateProjectionsWithFxRefresh(userId, options = {}) {
    const {
      date = null,
      allowCachedFxOnRefreshFailure = false,
      refreshFxFirst = true
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

    regenerateProjectionsAfterClearingNegativePending(userId);

    return {
      projection_ok: true,
      projection_error: null,
      fx_refresh: fxRefresh
    };
  }

  function regenerateProjectionsAfterMutation(userId) {
    return projectionStatusFor(userId, () => regenerateProjectionsAfterClearingNegativePending(userId), {
      logKind: "cashflow_projection_after_mutation_failed"
    });
  }

  function regenerateProjectionsPreservingPendingAfterMutation(userId) {
    return projectionStatusFor(userId, () => regenerateProjections(userId), {
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

  function regenerateProjectionsAfterClearingNegativePending(userId) {
    clearPendingIfItCausesNegativeOpeningBalance(userId);
    return regenerateProjections(userId);
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

  return {
    recordProjectionFailure,
    regenerateAllUsersAfterFxChange,
    regenerateProjectionsAfterMutation,
    regenerateProjectionsWithFxRefresh,
    withProjectionStatus
  };
}
