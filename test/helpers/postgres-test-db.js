import { config as loadDotenv } from "dotenv";
import pg from "pg";

import {
  POSTGRES_BUDGET_TABLES
} from "../../src/server/cashflow-postgres-budget-schema.js";
import {
  POSTGRES_COORDINATION_TABLES,
  POSTGRES_GLOBAL_TABLES
} from "../../src/server/cashflow-postgres-global-schema.js";

loadDotenv({ quiet: true });

const CASHFLOW_POSTGRES_SCHEMA_TABLES = [
  "cashflow_budget_schema_version",
  "cashflow_global_schema_version",
  ...POSTGRES_COORDINATION_TABLES,
  ...POSTGRES_BUDGET_TABLES,
  ...POSTGRES_GLOBAL_TABLES
];

const CASHFLOW_POSTGRES_FUNCTIONS = [
  "cashflow_prevent_budget_owner_change",
  "cashflow_prevent_last_system_admin_delete",
  "cashflow_prevent_last_system_admin_disable"
];

function quoteIdentifier(identifier) {
  const value = String(identifier || "");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe Postgres identifier: ${value}`);
  }
  return `"${value.replace(/"/g, "\"\"")}"`;
}

export function postgresRuntimeTestsEnabled(env = process.env) {
  return env.CASHFLOW_ENABLE_POSTGRES_TESTS === "1"
    && Boolean(String(env.CASHFLOW_DATABASE_URL || "").trim());
}

export function requirePostgresRuntimeTestConfig(env = process.env) {
  if (env.CASHFLOW_ENABLE_POSTGRES_TESTS !== "1") {
    throw new Error("Set CASHFLOW_ENABLE_POSTGRES_TESTS=1 to run disposable Postgres tests");
  }
  const databaseUrl = String(env.CASHFLOW_DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("CASHFLOW_DATABASE_URL is required for disposable Postgres tests");
  }
  return { databaseUrl };
}

export async function resetPostgresCashflowObjects(client) {
  if (process.env.CASHFLOW_ENABLE_POSTGRES_TESTS !== "1") {
    throw new Error("Refusing to reset Postgres objects without CASHFLOW_ENABLE_POSTGRES_TESTS=1");
  }

  const tables = [...new Set(CASHFLOW_POSTGRES_SCHEMA_TABLES)]
    .map(quoteIdentifier)
    .join(", ");

  await client.query("BEGIN");
  try {
    if (tables) {
      await client.query(`DROP TABLE IF EXISTS ${tables} CASCADE`);
    }
    for (const functionName of CASHFLOW_POSTGRES_FUNCTIONS) {
      await client.query(`DROP FUNCTION IF EXISTS ${quoteIdentifier(functionName)}() CASCADE`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function withDisposablePostgresDb(fn) {
  const { databaseUrl } = requirePostgresRuntimeTestConfig();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await resetPostgresCashflowObjects(pool);
    return await fn({
      databaseUrl,
      pool
    });
  } finally {
    try {
      await resetPostgresCashflowObjects(pool);
    } finally {
      await pool.end();
    }
  }
}
