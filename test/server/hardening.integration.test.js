import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCashflowBackgroundJobs } from "../../src/server/cashflow-background-jobs.js";
import { fetchWithTimeout } from "../../src/server/cashflow-fetch-utils.js";
import { createCashflowGlobalService } from "../../src/server/cashflow-global-service.js";
import { createCashflowLedgerService } from "../../src/server/cashflow-ledger-service.js";
import { createCashflowFxCacheService } from "../../src/server/cashflow-fx-cache-service.js";
import { createCashflowNotificationService } from "../../src/server/cashflow-notification-service.js";
import { generateId } from "../../src/server/cashflow-id-utils.js";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

async function withHarness(fn, options = {}) {
  const harness = await createCashflowTestHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

function setLocalRole(harness, role, { systemAdmin = false } = {}) {
  const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
  try {
    db.prepare(`
      INSERT OR IGNORE INTO accounts (
        id, display_name, status, created_at, updated_at
      )
      VALUES ('role_test_owner', 'Role test owner', 'active', datetime('now'), datetime('now'))
    `).run();
    db.prepare(`
      UPDATE budget_memberships
      SET account_id = 'role_test_owner', updated_at = datetime('now')
      WHERE budget_id = 'local' AND account_id = 'legacy-admin'
    `).run();
    db.prepare(`
      INSERT INTO budget_memberships (
        budget_id, account_id, role, invited_by_account_id, created_at, updated_at
      )
      VALUES ('local', 'legacy-admin', ?, NULL, datetime('now'), datetime('now'))
    `).run(role);
    db.prepare(`
      INSERT OR IGNORE INTO account_global_roles (
        account_id, role, granted_by_account_id, created_at
      )
      VALUES ('role_test_owner', 'system_admin', NULL, datetime('now'))
    `).run();
    db.prepare("DELETE FROM account_global_roles WHERE account_id = 'legacy-admin'").run();
    if (systemAdmin) {
      db.prepare(`
        INSERT INTO account_global_roles (account_id, role, granted_by_account_id, created_at)
        VALUES ('legacy-admin', 'system_admin', NULL, datetime('now'))
      `).run();
    }
  } finally {
    db.close();
  }
}

test("budget and system operations require capabilities while editor actions remain available", async () => withHarness(async harness => {
  await harness.api("/api/users");
  setLocalRole(harness, "editor");

  const operationalRequests = [
    ["/api/fx/refresh-all", {}],
    ["/api/fx/refresh", {}],
    ["/api/run-jobs", {}],
    ["/api/pending/recalculate", {}],
    ["/api/ledger/compact-history", {}],
    ["/api/regenerate-projections", {}],
    ["/api/backup", {}],
    ["/api/restore/missing", {}],
    ["/api/validate", {}]
  ];

  for (const [pathname, body] of operationalRequests) {
    const result = await harness.request(pathname, {
      method: "POST",
      body
    });
    assert.equal(result.response.status, 403, pathname);
    assert.match(result.body.error, /permission required/i);
  }

  const oneOff = await harness.request("/api/one-off", {
    method: "POST",
    body: {
      name: "Non-admin allowed",
      currency: "PLN",
      amount: 10,
      type: "income",
      date: "2026-06-01"
    }
  });
  assert.equal(oneOff.response.status, 200);

  const settings = await harness.request("/api/settings", {
    method: "PUT",
    body: {
      future_periods: 4
    }
  });
  assert.equal(settings.response.status, 403);
}));

test("invalid currencies and impossible dates are rejected before writes", async () => withHarness(async harness => {
  const invalidSettings = await harness.request("/api/settings", {
    method: "PUT",
    body: {
      ledger_currency: "XXX"
    }
  });
  assert.equal(invalidSettings.response.status, 400);

  const invalidSetup = await harness.request("/api/setup", {
    method: "POST",
    body: {
      ledger_currency: "NOPE"
    }
  });
  assert.equal(invalidSetup.response.status, 400);

  const invalidOneOff = await harness.request("/api/one-off", {
    method: "POST",
    body: {
      name: "Bad date",
      currency: "PLN",
      amount: 1,
      type: "expense",
      date: "2026-02-31"
    }
  });
  assert.equal(invalidOneOff.response.status, 400);

  const invalidRecurringMonth = await harness.request("/api/recurring-expenses", {
    method: "POST",
    body: {
      name: "Bad month",
      currency: "PLN",
      amount: 1,
      repeat_every_months: 2,
      start_month_year: "2026-13"
    }
  });
  assert.equal(invalidRecurringMonth.response.status, 400);

  const invalidCsv = await harness.request("/api/import/one-offs-csv", {
    method: "POST",
    body: {
      csv: "name,type,amount,currency,date\nBad,expense,1,PLN,2026-02-31"
    }
  });
  assert.equal(invalidCsv.response.status, 400);

  const exported = await harness.api("/api/export/full");
  exported.planning.one_off_transactions.push({
    id: "bad-import-oneoff",
    name: "Bad import",
    currency: "XXX",
    amount: 1,
    type: "expense",
    date: "2026-06-01",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z"
  });
  const invalidFullImport = await harness.request("/api/import/full", {
    method: "POST",
    body: {
      mode: "replace",
      export: exported
    }
  });
  assert.equal(invalidFullImport.response.status, 400);
}));

test("normal planning creates reject caller IDs and malformed numeric or boolean values", async () => withHarness(async harness => {
  const createCases = [
    ["/api/recurring-expenses", { id: "caller-expense", name: "Expense", currency: "PLN", amount: 1 }],
    ["/api/recurring-incomes", { id: "caller-income", name: "Income", currency: "PLN", amount: 1 }],
    ["/api/goals", { id: "caller-goal", name: "Goal", currency: "PLN", amount: 1, due_date: "2026-06-01" }],
    ["/api/flex", { id: "caller-flex", name: "Flex", currency: "PLN", amount: 1 }],
    ["/api/one-off", { id: "caller-oneoff", name: "One-off", currency: "PLN", amount: 1, type: "expense", date: "2026-06-01" }]
  ];

  for (const [pathname, body] of createCases) {
    const result = await harness.request(pathname, { method: "POST", body });
    assert.equal(result.response.status, 400, pathname);
    assert.ok(result.body.details.some(detail => detail.field === "id" && detail.reason === "server_generated"));
  }

  const malformedCases = [
    ["/api/one-off", { name: "Bad", currency: "PLN", amount: "abc", type: "expense", date: "2026-06-01" }],
    ["/api/recurring-expenses", { name: "Bad", currency: "PLN", amount: -1 }],
    ["/api/recurring-incomes", { name: "Bad", currency: "PLN", amount: 1, active: "false" }],
    ["/api/goals", { name: "Bad", currency: "PLN", amount: 1, priority: 1.5, due_date: "2026-06-01" }],
    ["/api/flex", { name: "Bad", currency: "PLN", amount: 1, allow_split: "yes" }]
  ];

  for (const [pathname, body] of malformedCases) {
    const result = await harness.request(pathname, { method: "POST", body });
    assert.equal(result.response.status, 400, `${pathname}: ${JSON.stringify(body)}`);
  }

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Valid update target",
      currency: "PLN",
      amount: 10,
      type: "expense",
      date: "2026-06-01"
    }
  });
  const invalidUpdate = await harness.request(`/api/one-off/${encodeURIComponent(oneOff.id)}`, {
    method: "PUT",
    body: { amount: -1 }
  });
  assert.equal(invalidUpdate.response.status, 400);

  const snapshot = await harness.api("/api");
  assert.equal(snapshot.recurringExpenses.length, 0);
  assert.equal(snapshot.recurringIncomes.length, 0);
  assert.equal(snapshot.goals.length, 0);
  assert.equal(snapshot.flexTransactions.length, 0);
  assert.equal(snapshot.oneOffs.length, 1);
  assert.equal(snapshot.oneOffs[0].amount, 10);
}));

