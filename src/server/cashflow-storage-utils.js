import fs from "fs";
import path from "path";

export function createCashflowStoragePaths(dataDir) {
  function userDataDir(userId) {
    const dir = path.join(dataDir, userId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  function planningDbPath(userId) {
    return path.join(userDataDir(userId), "planning.sqlite");
  }

  function ledgerDbPath(userId, year) {
    return path.join(userDataDir(userId), `ledger_${year}.sqlite`);
  }

  function backupDir(userId) {
    const dir = path.join(userDataDir(userId), "backups");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  function listCashflowUserIds() {
    if (!fs.existsSync(dataDir)) return [];

    return fs.readdirSync(dataDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .filter(userId => fs.existsSync(planningDbPath(userId)));
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
    const configured = settings?.backup_location && String(settings.backup_location).trim();

    if (configured) {
      const dir = path.join(configured, userId, "cashflow");
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }

    return backupDir(userId);
  }

  return {
    backupDir,
    backupRootDir,
    directorySizeBytes,
    ledgerDbPath,
    listCashflowUserIds,
    planningDbPath,
    userDataDir
  };
}
