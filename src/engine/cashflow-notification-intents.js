// Notification policy and row construction only; no delivery or platform clock.
export function notificationDedupeSuffix(settings, type, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("Explicit notification date is required");
  if (type !== "necessary_underfunded") {
    return date;
  }

  const repeatDays = Math.max(1, Number(settings?.necessary_underfunded_repeat_days || 1));
  const today = new Date(`${date}T00:00:00Z`);
  const epochDay = Math.floor(today.getTime() / 86_400_000);
  const bucket = Math.floor(epochDay / repeatDays);

  return `bucket-${bucket}`;
}

export function buildNotificationQueueRow({
  dedupeKey,
  entityId = null,
  generateId,
  message,
  params = null,
  priority = "default",
  queuedAt,
  today,
  settings = null,
  title,
  type
} = {}) {
  if (typeof generateId !== "function") {
    throw new Error("generateId is required to build notification rows");
  }
  if (!queuedAt) throw new Error("Explicit notification timestamp is required");
  const suffix = settings ? notificationDedupeSuffix(settings, type, today) : today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(suffix || "") && !String(suffix).startsWith("bucket-")) {
    throw new Error("Explicit notification date is required");
  }
  return {
    dedupe_key: `${dedupeKey}:${suffix}`,
    entity_id: entityId || null,
    id: generateId("notif"),
    message,
    notification_type: type,
    priority: priority || "default",
    queued_at: queuedAt,
    title,
    // Structured values so devices can word the alert in their own language.
    ...(params ? { params } : {})
  };
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
