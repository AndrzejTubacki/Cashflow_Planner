import fs from "node:fs";
import path from "node:path";

import { createCashflowErrorLogger } from "./server/cashflow-error-utils.js";
import { normalizeCurrency } from "./server/cashflow-money-utils.js";
import { createCashflowStoragePaths } from "./server/cashflow-storage-utils.js";
import { registerCashflowRoutes } from "./server/cashflow-routes.js";
import { createCashflowBackupService } from "./server/cashflow-backup-service.js";
import { createCashflowBudgetService } from "./server/cashflow-budget-service.js";
import { createCashflowDataPortabilityService } from "./server/cashflow-data-portability-service.js";
import { createCashflowGlobalService } from "./server/cashflow-global-service.js";
import {
  createCashflowSessionService,
  sessionTokenFromRequest
} from "./server/cashflow-session-service.js";
import { createCashflowSetupService } from "./server/cashflow-setup-service.js";
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
import { createCashflowRecoveryService } from "./server/cashflow-recovery-service.js";
import { createCashflowLocaleService } from "./server/cashflow-locale-utils.js";
import { validatePlanMutationInput } from "./server/cashflow-plan-input-validation.js";
import { generateId } from "./server/cashflow-id-utils.js";
import { badRequest } from "./server/cashflow-user-utils.js";
import {
  buildBudgetPeriods,
  buildPeriodSummariesFromDefinitions
} from "./server/cashflow-period-utils.js";

const DEFAULT_DELETED_BUDGET_RECOVERY_RETENTION_COUNT = 5;

function normalizeRetentionCount(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return number;
}

function deletedBudgetRecoveryRetentionCount(env = process.env) {
  return normalizeRetentionCount(
    env.CASHFLOW_DELETED_BUDGET_RECOVERY_RETENTION_COUNT,
    DEFAULT_DELETED_BUDGET_RECOVERY_RETENTION_COUNT
  );
}

