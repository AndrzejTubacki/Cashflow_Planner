import { cashflowErrorMessage, cashflowErrorStack } from "./cashflow-error-utils.js";
import { generateId } from "./cashflow-id-utils.js";

export function createCashflowProjectionCoordinatorService({
  collectCurrenciesForFxSnapshot,
  ensureFxCacheForMutation,
  getCachedFxSnapshot,
  listCashflowUserIds,
  logCashflowError,
  logError,
  logServerEvent,
  openPlanningDb,
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


  function withProjectionStatus(userId, result) {
    const projection = regenerateProjectionsAfterMutation(userId);

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
      refreshFxFirst = true
    } = options;

    let fxRefresh = null;

    if (refreshFxFirst) {
      fxRefresh = await refreshNbpFxCacheForUser(userId, date);
    }

    regenerateProjections(userId);

    return {
      projection_ok: true,
      projection_error: null,
      fx_refresh: fxRefresh
    };
  }

  function regenerateProjectionsAfterMutation(userId) {
    try {
      regenerateProjections(userId);

      return {
        projection_ok: true,
        projection_error: null
      };
    } catch (error) {
      logCashflowError("cashflow_projection_after_mutation_failed", error, {
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

  function recordProjectionFailure(db, userId, error, fxSnapshot = null) {
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO projection_snapshots (
        id,
        snapshot_timestamp,
        total_projected_income,
        total_projected_expenses,
        available_balance,
        fx_rates_used,
        generation_succeeded,
        warning_count,
        created_at
      ) VALUES (?, ?, 0, 0, 0, ?, 0, 1, datetime('now'))
    `).run(
      generateId("snapshot"),
      now,
      JSON.stringify(fxSnapshot || {})
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
