import crypto from "node:crypto";

import { createCashflowGlobalDbService } from "./cashflow-global-db-service.js";
import { createSqliteGlobalRepository } from "./cashflow-global-repository.js";
import {
  dropGlobalRuntimeGuardTriggers,
  ensureGlobalRuntimeSchemaObjects,
  GLOBAL_SCHEMA_VERSION,
  GLOBAL_TABLE_NAMES
} from "./cashflow-global-schema.js";
import {
  columnsForGlobalRow,
  normalizeGlobalRowsForInsert,
  normalizeGlobalTablesForReplace,
  quoteGlobalIdentifier
} from "./cashflow-global-store-row-utils.js";
import { normalizeSqliteBindValue } from "./cashflow-sqlite-bind-utils.js";

function quoteIdentifier(identifier) {
  return quoteGlobalIdentifier(identifier);
}

function assertGlobalTable(tableName) {
  const safeTable = String(tableName || "").trim();
  if (!GLOBAL_TABLE_NAMES.includes(safeTable)) {
    throw new Error(`Unsupported global metadata table: ${safeTable}`);
  }
  return safeTable;
}

function normalizeLockName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(name)) {
    throw new Error("Lock name must be 1-128 chars using letters, numbers, colon, underscore, or dash");
  }
  return name;
}

function normalizeTtl(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1000 || number > 3600000) {
    return fallback;
  }
  return Math.trunc(number);
}

function createInProcessLockService({
  defaultTtlMs = 120000,
  locks = new Map(),
  now = () => new Date(),
  ownerId = `cashflow_${crypto.randomUUID()}`
} = {}) {
  const normalizedOwnerId = String(ownerId || "").trim();
  if (!normalizedOwnerId) {
    throw new Error("In-process lock service requires ownerId");
  }

  function currentMs() {
    const value = now();
    return value instanceof Date ? value.getTime() : new Date(value).getTime();
  }

  async function tryAcquire(name, options = {}) {
    const normalizedName = normalizeLockName(name);
    const timestamp = currentMs();
    const expiresAtMs = timestamp + normalizeTtl(options.ttlMs, defaultTtlMs);
    const existing = locks.get(normalizedName);

    if (existing && existing.expiresAtMs > timestamp && existing.owner_id !== normalizedOwnerId) {
      return {
        acquired: false,
        lock: null
      };
    }

    const lock = {
      name: normalizedName,
      owner_id: normalizedOwnerId,
      expires_at: new Date(expiresAtMs).toISOString(),
      expiresAtMs
    };
    locks.set(normalizedName, lock);
    return {
      acquired: true,
      lock: {
        name: lock.name,
        owner_id: lock.owner_id,
        expires_at: lock.expires_at
      }
    };
  }

  async function renew(name, options = {}) {
    const normalizedName = normalizeLockName(name);
    const timestamp = currentMs();
    const existing = locks.get(normalizedName);
    if (!existing || existing.owner_id !== normalizedOwnerId || existing.expiresAtMs <= timestamp) {
      return {
        renewed: false,
        lock: null
      };
    }

    existing.expiresAtMs = timestamp + normalizeTtl(options.ttlMs, defaultTtlMs);
    existing.expires_at = new Date(existing.expiresAtMs).toISOString();
    return {
      renewed: true,
      lock: {
        name: existing.name,
        owner_id: existing.owner_id,
        expires_at: existing.expires_at
      }
    };
  }

  async function release(name) {
    const normalizedName = normalizeLockName(name);
    const existing = locks.get(normalizedName);
    if (!existing || existing.owner_id !== normalizedOwnerId) return 0;
    locks.delete(normalizedName);
    return 1;
  }

  async function withLock(name, fn, options = {}) {
    const acquireResult = await tryAcquire(name, options);
    if (!acquireResult.acquired) {
      return {
        acquired: false,
        skipped: true
      };
    }

    try {
      const result = await fn(acquireResult.lock);
      return {
        acquired: true,
        result
      };
    } finally {
      await release(name);
    }
  }

  return {
    ownerId: normalizedOwnerId,
    release,
    renew,
    tryAcquire,
    withLock
  };
}

