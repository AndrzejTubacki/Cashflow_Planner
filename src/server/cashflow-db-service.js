import Database from "better-sqlite3";
import fs from "fs";
import {
  initializeLedgerSchema,
  initializePlanningSchema,
  LEDGER_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION
} from "./cashflow-schema.js";
import {
  applyLedgerMigrations,
  applyPlanningMigrations
} from "./cashflow-migrations.js";
import { createCashflowMigrationRecoveryService } from "./cashflow-migration-recovery.js";
import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";
import { userNotFoundError } from "./cashflow-user-utils.js";

function initPragmas(db) {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
}

function initReadOnlyPragmas(db) {
  db.pragma("foreign_keys = ON");
  db.pragma("query_only = ON");
  db.pragma("busy_timeout = 5000");
}

function schemaVersion(dbPath) {
  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true
  });

  try {
    return db.pragma("user_version", { simple: true });
  } finally {
    db.close();
  }
}

export function createCashflowDbService({
  isPostgresBackend = () => false,
  ledgerDbPath,
  logError = () => {},
  logServerEvent = () => {},
  onMigrationRecoveryComplete = () => {},
  planningDbPath,
  userDataDir
}) {
  // Every mutating planner/ledger code path is expected to check
  // budgetStore.backend and route through the Postgres-aware sibling before
  // it would ever reach these openers. Two real bugs this session
  // (createBudgetAsync, POST /api/setup) traced back to a sync-only path
  // still calling one of these under a live Postgres backend anyway — each
  // only surfaced when actually exercised. Rather than trying to statically
  // audit every call site and hope nothing is missed, this throws the
  // instant it happens, with enough detail (caller stack included) to find
  // the offending call site immediately instead of days later.
  function assertNotPostgresBackend(kind, details) {
    if (!isPostgresBackend()) return;

    const error = new Error(
      `cashflow-db-service: attempted to open a SQLite ${kind} database while CASHFLOW_DB_BACKEND=postgres is active. ` +
      "This means a code path bypassed the Postgres budget store instead of routing through its async sibling."
    );
    error.code = "CASHFLOW_SQLITE_OPENER_USED_UNDER_POSTGRES_BACKEND";
    logError("cashflow_sqlite_opener_used_under_postgres_backend", {
      ...details,
      kind,
      message: error.message,
      stack: error.stack
    });
    throw error;
  }

  const {
    ensureMigrationRecovery,
    markMigrationRecoveryComplete
  } = createCashflowMigrationRecoveryService({
    userDataDir,
    logError,
    logServerEvent
  });

  function completeMigrationRecovery(userId) {
    const recoveryPath = markMigrationRecoveryComplete(userId);
    if (!recoveryPath) return;
    try {
      onMigrationRecoveryComplete(userId, recoveryPath);
    } catch (error) {
      logError("cashflow_migration_recovery_completion_callback_failed", {
        userId,
        recoveryPath,
        error: error.message
      });
    }
  }

  function openPlanningDb(userId, options = {}) {
    assertNotPostgresBackend("planning", { userId });
    const { create = true } = options;
    const dbPath = planningDbPath(userId, { create });
    const isNew = !fs.existsSync(dbPath);
    if (!create && isNew) {
      throw userNotFoundError(userId);
    }
    if (!isNew) {
      const sourceVersion = schemaVersion(dbPath);
      if (sourceVersion < PLANNING_SCHEMA_VERSION) {
        ensureMigrationRecovery(userId, {
          kind: "planning",
          file: "planning.sqlite",
          sourceVersion,
          targetVersion: PLANNING_SCHEMA_VERSION
        });
      }
    }
    const db = new Database(dbPath);
    initPragmas(db);

    try {
      if (isNew) {
        initializePlanningSchema(db);
      } else {
        applyPlanningMigrations(db);
        completeMigrationRecovery(userId);
      }
    } catch (error) {
      db.close();
      throw error;
    }

    return db;
  }

  function openLedgerDb(userId, year, options = {}) {
    assertNotPostgresBackend("ledger", { userId, year });
    const { create = true } = options;
    const dbPath = ledgerDbPath(userId, year, { create });
    const isNew = !fs.existsSync(dbPath);
    if (!create && isNew) {
      throw userNotFoundError(userId);
    }
    if (!isNew) {
      const sourceVersion = schemaVersion(dbPath);
      if (sourceVersion < LEDGER_SCHEMA_VERSION) {
        ensureMigrationRecovery(userId, {
          kind: "ledger",
          file: `ledger_${year}.sqlite`,
          sourceVersion,
          targetVersion: LEDGER_SCHEMA_VERSION
        });
      }
    }
    const db = new Database(dbPath);
    initPragmas(db);

    try {
      if (isNew) {
        initializeLedgerSchema(db);
      } else {
        applyLedgerMigrations(db, { occurrenceKeyFromRow });
        completeMigrationRecovery(userId);
      }
    } catch (error) {
      db.close();
      throw error;
    }

    return db;
  }

  function listLedgerYears(userId) {
    const dir = userDataDir(userId, { create: false });
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
      .map(name => {
        const match = name.match(/^ledger_(\d{4})\.sqlite$/);
        return match ? match[1] : null;
      })
      .filter(Boolean)
      .sort();
  }

  return {
    initReadOnlyPragmas,
    listLedgerYears,
    openLedgerDb,
    openPlanningDb
  };
}
