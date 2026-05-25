import { createCashflowErrorLogger } from "./server/cashflow-error-utils.js";
import { normalizeCurrency } from "./server/cashflow-money-utils.js";
import { createCashflowStoragePaths } from "./server/cashflow-storage-utils.js";
import { registerCashflowRoutes } from "./server/cashflow-routes.js";
import { createCashflowBackupService } from "./server/cashflow-backup-service.js";
import { createCashflowBackgroundJobs } from "./server/cashflow-background-jobs.js";
import { createCashflowPredictionService } from "./server/cashflow-prediction-service.js";
import { createCashflowNotificationService } from "./server/cashflow-notification-service.js";
import { createCashflowFxCacheService } from "./server/cashflow-fx-cache-service.js";
import { createCashflowSnapshotService } from "./server/cashflow-snapshot-service.js";
import { createCashflowLedgerService } from "./server/cashflow-ledger-service.js";
import { createCashflowSettingsService } from "./server/cashflow-settings-service.js";
import { createCashflowDbService } from "./server/cashflow-db-service.js";
import { createCashflowProjectionStateService } from "./server/cashflow-projection-state-service.js";
import { createCashflowPlanMutationService } from "./server/cashflow-plan-mutation-service.js";
import { createCashflowPendingTransitionService } from "./server/cashflow-pending-transition-service.js";
import { createCashflowPendingConfirmationService } from "./server/cashflow-pending-confirmation-service.js";
import { createCashflowConfirmedFxService } from "./server/cashflow-confirmed-fx-service.js";
import { createCashflowProjectionEngineService } from "./server/cashflow-projection-engine-service.js";
import { createCashflowProjectionCoordinatorService } from "./server/cashflow-projection-coordinator-service.js";
import { createCashflowLocaleService } from "./server/cashflow-locale-utils.js";
import { generateId } from "./server/cashflow-id-utils.js";
import {
  buildBudgetPeriods,
  buildPeriodSummariesFromDefinitions
} from "./server/cashflow-period-utils.js";

