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

async function withHarness(fn) {
  const harness = await createCashflowTestHarness();
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

function setLocalPermissions(harness, permissions) {
  const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
  try {
    db.prepare("UPDATE users SET permissions = ? WHERE id = 'local'").run(JSON.stringify(permissions));
  } finally {
    db.close();
  }
}

test("operational endpoints require admin while normal user actions remain available", async () => withHarness(async harness => {
  await harness.api("/api/users");
  setLocalPermissions(harness, ["user"]);

  const operationalRequests = [
    ["/api/fx/refresh-all", {}],
    ["/api/fx/refresh", {}],
    ["/api/run-jobs", {}],
    ["/api/pending/recalculate", {}],
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
    assert.match(result.body.error, /Admin permission required/);
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
  assert.equal(settings.response.status, 200);
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
    [{ ntfy_url: "ftp://example.com/topic" }, "ntfy_url"],
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
  const currentTime = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC"
  }).format(new Date());

  const jobs = createCashflowBackgroundJobs({
    getSettings: () => ({ timezone: "UTC", notification_delivery_time: currentTime }),
    listCashflowUserIds: () => ["local"],
    logError: () => {},
    logServerEvent: (kind, details) => events.push({ kind, details }),
    maybeRunAutomaticBackup: () => null,
    moveDueFutureTransactionsToPending: () => 0,
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

  releaseNotifications();
  await first;
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

test("daily maintenance runs retention even when automatic backup is disabled", async () => {
  const cleaned = [];
  const jobs = createCashflowBackgroundJobs({
    cleanupOperationalData: (userId, reason) => cleaned.push({ userId, reason }),
    getSettings: () => ({
      timezone: "UTC",
      auto_backup_enabled: 0,
      notification_delivery_time: "12:00"
    }),
    listCashflowUserIds: () => ["local"],
    logError: () => {},
    logServerEvent: () => {},
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
