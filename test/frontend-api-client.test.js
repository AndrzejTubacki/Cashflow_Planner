import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CashflowApiError,
  createCashflowApiClient
} from "../public/app/cashflow/api-client.js";

test("API client scopes selected-user requests and serializes JSON bodies", async () => {
  const calls = [];
  const client = createCashflowApiClient({
    getUserId: () => "selected-user",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.json("/api/settings", {
    method: "PUT",
    body: { locale: "pl" }
  });
  await client.json("/api/users", {
    cache: "no-store",
    scoped: false
  });

  assert.equal(calls[0].options.headers["x-cashflow-user-id"], "selected-user");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.equal(calls[0].options.body, JSON.stringify({ locale: "pl" }));
  assert.equal(Object.prototype.hasOwnProperty.call(calls[1].options.headers, "x-cashflow-user-id"), false);
});

test("API client prefers budget IDs and attaches session CSRF tokens to mutations", async () => {
  const calls = [];
  const client = createCashflowApiClient({
    getBudgetId: () => "selected-budget",
    getCsrfToken: () => "csrf-token",
    getUserId: () => "legacy-user",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.json("/api/settings", {
    method: "PUT",
    body: { locale: "pl" }
  });
  await client.json("/api");

  assert.equal(calls[0].options.headers["x-cashflow-budget-id"], "selected-budget");
  assert.equal(calls[0].options.headers["x-cashflow-csrf-token"], "csrf-token");
  assert.equal(Object.hasOwn(calls[0].options.headers, "x-cashflow-user-id"), false);
  assert.equal(Object.hasOwn(calls[1].options.headers, "x-cashflow-csrf-token"), false);
  assert.equal(calls[0].options.credentials, "same-origin");
});

test("API client raw responses and typed errors preserve response details", async () => {
  const rawClient = createCashflowApiClient({
    fetchImpl: async () => new Response("csv-data", { status: 200 })
  });
  const raw = await rawClient.raw("/api/export/confirmed-ledger.csv");
  assert.equal(await raw.text(), "csv-data");

  const failingClient = createCashflowApiClient({
    fetchImpl: async () => new Response(JSON.stringify({
      error: "Import conflict",
      details: [{ row: 2, field: "id", reason: "duplicate" }],
      conflicts: [{ table: "one_off_transactions", id: "one" }]
    }), {
      status: 409,
      headers: { "content-type": "application/json" }
    })
  });

  await assert.rejects(
    () => failingClient.json("/api/import/full", { method: "POST", body: {} }),
    error => {
      assert.ok(error instanceof CashflowApiError);
      assert.equal(error.status, 409);
      assert.equal(error.message, "Import conflict");
      assert.deepEqual(error.details, [{ row: 2, field: "id", reason: "duplicate" }]);
      assert.deepEqual(error.conflicts, [{ table: "one_off_transactions", id: "one" }]);
      return true;
    }
  );
});

test("frontend modules do not use the legacy global API client or browser alerts", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const files = [
    "public/app.js",
    "public/app/cashflow/actions.js",
    "public/app/cashflow/handlers.js",
    "public/app/cashflow/modal.js"
  ];

  for (const file of files) {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    assert.doesNotMatch(source, /window\.cashflowFetch/);
    assert.doesNotMatch(source, /\balert\s*\(/);
  }
});

test("beta budget export delegates to parent-owned busy and error state", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const budgetView = fs.readFileSync(path.join(repoRoot, "frontend-beta/src/BudgetView.jsx"), "utf8");
  const budgetRow = budgetView.slice(
    budgetView.indexOf("function BudgetRow"),
    budgetView.indexOf("function MembersPanel")
  );
  assert.match(budgetRow, /onExport/);
  assert.match(budgetRow, /onClick=\{\(\) => onExport\(budget\.id\)\}/);
  assert.doesNotMatch(budgetRow, /\bsetBusy\b|\bsetError\b|\bdownloadFile\b/);
  assert.match(budgetView, /async function handleExport\(budgetId\)/);
  assert.match(budgetView, /onExport=\{handleExport\}/);
});

test("beta app only installs the CSRF token from its current load", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const app = fs.readFileSync(path.join(repoRoot, "frontend-beta/src/App.jsx"), "utf8");
  assert.match(
    app,
    /if \(currentRequestId === loadCounter\.current && sessionResult\?\.csrfToken\) \{\s*setCsrfToken/
  );
});

test("legacy cashflow load guards budget-manager assignment against stale requests", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const legacyApp = fs.readFileSync(path.join(repoRoot, "public/app.js"), "utf8");
  assert.match(legacyApp, /expectedCashflowSeq !== cashflowLoadSeq\) return false;\s*state\.budgetManager = manager;/);
  assert.match(legacyApp, /expectedCashflowSeq: seq[\s\S]*seq !== cashflowLoadSeq \|\| !managerLoaded/);
});

test("beta account ID pattern compiles the way browsers compile pattern attributes", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const entry = fs.readFileSync(path.join(repoRoot, "frontend-beta/src/EntryViews.jsx"), "utf8");
  const source = entry.match(/const ACCOUNT_ID_PATTERN = "((?:[^"\\]|\\.)*)";/)[1];
  const pattern = JSON.parse(`"${source}"`);
  // Browsers ignore a pattern that fails to compile with the `v` flag, silently disabling the check.
  const compiled = new RegExp(`^(?:${pattern})$`, "v");
  assert.equal(compiled.test("admin_1-a"), true);
  assert.equal(compiled.test("bad id!"), false);
  assert.equal(compiled.test("a".repeat(65)), false);
});
