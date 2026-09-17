import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";

async function withTempDataDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "cashflow-db-service-test-"));

  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildService(dataDir, overrides = {}) {
  const { ledgerDbPath, planningDbPath, userDataDir } = createCashflowStoragePaths(dataDir);
  return createCashflowDbService({
    ledgerDbPath,
    planningDbPath,
    userDataDir,
    ...overrides
  });
}

test("openPlanningDb and openLedgerDb work normally when isPostgresBackend is not provided", () => withTempDataDir(async dataDir => {
  const { openLedgerDb, openPlanningDb } = buildService(dataDir);

  const planningDb = openPlanningDb("local");
  try {
    assert.ok(planningDb.prepare("SELECT * FROM settings WHERE id = 1").get());
  } finally {
    planningDb.close();
  }

  const ledgerDb = openLedgerDb("local", "2026");
  try {
    assert.equal(ledgerDb.prepare("SELECT COUNT(*) AS count FROM confirmed_transactions").get().count, 0);
  } finally {
    ledgerDb.close();
  }
}));

test("openPlanningDb refuses to run and logs when isPostgresBackend reports postgres", () => withTempDataDir(async dataDir => {
  const loggedErrors = [];
  const { openPlanningDb } = buildService(dataDir, {
    isPostgresBackend: () => true,
    logError: (event, details) => loggedErrors.push({ event, details })
  });

  assert.throws(
    () => openPlanningDb("local"),
    /CASHFLOW_DB_BACKEND=postgres/
  );

  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0].event, "cashflow_sqlite_opener_used_under_postgres_backend");
  assert.equal(loggedErrors[0].details.kind, "planning");
  assert.equal(loggedErrors[0].details.userId, "local");
  assert.equal(typeof loggedErrors[0].details.stack, "string");
  assert.match(loggedErrors[0].details.stack, /openPlanningDb/);
}));

test("openLedgerDb refuses to run and logs when isPostgresBackend reports postgres", () => withTempDataDir(async dataDir => {
  const loggedErrors = [];
  const { openLedgerDb } = buildService(dataDir, {
    isPostgresBackend: () => true,
    logError: (event, details) => loggedErrors.push({ event, details })
  });

  assert.throws(
    () => openLedgerDb("local", "2026"),
    /CASHFLOW_DB_BACKEND=postgres/
  );

  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedErrors[0].event, "cashflow_sqlite_opener_used_under_postgres_backend");
  assert.equal(loggedErrors[0].details.kind, "ledger");
  assert.equal(loggedErrors[0].details.userId, "local");
  assert.equal(loggedErrors[0].details.year, "2026");
}));

test("isPostgresBackend can flip at runtime, matching how cashflow.js resolves the backend after construction", () => withTempDataDir(async dataDir => {
  let backend = "sqlite";
  const { openPlanningDb } = buildService(dataDir, {
    isPostgresBackend: () => backend === "postgres"
  });

  const db = openPlanningDb("local");
  db.close();

  backend = "postgres";
  assert.throws(() => openPlanningDb("local"), /CASHFLOW_DB_BACKEND=postgres/);
}));
