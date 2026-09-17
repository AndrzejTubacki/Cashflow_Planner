import { DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { calculateNextDate, todayInTimezone } from "./cashflow-date-utils.js";
import { fetchWithTimeout, notificationFetchTimeoutMs } from "./cashflow-fetch-utils.js";

export function notificationDedupeSuffix(settings, type) {
  if (type !== "necessary_underfunded") {
    return todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE);
  }

  const repeatDays = Math.max(1, Number(settings?.necessary_underfunded_repeat_days || 1));
  const today = new Date(`${todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE)}T00:00:00Z`);
  const epochDay = Math.floor(today.getTime() / 86_400_000);
  const bucket = Math.floor(epochDay / repeatDays);

  return `bucket-${bucket}`;
}

export function buildNotificationQueueRow({
  dedupeKey,
  entityId = null,
  generateId,
  message,
  priority = "default",
  queuedAt = new Date().toISOString(),
  settings = null,
  title,
  type
} = {}) {
  if (typeof generateId !== "function") {
    throw new Error("generateId is required to build notification rows");
  }
  const suffix = settings ? notificationDedupeSuffix(settings, type) : todayInTimezone();
  return {
    dedupe_key: `${dedupeKey}:${suffix}`,
    entity_id: entityId || null,
    id: generateId("notif"),
    message,
    notification_type: type,
    priority: priority || "default",
    queued_at: queuedAt,
    title
  };
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

export function notificationEnabled(settings, type) {
  const map = {
    goal_impossible: "notify_goal_impossible",
    necessary_underfunded: "notify_necessary_underfunded",
    funding_shortfall: "notify_funding_shortfall",
    income_missing: "notify_income_missing",
    pending_summary: "notify_pending_summary",
    goal_funded: "notify_goal_funded",
    fx_changed: "notify_fx_changed"
  };

  return Number(settings?.[map[type]]) === 1;
}

export function notificationPriority(settings, type) {
  const map = {
    goal_impossible: "ntfy_priority_goal_impossible",
    necessary_underfunded: "ntfy_priority_necessary_underfunded",
    funding_shortfall: "ntfy_priority_funding_shortfall",
    income_missing: "ntfy_priority_income_missing",
    pending_summary: "ntfy_priority_pending_summary",
    goal_funded: "ntfy_priority_goal_funded",
    fx_changed: "ntfy_priority_fx_changed"
  };

  return settings?.[map[type]] || "default";
}

export function createCashflowNotificationService({
  budgetStore = null,
  fetchImpl = fetch,
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
        await sendNotification(settings, notification);

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

        await sendNotification(settings, notification);
        await writer.markNotificationsSent(userId, [notification.id]);
        return true;
      });

      if (!delivered) break;
      sent += 1;
    }

    return sent;
  }

  function notificationChannel(settings) {
    const channel = String(settings?.notification_channel || "ntfy").trim().toLowerCase();
    return channel === "discord" ? "discord" : "ntfy";
  }

  function notificationDestinationConfigured(settings) {
    return notificationChannel(settings) === "discord"
      ? Boolean(settings?.discord_webhook_url)
      : Boolean(settings?.ntfy_url);
  }

  async function sendNotification(settings, notification) {
    return notificationChannel(settings) === "discord"
      ? sendDiscordNotification(settings, notification)
      : sendNtfyNotification(settings, notification);
  }

  async function sendNtfyNotification(settings, notification) {
    const url = cleanNtfyUrl(settings.ntfy_url);
    const authorization = ntfyAuthorizationHeader(settings);

    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Title": notification.title,
        "Priority": notification.priority || "default",
        "Tags": "money",
        ...(authorization ? { "Authorization": authorization } : {})
      },
      body: notification.message
    }, notificationFetchTimeoutMs(), fetchImpl);

    if (!response.ok) {
      throw new Error(`ntfy failed: ${response.status} ${response.statusText}`);
    }
  }

  async function sendDiscordNotification(settings, notification) {
    const title = String(notification.title || "Cashflow");
    const message = String(notification.message || "");
    const content = `${title}\n${message}`.slice(0, 2000);
    const response = await fetchWithTimeout(settings.discord_webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content
      })
    }, notificationFetchTimeoutMs(), fetchImpl);

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

