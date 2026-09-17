import fs from "node:fs";
import path from "node:path";

import { createCashflowErrorLogger } from "./server/cashflow-error-utils.js";
import {
  resolveCashflowDbConfig
} from "./server/cashflow-db-config.js";
import { normalizeCurrency } from "./server/cashflow-money-utils.js";
import { createCashflowStoragePaths } from "./server/cashflow-storage-utils.js";
import { registerCashflowRoutes } from "./server/cashflow-routes.js";
import { createCashflowBackupService } from "./server/cashflow-backup-service.js";
import { createCashflowBudgetService } from "./server/cashflow-budget-service.js";
import { createCashflowDataPortabilityService } from "./server/cashflow-data-portability-service.js";
import { createCashflowGlobalService } from "./server/cashflow-global-service.js";
import { createCashflowStorageBackend } from "./server/cashflow-storage-backend.js";
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

async function createCashflowModule({
  appVersion = "0.0.0",
  authProviderHook = null,
  backupServiceHook = null,
  dataDir,
  databaseConfig = resolveCashflowDbConfig(),
  globalMigrationHook = null,
  localeDir,
  lockService = null,
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
  let listBudgetIdsAsync = async () => listBudgetIds();
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
  let exportBudgetForPurgeAsync = async () => {
    throw new Error("Budget purge recovery export is not initialized");
  };

  // Set once the real backend is known below. Read lazily by
  // createCashflowDbService's openers so their guard sees the final,
  // normalized backend rather than the raw, unnormalized databaseConfig.
  let activeDbBackend = null;

  // Open and migrate SQLite databases, and expose ledger-year discovery.
  const {
    initReadOnlyPragmas,
    listLedgerYears,
    openLedgerDb,
    openPlanningDb
  } = createCashflowDbService({
    isPostgresBackend: () => activeDbBackend === "postgres",
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

  const storageBackend = await createCashflowStorageBackend({
    beforeGlobalMigrationStep: globalMigrationHook || (() => {}),
    databaseConfig,
    dataDir,
    listCashflowUserIds,
    listLedgerYears,
    logError,
    logServerEvent,
    openLedgerDb,
    openPlanningDb
  });
  const { budgetStore, globalStore } = storageBackend;
  const resolvedDatabaseConfig = storageBackend.config;
  activeDbBackend = resolvedDatabaseConfig.backend;

  // Wrap host logging with Cashflow-specific error metadata.
  const logCashflowError = createCashflowErrorLogger(logError);

  // Manage FX cache reads, NBP fetches, and projection refreshes after FX changes.
  const {
    collectCurrenciesForFxSnapshot,
    collectCurrenciesForFxSnapshotAsync,
    ensureFxCacheForMutation,
    fetchProviderRate,
    fetchNbpFxSnapshot,
    fetchNbpRate,
    getCachedFxRate,
    getCachedFxRateAsync,
    getCachedFxSnapshot,
    getCachedFxSnapshotAsync,
    getFxProviderSettings,
    getFxProviderSettingsAsync,
    getProviderPairRate,
    refreshNbpFxCacheForAllUsers,
    refreshNbpFxCacheForUser,
    safeGetCurrentFxSnapshot,
    safeGetCurrentFxSnapshotAsync,
    upsertFxCacheRate,
    upsertFxCacheRateAsync
  } = createCashflowFxCacheService({
    budgetStore,
    getCurrentFxSnapshot,
    listCashflowUserIds: () => listBudgetIds(),
    listCashflowUserIdsAsync: () => listBudgetIdsAsync(),
    logCashflowError,
    logError,
    logServerEvent,
    normalizeCurrency,
    openPlanningDb,
    regenerateProjectionsAfterMutation,
    regenerateProjectionsAfterMutationAsync,
    fetchImpl
  });

  // Resolve historical FX rates for confirmed ledger entries.
  const {
    getConfirmedFxForDate
  } = createCashflowConfirmedFxService({
    fetchProviderRate,
    fetchNbpRate,
    getCachedFxRate,
    getCachedFxRateAsync,
    getFxProviderSettings,
    getFxProviderSettingsAsync,
    getFxSnapshotForDate,
    upsertFxCacheRate,
    upsertFxCacheRateAsync
  });

  // Read/write confirmed ledger rows and calculate confirmed/pending funding totals.
  const {
    hasAnyConfirmedTransactions,
    hasAnyConfirmedTransactionsAsync,
    compactHistoricalLedger: compactHistoricalLedgerRows,
    compactHistoricalLedgerAsync: compactHistoricalLedgerRowsAsync,
    historicalLedgerCompactionPlan,
    historicalLedgerCompactionPlanAsync,
    latestConfirmedBalance,
    latestConfirmedBalanceAsync,
    listConfirmedTransactionsPage,
    listConfirmedTransactionsPageAsync,
    loadAllConfirmedTransactions,
    loadAllConfirmedTransactionsAsync,
    newestConfirmedTransactionDate,
    newestConfirmedTransactionDateAsync,
    recalculateLedgerRunningBalance,
    recalculateLedgerRunningBalanceAsync,
    confirmedFundingTotals,
    confirmedFundingTotalsAsync,
    sumConfirmedFunding,
    sumConfirmedFundingAsync,
    sumPendingFunding,
    sumPendingFundingAsync,
    wouldLedgerGoNegativeAfterInsert,
    wouldLedgerGoNegativeAfterInsertAsync
  } = createCashflowLedgerService({
    budgetStore,
    generateId,
    listLedgerYears,
    openLedgerDb,
    openPlanningDb
  });

  // Keep planning-table state coherent: pending rows, running balances, and occurrence keys.
  const {
    confirmedBalanceAsOf,
    confirmedBalanceAsOfAsync,
    confirmedOccurrenceKeys,
    confirmedOccurrenceKeysAsync,
    confirmedRowsAfterDate,
    confirmedRowsAfterDateAsync,
    confirmedOneOffProgress,
    confirmedOneOffProgressAsync,
    deletePendingOccurrence,
    findConfirmedOccurrence,
    findConfirmedOccurrenceAsync,
    normalizePendingStatus,
    normalizeRecurringInput,
    pendingOccurrenceExists,
    pendingOccurrenceRow,
    pendingNetBalance,
    pendingNetBalanceAsync,
    planningOpeningBalance,
    planningOpeningBalanceAsync,
    recalculatePlanningRunningBalances,
    recalculatePlanningRunningBalancesAsync,
    refreshPendingOccurrence,
    requireStartMonthYearIfNeeded
  } = createCashflowProjectionStateService({
    budgetStore,
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
    budgetStore,
    normalizePendingStatus,
    openPlanningDb,
    recalculatePlanningRunningBalances,
    withProjectionStatus
  });

  // Read and update global Cashflow settings.
  const {
    getSettings,
    getSettingsAsync,
    updateSettings
  } = createCashflowSettingsService({
    budgetStore,
    fetchProviderRate,
    getCachedFxRate,
    getCachedFxRateAsync,
    latestConfirmedBalance,
    latestConfirmedBalanceAsync,
    normalizeLocale,
    openPlanningDb,
    recalculatePlanningRunningBalances,
    recalculatePlanningRunningBalancesAsync
  });

  const {
    activateAdminAuthDraft,
    activateAdminAuthDraftAsync,
    authenticateExternalLogin,
    authenticateInternalLogin,
    completeAuthProviderCallback,
    completeInternalPasswordSetup,
    createAdminPasswordResetToken,
    createUser,
    createUserAsync,
    deleteAdminAccount,
    deleteAdminAccountAsync,
    deleteAdminAuthProvider,
    deleteAdminAuthProviderAsync,
    getAdminAuthConfig,
    getAdminAuthConfigAsync,
    getGlobalOptions,
    getGlobalOptionsAsync,
    initializeBudgetStorage,
    initializeBudgetStorageAsync,
    listAdminAccounts,
    listAdminAccountsAsync,
    listActiveBudgetIds,
    listActiveBudgetIdsAsync,
    listAuthProviders,
    listAuthProvidersAsync,
    listUsers,
    listUsersAsync,
    openGlobalDb,
    registerInternalAccountWithInvitation,
    resolveAccountContext,
    resolveAccountContextAsync,
    resolveBudgetContext,
    resolveBudgetContextAsync,
    resolveBudgetStorageKey,
    resolveSession,
    resolveSessionAsync,
    setAdminProviderIdentity,
    setAdminProviderIdentityAsync,
    setAdminExternalIdentity,
    setAdminExternalIdentityAsync,
    revokeAdminAccountSession,
    revokeAdminAccountSessionAsync,
    selectUser,
    selectUserAsync,
    setAccountSystemAdmin,
    setAccountSystemAdminAsync,
    startAuthProviderLink,
    startAuthProviderLogin,
    testAdminAuthDraft,
    testAdminAuthDraftAsync,
    upsertAdminAuthProvider,
    upsertAdminAuthProviderAsync,
    updateAdminAuthDraft,
    updateAdminAuthDraftAsync,
    updateAdminAccount,
    updateAdminAccountAsync,
    updateGlobalOptions,
    updateGlobalOptionsAsync
  } = createCashflowGlobalService({
    authProviderHook,
    beforeGlobalMigrationStep: globalMigrationHook || (() => {}),
    budgetStore,
    cashflowUserStorageExists,
    dataDir,
    deleteCashflowUserStorage,
    globalStore,
    listCashflowUserIds,
    logError,
    logServerEvent,
    normalizeLocale,
    openPlanningDb
  });
  budgetStorageKeyFor = resolveBudgetStorageKey;
  listBudgetIds = listActiveBudgetIds;
  listBudgetIdsAsync = typeof listActiveBudgetIdsAsync === "function"
    ? listActiveBudgetIdsAsync
    : async () => listBudgetIds();

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
    globalStore,
    openGlobalDb,
    resolveAccountContext: resolveAccountContextAsync,
    resolveBudgetContext: resolveBudgetContextAsync
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
    budgetStore,
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
    budgetStore,
    deletePendingOccurrence,
    findConfirmedOccurrence,
    getConfirmedFxForDate,
    newestConfirmedTransactionDate,
    newestConfirmedTransactionDateAsync,
    openLedgerDb,
    openPlanningDb,
    recalculateLedgerRunningBalance,
    runRecoverableUserMutation,
    withProjectionStatus,
    wouldLedgerGoNegativeAfterInsert,
    wouldLedgerGoNegativeAfterInsertAsync
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

  async function regenerateAllUsersAfterFxChangeAsync() {
    return await requireProjectionCoordinator().regenerateAllUsersAfterFxChangeAsync();
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

  async function regenerateProjectionsAfterMutationAsync(userId) {
    // Async status wrapper can use budget-store helpers and optional runtime locks.
    return await requireProjectionCoordinator().regenerateProjectionsAfterMutationAsync(userId);
  }

  function recordProjectionFailure(db, userId, error, fxSnapshot = null) {
    // Persist projection failure details for diagnostics in the snapshot/API.
    return requireProjectionCoordinator().recordProjectionFailure(db, userId, error, fxSnapshot);
  }

  async function recordProjectionFailureAsync(userId, error, fxSnapshot = null) {
    // Async variant uses the configured budget store when available.
    return await requireProjectionCoordinator().recordProjectionFailureAsync(userId, error, fxSnapshot);
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
    createBackupAsync,
    maybeRunAutomaticBackup,
    maybeRunAutomaticBackupAsync,
    restoreBackup,
    restoreBackupAsync,
    restoreBackupFromPath,
    restoreBackupFromPathAsync,
    validateBackupFolderForRestore,
    validateCashflowData
  } = createCashflowBackupService({
    backupDir,
    backupHook: backupServiceHook,
    backupRootDir,
    budgetStore,
    directorySizeBytes,
    generateId,
    getSettings,
    getSettingsAsync,
    initReadOnlyPragmas,
    listLedgerYears,
    logError,
    logServerEvent,
    openLedgerDb,
    openPlanningDb,
    recalculateLedgerRunningBalance,
    recalculateLedgerRunningBalanceAsync,
    regenerateProjectionsAfterMutation,
    regenerateProjectionsAfterMutationAsync
  });
  cleanupAfterMigrationRecovery = cleanupOperationalDataBestEffort;

  recoveryService = createCashflowRecoveryService({
    afterWork: recoverableMutationHook,
    budgetStore,
    cleanupOperationalData: cleanupOperationalDataBestEffort,
    createBackup,
    createBackupAsync,
    logError,
    logServerEvent,
    restoreBackupFromPath,
    restoreBackupFromPathAsync
  });

  async function compactLedgerHistory(userId, options = {}) {
    const plan = await historicalLedgerCompactionPlanAsync(userId, options);
    if (!plan.enabled || !plan.eligibleRows || !plan.needsCompaction) {
      return {
        ...plan,
        compactedRows: 0,
        createdRows: 0
      };
    }

    return runRecoverableUserMutation(userId, "compact_ledger_history", async () =>
      withProjectionStatus(userId, await compactHistoricalLedgerRowsAsync(userId, {
        ...options,
        plan
      }))
    );
  }

  const {
    acceptInvitation,
    acceptInvitationAsync,
    archiveBudget,
    archiveBudgetAsync,
    createBudget,
    createBudgetAsync,
    createInvitation,
    createInvitationAsync,
    leaveBudget,
    leaveBudgetAsync,
    listAccounts,
    listAccountsAsync,
    listBudgetsForAccount,
    listBudgetsForAccountAsync,
    listInvitations,
    listInvitationsAsync,
    listMembers,
    listMembersAsync,
    purgeBudget,
    purgeBudgetAsync,
    removeMember,
    removeMemberAsync,
    renameBudget,
    renameBudgetAsync,
    restoreBudget: restoreBudgetMetadata,
    restoreBudgetAsync: restoreBudgetMetadataAsync,
    revokeInvitation,
    revokeInvitationAsync,
    transferOwnership,
    transferOwnershipAsync,
    updateMemberRole,
    updateMemberRoleAsync
  } = createCashflowBudgetService({
    createBudgetBackup: budgetId => exportBudgetForPurge(budgetId),
    createBudgetBackupAsync: budgetId => exportBudgetForPurgeAsync(budgetId),
    deleteBudgetStorage,
    globalStore,
    initializeBudgetStorage,
    initializeBudgetStorageAsync,
    openGlobalDb
  });

  const {
    exportConfirmedLedgerCsv,
    exportConfirmedLedgerCsvAsync,
    exportFullData,
    exportFullDataAsync,
    exportSampleData,
    previewFullImport,
    previewFullImportAsync,
    importFullData,
    importFullDataAsync,
    importOneOffCsv,
    importOneOffCsvAsync,
    importSampleData,
    importSampleDataAsync
  } = createCashflowDataPortabilityService({
    budgetStore,
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
    recalculateLedgerRunningBalanceAsync,
    regenerateProjectionsAfterMutation,
    regenerateProjectionsAfterMutationAsync,
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

  exportBudgetForPurgeAsync = async budgetId => {
    const recoveryDir = path.join(dataDir, "deleted-budget-recoveries");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const recoveryPath = path.join(recoveryDir, `budget_${budgetId}_${timestamp}.json`);
    fs.mkdirSync(recoveryDir, { recursive: true });
    const exported = await exportFullDataAsync(budgetId, appVersion);
    fs.writeFileSync(
      recoveryPath,
      `${JSON.stringify(exported, null, 2)}\n`,
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
    setupRequired,
    setupRequiredAsync
  } = createCashflowSetupService({
    budgetStore,
    hasAnyConfirmedTransactions,
    hasAnyConfirmedTransactionsAsync,
    normalizeLocale,
    openPlanningDb,
    regenerateProjectionsAfterMutation,
    regenerateProjectionsAfterMutationAsync
  });

  // Predict recurring amounts from historical ledger rows when a rule uses prediction.
  const {
    confirmedRowsForPrediction,
    confirmedRowsForPredictionAsync,
    predictedAmountForRecurringExpense,
    predictedAmountForRecurringExpenseAsync,
    predictedAmountForRecurringIncome,
    predictedAmountForRecurringIncomeAsync
  } = createCashflowPredictionService({
    budgetStore,
    listLedgerYears,
    openLedgerDb
  });

  function registerRoutes(app) {
    // Bind all HTTP routes to the functions assembled above.
    registerCashflowRoutes(app, {
      collectCurrenciesForFxSnapshot,
      collectCurrenciesForFxSnapshotAsync,
      acceptInvitation,
      acceptInvitationAsync,
      activateAdminAuthDraft,
      activateAdminAuthDraftAsync,
      authenticateExternalLogin,
      authenticateInternalLogin,
      completeAuthProviderCallback,
      archiveBudget,
      archiveBudgetAsync,
      compactLedgerHistory,
      confirmPendingTransaction,
      countPendingTransactions,
      clearPendingTransactions,
      createBackup,
      createBackupAsync,
      appVersion,
      createFlexTransaction,
      createGoal,
      createBudget,
      createBudgetAsync,
      completeInternalPasswordSetup,
      createInvitation,
      createInvitationAsync,
      createAdminPasswordResetToken,
      deleteAdminAuthProvider,
      deleteAdminAuthProviderAsync,
      createUser,
      createUserAsync,
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
      exportConfirmedLedgerCsvAsync,
      exportFullData,
      exportFullDataAsync,
      exportSampleData,
      fetchNbpFxSnapshot,
      fetchNbpRate,
      getCachedFxSnapshot,
      getCachedFxSnapshotAsync,
      getAdminAuthConfig,
      getAdminAuthConfigAsync,
      getGlobalOptions,
      getGlobalOptionsAsync,
      getSettingsAsync,
      getProviderPairRate,
      getSnapshot,
      getSnapshotAsync,
      listAdminAccounts,
      listAdminAccountsAsync,
      listAuthProviders,
      listAuthProvidersAsync,
      listUsers,
      listUsersAsync,
      listAccounts,
      listAccountsAsync,
      listBudgetsForAccount,
      listBudgetsForAccountAsync,
      listConfirmedTransactionsPage,
      listConfirmedTransactionsPageAsync,
      listInvitations,
      listInvitationsAsync,
      listMembers,
      listMembersAsync,
      listAvailableLocales,
      lockService,
      logCashflowError,
      logError,
      moveFutureTransactionToPending,
      openPlanningDb,
      recordProjectionFailure,
      recordProjectionFailureAsync,
      refreshNbpFxCacheForAllUsers,
      regenerateProjectionsWithFxRefresh,
      resolveRequestContext,
      resolveRequestActor,
      resolveBudgetContext,
      resolveBudgetContextAsync,
      resolveRequestUser,
      resolveSession,
      resolveSessionAsync,
      registerInternalAccountWithInvitation,
      revokeAdminAccountSession,
      revokeAdminAccountSessionAsync,
      revokeSession,
      rotateCsrfToken,
      selectBudget,
      selectUser,
      selectUserAsync,
      setAdminProviderIdentity,
      setAdminProviderIdentityAsync,
      setAdminExternalIdentity,
      setAdminExternalIdentityAsync,
      startAuthProviderLink,
      startAuthProviderLogin,
      restoreBackup,
      restoreBackupAsync,
      restoreBudgetMetadata,
      restoreBudgetMetadataAsync,
      removeMember,
      removeMemberAsync,
      renameBudget,
      renameBudgetAsync,
      revokeInvitation,
      revokeInvitationAsync,
      purgeBudget,
      purgeBudgetAsync,
      leaveBudget,
      leaveBudgetAsync,
      transferOwnership,
      transferOwnershipAsync,
      testAdminAuthDraft,
      testAdminAuthDraftAsync,
      upsertAdminAuthProvider,
      upsertAdminAuthProviderAsync,
      updateMemberRole,
      updateMemberRoleAsync,
      previewFullImport,
      previewFullImportAsync,
      importFullData,
      importFullDataAsync,
      importOneOffCsv,
      importOneOffCsvAsync,
      importSampleData,
      importSampleDataAsync,
      safeGetCurrentFxSnapshot,
      safeGetCurrentFxSnapshotAsync,
      updateFlexTransaction,
      updateGoal,
      updateOneOffTransaction,
      updatePendingTransaction,
      updateRecurringExpense,
      updateRecurringIncome,
      updateAdminAccount,
      updateAdminAccountAsync,
      updateAdminAuthDraft,
      updateAdminAuthDraftAsync,
      updateSettings,
      setAccountSystemAdmin,
      setAccountSystemAdminAsync,
      deleteAdminAccount,
      deleteAdminAccountAsync,
      updateGlobalOptions,
      updateGlobalOptionsAsync,
      validatePlanMutationInput,
      completeSetup,
      setupRequired,
      setupRequiredAsync,
      translateLocale,
      validateCashflowData,
      validateCsrfToken,
      withProjectionStatus
    });
  }

  async function readinessCheck({
    checkDefaultBudget = false
  } = {}) {
    const result = {
      databaseBackend: resolvedDatabaseConfig.backend,
      globalSchemaVersion: null,
      defaultBudgetChecked: false,
      defaultBudgetPresent: false,
      defaultBudgetSchemaVersion: null
    };

    const globalReady = await globalStore.checkReadiness();
    result.globalSchemaVersion = globalReady.globalSchemaVersion;
    await globalStore.withRepository(repo => {
      if (!repo.globalOptions.get()) {
        throw new Error("global_options row is missing");
      }
      if (!repo.authConfig.get()) {
        throw new Error("auth_config row is missing");
      }
    });

    if (checkDefaultBudget) {
      result.defaultBudgetChecked = true;
      const defaultPlanningDbPath = planningDbPath("local", { create: false });
      result.defaultBudgetPresent = fs.existsSync(defaultPlanningDbPath);
      if (result.defaultBudgetPresent) {
        const budgetReady = await budgetStore.checkReadiness("local");
        result.defaultBudgetSchemaVersion = budgetReady.planningSchemaVersion;
      }
    }

    return result;
  }

  // Build the full API snapshot consumed by the browser app.
  const { getSnapshot, getSnapshotAsync } = createCashflowSnapshotService({
    budgetStore,
    buildBudgetPeriods,
    buildPeriodSummariesFromDefinitions,
    confirmedFundingTotals,
    confirmedFundingTotalsAsync,
    getCachedFxSnapshot,
    getCachedFxSnapshotAsync,
    confirmedRowsForPrediction,
    loadAllConfirmedTransactions,
    loadAllConfirmedTransactionsAsync,
    openPlanningDb,
    listAvailableLocales,
    predictedAmountForRecurringExpense,
    predictedAmountForRecurringExpenseAsync,
    safeGetCurrentFxSnapshot,
    safeGetCurrentFxSnapshotAsync,
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
    budgetStore,
    fetchImpl,
    generateId,
    listLedgerYears,
    openLedgerDb,
    openPlanningDb
  });

  // Generate future transactions and allocation projections for one user.
  projectionEngine = createCashflowProjectionEngineService({
    budgetStore,
    confirmedBalanceAsOf,
    confirmedBalanceAsOfAsync,
    confirmedFundingTotals,
    confirmedOccurrenceKeys,
    confirmedOccurrenceKeysAsync,
    confirmedRowsAfterDate,
    confirmedRowsAfterDateAsync,
    confirmedOneOffProgress,
    confirmedOneOffProgressAsync,
    confirmedRowsForPrediction,
    confirmedRowsForPredictionAsync,
    deletePendingOccurrence,
    getCachedFxSnapshot,
    getCachedFxSnapshotAsync,
    logServerEvent,
    notificationEnabled,
    notificationPriority,
    openPlanningDb,
    planningOpeningBalance,
    predictedAmountForRecurringExpense,
    predictedAmountForRecurringIncome,
    queueNotification,
    recalculatePlanningRunningBalances,
    recalculatePlanningRunningBalancesAsync,
    refreshPendingOccurrence,
    safeGetCurrentFxSnapshot,
    safeGetCurrentFxSnapshotAsync,
    sumConfirmedFunding,
    sumPendingFunding
  });

  // Coordinate projection runs, FX refreshes, status capture, and all-user rebuilds.
  projectionCoordinator = createCashflowProjectionCoordinatorService({
    budgetStore,
    collectCurrenciesForFxSnapshot,
    confirmedBalanceAsOf,
    confirmedBalanceAsOfAsync,
    ensureFxCacheForMutation,
    getCachedFxSnapshot,
    getCachedFxSnapshotAsync,
    latestConfirmedBalance,
    listCashflowUserIds: () => listBudgetIds(),
    listCashflowUserIdsAsync: () => listBudgetIdsAsync(),
    lockService,
    logCashflowError,
    logError,
    logServerEvent,
    openPlanningDb,
    pendingNetBalance,
    pendingNetBalanceAsync,
    refreshNbpFxCacheForUser,
    regenerateProjections,
    regenerateProjectionsAsync: projectionEngine.regenerateProjectionsAsync,
    safeGetCurrentFxSnapshot,
    safeGetCurrentFxSnapshotAsync
  });

  const {
    clearPendingTransactions,
    countPendingTransactions
  } = projectionCoordinator;

  async function resolveRequestContext(req) {
    if (req.cashflowContext) return req.cashflowContext;

    const hasBudgetHeader = Object.prototype.hasOwnProperty.call(req.headers, "x-cashflow-budget-id");
    const hasLegacyHeader = Object.prototype.hasOwnProperty.call(req.headers, "x-cashflow-user-id");
    const budgetHeader = hasBudgetHeader ? String(req.headers["x-cashflow-budget-id"] || "").trim() : "";
    const legacyHeader = hasLegacyHeader ? String(req.headers["x-cashflow-user-id"] || "").trim() : "";
    if (hasBudgetHeader && hasLegacyHeader && budgetHeader !== legacyHeader) {
      throw badRequest("Conflicting budget selectors");
    }

    const tokenContext = await resolveRequestActor(req);

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
          ...(await resolveBudgetContext(budgetId, {
            accountId: tokenContext.account.id
          })),
          authSession: tokenContext.authSession
        }
      : tokenContext || await resolveBudgetContext(budgetId);
    req.cashflowContext = {
      ...selectedContext,
      legacyBudgetHeader: hasLegacyHeader && !hasBudgetHeader
    };
    return req.cashflowContext;
  }

  async function resolveRequestActor(req) {
    if (req.cashflowActorContext) return req.cashflowActorContext;
    const token = sessionTokenFromRequest(req);
    const tokenContext = token ? await resolveTokenContext(token) : null;
    if (token && !tokenContext) {
      const error = new Error("Authentication required");
      error.status = 401;
      throw error;
    }
    req.cashflowActorContext = tokenContext;
    return tokenContext;
  }

  async function resolveRequestUser(req) {
    return (await resolveRequestContext(req)).budget.id;
  }

  // Schedule recurring maintenance: midnight transitions, FX refresh, notifications, backups.
  const { startBackgroundJobs } = createCashflowBackgroundJobs({
    budgetStore,
    cleanupOperationalData: cleanupOperationalDataBestEffort,
    compactLedgerHistory,
    getSettings,
    getSettingsAsync,
    listCashflowUserIds: () => listBudgetIds(),
    listCashflowUserIdsAsync: () => listBudgetIdsAsync(),
    lockService,
    logCashflowError,
    logError,
    logServerEvent,
    maybeRunAutomaticBackup,
    maybeRunAutomaticBackupAsync,
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
    compactLedgerHistory,
    readinessCheck,
    registerRoutes,
    startBackgroundJobs,
    getSnapshot,
    getSnapshotAsync,
    getSettings,
    updateSettings,
    regenerateAllUsersAfterFxChange,
    regenerateAllUsersAfterFxChangeAsync,
    refreshNbpFxCacheForUser,
    refreshNbpFxCacheForAllUsers
  };
}
export { createCashflowModule };





