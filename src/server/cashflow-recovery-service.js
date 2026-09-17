export function createCashflowRecoveryService({
  budgetStore = null,
  cleanupOperationalData = () => null,
  createBackup,
  createBackupAsync = null,
  logError,
  logServerEvent,
  restoreBackupFromPath,
  restoreBackupFromPathAsync = null,
  afterWork = null
}) {
  function usesPostgresBudgetStore() {
    return budgetStore?.backend === "postgres"
      && typeof createBackupAsync === "function"
      && typeof restoreBackupFromPathAsync === "function";
  }

  function requireProjectionSuccess(result) {
    if (result?._projection?.projection_ok === false) {
      const error = new Error(`Projection regeneration failed: ${result._projection.projection_error || "unknown error"}`);
      error.status = 500;
      throw error;
    }
    return result;
  }

  async function runRecoverableUserMutation(userId, operation, work) {
    const usePostgres = usesPostgresBudgetStore();
    // Neither SQLite (planning plus yearly ledger files) nor the Postgres
    // budget-store writer surface can atomically cover a whole planner
    // mutation today, so both paths restore a full snapshot on failure.
    const safetyBackup = usePostgres
      ? await createBackupAsync(userId, { deferCleanup: true })
      : createBackup(userId, { deferCleanup: true });

    try {
      const result = await work();
      if (typeof afterWork === "function") {
        await afterWork({ userId, operation, result, safetyBackup });
      }
      const successful = requireProjectionSuccess(result);
      // Retention cleanup is SQLite-only (it opens openPlanningDb directly)
      // and would otherwise create a stray, disconnected local planning.sqlite
      // file as a side effect for a Postgres-backed budget, so it's skipped
      // there rather than called best-effort. Best-effort retention isn't
      // critical to correctness either way.
      if (!usePostgres) cleanupOperationalData(userId, `${operation}_completed`);
      return successful;
    } catch (error) {
      logError("cashflow_recoverable_mutation_failed_before_rollback", {
        userId,
        operation,
        safetyBackup,
        error: error.message || String(error)
      });
      try {
        const rollbackProjection = usePostgres
          ? await restoreBackupFromPathAsync(userId, safetyBackup)
          : restoreBackupFromPath(userId, safetyBackup);
        if (rollbackProjection?.projection_ok === false) {
          throw new Error(`Rollback projection regeneration failed: ${rollbackProjection.projection_error || "unknown error"}`);
        }
        logServerEvent("cashflow_recoverable_mutation_rolled_back", {
          userId,
          operation,
          safetyBackup,
          error: error.message || String(error)
        });
        if (!usePostgres) cleanupOperationalData(userId, `${operation}_rolled_back`);
      } catch (rollbackError) {
        logError("cashflow_recoverable_mutation_rollback_failed", {
          userId,
          operation,
          safetyBackup,
          error: error.message || String(error),
          rollbackError: rollbackError.message || String(rollbackError)
        });
        const combined = new Error(`${operation} failed and rollback also failed`);
        combined.status = 500;
        combined.details = {
          phase: "rollback_failed",
          safetyBackup,
          originalError: error.message,
          originalStatus: Number(error?.status) || 500,
          rollbackError: rollbackError.message
        };
        throw combined;
      }

      throw error;
    }
  }

  return {
    runRecoverableUserMutation
  };
}
