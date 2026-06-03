import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { chromium } from "playwright";

const startedChildren = [];
const SYSTEM_CHROME_CANDIDATES = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);

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

async function completeSetupIfNeeded(page) {
  if (await page.locator("[data-cashflow-setup]").isVisible().catch(() => false)) {
    await page.locator('input[name="income_amount"]').fill("1000");
    await page.locator("[data-cashflow-setup-form] button[type='submit']").click();
    await page.waitForSelector("[data-cashflow-page]", { state: "visible" });
  }
}

async function openOneOffFutureSection(page) {
  await page.locator("[data-cashflow-oneoff-tab] details").evaluateAll(detailsList => {
    for (const details of detailsList) {
      details.open = true;
    }
  });
}

async function waitForOneOffRow(page, text) {
  const row = page.locator('[data-cashflow-oneoff-tab] tr[data-tx-type="one-off"]', { hasText: text });
  await row.waitFor({ state: "attached" });
  await openOneOffFutureSection(page);
  await row.waitFor({ state: "visible" });
  return row;
}

async function assertModalUsesSelectedUser(page) {
  const smokeUserId = `browser_smoke_${Date.now()}`;

  await page.locator("[data-cashflow-logout]").click();
  await page.waitForSelector("[data-cashflow-user-selection]", { state: "visible" });
  await page.locator('input[name="userId"]').fill(smokeUserId);
  await page.locator('input[name="displayName"]').fill("Browser Smoke");
  await page.locator("[data-cashflow-create-user-form] button[type='submit']").click();
  await page.waitForSelector("[data-cashflow-page], [data-cashflow-setup]", { state: "visible" });
  await completeSetupIfNeeded(page);

  await page.locator('[data-cashflow-tab="oneoff"]').click();
  await page.locator("[data-cashflow-add-oneoff]").click();
  await page.locator("[data-cashflow-modal-form] input[name='name']").fill("Smoke modal one-off");
  await page.locator("[data-cashflow-modal-form] input[name='amount']").fill("42");
  await page.locator("[data-cashflow-modal-form] input[name='date']").fill("2099-01-15");
  await page.locator("[data-cashflow-modal-form] button[type='submit']").click();
  await page.locator("[data-cashflow-modal-root]").waitFor({ state: "detached" });
  await waitForOneOffRow(page, "Smoke modal one-off");

  await page.locator('[data-cashflow-oneoff-tab] tr[data-tx-type="one-off"]', { hasText: "Smoke modal one-off" }).locator("[data-edit-tx]").click();
  await page.locator("[data-cashflow-modal-form] input[name='name']").fill("Smoke edited one-off");
  await page.locator("[data-cashflow-modal-form] button[type='submit']").click();
  await page.locator("[data-cashflow-modal-root]").waitFor({ state: "detached" });
  await waitForOneOffRow(page, "Smoke edited one-off");

  await page.locator("[data-cashflow-logout]").click();
  await page.waitForSelector("[data-cashflow-user-selection]", { state: "visible" });
  await page.locator('[data-cashflow-select-user="local"]').click();
  await page.waitForSelector("[data-cashflow-page], [data-cashflow-setup]", { state: "visible" });
  await completeSetupIfNeeded(page);
  await page.locator('[data-cashflow-tab="oneoff"]').click();
  await assert.doesNotMatch(await page.locator("[data-cashflow-oneoff-tab]").textContent(), /Smoke edited one-off/);
}

async function assertActionErrorsStayInApp(page) {
  await page.route("**/api/run-jobs", route => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: "Smoke action failure" })
  }));

  await page.locator("[data-cashflow-run-jobs]").click();
  const banner = page.locator("[data-cashflow-error-banner]");
  await banner.waitFor({ state: "visible" });
  await assert.match(await banner.textContent(), /Smoke action failure/);
  await page.locator("[data-cashflow-page]").waitFor({ state: "visible" });
  await banner.locator("[data-cashflow-dismiss-error]").click();
  await banner.waitFor({ state: "detached" });
  await page.unroute("**/api/run-jobs");
}

async function assertInvalidRememberedUserReturnsToSelection(page) {
  await page.evaluate(() => {
    localStorage.setItem("cashflow_user_id", "missing-remembered-user");
  });
  await page.route("**/api/session", route => route.fulfill({
    status: 404,
    contentType: "application/json",
    body: JSON.stringify({ error: "User not found" })
  }));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-cashflow-user-selection]").waitFor({ state: "visible" });
  await assert.match(await page.locator("[data-cashflow-user-selection]").textContent(), /Selected user is no longer available/);
  assert.equal(await page.evaluate(() => localStorage.getItem("cashflow_user_id")), null);
  await page.unroute("**/api/session");
}

async function runBrowserSmoke(baseUrl) {
  const executablePath = SYSTEM_CHROME_CANDIDATES.find(candidate => existsSync(candidate));
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    if (await page.locator("[data-cashflow-user-selection]").isVisible().catch(() => false)) {
      await page.locator('[data-cashflow-select-user="local"]').click();
      await page.waitForSelector("[data-cashflow-page], [data-cashflow-setup]", { state: "visible" });
    }

    await completeSetupIfNeeded(page);

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
    await assertActionErrorsStayInApp(page);
    await assertModalUsesSelectedUser(page);
    await assertInvalidRememberedUserReturnsToSelection(page);
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