test("pair-rate routes respect manual and disabled provider semantics", async () => withHarness(async harness => {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      fx_provider: "manual",
      manual_fx_rates: {
        "EUR/USD": 1.25,
        "GBP/PLN": 5,
        "USD/PLN": 4
      }
    }
  });

  const direct = await harness.api("/api/fx/rate/EUR/USD");
  const inverse = await harness.api("/api/fx/rate/USD/EUR");
  const derived = await harness.api("/api/fx/rate/GBP/USD");
  const same = await harness.api("/api/fx/rate/EUR/EUR");
  assert.equal(direct.rate, 1.25);
  assert.equal(inverse.rate, 0.8);
  assert.equal(derived.rate, 1.25);
  assert.equal(same.rate, 1);
  assert.equal(same.source, "same-currency");
  const invalidDate = await harness.request("/api/fx/rate/EUR/USD/2026-02-31");
  assert.equal(invalidDate.response.status, 400);

  await harness.api("/api/settings", {
    method: "PUT",
    body: { fx_provider: "disabled" }
  });
  const disabled = await harness.request("/api/fx/rate/EUR/USD");
  assert.equal(disabled.response.status, 400);
  assert.match(disabled.body.error, /disabled/i);
}));

test("settings updates strictly reject malformed supported fields", async () => withHarness(async harness => {
  const invalidUpdates = [
    [{ future_periods: 0 }, "future_periods"],
    [{ future_periods: 1.5 }, "future_periods"],
    [{ future_periods: true }, "future_periods"],
    [{ future_periods: " " }, "future_periods"],
    [{ minimum_reserve_enabled: "yes" }, "minimum_reserve_enabled"],
    [{ minimum_reserve_amount: -1 }, "minimum_reserve_amount"],
    [{ ledger_history_compaction_months: 601 }, "ledger_history_compaction_months"],
    [{ ledger_history_compaction_months: 1.5 }, "ledger_history_compaction_months"],
    [{ fx_buffer_percent: 101 }, "fx_buffer_percent"],
    [{ fx_provider: "unknown" }, "fx_provider"],
    [{ fx_used_currencies: null }, "fx_used_currencies"],
    [{ fx_used_currencies: ["XXX"] }, "fx_used_currencies"],
    [{ manual_fx_rates: null }, "manual_fx_rates"],
    [{ manual_fx_rates: { "EUR/USD": 0 } }, "manual_fx_rates"],
    [{ manual_fx_rates: { PLN: 0 } }, "manual_fx_rates"],
    [{ manual_fx_rates: { "EUR/USD": true } }, "manual_fx_rates"],
    [{ manual_fx_rates: { "EUR/EUR": 1 } }, "manual_fx_rates"],
    [{ manual_fx_rates: "{bad" }, "manual_fx_rates"],
    [{ locale: "xx" }, "locale"],
    [{ timezone: "Not/A_Timezone" }, "timezone"],
    [{ holiday_country: "XX" }, "holiday_country"],
    [{ notification_channel: "sms" }, "notification_channel"],
    [{ ntfy_url: "ftp://example.com/topic" }, "ntfy_url"],
    [{ ntfy_auth_token: "x".repeat(501) }, "ntfy_auth_token"],
    [{ discord_webhook_url: "ftp://example.com/webhook" }, "discord_webhook_url"],
    [{ notification_delivery_time: "25:00" }, "notification_delivery_time"],
    [{ ntfy_priority_income_missing: "extreme" }, "ntfy_priority_income_missing"],
    [{ backup_interval_minutes: 0 }, "backup_interval_minutes"],
    [{ backup_retention_count: 0 }, "backup_retention_count"],
    [{ necessary_underfunded_repeat_days: 0 }, "necessary_underfunded_repeat_days"],
    [{ unsupported_setting: "ignored-before" }, "unsupported_setting"]
  ];

  for (const [body, field] of invalidUpdates) {
    const result = await harness.request("/api/settings", {
      method: "PUT",
      body
    });

    assert.equal(result.response.status, 400, JSON.stringify(body));
    assert.ok(result.body.details.some(detail => detail.field === field), JSON.stringify(result.body));
  }
}));

