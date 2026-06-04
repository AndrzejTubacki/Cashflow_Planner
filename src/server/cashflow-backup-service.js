import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  replaceTableRowsFromBackup,
  tableExists
} from "./cashflow-db-utils.js";
import { cleanupMigrationRecoveryFolders } from "./cashflow-migration-recovery.js";
import { badRequest, notFound } from "./cashflow-user-utils.js";

const PROJECTION_SNAPSHOT_RETENTION = 100;
const EVENT_LOG_RETENTION = 2_000;
const SENT_NOTIFICATION_RETENTION = 1_000;
const FAILED_BACKUP_METADATA_RETENTION = 100;
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;

export function createCashflowBackupService({
  backupDir,
  backupHook = null,
  backupRootDir,
  directorySizeBytes,
  generateId,
  getSettings,
  initReadOnlyPragmas,
  listLedgerYears,
  logError = () => {},
  logServerEvent = () => {},
  now = () => new Date(),
  openLedgerDb,
  openPlanningDb,
  recalculateLedgerRunningBalance,
  regenerateProjectionsAfterMutation
}) {
  function runBackupHook(phase, details = {}) {
    if (typeof backupHook === "function") backupHook({ phase, ...details });
  }

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

  function cleanupBackupFolders(userId) {
    const settings = getSettings(userId);
    const retention = Math.max(1, Number(settings?.backup_retention_count || 10));
    const dir = backupRootDir(userId, settings);

    if (!fs.existsSync(dir)) return { deleted: 0, retainedPaths: [] };

    const backups = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith("backup_") && !entry.name.endsWith(".tmp"))
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

    return {
      deleted: toDelete.length,
      retainedPaths: backups.slice(0, retention).map(backup => backup.path)
    };
  }

  function cleanupStaleTemporaryFolders(dir, currentTime) {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
    let deleted = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("backup_") || !entry.name.endsWith(".tmp")) continue;
      const fullPath = path.join(dir, entry.name);
      if (currentTime - fs.statSync(fullPath).mtimeMs <= STALE_TEMP_AGE_MS) continue;
      fs.rmSync(fullPath, { recursive: true, force: true });
      deleted += 1;
    }
    return deleted;
  }

  function cleanupOperationalData(userId) {
    const settings = getSettings(userId);
    const root = backupRootDir(userId, settings);
    const builtInRoot = typeof backupDir === "function" ? backupDir(userId) : root;
    const currentTime = now().getTime();
    const folderCleanup = cleanupBackupFolders(userId);
    const staleTemporaryDeleted = [...new Set([root, builtInRoot])]
      .reduce((total, dir) => total + cleanupStaleTemporaryFolders(dir, currentTime), 0);
    const migrationCleanup = cleanupMigrationRecoveryFolders(builtInRoot, currentTime);
    const db = openPlanningDb(userId);

    try {
      const result = db.transaction(() => {
        const snapshotsDeleted = db.prepare(`
          DELETE FROM projection_snapshots
          WHERE id NOT IN (
            SELECT id FROM projection_snapshots
            ORDER BY snapshot_timestamp DESC, id DESC
            LIMIT ?
          )
        `).run(PROJECTION_SNAPSHOT_RETENTION).changes;
        const eventsDeleted = db.prepare(`
          DELETE FROM event_log
          WHERE id NOT IN (
            SELECT id FROM event_log
            ORDER BY timestamp DESC, id DESC
            LIMIT ?
          )
        `).run(EVENT_LOG_RETENTION).changes;
        const notificationsDeleted = db.prepare(`
          DELETE FROM notification_queue
          WHERE sent_at IS NOT NULL
            AND id NOT IN (
              SELECT id FROM notification_queue
              WHERE sent_at IS NOT NULL
              ORDER BY sent_at DESC, queued_at DESC, id DESC
              LIMIT ?
            )
        `).run(SENT_NOTIFICATION_RETENTION).changes;

        const successful = db.prepare(`
          SELECT id, backup_path
          FROM backup_metadata
          WHERE success = 1
        `).all();
        let metadataDeleted = 0;
        for (const row of successful) {
          if (!fs.existsSync(row.backup_path) || !fs.statSync(row.backup_path).isDirectory()) {
            metadataDeleted += db.prepare("DELETE FROM backup_metadata WHERE id = ?").run(row.id).changes;
          }
        }
        metadataDeleted += db.prepare(`
          DELETE FROM backup_metadata
          WHERE success = 0
            AND id NOT IN (
              SELECT id FROM backup_metadata
              WHERE success = 0
              ORDER BY backup_timestamp DESC, created_at DESC, id DESC
              LIMIT ?
            )
        `).run(FAILED_BACKUP_METADATA_RETENTION).changes;

        return {
          snapshotsDeleted,
          eventsDeleted,
          notificationsDeleted,
          metadataDeleted
        };
      })();

      return {
        ...result,
        backupsDeleted: folderCleanup.deleted,
        migrationBackupsDeleted: migrationCleanup.completedDeleted,
        staleTemporaryDeleted: staleTemporaryDeleted + migrationCleanup.staleTemporaryDeleted
      };
    } finally {
      db.close();
    }
  }

  function cleanupOperationalDataBestEffort(userId, reason) {
    try {
      runBackupHook("before_retention_cleanup", { userId, reason });
      const result = cleanupOperationalData(userId);
      logServerEvent("cashflow_operational_retention_completed", { userId, reason, ...result });
      return result;
    } catch (error) {
      logError("cashflow_operational_retention_failed", {
        userId,
        reason,
        error: error.message
      });
      return null;
    }
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

    const backupPath = createBackup(userId, { deferCleanup: true });
    const deleted = cleanupOperationalDataBestEffort(userId, "automatic_backup")?.backupsDeleted || 0;

    return { backupPath, deleted };
  }

  function createBackup(userId, options = {}) {
    const { deferCleanup = false } = options;
    const settings = getSettings(userId);
    const dir = backupRootDir(userId, settings);
    const createdAt = now().toISOString();
    const timestamp = createdAt.replace(/[:.]/g, "-");
    const backupId = generateId("backup");
    const backupRoot = path.join(dir, `backup_${timestamp}_${backupId}`);
    const temporaryRoot = `${backupRoot}.tmp`;

    function recordMetadata(success, errorMessage = null, sizeBytes = null) {
      const db = openPlanningDb(userId);
      try {
        db.prepare(`
          INSERT INTO backup_metadata (
            id, backup_timestamp, backup_path, size_bytes, success, error_message, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(backupId, createdAt, backupRoot, sizeBytes, success ? 1 : 0, errorMessage);
      } finally {
        db.close();
      }
    }

    try {
      fs.mkdirSync(temporaryRoot, { recursive: false });

      const planningBackupPath = path.join(temporaryRoot, "planning.sqlite");
      runBackupHook("before_planning_copy", { userId, backupRoot, temporaryRoot });
      const planningDb = openPlanningDb(userId);

      try {
        planningDb.prepare("VACUUM INTO ?").run(planningBackupPath);
      } finally {
        planningDb.close();
      }

      for (const year of listLedgerYears(userId)) {
        const ledgerBackupPath = path.join(temporaryRoot, `ledger_${year}.sqlite`);
        runBackupHook("before_ledger_copy", { userId, year, backupRoot, temporaryRoot });
        const ledgerDb = openLedgerDb(userId, year);

        try {
          ledgerDb.prepare("VACUUM INTO ?").run(ledgerBackupPath);
        } finally {
          ledgerDb.close();
        }
      }

      runBackupHook("before_backup_validation", { userId, backupRoot, temporaryRoot });
      validateBackupFolderForRestore(temporaryRoot);
      fs.renameSync(temporaryRoot, backupRoot);
      runBackupHook("before_success_metadata", { userId, backupRoot });
      recordMetadata(true, null, directorySizeBytes(backupRoot));
      if (!deferCleanup) cleanupOperationalDataBestEffort(userId, "backup_created");
      return backupRoot;
    } catch (error) {
      for (const partialPath of [temporaryRoot, backupRoot]) {
        try {
          fs.rmSync(partialPath, { recursive: true, force: true });
        } catch (cleanupError) {
          logError("cashflow_backup_partial_cleanup_failed", {
            userId,
            backupPath: backupRoot,
            partialPath,
            error: cleanupError.message
          });
        }
      }

      try {
        recordMetadata(false, error.message, null);
      } catch (metadataError) {
        logError("cashflow_backup_failure_metadata_failed", {
          userId,
          backupPath: backupRoot,
          error: error.message,
          metadataError: metadataError.message
        });
      }
      logError("cashflow_backup_creation_failed", {
        userId,
        backupPath: backupRoot,
        error: error.message
      });
      throw error;
    }
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
      "ledger_currency_events",
      "fx_rates_cache",
      "settings"
    ];

    const insertOrder = [
      "settings",
      "fx_rates_cache",
      "ledger_currency_events",
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

  function restoreBackupFromPath(userId, backupPath) {
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

    const projection = regenerateProjectionsAfterMutation(userId);
    if (projection?.projection_ok === false) {
      throw new Error(`Projection regeneration failed after restore: ${projection.projection_error || "unknown error"}`);
    }
    return projection;
  }

  function restoreBackup(userId, backupId) {
    const db = openPlanningDb(userId);

    let backupPath;

    try {
      const row = db.prepare(`
        SELECT backup_path, success
        FROM backup_metadata
        WHERE id = ?
      `).get(backupId);

      if (!row?.backup_path || Number(row.success) !== 1) {
        throw notFound("Backup not found", [{ field: "backupId", reason: "not_found" }]);
      }

      backupPath = row.backup_path;
    } finally {
      db.close();
    }

    if (!fs.existsSync(backupPath)) {
      throw notFound("Backup not found", [{ field: "backupId", reason: "backup_folder_missing" }]);
    }
    try {
      validateBackupFolderForRestore(backupPath);
    } catch (error) {
      throw badRequest("Backup is invalid and cannot be restored", {
        phase: "backup_validation_failed",
        backupPath,
        error: error.message
      });
    }

    const safetyBackup = createBackup(userId, { deferCleanup: true });

    try {
      runBackupHook("before_restore_apply", { userId, backupPath, safetyBackup });
      const projection = restoreBackupFromPath(userId, backupPath);
      cleanupOperationalDataBestEffort(userId, "restore_completed");

      return {
        ok: true,
        restoredFrom: backupPath,
        safetyBackup,
        mode: "row_import_validated",
        _projection: projection
      };
    } catch (error) {
      logError("cashflow_restore_failed_before_rollback", {
        userId,
        restoredFrom: backupPath,
        safetyBackup,
        error: error.message
      });
      try {
        runBackupHook("before_restore_rollback", { userId, backupPath, safetyBackup, error });
        restoreBackupFromPath(userId, safetyBackup);
        logServerEvent("cashflow_restore_rolled_back", {
          userId,
          restoredFrom: backupPath,
          safetyBackup,
          error: error.message
        });
        cleanupOperationalDataBestEffort(userId, "restore_rolled_back");
      } catch (rollbackError) {
        logError("cashflow_restore_rollback_failed", {
          userId,
          restoredFrom: backupPath,
          safetyBackup,
          error: error.message,
          rollbackError: rollbackError.message
        });
        const combined = new Error("Restore failed and rollback also failed");
        combined.status = 500;
        combined.details = {
          phase: "rollback_failed",
          safetyBackup,
          originalError: error.message,
          originalStatus: Number(error?.status) || 500,
          rollbackError: rollbackError.message
        };
        throw combined;
      }

      const rolledBack = new Error(`Restore failed and was rolled back: ${error.message}`);
      rolledBack.status = Number(error?.status) || 500;
      if (error?.details) rolledBack.details = error.details;
      throw rolledBack;
    }
  }

  return {
    cleanupOperationalData,
    cleanupOperationalDataBestEffort,
    createBackup,
    maybeRunAutomaticBackup,
    restoreBackup,
    restoreBackupFromPath,
    validateBackupFolderForRestore,
    validateCashflowData
  };
}
