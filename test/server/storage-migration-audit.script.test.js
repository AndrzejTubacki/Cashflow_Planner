import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("storage-migration-audit executes as main even when invoked via symlink", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "cashflow-symlink-test-"));
  try {
    const scriptPath = path.resolve("scripts/storage-migration-audit.mjs");
    const symlinkPath = path.join(tempDir, "audit.mjs");
    fs.symlinkSync(scriptPath, symlinkPath);

    const output = execFileSync("node", [symlinkPath, "--help"], { encoding: "utf8" });
    assert.match(output, /Reads existing SQLite storage and prints a migration-readiness inventory/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
