import { calculateNextDate, todayWarsaw } from "./cashflow-date-utils.js";

export function createCashflowNotificationService({
  generateId,
  listLedgerYears,
  openLedgerDb,
  openPlanningDb
}) {
  function notificationDedupeSuffix(settings, type) {
    if (type !== "necessary_underfunded") {
      return todayWarsaw();
    }

    const repeatDays = Math.max(1, Number(settings?.necessary_underfunded_repeat_days || 1));
    const today = new Date(`${todayWarsaw()}T00:00:00Z`);
    const epochDay = Math.floor(today.getTime() / 86_400_000);
    const bucket = Math.floor(epochDay / repeatDays);

    return `bucket-${bucket}`;
  }

  async function sendQueuedNotifications(userId) {
    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
      if (!settings?.ntfy_url) return 0;

      const pending = db.prepare(`
        SELECT *
        FROM notification_queue
        WHERE sent_at IS NULL
        ORDER BY queued_at ASC
      `).all();

      if (!pending.length) return 0;

      let sent = 0;

      for (const notification of pending) {
        const response = await fetch(settings.ntfy_url, {
          method: "POST",
          headers: {
            "Title": notification.title,
            "Priority": notification.priority || "default",
            "Tags": "money"
          },
          body: notification.message
        });

        if (!response.ok) {
          throw new Error(`ntfy failed: ${response.status} ${response.statusText}`);
        }

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

  function queueDailyPendingSummary(userId) {
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

  function queueMissingIncomeNotifications(userId) {
    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
      if (!notificationEnabled(settings, "income_missing")) return 0;

      const today = todayWarsaw();
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

  function queueNotification(db, type, title, message, priority, entityId, dedupeKey, settings = null) {
    const suffix = settings ? notificationDedupeSuffix(settings, type) : todayWarsaw();
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

  function notificationEnabled(settings, type) {
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

  function notificationPriority(settings, type) {
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

  return {
    notificationEnabled,
    notificationPriority,
    queueDailyPendingSummary,
    queueMissingIncomeNotifications,
    queueNotification,
    sendQueuedNotifications
  };
}

