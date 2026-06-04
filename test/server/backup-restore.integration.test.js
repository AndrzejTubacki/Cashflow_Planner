import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { initializeLedgerSchema } from "../../src/server/cashflow-schema.js";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

async function withHarness(fn, options = {}) {
  const harness = await createCashflowTestHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

function latestBackupId(harness) {
  const db = harness.openPlanningDb();
  try {
    return db.prepare(`
      SELECT id
      FROM backup_metadata
      WHERE success = 1
      ORDER BY backup_timestamp DESC
      LIMIT 1
    `).get()?.id;
  } finally {
    db.close();
  }
}

function latestBackupPath(harness) {
  const db = harness.openPlanningDb();
  try {
    return db.prepare(`
      SELECT backup_path
      FROM backup_metadata
      WHERE success = 1
      ORDER BY backup_timestamp DESC
      LIMIT 1
    `).get()?.backup_path;
  } finally {
    db.close();
  }
}

function insertLedgerCurrencyEvent(harness, id, oldCurrency = "PLN", newCurrency = "USD") {
  const db = harness.openPlanningDb();
  try {
    db.prepare(`
      INSERT INTO ledger_currency_events (
        id, old_currency, new_currency, old_balance, converted_opening_balance,
        fx_rate, rate_date, source, details, created_at
      ) VALUES (?, ?, ?, 100, 25, 0.25, '2026-06-01', 'test', '{}', datetime('now'))
    `).run(id, oldCurrency, newCurrency);
  } finally {
    db.close();
  }
}

function ledgerCurrencyEventIds(harness) {
  const db = harness.openPlanningDb();
  try {
    return db.prepare("SELECT id FROM ledger_currency_events ORDER BY id").all().map(row => row.id);
  } finally {
    db.close();
  }
}

test("backup and restore preserve planning data and validate after restore", async () => withHarness(async harness => {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      future_periods: 2,
      fx_provider: "manual",
      manual_fx_rates: {},
      fx_buffer_percent: 0
    }
  });

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Backup one-off",
      currency: "PLN",
      amount: 123,
      type: "income",
      date: "2026-06-01"
    }
  });
  const flex = await harness.api("/api/flex", {
    method: "POST",
    body: {
      name: "Backup flex",
      currency: "PLN",
      amount: 50,
      priority: 1,
      active: 1,
      allow_split: 1,
      min_amount: 10,
      max_amount: 50
    }
  });

  const before = await harness.api("/api");
  await harness.api("/api/backup", { method: "POST", body: {} });
  const backupId = latestBackupId(harness);
  assert.ok(backupId);

  await harness.api(`/api/one-off/${encodeURIComponent(oneOff.id)}`, { method: "DELETE" });
  await harness.api(`/api/flex/${encodeURIComponent(flex.id)}`, { method: "DELETE" });

  let mutated = await harness.api("/api");
  assert.equal(mutated.oneOffs.some(row => row.id === oneOff.id), false);
  assert.equal(mutated.flexTransactions.some(row => row.id === flex.id), false);

  await harness.api(`/api/restore/${encodeURIComponent(backupId)}`, {
    method: "POST",
    body: {}
  });

  const restored = await harness.api("/api");
  const validation = await harness.api("/api/validate", { method: "POST", body: {} });

  assert.equal(restored.oneOffs.some(row => row.id === oneOff.id && row.name === "Backup one-off"), true);
  assert.equal(restored.flexTransactions.some(row => row.id === flex.id && row.name === "Backup flex"), true);
  assert.equal(validation.ok, true);
  assert.equal(restored.settings.fx_provider, before.settings.fx_provider);
  assert.equal(restored.settings.future_periods, before.settings.future_periods);
}));

test("backup and restore replace ledger currency events", async () => withHarness(async harness => {
  insertLedgerCurrencyEvent(harness, "event-backed-up");

  await harness.api("/api/backup", { method: "POST", body: {} });
  const backupId = latestBackupId(harness);
  assert.ok(backupId);

  const db = harness.openPlanningDb();
  try {
    db.prepare("DELETE FROM ledger_currency_events").run();
    db.prepare(`
      INSERT INTO ledger_currency_events (
        id, old_currency, new_currency, old_balance, converted_opening_balance,
        fx_rate, rate_date, source, details, created_at
      ) VALUES ('event-live-only', 'USD', 'EUR', 10, 9, 0.9, '2026-06-02', 'test', '{}', datetime('now'))
    `).run();
  } finally {
    db.close();
  }

  await harness.api(`/api/restore/${encodeURIComponent(backupId)}`, {
    method: "POST",
    body: {}
  });

  assert.deepEqual(ledgerCurrencyEventIds(harness), ["event-backed-up"]);
}));

