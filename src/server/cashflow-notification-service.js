import { DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { calculateNextDate, todayInTimezone } from "./cashflow-date-utils.js";
import { fetchWithTimeout, notificationFetchTimeoutMs } from "./cashflow-fetch-utils.js";
import { sendToNotificationDestination, pinnedNotificationRequest } from "./cashflow-notification-destination.js";

import {
  buildNotificationQueueRow as buildNotificationIntent,
  notificationDedupeSuffix as notificationDedupeSuffixForDate,
  notificationEnabled, notificationPriority
} from "../engine/cashflow-notification-intents.js";
export { notificationEnabled, notificationPriority };

// Server adapters retain historical clock defaults; the core requires explicit time.
export function notificationDedupeSuffix(settings, type) {
  return notificationDedupeSuffixForDate(settings, type, todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE));
}

export function buildNotificationQueueRow(options = {}) {
  return buildNotificationIntent({
    ...options,
    queuedAt: options.queuedAt ?? new Date().toISOString(),
    today: options.today ?? todayInTimezone(options.settings?.timezone || DEFAULT_TIMEZONE)
  });
}

/**
 * Splits an ntfy topic URL into a credential-free URL plus any auth embedded
 * in it. Node's built-in `fetch` refuses to send a request whose URL has
 * embedded userinfo ("Request cannot be constructed from a URL that includes
 * credentials"), so a URL like `https://:tk_xxx@ntfy.example.com/topic`
 * (ntfy's own documented way of putting an access token in a URL) must have
 * its credentials moved to an Authorization header before it can be fetched.
 * An empty username with a password is treated as a bearer token (matching
 * ntfy's `tk_...` access-token convention); a non-empty username is treated
 * as HTTP Basic auth.
 */
export function extractNtfyCredentialsFromUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return { cleanUrl: value, token: null, username: null, password: null };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { cleanUrl: value, token: null, username: null, password: null };
  }

  if (!parsed.username && !parsed.password) {
    return { cleanUrl: value, token: null, username: null, password: null };
  }

  const username = parsed.username ? decodeURIComponent(parsed.username) : "";
  const password = parsed.password ? decodeURIComponent(parsed.password) : "";
  parsed.username = "";
  parsed.password = "";

  const token = !username && password ? password : null;

  return {
    cleanUrl: parsed.toString(),
    token,
    username: username || null,
    password: !token && password ? password : null
  };
}

/** The ntfy URL with any embedded userinfo credentials stripped out. */
export function cleanNtfyUrl(url) {
  return extractNtfyCredentialsFromUrl(url).cleanUrl;
}

/**
 * Builds the Authorization header value for an ntfy request, preferring an
 * explicit `ntfy_auth_token` setting and falling back to credentials
 * embedded in `ntfy_url` (for configurations saved before the dedicated
 * token field existed).
 */
export function ntfyAuthorizationHeader(settings) {
  const explicitToken = String(settings?.ntfy_auth_token || "").trim();
  if (explicitToken) return `Bearer ${explicitToken}`;

  const { token, username, password } = extractNtfyCredentialsFromUrl(settings?.ntfy_url);
  if (token) return `Bearer ${token}`;
  if (username && password) return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  return null;
}