function createCashflowModule({
  appVersion = "0.0.0",
  dataDir,
  localeDir,
  getCurrentFxSnapshot,
  getFxSnapshotForDate = null,
  logError,
  logServerEvent,
  appendApiLogLine
}) {
  // Resolve all per-user file paths: planning DB, yearly ledger DBs, and backup folders.
  const {
    backupRootDir,
    directorySizeBytes,
    ledgerDbPath,
    listCashflowUserIds,
    planningDbPath,
    userDataDir
  } = createCashflowStoragePaths(dataDir);

  const {
    listAvailableLocales,
    normalizeLocale,
    translateLocale
  } = createCashflowLocaleService(localeDir);

  // Open and migrate SQLite databases, and expose ledger-year discovery.
  const {
    initReadOnlyPragmas,
    listLedgerYears,
    openLedgerDb,
    openPlanningDb
  } = createCashflowDbService({
    ledgerDbPath,
    planningDbPath,
    userDataDir
  });

  // Wrap host logging with Cashflow-specific error metadata.
  const logCashflowError = createCashflowErrorLogger(logError);

  // Manage FX cache reads, NBP fetches, and projection refreshes after FX changes.
  const {
    collectCurrenciesForFxSnapshot,
    ensureFxCacheForMutation,
    fetchProviderRate,
    fetchNbpFxSnapshot,
    fetchNbpRate,
    getCachedFxRate,
    getCachedFxSnapshot,
    getFxProviderSettings,
    refreshNbpFxCacheForAllUsers,
    refreshNbpFxCacheForUser,
    safeGetCurrentFxSnapshot,
    upsertFxCacheRate
  } = createCashflowFxCacheService({
    getCurrentFxSnapshot,
    listCashflowUserIds,
    logCashflowError,
    logError,
    logServerEvent,
    normalizeCurrency,
    openPlanningDb,
    regenerateProjectionsAfterMutation
  });

  // Resolve historical FX rates for confirmed ledger entries.
  const {
    getConfirmedFxForDate
  } = createCashflowConfirmedFxService({
    fetchProviderRate,
    fetchNbpRate,
    getCachedFxRate,
    getFxProviderSettings,
    getFxSnapshotForDate,
    upsertFxCacheRate
  });

  // Read/write confirmed ledger rows and calculate confirmed/pending funding totals.
  const {
    hasAnyConfirmedTransactions,
    latestConfirmedBalance,
    loadAllConfirmedTransactions,
    newestConfirmedTransactionDate,
    recalculateLedgerRunningBalance,
    sumConfirmedFunding,
    sumPendingFunding,
    wouldLedgerGoNegativeAfterInsert
  } = createCashflowLedgerService({
    listLedgerYears,
    openLedgerDb,
    openPlanningDb
  });

  // Keep planning-table state coherent: pending rows, running balances, and occurrence keys.
  const {
    confirmedOccurrenceKeys,
    confirmedOneOffSourceIds,
    deletePendingOccurrence,
    findConfirmedOccurrence,
    normalizePendingStatus,
    normalizeRecurringInput,
    pendingOccurrenceExists,
    pendingOccurrenceRow,
    pendingNetBalance,
    planningOpeningBalance,
    recalculatePlanningRunningBalances,
    refreshPendingOccurrence,
    requireStartMonthYearIfNeeded
  } = createCashflowProjectionStateService({
    latestConfirmedBalance,
    listLedgerYears,
    loadAllConfirmedTransactions,
    openLedgerDb
  });

  // Move generated future rows into pending when they become actionable.
  const {
    moveDueFutureTransactionsToPending,
    moveFutureTransactionToPending
  } = createCashflowPendingTransitionService({
    normalizePendingStatus,
    openPlanningDb,
    recalculatePlanningRunningBalances,
    withProjectionStatus
  });

  // Read and update global Cashflow settings.
  const {
    getSettings,
    updateSettings
  } = createCashflowSettingsService({
    normalizeLocale,
    openPlanningDb
  });

  // Create, update, delete planned entities, then recalculate affected projection state.
  const {
    createFlexTransaction,
    createGoal,
    createOneOffTransaction,
    createRecurringExpense,
    createRecurringIncome,
    deleteFlexTransaction,
    deleteGoal,
    deleteOneOffTransaction,
    deleteRecurringExpense,
    deleteRecurringIncome,
    updateFlexTransaction,
    updateGoal,
    updateOneOffTransaction,
    updatePendingTransaction,
    updateRecurringExpense,
    updateRecurringIncome
  } = createCashflowPlanMutationService({
    loadAllConfirmedTransactions,
    newestConfirmedTransactionDate,
    normalizeRecurringInput,
    openPlanningDb,
    recalculatePlanningRunningBalances,
    requireStartMonthYearIfNeeded,
    withProjectionStatus
  });

  // Convert a pending row into a confirmed yearly ledger entry.
  const {
    confirmPendingTransaction
  } = createCashflowPendingConfirmationService({
    deletePendingOccurrence,
    findConfirmedOccurrence,
    getConfirmedFxForDate,
    newestConfirmedTransactionDate,
    openLedgerDb,
    openPlanningDb,
    recalculateLedgerRunningBalance,
    withProjectionStatus,
    wouldLedgerGoNegativeAfterInsert
  });

  let projectionCoordinator = null;

  function requireProjectionCoordinator() {
    // Several services call projection operations before the coordinator variable is assigned.
    if (!projectionCoordinator) {
      throw new Error("Cashflow projection coordinator is not initialized");
    }

    return projectionCoordinator;
  }

  function regenerateAllUsersAfterFxChange() {
    // Rebuild projections for every user after shared FX rates change.
    return requireProjectionCoordinator().regenerateAllUsersAfterFxChange();
  }

  function withProjectionStatus(userId, result) {
    // Attach projection success/failure metadata to mutation responses.
    return requireProjectionCoordinator().withProjectionStatus(userId, result);
  }

  async function regenerateProjectionsWithFxRefresh(userId, options = {}) {
    // Refresh FX first when requested, then rebuild projections for one user.
    return requireProjectionCoordinator().regenerateProjectionsWithFxRefresh(userId, options);
  }

  function regenerateProjectionsAfterMutation(userId) {
    // Rebuild projections after a planned, pending, or confirmed transaction changes.
    return requireProjectionCoordinator().regenerateProjectionsAfterMutation(userId);
  }

  function recordProjectionFailure(db, userId, error, fxSnapshot = null) {
    // Persist projection failure details for diagnostics in the snapshot/API.
    return requireProjectionCoordinator().recordProjectionFailure(db, userId, error, fxSnapshot);
  }

  let projectionEngine = null;

  function regenerateProjections(userId) {
    // Low-level projection rebuild delegated to the engine once it is wired.
    if (!projectionEngine) {
      throw new Error("Cashflow projection engine is not initialized");
    }

    return projectionEngine.regenerateProjections(userId);
  }

  // Create/restore backups and validate data integrity before risky operations.
  const {
    cleanupOldBackups,
    createBackup,
    maybeRunAutomaticBackup,
    restoreBackup,
    validateBackupFolderForRestore,
    validateCashflowData
  } = createCashflowBackupService({
    backupRootDir,
    directorySizeBytes,
    generateId,
    getSettings,
    initReadOnlyPragmas,
    listLedgerYears,
    openLedgerDb,
    openPlanningDb,
    recalculateLedgerRunningBalance,
    regenerateProjectionsAfterMutation
  });

  // Predict recurring amounts from historical ledger rows when a rule uses prediction.
  const {
    loadConfirmedTransactions,
    predictedAmountForRecurringExpense,
    predictedAmountForRecurringIncome
  } = createCashflowPredictionService({
    listLedgerYears,
    openLedgerDb
  });

  function registerRoutes(app) {
    // Bind all HTTP routes to the functions assembled above.
    registerCashflowRoutes(app, {
      collectCurrenciesForFxSnapshot,
      confirmPendingTransaction,
      createBackup,
      appVersion,
      createFlexTransaction,
      createGoal,
      createOneOffTransaction,
      createRecurringExpense,
      createRecurringIncome,
      deleteFlexTransaction,
      deleteGoal,
      deleteOneOffTransaction,
      deleteRecurringExpense,
      deleteRecurringIncome,
      ensureFxCacheForMutation,
      fetchNbpFxSnapshot,
      fetchNbpRate,
      getCachedFxSnapshot,
      getSnapshot,
      listAvailableLocales,
      logCashflowError,
      logError,
      moveFutureTransactionToPending,
      openPlanningDb,
      recordProjectionFailure,
      refreshNbpFxCacheForAllUsers,
      regenerateProjectionsWithFxRefresh,
      resolveRequestUser,
      restoreBackup,
      safeGetCurrentFxSnapshot,
      updateFlexTransaction,
      updateGoal,
      updateOneOffTransaction,
      updatePendingTransaction,
      updateRecurringExpense,
      updateRecurringIncome,
      updateSettings,
      translateLocale,
      validateCashflowData,
      withProjectionStatus
    });
  }

  // Build the full API snapshot consumed by the browser app.
  const { getSnapshot } = createCashflowSnapshotService({
    buildBudgetPeriods,
    buildPeriodSummariesFromDefinitions,
    getCachedFxSnapshot,
    loadAllConfirmedTransactions,
    openPlanningDb,
    listAvailableLocales,
    predictedAmountForRecurringExpense,
    safeGetCurrentFxSnapshot,
    sumConfirmedFunding
  });

  // Queue and send user-facing notifications for shortfalls, pending summaries, and goals.
  const {
    notificationEnabled,
    notificationPriority,
    queueDailyPendingSummary,
    queueMissingIncomeNotifications,
    queueNotification,
    sendQueuedNotifications
  } = createCashflowNotificationService({
    generateId,
    listLedgerYears,
    openLedgerDb,
    openPlanningDb
  });

  // Generate future transactions and allocation projections for one user.
  projectionEngine = createCashflowProjectionEngineService({
    confirmedOccurrenceKeys,
    confirmedOneOffSourceIds,
    deletePendingOccurrence,
    getCachedFxSnapshot,
    logServerEvent,
    notificationEnabled,
    notificationPriority,
    openPlanningDb,
    planningOpeningBalance,
    predictedAmountForRecurringExpense,
    predictedAmountForRecurringIncome,
    queueNotification,
    recalculatePlanningRunningBalances,
    refreshPendingOccurrence,
    safeGetCurrentFxSnapshot,
    sumConfirmedFunding,
    sumPendingFunding
  });

  // Coordinate projection runs, FX refreshes, status capture, and all-user rebuilds.
  projectionCoordinator = createCashflowProjectionCoordinatorService({
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
  });

  function resolveRequestUser(req) {
    // The standalone UI uses local; API clients can select another user with this header.
    const userId = req.headers["x-cashflow-user-id"] || "local";
    return String(userId).trim() || "local";
  }

  // Schedule recurring maintenance: midnight transitions, FX refresh, notifications, backups.
  const { startBackgroundJobs } = createCashflowBackgroundJobs({
    getSettings,
    listCashflowUserIds,
    logCashflowError,
    logError,
    logServerEvent,
    maybeRunAutomaticBackup,
    moveDueFutureTransactionsToPending,
    queueDailyPendingSummary,
    queueMissingIncomeNotifications,
    refreshNbpFxCacheForAllUsers,
    sendQueuedNotifications
  });

  // Public module surface consumed by server.mjs and tests.
  return {
    registerRoutes,
    startBackgroundJobs,
    getSnapshot,
    getSettings,
    updateSettings,
    regenerateAllUsersAfterFxChange,
    refreshNbpFxCacheForUser,
    refreshNbpFxCacheForAllUsers
  };
}
export { createCashflowModule };





