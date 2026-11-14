import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { createCashflowBackupService } from "../../src/server/cashflow-backup-service.js";
import { generateId } from "../../src/server/cashflow-id-utils.js";
import { backupPruningPlan } from "../../src/server/cashflow-backup-retention.js";
import { createInProcessLockService } from "../../src/server/cashflow-sqlite-global-store.js";
import { budgetRuntimeLockName, BUDGET_RUNTIME_LOCK_JOBS } from "../../src/server/cashflow-runtime-locks.js";
import { applyGlobalMigrations, initializeGlobalSchema, GLOBAL_SCHEMA_VERSION } from "../../src/server/cashflow-global-schema.js";
import { createGlobalStoreExport } from "../../src/server/cashflow-global-store-export.js";
import { createGlobalStoreImportPlan } from "../../src/server/cashflow-global-store-import-plan.js";

async function fixture(work) {
  const harness = await createCashflowTestHarness({ inProcess: true, userId: "retention-test" });
  let time = Date.parse("2026-06-01T00:00:00Z");
  const options = { backup_max_retention_count: 0, backup_max_age_days: 0 };
  const events = [];
  const lockService = createInProcessLockService();
  const root = path.join(harness.dataDir, harness.userId, "backups");
  fs.mkdirSync(root, { recursive: true });
  const service = createCashflowBackupService({
    backupDir: () => root, backupRootDir: () => root,
    getGlobalOptions: () => options, getGlobalOptionsAsync: async () => options,
    getSettings: harness.cashflow.getSettings,
    now: () => new Date(time++), generateId, lockService,
    openPlanningDb: () => harness.openPlanningDb(),
    initReadOnlyPragmas: () => {},
    listLedgerYears: () => [],
    // Restore tests here cover pruning only; balances and projections are stubbed.
    recalculateLedgerRunningBalance: () => {},
    regenerateProjectionsAfterMutation: () => null,
    directorySizeBytes: dir => fs.readdirSync(dir).reduce((sum, file) => sum + fs.statSync(path.join(dir, file)).size, 0),
    logServerEvent: (kind, details) => events.push({ kind, details })
  });
  const rows = () => {
    const db = harness.openPlanningDb();
    try { return db.prepare("SELECT * FROM backup_metadata WHERE success = 1 ORDER BY backup_timestamp").all(); }
    finally { db.close(); }
  };
  try { await work({ harness, service, options, rows, root, events, lockService, age: days => { time += days * 86400000; } }); }
  finally { await harness.cleanup(); }
}

test("SQLite manual and safety backups enforce the smaller owner count/admin cap", async () => fixture(async ({ service, options, rows, events }) => {
  for (let i = 0; i < 4; i++) service.createBackup("retention-test");
  assert.equal(rows().length, 4);
  options.backup_max_retention_count = 2;
  const latest = service.createBackup("retention-test", { deferCleanup: true });
  assert.equal(rows().length, 2);
  assert.ok(rows().some(row => row.backup_path === latest));
  assert.ok(events.some(event => event.details.backupsDeleted === 3));
  options.backup_max_retention_count = 0;
  service.createBackup("retention-test");
  assert.equal(rows().length, 3);
}));

test("SQLite restore prunes back to the admin cap once the restored backup is released", async () => fixture(async ({ service, options, rows }) => {
  options.backup_max_retention_count = 2;
  for (let i = 0; i < 3; i++) service.createBackup("retention-test");
  assert.equal(rows().length, 2);
  const [oldest] = rows();
  const result = service.restoreBackup("retention-test", oldest.id);
  const after = rows();
  assert.equal(after.length, 2);
  assert.ok(after.some(row => row.backup_path === result.safetyBackup));
}));

test("SQLite age pruning keeps the newest even when every backup is old; zero disables age", async () => fixture(async ({ service, options, rows, age }) => {
  service.createBackup("retention-test");
  age(2);
  const latest = service.createBackup("retention-test");
  age(20);
  options.backup_max_age_days = 1;
  const result = await service.cleanupOperationalDataAsync("retention-test");
  assert.equal(result.backupsDeleted, 1);
  assert.deepEqual(rows().map(row => row.backup_path), [latest]);
  options.backup_max_age_days = 0;
  service.createBackup("retention-test");
  age(100);
  await service.cleanupOperationalDataAsync("retention-test");
  assert.equal(rows().length, 2);
}));

