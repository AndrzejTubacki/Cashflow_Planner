import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import {
  applyGlobalMigrations,
  GLOBAL_SCHEMA_VERSION,
  initializeGlobalSchema
} from "./cashflow-global-schema.js";

const RECOVERY_FORMAT = "cashflow-global-migration-recovery";
const RECOVERY_VERSION = 1;
export const DEFAULT_GLOBAL_MIGRATION_RECOVERY_RETENTION_COUNT = 2;

function normalizeRetentionCount(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return number;
}

function globalMigrationRecoveryRetentionCount(env = process.env) {
  return normalizeRetentionCount(
    env.CASHFLOW_GLOBAL_MIGRATION_RECOVERY_RETENTION_COUNT,
    DEFAULT_GLOBAL_MIGRATION_RECOVERY_RETENTION_COUNT
  );
}

function readManifest(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function recoveryFolders(root) {
  if (!fs.existsSync(root)) return [];

  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith("global_migration_backup_"))
    .map(entry => path.join(root, entry.name))
    .sort()
    .reverse();
}

function verifySnapshot(dbPath, expectedVersion) {
  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true
  });

  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    const version = db.pragma("user_version", { simple: true });
    if (integrity !== "ok" || version !== expectedVersion) {
      throw new Error(`Global recovery verification failed: integrity=${integrity}, version=${version}`);
    }
  } finally {
    db.close();
  }
}

function reusablePendingRecovery(root, sourceVersion) {
  for (const folder of recoveryFolders(root)) {
    const manifest = readManifest(folder);
    if (
      manifest?.format === RECOVERY_FORMAT
      && manifest?.status === "pending"
      && manifest?.sourceVersion === sourceVersion
      && manifest?.targetVersion === GLOBAL_SCHEMA_VERSION
      && fs.existsSync(path.join(folder, "cashflow-global.sqlite"))
    ) {
      return folder;
    }
  }

  return null;
}

export function cleanupGlobalMigrationRecoveryFolders(root, {
  retentionCount = globalMigrationRecoveryRetentionCount()
} = {}) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { completedDeleted: 0, retainedCompleted: 0 };
  }

  const completed = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory()
      || !entry.name.startsWith("global_migration_backup_")
      || entry.name.endsWith(".tmp")
    ) {
      continue;
    }

    const fullPath = path.join(root, entry.name);
    const stat = fs.statSync(fullPath);
    const manifest = readManifest(fullPath);
    if (manifest?.status !== "completed") continue;
    completed.push({
      path: fullPath,
      completedAt: Date.parse(manifest.completedAt || manifest.createdAt || "") || stat.mtimeMs
    });
  }

  completed.sort((a, b) => b.completedAt - a.completedAt);
  const remove = completed.slice(retentionCount);
  for (const recovery of remove) {
    fs.rmSync(recovery.path, { recursive: true, force: true });
  }

  return {
    completedDeleted: remove.length,
    retainedCompleted: completed.length - remove.length
  };
}

export function createCashflowGlobalMigrationService({
  dataDir,
  logError = () => {},
  logServerEvent = () => {}
}) {
  const recoveryRoot = path.join(dataDir, "global-migration-backups");

  function createRecoverySnapshot(db, sourceVersion) {
    const reusable = reusablePendingRecovery(recoveryRoot, sourceVersion);
    if (reusable) return reusable;

    const timestamp = new Date().toISOString();
    const folderName = `global_migration_backup_${timestamp.replace(/[:.]/g, "-")}`;
    const finalPath = path.join(recoveryRoot, folderName);
    const tempPath = `${finalPath}.tmp`;
    const snapshotPath = path.join(tempPath, "cashflow-global.sqlite");

    try {
      fs.mkdirSync(recoveryRoot, { recursive: true });
      fs.mkdirSync(tempPath, { recursive: false });
      db.prepare("VACUUM INTO ?").run(snapshotPath);
      verifySnapshot(snapshotPath, sourceVersion);
      fs.writeFileSync(path.join(tempPath, "manifest.json"), `${JSON.stringify({
        format: RECOVERY_FORMAT,
        version: RECOVERY_VERSION,
        status: "pending",
        createdAt: timestamp,
        completedAt: null,
        sourceVersion,
        targetVersion: GLOBAL_SCHEMA_VERSION,
        database: "cashflow-global.sqlite"
      }, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, finalPath);
      logServerEvent("cashflow_global_migration_recovery_created", {
        recoveryPath: finalPath,
        sourceVersion,
        targetVersion: GLOBAL_SCHEMA_VERSION
      });
      return finalPath;
    } catch (error) {
      fs.rmSync(tempPath, { recursive: true, force: true });
      logError("cashflow_global_migration_recovery_failed", {
        error: error.message,
        sourceVersion,
        targetVersion: GLOBAL_SCHEMA_VERSION
      });
      throw new Error(`Failed to create global pre-migration recovery snapshot: ${error.message}`, {
        cause: error
      });
    }
  }

  function markRecoveryComplete(recoveryPath) {
    if (!recoveryPath) return;
    const manifest = readManifest(recoveryPath);
    if (!manifest) return;
    manifest.status = "completed";
    manifest.completedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(recoveryPath, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
  }

  function initializeOrMigrate(db, {
    beforeStep = () => {},
    storageProfileIds = []
  } = {}) {
    const sourceVersion = db.pragma("user_version", { simple: true });
    if (sourceVersion === 0) {
      initializeGlobalSchema(db, { storageProfileIds });
      return null;
    }
    if (sourceVersion >= GLOBAL_SCHEMA_VERSION) return null;

    const recoveryPath = createRecoverySnapshot(db, sourceVersion);
    try {
      applyGlobalMigrations(db, {
        beforeStep,
        storageProfileIds
      });
      markRecoveryComplete(recoveryPath);
      try {
        const cleanup = cleanupGlobalMigrationRecoveryFolders(recoveryRoot);
        if (cleanup.completedDeleted > 0) {
          logServerEvent("cashflow_global_migration_recovery_retention_completed", cleanup);
        }
      } catch (cleanupError) {
        logError("cashflow_global_migration_recovery_retention_failed", {
          error: cleanupError.message
        });
      }
      logServerEvent("cashflow_global_migration_completed", {
        recoveryPath,
        sourceVersion,
        targetVersion: GLOBAL_SCHEMA_VERSION
      });
      return recoveryPath;
    } catch (error) {
      logError("cashflow_global_migration_failed", {
        error: error.message,
        recoveryPath,
        sourceVersion,
        targetVersion: GLOBAL_SCHEMA_VERSION
      });
      throw error;
    }
  }

  return {
    initializeOrMigrate
  };
}
