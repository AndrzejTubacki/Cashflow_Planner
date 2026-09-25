import crypto from "node:crypto";
import { createPostgresAuthRateLimitStore } from "./cashflow-postgres-auth-rate-limit-store.js";

import { createPostgresGlobalDbService } from "./cashflow-postgres-global-db-service.js";
import { createPostgresGlobalRepository } from "./cashflow-postgres-global-repository.js";
import { createPostgresLockService } from "./cashflow-postgres-lock-service.js";
import {
  POSTGRES_GLOBAL_TABLES
} from "./cashflow-postgres-global-schema.js";
import {
  columnsForGlobalRow,
  normalizeGlobalRowsForInsert,
  normalizeGlobalTablesForReplace,
  quoteGlobalIdentifier
} from "./cashflow-global-store-row-utils.js";

function quoteIdentifier(identifier) {
  return quoteGlobalIdentifier(identifier);
}

function assertGlobalTable(tableName) {
  const safeTable = String(tableName || "").trim();
  if (!POSTGRES_GLOBAL_TABLES.includes(safeTable)) {
    throw new Error(`Unsupported global metadata table: ${safeTable}`);
  }
  return safeTable;
}

export async function createPostgresGlobalStore({
  databaseUrl,
  logError = () => {},
  logServerEvent = () => {},
  pgModule = null,
  poolMax = 10,
  repositoryFactory = createPostgresGlobalRepository
} = {}) {
  const dbService = await createPostgresGlobalDbService({
    databaseUrl,
    logError,
    logServerEvent,
    pgModule,
    poolMax
  });

  async function withRepository(fn) {
    return await dbService.withClient(async client =>
      await fn(repositoryFactory(client), client)
    );
  }

  async function transaction(fn) {
    return await dbService.withClient(async client => {
      await client.query("BEGIN");
      try {
        const result = await fn(repositoryFactory(client), client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
        }
        throw error;
      }
    });
  }

  function createLockService(options = {}) {
    const ownerId = String(options.ownerId || `cashflow_${crypto.randomUUID()}`).trim();
    const lockOptions = { logError, ...options, ownerId };
    // Never pin a pool client across user work: nested store queries and
    // heartbeat queries must make progress even when every callback is busy.
    const client = { query: (sql, params) => dbService.withClient(connection => connection.query(sql, params)) };
    return createPostgresLockService({ ...lockOptions, client });
  }

  async function initializeLockSchema() {
    // Separate lock databases need only coordination DDL. Serialize replica
    // startup without implicitly migrating the application's global schema.
    return dbService.withClient(async client => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(73190102)");
        await client.query(`CREATE TABLE IF NOT EXISTS cashflow_runtime_locks (
          name TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
          acquired_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL, CHECK (expires_at > acquired_at)
        )`);
        await client.query("CREATE INDEX IF NOT EXISTS idx_cashflow_runtime_locks_expires_at ON cashflow_runtime_locks(expires_at)");
        await client.query("COMMIT");
        logServerEvent("cashflow_postgres_lock_schema_ready");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function listRows(tableName) {
    const safeTable = assertGlobalTable(tableName);
    return await dbService.withClient(async client => {
      const result = await client.query(`SELECT * FROM ${quoteIdentifier(safeTable)}`);
      return result?.rows || [];
    });
  }

  async function insertRows(tableName, rows = []) {
    const { tableName: safeTable, rows: normalized } = normalizeGlobalRowsForInsert(tableName, rows);
    return await dbService.withClient(async client => {
      await client.query("BEGIN");
      try {
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForGlobalRow(safeTable, row);
          const result = await client.query(
            `
              INSERT INTO ${quoteIdentifier(safeTable)} (${columns.map(quoteIdentifier).join(", ")})
              VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
            `,
            columns.map(column => row[column] ?? null)
          );
          inserted += Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return {
          inserted,
          tableName: safeTable
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function replaceRows(tableName, rows = []) {
    const { tableName: safeTable, rows: normalized } = normalizeGlobalRowsForInsert(tableName, rows);
    return await dbService.withClient(async client => {
      await client.query("BEGIN");
      try {
        await client.query(`SET CONSTRAINTS ALL DEFERRED`);
        await client.query(`DELETE FROM ${quoteIdentifier(safeTable)}`);
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForGlobalRow(safeTable, row);
          const result = await client.query(
            `
              INSERT INTO ${quoteIdentifier(safeTable)} (${columns.map(quoteIdentifier).join(", ")})
              VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
            `,
            columns.map(column => row[column] ?? null)
          );
          inserted += Number(result?.rowCount || 0);
        }
        await client.query("COMMIT");
        return {
          inserted,
          replaced: true,
          tableName: safeTable
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  async function replaceAllRows(tables = {}) {
    const normalizedTables = normalizeGlobalTablesForReplace(tables);
    return await dbService.withClient(async client => {
      await client.query("BEGIN");
      try {
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        for (const tableName of [...POSTGRES_GLOBAL_TABLES].reverse()) {
          await client.query(`DELETE FROM ${quoteIdentifier(tableName)}`);
        }

        const inserted = {};
        for (const tableName of POSTGRES_GLOBAL_TABLES) {
          inserted[tableName] = 0;
          for (const row of normalizedTables[tableName]) {
            const columns = columnsForGlobalRow(tableName, row);
            const result = await client.query(
              `
                INSERT INTO ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(", ")})
                VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
              `,
              columns.map(column => row[column] ?? null)
            );
            inserted[tableName] += Number(result?.rowCount || 0);
          }
        }
        for (const tableName of POSTGRES_GLOBAL_TABLES) {
        }
        await client.query("COMMIT");
        return {
          inserted,
          replaced: true
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }

  return {
    backend: "postgres",
    checkReadiness: dbService.checkReadiness,
    close: dbService.close,
    createLockService,
    createAuthRateLimitStore: () => createPostgresAuthRateLimitStore({ withClient: dbService.withClient }),
    initialize: dbService.initializeGlobalSchema,
    initializeLockSchema,
    insertRows,
    listRows,
    replaceAllRows,
    replaceRows,
    transaction,
    withRepository
  };
}
