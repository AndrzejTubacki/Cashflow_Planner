import assert from "node:assert/strict";
import Database from "better-sqlite3";
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
    useSession: true,
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
  assert.equal(otherUser.body.today, "2026-05-20");
  assert.equal(localUser.body.today, "2026-05-20");
}));

test("budget selector resolves through membership and legacy selector is deprecated", async () => withHarness(async harness => {
  await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "other_budget",
      displayName: "Other Budget"
    }
  });

  const selected = await harness.request("/api/session", {
    skipUserHeader: true,
    useSession: true,
    headers: {
      "x-cashflow-budget-id": "other_budget"
    }
  });
  assert.equal(selected.response.status, 200);
  assert.equal(selected.body.session.accountId, "other_budget");
  assert.equal(selected.body.session.budgetId, "other_budget");
  assert.equal(selected.body.session.budgetRole, "owner");
  assert.ok(selected.body.session.capabilities.includes("budget:read"));
  assert.equal(selected.response.headers.get("x-cashflow-deprecated"), null);

  const legacy = await harness.request("/api/session", {
    useSession: true,
    headers: {
      "x-cashflow-user-id": "other_budget"
    }
  });
  assert.equal(legacy.response.status, 200);
  assert.equal(legacy.response.headers.get("deprecation"), "true");
  assert.equal(legacy.response.headers.get("x-cashflow-deprecated"), "x-cashflow-user-id");

  const conflicting = await harness.request("/api", {
    headers: {
      "x-cashflow-budget-id": "other_budget",
      "x-cashflow-user-id": "local"
    }
  });
  assert.equal(conflicting.response.status, 400);
  assert.match(conflicting.body.error, /Conflicting budget selectors/);
}));

