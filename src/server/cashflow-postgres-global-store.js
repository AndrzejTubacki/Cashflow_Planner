import crypto from "node:crypto";

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
  repositoryFactory = createPostgresGlobalRepository
} = {}) {
  const dbService = await createPostgresGlobalDbService({
    databaseUrl,
    logError,
    logServerEvent,
    pgModule
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
    const lockOptions = { ...options, ownerId };
    return {
      ownerId,
      release: async name => await dbService.withClient(async client =>
        await createPostgresLockService({ ...lockOptions, client }).release(name)
      ),
      renew: async (name, renewOptions = {}) => await dbService.withClient(async client =>
        await createPostgresLockService({ ...lockOptions, client }).renew(name, renewOptions)
      ),
      tryAcquire: async (name, acquireOptions = {}) => await dbService.withClient(async client =>
        await createPostgresLockService({ ...lockOptions, client }).tryAcquire(name, acquireOptions)
      ),
      withLock: async (name, fn, acquireOptions = {}) => await dbService.withClient(async client =>
        await createPostgresLockService({ ...lockOptions, client }).withLock(name, fn, acquireOptions)
      )
    };
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
        await client.query(`ALTER TABLE ${quoteIdentifier(safeTable)} DISABLE TRIGGER USER`);
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
        await client.query(`ALTER TABLE ${quoteIdentifier(safeTable)} ENABLE TRIGGER USER`);
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
        for (const tableName of POSTGRES_GLOBAL_TABLES) {
          await client.query(`ALTER TABLE ${quoteIdentifier(tableName)} DISABLE TRIGGER USER`);
        }
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
          await client.query(`ALTER TABLE ${quoteIdentifier(tableName)} ENABLE TRIGGER USER`);
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
    initialize: dbService.initializeGlobalSchema,
    insertRows,
    listRows,
    replaceAllRows,
    replaceRows,
    transaction,
    withRepository
  };
}
