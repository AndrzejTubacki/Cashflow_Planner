import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { apiFetch, CashflowApiError } from "../frontend-beta/src/api.js";
import { formatMessage, setLocale, t } from "../frontend-beta/src/i18n.js";

const source = name => readFile(new URL(`../frontend-beta/src/${name}`, import.meta.url), "utf8");

test("stale FX warning names pairs and ages, refreshes then reloads, and handles busy/success/error states", async () => {
  const warning = await source("ProjectionWarnings.jsx");
  assert.match(warning, /snapshot\?\.staleFxRates \|\| \[\]/);
  assert.match(warning, /!missingFxRates.length && !staleFxRates.length/);
  assert.match(warning, /staleFxRates\.map\(\(\{ pair, ageDays \}\)/);
  assert.match(warning, /formatMessage\("Exchange rate \{pair\} is \{days\} days old\."/);
  assert.match(warning, /run\("fx", "\/api\/fx\/refresh"\)/);
  assert.match(warning, /await apiFetch\(path, \{ method: "POST" \}\);\s*await onRefresh\(\);/);
  assert.match(warning, /disabled=\{Boolean\(busy\)\}/);
  assert.match(warning, /busy === "fx" \? t\("Refreshing\.\.\."\)/);
  assert.match(warning, /setSuccess\(t\("Exchange rates refreshed\."\)\)/);
  assert.match(warning, /setError\(err.message/);
  assert.match(warning, /finally\s*\{\s*setBusy\(""\)/);
  const app = await source("App.jsx");
  assert.match(app, /<ProjectionWarnings snapshot=\{snapshot\} onRefresh=\{load\} \/>[\s\S]*section === "ledger"[\s\S]*<LedgerView/);
});

test("manual refresh retains the existing budget:maintain requirement", async () => {
  assert.match(await source("ProjectionWarnings.jsx"), /includes\("budget:maintain"\)/);
  const routes = await readFile(new URL("../src/server/cashflow-routes.js", import.meta.url), "utf8");
  assert.match(routes, /app.post\("\/api\/fx\/refresh",[\s\S]*?requireBudgetCapability\(req, CAPABILITIES.BUDGET_MAINTAIN\)/);
});

test("pair/age, explanation and success messages have English and Polish copy", () => {
  try {
    setLocale("en");
    assert.equal(formatMessage("Exchange rate {pair} is {days} days old.", { pair: "EUR/PLN", days: 32 }), "Exchange rate EUR/PLN is 32 days old.");
    setLocale("pl");
    assert.equal(formatMessage("Exchange rate {pair} is {days} days old.", { pair: "EUR/PLN", days: 32 }), "Kurs EUR/PLN pochodzi sprzed 32 dni.");
    assert.equal(t("Exchange rates are out of date"), "Kursy walut są nieaktualne");
    assert.match(t("Projections use the last known rate; confirming foreign-currency transactions is blocked until rates are refreshed."), /Zatwierdzanie transakcji.*zablokowane/);
    assert.equal(t("Exchange rates refreshed."), "Kursy walut zostały odświeżone.");
  } finally { setLocale("en"); }
});

test("confirmation preserves the server's actionable stale_fx_rate message through the API and Ledger error display", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const message = "The EUR/PLN exchange rate is 32 days old. Refresh exchange rates before confirming this transaction.";
  globalThis.localStorage = { getItem: () => "stale-fx-test" };
  globalThis.fetch = async () => new Response(JSON.stringify({ error: message, details: { code: "stale_fx_rate" } }), {
    status: 409, headers: { "content-type": "application/json" }
  });
  try {
    await assert.rejects(apiFetch("/api/pending/foreign/confirm", { method: "POST", body: {} }), error => {
      assert.ok(error instanceof CashflowApiError);
      assert.equal(error.status, 409);
      assert.equal(error.message, message);
      assert.equal(error.details.code, "stale_fx_rate");
      return true;
    });
    const ledger = await source("LedgerView.jsx");
    assert.match(ledger, /await confirmPending\(id, \{\}\);[\s\S]*?catch \(err\) \{\s*setError\(err.message/);
    assert.match(ledger, /error \? <div className="beta-error beta-dismissible">\{error\}/);
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});
