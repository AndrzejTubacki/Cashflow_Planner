import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCashflowBackupService } from "../../src/server/cashflow-backup-service.js";

function throwIfCalled(name) {
  return () => {
    throw new Error(`${name} should not be called on the Postgres backup path`);
  };
}

async function withTempBackupRoot(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "cashflow-backup-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function postgresBackupStore({ settingsRow, planningTables = {} }) {
  const metadataRows = [];

  return {
    backend: "postgres",
    metadataRows,
    async listConfirmedTransactions() {
      return [];
    },
    async listLedgerYears() {
      return [];
    },
    async listPlanningRows(budgetId, tableName) {
      if (tableName === "settings") return [{ ...settingsRow, budget_id: budgetId }];
      if (tableName === "backup_metadata") return metadataRows.filter(row => row.budget_id === budgetId);
      return (planningTables[tableName] || []).map(row => ({ ...row, budget_id: budgetId }));
    },
    async insertPlanningRows(budgetId, tableName, rows) {
      if (tableName === "backup_metadata") {
        metadataRows.push(...rows.map(row => ({ ...row, budget_id: budgetId })));
        return { inserted: rows.length };
      }
      throw new Error(`Unexpected insertPlanningRows table: ${tableName}`);
    },
    async replaceConfirmedTransactionsForYear() {
      return { inserted: 0, replaced: true };
    },
    async replacePlanningRows(budgetId, tableName, rows) {
      planningTables[tableName] = rows;
      return { inserted: rows.length, replaced: true };
    }
  };
}

function requiredSyncStubs() {
  return {
    backupDir: () => {
      throw new Error("SQLite backupDir should not be used on the Postgres path");
    },
    directorySizeBytes: throwIfCalled("directorySizeBytes"),
    initReadOnlyPragmas: throwIfCalled("initReadOnlyPragmas"),
    listLedgerYears: throwIfCalled("listLedgerYears"),
    openLedgerDb: throwIfCalled("openLedgerDb"),
    openPlanningDb: throwIfCalled("openPlanningDb"),
    recalculateLedgerRunningBalance: throwIfCalled("recalculateLedgerRunningBalance"),
    regenerateProjectionsAfterMutation: throwIfCalled("regenerateProjectionsAfterMutation"),
    getSettings: throwIfCalled("getSettings")
  };
}

test("createBackupAsync writes a real JSON snapshot file and records success metadata through the budget store", async () => {
  await withTempBackupRoot(async dir => {
    const budgetStore = postgresBackupStore({
      settingsRow: { id: 1, ledger_currency: "PLN", locale: "en", timezone: "UTC" },
      planningTables: {
        recurring_expenses: [{ id: "exp-1", name: "Rent", amount: 100 }]
      }
    });

    const service = createCashflowBackupService({
      ...requiredSyncStubs(),
      backupHook: null,
      backupRootDir: () => dir,
      budgetStore,
      generateId: prefix => `${prefix}-1`,
      getSettingsAsync: async userId => (await budgetStore.listPlanningRows(userId, "settings"))[0],
      recalculateLedgerRunningBalanceAsync: async () => {},
      regenerateProjectionsAfterMutationAsync: async () => ({ projection_ok: true, projection_error: null })
    });

    const backupPath = await service.createBackupAsync("household");

    assert.equal(fs.existsSync(backupPath), true);
    assert.equal(path.extname(backupPath), ".json");
    const written = JSON.parse(fs.readFileSync(backupPath, "utf8"));
    assert.equal(written.format, "cashflow-budget-store-snapshot");
    assert.equal(written.payload.tables.recurring_expenses[0].id, "exp-1");

    assert.equal(budgetStore.metadataRows.length, 1);
    assert.equal(budgetStore.metadataRows[0].success, true);
    assert.equal(budgetStore.metadataRows[0].backup_path, backupPath);
    assert.equal(budgetStore.metadataRows[0].budget_id, "household");
  });
});

