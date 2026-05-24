import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  replaceTableRowsFromBackup,
  tableExists
} from "./cashflow-db-utils.js";

export function createCashflowBackupService({
  backupRootDir,
  directorySizeBytes,
  generateId,
  getSettings,
  initReadOnlyPragmas,
  listLedgerYears,
  openLedgerDb,
  openPlanningDb,
  recalculateLedgerRunningBalance,
  regenerateProjectionsAfterMutation
}) {
  function validateBackupFolderForRestore(backupPath) {
    if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isDirectory()) {
      throw new Error("Backup folder not found");
    }

    const planningSource = path.join(backupPath, "planning.sqlite");

    if (!fs.existsSync(planningSource)) {
      throw new Error("Backup is missing planning.sqlite");
    }

    const backupLedgerYears = fs.readdirSync(backupPath)
      .map(name => {
        const match = name.match(/^ledger_(\d{4})\.sqlite$/);
        return match ? match[1] : null;
      })
      .filter(Boolean);

    const planningDb = new Database(planningSource, {
      readonly: true,
      fileMustExist: true
    });

    try {
      initReadOnlyPragmas(planningDb);

      const integrity = planningDb.prepare("PRAGMA integrity_check").get();
      if (integrity.integrity_check !== "ok") {
        throw new Error(`Backup planning.sqlite integrity check failed: ${integrity.integrity_check}`);
      }

      const requiredTables = [
        "settings",
        "planned_transactions",
        "recurring_expenses",
        "recurring_incomes",
        "flex_transactions",
        "goals",
        "one_off_transactions",
        "pending_transactions",
        "future_transactions"
      ];

      for (const tableName of requiredTables) {
        if (!tableExists(planningDb, tableName)) {
          throw new Error(`Backup planning.sqlite missing table: ${tableName}`);
        }
      }
    } finally {
      planningDb.close();
    }

    for (const year of backupLedgerYears) {
      const ledgerPath = path.join(backupPath, `ledger_${year}.sqlite`);
      const ledgerDb = new Database(ledgerPath, {
        readonly: true,
        fileMustExist: true
      });

      try {
        initReadOnlyPragmas(ledgerDb);

        const integrity = ledgerDb.prepare("PRAGMA integrity_check").get();
        if (integrity.integrity_check !== "ok") {
          throw new Error(`Backup ledger_${year}.sqlite integrity check failed: ${integrity.integrity_check}`);
        }

        if (!tableExists(ledgerDb, "confirmed_transactions")) {
          throw new Error(`Backup ledger_${year}.sqlite missing confirmed_transactions`);
        }
      } finally {
        ledgerDb.close();
      }
    }

    return {
      planningSource,
      backupLedgerYears
    };
  }

  function validateCashflowData(userId) {
    const db = openPlanningDb(userId);
    const warnings = [];

    try {
      const duplicateOperating = db.prepare(`
        SELECT operating_priority AS priority, COUNT(*) AS count
        FROM planned_transactions
        WHERE type IN ('recurring_expense', 'flex')
          AND operating_priority IS NOT NULL
        GROUP BY operating_priority
        HAVING COUNT(*) > 1
      `).all();

      for (const row of duplicateOperating) {
        warnings.push({
          type: "duplicate_operating_priority",
          message: `Duplicate operating priority ${row.priority}`,
          details: row
        });
      }

      const duplicateGoals = db.prepare(`
        SELECT goal_priority AS priority, COUNT(*) AS count
        FROM planned_transactions
        WHERE type = 'goal'
          AND goal_priority IS NOT NULL
        GROUP BY goal_priority
        HAVING COUNT(*) > 1
      `).all();

      for (const row of duplicateGoals) {
        warnings.push({
          type: "duplicate_goal_priority",
          message: `Duplicate goal priority ${row.priority}`,
          details: row
        });
      }

      const badFlex = db.prepare(`
        SELECT *
        FROM flex_transactions
        WHERE allow_split = 1
          AND min_amount IS NOT NULL
          AND max_amount IS NOT NULL
          AND min_amount > max_amount
      `).all();

      for (const row of badFlex) {
        warnings.push({
          type: "invalid_flex_min_max",
          message: `${row.name} has min_amount greater than max_amount`,
          details: row
        });
      }

      const orphanPlanned = db.prepare(`
        SELECT pt.*
        FROM planned_transactions pt
        LEFT JOIN recurring_expenses re ON re.planned_transaction_id = pt.id
        LEFT JOIN flex_transactions f ON f.planned_transaction_id = pt.id
        LEFT JOIN goals g ON g.planned_transaction_id = pt.id
        WHERE re.id IS NULL AND f.id IS NULL AND g.id IS NULL
      `).all();

      for (const row of orphanPlanned) {
        warnings.push({
          type: "orphan_planned_transaction",
          message: `Orphan planned transaction ${row.id}`,
          details: row
        });
      }

      const invalidPending = db.prepare(`
        SELECT *
        FROM pending_transactions
        WHERE amount < 0
          OR date IS NULL
          OR currency IS NULL
      `).all();

      for (const row of invalidPending) {
        warnings.push({
          type: "invalid_pending_transaction",
          message: `Invalid pending transaction ${row.id}`,
          details: row
        });
      }

      db.prepare(`
        INSERT INTO event_log (id, action, entity_type, entity_id, details, timestamp)
        VALUES (?, 'validation_completed', 'cashflow', ?, ?, datetime('now'))
      `).run(
        generateId("event"),
        userId,
        JSON.stringify({ warning_count: warnings.length, warnings })
      );

      return {
        ok: warnings.length === 0,
        warnings
      };
    } finally {
      db.close();
    }
  }

  function cleanupOldBackups(userId) {
    const settings = getSettings(userId);
    const retention = Math.max(1, Number(settings?.backup_retention_count || 10));
    const dir = backupRootDir(userId, settings);

    if (!fs.existsSync(dir)) return 0;

    const backups = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith("backup_"))
      .map(entry => {
        const fullPath = path.join(dir, entry.name);
        return {
          path: fullPath,
          mtimeMs: fs.statSync(fullPath).mtimeMs
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const toDelete = backups.slice(retention);

    for (const backup of toDelete) {
      fs.rmSync(backup.path, { recursive: true, force: true });
    }

    return toDelete.length;
  }

  function maybeRunAutomaticBackup(userId) {
    const settings = getSettings(userId);

    if (!Number(settings?.auto_backup_enabled)) return null;

    const intervalMinutes = Number(settings?.backup_interval_minutes || 1440);
    const db = openPlanningDb(userId);

    try {
      const lastBackup = db.prepare(`
        SELECT backup_timestamp
        FROM backup_metadata
        WHERE success = 1
        ORDER BY backup_timestamp DESC
        LIMIT 1
      `).get();

      if (lastBackup?.backup_timestamp) {
        const ageMs = Date.now() - new Date(lastBackup.backup_timestamp).getTime();
        const requiredMs = intervalMinutes * 60 * 1000;

        if (ageMs < requiredMs) return null;
      }
    } finally {
      db.close();
    }

    const backupPath = createBackup(userId);
    const deleted = cleanupOldBackups(userId);

    return { backupPath, deleted };
  }

  function createBackup(userId) {
    const settings = getSettings(userId);
    const dir = backupRootDir(userId, settings);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupRoot = path.join(dir, `backup_${timestamp}`);

    fs.mkdirSync(backupRoot, { recursive: true });

    const planningBackupPath = path.join(backupRoot, "planning.sqlite");
    const planningDb = openPlanningDb(userId);

    try {
      planningDb.prepare("VACUUM INTO ?").run(planningBackupPath);
    } finally {
      planningDb.close();
    }

    for (const year of listLedgerYears(userId)) {
      const ledgerBackupPath = path.join(backupRoot, `ledger_${year}.sqlite`);
      const ledgerDb = openLedgerDb(userId, year);

      try {
        ledgerDb.prepare("VACUUM INTO ?").run(ledgerBackupPath);
      } finally {
        ledgerDb.close();
      }
    }

    const db = openPlanningDb(userId);
    try {
      db.prepare(`
        INSERT INTO backup_metadata (id, backup_timestamp, backup_path, size_bytes, success, created_at)
        VALUES (?, ?, ?, ?, 1, datetime('now'))
      `).run(
        generateId("backup"),
        new Date().toISOString(),
        backupRoot,
        directorySizeBytes(backupRoot)
      );
    } finally {
      db.close();
    }

    return backupRoot;
  }

  function importPlanningBackupIntoLiveDb(userId, backupPlanningPath) {
    const liveDb = openPlanningDb(userId);
    const backupDb = new Database(backupPlanningPath, {
      readonly: true,
      fileMustExist: true
    });

    const deleteOrder = [
      "notification_queue",
      "projection_snapshots",
      "event_log",
      "future_transactions",
      "pending_transactions",
      "one_off_transactions",
      "goals",
      "flex_transactions",
      "recurring_incomes",
      "recurring_expenses",
      "planned_transactions",
      "fx_rates_cache",
      "settings"
    ];

    const insertOrder = [
      "settings",
      "fx_rates_cache",
      "planned_transactions",
      "recurring_expenses",
      "recurring_incomes",
      "flex_transactions",
      "goals",
      "one_off_transactions",
      "pending_transactions",
      "future_transactions",
      "event_log",
      "projection_snapshots",
      "notification_queue"
    ];

    try {
      initReadOnlyPragmas(backupDb);

      liveDb.transaction(() => {
        liveDb.pragma("foreign_keys = OFF");

        for (const tableName of deleteOrder) {
          if (tableExists(liveDb, tableName)) {
            liveDb.prepare(`DELETE FROM ${tableName}`).run();
          }
        }

        for (const tableName of insertOrder) {
          replaceTableRowsFromBackup(liveDb, backupDb, tableName);
        }

        liveDb.pragma("foreign_keys = ON");

        const fkErrors = liveDb.prepare("PRAGMA foreign_key_check").all();
        if (fkErrors.length) {
          throw new Error(`Restore failed foreign key check: ${JSON.stringify(fkErrors)}`);
        }

        liveDb.prepare(`
          UPDATE settings
          SET ledger_currency = 'PLN'
          WHERE id = 1
        `).run();

        liveDb.prepare(`
          INSERT INTO event_log (id, action, entity_type, entity_id, details, timestamp)
          VALUES (?, 'restore_completed', 'cashflow', ?, ?, datetime('now'))
        `).run(
          generateId("event"),
          userId,
          JSON.stringify({ backupPlanningPath })
        );
      })();
    } finally {
      backupDb.close();
      liveDb.close();
    }
  }

  function importLedgerBackupIntoLiveDb(userId, backupLedgerPath, year) {
    const liveDb = openLedgerDb(userId, year);
    const backupDb = new Database(backupLedgerPath, {
      readonly: true,
      fileMustExist: true
    });

    try {
      initReadOnlyPragmas(backupDb);

      liveDb.transaction(() => {
        replaceTableRowsFromBackup(liveDb, backupDb, "confirmed_transactions");
      })();
    } finally {
      backupDb.close();
      liveDb.close();
    }
  }

  function clearLedgerYear(userId, year) {
    const ledgerDb = openLedgerDb(userId, year);

    try {
      ledgerDb.prepare("DELETE FROM confirmed_transactions").run();
    } finally {
      ledgerDb.close();
    }
  }

  function restoreBackupFromPathNoSafety(userId, backupPath) {
    const { planningSource, backupLedgerYears } = validateBackupFolderForRestore(backupPath);
    const existingLedgerYears = listLedgerYears(userId);

    importPlanningBackupIntoLiveDb(userId, planningSource);

    for (const year of backupLedgerYears) {
      importLedgerBackupIntoLiveDb(userId, path.join(backupPath, `ledger_${year}.sqlite`), year);
    }

    for (const year of existingLedgerYears) {
      if (!backupLedgerYears.includes(year)) {
        clearLedgerYear(userId, year);
      }
    }

    recalculateLedgerRunningBalance(userId);

    return regenerateProjectionsAfterMutation(userId);
  }

  function restoreBackup(userId, backupId) {
    const db = openPlanningDb(userId);

    let backupPath;

    try {
      const row = db.prepare(`
        SELECT backup_path
        FROM backup_metadata
        WHERE id = ?
      `).get(backupId);

      if (!row?.backup_path) {
        throw new Error("Backup not found");
      }

      backupPath = row.backup_path;
    } finally {
      db.close();
    }

    validateBackupFolderForRestore(backupPath);

    const safetyBackup = createBackup(userId);

    try {
      const projection = restoreBackupFromPathNoSafety(userId, backupPath);

      return {
        ok: true,
        restoredFrom: backupPath,
        safetyBackup,
        mode: "row_import_validated",
        _projection: projection
      };
    } catch (error) {
      try {
        restoreBackupFromPathNoSafety(userId, safetyBackup);
      } catch (rollbackError) {
        throw new Error(
          `Restore failed and rollback also failed. Safety backup: ${safetyBackup}. Restore error: ${error.message}. Rollback error: ${rollbackError.message}`
        );
      }

      throw new Error(
        `Restore failed and was rolled back from safety backup ${safetyBackup}: ${error.message}`
      );
    }
  }

  return {
    cleanupOldBackups,
    createBackup,
    maybeRunAutomaticBackup,
    restoreBackup,
    validateBackupFolderForRestore,
    validateCashflowData
  };
}
