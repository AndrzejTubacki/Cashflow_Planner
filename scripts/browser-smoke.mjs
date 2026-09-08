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

function userHeaders(userId, headers = {}) {
  return {
    ...headers,
    "x-cashflow-user-id": userId
  };
}

function sessionHeaders(sessionAuth, method, headers = {}) {
  return {
    ...headers,
    cookie: sessionAuth.cookie,
    ...(!["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase())
      ? { "x-cashflow-csrf-token": sessionAuth.csrfToken }
      : {})
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: options.body !== undefined && typeof options.body !== "string"
      ? { "content-type": "application/json", ...(options.headers || {}) }
      : options.headers,
    body: options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body)
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${url} returned ${response.status}: ${body.slice(0, 500)}`);
  }

  return body ? JSON.parse(body) : null;
}

async function apiJson(baseUrl, userId, pathname, options = {}, sessionAuth = null) {
  return requestJson(`${baseUrl}${pathname}`, {
    ...options,
    headers: sessionAuth
      ? sessionHeaders(sessionAuth, options.method, options.headers)
      : userHeaders(userId, options.headers)
  });
}

async function createApiSession(baseUrl, userId) {
  const response = await fetch(`${baseUrl}/api/session/select`, {
    cache: "no-store",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId })
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`POST ${baseUrl}/api/session/select returned ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }

  const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^cashflow_session=.+/, "selected account API session cookie was not issued");
  assert.ok(body?.csrfToken, "selected account API session CSRF token was not issued");
  return {
    cookie,
    csrfToken: body.csrfToken
  };
}

async function waitForHealth(baseUrl, timeoutMs = Number(process.env.BROWSER_SMOKE_START_TIMEOUT_MS || 180000)) {
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

  return { baseUrl: `http://127.0.0.1:${port}` };
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

async function assertNoTempServerErrors() {
  for (const item of startedChildren) {
    const errorLog = path.join(item.logsDir, "error.log");
    if (!existsSync(errorLog)) continue;

    const content = (await fs.readFile(errorLog, "utf8")).trim();
    if (content) throw new Error(`Browser smoke server wrote errors:\n${content}`);
  }
}

async function waitForPage(page) {
  await page.locator("[data-cashflow-page]").waitFor({ state: "visible" });
}

async function waitForRefreshSettle(page) {
  await waitForPage(page);
  await page.waitForLoadState("networkidle").catch(() => {});
}

async function selectTab(page, tabId, selector) {
  await page.locator(`[data-cashflow-tab="${tabId}"]`).click();
  await page.locator(selector).waitFor({ state: "visible" });
}

async function openAllSettingsSections(page) {
  await selectTab(page, "settings", "[data-cashflow-settings-tab]");
  await page.locator("[data-cashflow-settings-tab] details").evaluateAll(items => {
    items.forEach(item => {
      item.open = true;
    });
  });
}

async function waitForApiResponse(page, pathname, action) {
  const responsePromise = page.waitForResponse(response => {
    try {
      return new URL(response.url()).pathname === pathname;
    } catch {
      return false;
    }
  });
  await action();
  const response = await responsePromise;
  assert.equal(response.ok(), true, `${pathname} returned ${response.status()}`);
  return response;
}

async function waitForApiMethodResponse(page, method, pathname, action) {
  const expectedMethod = String(method || "GET").toUpperCase();
  const responsePromise = page.waitForResponse(response => {
    try {
      return response.request().method() === expectedMethod &&
        new URL(response.url()).pathname === pathname;
    } catch {
      return false;
    }
  });
  await action();
  const response = await responsePromise;
  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    assert.equal(response.ok(), true, `${expectedMethod} ${pathname} returned ${response.status()}: ${body.slice(0, 500)}`);
  }
  return response;
}

