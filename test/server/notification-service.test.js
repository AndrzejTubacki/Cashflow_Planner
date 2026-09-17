import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildNotificationQueueRow,
  cleanNtfyUrl,
  createCashflowNotificationService,
  extractNtfyCredentialsFromUrl,
  notificationDedupeSuffix,
  ntfyAuthorizationHeader
} from "../../src/server/cashflow-notification-service.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";

test("notification row builder is backend-neutral and preserves dedupe semantics", () => {
  const settings = {
    necessary_underfunded_repeat_days: 7,
    timezone: "UTC"
  };
  const suffix = notificationDedupeSuffix(settings, "necessary_underfunded");
  const row = buildNotificationQueueRow({
    dedupeKey: "necessary_underfunded:rent",
    entityId: "rent",
    generateId: prefix => `${prefix}-row`,
    message: "Rent is underfunded.",
    priority: "high",
    queuedAt: "2026-01-01T00:00:00.000Z",
    settings,
    title: "Necessary transaction underfunded",
    type: "necessary_underfunded"
  });

  assert.match(suffix, /^bucket-\d+$/);
  assert.deepEqual(row, {
    dedupe_key: `necessary_underfunded:rent:${suffix}`,
    entity_id: "rent",
    id: "notif-row",
    message: "Rent is underfunded.",
    notification_type: "necessary_underfunded",
    priority: "high",
    queued_at: "2026-01-01T00:00:00.000Z",
    title: "Necessary transaction underfunded"
  });
});

// Regression coverage for a bug where ntfy URLs with an embedded access
// token (ntfy's own documented shape, e.g. https://:tk_xxx@host/topic) made
// every background notification send fail for months: Node's fetch refuses
// to construct a Request from a URL that has embedded credentials.

test("extractNtfyCredentialsFromUrl strips an empty-username access token embedded in the URL", () => {
  const result = extractNtfyCredentialsFromUrl("https://:tk_g5qdcly4l23ssxlpx8ys8wcwtqh68@ntfy.tubacki.pl/budget");
  assert.equal(result.cleanUrl, "https://ntfy.tubacki.pl/budget");
  assert.equal(result.token, "tk_g5qdcly4l23ssxlpx8ys8wcwtqh68");
  assert.equal(result.username, null);
  assert.equal(result.password, null);
});

test("extractNtfyCredentialsFromUrl treats a non-empty username as Basic auth", () => {
  const result = extractNtfyCredentialsFromUrl("https://alice:secret@ntfy.example.com/topic");
  assert.equal(result.cleanUrl, "https://ntfy.example.com/topic");
  assert.equal(result.token, null);
  assert.equal(result.username, "alice");
  assert.equal(result.password, "secret");
});

test("extractNtfyCredentialsFromUrl leaves a plain URL untouched", () => {
  const result = extractNtfyCredentialsFromUrl("https://ntfy.example.com/topic");
  assert.equal(result.cleanUrl, "https://ntfy.example.com/topic");
  assert.equal(result.token, null);
  assert.equal(result.username, null);
  assert.equal(result.password, null);
});

test("extractNtfyCredentialsFromUrl tolerates an empty or invalid URL", () => {
  assert.deepEqual(extractNtfyCredentialsFromUrl(""), { cleanUrl: "", token: null, username: null, password: null });
  assert.deepEqual(extractNtfyCredentialsFromUrl("not a url"), {
    cleanUrl: "not a url",
    token: null,
    username: null,
    password: null
  });
});

test("cleanNtfyUrl returns just the credential-free URL", () => {
  assert.equal(cleanNtfyUrl("https://:tk_abc@ntfy.example.com/topic"), "https://ntfy.example.com/topic");
  assert.equal(cleanNtfyUrl("https://ntfy.example.com/topic"), "https://ntfy.example.com/topic");
});

test("ntfyAuthorizationHeader prefers an explicit ntfy_auth_token setting", () => {
  const header = ntfyAuthorizationHeader({
    ntfy_auth_token: "tk_explicit",
    ntfy_url: "https://:tk_from_url@ntfy.example.com/topic"
  });
  assert.equal(header, "Bearer tk_explicit");
});

test("ntfyAuthorizationHeader falls back to a token embedded in ntfy_url", () => {
  const header = ntfyAuthorizationHeader({ ntfy_url: "https://:tk_from_url@ntfy.example.com/topic" });
  assert.equal(header, "Bearer tk_from_url");
});

test("ntfyAuthorizationHeader builds Basic auth from a username/password embedded in ntfy_url", () => {
  const header = ntfyAuthorizationHeader({ ntfy_url: "https://alice:secret@ntfy.example.com/topic" });
  assert.equal(header, `Basic ${Buffer.from("alice:secret").toString("base64")}`);
});

