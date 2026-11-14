import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { spawn } from "child_process";

import { SUPPORTED_FX_CURRENCIES } from "../src/server/cashflow-fx-provider-utils.js";

const startedChildren = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${body.slice(0, 200)}`);
  }

  return JSON.parse(body);
}

async function postJson(url, payload = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${body.slice(0, 200)}`);
  }

  return JSON.parse(body);
}

async function waitForHealth(baseUrl, timeoutMs = Number(process.env.SMOKE_START_TIMEOUT_MS || 180000)) {
  // Windows/network-mounted workspaces can take a long time to import server dependencies cold.
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const failedChild = startedChildren.find(item => item.exited);
    if (failedChild) {
      throw new Error(`Server exited before health check passed: ${failedChild.exitCode ?? failedChild.signal}\n${failedChild.output()}`);
    }

    try {
      const health = await requestJson(`${baseUrl}/healthz`);
      if (health?.ok === true) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }

    await sleep(500);
  }

  const output = startedChildren.map(item => item.output()).filter(Boolean).join("\n");
  throw new Error(`Timed out waiting for ${baseUrl}/healthz${output ? `\nServer output:\n${output}` : ""}`);
}

async function startServer() {
  const port = process.env.SMOKE_PORT || "3199";
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-smoke-"));
  const dataDir = path.join(runtimeRoot, "data");
  const logsDir = path.join(runtimeRoot, "logs");
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: port,
      CASHFLOW_BIND_HOST: "127.0.0.1",
      CASHFLOW_DB_BACKEND: "sqlite",
      CASHFLOW_DATABASE_URL: "",
      CASHFLOW_RUNTIME_LOCK_BACKEND: "none",
      CASHFLOW_RUNTIME_LOCK_DATABASE_URL: "",
      DATA_DIR: dataDir,
      LOGS_DIR: logsDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", chunk => {
    output += chunk.toString();
  });
  child.stderr.on("data", chunk => {
    output += chunk.toString();
  });

  const tracked = { child, runtimeRoot, output: () => output, exited: false, exitCode: null, signal: null };
  child.on("exit", (exitCode, signal) => {
    tracked.exited = true;
    tracked.exitCode = exitCode;
    tracked.signal = signal;
  });

  startedChildren.push(tracked);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    child
  };
}

async function stopChildren() {
  for (const item of startedChildren.reverse()) {
    if (!item.child.killed) {
      item.child.kill();
    }

    await new Promise(resolve => {
      item.child.once("exit", resolve);
      setTimeout(resolve, 2000);
    });

    await rm(item.runtimeRoot, { recursive: true, force: true });
  }
}

async function main() {
  const deployed = Boolean(process.env.CASHFLOW_BASE_URL);
  let baseUrl = process.env.CASHFLOW_BASE_URL || "";
  let userId = "cashflow-smoke";
  let sessionHeaders = {};

  if (!baseUrl) {
    const started = await startServer();
    baseUrl = started.baseUrl;
  } else {
    userId = String(process.env.CASHFLOW_SMOKE_USER_ID || "").trim();
    if (!userId) throw new Error("CASHFLOW_SMOKE_USER_ID is required for deployed smoke");
    if (userId === "local") throw new Error("Deployed smoke refuses CASHFLOW_SMOKE_USER_ID=local");
  }

  await waitForHealth(baseUrl);

  const system = await requestJson(`${baseUrl}/api/system`);
  if (system?.app !== "cashflow") {
    throw new Error("Unexpected /api/system payload");
  }

  if (!deployed) {
    // Fresh installations have no implicit local user. Exercise supported setup
    // inside the temporary runtime, using the returned session and CSRF token.
    const created = await fetch(`${baseUrl}/api/users`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, displayName: "Disposable smoke account" })
    });
    const account = await created.json();
    if (!created.ok) throw new Error(`Account creation failed: ${JSON.stringify(account)}`);
    const cookie = created.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    sessionHeaders = { cookie, "x-cashflow-csrf-token": account.csrfToken };
    const setup = await fetch(`${baseUrl}/api/setup`, {
      method: "POST", headers: { ...sessionHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ currency: "PLN", opening_balance: 1000,
        income_enabled: false, future_periods: 3, timezone: "Europe/Warsaw",
        holiday_country: "PL", locale: "en" })
    });
    const result = await setup.json();
    if (!setup.ok || !result.setup?.ok) throw new Error(`Budget setup failed: ${JSON.stringify(result)}`);
  } else {
    const session = await requestJson(`${baseUrl}/api/session`, {
      headers: {
        "x-cashflow-user-id": userId
      }
    });
    if (!session?.session?.authenticated || session.session.userId !== userId) {
      throw new Error("Unexpected deployed /api/session payload");
    }
  }

  const response = await fetch(`${baseUrl}/api`, {
    cache: "no-store",
    headers: {
      ...sessionHeaders,
      "x-cashflow-user-id": userId
    }
  });
  const cashflow = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${baseUrl}/api returned ${response.status}: ${JSON.stringify(cashflow).slice(0, 200)}`);
  }
  if (!SUPPORTED_FX_CURRENCIES.includes(cashflow?.settings?.ledger_currency)) {
    throw new Error("Unexpected /api settings payload");
  }

  console.log(`Smoke OK: ${baseUrl}`);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(stopChildren);
