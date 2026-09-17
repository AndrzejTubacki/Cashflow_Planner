import {
  createPostgresBudgetStorageSchemaSql,
  POSTGRES_LEDGER_SCHEMA_VERSION,
  POSTGRES_PLANNING_SCHEMA_VERSION
} from "./cashflow-postgres-budget-schema.js";

export const POSTGRES_BUDGET_DRIVER_MISSING_CODE = "CASHFLOW_POSTGRES_BUDGET_DRIVER_MISSING";

async function loadPgModule(pgModule = null) {
  if (pgModule) return pgModule;
  try {
    return await import("pg");
  } catch (error) {
    const wrapped = new Error(
      "Postgres budget storage support requires the pg package. External database runtime is not enabled in this build."
    );
    wrapped.code = POSTGRES_BUDGET_DRIVER_MISSING_CODE;
    wrapped.cause = error;
    throw wrapped;
  }
}

function poolConstructor(pgModule) {
  return pgModule?.Pool || pgModule?.default?.Pool;
}

function missingDatabaseUrlError() {
  const error = new Error("CASHFLOW_DATABASE_URL is required for Postgres budget storage");
  error.code = "CASHFLOW_DATABASE_URL_REQUIRED";
  throw error;
}

export async function createPostgresBudgetDbService({
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
    error.code = POSTGRES_BUDGET_DRIVER_MISSING_CODE;
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

  async function initializeBudgetSchema() {
    return await withClient(async client => {
      try {
        await client.query("BEGIN");
        await client.query(createPostgresBudgetStorageSchemaSql({ includeTransaction: false }));
        await client.query("COMMIT");
        logServerEvent("cashflow_postgres_budget_schema_ready", {
          ledgerVersion: POSTGRES_LEDGER_SCHEMA_VERSION,
          planningVersion: POSTGRES_PLANNING_SCHEMA_VERSION
        });
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          logError("cashflow_postgres_budget_schema_rollback_failed", {
            error: rollbackError.message
          });
        }
        logError("cashflow_postgres_budget_schema_failed", {
          error: error.message
        });
        throw error;
      }
    });
  }

  async function checkReadiness() {
    return await withClient(async client => {
      const result = await client.query(
        "SELECT planning_version, ledger_version FROM cashflow_budget_schema_version WHERE id = $1",
        [1]
      );
      const planningVersion = Number(result?.rows?.[0]?.planning_version);
      const ledgerVersion = Number(result?.rows?.[0]?.ledger_version);
      if (
        planningVersion !== POSTGRES_PLANNING_SCHEMA_VERSION
        || ledgerVersion !== POSTGRES_LEDGER_SCHEMA_VERSION
      ) {
        const error = new Error(
          `Postgres budget schema version mismatch: expected planning ${POSTGRES_PLANNING_SCHEMA_VERSION}/ledger ${POSTGRES_LEDGER_SCHEMA_VERSION}, got planning ${Number.isFinite(planningVersion) ? planningVersion : "missing"}/ledger ${Number.isFinite(ledgerVersion) ? ledgerVersion : "missing"}`
        );
        error.code = "CASHFLOW_POSTGRES_BUDGET_SCHEMA_VERSION_MISMATCH";
        throw error;
      }
      return {
        ok: true,
        backend: "postgres",
        ledgerSchemaVersion: ledgerVersion,
        planningSchemaVersion: planningVersion
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
    initializeBudgetSchema,
    withClient
  };
}
