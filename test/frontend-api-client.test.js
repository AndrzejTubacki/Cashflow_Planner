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
