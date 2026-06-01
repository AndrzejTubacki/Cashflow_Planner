import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";

async function withTempDataDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "cashflow-storage-test-"));

  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("cashflow storage paths keep databases directly under the user data directory", () => withTempDataDir(async dataDir => {
  const paths = createCashflowStoragePaths(dataDir);

  assert.equal(paths.planningDbPath("local"), path.join(dataDir, "local", "planning.sqlite"));
  assert.equal(paths.ledgerDbPath("local", "2026"), path.join(dataDir, "local", "ledger_2026.sqlite"));
}));

test("default backup directory lives under the user data directory", () => withTempDataDir(async dataDir => {
  const paths = createCashflowStoragePaths(dataDir);

  assert.equal(paths.backupDir("local"), path.join(dataDir, "local", "backups"));
}));
