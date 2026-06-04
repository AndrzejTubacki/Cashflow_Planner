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
  ledgerDbPath,
  logError = () => {},
  logServerEvent = () => {},
  planningDbPath,
  userDataDir
}) {
  const {
    ensureMigrationRecovery,
    markMigrationRecoveryComplete
  } = createCashflowMigrationRecoveryService({
    userDataDir,
    logError,
    logServerEvent
  });

  function openPlanningDb(userId, options = {}) {
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
        markMigrationRecoveryComplete(userId);
      }
    } catch (error) {
      db.close();
      throw error;
    }

    return db;
  }

  function openLedgerDb(userId, year, options = {}) {
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
        markMigrationRecoveryComplete(userId);
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
