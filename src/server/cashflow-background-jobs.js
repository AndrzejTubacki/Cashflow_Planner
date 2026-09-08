import crypto from "node:crypto";

import { DEFAULT_TIMEZONE, NOTIFICATION_DELIVERY_TIME } from "./cashflow-constants.js";
import { todayInTimezone, normalizeTimezone } from "./cashflow-date-utils.js";

export function createCashflowBackgroundJobs({
  cleanupOperationalData = () => null,
  getSettings,
  listCashflowUserIds,
  logError,
  logServerEvent,
  maybeRunAutomaticBackup,
  moveDueFutureTransactionsToPending,
  openPlanningDb = null,
  queueDailyPendingSummary,
  queueMissingIncomeNotifications,
  refreshNbpFxCacheForAllUsers,
  refreshNbpFxCacheForUser,
  sendQueuedNotifications,
  now = () => new Date()
}) {
  const lastRunKeys = new Set();
  let tickRunning = false;

  function startBackgroundJobs() {
    return setInterval(() => {
      tickPerUserJobs().catch(err => logError("cashflow_background_tick_failed", err));
    }, 60_000);
  }

  function localParts(timezone, currentTime) {
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: normalizeTimezone(timezone)
    }).formatToParts(currentTime);

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

  function localTimeReached(localTime, scheduledTime) {
    return String(localTime || "") >= String(scheduledTime || "00:00");
  }

  function persistedRunExists(userId, jobName, runKey) {
    if (typeof openPlanningDb !== "function") return false;
    let db = null;
    try {
      db = openPlanningDb(userId, { create: false });
      return Boolean(db.prepare(`
        SELECT 1
        FROM event_log
        WHERE action = 'background_job_success'
          AND entity_type = ?
          AND entity_id = ?
        LIMIT 1
      `).get(`background_job:${jobName}`, runKey));
    } catch (error) {
      logError("cashflow_background_schedule_state_read_failed", {
        userId,
        jobName,
        runKey,
        error: error.message
      });
      return false;
    } finally {
      db?.close();
    }
  }

  function recordPersistedRun(userId, jobName, runKey, details = {}) {
    if (typeof openPlanningDb !== "function") return;
    let db = null;
    try {
      db = openPlanningDb(userId);
      db.prepare(`
        INSERT INTO event_log (id, action, entity_type, entity_id, details, timestamp)
        VALUES (?, 'background_job_success', ?, ?, ?, datetime('now'))
      `).run(
        `background_${crypto.randomUUID()}`,
        `background_job:${jobName}`,
        runKey,
        JSON.stringify(details || {})
      );
    } catch (error) {
      logError("cashflow_background_schedule_state_write_failed", {
        userId,
        jobName,
        runKey,
        error: error.message
      });
    } finally {
      db?.close();
    }
  }

  async function runDailyJobOnce({
    userId,
    jobName,
    runKey,
    localTime,
    scheduledTime,
    work
  }) {
    if (!localTimeReached(localTime, scheduledTime)) return null;

    const memoryKey = `${jobName}:${userId}:${runKey}`;
    if (!shouldRun(memoryKey)) return null;
    if (persistedRunExists(userId, jobName, runKey)) return null;

    try {
      const result = await work();
      recordPersistedRun(userId, jobName, runKey, {
        scheduledTime
      });
      return result ?? true;
    } catch (error) {
      lastRunKeys.delete(memoryKey);
      throw error;
    }
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
          const currentTime = now();
          const local = localParts(timezone, currentTime);
          const today = todayInTimezone(timezone, currentTime);

          await runDailyJobOnce({
            userId,
            jobName: "midnight",
            runKey: local.date,
            localTime: local.time,
            scheduledTime: "00:00",
            work: () => {
              const created = moveDueFutureTransactionsToPending(userId, today);
              const pendingSummaryCount = queueDailyPendingSummary(userId);
              const missingIncomeCount = queueMissingIncomeNotifications(userId);

              logServerEvent("cashflow_midnight_job_completed", {
                userId,
                transactionsCreated: created,
                pendingSummaryCount,
                missingIncomeCount
              });
              return { created, pendingSummaryCount, missingIncomeCount };
            }
          });

          await runDailyJobOnce({
            userId,
            jobName: "fx",
            runKey: local.date,
            localTime: local.time,
            scheduledTime: "08:00",
            work: async () => {
              const result = typeof refreshNbpFxCacheForUser === "function"
                ? await refreshNbpFxCacheForUser(userId, today)
                : { users: await refreshNbpFxCacheForAllUsers(today) };
              logServerEvent("cashflow_fx_refresh_completed", {
                userId,
                result
              });
              return result;
            }
          });

          const deliveryTime = settings.notification_delivery_time || NOTIFICATION_DELIVERY_TIME;
          await runDailyJobOnce({
            userId,
            jobName: "notify",
            runKey: `${local.date}:${deliveryTime}`,
            localTime: local.time,
            scheduledTime: deliveryTime,
            work: async () => {
              const sent = await sendQueuedNotifications(userId);
              if (sent) logServerEvent("cashflow_notifications_sent", { userId, sent });
              return { sent };
            }
          });

          const backupResult = maybeRunAutomaticBackup(userId);
          if (backupResult) {
            logServerEvent("cashflow_auto_backup_completed", { userId, ...backupResult });
          }

          await runDailyJobOnce({
            userId,
            jobName: "maintenance",
            runKey: local.date,
            localTime: local.time,
            scheduledTime: "03:30",
            work: () => {
              cleanupOperationalData(userId, "daily_maintenance");
              return true;
            }
          });
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
