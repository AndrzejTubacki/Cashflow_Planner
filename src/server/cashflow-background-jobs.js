import {
  CASHFLOW_TIMEZONE,
  NOTIFICATION_DELIVERY_TIME
} from "./cashflow-constants.js";
import { todayWarsaw } from "./cashflow-date-utils.js";

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
  sendQueuedNotifications
}) {
  function startBackgroundJobs() {
    scheduleJob("0 0 * * *", CASHFLOW_TIMEZONE, async () => {
      try {
        const userIds = listCashflowUserIds();

        for (const userId of userIds) {
          try {
            const today = todayWarsaw();
            const created = moveDueFutureTransactionsToPending(userId, today);
            const pendingSummaryCount = queueDailyPendingSummary(userId);
            const missingIncomeCount = queueMissingIncomeNotifications(userId);

            logServerEvent("cashflow_midnight_job_completed", {
              userId,
              transactionsCreated: created,
              pendingSummaryCount,
              missingIncomeCount
            });
          } catch (err) {
            logError("cashflow_midnight_job_user_failed", {
              userId,
              error: err.message
            });
          }
        }
      } catch (err) {
        logError("cashflow_midnight_job_failed", err);
      }
    });

    scheduleJob("0 8 * * *", CASHFLOW_TIMEZONE, async () => {
      try {
        const results = await refreshNbpFxCacheForAllUsers();

        logServerEvent("cashflow_fx_refresh_completed", {
          users: results.length,
          results
        });
      } catch (err) {
        logError("cashflow_fx_refresh_failed", err);
      }
    });

    scheduleJob("* * * * *", CASHFLOW_TIMEZONE, async () => {
      try {
        const userIds = listCashflowUserIds();

        for (const userId of userIds) {
          try {
            const settings = getSettings(userId);
            const deliveryTime = settings?.notification_delivery_time || NOTIFICATION_DELIVERY_TIME;

            const parts = new Intl.DateTimeFormat("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
              timeZone: CASHFLOW_TIMEZONE
            }).formatToParts(new Date());

            const hour = parts.find(p => p.type === "hour")?.value;
            const minute = parts.find(p => p.type === "minute")?.value;

            if (`${hour}:${minute}` === deliveryTime) {
              const sent = await sendQueuedNotifications(userId);
              if (sent) logServerEvent("cashflow_notifications_sent", { userId, sent });
            }
          } catch (err) {
            logError("cashflow_notification_delivery_user_failed", {
              userId,
              error: err.message
            });
          }
        }
      } catch (err) {
        logError("cashflow_notification_delivery_failed", err);
      }
    });

    scheduleJob("30 3 * * *", CASHFLOW_TIMEZONE, async () => {
      try {
        const userIds = listCashflowUserIds();

        for (const userId of userIds) {
          try {
            const result = maybeRunAutomaticBackup(userId);
            if (result) {
              logServerEvent("cashflow_auto_backup_completed", { userId, ...result });
            }
          } catch (err) {
            logError("cashflow_auto_backup_user_failed", {
              userId,
              error: err.message
            });
          }
        }
      } catch (err) {
        logError("cashflow_auto_backup_failed", err);
      }
    });
  }

  function scheduleJob(cronExpression, timezone, handler) {
    const minuteMs = 60_000;
    let lastRunKey = null;

    setInterval(() => {
      const now = new Date();

      const parts = new Intl.DateTimeFormat("en-US", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: timezone
      }).formatToParts(now);

      const value = (type) => parts.find(p => p.type === type)?.value;

      const year = value("year");
      const month = value("month");
      const day = value("day");
      const hour = value("hour");
      const minute = value("minute");

      const [cronMin, cronHour] = cronExpression.split(" ");

      const matches =
        (cronMin === "*" || Number(cronMin) === Number(minute)) &&
        (cronHour === "*" || Number(cronHour) === Number(hour));

      const runKey = `${cronExpression}:${timezone}:${year}-${month}-${day}T${hour}:${minute}`;

      if (matches && runKey !== lastRunKey) {
        lastRunKey = runKey;
        handler().catch(err => logError("scheduled_job_error", err));
      }
    }, minuteMs);
  }
  return {
    startBackgroundJobs
  };
}
