import assert from "node:assert/strict";

import Database from "better-sqlite3";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createSqliteMigrationSnapshot } from "../../scripts/create-sqlite-migration-snapshot.mjs";
import { initializeGlobalSchema } from "../../src/server/cashflow-global-schema.js";
import {
  initializeLedgerSchema,
  initializePlanningSchema
} from "../../src/server/cashflow-schema.js";

async function withTempDirs(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "cashflow-sqlite-snapshot-test-"));
  const dataDir = path.join(root, "data");
  const outputDir = path.join(root, "snapshots");
  fs.mkdirSync(dataDir, { recursive: true });

  try {
    return await fn({ dataDir, outputDir, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function createSnapshotSource(dataDir) {
  const budgetDir = path.join(dataDir, "household");
  fs.mkdirSync(budgetDir, { recursive: true });

  const planning = new Database(path.join(budgetDir, "planning.sqlite"));
  try {
    initializePlanningSchema(planning);
    planning.prepare(`
      INSERT INTO one_off_transactions (
        id, name, amount, currency, type, date, created_at, updated_at
      )
      VALUES (
        'oneoff-secret-id', 'Private planning row value', 12.34, 'PLN',
        'expense', '2026-01-02', datetime('now'), datetime('now')
      )
    `).run();
  } finally {
    planning.close();
  }

  const ledger = new Database(path.join(budgetDir, "ledger_2026.sqlite"));
  try {
    initializeLedgerSchema(ledger);
    ledger.prepare(`
      INSERT INTO confirmed_transactions (
        id, name, currency, amount, type, date, confirmed_date,
        fx_rate, buffered_fx_rate, ledger_currency, running_balance_pln,
        ledger_amount, occurrence_key, created_at, updated_at
      )
      VALUES (
        'tx-secret-id', 'Private ledger row value', 'PLN', 10, 'income',
        '2026-01-02', '2026-01-02', 1, 1, 'PLN', 10, 10,
        'private-occurrence-key', datetime('now'), datetime('now')
      )
    `).run();
  } finally {
    ledger.close();
  }

  const global = new Database(path.join(dataDir, "cashflow-global.sqlite"));
  try {
    initializeGlobalSchema(global, { storageProfileIds: ["household"] });
  } finally {
    global.close();
  }
}

test("SQLite migration snapshot creates verified DATA_DIR-shaped database copies", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    createSnapshotSource(dataDir);

    const result = createSqliteMigrationSnapshot({
      dataDir,
      outputDir,
      now: new Date("2026-01-03T04:05:06Z")
    });

    assert.equal(result.ok, true);
    assert.equal(result.format, "cashflow-sqlite-migration-snapshot");
    assert.equal(result.containsSensitiveData, true);
    assert.equal(result.filesCopied, 3);
    assert.equal(result.budgets, 1);
    assert.equal(result.planningDbs, 1);
    assert.equal(result.ledgerDbs, 1);
    assert.equal(result.confirmedRows, 1);
    assert.equal(fs.existsSync(result.snapshotPath), true);
    assert.equal(fs.existsSync(`${result.snapshotPath}.tmp`), false);

    const summaryJson = JSON.stringify(result);
    assert.doesNotMatch(summaryJson, /Private planning row value/);
    assert.doesNotMatch(summaryJson, /Private ledger row value/);
    assert.doesNotMatch(summaryJson, /oneoff-secret-id/);
    assert.doesNotMatch(summaryJson, /private-occurrence-key/);

    const manifest = JSON.parse(fs.readFileSync(path.join(result.snapshotPath, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.sourceBackend, "sqlite");
    assert.equal(manifest.audit.totals.budgets, 1);
    assert.equal(manifest.copiedFiles.length, 3);

    const planningCopy = new Database(path.join(result.snapshotPath, "household", "planning.sqlite"), {
      readonly: true,
      fileMustExist: true
    });
    try {
      assert.equal(
        planningCopy.prepare("SELECT COUNT(*) AS count FROM one_off_transactions").get().count,
        1
      );
    } finally {
      planningCopy.close();
    }

    const ledgerCopy = new Database(path.join(result.snapshotPath, "household", "ledger_2026.sqlite"), {
      readonly: true,
      fileMustExist: true
    });
    try {
      assert.equal(
        ledgerCopy.prepare("SELECT COUNT(*) AS count FROM confirmed_transactions").get().count,
        1
      );
    } finally {
      ledgerCopy.close();
    }
  });
});

test("SQLite migration snapshot cleans temporary output when a database copy fails", async () => {
  await withTempDirs(async ({ dataDir, outputDir }) => {
    const budgetDir = path.join(dataDir, "broken-budget");
    fs.mkdirSync(budgetDir, { recursive: true });
    fs.writeFileSync(path.join(budgetDir, "planning.sqlite"), "not sqlite", "utf8");

    assert.throws(
      () => createSqliteMigrationSnapshot({ dataDir, outputDir }),
      /file is not a database|not a database|database disk image is malformed|file is not a database/i
    );

    assert.equal(fs.existsSync(outputDir), true);
    assert.deepEqual(fs.readdirSync(outputDir), []);
  });
});

test("SQLite migration snapshot rejects output directories inside DATA_DIR", async () => {
  await withTempDirs(async ({ dataDir }) => {
    createSnapshotSource(dataDir);

    assert.throws(
      () => createSqliteMigrationSnapshot({
        dataDir,
        outputDir: path.join(dataDir, "snapshots")
      }),
      /must not be inside DATA_DIR/
    );
  });
});
