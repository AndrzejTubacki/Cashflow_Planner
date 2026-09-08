import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { chromium } from "playwright";

const startedChildren = [];
const SCREENSHOT_DIR = path.resolve(import.meta.dirname, "..", "docs", "screenshots");
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

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${url} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function waitForHealth(baseUrl, timeoutMs = Number(process.env.SCREENSHOT_START_TIMEOUT_MS || 180000)) {
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
      // Keep polling while the screenshot server starts.
    }

    await sleep(500);
  }

  const output = startedChildren.map(item => item.output()).filter(Boolean).join("\n");
  throw new Error(`Timed out waiting for ${baseUrl}/healthz${output ? `\nServer output:\n${output}` : ""}`);
}

async function startServer() {
  const port = process.env.SCREENSHOT_PORT || "3298";
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-readme-screenshots-"));
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: port,
      DATA_DIR: path.join(runtimeRoot, "data"),
      LOGS_DIR: path.join(runtimeRoot, "logs")
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
  return `http://127.0.0.1:${port}`;
}

async function stopChildren() {
  for (const item of startedChildren.reverse()) {
    if (!item.child.killed) item.child.kill();
    await new Promise(resolve => {
      item.child.once("exit", resolve);
      setTimeout(resolve, 2000);
    });
    await rm(item.runtimeRoot, { recursive: true, force: true });
  }
}

async function launchBrowser() {
  const executablePath = SYSTEM_CHROME_CANDIDATES.find(candidate => existsSync(candidate));
  return chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true
  });
}

async function waitForApiResponse(page, method, pathname, action) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const responsePromise = page.waitForResponse(response => {
    try {
      return response.request().method() === normalizedMethod
        && new URL(response.url()).pathname === pathname;
    } catch {
      return false;
    }
  });
  await action();
  const response = await responsePromise;
  if (!response.ok()) {
    const text = await response.text().catch(() => "");
    throw new Error(`${normalizedMethod} ${pathname} returned ${response.status()}: ${text.slice(0, 500)}`);
  }
  return response;
}

async function selectTab(page, tabId, selector) {
  await page.locator(`[data-cashflow-tab="${tabId}"]`).click();
  await page.locator(selector).waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function createDemoBudget(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("[data-cashflow-user-selection]").waitFor({ state: "visible" });
  await page.locator('input[name="userId"]').fill("readme-demo");
  await page.locator('input[name="displayName"]').fill("README Demo");
  await waitForApiResponse(page, "POST", "/api/accounts", () =>
    page.locator("[data-cashflow-create-user-form] button[type='submit']").click()
  );

  await page.locator("[data-cashflow-budget-selection]").waitFor({ state: "visible" });
  await waitForApiResponse(page, "POST", "/api/budgets/readme-demo/select", () =>
    page.locator('[data-cashflow-select-budget="readme-demo"]').click()
  );

  await page.locator("[data-cashflow-setup]").waitFor({ state: "visible" });
  await page.locator('input[name="opening_balance"]').fill("2500");
  await page.locator('input[name="income_name"]').fill("Salary");
  await page.locator('input[name="income_amount"]').fill("7500");
  await waitForApiResponse(page, "POST", "/api/setup", () =>
    page.locator("[data-cashflow-setup-form] button[type='submit']").click()
  );
  await page.locator("[data-cashflow-page]").waitFor({ state: "visible" });

  await selectTab(page, "settings", "[data-cashflow-settings-tab]");
  await page.locator("[data-cashflow-settings-tab] details").evaluateAll(detailsList => {
    detailsList.forEach(details => {
      details.open = true;
    });
  });
  page.once("dialog", dialog => dialog.accept());
  await waitForApiResponse(page, "POST", "/api/import/sample", () =>
    page.locator("[data-cashflow-load-sample]").click()
  );
  await page.locator("[data-cashflow-page]").waitFor({ state: "visible" });
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function installScreenshotBackdrop(page) {
  await page.addStyleTag({
    content: `
      html,
      body,
      #app {
        background: #0f172a !important;
      }

      [data-cashflow-page] {
        background:
          linear-gradient(180deg, #172638 0%, #101827 45%, #0b1120 100%) !important;
        padding-bottom: 16px !important;
      }
    `
  });
}

async function screenshotPage(page, filename) {
  const target = page.locator("[data-cashflow-page]");
  await target.waitFor({ state: "visible" });
  await target.screenshot({
    animations: "disabled",
    path: path.join(SCREENSHOT_DIR, filename)
  });
}

async function main() {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const baseUrl = await startServer();
  await waitForHealth(baseUrl);

  const browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: {
      width: 1440,
      height: 1000
    }
  });

  try {
    await createDemoBudget(page, baseUrl);
    await installScreenshotBackdrop(page);

    await selectTab(page, "ledger", "[data-cashflow-ledger-tab]");
    await screenshotPage(page, "ledger-overview.png");

    await selectTab(page, "budgets", "[data-cashflow-budget-manager]");
    await screenshotPage(page, "budget-manager.png");

    await selectTab(page, "settings", "[data-cashflow-settings-tab]");
    await page.locator("[data-cashflow-settings-tab] details").evaluateAll(detailsList => {
      detailsList.forEach(details => {
        details.open = true;
      });
    });
    await screenshotPage(page, "settings-portability.png");

    assert.equal(existsSync(path.join(SCREENSHOT_DIR, "ledger-overview.png")), true);
    assert.equal(existsSync(path.join(SCREENSHOT_DIR, "budget-manager.png")), true);
    assert.equal(existsSync(path.join(SCREENSHOT_DIR, "settings-portability.png")), true);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log(`README screenshots written to ${SCREENSHOT_DIR}`);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(stopChildren);
