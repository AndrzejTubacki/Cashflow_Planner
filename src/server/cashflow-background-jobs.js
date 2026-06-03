import { DEFAULT_TIMEZONE, NOTIFICATION_DELIVERY_TIME } from "./cashflow-constants.js";
import { todayInTimezone, normalizeTimezone } from "./cashflow-date-utils.js";

export function createCashflowBackgroundJobs({
  getSettings,
  listCashflowUserIds,
  logError,
  logServerEvent,
  maybeRunAutomaticBackup,
  moveDueFutureTransactionsToPending,
  queueDailyPendingSummary,
  queueMissingIncomeNotifications,
  refreshNbpFxCacheForAllUsers,
  refreshNbpFxCacheForUser,
  sendQueuedNotifications
}) {
  const lastRunKeys = new Set();
  let tickRunning = false;

  function startBackgroundJobs() {
    setInterval(() => {
      tickPerUserJobs().catch(err => logError("cashflow_background_tick_failed", err));
    }, 60_000);
  }

  function localParts(timezone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: normalizeTimezone(timezone)
    }).formatToParts(new Date());

    const value = (type) => parts.find(p => p.type === type)?.value;

    return {
      date: `${value("year")}-${value("month")}-${value("day")}`,
      time: `${value("hour")}:${value("minute")}`
    };
  }

  function shouldRun(key) {
    if (lastRunKeys.has(key)) return false;

    lastRunKeys.add(key);
    if (lastRunKeys.size > 10_000) {
      for (const existing of [...lastRunKeys].slice(0, 2_000)) {
        lastRunKeys.delete(existing);
      }
    }

    return true;
  }

  async function tickPerUserJobs() {
    if (tickRunning) {
      logServerEvent("cashflow_background_tick_skipped", {
        reason: "previous_tick_still_running"
      });
      return { skipped: true };
    }

    tickRunning = true;
    try {
      const userIds = listCashflowUserIds();

      for (const userId of userIds) {
        try {
          const settings = getSettings(userId) || {};
          const timezone = settings.timezone || DEFAULT_TIMEZONE;
          const local = localParts(timezone);
          const today = todayInTimezone(timezone);

          if (local.time === "00:00" && shouldRun(`midnight:${userId}:${local.date}`)) {
            const created = moveDueFutureTransactionsToPending(userId, today);
            const pendingSummaryCount = queueDailyPendingSummary(userId);
            const missingIncomeCount = queueMissingIncomeNotifications(userId);

            logServerEvent("cashflow_midnight_job_completed", {
              userId,
              transactionsCreated: created,
              pendingSummaryCount,
              missingIncomeCount
            });
          }

          if (local.time === "08:00" && shouldRun(`fx:${userId}:${local.date}`)) {
            const result = typeof refreshNbpFxCacheForUser === "function"
              ? await refreshNbpFxCacheForUser(userId, today)
              : { users: await refreshNbpFxCacheForAllUsers(today) };
            logServerEvent("cashflow_fx_refresh_completed", {
              userId,
              result
            });
          }

          const deliveryTime = settings.notification_delivery_time || NOTIFICATION_DELIVERY_TIME;
          if (local.time === deliveryTime && shouldRun(`notify:${userId}:${local.date}:${deliveryTime}`)) {
            const sent = await sendQueuedNotifications(userId);
            if (sent) logServerEvent("cashflow_notifications_sent", { userId, sent });
          }

          if (local.time === "03:30" && shouldRun(`backup:${userId}:${local.date}`)) {
            const result = maybeRunAutomaticBackup(userId);
            if (result) {
              logServerEvent("cashflow_auto_backup_completed", { userId, ...result });
            }
          }
        } catch (err) {
          logError("cashflow_background_user_failed", {
            userId,
            error: err.message
          });
        }
      }

      return { skipped: false, users: userIds.length };
    } finally {
      tickRunning = false;
    }
  }

  return {
    startBackgroundJobs,
    tickPerUserJobs
  };
}
