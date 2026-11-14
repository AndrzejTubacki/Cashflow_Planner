// Alerts an app shows itself, from the same rules the server queues for ntfy/Discord.
// The projection emits goal, funding and FX alerts; pending summary and missing income
// mirror the server's daily checks (cashflow-notification-service.js); missing income
// also covers an income past its date and still unconfirmed. No delivery here.
import { calculateNextDate, requireIsoDate } from "./cashflow-date-utils.js";
import { buildNotificationQueueRow } from "./cashflow-notification-intents.js";
import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";
import { calculateSnapshot } from "./snapshot.js";

export const DEVICE_NOTIFICATION_TYPES = ["goal_impossible", "necessary_underfunded", "funding_shortfall",
  "income_missing", "pending_summary", "goal_funded", "fx_changed"];

/** `types` are the alerts the person enabled on this device (independent of the
 * budget's server settings); `previousSummary` is the projection summary returned by
 * the previous check, used to tell whether exchange rates changed the forecast. */
export function deviceNotifications({ snapshot, types, repeatDays = 1, previousSummary = null }) {
  if (!Array.isArray(types) || types.some(type => !DEVICE_NOTIFICATION_TYPES.includes(type))) throw new Error("Unknown notification type");
  if (!Number.isSafeInteger(repeatDays) || repeatDays < 1 || repeatDays > 365) throw new Error("Repeat interval must be 1 to 365 days");
  const request = snapshot?.request;
  requireIsoDate(request?.today, "today");
  const today = request.today;
  const settings = { ...request.settings, necessary_underfunded_repeat_days: repeatDays };
  for (const type of DEVICE_NOTIFICATION_TYPES) settings[`notify_${type}`] = types.includes(type) ? 1 : 0;
  const tables = { ...request.tables, projection_snapshots: previousSummary ? [previousSummary] : [] };
  const { plan } = calculateSnapshot({ ...snapshot, request: { ...request, settings, tables } });
  const queuedAt = request.generationTimestamp;
  let sequence = 0;
  const row = (type, dedupeKey, entityId, title, message, params) => buildNotificationQueueRow({ dedupeKey, entityId,
    generateId: prefix => `${prefix}-device-${++sequence}`, message, params, queuedAt, settings, title, today, type });
  const notifications = [...plan.notificationRows];

  const open = plan.pendingRows.filter(value => ["pending", "partial", "underfunded", "funded"].includes(value.status));
  if (types.includes("pending_summary") && open.length) {
    notifications.push(row("pending_summary", "pending_summary", "pending_summary", "Pending cashflow transactions",
      `${open.length} transaction(s) are waiting for confirmation.`, { count: open.length }));
  }
  if (types.includes("income_missing")) {
    const handled = new Set(request.handledOccurrenceKeys);
    const scheduled = plan.pendingRows;
    const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    for (const income of request.tables.recurring_incomes.filter(value => Number(value.active) === 1 || value.active === true)) {
      const expected = calculateNextDate(income, year, month);
      // An income due today is not missing yet.
      if (!expected || expected >= today) continue;
      if (handled.has(occurrenceKeyFromRow({ type: "income", date: expected, source_recurring_income_id: income.id }))) continue;
      // The server also skips a pending row on the expected date; here an occurrence past
      // its date and still unconfirmed counts as missing (only a later one is skipped).
      if (scheduled.some(value => value.source_recurring_income_id === income.id && value.date > expected)) continue;
      notifications.push(row("income_missing", `income_missing:${income.id}:${expected}`, income.id, "Recurring income missing",
        `${income.name} expected on ${expected} has not been confirmed.`, { name: income.name, date: expected }));
    }
  }
  return { notifications: notifications.filter(value => types.includes(value.notification_type)),
    summary: plan.projectionSnapshotRows[0] ?? null };
}

export function deviceNotificationsJson(json) {
  try { return JSON.stringify({ ok: true, ...deviceNotifications(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: "DEVICE_NOTIFICATIONS_REJECTED", message: error.message } }); }
}
