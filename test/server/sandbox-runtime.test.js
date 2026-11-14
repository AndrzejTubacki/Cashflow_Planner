import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { sandboxEnvironment, sandboxRoot } from "../../scripts/lib/sandbox-runtime.mjs";

test("Sandbox launch configuration overrides inherited deployment paths and database settings", () => {
  const env = sandboxEnvironment({ PORT: "3000", DATA_DIR: "/unsafe/data", LOGS_DIR: "/unsafe/logs",
    CASHFLOW_DB_BACKEND: "postgres", CASHFLOW_DATABASE_URL: "postgres://unsafe",
    CASHFLOW_RUNTIME_LOCK_DATABASE_URL: "postgres://unsafe", CASHFLOW_RUNTIME_LOCK_BACKEND: "postgres" });
  assert.equal(env.PORT, "3301");
  assert.equal(env.CASHFLOW_BIND_HOST, "127.0.0.1");
  assert.equal(env.DATA_DIR, path.join(sandboxRoot, ".sandbox-runtime/data"));
  assert.equal(env.LOGS_DIR, path.join(sandboxRoot, ".sandbox-runtime/logs"));
  assert.equal(env.CASHFLOW_DB_BACKEND, "sqlite");
  assert.equal(env.CASHFLOW_DATABASE_URL, "");
  assert.equal(env.CASHFLOW_RUNTIME_LOCK_DATABASE_URL, "");
  assert.equal(env.CASHFLOW_RUNTIME_LOCK_BACKEND, "none");
  assert.equal(sandboxEnvironment({ CASHFLOW_SANDBOX_PORT: "3401" }).PORT, "3401");
  for (const port of ["0", "80", "3301junk", "65536", "-1"]) {
    assert.throws(() => sandboxEnvironment({ CASHFLOW_SANDBOX_PORT: port }));
  }
});

test("fresh SQLite smoke creates a real account and completes setup without an implicit local user", async () => {
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
  const runtime = await mkdtemp(path.join(tmpdir(), "cashflow-sandbox-smoke-test-"));
  try {
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/smoke.mjs"], {
        cwd: sandboxRoot, env: { ...process.env, CASHFLOW_BASE_URL: "", SMOKE_PORT: String(port),
          CASHFLOW_DB_BACKEND: "postgres", CASHFLOW_DATABASE_URL: "postgres://unreachable",
          DATA_DIR: runtime, LOGS_DIR: runtime }, stdio: ["ignore", "pipe", "pipe"]
      });
      let text = "";
      child.stdout.on("data", chunk => { text += chunk; });
      child.stderr.on("data", chunk => { text += chunk; });
      const timer = setTimeout(() => child.kill(), 30000);
      child.on("error", reject);
      child.on("close", code => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(text)); else resolve(text);
      });
    });
    assert.match(output, /Smoke OK:/);
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
});