test("discord notification channel sends queued notifications through webhook JSON", async () => withHarness(async harness => {
  const calls = [];
  const notifications = createCashflowNotificationService({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 204, statusText: "No Content" };
    },
    generateId,
    listLedgerYears: harness.listLedgerYears,
    openLedgerDb: harness.openLedgerDb,
    openPlanningDb: harness.openPlanningDb
  });

  const db = harness.openPlanningDb();
  try {
    db.prepare(`
      UPDATE settings
      SET notification_channel = 'discord',
          discord_webhook_url = 'https://discord.example.test/api/webhooks/test'
      WHERE id = 1
    `).run();
    db.prepare(`
      INSERT INTO notification_queue (
        id, notification_type, title, message, priority, queued_at, dedupe_key
      ) VALUES (
        'discord-notification', 'pending_summary', 'Pending', 'Pending rows', 'default',
        datetime('now'), 'discord-notification'
      )
    `).run();
  } finally {
    db.close();
  }

  const sent = await notifications.sendQueuedNotifications(harness.userId);
  assert.equal(sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.example.test/api/webhooks/test");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    content: "Pending\nPending rows"
  });

  const check = harness.openPlanningDb();
  try {
    assert.ok(check.prepare("SELECT sent_at FROM notification_queue WHERE id = 'discord-notification'").get().sent_at);
  } finally {
    check.close();
  }
}));

test("ntfy notification channel sends using a token embedded in the stored URL", async () => withHarness(async harness => {
  const calls = [];
  const notifications = createCashflowNotificationService({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, statusText: "OK" };
    },
    generateId,
    listLedgerYears: harness.listLedgerYears,
    openLedgerDb: harness.openLedgerDb,
    openPlanningDb: harness.openPlanningDb
  });

  const db = harness.openPlanningDb();
  try {
    db.prepare(`
      UPDATE settings
      SET notification_channel = 'ntfy',
          ntfy_url = 'https://:tk_hardening_test@ntfy.example.test/topic'
      WHERE id = 1
    `).run();
    db.prepare(`
      INSERT INTO notification_queue (
        id, notification_type, title, message, priority, queued_at, dedupe_key
      ) VALUES (
        'ntfy-notification', 'pending_summary', 'Pending', 'Pending rows', 'default',
        datetime('now'), 'ntfy-notification'
      )
    `).run();
  } finally {
    db.close();
  }

  const sent = await notifications.sendQueuedNotifications(harness.userId);
  assert.equal(sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ntfy.example.test/topic");
  assert.equal(calls[0].options.headers.Authorization, "Bearer tk_hardening_test");

  const check = harness.openPlanningDb();
  try {
    assert.ok(check.prepare("SELECT sent_at FROM notification_queue WHERE id = 'ntfy-notification'").get().sent_at);
  } finally {
    check.close();
  }
}));

test("Postgres notification delivery claims one queued row per transaction", async () => {
  const calls = [];
  const marks = [];
  const claimedBatches = [
    [{
      id: "postgres-notification-a",
      message: "First rows",
      priority: "default",
      title: "First"
    }],
    [{
      id: "postgres-notification-b",
      message: "Second rows",
      priority: "default",
      title: "Second"
    }],
    []
  ];
  const notifications = createCashflowNotificationService({
    budgetStore: {
      backend: "postgres",
      async listPlanningRows(_budgetId, tableName) {
        assert.equal(tableName, "settings");
        return [{
          discord_webhook_url: "https://discord.example.test/api/webhooks/test",
          notification_channel: "discord"
        }];
      },
      async transaction(fn) {
        return await fn({
          async claimUnsentNotifications(_budgetId, options) {
            assert.deepEqual(options, { limit: 1 });
            return claimedBatches.shift();
          },
          async markNotificationsSent(_budgetId, ids) {
            marks.push(ids);
            return { updated: ids.length };
          }
        });
      }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 204, statusText: "No Content" };
    },
    generateId,
    listLedgerYears: () => [],
    openLedgerDb: () => {
      throw new Error("not used");
    },
    openPlanningDb: () => {
      throw new Error("not used");
    }
  });

  const sent = await notifications.sendQueuedNotifications("household");
  assert.equal(sent, 2);
  assert.deepEqual(marks, [["postgres-notification-a"], ["postgres-notification-b"]]);
  assert.deepEqual(calls.map(call => call.url), [
    "https://discord.example.test/api/webhooks/test",
    "https://discord.example.test/api/webhooks/test"
  ]);
});

test("notification queue helper uses Postgres budget-store upsert path", async () => {
  const queued = [];
  const notifications = createCashflowNotificationService({
    budgetStore: {
      backend: "postgres",
      async upsertNotifications(budgetId, rows) {
        assert.equal(budgetId, "household");
        queued.push(...rows);
        return { upserted: rows.length };
      }
    },
    generateId: () => "notif-postgres",
    listLedgerYears: () => [],
    openLedgerDb: () => {
      throw new Error("Postgres notification queue helper must not open SQLite ledger files");
    },
    openPlanningDb: () => {
      throw new Error("Postgres notification queue helper must not open SQLite planning files");
    }
  });

  await notifications.queueNotificationAsync(
    "household",
    "funding_shortfall",
    "Funding shortfall",
    "A transaction is short.",
    "high",
    "row-1",
    "funding_shortfall:row-1",
    { timezone: "UTC" }
  );

  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, "notif-postgres");
  assert.equal(queued[0].notification_type, "funding_shortfall");
  assert.match(queued[0].dedupe_key, /^funding_shortfall:row-1:\d{4}-\d{2}-\d{2}$/);
});

