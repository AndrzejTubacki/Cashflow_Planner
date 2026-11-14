// pg returns Date objects; Date.parse(Date) loses milliseconds through toString().
function timestamp(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** Plan only successful, owned artifacts supplied by the storage adapter.
 * Protected artifacts can exceed the count allowance: a running operation
 * can temporarily retain more, but neither age nor count can remove the newest.
 */
export function backupPruningPlan(rows, settings = {}, options = {}, currentTime = Date.now(), protectedPaths = []) {
  const count = Math.max(1, Number(settings.backup_retention_count) || 10);
  const cap = Number(options.backup_max_retention_count) || 0;
  const retention = cap > 0 ? Math.min(count, cap) : count;
  const ageDays = Number(options.backup_max_age_days) || 0;
  const cutoff = ageDays > 0 ? currentTime - ageDays * 86400000 : -Infinity;
  const protectedSet = new Set(protectedPaths);
  const sorted = rows.filter(row => Number(row.success) === 1).sort((a, b) =>
    timestamp(b.backup_timestamp) - timestamp(a.backup_timestamp)
    || timestamp(b.created_at) - timestamp(a.created_at)
    || String(b.id).localeCompare(String(a.id)));
  return sorted.filter((row, index) => index > 0 && !protectedSet.has(row.backup_path)
    && (index >= retention || timestamp(row.backup_timestamp) < cutoff));
}
