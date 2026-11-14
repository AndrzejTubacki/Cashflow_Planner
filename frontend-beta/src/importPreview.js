import { formatMessage, t } from "./i18n.js";

function displayValue(value) {
  if (value === null || value === undefined || value === "") return t("None");
  if (typeof value === "boolean") return value ? t("Yes") : t("No");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function tableLabel(name) {
  const labels = {
    settings: t("Settings"), recurring_expenses: t("Recurring expenses"), recurring_incomes: t("Recurring income"),
    goals: t("Goals"), flex_transactions: t("Flex"), one_off_transactions: t("One-off"),
    pending_transactions: t("Pending transactions"), future_transactions: t("Future transactions"),
    confirmed_transactions: t("Confirmed transactions"), fx_rates_cache: t("FX rate cache"),
    projection_snapshots: t("Projection snapshots"), event_log: t("Event log"),
    notification_queue: t("Notification queue"), backup_metadata: t("Backup metadata")
  };
  // Unknown table/column identifiers remain exact technical identifiers.
  return labels[name] || String(name || t("Table"));
}

function describeConflict(conflict) {
  if (!conflict || typeof conflict !== "object") return displayValue(conflict);
  const identity = [conflict.table ? tableLabel(conflict.table) : "", conflict.id].filter(Boolean).join(" / ");
  const reason = conflict.reason === "duplicate_in_import" ? t("Duplicate ID in the imported file")
    : conflict.reason === "already_exists" ? t("ID already exists in this budget")
      : conflict.reason === "duplicate id" ? t("Duplicate ID")
        : conflict.message ? t(conflict.message) : conflict.reason || conflict.field || t("Conflict");
  return identity ? `${identity}: ${reason}` : reason;
}

// Keep every sentence and count in the destructive confirmation localized.
export function describeFullImportPreview(preview) {
  const merge = preview?.mode === "merge";
  const lines = [
    t("Import preview"),
    formatMessage("Mode: {mode}", { mode: merge ? t("Merge") : t("Replace") }),
    merge ? t("This will merge the file into this budget. If any row conflicts with an existing one, the whole import is rejected.")
      : t("This will replace this budget's planning data, settings, and ledger years with the file after a safety backup."),
    "", t("Planning tables (incoming / current):")
  ];
  const tables = Object.entries(preview?.tables || {});
  if (!tables.length) lines.push(t("None"));
  for (const [name, table] of tables) {
    lines.push(formatMessage("Table {table}: {incoming} / {current}", {
      table: tableLabel(name), incoming: table?.exportRowCount ?? 0, current: table?.currentRowCount ?? 0
    }));
    if (table?.defaultedColumns?.length && Number(table?.exportRowCount) > 0) {
      lines.push(formatMessage("Defaults used for: {columns}", { columns: table.defaultedColumns.join(", ") }));
    }
  }
  const incomingYears = preview?.ledgerYears?.export || [];
  const currentYears = preview?.ledgerYears?.current || [];
  lines.push("", formatMessage("Ledger years in file: {years}", { years: incomingYears.length ? incomingYears.join(", ") : t("None") }),
    formatMessage("Ledger years currently in budget: {years}", { years: currentYears.length ? currentYears.join(", ") : t("None") }),
    "", t("Settings changes:"));
  const settingsChanges = preview?.settingsChanges || [];
  if (!settingsChanges.length) lines.push(t("None"));
  for (const change of settingsChanges) lines.push(`${change.field}: ${displayValue(change.from)} → ${displayValue(change.to)}`);
  lines.push("", t("Conflicts:"));
  const conflicts = preview?.conflicts || [];
  if (!conflicts.length) lines.push(t("None"));
  for (const conflict of conflicts) lines.push(describeConflict(conflict));
  if (conflicts.length && merge) lines.push(t("The import will be rejected until these conflicts are resolved."));
  lines.push("", merge ? t("Merge this data into the budget?") : t("Replace this budget with the imported data?"));
  return lines.join("\n");
}