test("backup_location is constrained by CASHFLOW_BACKUP_ALLOWED_ROOTS", async () => withHarness(async harness => {
  const previous = process.env.CASHFLOW_BACKUP_ALLOWED_ROOTS;
  const allowedRoot = path.join(harness.dataDir, "allowed-backups");
  const outsideRoot = path.join(harness.dataDir, "outside-backups");
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });

  try {
    delete process.env.CASHFLOW_BACKUP_ALLOWED_ROOTS;
    const missingAllowList = await harness.request("/api/settings", {
      method: "PUT",
      body: {
        backup_location: path.join(allowedRoot, "user")
      }
    });
    assert.equal(missingAllowList.response.status, 400);

    process.env.CASHFLOW_BACKUP_ALLOWED_ROOTS = allowedRoot;
    const allowed = await harness.request("/api/settings", {
      method: "PUT",
      body: {
        backup_location: path.join(allowedRoot, "user")
      }
    });
    assert.equal(allowed.response.status, 200);

    const rejected = await harness.request("/api/settings", {
      method: "PUT",
      body: {
        backup_location: path.join(outsideRoot, "user")
      }
    });
    assert.equal(rejected.response.status, 400);
  } finally {
    if (previous === undefined) {
      delete process.env.CASHFLOW_BACKUP_ALLOWED_ROOTS;
    } else {
      process.env.CASHFLOW_BACKUP_ALLOWED_ROOTS = previous;
    }
  }
}));

test("external fetch timeout errors carry 504 status", async () => {
  const fetchImpl = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });

  await assert.rejects(
    () => fetchWithTimeout("https://example.invalid", {}, 20, fetchImpl),
    error => error.status === 504
  );
});

test("external fetch network errors carry 504 status", async () => {
  await assert.rejects(
    () => fetchWithTimeout("https://example.invalid", {}, 20, async () => {
      throw new TypeError("fetch failed");
    }),
    error => error.status === 504 && /External request failed: fetch failed/.test(error.message)
  );
});

test("NBP and Frankfurter provider timeouts carry 504 status", async () => {
  const previous = process.env.CASHFLOW_FX_FETCH_TIMEOUT_MS;
  process.env.CASHFLOW_FX_FETCH_TIMEOUT_MS = "20";
  const fetchImpl = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
  const fx = createCashflowFxCacheService({
    fetchImpl,
    getCurrentFxSnapshot: () => null,
    listCashflowUserIds: () => [],
    logCashflowError: () => {},
    logError: () => {},
    logServerEvent: () => {},
    normalizeCurrency: value => String(value || "").toUpperCase(),
    openPlanningDb: () => {
      throw new Error("not needed");
    },
    regenerateProjectionsAfterMutation: () => ({})
  });

  try {
    await assert.rejects(() => fx.fetchNbpRate("EUR"), error => error.status === 504);
    await assert.rejects(() => fx.fetchProviderRate("frankfurter", "EUR", null, "USD"), error => error.status === 504);
  } finally {
    if (previous === undefined) {
      delete process.env.CASHFLOW_FX_FETCH_TIMEOUT_MS;
    } else {
      process.env.CASHFLOW_FX_FETCH_TIMEOUT_MS = previous;
    }
  }
});

test("all-user FX refresh can enumerate budgets through async neutral lister", async () => {
  const fx = createCashflowFxCacheService({
    getCurrentFxSnapshot: () => null,
    listCashflowUserIds: () => {
      throw new Error("sync lister should not be used");
    },
    listCashflowUserIdsAsync: async () => [],
    logCashflowError: () => {},
    logError: () => {},
    logServerEvent: () => {},
    normalizeCurrency: value => String(value || "").toUpperCase(),
    openPlanningDb: () => {
      throw new Error("not needed");
    },
    regenerateProjectionsAfterMutation: () => ({})
  });

  assert.deepEqual(await fx.refreshNbpFxCacheForAllUsers(), []);
});

test("ntfy timeout leaves queued notifications unsent", async () => withHarness(async harness => {
  const previous = process.env.CASHFLOW_NOTIFICATION_FETCH_TIMEOUT_MS;
  process.env.CASHFLOW_NOTIFICATION_FETCH_TIMEOUT_MS = "20";
  const fetchImpl = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
  const notifications = createCashflowNotificationService({
    fetchImpl,
    generateId,
    listLedgerYears: () => [],
    openLedgerDb: () => {
      throw new Error("not needed");
    },
    openPlanningDb: harness.openPlanningDb
  });
  const db = harness.openPlanningDb();
  db.prepare("UPDATE settings SET ntfy_url = 'https://ntfy.example.test/topic' WHERE id = 1").run();
  db.prepare(`
    INSERT INTO notification_queue (
      id, notification_type, title, message, priority, queued_at, dedupe_key
    ) VALUES (
      'timeout-notification', 'pending_summary', 'Pending', 'Pending rows', 'default',
      datetime('now'), 'timeout-notification'
    )
  `).run();
  db.close();

  try {
    await assert.rejects(
      () => notifications.sendQueuedNotifications(harness.userId),
      error => error.status === 504
    );

    const check = harness.openPlanningDb();
    try {
      assert.equal(
        check.prepare("SELECT sent_at FROM notification_queue WHERE id = 'timeout-notification'").get().sent_at,
        null
      );
    } finally {
      check.close();
    }
  } finally {
    if (previous === undefined) {
      delete process.env.CASHFLOW_NOTIFICATION_FETCH_TIMEOUT_MS;
    } else {
      process.env.CASHFLOW_NOTIFICATION_FETCH_TIMEOUT_MS = previous;
    }
  }
}));

