import crypto from "node:crypto";

import { DEFAULT_TIMEZONE, NOTIFICATION_DELIVERY_TIME } from "./cashflow-constants.js";
import { todayInTimezone, normalizeTimezone } from "./cashflow-date-utils.js";
import {
  BUDGET_RUNTIME_LOCK_JOBS,
  budgetRuntimeLockName,
  GLOBAL_BACKGROUND_TICK_LOCK
} from "./cashflow-runtime-locks.js";

export function createCashflowBackgroundJobs({
  backgroundLockName = GLOBAL_BACKGROUND_TICK_LOCK,
  budgetStore = null,
  cleanupOperationalData = () => null,
  compactLedgerHistory = null,
  getSettings,
  getSettingsAsync = null,
  listCashflowUserIds,
  listCashflowUserIdsAsync = null,
  lockService = null,
  logError,
  logServerEvent,
  maybeRunAutomaticBackup,
  maybeRunAutomaticBackupAsync = null,
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
  let stopping = false;
  let interval = null;
  let inFlightTick = null;

  function startBackgroundJobs() {
    // The scheduler owns its timer and tracks the complete locked promise.
    if (interval) return interval;
    interval = setInterval(() => {
      tickPerUserJobs().catch(err => logError("cashflow_background_tick_failed", err));
    }, 60_000);
    return interval;
  }

  async function stopBackgroundJobs() {
    // Reject new ticks while letting an active callback release its lease.
    stopping = true;
    clearInterval(interval);
    interval = null;
    try {
      await inFlightTick;
    } catch (error) {
      // A failed tick has still drained; it must not prevent pool cleanup.
      logError("cashflow_background_drain_failed", { error: error.message });
    }
  }

  function tickPerUserJobs() {
    if (stopping) return Promise.resolve({ skipped: true, reason: "shutdown" });
    if (inFlightTick) {
      logServerEvent("cashflow_background_tick_skipped", { reason: "previous_tick_still_running" });
      return Promise.resolve({ skipped: true });
    }
    const work = runTickPerUserJobs();
    inFlightTick = work;
    return work.finally(() => { if (inFlightTick === work) inFlightTick = null; });
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

  async function settingsForUser(userId) {
    if (typeof getSettingsAsync === "function") {
      return await getSettingsAsync(userId);
    }
    return getSettings(userId);
  }

  async function persistedRunExists(userId, jobName, runKey) {
    if (budgetStore && typeof budgetStore.listPlanningRows === "function") {
      try {
        const rows = await budgetStore.listPlanningRows(userId, "event_log");
        return rows.some(row =>
          row.action === "background_job_success"
            && row.entity_type === `background_job:${jobName}`
            && row.entity_id === runKey
        );
      } catch (error) {
        logError("cashflow_background_schedule_state_read_failed", {
          userId,
          jobName,
          runKey,
          error: error.message
        });
        return false;
      }
    }

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

  async function recordPersistedRun(userId, jobName, runKey, details = {}) {
    if (budgetStore && typeof budgetStore.insertPlanningRows === "function") {
      try {
        await budgetStore.insertPlanningRows(userId, "event_log", [{
          id: `background_${crypto.randomUUID()}`,
          action: "background_job_success",
          entity_type: `background_job:${jobName}`,
          entity_id: runKey,
          details: JSON.stringify(details || {}),
          timestamp: new Date().toISOString()
        }]);
      } catch (error) {
        logError("cashflow_background_schedule_state_write_failed", {
          userId,
          jobName,
          runKey,
          error: error.message
        });
      }
      return;
    }

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

  const failureCounts = new Map();

  async function runDailyJobOnce({
    userId,
    jobName,
    runKey,
    localTime,
    scheduledTime,
    work,
    lockName = "",
    lockTtlMs = 55_000
  }) {
    if (!localTimeReached(localTime, scheduledTime)) return null;

    const runOnce = async () => {
      const memoryKey = `${jobName}:${userId}:${runKey}`;
      if (!shouldRun(memoryKey)) return null;
      if (await persistedRunExists(userId, jobName, runKey)) return null;

      const fails = failureCounts.get(memoryKey) || 0;
      if (fails >= 3) return null;

      try {
        const result = await work();
        await recordPersistedRun(userId, jobName, runKey, {
          scheduledTime
        });
        failureCounts.delete(memoryKey);
        return result ?? true;
      } catch (error) {
        lastRunKeys.delete(memoryKey);
        failureCounts.set(memoryKey, fails + 1);
        throw error;
      }
    };

    if (lockName && lockService && typeof lockService.withLock === "function") {
      const lockResult = await lockService.withLock(lockName, runOnce, {
        ttlMs: lockTtlMs
      });
      if (!lockResult?.acquired) {
        logServerEvent("cashflow_background_job_lock_skipped", {
          jobName,
          lockName,
          userId
        });
        return null;
      }
      return lockResult.result;
    }

    return await runOnce();
  }

  async function runTickPerUserJobs() {
    if (tickRunning) {
      logServerEvent("cashflow_background_tick_skipped", {
        reason: "previous_tick_still_running"
      });
      return { skipped: true };
    }

    tickRunning = true;
    try {
      const runTick = async (_lock, { signal } = {}) => {
        const userIds = typeof listCashflowUserIdsAsync === "function"
          ? await listCashflowUserIdsAsync()
          : listCashflowUserIds();

        for (const [userIndex, userId] of userIds.entries()) {
          if (signal?.aborted) {
            logServerEvent("cashflow_background_tick_lock_lost", {
              processedUsers: userIndex,
              remainingUsers: userIds.length - userIndex
            });
            return { skipped: false, users: userIndex, lockLost: true };
          }
          try {
            const settings = await settingsForUser(userId) || {};
            const timezone = settings.timezone || DEFAULT_TIMEZONE;
            const currentTime = now();
            const local = localParts(timezone, currentTime);
            const today = todayInTimezone(timezone, currentTime);
            const dailyLedgerTime = settings.notification_delivery_time || NOTIFICATION_DELIVERY_TIME;

            try {
              await runDailyJobOnce({
                userId,
                jobName: "midnight",
                lockName: budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.ledgerCheck),
                runKey: `${local.date}:${dailyLedgerTime}`,
                localTime: local.time,
                scheduledTime: dailyLedgerTime,
                work: async () => {
                  const created = await moveDueFutureTransactionsToPending(userId, today);
                  const pendingSummaryCount = await queueDailyPendingSummary(userId);
                  const missingIncomeCount = await queueMissingIncomeNotifications(userId);

                  logServerEvent("cashflow_midnight_job_completed", {
                    userId,
                    transactionsCreated: created,
                    pendingSummaryCount,
                    missingIncomeCount
                  });
                  return { created, pendingSummaryCount, missingIncomeCount };
                }
              });
            } catch (err) {
              logError("cashflow_background_job_failed", { userId, jobName: "midnight", error: err.message });
            }

            try {
              await runDailyJobOnce({
                userId,
                jobName: "fx",
                lockName: budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.fxRefresh),
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
            } catch (err) {
              logError("cashflow_background_job_failed", { userId, jobName: "fx", error: err.message });
            }

            try {
              await runDailyJobOnce({
                userId,
                jobName: "notify",
                lockName: budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.notifications),
                runKey: `${local.date}:catchup:${dailyLedgerTime}`,
                localTime: local.time,
                scheduledTime: dailyLedgerTime,
                work: async () => {
                  const sent = await sendQueuedNotifications(userId);
                  if (sent) logServerEvent("cashflow_notifications_sent", { userId, sent });
                  return { sent };
                }
              });
            } catch (err) {
              logError("cashflow_background_job_failed", { userId, jobName: "notify", error: err.message });
            }

            try {
              const runBackup = async () => (
                typeof maybeRunAutomaticBackupAsync === "function"
                  ? maybeRunAutomaticBackupAsync(userId)
                  : maybeRunAutomaticBackup(userId)
              );
              const backupResult = lockService && typeof lockService.withLock === "function"
                ? (await lockService.withLock(
                    budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.automaticBackup),
                    runBackup,
                    { ttlMs: 55_000 }
                  ))?.result
                : await runBackup();
              if (backupResult) {
                logServerEvent("cashflow_auto_backup_completed", { userId, ...backupResult });
              }
            } catch (err) {
              logError("cashflow_background_job_failed", { userId, jobName: "backup", error: err.message });
            }

            try {
              await runDailyJobOnce({
                userId,
                jobName: "maintenance",
                lockName: budgetRuntimeLockName(userId, BUDGET_RUNTIME_LOCK_JOBS.retention),
                runKey: local.date,
                localTime: local.time,
                scheduledTime: "03:30",
                work: async () => {
                  cleanupOperationalData(userId, "daily_maintenance");
                  const compaction = typeof compactLedgerHistory === "function"
                    ? await compactLedgerHistory(userId)
                    : null;
                  if (compaction?.compactedRows) {
                    logServerEvent("cashflow_ledger_history_compacted", {
                      userId,
                      compactedRows: compaction.compactedRows,
                      createdRows: compaction.createdRows,
                      cutoffDate: compaction.cutoffDate
                    });
                  }
                  return { compaction };
                }
              });
            } catch (err) {
              logError("cashflow_background_job_failed", { userId, jobName: "maintenance", error: err.message });
            }
          } catch (err) {
            logError("cashflow_background_user_failed", {
              userId,
              error: err.message
            });
          }
        }

        return { skipped: false, users: userIds.length };
      };

      if (lockService && typeof lockService.withLock === "function") {
        const lockResult = await lockService.withLock(backgroundLockName, runTick, {
          ttlMs: 55_000
        });
        if (!lockResult?.acquired) {
          logServerEvent("cashflow_background_tick_skipped", {
            reason: "distributed_lock_unavailable"
          });
          return { skipped: true, reason: "distributed_lock_unavailable" };
        }
        return lockResult.result;
      }

      return await runTick();
    } finally {
      tickRunning = false;
    }
  }

  return {
    startBackgroundJobs,
    stopBackgroundJobs,
    tickPerUserJobs
  };
}