async function createLocalSmokeUserAndCompleteSetup(page) {
  const userId = `browser_smoke_${Date.now()}`;
  await page.locator("[data-cashflow-user-selection]").waitFor({ state: "visible" });
  await page.locator('input[name="userId"]').fill(userId);
  await page.locator('input[name="displayName"]').fill("Browser Smoke");
  await page.locator("[data-cashflow-create-user-form] button[type='submit']").click();
  await page.locator("[data-cashflow-budget-selection]").waitFor({ state: "visible" });
  await page.locator(`[data-cashflow-select-budget="${userId}"]`).click();
  await page.locator("[data-cashflow-setup]").waitFor({ state: "visible" });

  await page.locator('input[name="opening_balance"]').fill("1000");
  await page.locator('input[name="income_enabled"]').uncheck();
  await page.locator("[data-cashflow-setup-form] button[type='submit']").click();
  await waitForPage(page);

  return userId;
}

async function assertUserSelectionAndLogout(page, userId) {
  await page.locator("[data-cashflow-logout]").click();
  await page.locator("[data-cashflow-user-selection]").waitFor({ state: "visible" });
  await waitForApiResponse(page, "/api/session/select-account", () =>
    page.locator(`[data-cashflow-select-account="${userId}"]`).click()
  );
  await page.locator("[data-cashflow-budget-selection]").waitFor({ state: "visible" });
  await waitForApiResponse(page, `/api/budgets/${userId}/select`, () =>
    page.locator(`[data-cashflow-select-budget="${userId}"]`).click()
  );
  await waitForPage(page);
}

async function assertTabsRender(page) {
  const tabs = [
    ["ledger", "[data-cashflow-ledger-tab]"],
    ["recurring", "[data-cashflow-recurring-tab]"],
    ["income", "[data-cashflow-income-tab]"],
    ["oneoff", "[data-cashflow-oneoff-tab]"],
    ["goals", "[data-cashflow-goals-tab]"],
    ["flex", "[data-cashflow-flex-tab]"],
    ["priority", "[data-cashflow-priority-tab]"],
    ["budgets", "[data-cashflow-budget-manager]"],
    ["settings", "[data-cashflow-settings-tab]"]
  ];

  for (const [tabId, selector] of tabs) {
    await selectTab(page, tabId, selector);
  }
}

async function openOneOffFutureSection(page) {
  await page.locator("[data-cashflow-oneoff-tab] details").evaluateAll(detailsList => {
    detailsList.forEach(details => {
      details.open = true;
    });
  });
}

async function waitForOneOffRow(page, text) {
  const row = page.locator('[data-cashflow-oneoff-tab] tr[data-tx-type="one-off"]', { hasText: text });
  await row.waitFor({ state: "attached" });
  await openOneOffFutureSection(page);
  await row.waitFor({ state: "visible" });
  return row;
}

async function assertModalCreateEdit(page, baseUrl, userId, sessionAuth) {
  await selectTab(page, "oneoff", "[data-cashflow-oneoff-tab]");
  await page.locator("[data-cashflow-add-oneoff]").click();
  await page.locator("[data-cashflow-modal-form] input[name='name']").fill("Smoke modal one-off");
  await page.locator("[data-cashflow-modal-form] input[name='amount']").fill("42");
  await page.locator("[data-cashflow-modal-form] input[name='date']").fill("2099-01-15");
  await page.locator("[data-cashflow-modal-form] button[type='submit']").click();
  await page.locator("[data-cashflow-modal-root]").waitFor({ state: "detached" });
  await waitForOneOffRow(page, "Smoke modal one-off");

  await page.locator('[data-cashflow-oneoff-tab] tr[data-tx-type="one-off"]', { hasText: "Smoke modal one-off" })
    .locator("[data-edit-tx]").click();
  await page.locator("[data-cashflow-modal-form] input[name='name']").fill("Smoke edited one-off");
  await page.locator("[data-cashflow-modal-form] button[type='submit']").click();
  await page.locator("[data-cashflow-modal-root]").waitFor({ state: "detached" });
  await waitForOneOffRow(page, "Smoke edited one-off");

  const snapshot = await apiJson(baseUrl, userId, "/api", {}, sessionAuth);
  assert.ok(snapshot.oneOffs.some(row => row.name === "Smoke edited one-off"));
}

