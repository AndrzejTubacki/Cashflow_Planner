import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createCashflowTestHarness,
  planningDbPath
} from "../helpers/cashflow-test-harness.js";

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

  assert.equal(result.response.status, 404);
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

  await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "other"
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

test("read routes reject unknown users without creating profile data", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    const unknownId = "missing_user";
    const result = await harness.request("/api", {
      headers: {
        "x-cashflow-user-id": unknownId
      }
    });

    assert.equal(result.response.status, 404);
    assert.equal(fs.existsSync(path.join(harness.dataDir, unknownId)), false);
  } finally {
    await harness.cleanup();
  }
});

test("session lookup is read-only and session select initializes local only explicitly", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    const listed = await harness.request("/api/users", { skipUserHeader: true });
    assert.equal(listed.response.status, 200);
    assert.ok(listed.body.users.some(user => user.id === "local"));
    assert.equal(fs.existsSync(planningDbPath(harness.dataDir, "local")), false);

    const missingSession = await harness.request("/api/session", {
      headers: {
        "x-cashflow-user-id": "ghost"
      }
    });
    assert.equal(missingSession.response.status, 404);
    assert.equal(fs.existsSync(path.join(harness.dataDir, "ghost")), false);

    const selectMissing = await harness.request("/api/session/select", {
      method: "POST",
      skipUserHeader: true,
      body: {
        userId: "ghost"
      }
    });
    assert.equal(selectMissing.response.status, 404);
    assert.equal(fs.existsSync(path.join(harness.dataDir, "ghost")), false);

    const selected = await harness.request("/api/session/select", {
      method: "POST",
      skipUserHeader: true,
      body: {
        userId: "local"
      }
    });
    assert.equal(selected.response.status, 200);
    assert.equal(selected.body.session.userId, "local");
    assert.equal(fs.existsSync(planningDbPath(harness.dataDir, "local")), true);
  } finally {
    await harness.cleanup();
  }
});

test("invalid user headers return 400 and do not create data directories", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    const invalidIds = ["../x", "/absolute", "", "_reserved", "a".repeat(65), "has/slash", "has\\slash"];

    for (const userId of invalidIds) {
      const result = await harness.request("/api", {
        headers: {
          "x-cashflow-user-id": userId
        }
      });
      assert.equal(result.response.status, 400);
    }

    assert.equal(fs.existsSync(path.join(harness.dataDir, "..", "x")), false);
    assert.equal(fs.existsSync(path.join(harness.dataDir, "_reserved")), false);
  } finally {
    await harness.cleanup();
  }
});

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

test("settings route stores configurable timezone and falls back for invalid values", async () => withHarness(async harness => {
  const updated = await harness.api("/api/settings", {
    method: "PUT",
    body: {
      timezone: "America/New_York"
    }
  });

  assert.equal(updated.timezone, "America/New_York");

  const fallback = await harness.api("/api/settings", {
    method: "PUT",
    body: {
      timezone: "bad/timezone"
    }
  });

  assert.equal(fallback.timezone, "Europe/Warsaw");
}));