export function createSqliteGlobalStore({
  beforeGlobalMigrationStep = () => {},
  createLockService = createInProcessLockService,
  dataDir,
  listCashflowUserIds,
  logError = () => {},
  logServerEvent = () => {},
  repositoryFactory = createSqliteGlobalRepository
} = {}) {
  const dbService = createCashflowGlobalDbService({
    beforeGlobalMigrationStep,
    dataDir,
    listCashflowUserIds,
    logError,
    logServerEvent
  });

  function withRepository(fn) {
    const db = dbService.openGlobalDb();
    let result;
    try {
      result = fn(repositoryFactory(db), db);
    } catch (error) {
      db.close();
      throw error;
    }
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        db.close();
      });
    }
    db.close();
    return result;
  }

  function transaction(fn) {
    const db = dbService.openGlobalDb();
    try {
      const repo = repositoryFactory(db);
      const run = db.transaction(() => {
        const result = fn(repo, db);
        if (result && typeof result.then === "function") {
          throw new Error("SQLite global-store transaction callbacks must be synchronous");
        }
        return result;
      });
      return run();
    } finally {
      db.close();
    }
  }

  function checkReadiness() {
    const db = dbService.openGlobalDb();
    try {
      const version = Number(db.pragma("user_version", { simple: true }) || 0);
      if (version !== GLOBAL_SCHEMA_VERSION) {
        const error = new Error(
          `SQLite global schema version mismatch: expected ${GLOBAL_SCHEMA_VERSION}, got ${Number.isFinite(version) ? version : "missing"}`
        );
        error.code = "CASHFLOW_SQLITE_GLOBAL_SCHEMA_VERSION_MISMATCH";
        throw error;
      }
      return {
        ok: true,
        backend: "sqlite",
        globalSchemaVersion: version
      };
    } finally {
      db.close();
    }
  }

  async function listRows(tableName) {
    const safeTable = assertGlobalTable(tableName);
    const db = dbService.openGlobalDb();
    try {
      return db.prepare(`SELECT * FROM ${quoteIdentifier(safeTable)}`).all();
    } finally {
      db.close();
    }
  }

  async function insertRows(tableName, rows = []) {
    const { tableName: safeTable, rows: normalized } = normalizeGlobalRowsForInsert(tableName, rows);
    const db = dbService.openGlobalDb();
    try {
      const insertAll = db.transaction(() => {
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForGlobalRow(safeTable, row);
          const statement = db.prepare(`
            INSERT INTO ${quoteIdentifier(safeTable)} (${columns.map(quoteIdentifier).join(", ")})
            VALUES (${columns.map(() => "?").join(", ")})
          `);
          inserted += statement.run(columns.map(column => normalizeSqliteBindValue(row[column]))).changes;
        }
        return inserted;
      });
      return {
        inserted: insertAll(),
        tableName: safeTable
      };
    } finally {
      db.close();
    }
  }

  async function replaceRows(tableName, rows = []) {
    const { tableName: safeTable, rows: normalized } = normalizeGlobalRowsForInsert(tableName, rows);
    const db = dbService.openGlobalDb();
    try {
      const replaceAll = db.transaction(() => {
        db.prepare(`DELETE FROM ${quoteIdentifier(safeTable)}`).run();
        let inserted = 0;
        for (const row of normalized) {
          const columns = columnsForGlobalRow(safeTable, row);
          const statement = db.prepare(`
            INSERT INTO ${quoteIdentifier(safeTable)} (${columns.map(quoteIdentifier).join(", ")})
            VALUES (${columns.map(() => "?").join(", ")})
          `);
          inserted += statement.run(columns.map(column => normalizeSqliteBindValue(row[column]))).changes;
        }
        return inserted;
      });
      return {
        inserted: replaceAll(),
        replaced: true,
        tableName: safeTable
      };
    } finally {
      db.close();
    }
  }

  async function replaceAllRows(tables = {}) {
    const normalizedTables = normalizeGlobalTablesForReplace(tables);
    const db = dbService.openGlobalDb();
    try {
      const replaceAll = db.transaction(() => {
        dropGlobalRuntimeGuardTriggers(db);
        for (const tableName of [...GLOBAL_TABLE_NAMES].reverse()) {
          db.prepare(`DELETE FROM ${quoteIdentifier(tableName)}`).run();
        }

        const inserted = {};
        for (const tableName of GLOBAL_TABLE_NAMES) {
          inserted[tableName] = 0;
          for (const row of normalizedTables[tableName]) {
            const columns = columnsForGlobalRow(tableName, row);
            const statement = db.prepare(`
              INSERT INTO ${quoteIdentifier(tableName)} (${columns.map(quoteIdentifier).join(", ")})
              VALUES (${columns.map(() => "?").join(", ")})
            `);
            inserted[tableName] += statement.run(columns.map(column => normalizeSqliteBindValue(row[column]))).changes;
          }
        }

        ensureGlobalRuntimeSchemaObjects(db);
        db.pragma(`user_version = ${GLOBAL_SCHEMA_VERSION}`);
        return inserted;
      });
      return {
        inserted: replaceAll(),
        replaced: true
      };
    } finally {
      db.close();
    }
  }

  return {
    backend: "sqlite",
    checkReadiness,
    close: async () => {},
    createLockService,
    globalDbPath: dbService.globalDbPath,
    initialize: () => {
      const db = dbService.openGlobalDb();
      db.close();
    },
    insertRows,
    listRows,
    replaceAllRows,
    replaceRows,
    transaction,
    withRepository
  };
}