async function assertBudgetManagerAndSharing(page, baseUrl, userId, sessionAuth) {
  const invitedAccountId = `${userId}_shared`;
  await requestJson(`${baseUrl}/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: {
      userId: invitedAccountId,
      displayName: "Browser Smoke Shared"
    }
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForPage(page);
  await page.getByRole("tab", { name: "Budgets" }).click();
  await page.locator("[data-cashflow-budget-manager]").waitFor({ state: "visible" });

  await page.getByLabel("New budget name").fill("Smoke managed budget");
  await waitForApiMethodResponse(page, "POST", "/api/budgets", () =>
    page.getByRole("button", { name: "Create budget" }).click()
  );
  await page.locator("[data-cashflow-budget-manager]", { hasText: "Smoke managed budget" }).waitFor({ state: "visible" });

  const budgetList = await apiJson(baseUrl, userId, "/api/budgets", {}, sessionAuth);
  const managedBudget = budgetList.budgets.find(budget => budget.display_name === "Smoke managed budget");
  assert.ok(managedBudget);

  await waitForApiMethodResponse(page, "POST", `/api/budgets/${managedBudget.id}/select`, () =>
    page.locator(`[data-cashflow-budget-select="${managedBudget.id}"]`).click()
  );
  await page.locator("[data-cashflow-setup]").waitFor({ state: "visible" });
  await page.locator('input[name="opening_balance"]').fill("0");
  await page.locator('input[name="income_enabled"]').uncheck();
  await page.locator("[data-cashflow-setup-form] button[type='submit']").click();
  await waitForPage(page);

  await page.getByRole("tab", { name: "Budgets" }).click();
  await page.locator("[data-cashflow-budget-manager]").waitFor({ state: "visible" });
  await page.locator(`[data-cashflow-budget-name="${managedBudget.id}"]`).fill("Smoke renamed budget");
  await waitForApiMethodResponse(page, "PUT", `/api/budgets/${managedBudget.id}`, () =>
    page.locator(`[data-cashflow-budget-rename="${managedBudget.id}"]`).click()
  );
  await page.locator("[data-cashflow-budget-manager]", { hasText: "Smoke renamed budget" }).waitFor({ state: "visible" });

  await waitForApiMethodResponse(page, "POST", `/api/budgets/${userId}/select`, () =>
    page.locator(`[data-cashflow-budget-select="${userId}"]`).click()
  );
  await page.locator("[data-cashflow-budget-manager]").waitFor({ state: "visible" });

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForPage(page);
  await page.getByRole("tab", { name: "Budgets" }).click();
  await page.locator("[data-cashflow-budget-manager]").waitFor({ state: "visible" });

  const selectedInviteAccount = await page.locator("[data-cashflow-budget-invite-form] select[name='accountId']").selectOption(invitedAccountId);
  assert.deepEqual(selectedInviteAccount, [invitedAccountId]);
  await page.locator("[data-cashflow-budget-invite-form] select[name='role']").selectOption("viewer");
  await waitForApiMethodResponse(page, "POST", `/api/budgets/${userId}/invitations`, () =>
    page.locator("[data-cashflow-budget-invite-form] button[type='submit']").click()
  );
  const invitationToken = await page.getByLabel("Invitation token").inputValue();
  assert.ok(invitationToken);

  await page.locator("[data-cashflow-logout]").click();
  await page.locator("[data-cashflow-user-selection]").waitFor({ state: "visible" });
  await waitForApiResponse(page, "/api/session/select-account", () =>
    page.locator(`[data-cashflow-select-account="${invitedAccountId}"]`).click()
  );
  await page.locator("[data-cashflow-budget-selection]").waitFor({ state: "visible" });
  await page.locator("[data-cashflow-accept-invitation-form] input[name='token']").fill(invitationToken);
  await waitForApiMethodResponse(page, "POST", "/api/invitations/accept", () =>
    page.locator("[data-cashflow-accept-invitation-form] button[type='submit']").click()
  );
  await page.locator(`[data-cashflow-select-budget="${userId}"]`).waitFor({ state: "visible" });
  await waitForApiMethodResponse(page, "POST", `/api/budgets/${userId}/select`, () =>
    page.locator(`[data-cashflow-select-budget="${userId}"]`).click()
  );
  await waitForPage(page);
  await page.getByRole("tab", { name: "Budgets" }).click();
  const sharedBudgetRow = page.locator(`[data-cashflow-budget-row="${userId}"]`);
  await sharedBudgetRow.waitFor({ state: "visible" });
  assert.equal(await sharedBudgetRow.locator("[data-cashflow-budget-rename]").count(), 0);
  assert.equal(await page.locator("[data-cashflow-budget-invite-form]").count(), 0);

  await page.locator("[data-cashflow-logout]").click();
  await page.locator("[data-cashflow-user-selection]").waitFor({ state: "visible" });
  await waitForApiResponse(page, "/api/session/select-account", () =>
    page.locator(`[data-cashflow-select-account="${userId}"]`).click()
  );
  await page.locator("[data-cashflow-budget-selection]").waitFor({ state: "visible" });
  await waitForApiMethodResponse(page, "POST", `/api/budgets/${userId}/select`, () =>
    page.locator(`[data-cashflow-select-budget="${userId}"]`).click()
  );
  await waitForPage(page);

  await page.getByRole("tab", { name: "Admin" }).click();
  await page.locator("[data-cashflow-admin-accounts]").waitFor({ state: "visible" });
  await page.locator(`[data-cashflow-admin-account-name="${invitedAccountId}"]`).fill("Browser Smoke Shared Renamed");
  await waitForApiMethodResponse(page, "PUT", `/api/admin/accounts/${invitedAccountId}`, () =>
    page.locator(`[data-cashflow-admin-account-rename="${invitedAccountId}"]`).click()
  );
  await page.waitForFunction(accountId => {
    const input = document.querySelector(`[data-cashflow-admin-account-name="${accountId}"]`);
    return input?.value === "Browser Smoke Shared Renamed";
  }, invitedAccountId);
  await waitForApiMethodResponse(page, "PUT", `/api/admin/accounts/${invitedAccountId}/system-admin`, () =>
    page.locator(`[data-cashflow-admin-account-admin="${invitedAccountId}"][data-enabled="1"]`).click()
  );
  page.once("dialog", dialog => dialog.accept());
  await waitForApiMethodResponse(page, "PUT", `/api/admin/accounts/${invitedAccountId}/system-admin`, () =>
    page.locator(`[data-cashflow-admin-account-admin="${invitedAccountId}"][data-enabled="0"]`).click()
  );
  page.once("dialog", dialog => dialog.accept());
  await waitForApiMethodResponse(page, "PUT", `/api/admin/accounts/${invitedAccountId}`, () =>
    page.locator(`[data-cashflow-admin-account-status="${invitedAccountId}"][data-next-status="disabled"]`).click()
  );
  await waitForApiMethodResponse(page, "PUT", `/api/admin/accounts/${invitedAccountId}`, () =>
    page.locator(`[data-cashflow-admin-account-status="${invitedAccountId}"][data-next-status="active"]`).click()
  );

  await page.locator("[data-cashflow-admin-auth]").waitFor({ state: "visible" });
  await page.locator("[data-cashflow-admin-auth-form] input[name='sessionIdleMinutes']").fill("721");
  await page.locator("[data-cashflow-admin-auth-form] input[name='sessionAbsoluteMinutes']").fill("10081");
  await waitForApiMethodResponse(page, "PUT", "/api/admin/auth/draft", () =>
    page.locator("[data-cashflow-admin-auth-form] button[type='submit']").click()
  );
  await page.locator("[data-cashflow-admin-auth]").waitFor({ state: "visible" });
  await waitForApiMethodResponse(page, "POST", "/api/admin/auth/test", () =>
    page.locator("[data-cashflow-admin-auth-test]").click()
  );
  await page.waitForLoadState("networkidle").catch(() => {});

  const providerId = `smoke-provider-${Date.now()}`;
  const providerForm = page.locator("[data-cashflow-admin-provider-form]").last();
  await providerForm.locator('input[name="providerId"]').waitFor({ state: "visible" });
  await providerForm.locator('input[name="providerId"]').fill(providerId);
  await providerForm.locator('select[name="kind"]').selectOption("oidc");
  await providerForm.locator('input[name="displayName"]').fill("Smoke Provider");
  await providerForm.locator('input[name="issuer"]').fill("https://issuer.example.test/");
  await providerForm.locator('input[name="redirectUri"]').fill(`${baseUrl}/api/auth/providers/${providerId}/callback`);
  const providerFormValidity = await providerForm.evaluate(form => ({
    valid: form.checkValidity(),
    invalid: [...form.elements]
      .filter(element => typeof element.checkValidity === "function" && !element.checkValidity())
      .map(element => ({
        name: element.getAttribute("name") || "",
        message: element.validationMessage || "",
        value: element.value || ""
      }))
  }));
  assert.deepEqual(providerFormValidity.invalid, [], "provider form failed browser validation");
  await waitForApiMethodResponse(page, "PUT", `/api/admin/auth/providers/${providerId}`, () =>
    providerForm.locator("button[type='submit']").click()
  );
  await page.locator("[data-cashflow-admin-auth-providers]", { hasText: "Smoke Provider" }).waitFor({ state: "visible" });
  page.once("dialog", dialog => dialog.accept());
  await waitForApiMethodResponse(page, "DELETE", `/api/admin/auth/providers/${providerId}`, () =>
    page.locator(`[data-cashflow-admin-provider-delete="${providerId}"]`).click()
  );
}

async function assertSettingsSave(page, baseUrl, userId, sessionAuth) {
  await openAllSettingsSections(page);
  await page.locator('input[name="future_periods"]').fill("6");
  await waitForApiResponse(page, "/api/settings", () =>
    page.locator("[data-cashflow-settings-form] button[type='submit']").click()
  );
  await waitForPage(page);

  const snapshot = await apiJson(baseUrl, userId, "/api", {}, sessionAuth);
  assert.equal(snapshot.settings.future_periods, 6);
}

function mergeExportFrom(fullExport, markerId) {
  const planning = Object.fromEntries(
    Object.entries(fullExport.planning).map(([tableName, rows]) => [
      tableName,
      tableName === "settings" ? rows : []
    ])
  );
  const now = new Date().toISOString();
  planning.one_off_transactions = [{
    id: markerId,
    name: "Smoke merge import",
    currency: fullExport.planning.settings[0].ledger_currency,
    amount: 7,
    type: "income",
    date: "2099-02-01",
    created_at: now,
    updated_at: now
  }];

  return {
    ...fullExport,
    exportedAt: now,
    planning,
    ledgers: {}
  };
}

async function uploadFile(page, selector, name, mimeType, content) {
  await page.locator(selector).setInputFiles({
    name,
    mimeType,
    buffer: Buffer.from(content)
  });
}

async function assertDataPortability(page, baseUrl, userId, sessionAuth) {
  await openAllSettingsSections(page);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("[data-cashflow-download-full-export]").click();
  const download = await downloadPromise;
  const exportText = await fs.readFile(await download.path(), "utf8");
  const fullExport = JSON.parse(exportText);
  assert.equal(fullExport.format, "cashflow-full-export");

  await apiJson(baseUrl, userId, "/api/one-off", {
    method: "POST",
    body: {
      name: "Smoke replace marker",
      currency: fullExport.planning.settings[0].ledger_currency,
      amount: 5,
      type: "income",
      date: "2099-03-01"
    }
  }, sessionAuth);

  await uploadFile(page, "[data-cashflow-full-import-file]", "smoke-replace.json", "application/json", exportText);
  await page.locator("[data-cashflow-full-import-mode]").selectOption("replace");
  await waitForApiResponse(page, "/api/import/full", () =>
    page.locator("[data-cashflow-import-full]").click()
  );
  await waitForRefreshSettle(page);
  assert.equal((await apiJson(baseUrl, userId, "/api", {}, sessionAuth)).oneOffs.some(row => row.name === "Smoke replace marker"), false);

  await openAllSettingsSections(page);
  const mergeId = `smoke-merge-${Date.now()}`;
  const mergeExport = mergeExportFrom(fullExport, mergeId);
  await uploadFile(page, "[data-cashflow-full-import-file]", "smoke-merge.json", "application/json", JSON.stringify(mergeExport));
  await page.locator("[data-cashflow-full-import-mode]").selectOption("merge");
  await waitForApiResponse(page, "/api/import/full", () =>
    page.locator("[data-cashflow-import-full]").click()
  );
  await waitForRefreshSettle(page);
  assert.ok((await apiJson(baseUrl, userId, "/api", {}, sessionAuth)).oneOffs.some(row => row.id === mergeId));

  await openAllSettingsSections(page);
  const appendCsv = "name,type,amount,currency,date\nSmoke CSV append,income,11,PLN,2099-04-01";
  await uploadFile(page, "[data-cashflow-oneoff-csv-file]", "smoke-append.csv", "text/csv", appendCsv);
  page.once("dialog", dialog => dialog.dismiss());
  await waitForApiResponse(page, "/api/import/one-offs-csv", () =>
    page.locator("[data-cashflow-import-oneoff-csv]").click()
  );
  await waitForRefreshSettle(page);
  assert.ok((await apiJson(baseUrl, userId, "/api", {}, sessionAuth)).oneOffs.some(row => row.name === "Smoke CSV append"));

  await openAllSettingsSections(page);
  const replaceCsv = "name,type,amount,currency,date\nSmoke CSV replacement,income,12,PLN,2099-05-01";
  await uploadFile(page, "[data-cashflow-oneoff-csv-file]", "smoke-replace.csv", "text/csv", replaceCsv);
  page.once("dialog", dialog => dialog.accept());
  await waitForApiResponse(page, "/api/import/one-offs-csv", () =>
    page.locator("[data-cashflow-import-oneoff-csv]").click()
  );
  await waitForRefreshSettle(page);
  const replaced = await apiJson(baseUrl, userId, "/api", {}, sessionAuth);
  assert.ok(replaced.oneOffs.some(row => row.name === "Smoke CSV replacement"));
  assert.equal(replaced.oneOffs.some(row => row.name === "Smoke CSV append"), false);

  await openAllSettingsSections(page);
  page.once("dialog", dialog => dialog.accept());
  await waitForApiResponse(page, "/api/import/sample", () =>
    page.locator("[data-cashflow-load-sample]").click()
  );
  const sample = await apiJson(baseUrl, userId, "/api", {}, sessionAuth);
  assert.equal(sample.setup_required, false);
  assert.ok(sample.oneOffs.some(row => row.name === "Sample laptop"));

  await page.setViewportSize({ width: 480, height: 900 });
  await selectTab(page, "ledger", "[data-cashflow-ledger-tab]");
  const toggle = page.locator("[data-cashflow-toggle-funding]");
  await toggle.waitFor({ state: "visible" });
  const grid = page.locator("[data-cashflow-funding-grid]");
  const items = page.locator("[data-cashflow-funding-item]");
  assert.ok(await items.count() > 1);
  assert.equal(await items.nth(1).isVisible(), false);
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  assert.equal(await grid.evaluate(element => element.classList.contains("cashflow-funding-overview--collapsed")), false);
  assert.equal(await items.nth(1).isVisible(), true);
  await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await grid.evaluate(element => element.classList.contains("cashflow-funding-overview--collapsed")), true);
  assert.equal(await items.nth(1).isVisible(), false);
  await page.setViewportSize({ width: 1280, height: 720 });
}

async function assertLedgerConfirmation(page, baseUrl, userId, sessionAuth) {
  let snapshot = await apiJson(baseUrl, userId, "/api", {}, sessionAuth);
  const name = `Smoke confirm ${Date.now()}`;
  const oneOff = await apiJson(baseUrl, userId, "/api/one-off", {
    method: "POST",
    body: {
      name,
      currency: snapshot.settings.ledger_currency,
      amount: 20,
      type: "income",
      date: snapshot.today
    }
  }, sessionAuth);

  snapshot = await apiJson(baseUrl, userId, "/api", {}, sessionAuth);
  let pending = snapshot.pendingTransactions.find(row => row.source_one_off_id === oneOff.id);
  if (!pending) {
    const future = snapshot.futureTransactions.find(row => row.source_one_off_id === oneOff.id);
    assert.ok(future, "confirmation smoke one-off did not generate a future row");
    await apiJson(baseUrl, userId, `/api/future/${encodeURIComponent(future.id)}/move-to-pending`, {
      method: "POST",
      body: { occurrenceKey: future.occurrence_key }
    }, sessionAuth);
    snapshot = await apiJson(baseUrl, userId, "/api", {}, sessionAuth);
    pending = snapshot.pendingTransactions.find(row => row.source_one_off_id === oneOff.id);
  }
  assert.ok(pending);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForPage(page);
  await selectTab(page, "ledger", "[data-cashflow-ledger-tab]");
  const row = page.locator('tr[data-tx-type="pending"]', { hasText: name });
  await row.waitFor({ state: "visible" });
  await waitForApiResponse(page, `/api/pending/${pending.id}/confirm`, () =>
    row.locator("[data-cashflow-confirm-pending]").click()
  );

  snapshot = await apiJson(baseUrl, userId, "/api", {}, sessionAuth);
  assert.ok(snapshot.confirmedTransactions.some(item => item.name === name));
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
  assert.match(await banner.textContent(), /Smoke action failure/);
  await waitForPage(page);
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
  assert.equal(await page.evaluate(() => localStorage.getItem("cashflow_user_id")), null);
  await page.unroute("**/api/session");
}

async function runBrowserSmoke(baseUrl, {
  deployed,
  mutating,
  userId: configuredUserId
}) {
  const executablePath = SYSTEM_CHROME_CANDIDATES.find(candidate => existsSync(candidate));
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  let userId = configuredUserId;
  let sessionAuth = null;

  try {
    if (deployed) {
      await page.addInitScript(selectedUserId => {
        localStorage.setItem("cashflow_user_id", selectedUserId);
      }, userId);
    }

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    if (!deployed) {
      userId = await createLocalSmokeUserAndCompleteSetup(page);
      await assertUserSelectionAndLogout(page, userId);
      sessionAuth = await createApiSession(baseUrl, userId);
    } else {
      await waitForPage(page);
    }

    await assertTabsRender(page);
    if (!deployed) {
      await assertBudgetManagerAndSharing(page, baseUrl, userId, sessionAuth);
    }
    if (!mutating) return;

    await assertLedgerConfirmation(page, baseUrl, userId, sessionAuth);
    await assertModalCreateEdit(page, baseUrl, userId, sessionAuth);
    await assertSettingsSave(page, baseUrl, userId, sessionAuth);
    await assertDataPortability(page, baseUrl, userId, sessionAuth);
    await assertActionErrorsStayInApp(page);
    await assertInvalidRememberedUserReturnsToSelection(page);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  const deployed = Boolean(process.env.CASHFLOW_BASE_URL);
  const mutating = !deployed || process.env.CASHFLOW_ALLOW_MUTATING_SMOKE === "1";
  let baseUrl = process.env.CASHFLOW_BASE_URL || "";
  let userId = "";
  let recoveryExport = null;

  if (!deployed) {
    ({ baseUrl } = await startServer());
  } else {
    userId = String(process.env.CASHFLOW_SMOKE_USER_ID || "").trim();
    if (!userId) throw new Error("CASHFLOW_SMOKE_USER_ID is required for deployed browser smoke");
    if (userId === "local") throw new Error("Deployed browser smoke refuses CASHFLOW_SMOKE_USER_ID=local");
  }

  await waitForHealth(baseUrl);
  const system = await requestJson(`${baseUrl}/api/system`);
  assert.equal(system?.app, "cashflow");

  if (deployed) {
    const session = await apiJson(baseUrl, userId, "/api/session");
    assert.equal(session?.session?.authenticated, true);
    assert.equal(session?.session?.userId, userId);
    const snapshot = await apiJson(baseUrl, userId, "/api");
    if (snapshot.setup_required) {
      throw new Error(`Deployed smoke profile ${userId} must complete setup before browser smoke`);
    }
    if (mutating) {
      recoveryExport = await apiJson(baseUrl, userId, "/api/export/full?includeOperationalSettings=1");
    }
  }

  try {
    await runBrowserSmoke(baseUrl, { deployed, mutating, userId });
  } finally {
    if (deployed && recoveryExport) {
      await apiJson(baseUrl, userId, "/api/import/full", {
        method: "POST",
        body: {
          mode: "replace",
          export: recoveryExport,
          includeOperationalSettings: true
        }
      });
    }
  }

  await assertNoTempServerErrors();
  console.log(`Browser smoke OK (${mutating ? "mutating isolated profile" : "read-only"}): ${baseUrl}`);
}

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(stopChildren);
