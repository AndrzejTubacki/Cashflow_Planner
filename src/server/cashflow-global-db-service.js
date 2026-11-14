import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

import { createCashflowGlobalMigrationService } from "./cashflow-global-migration-recovery.js";
import { STANDALONE_TRANSFER_FILE_MARKER } from './cashflow-standalone-transfer-schema.js';

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

  let migrationRan = false;

  function openGlobalDb() {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(globalDbPath);
    initGlobalPragmas(db);
    try {
      if (!migrationRan) {
        globalMigration.initializeOrMigrate(db, {
          beforeStep: beforeGlobalMigrationStep,
          // Sealed transfers have explicit account/device ownership in global
          // metadata. Missing metadata must not turn an unpublished orphan (or
          // a previously published transfer) into a newly enrolled legacy user.
          storageProfileIds: listCashflowUserIds().filter(id =>
            !fs.existsSync(path.join(dataDir, id, STANDALONE_TRANSFER_FILE_MARKER)))
        });
        db.prepare(`
          UPDATE global_options
          SET holiday_country = CASE
                WHEN UPPER(COALESCE(holiday_country, 'PL')) IN ('PL', 'DE') THEN UPPER(COALESCE(holiday_country, 'PL'))
                ELSE 'PL'
              END
          WHERE id = 1
        `).run();
        migrationRan = true;
      }
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