test("createBackupAsync records failure metadata when snapshot creation fails before any file is written", async () => {
  await withTempBackupRoot(async dir => {
    const budgetStore = postgresBackupStore({
      settingsRow: { id: 1, ledger_currency: "PLN", locale: "en", timezone: "UTC" }
    });

    const service = createCashflowBackupService({
      ...requiredSyncStubs(),
      backupRootDir: () => dir,
      budgetStore,
      generateId: prefix => `${prefix}-1`,
      getSettingsAsync: async userId => (await budgetStore.listPlanningRows(userId, "settings"))[0],
      recalculateLedgerRunningBalanceAsync: async () => {},
      regenerateProjectionsAfterMutationAsync: async () => ({ projection_ok: true, projection_error: null })
    });

    // An empty userId makes createBudgetStoreSnapshot's budgetIds filter to
    // an empty array, so it throws before any file I/O happens — this
    // exercises the catch block's cleanup/failure-metadata path.
    await assert.rejects(
      () => service.createBackupAsync(""),
      /budgetId is required|At least one budgetId is required/
    );

    assert.equal(budgetStore.metadataRows.length, 1);
    assert.equal(budgetStore.metadataRows[0].success, false);
    assert.ok(budgetStore.metadataRows[0].error_message);
  });
});

test("restoreBackupAsync restores planning rows from a real JSON snapshot file and recalculates/regenerates afterward", async () => {
  await withTempBackupRoot(async dir => {
    const budgetStore = postgresBackupStore({
      settingsRow: { id: 1, ledger_currency: "PLN", locale: "en", timezone: "UTC" },
      planningTables: {
        recurring_expenses: [{ id: "exp-original", name: "Original", amount: 50 }]
      }
    });

    let balanceRecalculated = 0;
    let projectionRegenerated = 0;

    const service = createCashflowBackupService({
      ...requiredSyncStubs(),
      backupRootDir: () => dir,
      budgetStore,
      generateId: (() => {
        let n = 0;
        return prefix => `${prefix}-${++n}`;
      })(),
      getSettingsAsync: async userId => (await budgetStore.listPlanningRows(userId, "settings"))[0],
      recalculateLedgerRunningBalanceAsync: async () => {
        balanceRecalculated += 1;
      },
      regenerateProjectionsAfterMutationAsync: async () => {
        projectionRegenerated += 1;
        return { projection_ok: true, projection_error: null };
      }
    });

    const backupPath = await service.createBackupAsync("household");

    // Mutate live data after the backup was taken, then restore it.
    await budgetStore.replacePlanningRows("household", "recurring_expenses", [
      { id: "exp-changed", name: "Changed after backup", amount: 999 }
    ]);

    const backupId = budgetStore.metadataRows[0].id;
    const result = await service.restoreBackupAsync("household", backupId);

    assert.equal(result.ok, true);
    assert.equal(result.restoredFrom, backupPath);
    assert.equal(result.mode, "budget_store_snapshot");
    assert.equal(result._projection.projection_ok, true);
    assert.equal(balanceRecalculated, 1);
    // createBackupAsync (called once above, and once again internally for the
    // pre-restore safety backup) never regenerates projections itself — only
    // restoreBackupFromPathAsync does, once, for the actual restore.
    assert.equal(projectionRegenerated, 1);

    const restoredRows = await budgetStore.listPlanningRows("household", "recurring_expenses");
    assert.equal(restoredRows[0].id, "exp-original");
  });
});

