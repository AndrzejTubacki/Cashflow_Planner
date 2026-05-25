import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { chromium } from "playwright";

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

async function waitForHealth(baseUrl, timeoutMs = Number(process.env.BROWSER_SMOKE_START_TIMEOUT_MS || 180000)) {
  // Browser smoke may cold-start the app from slow network-mounted workspaces, so startup is configurable.
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const failedChild = startedChildren.find(item => item.exited);
    if (failedChild) {
      throw new Error(`Server exited before health check passed: ${failedChild.exitCode ?? failedChild.signal}\n${failedChild.output()}`);
    }

    try {
      const health = await requestJson(`${baseUrl}/healthz`);
      if (health?.ok === true) return;
    } catch {
      // Keep polling while the temporary smoke-test server starts.
    }

    await sleep(500);
  }

  const output = startedChildren.map(item => item.output()).filter(Boolean).join("\n");
  throw new Error(`Timed out waiting for ${baseUrl}/healthz${output ? `\nServer output:\n${output}` : ""}`);
}

async function startServer() {
  const port = process.env.BROWSER_SMOKE_PORT || "3299";
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-browser-smoke-"));
  const dataDir = path.join(runtimeRoot, "data");
  const logsDir = path.join(runtimeRoot, "logs");

  // The browser smoke test owns this temporary server and removes its runtime data after inspection.
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

  const tracked = { child, runtimeRoot, logsDir, output: () => output, exited: false, exitCode: null, signal: null };
  child.on("exit", (exitCode, signal) => {
    tracked.exited = true;
    tracked.exitCode = exitCode;
    tracked.signal = signal;
  });

  startedChildren.push(tracked);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    logsDir
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

async function assertNoTempServerErrors() {
  for (const item of startedChildren) {
    const errorLog = path.join(item.logsDir, "error.log");
    if (!existsSync(errorLog)) continue;

    const content = (await fs.readFile(errorLog, "utf8")).trim();
    if (content) {
      throw new Error(`Browser smoke server wrote errors:\n${content}`);
    }
  }
}

async function assertTab(page, tabId, selector, expectedText) {
  await page.locator(`[data-cashflow-tab="${tabId}"]`).click();
  const tab = page.locator(selector);
  await tab.waitFor({ state: "visible" });
  await assert.match(await tab.textContent(), expectedText);
}

async function runBrowserSmoke(baseUrl) {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("[data-cashflow-page]").waitFor({ state: "visible" });
    await assert.match(await page.locator("body").textContent(), /Cashflow/);

    await page.locator("[data-cashflow-validate]").click();
    await page.locator(".cashflow-validation").waitFor({ state: "visible" });
    await assert.match(await page.locator(".cashflow-validation").textContent(), /Validation/);

    await assertTab(page, "ledger", "[data-cashflow-ledger-tab]", /Pending[\s\S]*Confirmed[\s\S]*Future/);
    await assertTab(page, "recurring", "[data-cashflow-recurring-tab]", /Recurring expenses[\s\S]*Add expense/);
    await assertTab(page, "income", "[data-cashflow-income-tab]", /Recurring income[\s\S]*Add income/);
    await assertTab(page, "oneoff", "[data-cashflow-oneoff-tab]", /One-off[\s\S]*Add transaction/);
    await assertTab(page, "goals", "[data-cashflow-goals-tab]", /Goals[\s\S]*Add goal/);
    await assertTab(page, "flex", "[data-cashflow-flex-tab]", /Flex[\s\S]*Add flex/);
    await assertTab(page, "priority", "[data-cashflow-priority-tab]", /Operating priority[\s\S]*Goal priority/);
    await assertTab(page, "settings", "[data-cashflow-settings-tab]", /Settings[\s\S]*General[\s\S]*Currency & Exchange/);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  let baseUrl = process.env.CASHFLOW_BASE_URL || "";

  if (!baseUrl) {
    ({ baseUrl } = await startServer());
  }

  await waitForHealth(baseUrl);
  await runBrowserSmoke(baseUrl);
  await assertNoTempServerErrors();

  console.log(`Browser smoke OK: ${baseUrl}`);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(stopChildren);