test("SQLite protected restore/import artifacts survive count and age pruning until released", async () => fixture(async ({ service, options, rows, age }) => {
  const selected = service.createBackup("retention-test");
  const release = service.protectBackup(selected);
  options.backup_max_retention_count = 1;
  options.backup_max_age_days = 1;
  age(10);
  const safety = service.createBackup("retention-test", { deferCleanup: true });
  assert.equal(rows().length, 2);
  assert.ok(fs.existsSync(selected));
  release();
  await service.cleanupOperationalDataAsync("retention-test");
  assert.deepEqual(rows().map(row => row.backup_path), [safety]);
}));

test("SQLite scheduled pruning skips an active portability lock", async () => fixture(async ({ service, lockService, options, rows }) => {
  service.createBackup("retention-test"); service.createBackup("retention-test");
  options.backup_max_retention_count = 1;
  await lockService.withLock(budgetRuntimeLockName("retention-test", BUDGET_RUNTIME_LOCK_JOBS.dataPortability), async () => {
    assert.equal((await service.cleanupOperationalDataAsync("retention-test")).skipped, true);
    assert.equal(rows().length, 2);
  });
  await service.cleanupOperationalDataAsync("retention-test");
  assert.equal(rows().length, 1);
}));

test("SQLite retention leaves backup-like foreign folders, symlinks, failed artifacts and unregistered copies", async () => fixture(async ({ harness, service, options, rows, root }) => {
  const original = service.createBackup("retention-test");
  const foreign = path.join(root, "backup_2020-01-01T00-00-00-000Z_backup-foreign");
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, "operator.txt"), "synthetic foreign file");
  const copy = path.join(root, "backup_2020-01-01T00-00-00-001Z_backup-unregistered");
  fs.cpSync(original, copy, { recursive: true });
  const symlink = path.join(root, "backup_2020-01-01T00-00-00-002Z_backup-symlink");
  fs.symlinkSync(copy, symlink);
  const failed = path.join(root, "backup_2020-01-01T00-00-00-003Z_backup-failed");
  fs.cpSync(original, failed, { recursive: true });
  const db = harness.openPlanningDb();
  try {
    for (const [id, target, success] of [["foreign", foreign, 1], ["symlink", symlink, 1], ["failed", failed, 0]]) {
      db.prepare("INSERT INTO backup_metadata (id,backup_timestamp,backup_path,success,created_at) VALUES (?, '2020-01-01', ?, ?, '2020-01-01')").run(id, target, success);
    }
  } finally { db.close(); }
  options.backup_max_retention_count = 1;
  service.createBackup("retention-test");
  for (const target of [foreign, copy, symlink, failed]) assert.ok(fs.existsSync(target), target);
  assert.equal(fs.existsSync(original), false);
  assert.ok(rows().some(row => row.id === "foreign"));
}));

test("pruning is deterministic, budget count applies without cap, and cutoff is strictly older", () => {
  const rows = [1, 2, 3].map(day => ({ id: String(day), success: 1, backup_path: String(day), backup_timestamp: `2026-06-0${day}T00:00:00Z` }));
  assert.deepEqual(backupPruningPlan(rows, { backup_retention_count: 2 }).map(row => row.id), ["1"]);
  assert.deepEqual(backupPruningPlan(rows, {}, { backup_max_age_days: 1 }, Date.parse("2026-06-03T00:00:00Z")).map(row => row.id), ["1"]);
  assert.deepEqual(backupPruningPlan([rows[0]], {}, { backup_max_age_days: 1 }, Date.parse("2026-12-01")).map(row => row.id), []);
});

test("global step 8 adds backup policy columns without raising the schema version", () => {
  const db = new Database(":memory:");
  try {
    initializeGlobalSchema(db);
    db.exec("ALTER TABLE global_options DROP COLUMN backup_max_retention_count; ALTER TABLE global_options DROP COLUMN backup_max_age_days; PRAGMA user_version = 7;");
    db.prepare("UPDATE global_options SET locale = 'pl' WHERE id = 1").run();
    applyGlobalMigrations(db);
    assert.equal(db.pragma("user_version", { simple: true }), GLOBAL_SCHEMA_VERSION);
    assert.deepEqual(db.prepare("SELECT backup_max_retention_count, backup_max_age_days, locale FROM global_options").get(),
      { backup_max_retention_count: 0, backup_max_age_days: 0, locale: "pl" });
    assert.throws(() => db.exec("UPDATE global_options SET backup_max_age_days = -1"), /CHECK constraint/);
  } finally { db.close(); }
});

