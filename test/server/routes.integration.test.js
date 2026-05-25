import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

async function withHarness(fn) {
  const harness = await createCashflowTestHarness();
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

test("routes return localized error messages based on saved user locale", async () => withHarness(async harness => {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      locale: "pl"
    }
  });

  const result = await harness.request("/api/goals/missing-goal", {
    method: "PUT",
    body: {
      name: "Missing"
    }
  });

  assert.equal(result.response.status, 500);
  assert.deepEqual(Object.keys(result.body), ["error"]);
  assert.equal(result.body.error, "Nie znaleziono celu");
}));

test("x-cashflow-user-id selects isolated user data", async () => withHarness(async harness => {
  await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Local user only",
      currency: "PLN",
      amount: 10,
      type: "income",
      date: "2026-06-01"
    }
  });

  const otherUser = await harness.request("/api", {
    headers: {
      "x-cashflow-user-id": "other"
    }
  });
  const localUser = await harness.request("/api");

  assert.equal(otherUser.response.status, 200);
  assert.equal(localUser.response.status, 200);
  assert.equal(localUser.body.oneOffs.length, 1);
  assert.equal(otherUser.body.oneOffs.length, 0);
  assert.equal(otherUser.body.settings.ledger_currency, "PLN");
}));

test("core route flow validates after settings and job regeneration", async () => withHarness(async harness => {
  const settings = await harness.api("/api/settings", {
    method: "PUT",
    body: {
      future_periods: 3,
      fx_provider: "manual",
      manual_fx_rates: {},
      fx_buffer_percent: 0
    }
  });

  assert.equal(settings.ledger_currency, "PLN");

  const projection = await harness.api("/api/run-jobs", {
    method: "POST",
    body: {}
  });
  const validation = await harness.api("/api/validate", {
    method: "POST",
    body: {}
  });

  assert.equal(projection.ok, true);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.warnings, []);
}));