test("budget IDs resolve independently from immutable storage keys", async () => withHarness(async harness => {
  await harness.api("/api/users");
  const globalDb = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
  try {
    globalDb.transaction(() => {
      globalDb.pragma("defer_foreign_keys = ON");
      globalDb.prepare(`
        UPDATE budget_memberships
        SET budget_id = 'household-budget'
        WHERE budget_id = 'local'
      `).run();
      globalDb.prepare(`
        UPDATE budgets
        SET id = 'household-budget'
        WHERE id = 'local'
      `).run();
    })();
  } finally {
    globalDb.close();
  }

  const result = await harness.request("/api", {
    skipUserHeader: true,
    headers: {
      "x-cashflow-budget-id": "household-budget"
    }
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.session.budgetId, "household-budget");
  assert.equal(result.body.session.userId, "household-budget");
}));

test("system administrators cannot access budget data without membership", async () => withHarness(async harness => {
  await harness.api("/api/users");
  const globalDb = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
  try {
    globalDb.prepare(`
      INSERT INTO accounts (id, display_name, status, created_at, updated_at)
      VALUES ('local_owner_replacement', 'Replacement owner', 'active', datetime('now'), datetime('now'))
    `).run();
    globalDb.prepare(`
      UPDATE budget_memberships
      SET account_id = 'local_owner_replacement',
          updated_at = datetime('now')
      WHERE budget_id = 'local' AND account_id = 'legacy-admin' AND role = 'owner'
    `).run();
    assert.ok(globalDb.prepare(`
      SELECT 1 FROM account_global_roles
      WHERE account_id = 'legacy-admin' AND role = 'system_admin'
    `).get());
  } finally {
    globalDb.close();
  }

  const result = await harness.request("/api");
  assert.equal(result.response.status, 403);
  assert.match(result.body.error, /Budget access denied/);
}));

test("budget authorization blocks header, export, backup, and cross-budget row ID access", async () => withHarness(async harness => {
  await harness.api("/api/users");
  await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "private_budget",
      displayName: "Private budget"
    }
  });

  const privateRequest = {
    skipUserHeader: true,
    useSession: true,
    headers: {
      "x-cashflow-budget-id": "private_budget"
    }
  };
  const privateOneOff = await harness.api("/api/one-off", {
    ...privateRequest,
    method: "POST",
    body: {
      name: "Private row",
      type: "expense",
      amount: 25,
      currency: "PLN",
      date: "2026-06-10"
    }
  });
  await harness.api("/api/backup", {
    ...privateRequest,
    method: "POST"
  });
  const privateDb = harness.openPlanningDb("private_budget");
  const privateBackupId = privateDb.prepare(`
    SELECT id
    FROM backup_metadata
    WHERE success = 1
    ORDER BY created_at DESC
    LIMIT 1
  `).get().id;
  privateDb.close();

  const globalDb = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
  try {
    globalDb.prepare(`
      INSERT INTO accounts (id, display_name, status, created_at, updated_at)
      VALUES ('private_owner_replacement', 'Replacement owner', 'active', datetime('now'), datetime('now'))
    `).run();
    globalDb.prepare(`
      UPDATE budget_memberships
      SET account_id = 'private_owner_replacement',
          updated_at = datetime('now')
      WHERE budget_id = 'private_budget' AND account_id = 'private_budget' AND role = 'owner'
    `).run();
  } finally {
    globalDb.close();
  }

  for (const [pathname, method] of [
    ["/api", "GET"],
    ["/api/export/full", "GET"],
    [`/api/restore/${privateBackupId}`, "POST"]
  ]) {
    const denied = await harness.request(pathname, {
      ...privateRequest,
      method
    });
    assert.equal(denied.response.status, 403, `${method} ${pathname}`);
  }

  const crossBudgetRow = await harness.request(`/api/one-off/${privateOneOff.id}`, {
    method: "PUT",
    body: {
      name: "Should not cross budgets",
      type: "expense",
      amount: 25,
      currency: "PLN",
      date: "2026-06-10"
    }
  });
  assert.equal(crossBudgetRow.response.status, 404);

  const crossBudgetBackup = await harness.request(`/api/restore/${privateBackupId}`, {
    method: "POST"
  });
  assert.equal(crossBudgetBackup.response.status, 404);
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

test("invalid user creation ids return 400 without metadata or profile storage", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    const invalidIds = ["", "../x", "/absolute", "_reserved", "a".repeat(65), "has/slash", "has\\slash"];

    for (const userId of invalidIds) {
      const result = await harness.request("/api/users", {
        method: "POST",
        skipUserHeader: true,
        body: { userId }
      });
      assert.equal(result.response.status, 400, JSON.stringify(userId));
    }

    const globalDbPath = path.join(harness.dataDir, "cashflow-global.sqlite");
    if (fs.existsSync(globalDbPath)) {
      const db = new Database(globalDbPath);
      try {
        const invalidMetadata = db.prepare(`
          SELECT id
          FROM users
          WHERE id != 'local'
        `).all();
        assert.deepEqual(invalidMetadata, []);
      } finally {
        db.close();
      }
    }

    const profileDirs = fs.readdirSync(harness.dataDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    assert.deepEqual(profileDirs, []);
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

test("manual projection maintenance falls back to cached FX when provider refresh fails", async () => {
  const harness = await createCashflowTestHarness({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
    fxSnapshot: null
  });

  try {
    await harness.api("/api/settings", {
      method: "PUT",
      body: {
        future_periods: 2,
        fx_provider: "nbp",
        fx_used_currencies: ["EUR"],
        fx_buffer_percent: 0
      }
    });

    const db = harness.openPlanningDb();
    try {
      db.prepare(`
        INSERT INTO fx_rates_cache (
          base_currency, quote_currency, currency, rate_date, rate,
          effective_date, source, raw_json, updated_at
        ) VALUES (
          'EUR', 'PLN', 'EUR', ?, 4, ?, 'test-cache', '{}', datetime('now')
        )
      `).run(harness.today, harness.today);
    } finally {
      db.close();
    }

    await harness.api("/api/one-off", {
      method: "POST",
      body: {
        name: "Cached EUR future",
        currency: "EUR",
        amount: 10,
        type: "income",
        date: "2026-05-21"
      }
    });

    const regenerated = await harness.api("/api/regenerate-projections", {
      method: "POST",
      body: {}
    });

    assert.equal(regenerated.ok, true);
    assert.equal(regenerated._projection.fx_refresh.ok, false);
    assert.equal(regenerated._projection.fx_refresh.status, 504);
    assert.match(regenerated._projection.fx_refresh.error, /External request failed: fetch failed/);
    assert.ok(regenerated.futureTransactions.some(row =>
      row.name === "Cached EUR future" && row.ledger_amount === 40
    ));

    await harness.api("/api/one-off", {
      method: "POST",
      body: {
        name: "Cached EUR pending",
        currency: "EUR",
        amount: 5,
        type: "income",
        date: harness.today
      }
    });

    const recalculated = await harness.api("/api/pending/recalculate", {
      method: "POST",
      body: {}
    });

    assert.equal(recalculated.ok, true);
    assert.equal(recalculated._projection.fx_refresh.ok, false);
    assert.equal(recalculated._projection.fx_refresh.status, 504);
    assert.ok(recalculated.pendingTransactions.some(row =>
      row.name === "Cached EUR pending" && row.ledger_amount === 20
    ));
  } finally {
    await harness.cleanup();
  }
});

test("validation route reports malformed settings, stale sources, duplicate occurrences, and ledger drift", async () => withHarness(async harness => {
  await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Validation seed",
      currency: "PLN",
      amount: 100,
      type: "income",
      date: harness.today
    }
  });
  await harness.api("/api/run-jobs", {
    method: "POST",
    body: {}
  });
  const snapshot = await harness.api("/api");
  const pending = snapshot.pendingTransactions.find(row => row.name === "Validation seed");
  assert.ok(pending);
  await harness.api(`/api/pending/${encodeURIComponent(pending.id)}/confirm`, {
    method: "POST",
    body: {
      confirmed_date: harness.today,
      amount: 100
    }
  });

  const planningDb = harness.openPlanningDb();
  try {
    planningDb.prepare(`
      UPDATE settings
      SET ledger_currency = 'XXX',
          timezone = 'Not/A_Timezone',
          fx_used_currencies = '["NOPE"]',
          manual_fx_rates = '{"EUR/EUR":1}'
      WHERE id = 1
    `).run();
    planningDb.pragma("foreign_keys = OFF");
    planningDb.prepare(`
      INSERT INTO pending_transactions (
        id, name, currency, amount, type, date, source_one_off_id,
        ledger_currency, status, occurrence_key, created_at, updated_at
      )
      VALUES (
        'validation-stale-pending', 'Stale source', 'PLN', 1, 'expense', ?,
        'missing-one-off', 'PLN', 'pending', 'validation-duplicate-key',
        datetime('now'), datetime('now')
      )
    `).run(harness.today);
    planningDb.pragma("foreign_keys = ON");
  } finally {
    planningDb.close();
  }

  const ledgerDb = harness.openLedgerDb("2026");
  try {
    ledgerDb.prepare(`
      UPDATE confirmed_transactions
      SET running_balance_pln = running_balance_pln + 25,
          occurrence_key = 'validation-duplicate-key'
      WHERE name = 'Validation seed'
    `).run();
  } finally {
    ledgerDb.close();
  }

  const validation = await harness.api("/api/validate", {
    method: "POST",
    body: {}
  });

  assert.equal(validation.ok, false);
  const warningTypes = new Set(validation.warnings.map(warning => warning.type));
  assert.ok(warningTypes.has("malformed_setting"));
  assert.ok(warningTypes.has("stale_source_link"));
  assert.ok(warningTypes.has("duplicate_occurrence_key"));
  assert.ok(warningTypes.has("active_ledger_running_balance_drift"));
}));

