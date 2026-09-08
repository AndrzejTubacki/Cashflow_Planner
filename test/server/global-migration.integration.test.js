import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCashflowGlobalService } from "../../src/server/cashflow-global-service.js";
import { cleanupGlobalMigrationRecoveryFolders } from "../../src/server/cashflow-global-migration-recovery.js";
import {
  initializeLedgerSchema,
  initializePlanningSchema
} from "../../src/server/cashflow-schema.js";
import {
  GLOBAL_SCHEMA_VERSION,
  LEGACY_ADMIN_ACCOUNT_ID
} from "../../src/server/cashflow-global-schema.js";

function createVersionOneGlobalDb(dataDir, users = []) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
  try {
    db.exec(`
      PRAGMA user_version = 1;

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT '["admin"]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_selected_at TEXT
      );

      CREATE TABLE global_options (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ledger_currency TEXT NOT NULL DEFAULT 'PLN',
        locale TEXT NOT NULL DEFAULT 'en',
        timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw',
        future_periods INTEGER NOT NULL DEFAULT 11,
        fx_provider TEXT NOT NULL DEFAULT 'nbp',
        fx_buffer_percent REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      INSERT INTO global_options (id, updated_at) VALUES (1, datetime('now'));
    `);
    const insert = db.prepare(`
      INSERT INTO users (id, display_name, permissions, created_at, updated_at)
      VALUES (?, ?, '["admin"]', datetime('now'), datetime('now'))
    `);
    for (const user of users) {
      insert.run(user.id, user.displayName || user.id);
    }
  } finally {
    db.close();
  }
}

function dummyPlanningDb(onOpen = () => {}) {
  onOpen();
  return {
    prepare: () => ({
      run: () => ({ changes: 1 })
    }),
    close: () => {}
  };
}

function createProfileStorage(dataDir, profileId) {
  const profileDir = path.join(dataDir, profileId);
  fs.mkdirSync(profileDir, { recursive: true });
  const planning = new Database(path.join(profileDir, "planning.sqlite"));
  try {
    initializePlanningSchema(planning);
  } finally {
    planning.close();
  }
  const ledger = new Database(path.join(profileDir, "ledger_2026.sqlite"));
  try {
    initializeLedgerSchema(ledger);
  } finally {
    ledger.close();
  }
}