test("funding source SQL helpers reject unknown source columns", () => {
  const ledger = createCashflowLedgerService({
    listLedgerYears: () => [],
    openLedgerDb: () => null,
    openPlanningDb: () => null
  });

  assert.throws(
    () => ledger.sumConfirmedFunding("local", "source_goal_id; DROP TABLE goals", "x"),
    /Unsupported funding source column/
  );
  assert.throws(
    () => ledger.sumPendingFunding("local", "source_goal_id; DROP TABLE goals", "x"),
    /Unsupported funding source column/
  );
});

test("background tick skips overlap", async () => {
  const events = [];
  let releaseNotifications = null;

  const jobs = createCashflowBackgroundJobs({
    getSettings: () => ({ timezone: "UTC", notification_delivery_time: "08:00" }),
    listCashflowUserIds: () => ["local"],
    logError: () => {},
    logServerEvent: (kind, details) => events.push({ kind, details }),
    maybeRunAutomaticBackup: () => null,
    moveDueFutureTransactionsToPending: () => 0,
    now: () => new Date("2026-06-03T08:00:00.000Z"),
    queueDailyPendingSummary: () => 0,
    queueMissingIncomeNotifications: () => 0,
    refreshNbpFxCacheForAllUsers: async () => [],
    refreshNbpFxCacheForUser: async () => ({ updated_count: 0 }),
    sendQueuedNotifications: () => new Promise(resolve => {
      releaseNotifications = () => resolve(0);
    })
  });

  const first = jobs.tickPerUserJobs();
  const second = await jobs.tickPerUserJobs();
  assert.deepEqual(second, { skipped: true });
  assert.ok(events.some(event => event.kind === "cashflow_background_tick_skipped"));

  for (let index = 0; index < 20 && typeof releaseNotifications !== "function"; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof releaseNotifications, "function");
  releaseNotifications();
  await first;
});

test("background tick uses optional distributed lock service", async () => {
  const lockCalls = [];
  const sentUsers = [];
  const jobs = createCashflowBackgroundJobs({
    getSettings: () => ({ timezone: "UTC", notification_delivery_time: "08:00" }),
    listCashflowUserIds: () => ["local"],
    lockService: {
      withLock: async (name, work, options) => {
        lockCalls.push({ name, options });
        return { acquired: true, result: await work() };
      }
    },
    logError: () => {},
    logServerEvent: () => {},
    maybeRunAutomaticBackup: () => null,
    moveDueFutureTransactionsToPending: () => 0,
    now: () => new Date("2026-06-03T08:00:00.000Z"),
    queueDailyPendingSummary: () => 0,
    queueMissingIncomeNotifications: () => 0,
    refreshNbpFxCacheForAllUsers: async () => [],
    refreshNbpFxCacheForUser: async () => ({ updated_count: 0 }),
    sendQueuedNotifications: async userId => {
      sentUsers.push(userId);
      return 0;
    }
  });

  const result = await jobs.tickPerUserJobs();

  assert.deepEqual(result, { skipped: false, users: 1 });
  assert.deepEqual(lockCalls, [
    {
      name: "background:tick",
      options: { ttlMs: 55_000 }
    },
    {
      name: "budget:local:ledger-check",
      options: { ttlMs: 55_000 }
    },
    {
      name: "budget:local:fx-refresh",
      options: { ttlMs: 55_000 }
    },
    {
      name: "budget:local:notifications",
      options: { ttlMs: 55_000 }
    },
    {
      name: "budget:local:automatic-backup",
      options: { ttlMs: 55_000 }
    },
    {
      name: "budget:local:retention",
      options: { ttlMs: 55_000 }
    }
  ]);
  assert.deepEqual(sentUsers, ["local"]);
});

test("background tick skips work when optional distributed lock is unavailable", async () => {
  const events = [];
  const jobs = createCashflowBackgroundJobs({
    getSettings: () => {
      throw new Error("work should not run");
    },
    listCashflowUserIds: () => ["local"],
    lockService: {
      withLock: async () => ({ acquired: false })
    },
    logError: () => {},
    logServerEvent: (kind, details) => events.push({ kind, details }),
    maybeRunAutomaticBackup: () => null,
    moveDueFutureTransactionsToPending: () => 0,
    now: () => new Date("2026-06-03T08:00:00.000Z"),
    queueDailyPendingSummary: () => 0,
    queueMissingIncomeNotifications: () => 0,
    refreshNbpFxCacheForAllUsers: async () => [],
    refreshNbpFxCacheForUser: async () => ({ updated_count: 0 }),
    sendQueuedNotifications: async () => 0
  });

  const result = await jobs.tickPerUserJobs();

  assert.deepEqual(result, {
    skipped: true,
    reason: "distributed_lock_unavailable"
  });
  assert.ok(events.some(event =>
    event.kind === "cashflow_background_tick_skipped"
      && event.details.reason === "distributed_lock_unavailable"
  ));
});

