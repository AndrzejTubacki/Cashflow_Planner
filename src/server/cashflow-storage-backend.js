import {
  assertCashflowDatabaseUrlConfigured,
  assertCashflowDbBackendSupported,
  DEFAULT_DB_BACKEND,
  resolveCashflowDbConfig
} from "./cashflow-db-config.js";
import { createPostgresBudgetStore, createSqliteBudgetStore } from "./cashflow-budget-store.js";
import { createSqliteGlobalStore } from "./cashflow-sqlite-global-store.js";
import { createPostgresGlobalStore } from "./cashflow-postgres-global-store.js";

const SQLITE_RUNTIME_CAPABILITIES = Object.freeze({
  budgetRuntime: "sqlite-files",
  distributedLocks: false,
  externalRuntime: false,
  globalRuntime: "sqlite-file",
  migrationOnly: false,
  multiReplicaSafe: false,
  sqliteSyncRuntime: true
});

// distributedLocks is a string, not a boolean, because it is opt-in and
// configured separately from CASHFLOW_DB_BACKEND (via
// CASHFLOW_RUNTIME_LOCK_BACKEND=postgres, see
// cashflow-runtime-lock-service.js) rather than automatic. multiReplicaSafe
// describes the store's own write safety (proven by real concurrent-write
// tests against a disposable database — see
// test/server/postgres-runtime.integration.test.js), which holds
// regardless of whether the lock service is configured; without it,
// concurrent replicas can still do redundant work (e.g. both regenerating
// a projection), just not corrupt data.
const POSTGRES_RUNTIME_CAPABILITIES = Object.freeze({
  budgetRuntime: "postgres",
  distributedLocks: "opt-in (CASHFLOW_RUNTIME_LOCK_BACKEND=postgres)",
  externalRuntime: true,
  globalRuntime: "postgres",
  migrationOnly: false,
  multiReplicaSafe: true,
  sqliteSyncRuntime: false
});

function normalizedConfig(config = resolveCashflowDbConfig()) {
  return {
    ...config,
    backend: String(config?.backend || DEFAULT_DB_BACKEND).trim().toLowerCase() || DEFAULT_DB_BACKEND,
    external: Boolean(config?.external),
    supported: Boolean(config?.supported)
  };
}

export function describeCashflowStorageBackend(config = resolveCashflowDbConfig()) {
  const resolved = normalizedConfig(config);

  if (resolved.backend === DEFAULT_DB_BACKEND) {
    return {
      backend: DEFAULT_DB_BACKEND,
      capabilities: SQLITE_RUNTIME_CAPABILITIES,
      external: false,
      failClosedReason: null,
      runtimeSupported: true
    };
  }

  if (resolved.backend === "postgres") {
    return {
      backend: "postgres",
      capabilities: POSTGRES_RUNTIME_CAPABILITIES,
      external: true,
      failClosedReason: null,
      runtimeSupported: true
    };
  }

  return {
    backend: resolved.backend,
    capabilities: Object.freeze({
      budgetRuntime: "unsupported",
      distributedLocks: false,
      externalRuntime: false,
      globalRuntime: "unsupported",
      migrationOnly: false,
      multiReplicaSafe: false,
      sqliteSyncRuntime: false
    }),
    external: true,
    failClosedReason: `${resolved.backend} is not a supported Cashflow storage backend.`,
    runtimeSupported: false
  };
}

export async function createCashflowStorageBackend({
  beforeGlobalMigrationStep = () => {},
  databaseConfig = resolveCashflowDbConfig(),
  dataDir,
  env = process.env,
  listCashflowUserIds,
  listLedgerYears,
  logError = () => {},
  logServerEvent = () => {},
  openLedgerDb,
  openPlanningDb
} = {}) {
  const resolvedConfig = assertCashflowDbBackendSupported(databaseConfig);
  const description = describeCashflowStorageBackend(resolvedConfig);

  if (!description.runtimeSupported) {
    const error = new Error(description.failClosedReason || "External storage backend is not runtime-enabled");
    error.code = "CASHFLOW_DB_BACKEND_UNSUPPORTED";
    error.status = 500;
    throw error;
  }

  if (description.backend === DEFAULT_DB_BACKEND) {
    return {
      ...description,
      config: resolvedConfig,
      budgetStore: createSqliteBudgetStore({
        listLedgerYears,
        openLedgerDb,
        openPlanningDb
      }),
      globalStore: createSqliteGlobalStore({
        beforeGlobalMigrationStep,
        dataDir,
        listCashflowUserIds,
        logError,
        logServerEvent
      })
    };
  }

  // Postgres: read the connection string directly from env rather than
  // threading it through resolvedConfig/description, which are logged and
  // otherwise treated as safe-to-serialize (databaseUrlConfigured is a
  // boolean precisely so those objects never carry the secret itself) —
  // same pattern as cashflow-runtime-lock-service.js.
  assertCashflowDatabaseUrlConfigured(resolvedConfig);
  const databaseUrl = String(env.CASHFLOW_DATABASE_URL || "").trim();

  const [globalStore, budgetStore] = await Promise.all([
    createPostgresGlobalStore({ databaseUrl, logError, logServerEvent }),
    createPostgresBudgetStore({ databaseUrl, logError, logServerEvent })
  ]);

  return {
    ...description,
    config: resolvedConfig,
    budgetStore,
    globalStore
  };
}
