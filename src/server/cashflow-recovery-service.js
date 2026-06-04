export function createCashflowRecoveryService({
  cleanupOperationalData = () => null,
  createBackup,
  logError,
  logServerEvent,
  restoreBackupFromPath,
  afterWork = null
}) {
  function requireProjectionSuccess(result) {
    if (result?._projection?.projection_ok === false) {
      const error = new Error(`Projection regeneration failed: ${result._projection.projection_error || "unknown error"}`);
      error.status = 500;
      throw error;
    }
    return result;
  }

  async function runRecoverableUserMutation(userId, operation, work) {
    // SQLite cannot atomically cover planning plus yearly ledger files, so restore a full snapshot on failure.
    const safetyBackup = createBackup(userId, { deferCleanup: true });

    try {
      const result = await work();
      if (typeof afterWork === "function") {
        await afterWork({ userId, operation, result, safetyBackup });
      }
      const successful = requireProjectionSuccess(result);
      cleanupOperationalData(userId, `${operation}_completed`);
      return successful;
    } catch (error) {
      logError("cashflow_recoverable_mutation_failed_before_rollback", {
        userId,
        operation,
        safetyBackup,
        error: error.message || String(error)
      });
      try {
        const rollbackProjection = restoreBackupFromPath(userId, safetyBackup);
        if (rollbackProjection?.projection_ok === false) {
          throw new Error(`Rollback projection regeneration failed: ${rollbackProjection.projection_error || "unknown error"}`);
        }
        logServerEvent("cashflow_recoverable_mutation_rolled_back", {
          userId,
          operation,
          safetyBackup,
          error: error.message || String(error)
        });
        cleanupOperationalData(userId, `${operation}_rolled_back`);
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
