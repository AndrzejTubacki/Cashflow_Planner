import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Private developer tests live in the gitignored dev/tests folder. When it exists
// in this checkout, run all of them as one check; otherwise skip.
const devTests = path.resolve(import.meta.dirname, "../dev/tests");

test("developer tests in dev/tests pass", { skip: fs.existsSync(devTests) ? false : "dev/tests is not present in this checkout" }, () => {
  const files = fs.readdirSync(devTests).filter(name => name.endsWith(".test.js") || name.endsWith(".test.mjs"))
    .map(name => path.join(devTests, name));
  assert.ok(files.length > 0, "dev/tests contains no test files");
  // A nested node --test inherits NODE_TEST_CONTEXT and would then report to this
  // runner instead of failing with its own exit code; run it as a standalone run.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = spawnSync(process.execPath, ["--test", ...files], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