export function createCashflowNotificationService({
  budgetStore = null,
  fetchImpl = fetch,
  lookupHost,
  getGlobalOptions = async () => ({}),
  logError = () => {},
  generateId,
  listLedgerYears,
  openLedgerDb,
  openPlanningDb
}) {
  function usesPostgresBudgetStore() {
    return budgetStore?.backend === "postgres"
      && typeof budgetStore.listPlanningRows === "function"
      && typeof budgetStore.listConfirmedTransactions === "function"
      && typeof budgetStore.upsertNotifications === "function";
  }

  function canQueueWithBudgetStore() {
    return budgetStore?.backend === "postgres"
      && typeof budgetStore.upsertNotifications === "function";
  }

  function dateKey(value) {
    if (value instanceof Date) {
      const year = value.getFullYear();
      const month = String(value.getMonth() + 1).padStart(2, "0");
      const day = String(value.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }

    return String(value || "").slice(0, 10);
  }

  async function sendQueuedNotifications(userId) {
    if (
      budgetStore?.backend === "postgres"
      && typeof budgetStore.transaction === "function"
      && typeof budgetStore.listPlanningRows === "function"
    ) {
      return await sendQueuedNotificationsWithBudgetStore(userId);
    }

    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
      if (!notificationDestinationConfigured(settings)) return 0;

      const pending = db.prepare(`
        SELECT *
        FROM notification_queue
        WHERE sent_at IS NULL
        ORDER BY queued_at ASC
      `).all();

      if (!pending.length) return 0;

      let sent = 0;

      for (const notification of pending) {
        await sendNotification(settings, notification, channels => db.prepare(
          "UPDATE notification_queue SET sent_channels = ? WHERE id = ?").run(channels.join(","), notification.id));

        db.prepare(`
          UPDATE notification_queue
          SET sent_at = datetime('now')
          WHERE id = ?
        `).run(notification.id);

        sent += 1;
      }

      return sent;
    } finally {
      db.close();
    }
  }

  async function sendQueuedNotificationsWithBudgetStore(userId) {
    const settings = (await budgetStore.listPlanningRows(userId, "settings"))?.[0] || null;
    if (!notificationDestinationConfigured(settings)) return 0;

    let sent = 0;
    while (true) {
      const delivered = await budgetStore.transaction(async writer => {
        if (
          typeof writer.claimUnsentNotifications !== "function"
          || typeof writer.markNotificationsSent !== "function"
        ) {
          throw new Error("Postgres budget store does not support notification delivery claims");
        }

        const pending = await writer.claimUnsentNotifications(userId, { limit: 1 });
        const notification = pending[0] || null;
        if (!notification) return false;

        try {
          await sendNotification(settings, notification, async channels => {
            if (typeof writer.recordNotificationChannelsSent === "function") await writer.recordNotificationChannelsSent(userId, notification.id, channels);
          });
        } catch (error) {
          // Commit the channels that did receive it; the next run retries only the rest.
          return { error };
        }
        await writer.markNotificationsSent(userId, [notification.id]);
        return true;
      });

      if (delivered?.error) throw delivered.error;
      if (!delivered) break;
      sent += 1;
    }

    return sent;
  }

  function notificationChannel(settings) {
    const channel = String(settings?.notification_channel || "ntfy").trim().toLowerCase();
    return channel === "discord" ? "discord" : "ntfy";
  }

  /** Every chosen channel with a destination: notification_channels (any combination),
   * else the single notification_channel. */
  function notificationChannels(settings) {
    const chosen = settings?.notification_channels
      ? String(settings.notification_channels).split(",").map(item => item.trim()).filter(item => ["ntfy", "discord"].includes(item))
      : [notificationChannel(settings)];
    return chosen.filter(channel => channel === "discord" ? Boolean(settings?.discord_webhook_url) : Boolean(settings?.ntfy_url));
  }

  function notificationDestinationConfigured(settings) {
    return notificationChannels(settings).length > 0;
  }

  /** Sends to each chosen channel that has not received it yet; [recordSent] persists
   * progress after each one, so a failure does not repeat earlier deliveries. */
  async function sendNotification(settings, notification, recordSent = async () => {}) {
    const sent = String(notification.sent_channels || "").split(",").filter(Boolean);
    for (const channel of notificationChannels(settings)) {
      if (sent.includes(channel)) continue;
      try {
        await (channel === "discord" ? sendDiscordNotification(settings, notification) : sendNtfyNotification(settings, notification));
      } catch (error) {
        // Never log the destination, credentials, or financial notification body.
        logError("cashflow_notification_delivery_failed", { channel });
        throw error;
      }
      sent.push(channel);
      await recordSent(sent);
    }
  }

  // Re-read admin approval on every delivery; revoked exceptions must not linger.
  async function deliver(url, options, isNtfy) {
    const globalOptions = isNtfy ? await getGlobalOptions() : {};
    return fetchWithTimeout(url, options, notificationFetchTimeoutMs(), (destination, requestOptions) =>
      sendToNotificationDestination(destination, requestOptions, {
        lookupHost,
        allowedPrivateHosts: isNtfy ? globalOptions?.ntfy_allowed_private_hosts || [] : [],
        requestImpl: fetchImpl === fetch ? pinnedNotificationRequest : fetchImpl
      }));
  }

  async function sendNtfyNotification(settings, notification) {
    const url = cleanNtfyUrl(settings.ntfy_url);
    const authorization = ntfyAuthorizationHeader(settings);

    const response = await deliver(url, {
      method: "POST",
      headers: {
        "Title": notification.title,
        "Priority": notification.priority || "default",
        "Tags": "money",
        ...(authorization ? { "Authorization": authorization } : {})
      },
      body: notification.message
    }, true);

    if (!response.ok) {
      throw new Error(`ntfy failed: ${response.status} ${response.statusText}`);
    }
  }

  async function sendDiscordNotification(settings, notification) {
    const title = String(notification.title || "Cashflow");
    const message = String(notification.message || "");
    const content = `${title}\n${message}`.slice(0, 2000);
    const response = await deliver(settings.discord_webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content
      })
    }, false);

    if (!response.ok) {
      throw new Error(`discord webhook failed: ${response.status} ${response.statusText}`);
    }
  }

  async function queueDailyPendingSummary(userId) {
    if (usesPostgresBudgetStore()) {
      return await queueDailyPendingSummaryWithBudgetStore(userId);
    }

    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
      if (!notificationEnabled(settings, "pending_summary")) return 0;

      const count = db.prepare(`
        SELECT COUNT(*) AS count
        FROM pending_transactions
        WHERE status IN ('pending', 'partial', 'underfunded', 'funded')
      `).get().count;

      if (!count) return 0;

      queueNotification(
        db,
        "pending_summary",
        "Pending cashflow transactions",
        `${count} transaction(s) are waiting for confirmation.`,
        notificationPriority(settings, "pending_summary"),
        "pending_summary",
        "pending_summary",
        settings
      );

      return count;
    } finally {
      db.close();
    }
  }

  async function queueDailyPendingSummaryWithBudgetStore(userId) {
    const settings = (await budgetStore.listPlanningRows(userId, "settings"))?.[0] || null;
    if (!notificationEnabled(settings, "pending_summary")) return 0;

    const pendingRows = await budgetStore.listPlanningRows(userId, "pending_transactions");
    const count = pendingRows.filter(row =>
      ["pending", "partial", "underfunded", "funded"].includes(row.status)
    ).length;

    if (!count) return 0;

    await queueNotificationWithBudgetStore(
      userId,
      "pending_summary",
      "Pending cashflow transactions",
      `${count} transaction(s) are waiting for confirmation.`,
      notificationPriority(settings, "pending_summary"),
      "pending_summary",
      "pending_summary",
      settings
    );

    return count;
  }

  async function queueMissingIncomeNotifications(userId) {
    if (usesPostgresBudgetStore()) {
      return await queueMissingIncomeNotificationsWithBudgetStore(userId);
    }

    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
      if (!notificationEnabled(settings, "income_missing")) return 0;

      const today = todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE);
      const year = Number(today.slice(0, 4));
      const month = Number(today.slice(5, 7));

      const incomes = db.prepare(`
        SELECT *
        FROM recurring_incomes
        WHERE active = 1
      `).all();

      let queued = 0;

      for (const income of incomes) {
        const expectedDate = calculateNextDate(income, year, month);

        if (!expectedDate || expectedDate > today) continue;

        const pending = db.prepare(`
          SELECT id
          FROM pending_transactions
          WHERE source_recurring_income_id = ?
            AND date >= ?
          LIMIT 1
        `).get(income.id, expectedDate);

        if (pending) continue;

        let confirmed = false;

        for (const ledgerYear of listLedgerYears(userId)) {
          const ledgerDb = openLedgerDb(userId, ledgerYear);

          try {
            const row = ledgerDb.prepare(`
              SELECT id
              FROM confirmed_transactions
              WHERE source_recurring_income_id = ?
                AND date >= ?
              LIMIT 1
            `).get(income.id, expectedDate);

            if (row) confirmed = true;
          } finally {
            ledgerDb.close();
          }

          if (confirmed) break;
        }

        if (confirmed) continue;

        queueNotification(
          db,
          "income_missing",
          "Recurring income missing",
          `${income.name} expected on ${expectedDate} has not been confirmed.`,
          notificationPriority(settings, "income_missing"),
          income.id,
          `income_missing:${income.id}:${expectedDate}`,
          settings
        );

        queued += 1;
      }

      return queued;
    } finally {
      db.close();
    }
  }

  async function queueMissingIncomeNotificationsWithBudgetStore(userId) {
    const settings = (await budgetStore.listPlanningRows(userId, "settings"))?.[0] || null;
    if (!notificationEnabled(settings, "income_missing")) return 0;

    const today = todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE);
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const incomes = (await budgetStore.listPlanningRows(userId, "recurring_incomes"))
      .filter(income => Number(income.active) === 1 || income.active === true);
    const pendingRows = await budgetStore.listPlanningRows(userId, "pending_transactions");
    const confirmedRows = await budgetStore.listConfirmedTransactions(userId);

    let queued = 0;

    for (const income of incomes) {
      const expectedDate = calculateNextDate(income, year, month);

      if (!expectedDate || expectedDate > today) continue;

      const pending = pendingRows.some(row =>
        row.source_recurring_income_id === income.id
        && dateKey(row.date) >= expectedDate
      );

      if (pending) continue;

      const confirmed = confirmedRows.some(row =>
        row.source_recurring_income_id === income.id
        && dateKey(row.date) >= expectedDate
      );

      if (confirmed) continue;

      await queueNotificationWithBudgetStore(
        userId,
        "income_missing",
        "Recurring income missing",
        `${income.name} expected on ${expectedDate} has not been confirmed.`,
        notificationPriority(settings, "income_missing"),
        income.id,
        `income_missing:${income.id}:${expectedDate}`,
        settings
      );

      queued += 1;
    }

    return queued;
  }

  function queueNotification(db, type, title, message, priority, entityId, dedupeKey, settings = null) {
    const suffix = settings ? notificationDedupeSuffix(settings, type) : todayInTimezone();
    const finalDedupeKey = `${dedupeKey}:${suffix}`;

    db.prepare(`
      INSERT INTO notification_queue (
        id, notification_type, title, message, priority, entity_id, queued_at, dedupe_key
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
      ON CONFLICT(dedupe_key) DO UPDATE SET
        title = excluded.title,
        message = excluded.message,
        priority = excluded.priority,
        queued_at = datetime('now')
    `).run(
      generateId("notif"),
      type,
      title,
      message,
      priority || "default",
      entityId || null,
      finalDedupeKey
    );
  }

  async function queueNotificationAsync(userId, type, title, message, priority, entityId, dedupeKey, settings = null) {
    if (canQueueWithBudgetStore()) {
      await queueNotificationWithBudgetStore(
        userId,
        type,
        title,
        message,
        priority,
        entityId,
        dedupeKey,
        settings
      );
      return;
    }

    const db = openPlanningDb(userId);
    try {
      queueNotification(db, type, title, message, priority, entityId, dedupeKey, settings);
    } finally {
      db.close();
    }
  }

  async function queueNotificationWithBudgetStore(userId, type, title, message, priority, entityId, dedupeKey, settings = null) {
    await budgetStore.upsertNotifications(userId, [buildNotificationQueueRow({
      dedupeKey,
      entityId,
      generateId,
      message,
      priority,
      settings,
      title,
      type
    })]);
  }

  return {
    notificationEnabled,
    notificationPriority,
    queueDailyPendingSummary,
    queueMissingIncomeNotifications,
    queueNotification,
    queueNotificationAsync,
    sendQueuedNotifications
  };
}

