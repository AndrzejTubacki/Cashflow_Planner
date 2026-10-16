import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";

// Run the actual CLI against its own empty, temporary instance, not a harness
// that pre-creates a user and would conceal the original missing-local bug.
test("standalone smoke bootstraps an isolated account and authenticates its snapshot request", { timeout: 60000 }, async () => {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ["scripts/smoke.mjs"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, CASHFLOW_BASE_URL: "", SMOKE_PORT: String(port),
      CASHFLOW_DB_BACKEND: "postgres", CASHFLOW_DATABASE_URL: "postgres://invalid.invalid/not_used" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, output);
  assert.match(output, /Smoke OK:/);
  assert.doesNotMatch(output, /User not found|Unauthorized/);
});