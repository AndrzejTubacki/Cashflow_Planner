import { createPostgresGlobalStore } from "./cashflow-postgres-global-store.js";

const SUPPORTED_RUNTIME_LOCK_BACKENDS = new Set(["none", "postgres"]);

function enabledBackend(value) {
  const backend = String(value || "none").trim().toLowerCase();
  if (!backend || backend === "off" || backend === "disabled") return "none";
  if (backend === "postgresql" || backend === "pg") return "postgres";
  return backend;
}

function secretConfigured(value) {
  return Boolean(String(value || "").trim());
}

export function describeCashflowRuntimeLockConfig(env = process.env) {
  const backend = enabledBackend(env.CASHFLOW_RUNTIME_LOCK_BACKEND);
  const databaseUrlConfigured = secretConfigured(
    env.CASHFLOW_RUNTIME_LOCK_DATABASE_URL || env.CASHFLOW_DATABASE_URL
  );

  return {
    backend,
    databaseUrlConfigured,
    enabled: backend !== "none",
    supported: SUPPORTED_RUNTIME_LOCK_BACKENDS.has(backend)
  };
}

export async function createCashflowRuntimeLockService({
  env = process.env,
  logError = () => {},
  logServerEvent = () => {},
  pgModule = null
} = {}) {
  const config = describeCashflowRuntimeLockConfig(env);
  if (!config.enabled) {
    logServerEvent("cashflow_runtime_lock_service_disabled", {
      backend: config.backend
    });
    return {
      close: async () => {},
      config,
      lockService: null
    };
  }

  if (!config.supported) {
    const error = new Error(`Unsupported CASHFLOW_RUNTIME_LOCK_BACKEND "${config.backend}"`);
    error.code = "CASHFLOW_RUNTIME_LOCK_BACKEND_UNSUPPORTED";
    error.status = 500;
    throw error;
  }

  if (config.backend === "postgres") {
    const databaseUrl = String(
      env.CASHFLOW_RUNTIME_LOCK_DATABASE_URL || env.CASHFLOW_DATABASE_URL || ""
    ).trim();
    if (!databaseUrl) {
      const error = new Error(
        "CASHFLOW_RUNTIME_LOCK_BACKEND=postgres requires CASHFLOW_RUNTIME_LOCK_DATABASE_URL or CASHFLOW_DATABASE_URL"
      );
      error.code = "CASHFLOW_RUNTIME_LOCK_DATABASE_URL_REQUIRED";
      error.status = 500;
      throw error;
    }

    const ownerId = String(env.CASHFLOW_RUNTIME_LOCK_OWNER_ID || "").trim() || undefined;
    const store = await createPostgresGlobalStore({
      databaseUrl,
      logError,
      logServerEvent,
      pgModule
    });
    await store.initialize();
    const lockService = store.createLockService({ ownerId });
    logServerEvent("cashflow_runtime_lock_service_enabled", {
      backend: config.backend,
      databaseUrlConfigured: true
    });

    return {
      close: store.close,
      config,
      lockService
    };
  }

  const error = new Error(`Unsupported CASHFLOW_RUNTIME_LOCK_BACKEND "${config.backend}"`);
  error.code = "CASHFLOW_RUNTIME_LOCK_BACKEND_UNSUPPORTED";
  error.status = 500;
  throw error;
}
