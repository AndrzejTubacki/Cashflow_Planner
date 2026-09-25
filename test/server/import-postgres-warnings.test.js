import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("Standalone Postgres import scripts warn against partial applies", () => {
  const globalScript = path.resolve("scripts/import-global-metadata-to-postgres.mjs");
  const budgetScript = path.resolve("scripts/import-budget-storage-to-postgres.mjs");

  const globalResult = spawnSync("node", [globalScript, "--apply", "--input", "package.json"], { encoding: "utf8" });
  assert.match(globalResult.stderr, /WARNING: You are running a standalone migration script with --apply/);
  assert.match(globalResult.stderr, /migrate only the global metadata/);

  const budgetResult = spawnSync("node", [budgetScript, "--apply", "--input", "package.json"], { encoding: "utf8" });
  assert.match(budgetResult.stderr, /WARNING: You are running a standalone migration script with --apply/);
  assert.match(budgetResult.stderr, /migrate only the budget data/);
});
