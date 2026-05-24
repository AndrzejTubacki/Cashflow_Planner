import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { spawn } from "child_process";

const startedChildren = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${body.slice(0, 200)}`);
  }

  return JSON.parse(body);
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
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

  throw new Error(`Timed out waiting for ${baseUrl}/healthz`);
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

  startedChildren.push({ child, runtimeRoot, output: () => output });
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
  let baseUrl = process.env.CASHFLOW_BASE_URL || "";

  if (!baseUrl) {
    const started = await startServer();
    baseUrl = started.baseUrl;
  }

  await waitForHealth(baseUrl);

  const system = await requestJson(`${baseUrl}/api/system`);
  if (system?.app !== "cashflow") {
    throw new Error("Unexpected /api/system payload");
  }

  const cashflow = await requestJson(`${baseUrl}/api`);
  if (cashflow?.settings?.ledger_currency !== "PLN") {
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
