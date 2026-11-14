import { formatMessage } from "./i18n.js";

// Capabilities come from the server; system administrators do not bypass membership.
export function backupPermissions(snapshot) {
  const capabilities = snapshot?.session?.capabilities || [];
  return {
    settings: capabilities.includes("budget:settings"),
    create: capabilities.includes("budget:backup"),
    restore: capabilities.includes("budget:restore")
  };
}

// Choose the largest exact unit so existing minute values survive a settings save.
export function backupDraft(settings = {}) {
  const minutes = Number(settings.backup_interval_minutes ?? 1440);
  const unit = minutes % 1440 === 0 ? 1440 : minutes % 60 === 0 ? 60 : 1;
  return {
    enabled: Number(settings.auto_backup_enabled) === 1,
    interval: minutes / unit,
    unit,
    retention: settings.backup_retention_count ?? 10,
    location: settings.backup_location || ""
  };
}

// Do not send an unused PostgreSQL path through SQLite filesystem validation.
export function backupSettings(draft, backend) {
  return {
    auto_backup_enabled: draft.enabled ? 1 : 0,
    backup_interval_minutes: Number(draft.interval) * Number(draft.unit),
    backup_retention_count: Number(draft.retention),
    ...(backend === "sqlite" ? { backup_location: draft.location.trim() || null } : {})
  };
}

export function formatBackupSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function newestBackups(rows = []) {
  return [...rows].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)));
}

// Confirmation precedes every request and names both the recovery point and scope.
export async function restoreSelectedBackup(backup, { confirm, request, refresh }) {
  if (!confirm(formatMessage("Restore backup {id}? This replaces this budget’s settings, planning data, and ledger. A safety backup of the current budget is taken first.", { id: backup.id }))) return false;
  await request(`/api/restore/${encodeURIComponent(backup.id)}`, { method: "POST" });
  await refresh();
  return true;
}

// An age limit may shorten any owner's count; both limits are instance policy.
export function stricterBackupPolicy(policy = {}, retention = 10) {
  const cap = Number(policy.backup_max_retention_count) || 0;
  return { cap: cap > 0 && cap < Number(retention) ? cap : 0, ageDays: Number(policy.backup_max_age_days) || 0 };
}