test("restoreBackupAsync rolls back to a fresh safety backup when the target restore fails", async () => {
  await withTempBackupRoot(async dir => {
    const budgetStore = postgresBackupStore({
      settingsRow: { id: 1, ledger_currency: "PLN", locale: "en", timezone: "UTC" },
      planningTables: {
        recurring_expenses: [{ id: "exp-current", name: "Current", amount: 10 }]
      }
    });

    let regenerateCall = 0;

    const service = createCashflowBackupService({
      ...requiredSyncStubs(),
      backupRootDir: () => dir,
      budgetStore,
      generateId: (() => {
        let n = 0;
        return prefix => `${prefix}-${++n}`;
      })(),
      getSettingsAsync: async userId => (await budgetStore.listPlanningRows(userId, "settings"))[0],
      recalculateLedgerRunningBalanceAsync: async () => {},
      regenerateProjectionsAfterMutationAsync: async () => {
        regenerateCall += 1;
        // Fail only the first restore attempt (the target backup), succeed on
        // the rollback-to-safety-backup attempt.
        if (regenerateCall === 1) {
          return { projection_ok: false, projection_error: "boom" };
        }
        return { projection_ok: true, projection_error: null };
      }
    });

    // Create a backup to restore (this becomes corrupted for the test by
    // writing an otherwise-valid but distinct snapshot).
    const targetBackupPath = await service.createBackupAsync("household");
    const targetBackupId = budgetStore.metadataRows[0].id;
    void targetBackupPath;

    await assert.rejects(
      () => service.restoreBackupAsync("household", targetBackupId),
      error => {
        assert.match(error.message, /rolled back/);
        return true;
      }
    );

    // Two backups now exist: the original target backup and the safety
    // backup created just before the (failed) restore attempt.
    assert.equal(budgetStore.metadataRows.length, 2);
    assert.equal(regenerateCall, 2);
  });
});

function automaticBackupService(dir, budgetStore, settingsRow) {
  return createCashflowBackupService({
    ...requiredSyncStubs(),
    backupRootDir: () => dir,
    budgetStore,
    generateId: prefix => `${prefix}-auto`,
    getSettingsAsync: async () => settingsRow,
    recalculateLedgerRunningBalanceAsync: async () => {},
    regenerateProjectionsAfterMutationAsync: async () => ({ projection_ok: true, projection_error: null })
  });
}

test("maybeRunAutomaticBackupAsync does nothing when auto_backup_enabled is off", async () => {
  await withTempBackupRoot(async dir => {
    const budgetStore = postgresBackupStore({ settingsRow: {} });
    const service = automaticBackupService(dir, budgetStore, {
      auto_backup_enabled: 0,
      backup_interval_minutes: 60
    });

    assert.equal(await service.maybeRunAutomaticBackupAsync("household"), null);
    assert.equal(budgetStore.metadataRows.length, 0);
  });
});

test("maybeRunAutomaticBackupAsync skips when the last successful backup is still within the interval", async () => {
  await withTempBackupRoot(async dir => {
    const budgetStore = postgresBackupStore({ settingsRow: {} });
    budgetStore.metadataRows.push({
      budget_id: "household",
      id: "recent-backup",
      success: true,
      backup_timestamp: new Date().toISOString()
    });
    const service = automaticBackupService(dir, budgetStore, {
      auto_backup_enabled: 1,
      backup_interval_minutes: 60
    });

    assert.equal(await service.maybeRunAutomaticBackupAsync("household"), null);
    assert.equal(budgetStore.metadataRows.length, 1);
  });
});

test("maybeRunAutomaticBackupAsync creates a real backup when the interval has elapsed", async () => {
  await withTempBackupRoot(async dir => {
    const budgetStore = postgresBackupStore({
      settingsRow: { id: 1, ledger_currency: "PLN", locale: "en", timezone: "UTC" }
    });
    budgetStore.metadataRows.push({
      budget_id: "household",
      id: "stale-backup",
      success: true,
      backup_timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    });
    const service = automaticBackupService(dir, budgetStore, {
      auto_backup_enabled: 1,
      backup_interval_minutes: 60
    });

    const result = await service.maybeRunAutomaticBackupAsync("household");

    assert.ok(result?.backupPath);
    assert.equal(fs.existsSync(result.backupPath), true);
    assert.equal(result.deleted, 0);
    assert.equal(budgetStore.metadataRows.length, 2);
    assert.equal(budgetStore.metadataRows[1].success, true);
  });
});
