import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("Standalone Postgres scripts reject --database-url CLI argument", () => {
  const exportScript = path.resolve("scripts/export-postgres-storage.mjs");

  const result = spawnSync("node", [exportScript, "--database-url", "postgres://test"], { encoding: "utf8" });
  assert.match(result.stderr, /Unknown argument: --database-url/);
});
