import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

import { createCashflowGlobalMigrationService } from "./cashflow-global-migration-recovery.js";

function initGlobalPragmas(db) {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
}

export function createCashflowGlobalDbService({
  beforeGlobalMigrationStep = () => {},
  dataDir,
  listCashflowUserIds,
  logError = () => {},
  logServerEvent = () => {}
}) {
  const globalDbPath = path.join(dataDir, "cashflow-global.sqlite");
  const globalMigration = createCashflowGlobalMigrationService({
    dataDir,
    logError,
    logServerEvent
  });

  function openGlobalDb() {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(globalDbPath);
    initGlobalPragmas(db);
    try {
      globalMigration.initializeOrMigrate(db, {
        beforeStep: beforeGlobalMigrationStep,
        storageProfileIds: listCashflowUserIds()
      });
      db.prepare(`
        UPDATE global_options
        SET holiday_country = CASE
              WHEN UPPER(COALESCE(holiday_country, 'PL')) IN ('PL', 'DE') THEN UPPER(COALESCE(holiday_country, 'PL'))
              ELSE 'PL'
            END
        WHERE id = 1
      `).run();
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  return {
    backend: "sqlite",
    globalDbPath,
    openGlobalDb
  };
}