test("background tick skips budget jobs when a job-specific distributed lock is unavailable", async () => {
  const events = [];
  let movedDue = 0;
  const jobs = createCashflowBackgroundJobs({
    getSettings: () => ({ timezone: "UTC", notification_delivery_time: "08:00" }),
    listCashflowUserIds: () => ["local"],
    lockService: {
      withLock: async (name, work, options) => {
        if (name === "background:tick") {
          return { acquired: true, result: await work(options) };
        }
        if (name === "budget:local:ledger-check") {
          return { acquired: false };
        }
        return { acquired: true, result: await work(options) };
      }
    },
    logError: () => {},
    logServerEvent: (kind, details) => events.push({ kind, details }),
    maybeRunAutomaticBackup: () => null,
    moveDueFutureTransactionsToPending: () => {
      movedDue += 1;
      return 1;
    },
    now: () => new Date("2026-06-03T08:00:00.000Z"),
    queueDailyPendingSummary: () => 0,
    queueMissingIncomeNotifications: () => 0,
    refreshNbpFxCacheForAllUsers: async () => [],
    refreshNbpFxCacheForUser: async () => ({ updated_count: 0 }),
    sendQueuedNotifications: async () => 0
  });

  assert.deepEqual(await jobs.tickPerUserJobs(), { skipped: false, users: 1 });
  assert.equal(movedDue, 0);
  assert.ok(events.some(event =>
    event.kind === "cashflow_background_job_lock_skipped"
      && event.details.jobName === "midnight"
      && event.details.lockName === "budget:local:ledger-check"
  ));
});

test("route-triggered projection regeneration uses optional budget projection lock", async () => {
  const lockCalls = [];
  await withHarness(async harness => {
    const result = await harness.api("/api/regenerate-projections", {
      method: "POST",
      body: {}
    });

    assert.equal(result.ok, true);
    assert.equal(result._projection.projection_ok, true);
    assert.ok(lockCalls.some(call =>
      call.name === "budget:local:projection"
        && call.options.ttlMs === 120_000
    ));
  }, {
    lockService: {
      withLock: async (name, work, options) => {
        lockCalls.push({ name, options });
        return { acquired: true, result: await work() };
      }
    }
  });
});

test("route-triggered pending recalculation locks the whole recalculation once", async () => {
  const lockCalls = [];
  await withHarness(async harness => {
    const result = await harness.api("/api/pending/recalculate", {
      method: "POST",
      body: {}
    });

    assert.equal(result.ok, true);
    assert.deepEqual(lockCalls.map(call => ({
      name: call.name,
      ttlMs: call.options.ttlMs
    })), [
      { name: "budget:local:projection", ttlMs: 120_000 }
    ]);
  }, {
    lockService: {
      withLock: async (name, work, options) => {
        lockCalls.push({ name, options });
        return { acquired: true, result: await work() };
      }
    }
  });
});

test("route-triggered budget maintenance uses optional budget locks", async () => {
  const lockCalls = [];
  await withHarness(async harness => {
    const backup = await harness.api("/api/backup", {
      method: "POST",
      body: {}
    });
    assert.equal(backup.ok, true);

    const compaction = await harness.api("/api/ledger/compact-history", {
      method: "POST",
      body: { months: 0 }
    });
    assert.equal(compaction.compaction.enabled, false);

    assert.deepEqual(lockCalls.map(call => ({
      name: call.name,
      ttlMs: call.options.ttlMs
    })), [
      { name: "budget:local:automatic-backup", ttlMs: 300_000 },
      { name: "budget:local:retention", ttlMs: 120_000 }
    ]);
  }, {
    lockService: {
      withLock: async (name, work, options) => {
        lockCalls.push({ name, options });
        return { acquired: true, result: await work() };
      }
    }
  });
});

test("route-triggered budget maintenance returns conflict when optional budget lock is unavailable", async () => {
  await withHarness(async harness => {
    const result = await harness.request("/api/backup", {
      method: "POST",
      body: {}
    });

    assert.equal(result.response.status, 409);
    assert.equal(result.body.error, "Backup is already running");
    assert.equal(result.body.details[0].lock, "budget:local:automatic-backup");
  }, {
    lockService: {
      withLock: async () => ({ acquired: false })
    }
  });
});

test("background tick isolates one user's timeout and continues with later users", async () => {
  const errors = [];
  const sentUsers = [];
  const timeout = new Error("External request timed out");
  timeout.status = 504;
  const jobs = createCashflowBackgroundJobs({
    getSettings: () => ({ timezone: "UTC", notification_delivery_time: "08:00" }),
    listCashflowUserIds: () => ["timeout_user", "healthy_user"],
    logError: (kind, details) => errors.push({ kind, details }),
    logServerEvent: () => {},
    maybeRunAutomaticBackup: () => null,
    moveDueFutureTransactionsToPending: () => 0,
    now: () => new Date("2026-06-03T08:00:00.000Z"),
    queueDailyPendingSummary: () => 0,
    queueMissingIncomeNotifications: () => 0,
    refreshNbpFxCacheForAllUsers: async () => [],
    refreshNbpFxCacheForUser: async () => ({ updated_count: 0 }),
    sendQueuedNotifications: async userId => {
      sentUsers.push(userId);
      if (userId === "timeout_user") throw timeout;
      return 1;
    }
  });

  const result = await jobs.tickPerUserJobs();

  assert.deepEqual(result, { skipped: false, users: 2 });
  assert.deepEqual(sentUsers, ["timeout_user", "healthy_user"]);
  assert.ok(errors.some(item =>
    item.kind === "cashflow_background_user_failed"
      && item.details.userId === "timeout_user"
      && item.details.error === "External request timed out"
  ));
});

