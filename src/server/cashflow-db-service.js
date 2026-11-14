import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  LEDGER_COLUMNS,
  ledgerYearViewSql,
  LEDGER_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION
} from "./cashflow-schema.js";
import { initializePlanningSchema } from "./cashflow-schema.js";
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
        mergeLegacyLedgerFiles(userId, db, { fresh: true });
      } else {
        applyPlanningMigrations(db);
        mergeLegacyLedgerFiles(userId, db);
        completeMigrationRecovery(userId);
      }
    } catch (error) {
      db.close();
      throw error;
    }

    return db;
  }

  /** Legacy ledger_YYYY.sqlite files are imported into planning.sqlite once, in
   * one transaction behind ledger_merge_state; afterwards they are renamed to
   * *.merged (kept as a recovery copy, never read again). Very old rows with
   * no confirmed_date get their scheduled date, the fallback every ledger
   * reader already applied. A crash after the
   * commit only leaves files to rename on the next open. */
  function legacyLedgerFiles(userId) {
    const dir = userDataDir(userId, { create: false });
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map(name => ({ name, match: name.match(/^ledger_(\d{4})\.sqlite$/) }))
      .filter(entry => entry.match).map(entry => ({ year: Number(entry.match[1]), file: path.join(dir, entry.name) }));
  }

  function mergeLegacyLedgerFiles(userId, db, { fresh = false } = {}) {
    const files = legacyLedgerFiles(userId);
    if (fresh && !files.length) return;
    // A brand-new planning file starts merged, unless ledger-only legacy files
    // already sit beside it (a confirmed-only user).
    if (fresh) db.prepare("DELETE FROM ledger_merge_state").run();
    const merged = Boolean(db.prepare("SELECT 1 FROM ledger_merge_state WHERE id = 1").get());
    if (!merged) {
      const insert = db.prepare(`INSERT INTO ledger_transactions (${LEDGER_COLUMNS.join(", ")}, ledger_year)
        VALUES (${LEDGER_COLUMNS.map(() => "?").join(", ")}, ?)`);
      const rowsByYear = files.map(({ year, file }) => {
        const ledger = new Database(file);
        try {
          initPragmas(ledger);
          applyLedgerMigrations(ledger, { occurrenceKeyFromRow });
          return { year, rows: ledger.prepare("SELECT * FROM confirmed_transactions").all() };
        } finally { ledger.close(); }
      });
      db.transaction(() => {
        for (const { year, rows } of rowsByYear) for (const row of rows) insert.run(...LEDGER_COLUMNS.map(column => (column === "confirmed_date" ? row.confirmed_date || row.date : row[column]) ?? null), year);
        db.prepare("INSERT INTO ledger_merge_state (id, merged_at) VALUES (1, datetime('now'))").run();
      }).immediate();
      if (files.length) logServerEvent("cashflow_ledger_merged_into_planning", { userId, files: files.length });
    }
    for (const { file } of files) {
      for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, `${file}${suffix}.merged`);
    }
  }

  /** A planning.sqlite connection whose `confirmed_transactions` view shows one
   * ledger year (see ledgerYearViewSql). */
  function openLedgerDb(userId, year, options = {}) {
    assertNotPostgresBackend("ledger", { userId, year });
    const viewSql = ledgerYearViewSql(year);
    const db = openPlanningDb(userId, { create: options.create !== false });
    try {
      db.exec(viewSql);
    } catch (error) { db.close(); throw error; }
    return db;
  }

  /** Ledger years that hold rows (merging any legacy files first). */
  function listLedgerYears(userId) {
    const dir = userDataDir(userId, { create: false });
    if (!fs.existsSync(dir)) return [];
    if (!fs.existsSync(planningDbPath(userId, { create: false }))) {
      // Not opened since the merge shipped: the legacy files name the years.
      return legacyLedgerFiles(userId).map(entry => String(entry.year)).sort();
    }
    const db = openPlanningDb(userId, { create: false });
    try {
      return db.prepare("SELECT DISTINCT ledger_year FROM ledger_transactions ORDER BY ledger_year").all().map(row => String(row.ledger_year));
    } finally { db.close(); }
  }

  return {
    initReadOnlyPragmas,
    listLedgerYears,
    openLedgerDb,
    openPlanningDb
  };
}
