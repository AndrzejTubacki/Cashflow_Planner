import Database from "better-sqlite3";
import fs from "fs";
import {
  initializeLedgerSchema,
  initializePlanningSchema
} from "./cashflow-schema.js";
import {
  applyLedgerMigrations,
  applyPlanningMigrations
} from "./cashflow-migrations.js";
import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";

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

export function createCashflowDbService({
  ledgerDbPath,
  planningDbPath,
  userDataDir
}) {
  function openPlanningDb(userId) {
    const dbPath = planningDbPath(userId);
    const isNew = !fs.existsSync(dbPath);
    const db = new Database(dbPath);
    initPragmas(db);

    if (isNew) {
      initializePlanningSchema(db);
    } else {
      applyPlanningMigrations(db);
    }

    return db;
  }

  function openLedgerDb(userId, year) {
    const dbPath = ledgerDbPath(userId, year);
    const isNew = !fs.existsSync(dbPath);
    const db = new Database(dbPath);
    initPragmas(db);

    if (isNew) {
      initializeLedgerSchema(db);
    } else {
      applyLedgerMigrations(db, { occurrenceKeyFromRow });
    }

    return db;
  }

  function listLedgerYears(userId) {
    const dir = userDataDir(userId);
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
