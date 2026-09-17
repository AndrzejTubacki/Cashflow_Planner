import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { auditSqliteStorage } from "../../scripts/storage-migration-audit.mjs";
import { initializeGlobalSchema } from "../../src/server/cashflow-global-schema.js";
import {
  initializeLedgerSchema,
  initializePlanningSchema
} from "../../src/server/cashflow-schema.js";

async function withTempStorage(fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cashflow-storage-audit-test-"));
  try {
    return await fn(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function createAuditedStorage(dataDir) {
  const budgetDir = path.join(dataDir, "household");
  fs.mkdirSync(budgetDir, { recursive: true });

  const planning = new Database(path.join(budgetDir, "planning.sqlite"));
  try {
    initializePlanningSchema(planning);
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
        'tx-secret-id', 'Private row value', 'PLN', 10, 'income',
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

test("SQLite storage migration audit reports counts without row values or identifiers by default", async () => {
  await withTempStorage(async dataDir => {
    createAuditedStorage(dataDir);

    const report = auditSqliteStorage({
      dataDir,
      now: new Date("2026-01-03T04:05:06Z")
    });
    const json = JSON.stringify(report);

    assert.equal(report.format, "cashflow-sqlite-storage-audit");
    assert.equal(report.backend, "sqlite");
    assert.equal(report.global.exists, true);
    assert.equal(report.global.tables.accounts, 1);
    assert.equal(report.totals.budgets, 1);
    assert.equal(report.totals.planningDbs, 1);
    assert.equal(report.totals.ledgerDbs, 1);
    assert.equal(report.totals.confirmedRows, 1);
    assert.equal(report.budgets[0].label, "budget_1");
    assert.equal(report.budgets[0].planning.tables.settings, 1);
    assert.equal(report.budgets[0].ledgers[0].confirmedRows, 1);
    assert.equal(Object.hasOwn(report.budgets[0], "storageKey"), false);
    assert.equal(Object.hasOwn(report.budgets[0], "path"), false);

    assert.doesNotMatch(json, /household/);
    assert.doesNotMatch(json, /Private row value/);
    assert.doesNotMatch(json, /tx-secret-id/);
    assert.doesNotMatch(json, /private-occurrence-key/);
  });
});

test("SQLite storage migration audit can opt in to storage identifiers", async () => {
  await withTempStorage(async dataDir => {
    createAuditedStorage(dataDir);

    const report = auditSqliteStorage({
      dataDir,
      includeIdentifiers: true
    });

    assert.equal(report.budgets[0].storageKey, "household");
    assert.equal(report.budgets[0].path, path.join(dataDir, "household"));
  });
});
