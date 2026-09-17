export const DEFAULT_DB_BACKEND = "sqlite";
export const SUPPORTED_DB_BACKENDS = [DEFAULT_DB_BACKEND, "postgres"];

function normalizeDbBackend(value) {
  const backend = String(value || DEFAULT_DB_BACKEND).trim().toLowerCase();
  if (!backend) return DEFAULT_DB_BACKEND;
  if (backend === "sqlite" || backend === "better-sqlite3") return DEFAULT_DB_BACKEND;
  if (backend === "postgres" || backend === "postgresql" || backend === "pg") return "postgres";
  return backend;
}

export function resolveCashflowDbConfig(env = process.env) {
  const backend = normalizeDbBackend(env.CASHFLOW_DB_BACKEND);
  const databaseUrl = String(env.CASHFLOW_DATABASE_URL || "").trim();
  const external = backend !== DEFAULT_DB_BACKEND;

  return {
    backend,
    databaseUrlConfigured: Boolean(databaseUrl),
    external,
    supported: SUPPORTED_DB_BACKENDS.includes(backend)
  };
}

export function assertCashflowDbBackendSupported(config = resolveCashflowDbConfig()) {
  if (config.supported) return config;

  const supported = SUPPORTED_DB_BACKENDS.join(", ");
  const error = new Error(
    `Unsupported CASHFLOW_DB_BACKEND "${config.backend}". Supported backends: ${supported}.`
  );
  error.code = "CASHFLOW_DB_BACKEND_UNSUPPORTED";
  error.status = 500;
  throw error;
}

export function assertCashflowDatabaseUrlConfigured(config) {
  if (config.backend === DEFAULT_DB_BACKEND || config.databaseUrlConfigured) return config;

  const error = new Error(
    `CASHFLOW_DB_BACKEND=${config.backend} requires CASHFLOW_DATABASE_URL to be set.`
  );
  error.code = "CASHFLOW_DATABASE_URL_REQUIRED";
  error.status = 500;
  throw error;
}