function writeGlobalRecoveryManifest(recoveryRoot, name, manifest) {
  const recoveryPath = path.join(recoveryRoot, name);
  fs.mkdirSync(recoveryPath, { recursive: true });
  fs.writeFileSync(
    path.join(recoveryPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return recoveryPath;
}

async function withRuntime(fn) {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-global-migration-test-"));
  try {
    return await fn({
      dataDir: path.join(runtimeRoot, "data"),
      runtimeRoot
    });
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

test("global migration snapshots version one and assigns existing profile storage to one legacy admin", async () => {
  await withRuntime(({ dataDir }) => {
    const profiles = ["household", "shared"];
    createVersionOneGlobalDb(dataDir, [
      { id: "household", displayName: "Household Budget" },
      { id: "metadata_only", displayName: "Metadata Only" }
    ]);
    for (const profile of profiles) {
      fs.mkdirSync(path.join(dataDir, profile), { recursive: true });
    }

    const service = createCashflowGlobalService({
      cashflowUserStorageExists: userId => profiles.includes(userId),
      dataDir,
      listCashflowUserIds: () => profiles,
      openPlanningDb: () => dummyPlanningDb()
    });

    assert.equal(service.getGlobalOptions().holiday_country, "PL");

    const db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
    try {
      assert.equal(db.pragma("user_version", { simple: true }), GLOBAL_SCHEMA_VERSION);
      assert.deepEqual(
        db.prepare("SELECT id, display_name FROM accounts ORDER BY id").all(),
        [{ id: LEGACY_ADMIN_ACCOUNT_ID, display_name: "Legacy Administrator" }]
      );
      assert.deepEqual(
        db.prepare("SELECT account_id, role FROM account_global_roles").all(),
        [{ account_id: LEGACY_ADMIN_ACCOUNT_ID, role: "system_admin" }]
      );
      assert.deepEqual(
        db.prepare("SELECT id, storage_key, display_name FROM budgets ORDER BY id").all(),
        [
          { id: "household", storage_key: "household", display_name: "Household Budget" },
          { id: "shared", storage_key: "shared", display_name: "shared" }
        ]
      );
      assert.deepEqual(
        db.prepare("SELECT budget_id, account_id, role FROM budget_memberships ORDER BY budget_id").all(),
        profiles.map(budgetId => ({
          budget_id: budgetId,
          account_id: LEGACY_ADMIN_ACCOUNT_ID,
          role: "owner"
        }))
      );
      assert.equal(db.prepare("SELECT 1 FROM budgets WHERE id = 'metadata_only'").get(), undefined);
    } finally {
      db.close();
    }

    const recoveryRoot = path.join(dataDir, "global-migration-backups");
    const recoveries = fs.readdirSync(recoveryRoot);
    assert.equal(recoveries.length, 1);
    const recoveryPath = path.join(recoveryRoot, recoveries[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(recoveryPath, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.sourceVersion, 1);
    assert.equal(manifest.targetVersion, GLOBAL_SCHEMA_VERSION);

    const recoveryDb = new Database(path.join(recoveryPath, "cashflow-global.sqlite"), {
      readonly: true
    });
    try {
      assert.equal(recoveryDb.pragma("user_version", { simple: true }), 1);
    } finally {
      recoveryDb.close();
    }

    service.getGlobalOptions();
    assert.equal(fs.readdirSync(recoveryRoot).length, 1);
    assert.ok(profiles.every(profile => fs.existsSync(path.join(dataDir, profile))));
  });
});

test("initial global schema creation imports existing storage budgets before account bootstrap", async () => {
  await withRuntime(({ dataDir }) => {
    const storage = new Set(["household", "shared"]);
    for (const profile of storage) {
      createProfileStorage(dataDir, profile);
    }

    const service = createCashflowGlobalService({
      cashflowUserStorageExists: userId => storage.has(userId),
      dataDir,
      listCashflowUserIds: () => [...storage],
      openPlanningDb: userId => dummyPlanningDb(() => storage.add(userId))
    });

    service.getGlobalOptions();

    let db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
    try {
      assert.equal(db.pragma("user_version", { simple: true }), GLOBAL_SCHEMA_VERSION);
      assert.deepEqual(
        db.prepare("SELECT id FROM budgets ORDER BY id").all().map(row => row.id),
        ["household", "shared"]
      );
      assert.deepEqual(
        db.prepare("SELECT account_id, role FROM account_global_roles ORDER BY account_id").all(),
        [{ account_id: LEGACY_ADMIN_ACCOUNT_ID, role: "system_admin" }]
      );
      assert.deepEqual(
        db.prepare("SELECT DISTINCT account_id, role FROM budget_memberships ORDER BY account_id").all(),
        [{ account_id: LEGACY_ADMIN_ACCOUNT_ID, role: "owner" }]
      );
    } finally {
      db.close();
    }

    service.createUser({
      userId: "new_account",
      displayName: "New Account"
    });

    db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
    try {
      assert.deepEqual(
        db.prepare("SELECT account_id, role FROM account_global_roles ORDER BY account_id").all(),
        [{ account_id: LEGACY_ADMIN_ACCOUNT_ID, role: "system_admin" }]
      );
      assert.equal(
        db.prepare(`
          SELECT role
          FROM budget_memberships
          WHERE budget_id = 'new_account' AND account_id = 'new_account'
        `).get()?.role,
        "owner"
      );
    } finally {
      db.close();
    }
  });
});

test("failed global migration rolls back schema changes and reuses its recovery snapshot", async () => {
  await withRuntime(({ dataDir }) => {
    createVersionOneGlobalDb(dataDir, [{ id: "household", displayName: "Household" }]);
    fs.mkdirSync(path.join(dataDir, "household"), { recursive: true });

    const failing = createCashflowGlobalService({
      beforeGlobalMigrationStep: () => {
        throw new Error("injected global migration failure");
      },
      cashflowUserStorageExists: userId => userId === "household",
      dataDir,
      listCashflowUserIds: () => ["household"],
      openPlanningDb: () => dummyPlanningDb()
    });

    assert.throws(() => failing.getGlobalOptions(), /injected global migration failure/);

    let db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
    try {
      assert.equal(db.pragma("user_version", { simple: true }), 1);
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get(),
        undefined
      );
    } finally {
      db.close();
    }

    const recoveryRoot = path.join(dataDir, "global-migration-backups");
    assert.equal(fs.readdirSync(recoveryRoot).length, 1);

    const succeeding = createCashflowGlobalService({
      cashflowUserStorageExists: userId => userId === "household",
      dataDir,
      listCashflowUserIds: () => ["household"],
      openPlanningDb: () => dummyPlanningDb()
    });
    succeeding.getGlobalOptions();

    db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
    try {
      assert.equal(db.pragma("user_version", { simple: true }), GLOBAL_SCHEMA_VERSION);
      assert.ok(db.prepare("SELECT 1 FROM budgets WHERE id = 'household'").get());
    } finally {
      db.close();
    }
    assert.equal(fs.readdirSync(recoveryRoot).length, 1);
  });
});

test("global migration recovery retention keeps newest completed folders only", async () => {
  await withRuntime(({ dataDir }) => {
    const recoveryRoot = path.join(dataDir, "global-migration-backups");
    const completed = [];
    for (let index = 0; index < 4; index += 1) {
      completed.push(writeGlobalRecoveryManifest(
        recoveryRoot,
        `global_migration_backup_2026-01-0${index + 1}`,
        {
          format: "cashflow-global-migration-recovery",
          status: "completed",
          createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
          completedAt: `2026-01-0${index + 1}T01:00:00.000Z`
        }
      ));
    }
    const pending = writeGlobalRecoveryManifest(
      recoveryRoot,
      "global_migration_backup_pending",
      {
        format: "cashflow-global-migration-recovery",
        status: "pending",
        createdAt: "2026-01-05T00:00:00.000Z"
      }
    );
    const incomplete = path.join(recoveryRoot, "global_migration_backup_incomplete");
    fs.mkdirSync(incomplete, { recursive: true });
    const temp = path.join(recoveryRoot, "global_migration_backup_temp.tmp");
    fs.mkdirSync(temp, { recursive: true });

    const cleanup = cleanupGlobalMigrationRecoveryFolders(recoveryRoot, {
      retentionCount: 2
    });

    assert.deepEqual(cleanup, {
      completedDeleted: 2,
      retainedCompleted: 2
    });
    assert.equal(fs.existsSync(completed[0]), false);
    assert.equal(fs.existsSync(completed[1]), false);
    assert.equal(fs.existsSync(completed[2]), true);
    assert.equal(fs.existsSync(completed[3]), true);
    assert.equal(fs.existsSync(pending), true);
    assert.equal(fs.existsSync(incomplete), true);
    assert.equal(fs.existsSync(temp), true);
  });
});

test("new accounts own their budget without receiving legacy administrator ownership", async () => {
  await withRuntime(({ dataDir }) => {
    const storage = new Set();
    const service = createCashflowGlobalService({
      cashflowUserStorageExists: userId => storage.has(userId),
      dataDir,
      listCashflowUserIds: () => [...storage],
      openPlanningDb: userId => dummyPlanningDb(() => storage.add(userId))
    });

    service.getGlobalOptions();
    let db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM accounts").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM budgets").get().count, 0);
    } finally {
      db.close();
    }

    const session = service.createUser({
      userId: "new_budget",
      displayName: "New Budget"
    });
    assert.equal(session.userId, "new_budget");

    db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
    try {
      assert.deepEqual(
        db.prepare("SELECT id, storage_key, display_name FROM budgets").get(),
        {
          id: "new_budget",
          storage_key: "new_budget",
          display_name: "New Budget"
        }
      );
      assert.deepEqual(
        db.prepare("SELECT account_id, role FROM budget_memberships WHERE budget_id = 'new_budget'").get(),
        {
          account_id: "new_budget",
          role: "owner"
        }
      );
    } finally {
      db.close();
    }
  });
});
