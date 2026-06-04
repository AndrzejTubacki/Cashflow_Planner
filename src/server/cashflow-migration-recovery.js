import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import {
  LEDGER_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION
} from "./cashflow-schema.js";

const RECOVERY_FORMAT = "cashflow-migration-recovery";
const RECOVERY_FORMAT_VERSION = 1;

function targetVersion(kind) {
  return kind === "planning" ? PLANNING_SCHEMA_VERSION : LEDGER_SCHEMA_VERSION;
}

function databaseKind(fileName) {
  return fileName === "planning.sqlite" ? "planning" : "ledger";
}

function databaseFiles(userDir) {
  if (!fs.existsSync(userDir)) return [];

  return fs.readdirSync(userDir)
    .filter(fileName => fileName === "planning.sqlite" || /^ledger_\d{4}\.sqlite$/.test(fileName))
    .sort();
}

function databaseVersion(dbPath) {
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

function currentDatabases(userDir) {
  return databaseFiles(userDir).map(fileName => {
    const kind = databaseKind(fileName);
    return {
      file: fileName,
      kind,
      sourceVersion: databaseVersion(path.join(userDir, fileName)),
      targetVersion: targetVersion(kind)
    };
  });
}

function readManifest(recoveryPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(recoveryPath, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function pendingRecoveryDirs(backupDir) {
  if (!fs.existsSync(backupDir) || !fs.statSync(backupDir).isDirectory()) return [];

  return fs.readdirSync(backupDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith("migration_backup_"))
    .map(entry => path.join(backupDir, entry.name))
    .sort()
    .reverse();
}

function canReusePendingRecovery(manifest, databases) {
  if (manifest?.format !== RECOVERY_FORMAT || manifest?.status !== "pending") return false;
  if (manifest?.targetVersions?.planning !== PLANNING_SCHEMA_VERSION) return false;
  if (manifest?.targetVersions?.ledger !== LEDGER_SCHEMA_VERSION) return false;

  const original = new Map((manifest.databases || []).map(item => [item.file, item]));
  if (original.size !== databases.length) return false;

  return databases.every(item => {
    const saved = original.get(item.file);
    return saved
      && saved.kind === item.kind
      && [saved.sourceVersion, saved.targetVersion].includes(item.sourceVersion);
  });
}

function findReusablePendingRecovery(backupDir, databases) {
  for (const recoveryPath of pendingRecoveryDirs(backupDir)) {
    if (canReusePendingRecovery(readManifest(recoveryPath), databases)) {
      return recoveryPath;
    }
  }

  return null;
}

function vacuumCopy(sourcePath, destinationPath) {
  const db = new Database(sourcePath, {
    readonly: false,
    fileMustExist: true
  });

  try {
    db.prepare("VACUUM INTO ?").run(destinationPath);
  } finally {
    db.close();
  }
}

export function createCashflowMigrationRecoveryService({
  userDataDir,
  logError = () => {},
  logServerEvent = () => {}
}) {
  function recoveryBackupDir(userId) {
    return path.join(userDataDir(userId, { create: false }), "backups");
  }

  function ensureMigrationRecovery(userId, trigger = {}) {
    const userDir = userDataDir(userId, { create: false });
    const databases = currentDatabases(userDir);
    const outdated = databases.filter(item => item.sourceVersion < item.targetVersion);
    if (!outdated.length) return null;

    const backupDir = recoveryBackupDir(userId);
    const reusable = findReusablePendingRecovery(backupDir, databases);
    if (reusable) return reusable;

    const timestamp = new Date().toISOString();
    const folderId = timestamp.replace(/[:.]/g, "-");
    const recoveryPath = path.join(backupDir, `migration_backup_${folderId}`);
    const tempPath = `${recoveryPath}.tmp`;

    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.mkdirSync(tempPath, { recursive: false });

      for (const database of databases) {
        vacuumCopy(
          path.join(userDir, database.file),
          path.join(tempPath, database.file)
        );
      }

      const manifest = {
        format: RECOVERY_FORMAT,
        version: RECOVERY_FORMAT_VERSION,
        status: "pending",
        createdAt: timestamp,
        completedAt: null,
        userId,
        trigger: {
          kind: trigger.kind || null,
          file: trigger.file || null,
          sourceVersion: trigger.sourceVersion ?? null,
          targetVersion: trigger.targetVersion ?? null
        },
        targetVersions: {
          planning: PLANNING_SCHEMA_VERSION,
          ledger: LEDGER_SCHEMA_VERSION
        },
        databases
      };

      fs.writeFileSync(
        path.join(tempPath, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8"
      );
      fs.renameSync(tempPath, recoveryPath);

      logServerEvent("cashflow_migration_recovery_created", {
        userId,
        recoveryPath,
        databases: databases.map(item => ({
          file: item.file,
          sourceVersion: item.sourceVersion,
          targetVersion: item.targetVersion
        }))
      });

      return recoveryPath;
    } catch (error) {
      try {
        fs.rmSync(tempPath, { recursive: true, force: true });
      } catch {
        // Preserve the snapshot creation error when cleanup is impossible.
      }
      logError("cashflow_migration_recovery_failed", {
        userId,
        error: error.message
      });
      throw new Error(`Failed to create pre-migration recovery snapshot: ${error.message}`, {
        cause: error
      });
    }
  }

  function markMigrationRecoveryComplete(userId) {
    try {
      const userDir = userDataDir(userId, { create: false });
      const databases = currentDatabases(userDir);
      if (databases.some(item => item.sourceVersion < item.targetVersion)) return null;

      const backupDir = recoveryBackupDir(userId);
      for (const recoveryPath of pendingRecoveryDirs(backupDir)) {
        const manifest = readManifest(recoveryPath);
        if (!canReusePendingRecovery(manifest, databases)) continue;

        manifest.status = "completed";
        manifest.completedAt = new Date().toISOString();
        fs.writeFileSync(
          path.join(recoveryPath, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          "utf8"
        );
        logServerEvent("cashflow_migration_recovery_completed", {
          userId,
          recoveryPath
        });
        return recoveryPath;
      }
    } catch (error) {
      logError("cashflow_migration_recovery_complete_failed", {
        userId,
        error: error.message
      });
    }

    return null;
  }

  return {
    ensureMigrationRecovery,
    markMigrationRecoveryComplete
  };
}