test("admin policy validates, persists, exposes only retention policy and survives portable global export/import", async () => fixture(async ({ harness }) => {
  const saved = await harness.request("/api/admin/options", { method: "PUT", body: { backup_max_retention_count: 3, backup_max_age_days: 14 } });
  assert.equal(saved.response.status, 200);
  const snapshot = await harness.api("/api");
  assert.deepEqual(snapshot.backupPolicy, { backup_max_retention_count: 3, backup_max_age_days: 14 });
  for (const field of ["backup_max_retention_count", "backup_max_age_days"]) {
    for (const bad of [-1, 1.5, "invalid", true, 2147483648]) {
      assert.equal((await harness.request("/api/admin/options", { method: "PUT", body: { [field]: bad } })).response.status, 400, `${field}: ${bad}`);
    }
  }
  const exported = await createGlobalStoreExport({ globalStore: harness.cashflow.globalStore });
  const imported = createGlobalStoreImportPlan(exported).writeBatches.find(batch => batch.tableName === "global_options").rows[0];
  assert.equal(imported.backup_max_retention_count, 3);
  assert.equal(imported.backup_max_age_days, 14);
  assert.equal((await harness.request("/api/admin/options", { method: "PUT", body: { backup_max_retention_count: "", backup_max_age_days: 0 } })).response.status, 200);
}));

test("automatic SQLite backups apply admin limits even with deferred operational cleanup", async () => fixture(async ({ harness, service, options, rows }) => {
  service.createBackup("retention-test"); service.createBackup("retention-test");
  const db = harness.openPlanningDb();
  try { db.exec("UPDATE settings SET auto_backup_enabled=1, backup_interval_minutes=1; UPDATE backup_metadata SET backup_timestamp='2000-01-01'"); }
  finally { db.close(); }
  options.backup_max_retention_count = 1;
  // The automatic scheduler compares against the actual current clock.
  const result = service.maybeRunAutomaticBackup("retention-test");
  assert.ok(result.backupPath);
  assert.equal(rows().length, 1);
}));

test("Postgres Date values retain millisecond ordering so a random ID cannot displace the newest", () => {
  const rows = [
    { id: "z-old", success: true, backup_path: "old", backup_timestamp: new Date("2026-06-01T00:00:00.001Z") },
    { id: "a-new", success: true, backup_path: "new", backup_timestamp: new Date("2026-06-01T00:00:00.002Z") }
  ];
  assert.deepEqual(backupPruningPlan(rows, { backup_retention_count: 1 }).map(row => row.id), ["z-old"]);
});

test("SQLite pruning follows registered backups after the owner changes backup location", async () => fixture(async ({ harness, service, options, rows }) => {
  const original = service.createBackup("retention-test");
  const oldRoot = path.join(harness.dataDir, "previous-custom-location");
  fs.mkdirSync(oldRoot);
  const moved = path.join(oldRoot, path.basename(original));
  fs.renameSync(original, moved);
  const db = harness.openPlanningDb();
  try { db.prepare("UPDATE backup_metadata SET backup_path = ? WHERE backup_path = ?").run(moved, original); }
  finally { db.close(); }
  options.backup_max_retention_count = 1;
  const latest = service.createBackup("retention-test");
  assert.equal(fs.existsSync(moved), false);
  assert.deepEqual(rows().map(row => row.backup_path), [latest]);
}));

test("operational retention never treats foreign migration-looking folders as Cashflow artifacts", async () => fixture(async ({ service, root }) => {
  const foreign = path.join(root, "migration_backup_foreign.tmp");
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, "manifest.json"), JSON.stringify({ format: "another-application", status: "completed" }));
  fs.writeFileSync(path.join(foreign, "operator.txt"), "synthetic operator file");
  fs.utimesSync(foreign, new Date("2000-01-01"), new Date("2000-01-01"));
  await service.cleanupOperationalDataAsync("retention-test");
  assert.ok(fs.existsSync(path.join(foreign, "operator.txt")));
}));