test("confirmed ledger page route supports pagination and filters", async () => withHarness(async harness => {
  const insertPendingIncome = (id, date, amount) => {
    const db = harness.openPlanningDb();
    try {
      db.prepare(`
        INSERT INTO pending_transactions (
          id, name, currency, amount, type, date, fx_rate, buffered_fx_rate,
          ledger_currency, status, funded_amount, requested_amount, ledger_amount,
          occurrence_key, created_at, updated_at
        )
        VALUES (?, ?, 'PLN', ?, 'income', ?, 1, 1, 'PLN', 'pending', ?, ?, ?, ?, ?, ?)
      `).run(id, id, amount, date, amount, amount, amount, id, `${date}T00:00:00Z`, `${date}T00:00:00Z`);
    } finally {
      db.close();
    }
  };

  insertPendingIncome("page-income-2025", "2025-12-31", 10);
  await harness.api("/api/pending/page-income-2025/confirm", {
    method: "POST",
    body: { confirmed_date: "2025-12-31", amount: 10 }
  });
  insertPendingIncome("page-income-2026", "2026-01-02", 20);
  await harness.api("/api/pending/page-income-2026/confirm", {
    method: "POST",
    body: { confirmed_date: "2026-01-02", amount: 20 }
  });

  const firstPage = await harness.api("/api/ledger/confirmed?type=income&limit=1");
  assert.equal(firstPage.total, 2);
  assert.equal(firstPage.limit, 1);
  assert.equal(firstPage.offset, 0);
  assert.equal(firstPage.rows.length, 1);
  assert.equal(firstPage.rows[0].id, "page-income-2026");

  const secondPage = await harness.api("/api/ledger/confirmed?type=income&limit=1&offset=1");
  assert.equal(secondPage.rows.length, 1);
  assert.equal(secondPage.rows[0].id, "page-income-2025");

  const yearPage = await harness.api("/api/ledger/confirmed?year=2025");
  assert.equal(yearPage.total, 1);
  assert.equal(yearPage.rows[0].ledger_year, "2025");

  const missingYear = await harness.api("/api/ledger/confirmed?year=1999");
  assert.equal(missingYear.total, 0);
  assert.deepEqual(missingYear.rows, []);

  const invalid = await harness.request("/api/ledger/confirmed?limit=not-a-number");
  assert.equal(invalid.response.status, 400);
}));

test("settings route stores configurable timezone and rejects invalid values", async () => withHarness(async harness => {
  const updated = await harness.api("/api/settings", {
    method: "PUT",
    body: {
      timezone: "America/New_York"
    }
  });

  assert.equal(updated.timezone, "America/New_York");

  const rejected = await harness.request("/api/settings", {
    method: "PUT",
    body: {
      timezone: "bad/timezone"
    }
  });

  assert.equal(rejected.response.status, 400);
  assert.ok(rejected.body.details.some(detail => detail.field === "timezone"));

  const snapshot = await harness.api("/api");
  assert.equal(snapshot.settings.timezone, "America/New_York");
}));
