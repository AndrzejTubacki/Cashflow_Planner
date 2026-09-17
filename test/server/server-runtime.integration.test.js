import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createPostgresBudgetDbService } from "../../src/server/cashflow-postgres-budget-db-service.js";
import { createPostgresGlobalDbService } from "../../src/server/cashflow-postgres-global-db-service.js";
import {
  postgresRuntimeTestsEnabled,
  withDisposablePostgresDb
} from "../helpers/postgres-test-db.js";

const POSTGRES_TEST_SKIP_REASON = "set CASHFLOW_ENABLE_POSTGRES_TESTS=1 and CASHFLOW_DATABASE_URL to run disposable Postgres tests";

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
    const system = await (await fetch(`${baseUrl}/api/system`, { cache: "no-store" })).json();
    assert.equal(system.databaseBackend, "sqlite");

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

test("server refuses an unrecognized external database backend before listening", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-runtime-test-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const secretUrl = "oracle://cashflow:do-not-print@example.invalid/cashflow";
  let output = "";
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: path.join(runtimeRoot, "data"),
      LOGS_DIR: path.join(runtimeRoot, "logs"),
      CASHFLOW_DB_BACKEND: "oracle",
      CASHFLOW_DATABASE_URL: secretUrl
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
    const exit = await waitForExit(child);
    assert.notEqual(exit.code, 0);
    assert.match(output, /Unsupported CASHFLOW_DB_BACKEND "oracle"/);
    assert.doesNotMatch(output, /do-not-print/);
    assert.doesNotMatch(output, /example\.invalid/);

    await assert.rejects(
      () => fetch(`${baseUrl}/healthz`, { cache: "no-store" }),
      /fetch failed/
    );

    const errorLog = await readFile(path.join(runtimeRoot, "logs", "error.log"), "utf8");
    assert.match(errorLog, /cashflow_database_backend_unsupported/);
    assert.match(errorLog, /"backend":"oracle"/);
    assert.match(errorLog, /"databaseUrlConfigured":true/);
    assert.doesNotMatch(errorLog, /do-not-print/);
    assert.doesNotMatch(errorLog, /example\.invalid/);
  } finally {
    await stopServer(child);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("server refuses Postgres backend without a database URL before listening", async () => {
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
      CASHFLOW_DB_BACKEND: "postgres",
      CASHFLOW_DATABASE_URL: ""
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
    const exit = await waitForExit(child);
    assert.notEqual(exit.code, 0);
    assert.match(output, /CASHFLOW_DATABASE_URL/);

    await assert.rejects(
      () => fetch(`${baseUrl}/healthz`, { cache: "no-store" }),
      /fetch failed/
    );

    const errorLog = await readFile(path.join(runtimeRoot, "logs", "error.log"), "utf8");
    assert.match(errorLog, /cashflow_database_backend_unsupported/);
    assert.match(errorLog, /"backend":"postgres"/);
    assert.match(errorLog, /"databaseUrlConfigured":false/);
  } finally {
    await stopServer(child);
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("server starts and serves requests with a real Postgres backend against a disposable database", {
  skip: postgresRuntimeTestsEnabled() ? false : POSTGRES_TEST_SKIP_REASON
}, async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-runtime-test-"));

  await withDisposablePostgresDb(async ({ databaseUrl }) => {
    const globalDb = await createPostgresGlobalDbService({ databaseUrl });
    const budgetDb = await createPostgresBudgetDbService({ databaseUrl });
    await globalDb.initializeGlobalSchema();
    await budgetDb.initializeBudgetSchema();
    await globalDb.close();
    await budgetDb.close();

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
        CASHFLOW_DB_BACKEND: "postgres",
        CASHFLOW_DATABASE_URL: databaseUrl,
        CASHFLOW_RUNTIME_LOCK_BACKEND: "postgres"
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

      const system = await (await fetch(`${baseUrl}/api/system`, { cache: "no-store" })).json();
      assert.equal(system.databaseBackend, "postgres");

      const readyResponse = await fetch(`${baseUrl}/readyz`, { cache: "no-store" });
      const readyBody = await readyResponse.json();
      assert.equal(readyResponse.status, 200);
      assert.equal(readyBody.ok, true);

      const createResponse = await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "server_smoke_test_user",
          displayName: "Server Smoke Test User"
        })
      });
      const created = await createResponse.json();
      assert.equal(created.session.userId, "server_smoke_test_user");
      assert.equal(created.session.budgetRole, "owner");
      assert.equal(created.session.authenticated, true);

      const cookie = createResponse.headers.getSetCookie()[0].split(";")[0];

      // /api/setup with a real recurring income exercises the full
      // real-server path: completeSetupWithBudgetStore's async projection
      // regeneration (previously silently fell back to the sync SQLite
      // engine here, creating stray local files and leaving Postgres's
      // future_transactions/projection_snapshots empty) and the
      // future_transactions.period column (previously constrained to a
      // "YYYY-MM" shape that no real period value — always a full
      // YYYY-MM-DD anchor date — could ever satisfy).
      const setupResponse = await fetch(`${baseUrl}/api/setup`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cookie": cookie,
          "x-cashflow-csrf-token": created.csrfToken
        },
        body: JSON.stringify({
          currency: "PLN",
          opening_balance: 1000,
          income_enabled: true,
          income_name: "Salary",
          income_amount: 5000,
          income_anchor_day: 10,
          future_periods: 6,
          timezone: "Europe/Warsaw",
          holiday_country: "PL",
          locale: "en"
        })
      });
      const setupBody = await setupResponse.json();
      assert.equal(setupResponse.status, 200);
      assert.equal(setupBody.setup.ok, true);
      assert.equal(setupBody.setup._projection.projection_ok, true);

      const budgetDbAfterSetup = await createPostgresBudgetDbService({ databaseUrl });
      try {
        const futureRows = await budgetDbAfterSetup.withClient(async client => {
          const result = await client.query(
            "SELECT name, period FROM future_transactions WHERE budget_id = $1 ORDER BY date",
            ["server_smoke_test_user"]
          );
          return result.rows;
        });
        assert.ok(futureRows.length > 0, "expected real future_transactions rows in Postgres");
        assert.ok(
          futureRows.every(row => /^\d{4}-\d{2}-\d{2}$/.test(row.period)),
          "expected every period to be a full anchor date, not a truncated month label"
        );

        const dataDirEntries = fs.existsSync(path.join(runtimeRoot, "data"))
          ? fs.readdirSync(path.join(runtimeRoot, "data"), { recursive: true })
          : [];
        assert.deepEqual(dataDirEntries, [], "expected no local SQLite files for a Postgres-backed budget");
      } finally {
        await budgetDbAfterSetup.close();
      }
    } finally {
      await stopServer(child);
    }
  });

  await rm(runtimeRoot, { recursive: true, force: true });
});
