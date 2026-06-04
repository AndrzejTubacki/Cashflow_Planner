import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCashflowBackupService } from "../../src/server/cashflow-backup-service.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { generateId } from "../../src/server/cashflow-id-utils.js";
import { occurrenceKeyFromRow } from "../../src/server/cashflow-occurrence-utils.js";
import {
  initializeLedgerSchema,
  initializePlanningSchema,
  LEDGER_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION
} from "../../src/server/cashflow-schema.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";

async function withRecoveryHarness(fn) {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-migration-recovery-"));
  const dataDir = path.join(runtimeRoot, "data");
  const userId = "migration_user";
  const userDir = path.join(dataDir, userId);
  fs.mkdirSync(userDir, { recursive: true });

  const planningPath = path.join(userDir, "planning.sqlite");
  const planningDb = new Database(planningPath);
  initializePlanningSchema(planningDb);
  planningDb.prepare(`
    INSERT INTO one_off_transactions (
      id, name, currency, amount, type, date, created_at, updated_at
    ) VALUES (
      'recovery-one-off', 'Recovery one-off', 'PLN', 25, 'expense', '2026-01-15',
      datetime('now'), datetime('now')
    )
  `).run();
  planningDb.pragma("user_version = 8");
  planningDb.close();

  const ledgerPath = path.join(userDir, "ledger_2026.sqlite");
  const ledgerDb = new Database(ledgerPath);
  initializeLedgerSchema(ledgerDb);
  ledgerDb.prepare(`
    INSERT INTO confirmed_transactions (
      id, name, currency, amount, type, date, confirmed_date,
      fx_rate, buffered_fx_rate, ledger_currency, running_balance_pln,
      ledger_amount, created_at, updated_at
    ) VALUES (
      'recovery-confirmed', 'Recovery confirmed', 'PLN', 100, 'income',
      '2026-01-01', '2026-01-01', 1, 1, 'PLN', 100, 100,
      datetime('now'), datetime('now')
    )
  `).run();
  ledgerDb.pragma("user_version = 2");
  ledgerDb.close();

  const paths = createCashflowStoragePaths(dataDir);
  const events = [];
  const errors = [];
  const dbService = createCashflowDbService({
    ledgerDbPath: paths.ledgerDbPath,
    logError: (kind, details) => errors.push({ kind, details }),
    logServerEvent: (kind, details) => events.push({ kind, details }),
    planningDbPath: paths.planningDbPath,
    userDataDir: paths.userDataDir
  });

  try {
    await fn({
      dataDir,
      dbService,
      errors,
      events,
      paths,
      planningPath,
      ledgerPath,
      userDir,
      userId
    });
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

function recoveryFolders(userDir) {
  const backupDir = path.join(userDir, "backups");
  if (!fs.existsSync(backupDir)) return [];

  return fs.readdirSync(backupDir)
    .filter(name => name.startsWith("migration_backup_"))
    .map(name => path.join(backupDir, name))
    .sort();
}

test("migration creates one full recovery snapshot and existing restore flow consumes it", async () => withRecoveryHarness(async harness => {
  harness.dbService.openPlanningDb(harness.userId).close();
  harness.dbService.openPlanningDb(harness.userId).close();

  let folders = recoveryFolders(harness.userDir);
  assert.equal(folders.length, 1);
  assert.equal(fs.existsSync(path.join(folders[0], "planning.sqlite")), true);
  assert.equal(fs.existsSync(path.join(folders[0], "ledger_2026.sqlite")), true);

  let manifest = JSON.parse(fs.readFileSync(path.join(folders[0], "manifest.json"), "utf8"));
  assert.equal(manifest.status, "pending");
  assert.equal(manifest.trigger.kind, "planning");
  assert.deepEqual(
    manifest.databases.map(item => [item.file, item.sourceVersion, item.targetVersion]),
    [
      ["ledger_2026.sqlite", 2, LEDGER_SCHEMA_VERSION],
      ["planning.sqlite", 8, PLANNING_SCHEMA_VERSION]
    ]
  );

  harness.dbService.openLedgerDb(harness.userId, "2026").close();
  folders = recoveryFolders(harness.userDir);
  assert.equal(folders.length, 1);

  manifest = JSON.parse(fs.readFileSync(path.join(folders[0], "manifest.json"), "utf8"));
  assert.equal(manifest.status, "completed");

  const currentPlanning = harness.dbService.openPlanningDb(harness.userId);
  currentPlanning.prepare("DELETE FROM one_off_transactions WHERE id = 'recovery-one-off'").run();
  currentPlanning.close();
  const currentLedger = harness.dbService.openLedgerDb(harness.userId, "2026");
  currentLedger.prepare("DELETE FROM confirmed_transactions WHERE id = 'recovery-confirmed'").run();
  currentLedger.close();

  const backupService = createCashflowBackupService({
    backupRootDir: harness.paths.backupRootDir,
    directorySizeBytes: harness.paths.directorySizeBytes,
    generateId,
    getSettings: () => ({ backup_retention_count: 10 }),
    initReadOnlyPragmas: harness.dbService.initReadOnlyPragmas,
    listLedgerYears: harness.dbService.listLedgerYears,
    openLedgerDb: harness.dbService.openLedgerDb,
    openPlanningDb: harness.dbService.openPlanningDb,
    recalculateLedgerRunningBalance: () => {},
    regenerateProjectionsAfterMutation: () => ({ projection_ok: true })
  });

  backupService.restoreBackupFromPath(harness.userId, folders[0]);

  const restoredPlanning = harness.dbService.openPlanningDb(harness.userId);
  assert.equal(
    restoredPlanning.prepare("SELECT name FROM one_off_transactions WHERE id = 'recovery-one-off'").get()?.name,
    "Recovery one-off"
  );
  restoredPlanning.close();

  const restoredLedger = harness.dbService.openLedgerDb(harness.userId, "2026");
  assert.equal(
    restoredLedger.prepare("SELECT name FROM confirmed_transactions WHERE id = 'recovery-confirmed'").get()?.name,
    "Recovery confirmed"
  );
  restoredLedger.close();

  assert.ok(harness.events.some(event => event.kind === "cashflow_migration_recovery_created"));
  assert.ok(harness.events.some(event => event.kind === "cashflow_migration_recovery_completed"));
  assert.deepEqual(harness.errors, []);
}));

test("migration aborts before writes when the recovery snapshot cannot be created", async () => withRecoveryHarness(async harness => {
  fs.writeFileSync(path.join(harness.userDir, "backups"), "not a directory");

  assert.throws(
    () => harness.dbService.openPlanningDb(harness.userId),
    /Failed to create pre-migration recovery snapshot/
  );

  const db = new Database(harness.planningPath);
  try {
    assert.equal(db.pragma("user_version", { simple: true }), 8);
    assert.equal(db.prepare("PRAGMA table_info(settings)").all().some(column => column.name === "locale"), true);
  } finally {
    db.close();
  }

  assert.ok(harness.errors.some(error => error.kind === "cashflow_migration_recovery_failed"));
}));