test("restore returns 404 for unknown metadata and missing backup folders", async () => withHarness(async harness => {
  const unknown = await harness.request("/api/restore/does-not-exist", {
    method: "POST",
    body: {}
  });
  assert.equal(unknown.response.status, 404);

  await harness.api("/api/backup", { method: "POST", body: {} });
  const backupId = latestBackupId(harness);
  fs.rmSync(latestBackupPath(harness), { recursive: true, force: true });
  const missing = await harness.request(`/api/restore/${encodeURIComponent(backupId)}`, {
    method: "POST",
    body: {}
  });
  assert.equal(missing.response.status, 404);
  assert.ok(missing.body.details.some(item => item.reason === "backup_folder_missing"));
}));

test("restore rejects corrupt backups before creating a safety backup", async () => withHarness(async harness => {
  await harness.api("/api/backup", { method: "POST", body: {} });
  const backupId = latestBackupId(harness);
  const backupPath = latestBackupPath(harness);
  const beforeCount = (() => {
    const db = harness.openPlanningDb();
    try {
      return db.prepare("SELECT COUNT(*) AS count FROM backup_metadata WHERE success = 1").get().count;
    } finally {
      db.close();
    }
  })();
  fs.writeFileSync(path.join(backupPath, "planning.sqlite"), "not sqlite");

  const rejected = await harness.request(`/api/restore/${encodeURIComponent(backupId)}`, {
    method: "POST",
    body: {}
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.details.phase, "backup_validation_failed");
  const db = harness.openPlanningDb();
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM backup_metadata WHERE success = 1").get().count, beforeCount);
  } finally {
    db.close();
  }
}));

test("staged backup failures clean partial folders and record failed metadata", async () => {
  for (const failurePhase of [
    "before_planning_copy",
    "before_ledger_copy",
    "before_backup_validation",
    "before_success_metadata"
  ]) {
    let failBackup = false;
    await withHarness(async harness => {
      const ledgerDb = harness.openLedgerDb("2026");
      try {
        initializeLedgerSchema(ledgerDb);
      } finally {
        ledgerDb.close();
      }

      failBackup = true;
      const failed = await harness.request("/api/backup", { method: "POST", body: {} });
      assert.equal(failed.response.status, 500, failurePhase);

      const backupDir = path.join(harness.dataDir, harness.userId, "backups");
      const folders = fs.existsSync(backupDir)
        ? fs.readdirSync(backupDir).filter(name => name.startsWith("backup_"))
        : [];
      assert.deepEqual(folders, [], failurePhase);

      const db = harness.openPlanningDb();
      try {
        const metadata = db.prepare("SELECT success, error_message FROM backup_metadata ORDER BY created_at DESC LIMIT 1").get();
        assert.equal(metadata.success, 0, failurePhase);
        assert.match(metadata.error_message, new RegExp(`forced ${failurePhase}`));
      } finally {
        db.close();
      }
    }, {
      backupServiceHook: ({ phase }) => {
        if (failBackup && phase === failurePhase) {
          throw new Error(`forced ${failurePhase}`);
        }
      }
    });
  }
});

test("retention cleanup failures do not fail a completed backup", async () => {
  let failCleanup = false;
  await withHarness(async harness => {
    failCleanup = true;
    const created = await harness.api("/api/backup", { method: "POST", body: {} });
    assert.equal(created.ok, true);
    assert.equal(fs.existsSync(created.path), true);
    assert.ok(harness.errors.some(item =>
      item.kind === "cashflow_operational_retention_failed"
        && item.details.reason === "backup_created"
    ));
  }, {
    backupServiceHook: ({ phase }) => {
      if (failCleanup && phase === "before_retention_cleanup") {
        throw new Error("forced retention cleanup failure");
      }
    }
  });
});

test("restore keeps its target backup until the deferred safety operation finishes", async () => withHarness(async harness => {
  await harness.api("/api/settings", {
    method: "PUT",
    body: { backup_retention_count: 1 }
  });
  const retained = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Retained by restore",
      currency: "PLN",
      amount: 10,
      type: "income",
      date: "2026-06-01"
    }
  });
  await harness.api("/api/backup", { method: "POST", body: {} });
  const backupId = latestBackupId(harness);
  const removed = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Removed by restore",
      currency: "PLN",
      amount: 20,
      type: "expense",
      date: "2026-06-02"
    }
  });

  const restored = await harness.api(`/api/restore/${encodeURIComponent(backupId)}`, {
    method: "POST",
    body: {}
  });
  assert.equal(restored.oneOffs.some(row => row.id === retained.id), true);
  assert.equal(restored.oneOffs.some(row => row.id === removed.id), false);
}));

test("restore rollback failures return structured recovery details", async () => {
  let failRestore = false;
  await withHarness(async harness => {
    await harness.api("/api/backup", { method: "POST", body: {} });
    const backupId = latestBackupId(harness);
    failRestore = true;

    const failed = await harness.request(`/api/restore/${encodeURIComponent(backupId)}`, {
      method: "POST",
      body: {}
    });
    assert.equal(failed.response.status, 500);
    assert.equal(failed.body.details.phase, "rollback_failed");
    assert.equal(typeof failed.body.details.safetyBackup, "string");
    assert.match(failed.body.details.originalError, /forced restore failure/);
    assert.match(failed.body.details.rollbackError, /forced restore rollback failure/);
  }, {
    backupServiceHook: ({ phase }) => {
      if (!failRestore) return;
      if (phase === "before_restore_apply") throw new Error("forced restore failure");
      if (phase === "before_restore_rollback") throw new Error("forced restore rollback failure");
    }
  });
});