test("background tick catches up overdue daily jobs and persists success across scheduler instances", async () => withHarness(async harness => {
  const calls = [];
  const events = [];
  const makeJobs = () => createCashflowBackgroundJobs({
    cleanupOperationalData: (userId, reason) => calls.push(["cleanup", userId, reason]),
    getSettings: () => ({
      timezone: "UTC",
      auto_backup_enabled: 0,
      notification_delivery_time: "08:00"
    }),
    listCashflowUserIds: () => [harness.userId],
    logError: () => {},
    logServerEvent: (kind, details) => events.push({ kind, details }),
    maybeRunAutomaticBackup: () => null,
    moveDueFutureTransactionsToPending: userId => {
      calls.push(["midnight", userId]);
      return 0;
    },
    now: () => new Date("2026-06-03T08:05:00.000Z"),
    openPlanningDb: harness.openPlanningDb,
    queueDailyPendingSummary: userId => {
      calls.push(["pending-summary", userId]);
      return 0;
    },
    queueMissingIncomeNotifications: userId => {
      calls.push(["missing-income", userId]);
      return 0;
    },
    refreshNbpFxCacheForAllUsers: async () => [],
    refreshNbpFxCacheForUser: async userId => {
      calls.push(["fx", userId]);
      return { updated_count: 0 };
    },
    sendQueuedNotifications: async userId => {
      calls.push(["notify", userId]);
      return 0;
    }
  });

  await makeJobs().tickPerUserJobs();
  assert.deepEqual(calls, [
    ["midnight", harness.userId],
    ["pending-summary", harness.userId],
    ["missing-income", harness.userId],
    ["fx", harness.userId],
    ["notify", harness.userId],
    ["cleanup", harness.userId, "daily_maintenance"]
  ]);
  assert.ok(events.some(event => event.kind === "cashflow_midnight_job_completed"));
  assert.ok(events.some(event => event.kind === "cashflow_fx_refresh_completed"));

  await makeJobs().tickPerUserJobs();
  assert.deepEqual(calls, [
    ["midnight", harness.userId],
    ["pending-summary", harness.userId],
    ["missing-income", harness.userId],
    ["fx", harness.userId],
    ["notify", harness.userId],
    ["cleanup", harness.userId, "daily_maintenance"]
  ]);

  const db = harness.openPlanningDb();
  try {
    const persisted = db.prepare(`
      SELECT entity_type, entity_id
      FROM event_log
      WHERE action = 'background_job_success'
      ORDER BY entity_type, entity_id
    `).all();
    assert.deepEqual(persisted, [
      { entity_type: "background_job:fx", entity_id: "2026-06-03" },
      { entity_type: "background_job:maintenance", entity_id: "2026-06-03" },
      { entity_type: "background_job:midnight", entity_id: "2026-06-03:08:00" },
      { entity_type: "background_job:notify", entity_id: "2026-06-03:catchup:08:00" }
    ]);
  } finally {
    db.close();
  }
}));

test("background tick can persist daily run markers through the async budget store", async () => {
  const calls = [];
  const eventRows = [];
  const makeJobs = () => createCashflowBackgroundJobs({
    budgetStore: {
      async listPlanningRows(budgetId, tableName) {
        assert.equal(budgetId, "budget-1");
        assert.equal(tableName, "event_log");
        return eventRows;
      },
      async insertPlanningRows(budgetId, tableName, rows) {
        assert.equal(budgetId, "budget-1");
        assert.equal(tableName, "event_log");
        eventRows.push(...rows.map(row => ({ ...row })));
        return { inserted: rows.length };
      }
    },
    cleanupOperationalData: (userId, reason) => calls.push(["cleanup", userId, reason]),
    getSettings: () => {
      throw new Error("sync settings should not be read when getSettingsAsync is available");
    },
    getSettingsAsync: async userId => {
      assert.equal(userId, "budget-1");
      return {
        timezone: "UTC",
        auto_backup_enabled: 0,
        notification_delivery_time: "08:00"
      };
    },
    listCashflowUserIds: () => {
      throw new Error("sync budget listing should not be used when async listing is available");
    },
    listCashflowUserIdsAsync: async () => ["budget-1"],
    logError: () => {},
    logServerEvent: () => {},
    maybeRunAutomaticBackup: () => null,
    moveDueFutureTransactionsToPending: userId => {
      calls.push(["midnight", userId]);
      return 0;
    },
    now: () => new Date("2026-06-03T08:05:00.000Z"),
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async background run markers");
    },
    queueDailyPendingSummary: userId => {
      calls.push(["pending-summary", userId]);
      return 0;
    },
    queueMissingIncomeNotifications: userId => {
      calls.push(["missing-income", userId]);
      return 0;
    },
    refreshNbpFxCacheForAllUsers: async () => [],
    refreshNbpFxCacheForUser: async userId => {
      calls.push(["fx", userId]);
      return { updated_count: 0 };
    },
    sendQueuedNotifications: async userId => {
      calls.push(["notify", userId]);
      return 0;
    }
  });

  await makeJobs().tickPerUserJobs();
  await makeJobs().tickPerUserJobs();

  assert.deepEqual(calls, [
    ["midnight", "budget-1"],
    ["pending-summary", "budget-1"],
    ["missing-income", "budget-1"],
    ["fx", "budget-1"],
    ["notify", "budget-1"],
    ["cleanup", "budget-1", "daily_maintenance"]
  ]);
  assert.deepEqual(
    eventRows.map(row => ({ entity_type: row.entity_type, entity_id: row.entity_id })).sort((a, b) =>
      `${a.entity_type}:${a.entity_id}`.localeCompare(`${b.entity_type}:${b.entity_id}`)
    ),
    [
      { entity_type: "background_job:fx", entity_id: "2026-06-03" },
      { entity_type: "background_job:maintenance", entity_id: "2026-06-03" },
      { entity_type: "background_job:midnight", entity_id: "2026-06-03:08:00" },
      { entity_type: "background_job:notify", entity_id: "2026-06-03:catchup:08:00" }
    ]
  );
});

