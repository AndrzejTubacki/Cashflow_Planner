import {
  createPostgresGlobalSchemaSql,
  POSTGRES_GLOBAL_SCHEMA_VERSION
} from "./cashflow-postgres-global-schema.js";

export const POSTGRES_DRIVER_MISSING_CODE = "CASHFLOW_POSTGRES_DRIVER_MISSING";

async function loadPgModule(pgModule = null) {
  if (pgModule) return pgModule;
  try {
    return await import("pg");
  } catch (error) {
    const wrapped = new Error(
      "Postgres support requires the pg package. External database runtime is not enabled in this build."
    );
    wrapped.code = POSTGRES_DRIVER_MISSING_CODE;
    wrapped.cause = error;
    throw wrapped;
  }
}

function poolConstructor(pgModule) {
  return pgModule?.Pool || pgModule?.default?.Pool;
}

function missingDatabaseUrlError() {
  const error = new Error("CASHFLOW_DATABASE_URL is required for Postgres global storage");
  error.code = "CASHFLOW_DATABASE_URL_REQUIRED";
  throw error;
}

export async function createPostgresGlobalDbService({
  databaseUrl,
  logError = () => {},
  logServerEvent = () => {},
  pgModule = null
} = {}) {
  if (!String(databaseUrl || "").trim()) missingDatabaseUrlError();

  const loadedPg = await loadPgModule(pgModule);
  const Pool = poolConstructor(loadedPg);
  if (typeof Pool !== "function") {
    const error = new Error("Postgres driver does not expose a Pool constructor");
    error.code = POSTGRES_DRIVER_MISSING_CODE;
    throw error;
  }

  const pool = new Pool({
    connectionString: databaseUrl
  });

  async function withClient(fn) {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async function initializeGlobalSchema() {
    return withClient(async client => {
      try {
        await client.query("BEGIN");
        await client.query(createPostgresGlobalSchemaSql({ includeTransaction: false }));
        await client.query("COMMIT");
        logServerEvent("cashflow_postgres_global_schema_ready", {
          version: POSTGRES_GLOBAL_SCHEMA_VERSION
        });
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          logError("cashflow_postgres_global_schema_rollback_failed", {
            error: rollbackError.message
          });
        }
        logError("cashflow_postgres_global_schema_failed", {
          error: error.message
        });
        throw error;
      }
    });
  }

  async function checkReadiness() {
    return withClient(async client => {
      const result = await client.query(
        "SELECT version FROM cashflow_global_schema_version WHERE id = $1",
        [1]
      );
      const version = Number(result?.rows?.[0]?.version);
      if (version !== POSTGRES_GLOBAL_SCHEMA_VERSION) {
        const error = new Error(
          `Postgres global schema version mismatch: expected ${POSTGRES_GLOBAL_SCHEMA_VERSION}, got ${Number.isFinite(version) ? version : "missing"}`
        );
        error.code = "CASHFLOW_POSTGRES_GLOBAL_SCHEMA_VERSION_MISMATCH";
        throw error;
      }
      return {
        ok: true,
        backend: "postgres",
        globalSchemaVersion: version
      };
    });
  }

  async function close() {
    if (typeof pool.end === "function") {
      await pool.end();
    }
  }

  return {
    backend: "postgres",
    checkReadiness,
    close,
    initializeGlobalSchema,
    withClient
  };
}
