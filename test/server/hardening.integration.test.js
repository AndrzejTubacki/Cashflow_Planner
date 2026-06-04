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