test("automatic backup scheduling checks the configured interval on ordinary ticks", async () => {
  const backups = [];
  const jobs = createCashflowBackgroundJobs({
    cleanupOperationalData: () => {},
    getSettings: () => ({
      timezone: "UTC",
      auto_backup_enabled: 1,
      backup_interval_minutes: 30,
      notification_delivery_time: "23:59"
    }),
    listCashflowUserIds: () => ["local"],
    logError: () => {},
    logServerEvent: () => {},
    maybeRunAutomaticBackup: userId => {
      backups.push(userId);
      return null;
    },
    moveDueFutureTransactionsToPending: () => 0,
    now: () => new Date("2026-06-03T10:17:00.000Z"),
    queueDailyPendingSummary: () => 0,
    queueMissingIncomeNotifications: () => 0,
    refreshNbpFxCacheForAllUsers: async () => [],
    refreshNbpFxCacheForUser: async () => ({ updated_count: 0 }),
    sendQueuedNotifications: async () => 0
  });

  await jobs.tickPerUserJobs();
  assert.deepEqual(backups, ["local"]);
});

test("daily maintenance runs retention even when automatic backup is disabled", async () => {
  const cleaned = [];
  const compacted = [];
  const events = [];
  const jobs = createCashflowBackgroundJobs({
    cleanupOperationalData: (userId, reason) => cleaned.push({ userId, reason }),
    compactLedgerHistory: async userId => {
      compacted.push(userId);
      return { compactedRows: 2, createdRows: 1, cutoffDate: "2025-06-03" };
    },
    getSettings: () => ({
      timezone: "UTC",
      auto_backup_enabled: 0,
      notification_delivery_time: "12:00"
    }),
    listCashflowUserIds: () => ["local"],
    logError: () => {},
    logServerEvent: (kind, details) => events.push({ kind, details }),
    maybeRunAutomaticBackup: () => null,
    moveDueFutureTransactionsToPending: () => 0,
    now: () => new Date("2026-06-03T03:30:00.000Z"),
    queueDailyPendingSummary: () => 0,
    queueMissingIncomeNotifications: () => 0,
    refreshNbpFxCacheForAllUsers: async () => [],
    refreshNbpFxCacheForUser: async () => ({ updated_count: 0 }),
    sendQueuedNotifications: async () => 0
  });

  await jobs.tickPerUserJobs();
  assert.deepEqual(cleaned, [{ userId: "local", reason: "daily_maintenance" }]);
  assert.deepEqual(compacted, ["local"]);
  assert.ok(events.some(event =>
    event.kind === "cashflow_ledger_history_compacted" &&
    event.details.userId === "local" &&
    event.details.compactedRows === 2
  ));
});

test("failed user creation removes global metadata so retry is not blocked", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-global-test-"));
  const dataDir = path.join(runtimeRoot, "data");
  let shouldFail = true;

  try {
    const service = createCashflowGlobalService({
      cashflowUserStorageExists: () => false,
      dataDir,
      listCashflowUserIds: () => [],
      normalizeLocale: value => String(value || "en"),
      openPlanningDb: () => {
        if (shouldFail) throw new Error("planning init failed");
        return {
          prepare: () => ({ run: () => {} }),
          close: () => {}
        };
      }
    });

    assert.throws(() => service.createUser({ userId: "retry_user" }), /planning init failed/);

    const db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
    try {
      const row = db.prepare("SELECT id FROM users WHERE id = 'retry_user'").get();
      assert.equal(row, undefined);
    } finally {
      db.close();
    }

    shouldFail = false;
    const session = service.createUser({ userId: "retry_user" });
    assert.equal(session.userId, "retry_user");
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("failed user creation removes physical profile storage so retry is not blocked", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-global-test-"));
  const dataDir = path.join(runtimeRoot, "data");
  let failAfterStorageCreate = true;
  const openCounts = new Map();
  const userDir = userId => path.join(dataDir, userId);

  try {
    const service = createCashflowGlobalService({
      cashflowUserStorageExists: userId => fs.existsSync(userDir(userId)),
      dataDir,
      deleteCashflowUserStorage: userId => {
        fs.rmSync(userDir(userId), { recursive: true, force: true });
      },
      listCashflowUserIds: () => fs.existsSync(dataDir)
        ? fs.readdirSync(dataDir).filter(name => fs.statSync(path.join(dataDir, name)).isDirectory())
        : [],
      normalizeLocale: value => String(value || "en"),
      openPlanningDb: userId => {
        fs.mkdirSync(userDir(userId), { recursive: true });
        const count = (openCounts.get(userId) || 0) + 1;
        openCounts.set(userId, count);
        if (failAfterStorageCreate && userId === "retry_storage_user" && count >= 2) {
          throw new Error("defaults failed after storage");
        }
        return {
          prepare: () => ({ run: () => {} }),
          close: () => {}
        };
      }
    });

    assert.throws(
      () => service.createUser({ userId: "retry_storage_user" }),
      /defaults failed after storage/
    );
    assert.equal(fs.existsSync(userDir("retry_storage_user")), false);

    const db = new Database(path.join(dataDir, "cashflow-global.sqlite"));
    try {
      assert.equal(db.prepare("SELECT id FROM users WHERE id = 'retry_storage_user'").get(), undefined);
      assert.equal(db.prepare("SELECT id FROM budgets WHERE id = 'retry_storage_user'").get(), undefined);
      assert.equal(db.prepare("SELECT id FROM accounts WHERE id = 'retry_storage_user'").get(), undefined);
    } finally {
      db.close();
    }

    failAfterStorageCreate = false;
    const session = service.createUser({ userId: "retry_storage_user" });
    assert.equal(session.userId, "retry_storage_user");
    assert.equal(fs.existsSync(userDir("retry_storage_user")), true);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});