test("operational retention prunes bounded rows and completed recovery folders", async () => withHarness(async harness => {
  await harness.api("/api/settings", {
    method: "PUT",
    body: { backup_retention_count: 10 }
  });
  await harness.api("/api/backup", { method: "POST", body: {} });
  await harness.api("/api/backup", { method: "POST", body: {} });
  await harness.api("/api/backup", { method: "POST", body: {} });
  await harness.api("/api/settings", {
    method: "PUT",
    body: { backup_retention_count: 2 }
  });

  const db = harness.openPlanningDb();
  try {
    db.transaction(() => {
      const snapshot = db.prepare(`
        INSERT INTO projection_snapshots (
          id, snapshot_timestamp, total_projected_income, total_projected_expenses,
          available_balance, fx_rates_used, ledger_currency, generation_succeeded,
          warning_count, created_at
        ) VALUES (?, ?, 0, 0, 0, '{}', 'PLN', 1, 0, ?)
      `);
      const event = db.prepare(`
        INSERT INTO event_log (id, action, entity_type, entity_id, details, timestamp)
        VALUES (?, 'retention-test', 'test', ?, '{}', ?)
      `);
      const notification = db.prepare(`
        INSERT INTO notification_queue (
          id, notification_type, title, message, priority, entity_id, queued_at, sent_at, dedupe_key
        ) VALUES (?, 'test', 'Test', 'Test', 'default', ?, ?, ?, ?)
      `);
      const failedBackup = db.prepare(`
        INSERT INTO backup_metadata (
          id, backup_timestamp, backup_path, size_bytes, success, error_message, created_at
        ) VALUES (?, ?, ?, NULL, 0, 'failed', ?)
      `);

      for (let index = 0; index < 2_010; index += 1) {
        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        if (index < 110) snapshot.run(`retention-snapshot-${index}`, timestamp, timestamp);
        event.run(`retention-event-${index}`, `entity-${index}`, timestamp);
        if (index < 1_010) {
          notification.run(
            `retention-notification-${index}`,
            `entity-${index}`,
            timestamp,
            timestamp,
            `retention-${index}`
          );
        }
        if (index < 110) {
          failedBackup.run(`retention-failed-backup-${index}`, timestamp, `/missing/${index}`, timestamp);
        }
      }
      notification.run("retention-unsent-1", "unsent-1", "2026-06-01T00:00:00.000Z", null, "unsent-1");
      notification.run("retention-unsent-2", "unsent-2", "2026-06-01T00:00:01.000Z", null, "unsent-2");
    })();
  } finally {
    db.close();
  }

  const builtInBackupDir = path.join(harness.dataDir, harness.userId, "backups");
  fs.mkdirSync(builtInBackupDir, { recursive: true });
  for (let index = 0; index < 3; index += 1) {
    const dir = path.join(builtInBackupDir, `migration_backup_completed_${index}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
      format: "cashflow-migration-recovery",
      status: "completed",
      createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      completedAt: `2026-01-0${index + 1}T01:00:00.000Z`
    }));
  }
  const pending = path.join(builtInBackupDir, "migration_backup_pending");
  fs.mkdirSync(pending);
  fs.writeFileSync(path.join(pending, "manifest.json"), JSON.stringify({
    format: "cashflow-migration-recovery",
    status: "pending"
  }));
  const staleTemp = path.join(builtInBackupDir, "backup_stale.tmp");
  fs.mkdirSync(staleTemp);
  fs.utimesSync(staleTemp, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  const staleMigrationTemp = path.join(builtInBackupDir, "migration_backup_stale.tmp");
  fs.mkdirSync(staleMigrationTemp);
  fs.utimesSync(staleMigrationTemp, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  const unrelatedTemp = path.join(builtInBackupDir, "operator-work.tmp");
  fs.mkdirSync(unrelatedTemp);
  fs.utimesSync(unrelatedTemp, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

  harness.cashflow.cleanupOperationalData(harness.userId);

  const check = harness.openPlanningDb();
  try {
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM projection_snapshots").get().count, 100);
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM event_log").get().count, 2_000);
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE sent_at IS NOT NULL").get().count, 1_000);
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM notification_queue WHERE sent_at IS NULL").get().count, 2);
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM backup_metadata WHERE success = 0").get().count, 100);
    assert.equal(check.prepare("SELECT COUNT(*) AS count FROM backup_metadata WHERE success = 1").get().count, 2);
  } finally {
    check.close();
  }
  assert.equal(fs.existsSync(pending), true);
  assert.equal(fs.existsSync(staleTemp), false);
  assert.equal(fs.existsSync(staleMigrationTemp), false);
  assert.equal(fs.existsSync(unrelatedTemp), true);
  assert.equal(
    fs.readdirSync(builtInBackupDir).filter(name => name.startsWith("migration_backup_completed_")).length,
    2
  );
}));
