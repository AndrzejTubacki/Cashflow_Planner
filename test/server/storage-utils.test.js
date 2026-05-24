import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";

test("cashflow storage paths keep databases directly under the user data directory", () => {
  const paths = createCashflowStoragePaths("/data");

  assert.equal(paths.planningDbPath("local"), path.join("/data", "local", "planning.sqlite"));
  assert.equal(paths.ledgerDbPath("local", "2026"), path.join("/data", "local", "ledger_2026.sqlite"));
});

test("default backup directory lives under the user data directory", () => {
  const paths = createCashflowStoragePaths("/data");

  assert.equal(paths.backupDir("local"), path.join("/data", "local", "backups"));
});
