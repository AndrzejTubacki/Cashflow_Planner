import assert from "node:assert/strict";

import { SUPPORTED_FX_CURRENCIES } from "../src/server/cashflow-fx-provider-utils.js";

function usageError(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

function baseUrlFromEnv() {
  const baseUrl = String(process.env.CASHFLOW_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw usageError("CASHFLOW_BASE_URL is required for rollout checks");
  }
  return baseUrl;
}

function selectedId(value, fallback = "") {
  return String(value || fallback || "").trim();
}

function csrfHeaders(sessionAuth, method, headers = {}) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  return {
    ...headers,
    ...(sessionAuth.cookie ? { cookie: sessionAuth.cookie } : {}),
    ...(!["GET", "HEAD", "OPTIONS"].includes(normalizedMethod) && sessionAuth.csrfToken
      ? { "x-cashflow-csrf-token": sessionAuth.csrfToken }
      : {})
  };
}

async function requestJson(baseUrl, pathname, options = {}, sessionAuth = null) {
  const method = String(options.method || "GET").toUpperCase();
  const response = await fetch(`${baseUrl}${pathname}`, {
    cache: "no-store",
    ...options,
    headers: sessionAuth
      ? csrfHeaders(sessionAuth, method, options.headers)
      : options.headers,
    body: options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`${method} ${pathname} returned ${response.status}: ${text.slice(0, 500)}`);
  }

  const setCookie = String(response.headers.get("set-cookie") || "");
  return {
    payload,
    setCookie
  };
}

async function json(baseUrl, pathname, options = {}, sessionAuth = null) {
  const requestOptions = {
    ...options,
    headers: options.body !== undefined && typeof options.body !== "string"
      ? { "content-type": "application/json", ...(options.headers || {}) }
      : options.headers
  };
  return requestJson(baseUrl, pathname, requestOptions, sessionAuth);
}

function cookieFrom(setCookie) {
  return String(setCookie || "").split(";")[0];
}

function chooseActiveAccount(accounts) {
  const configured = selectedId(process.env.CASHFLOW_ROLLOUT_ACCOUNT_ID);
  const match = configured
    ? accounts.find(account => account.id === configured)
    : accounts.find(account => account.status === "active") || accounts[0];
  if (!match) throw new Error("No active account is available for rollout verification");
  return match;
}

function chooseActiveBudget(budgets) {
  const configured = selectedId(process.env.CASHFLOW_ROLLOUT_BUDGET_ID || process.env.CASHFLOW_SMOKE_USER_ID);
  const match = configured
    ? budgets.find(budget => budget.id === configured)
    : budgets.find(budget => budget.status === "active") || budgets[0];
  if (!match) throw new Error("No active budget is available for rollout verification");
  if (match.status !== "active") {
    throw new Error(`Selected budget ${match.id} is ${match.status}, not active`);
  }
  return match;
}

async function main() {
  const baseUrl = baseUrlFromEnv();
  const expectedMode = selectedId(process.env.CASHFLOW_EXPECT_AUTH_MODE, "none");
  if (expectedMode !== "none") {
    throw usageError("rollout-check currently verifies the none-mode migration rollout only");
  }

  const { payload: health } = await json(baseUrl, "/healthz");
  assert.equal(health?.ok, true, "/healthz did not report ok");

  const { payload: system } = await json(baseUrl, "/api/system");
  assert.equal(system?.app, "cashflow", "/api/system did not report the cashflow app");

  const { payload: authConfig } = await json(baseUrl, "/api/auth/config");
  assert.equal(authConfig?.auth?.activeMode || "none", expectedMode, "unexpected active auth mode");

  const { payload: accountPayload } = await json(baseUrl, "/api/accounts");
  assert.ok(Array.isArray(accountPayload?.accounts), "/api/accounts did not return an account list");
  const account = chooseActiveAccount(accountPayload.accounts);

  const selectedAccount = await json(baseUrl, "/api/session/select-account", {
    method: "POST",
    body: { accountId: account.id }
  });
  const sessionAuth = {
    cookie: cookieFrom(selectedAccount.setCookie),
    csrfToken: selectedAccount.payload?.csrfToken || ""
  };
  assert.match(sessionAuth.cookie, /^cashflow_session=.+/, "none-mode session cookie was not issued");
  assert.ok(sessionAuth.csrfToken, "CSRF token was not issued");
  assert.equal(selectedAccount.payload?.session?.accountId, account.id, "selected account session mismatch");
  assert.ok(Array.isArray(selectedAccount.payload?.budgets), "selected account did not return budgets");

  const budget = chooseActiveBudget(selectedAccount.payload.budgets);
  const { payload: selectedBudget } = await json(baseUrl, `/api/budgets/${encodeURIComponent(budget.id)}/select`, {
    method: "POST",
    body: {}
  }, sessionAuth);
  assert.equal(selectedBudget?.session?.budgetId, budget.id, "selected budget session mismatch");

  const { payload: sessionPayload } = await json(baseUrl, "/api/session", {}, sessionAuth);
  assert.equal(sessionPayload?.session?.authenticated, true, "session is not authenticated");
  assert.equal(sessionPayload?.session?.accountId, account.id, "session account mismatch");
  assert.equal(sessionPayload?.session?.budgetId, budget.id, "session budget mismatch");

  const { payload: budgetPayload } = await json(baseUrl, "/api/budgets", {}, sessionAuth);
  assert.ok(
    Array.isArray(budgetPayload?.budgets) && budgetPayload.budgets.some(row => row.id === budget.id),
    "selected account cannot list the selected budget"
  );

  const { payload: cashflow } = await json(baseUrl, "/api", {}, sessionAuth);
  assert.equal(cashflow?.setup_required, false, "selected budget must complete first-run setup before rollout");
  assert.ok(
    SUPPORTED_FX_CURRENCIES.includes(cashflow?.settings?.ledger_currency),
    "selected budget has an unsupported ledger currency"
  );
  assert.equal(cashflow?.settings?.setup_completed, 1, "selected budget settings are not marked set up");

  const { payload: exportPayload } = await json(baseUrl, "/api/export/full", {}, sessionAuth);
  assert.equal(exportPayload?.format, "cashflow-full-export", "full export did not return the expected format");
  assert.ok(exportPayload?.planning?.settings?.length >= 1, "full export is missing planner settings");

  console.log([
    "Rollout check OK",
    `baseUrl=${baseUrl}`,
    `authMode=${expectedMode}`,
    `account=${account.id}`,
    `budget=${budget.id}`,
    `startedAt=${system.startedAt || ""}`
  ].join(" "));
}

main().catch(error => {
  if (error?.usage) {
    console.error(error.message);
    console.error("Example: CASHFLOW_BASE_URL=https://cashflow.example.com npm run rollout:check");
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
