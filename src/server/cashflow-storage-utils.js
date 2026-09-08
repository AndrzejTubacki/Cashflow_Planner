import fs from "fs";
import path from "path";
import { createHttpError, normalizeUserId } from "./cashflow-user-utils.js";

export function createCashflowStoragePaths(dataDir) {
  const rootDir = path.resolve(dataDir);

  function containedPath(...parts) {
    const resolved = path.resolve(rootDir, ...parts);
    if (resolved !== rootDir && !resolved.startsWith(`${rootDir}${path.sep}`)) {
      throw createHttpError("Resolved Cashflow path escaped DATA_DIR", 400);
    }
    return resolved;
  }

  function userDataDir(userId, options = {}) {
    const { create = true } = options;
    const normalizedId = normalizeUserId(userId);
    const dir = containedPath(normalizedId);
    if (create && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  function planningDbPath(userId, options = {}) {
    return path.join(userDataDir(userId, options), "planning.sqlite");
  }

  function ledgerDbPath(userId, year, options = {}) {
    return path.join(userDataDir(userId, options), `ledger_${year}.sqlite`);
  }

  function backupDir(userId, options = {}) {
    const { create = true } = options;
    const dir = path.join(userDataDir(userId, options), "backups");
    if (create && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  function planningDbExists(userId) {
    return fs.existsSync(planningDbPath(userId, { create: false }));
  }

  function cashflowUserStorageExists(userId) {
    const dir = userDataDir(userId, { create: false });
    if (!fs.existsSync(dir)) return false;
    if (fs.existsSync(path.join(dir, "planning.sqlite"))) return true;

    return fs.readdirSync(dir, { withFileTypes: true })
      .some(entry => entry.isFile() && /^ledger_\d{4}\.sqlite$/.test(entry.name));
  }

  function deleteCashflowUserStorage(userId) {
    const dir = userDataDir(userId, { create: false });
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  function userDataDirExists(userId) {
    return fs.existsSync(userDataDir(userId, { create: false }));
  }

  function listCashflowUserIds() {
    if (!fs.existsSync(rootDir)) return [];

    return fs.readdirSync(rootDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(userId => {
        try {
          return cashflowUserStorageExists(userId);
        } catch {
          return false;
        }
      });
  }

  function directorySizeBytes(dir) {
    let total = 0;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        total += directorySizeBytes(fullPath);
      } else {
        total += fs.statSync(fullPath).size;
      }
    }

    return total;
  }

  function backupRootDir(userId, settings = null) {
    const normalizedId = normalizeUserId(userId);
    const configured = settings?.backup_location && String(settings.backup_location).trim();

    if (configured) {
      const dir = path.join(configured, normalizedId, "cashflow");
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }

    return backupDir(normalizedId);
  }

  return {
    backupDir,
    backupRootDir,
    cashflowUserStorageExists,
    deleteCashflowUserStorage,
    directorySizeBytes,
    ledgerDbPath,
    listCashflowUserIds,
    planningDbPath,
    planningDbExists,
    userDataDirExists,
    userDataDir
  };
}
