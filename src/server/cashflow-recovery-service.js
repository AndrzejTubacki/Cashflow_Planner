export function createCashflowRecoveryService({
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
    const safetyBackup = createBackup(userId);

    try {
      const result = await work();
      if (typeof afterWork === "function") {
        await afterWork({ userId, operation, result, safetyBackup });
      }
      return requireProjectionSuccess(result);
    } catch (error) {
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
      } catch (rollbackError) {
        logError("cashflow_recoverable_mutation_rollback_failed", {
          userId,
          operation,
          safetyBackup,
          error: error.message || String(error),
          rollbackError: rollbackError.message || String(rollbackError)
        });
        const combined = new Error(
          `${operation} failed and rollback also failed. Safety backup: ${safetyBackup}. `
          + `Original error: ${error.message}. Rollback error: ${rollbackError.message}`
        );
        combined.status = 500;
        throw combined;
      }

      throw error;
    }
  }

  return {
    runRecoverableUserMutation
  };
}