function cleanupDeletedBudgetRecoveries(recoveryDir, {
  protectedPaths = [],
  retentionCount = deletedBudgetRecoveryRetentionCount()
} = {}) {
  if (!fs.existsSync(recoveryDir) || !fs.statSync(recoveryDir).isDirectory()) {
    return { deleted: 0, retained: 0 };
  }

  const protectedSet = new Set(protectedPaths.map(item => path.resolve(item)));
  const recoveries = fs.readdirSync(recoveryDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^budget_.+\.json$/.test(entry.name))
    .map(entry => {
      const fullPath = path.join(recoveryDir, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        path: fullPath,
        mtimeMs: stat.mtimeMs,
        name: entry.name
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const protectedRecoveries = recoveries.filter(recovery => protectedSet.has(path.resolve(recovery.path)));
  const retainedCandidates = recoveries.filter(recovery => !protectedSet.has(path.resolve(recovery.path)));
  const retainedUnprotectedCount = Math.max(0, retentionCount - protectedRecoveries.length);
  const remove = retainedCandidates.slice(retainedUnprotectedCount);
  for (const recovery of remove) {
    fs.rmSync(recovery.path, { force: true });
  }

  return {
    deleted: remove.length,
    retained: recoveries.length - remove.length
  };
}

function createCashflowModule({
  appVersion = "0.0.0",
  authProviderHook = null,
  backupServiceHook = null,
  dataDir,
  globalMigrationHook = null,
  localeDir,
  getCurrentFxSnapshot,
  getFxSnapshotForDate = null,
  fetchImpl = fetch,
  portabilityMutationHook = null,
  recoverableMutationHook = null,
  logError,
  logServerEvent,
  appendApiLogLine
}) {
  // Resolve all per-user file paths: planning DB, yearly ledger DBs, and backup folders.
  const {
    backupDir: storageBackupDir,
    backupRootDir: storageBackupRootDir,
    cashflowUserStorageExists,
    deleteCashflowUserStorage,
    directorySizeBytes,
    ledgerDbPath: storageLedgerDbPath,
    listCashflowUserIds,
    planningDbPath: storagePlanningDbPath,
    userDataDir: storageUserDataDir
  } = createCashflowStoragePaths(dataDir);
  let budgetStorageKeyFor = budgetId => budgetId;
  let listBudgetIds = () => listCashflowUserIds();
  const backupDir = (budgetId, options) => storageBackupDir(budgetStorageKeyFor(budgetId), options);
  const backupRootDir = (budgetId, settings) => storageBackupRootDir(budgetStorageKeyFor(budgetId), settings);
  const ledgerDbPath = (budgetId, year, options) => storageLedgerDbPath(budgetStorageKeyFor(budgetId), year, options);
  const planningDbPath = (budgetId, options) => storagePlanningDbPath(budgetStorageKeyFor(budgetId), options);
  const userDataDir = (budgetId, options) => storageUserDataDir(budgetStorageKeyFor(budgetId), options);
  const deleteBudgetStorage = budgetId => deleteCashflowUserStorage(budgetStorageKeyFor(budgetId));

  const {
    listAvailableLocales,
    normalizeLocale,
    translateLocale
  } = createCashflowLocaleService(localeDir);

  let cleanupAfterMigrationRecovery = null;
  let exportBudgetForPurge = () => {
    throw new Error("Budget purge recovery export is not initialized");
  };

  // Open and migrate SQLite databases, and expose ledger-year discovery.
  const {
    initReadOnlyPragmas,
    listLedgerYears,
    openLedgerDb,
    openPlanningDb
  } = createCashflowDbService({
    ledgerDbPath,
    logError,
    logServerEvent,
    onMigrationRecoveryComplete: userId => {
      queueMicrotask(() => {
        if (typeof cleanupAfterMigrationRecovery === "function") {
          cleanupAfterMigrationRecovery(userId, "migration_recovery_completed");
        }
      });
    },
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
    getProviderPairRate,
    refreshNbpFxCacheForAllUsers,
    refreshNbpFxCacheForUser,
    safeGetCurrentFxSnapshot,
    upsertFxCacheRate
  } = createCashflowFxCacheService({
    getCurrentFxSnapshot,
    listCashflowUserIds: () => listBudgetIds(),
    logCashflowError,
    logError,
    logServerEvent,
    normalizeCurrency,
    openPlanningDb,
    regenerateProjectionsAfterMutation,
    fetchImpl
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
    listConfirmedTransactionsPage,
    loadAllConfirmedTransactions,
    newestConfirmedTransactionDate,
    recalculateLedgerRunningBalance,
    confirmedFundingTotals,
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
    confirmedBalanceAsOf,
    confirmedOccurrenceKeys,
    confirmedRowsAfterDate,
    confirmedOneOffProgress,
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

  let recoveryService = null;

  function runRecoverableUserMutation(userId, operation, work) {
    if (!recoveryService) {
      throw new Error("Cashflow recovery service is not initialized");
    }
    return recoveryService.runRecoverableUserMutation(userId, operation, work);
  }

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
    fetchProviderRate,
    getCachedFxRate,
    latestConfirmedBalance,
    normalizeLocale,
    openPlanningDb,
    recalculatePlanningRunningBalances
  });

  const {
    activateAdminAuthDraft,
    authenticateExternalLogin,
    authenticateInternalLogin,
    completeAuthProviderCallback,
    completeInternalPasswordSetup,
    createAdminPasswordResetToken,
    createUser,
    deleteAdminAccount,
    deleteAdminAuthProvider,
    getAdminAuthConfig,
    getGlobalOptions,
    initializeBudgetStorage,
    listAdminAccounts,
    listActiveBudgetIds,
    listAuthProviders,
    listUsers,
    openGlobalDb,
    registerInternalAccountWithInvitation,
    resolveAccountContext,
    resolveBudgetContext,
    resolveBudgetStorageKey,
    resolveSession,
    setAdminProviderIdentity,
    setAdminExternalIdentity,
    revokeAdminAccountSession,
    selectUser,
    setAccountSystemAdmin,
    startAuthProviderLink,
    startAuthProviderLogin,
    testAdminAuthDraft,
    upsertAdminAuthProvider,
    updateAdminAuthDraft,
    updateAdminAccount,
    updateGlobalOptions
  } = createCashflowGlobalService({
    authProviderHook,
    beforeGlobalMigrationStep: globalMigrationHook || (() => {}),
    cashflowUserStorageExists,
    dataDir,
    deleteCashflowUserStorage,
    listCashflowUserIds,
    logError,
    logServerEvent,
    normalizeLocale,
    openPlanningDb
  });
  budgetStorageKeyFor = resolveBudgetStorageKey;
  listBudgetIds = listActiveBudgetIds;

  const {
    createExternalAccountSession,
    createInternalAccountSession,
    createInternalSession,
    createNoneAccountSession,
    createNoneSession,
    resolveTokenContext,
    revokeSession,
    rotateCsrfToken,
    selectBudget,
    validateCsrfToken
  } = createCashflowSessionService({
    openGlobalDb,
    resolveAccountContext,
    resolveBudgetContext
  });

  // Create, update, delete planned entities, then recalculate affected projection state.
  const {
    createFlexTransaction,
    createGoal,
    createOneOffTransaction,
    createRecurringExpense,
    createRecurringIncome,
    dismissPendingOneOffRemainder,
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
    listLedgerYears,
    loadAllConfirmedTransactions,
    newestConfirmedTransactionDate,
    normalizeRecurringInput,
    openLedgerDb,
    openPlanningDb,
    recalculatePlanningRunningBalances,
    requireStartMonthYearIfNeeded,
    runRecoverableUserMutation,
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
    runRecoverableUserMutation,
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
    cleanupOperationalData,
    cleanupOperationalDataBestEffort,
    createBackup,
    maybeRunAutomaticBackup,
    restoreBackup,
    restoreBackupFromPath,
    validateBackupFolderForRestore,
    validateCashflowData
  } = createCashflowBackupService({
    backupDir,
    backupHook: backupServiceHook,
    backupRootDir,
    directorySizeBytes,
    generateId,
    getSettings,
    initReadOnlyPragmas,
    listLedgerYears,
    logError,
    logServerEvent,
    openLedgerDb,
    openPlanningDb,
    recalculateLedgerRunningBalance,
    regenerateProjectionsAfterMutation
  });
  cleanupAfterMigrationRecovery = cleanupOperationalDataBestEffort;

  recoveryService = createCashflowRecoveryService({
    afterWork: recoverableMutationHook,
    cleanupOperationalData: cleanupOperationalDataBestEffort,
    createBackup,
    logError,
    logServerEvent,
    restoreBackupFromPath
  });

  const {
    acceptInvitation,
    archiveBudget,
    createBudget,
    createInvitation,
    leaveBudget,
    listAccounts,
    listBudgetsForAccount,
    listInvitations,
    listMembers,
    purgeBudget,
    removeMember,
    renameBudget,
    restoreBudget: restoreBudgetMetadata,
    revokeInvitation,
    transferOwnership,
    updateMemberRole
  } = createCashflowBudgetService({
    createBudgetBackup: budgetId => exportBudgetForPurge(budgetId),
    deleteBudgetStorage,
    initializeBudgetStorage,
    openGlobalDb
  });

  const {
    exportConfirmedLedgerCsv,
    exportFullData,
    exportSampleData,
    importFullData,
    importOneOffCsv,
    importSampleData
  } = createCashflowDataPortabilityService({
    cleanupOperationalData: cleanupOperationalDataBestEffort,
    createBackup,
    generateId,
    listLedgerYears,
    loadAllConfirmedTransactions,
    logError,
    logServerEvent,
    mutationHook: portabilityMutationHook,
    normalizeLocale,
    openLedgerDb,
    openPlanningDb,
    recalculateLedgerRunningBalance,
    regenerateProjectionsAfterMutation,
    restoreBackupFromPath
  });
  exportBudgetForPurge = budgetId => {
    const recoveryDir = path.join(dataDir, "deleted-budget-recoveries");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const recoveryPath = path.join(recoveryDir, `budget_${budgetId}_${timestamp}.json`);
    fs.mkdirSync(recoveryDir, { recursive: true });
    fs.writeFileSync(
      recoveryPath,
      `${JSON.stringify(exportFullData(budgetId, appVersion), null, 2)}\n`,
      "utf8"
    );
    try {
      const cleanup = cleanupDeletedBudgetRecoveries(recoveryDir, {
        protectedPaths: [recoveryPath]
      });
      if (cleanup.deleted > 0) {
        logServerEvent("cashflow_deleted_budget_recovery_retention_completed", cleanup);
      }
    } catch (cleanupError) {
      logError("cashflow_deleted_budget_recovery_retention_failed", {
        budgetId,
        error: cleanupError.message
      });
    }
    return recoveryPath;
  };

  const {
    completeSetup,
    setupRequired
  } = createCashflowSetupService({
    hasAnyConfirmedTransactions,
    normalizeLocale,
    openPlanningDb,
    regenerateProjectionsAfterMutation
  });

  // Predict recurring amounts from historical ledger rows when a rule uses prediction.
  const {
    confirmedRowsForPrediction,
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
      acceptInvitation,
      activateAdminAuthDraft,
      authenticateExternalLogin,
      authenticateInternalLogin,
      completeAuthProviderCallback,
      archiveBudget,
      confirmPendingTransaction,
      createBackup,
      appVersion,
      createFlexTransaction,
      createGoal,
      createBudget,
      completeInternalPasswordSetup,
      createInvitation,
      createAdminPasswordResetToken,
      deleteAdminAuthProvider,
      createUser,
      createExternalAccountSession,
      createInternalAccountSession,
      createInternalSession,
      createNoneAccountSession,
      createNoneSession,
      createOneOffTransaction,
      createRecurringExpense,
      createRecurringIncome,
      deleteFlexTransaction,
      deleteGoal,
      deleteOneOffTransaction,
      deleteRecurringExpense,
      deleteRecurringIncome,
      dismissPendingOneOffRemainder,
      ensureFxCacheForMutation,
      exportConfirmedLedgerCsv,
      exportFullData,
      exportSampleData,
      fetchNbpFxSnapshot,
      fetchNbpRate,
      getCachedFxSnapshot,
      getAdminAuthConfig,
      getGlobalOptions,
      getProviderPairRate,
      getSnapshot,
      listAdminAccounts,
      listAuthProviders,
      listUsers,
      listAccounts,
      listBudgetsForAccount,
      listConfirmedTransactionsPage,
      listInvitations,
      listMembers,
      listAvailableLocales,
      logCashflowError,
      logError,
      moveFutureTransactionToPending,
      openPlanningDb,
      recordProjectionFailure,
      refreshNbpFxCacheForAllUsers,
      regenerateProjectionsWithFxRefresh,
      resolveRequestContext,
      resolveRequestActor,
      resolveBudgetContext,
      resolveRequestUser,
      resolveSession,
      registerInternalAccountWithInvitation,
      revokeAdminAccountSession,
      revokeSession,
      rotateCsrfToken,
      selectBudget,
      selectUser,
      setAdminProviderIdentity,
      setAdminExternalIdentity,
      startAuthProviderLink,
      startAuthProviderLogin,
      restoreBackup,
      restoreBudgetMetadata,
      removeMember,
      renameBudget,
      revokeInvitation,
      purgeBudget,
      leaveBudget,
      transferOwnership,
      testAdminAuthDraft,
      upsertAdminAuthProvider,
      updateMemberRole,
      importFullData,
      importOneOffCsv,
      importSampleData,
      safeGetCurrentFxSnapshot,
      updateFlexTransaction,
      updateGoal,
      updateOneOffTransaction,
      updatePendingTransaction,
      updateRecurringExpense,
      updateRecurringIncome,
      updateAdminAccount,
      updateAdminAuthDraft,
      updateSettings,
      setAccountSystemAdmin,
      deleteAdminAccount,
      updateGlobalOptions,
      validatePlanMutationInput,
      completeSetup,
      setupRequired,
      translateLocale,
      validateCashflowData,
      validateCsrfToken,
      withProjectionStatus
    });
  }

  function readinessCheck({
    checkDefaultBudget = false
  } = {}) {
    const result = {
      globalSchemaVersion: null,
      defaultBudgetChecked: false,
      defaultBudgetPresent: false,
      defaultBudgetSchemaVersion: null
    };

    const globalDb = openGlobalDb();
    try {
      result.globalSchemaVersion = globalDb.pragma("user_version", { simple: true });
      if (!globalDb.prepare("SELECT id FROM global_options WHERE id = 1").get()) {
        throw new Error("global_options row is missing");
      }
      if (!globalDb.prepare("SELECT id FROM auth_config WHERE id = 1").get()) {
        throw new Error("auth_config row is missing");
      }
    } finally {
      globalDb.close();
    }

    if (checkDefaultBudget) {
      result.defaultBudgetChecked = true;
      const defaultPlanningDbPath = planningDbPath("local", { create: false });
      result.defaultBudgetPresent = fs.existsSync(defaultPlanningDbPath);
      if (result.defaultBudgetPresent) {
        const planningDb = openPlanningDb("local", { create: false });
        try {
          result.defaultBudgetSchemaVersion = planningDb.pragma("user_version", { simple: true });
          planningDb.prepare("SELECT id FROM settings WHERE id = 1").get();
        } finally {
          planningDb.close();
        }
      }
    }

    return result;
  }

  // Build the full API snapshot consumed by the browser app.
  const { getSnapshot } = createCashflowSnapshotService({
    buildBudgetPeriods,
    buildPeriodSummariesFromDefinitions,
    confirmedFundingTotals,
    getCachedFxSnapshot,
    confirmedRowsForPrediction,
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
    confirmedBalanceAsOf,
    confirmedFundingTotals,
    confirmedOccurrenceKeys,
    confirmedRowsAfterDate,
    confirmedOneOffProgress,
    confirmedRowsForPrediction,
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
    confirmedBalanceAsOf,
    ensureFxCacheForMutation,
    getCachedFxSnapshot,
    latestConfirmedBalance,
    listCashflowUserIds: () => listBudgetIds(),
    logCashflowError,
    logError,
    logServerEvent,
    openPlanningDb,
    pendingNetBalance,
    refreshNbpFxCacheForUser,
    regenerateProjections,
    safeGetCurrentFxSnapshot
  });

  function resolveRequestContext(req) {
    if (req.cashflowContext) return req.cashflowContext;

    const hasBudgetHeader = Object.prototype.hasOwnProperty.call(req.headers, "x-cashflow-budget-id");
    const hasLegacyHeader = Object.prototype.hasOwnProperty.call(req.headers, "x-cashflow-user-id");
    const budgetHeader = hasBudgetHeader ? String(req.headers["x-cashflow-budget-id"] || "").trim() : "";
    const legacyHeader = hasLegacyHeader ? String(req.headers["x-cashflow-user-id"] || "").trim() : "";
    if (hasBudgetHeader && hasLegacyHeader && budgetHeader !== legacyHeader) {
      throw badRequest("Conflicting budget selectors");
    }

    const tokenContext = resolveRequestActor(req);

    const budgetId = hasBudgetHeader
      ? budgetHeader
      : hasLegacyHeader
        ? legacyHeader
        : tokenContext?.budget?.id || (tokenContext ? "" : "local");
    if (!budgetId) {
      throw badRequest("Budget selection required");
    }
    const selectedContext = tokenContext && budgetId !== tokenContext.budget?.id
      ? {
          ...resolveBudgetContext(budgetId, {
            accountId: tokenContext.account.id
          }),
          authSession: tokenContext.authSession
        }
      : tokenContext || resolveBudgetContext(budgetId);
    req.cashflowContext = {
      ...selectedContext,
      legacyBudgetHeader: hasLegacyHeader && !hasBudgetHeader
    };
    return req.cashflowContext;
  }

  function resolveRequestActor(req) {
    if (req.cashflowActorContext) return req.cashflowActorContext;
    const token = sessionTokenFromRequest(req);
    const tokenContext = token ? resolveTokenContext(token) : null;
    if (token && !tokenContext) {
      const error = new Error("Authentication required");
      error.status = 401;
      throw error;
    }
    req.cashflowActorContext = tokenContext;
    return tokenContext;
  }

  function resolveRequestUser(req) {
    return resolveRequestContext(req).budget.id;
  }

  // Schedule recurring maintenance: midnight transitions, FX refresh, notifications, backups.
  const { startBackgroundJobs } = createCashflowBackgroundJobs({
    cleanupOperationalData: cleanupOperationalDataBestEffort,
    getSettings,
    listCashflowUserIds: () => listBudgetIds(),
    logCashflowError,
    logError,
    logServerEvent,
    maybeRunAutomaticBackup,
    moveDueFutureTransactionsToPending,
    queueDailyPendingSummary,
    queueMissingIncomeNotifications,
    openPlanningDb,
    refreshNbpFxCacheForAllUsers,
    refreshNbpFxCacheForUser,
    sendQueuedNotifications
  });

  // Public module surface consumed by server.mjs and tests.
  return {
    cleanupOperationalData,
    readinessCheck,
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