test("ntfyAuthorizationHeader returns null for a plain URL with no credentials and no token setting", () => {
  assert.equal(ntfyAuthorizationHeader({ ntfy_url: "https://ntfy.example.com/topic" }), null);
  assert.equal(ntfyAuthorizationHeader({}), null);
});

test("a credentialed ntfy URL crashes the real fetch Request constructor, but the cleaned URL plus header does not", () => {
  const dirty = "https://:tk_g5qdcly4l23ssxlpx8ys8wcwtqh68@ntfy.tubacki.pl/budget";

  // This is the exact failure mode seen in production logs:
  // "Request cannot be constructed from a URL that includes credentials".
  assert.throws(() => new Request(dirty), /credentials/i);

  const clean = cleanNtfyUrl(dirty);
  const authorization = ntfyAuthorizationHeader({ ntfy_url: dirty });

  assert.doesNotThrow(() => new Request(clean, {
    method: "POST",
    headers: { Authorization: authorization }
  }));
});

async function withTempPlanningDbService(fn) {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-notif-test-"));
  try {
    const paths = createCashflowStoragePaths(path.join(runtimeRoot, "data"));
    const dbService = createCashflowDbService({
      ledgerDbPath: paths.ledgerDbPath,
      planningDbPath: paths.planningDbPath,
      userDataDir: paths.userDataDir
    });
    return await fn(dbService);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

test("sendQueuedNotifications delivers to ntfy using a token embedded in the stored URL without crashing", async () => {
  await withTempPlanningDbService(async dbService => {
    const userId = "notif-user";
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, status: 200, statusText: "OK" };
    };

    const db = dbService.openPlanningDb(userId);
    try {
      db.prepare(`
        UPDATE settings
        SET notification_channel = 'ntfy', ntfy_url = ?
        WHERE id = 1
      `).run("https://:tk_g5qdcly4l23ssxlpx8ys8wcwtqh68@ntfy.tubacki.pl/budget");

      db.prepare(`
        INSERT INTO notification_queue (
          id, notification_type, title, message, priority, entity_id, queued_at, dedupe_key
        ) VALUES ('notif-1', 'pending_summary', 'Pending', 'You have pending rows', 'default', NULL, datetime('now'), 'dedupe-1')
      `).run();
    } finally {
      db.close();
    }

    const service = createCashflowNotificationService({
      fetchImpl,
      generateId: prefix => `${prefix}-id`,
      listLedgerYears: dbService.listLedgerYears,
      openLedgerDb: dbService.openLedgerDb,
      openPlanningDb: dbService.openPlanningDb
    });

    const sent = await service.sendQueuedNotifications(userId);

    assert.equal(sent, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://ntfy.tubacki.pl/budget");
    assert.equal(calls[0].url.includes("@"), false);
    assert.equal(calls[0].options.headers.Authorization, "Bearer tk_g5qdcly4l23ssxlpx8ys8wcwtqh68");

    const db2 = dbService.openPlanningDb(userId);
    try {
      const row = db2.prepare("SELECT sent_at FROM notification_queue WHERE id = 'notif-1'").get();
      assert.ok(row.sent_at);
    } finally {
      db2.close();
    }
  });
});

test("sendQueuedNotifications prefers an explicit ntfy_auth_token over any URL-embedded credentials", async () => {
  await withTempPlanningDbService(async dbService => {
    const userId = "notif-user-2";
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url: String(url), options });
      return { ok: true, status: 200, statusText: "OK" };
    };

    const db = dbService.openPlanningDb(userId);
    try {
      db.prepare(`
        UPDATE settings
        SET notification_channel = 'ntfy', ntfy_url = ?, ntfy_auth_token = ?
        WHERE id = 1
      `).run("https://ntfy.example.com/topic", "tk_configured");

      db.prepare(`
        INSERT INTO notification_queue (
          id, notification_type, title, message, priority, entity_id, queued_at, dedupe_key
        ) VALUES ('notif-1', 'pending_summary', 'Pending', 'You have pending rows', 'default', NULL, datetime('now'), 'dedupe-1')
      `).run();
    } finally {
      db.close();
    }

    const service = createCashflowNotificationService({
      fetchImpl,
      generateId: prefix => `${prefix}-id`,
      listLedgerYears: dbService.listLedgerYears,
      openLedgerDb: dbService.openLedgerDb,
      openPlanningDb: dbService.openPlanningDb
    });

    await service.sendQueuedNotifications(userId);

    assert.equal(calls[0].options.headers.Authorization, "Bearer tk_configured");
  });
});
