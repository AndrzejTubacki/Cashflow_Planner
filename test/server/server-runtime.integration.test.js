import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(baseUrl, child, output, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health check passed: ${child.exitCode}\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`, { cache: "no-store" });
      const body = await response.json();
      if (response.ok && body?.ok === true) return;
    } catch {
      // Keep polling while the child process starts.
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for test server health\n${output()}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => {
    child.once("exit", resolve);
    setTimeout(resolve, 2000);
  });
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("timed out waiting for child process exit"));
    }, timeoutMs);
    function onExit(code, signal) {
      clearTimeout(timer);
      resolve({ code, signal });
    }
    child.once("exit", onExit);
  });
}

test("server runtime rate-limits internal authentication attempts", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-runtime-test-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(runtimeRoot, "data"),
      LOGS_DIR: path.join(runtimeRoot, "logs")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => {
    output += chunk.toString();
  });
  child.stderr.on("data", chunk => {
    output += chunk.toString();
  });

  try {
    await waitForHealth(baseUrl, child, () => output);
    const statuses = [];
    for (let index = 0; index < 21; index += 1) {
      const response = await fetch(`${baseUrl}/api/auth/internal/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "rate-limit@example.com",
          password: "not the password"
        })
      });
      statuses.push(response.status);
      await response.text();
    }

    assert.equal(statuses.slice(0, 20).every(status => status !== 429), true);
    assert.equal(statuses[20], 429);
  } finally {
    await stopServer(child);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("server exposes readiness checks and optional stdout log mirroring", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-runtime-test-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(runtimeRoot, "data"),
      LOGS_DIR: path.join(runtimeRoot, "logs"),
      CASHFLOW_MIRROR_LOGS_TO_STDOUT: "1",
      CASHFLOW_READYZ_CHECK_DEFAULT_BUDGET: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => {
    output += chunk.toString();
  });
  child.stderr.on("data", chunk => {
    output += chunk.toString();
  });

  try {
    await waitForHealth(baseUrl, child, () => output);
    const response = await fetch(`${baseUrl}/readyz`, { cache: "no-store" });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.checks.map(check => check.name),
      ["app_initialized", "data_dir_exists", "data_dir_writable", "global_metadata"]
    );
    assert.equal(
      body.checks.find(check => check.name === "global_metadata").details.defaultBudgetChecked,
      true
    );

    child.kill("SIGTERM");
    const exit = await waitForExit(child);
    assert.deepEqual(exit, { code: 0, signal: null });

    const log = await readFile(path.join(runtimeRoot, "logs", "server-events.log"), "utf8");
    assert.match(log, /server_start/);
    assert.match(output, /"kind":"server_start"/);
  } finally {
    await stopServer(child);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("server handles SIGTERM by closing listener and background interval", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-runtime-test-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(runtimeRoot, "data"),
      LOGS_DIR: path.join(runtimeRoot, "logs")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", chunk => {
    output += chunk.toString();
  });
  child.stderr.on("data", chunk => {
    output += chunk.toString();
  });

  try {
    await waitForHealth(baseUrl, child, () => output);
    child.kill("SIGTERM");
    const exit = await waitForExit(child);
    assert.deepEqual(exit, { code: 0, signal: null });

    const log = await readFile(path.join(runtimeRoot, "logs", "server-events.log"), "utf8");
    assert.match(log, /server_shutdown_requested/);
    assert.match(log, /server_shutdown_complete/);
  } finally {
    await stopServer(child);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
