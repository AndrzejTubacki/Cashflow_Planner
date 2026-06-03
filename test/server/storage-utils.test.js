import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs";
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

test("storage paths accept valid user ids and do not create when create is false", () => withTempDataDir(async dataDir => {
  const paths = createCashflowStoragePaths(dataDir);
  const userId = "User_123-test";

  assert.equal(paths.planningDbPath(userId, { create: false }), path.join(dataDir, userId, "planning.sqlite"));
  assert.equal(fs.existsSync(path.join(dataDir, userId)), false);
}));

test("storage paths reject invalid user ids before filesystem access", () => withTempDataDir(async dataDir => {
  const paths = createCashflowStoragePaths(dataDir);
  const invalidIds = ["../x", "/absolute", "", "_reserved", "a".repeat(65), "has/slash", "has\\slash"];

  for (const userId of invalidIds) {
    assert.throws(() => paths.planningDbPath(userId), /User ID must use/);
  }

  assert.equal(fs.readdirSync(dataDir).length, 0);
}));

test("storage user listing includes ledger-only profiles without creating planning databases", () => withTempDataDir(async dataDir => {
  const paths = createCashflowStoragePaths(dataDir);
  const userId = "confirmed_only";
  fs.mkdirSync(path.join(dataDir, userId), { recursive: true });
  fs.writeFileSync(path.join(dataDir, userId, "ledger_2026.sqlite"), "");

  assert.equal(paths.cashflowUserStorageExists(userId), true);
  assert.deepEqual(paths.listCashflowUserIds(), [userId]);
  assert.equal(fs.existsSync(path.join(dataDir, userId, "planning.sqlite")), false);
}));
