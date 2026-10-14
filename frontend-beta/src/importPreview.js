function displayValue(value) {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function describeConflict(conflict) {
  if (!conflict || typeof conflict !== "object") return displayValue(conflict);
  const identity = [conflict.table, conflict.id].filter(Boolean).join(" / ");
  const reason = conflict.reason || conflict.message || conflict.field || "conflict";
  return identity ? `${identity}: ${reason}` : displayValue(conflict);
}

function tableLabel(name) {
  return String(name || "table").replaceAll("_", " ");
}

// Keep the destructive confirmation tied to the server's preview contract.
export function describeFullImportPreview(preview) {
  const mode = preview?.mode === "merge" ? "merge" : "replace";
  const lines = [
    "Import preview",
    `Mode: ${mode}`,
    mode === "replace"
      ? "This will replace this budget's planning data, settings, and ledger years with the file after a safety backup."
      : "This will merge the file into this budget. If any row conflicts with an existing one, the whole import is rejected.",
    "",
    "Planning tables (incoming / current):"
  ];

  const tables = Object.entries(preview?.tables || {});
  if (tables.length) {
    for (const [name, table] of tables) {
      const defaulted = table?.defaultedColumns?.length && Number(table?.exportRowCount) > 0
        ? `; defaults used for: ${table.defaultedColumns.join(", ")}`
        : "";
      lines.push(`- ${tableLabel(name)}: ${table?.exportRowCount ?? 0} / ${table?.currentRowCount ?? 0}${defaulted}`);
    }
  } else {
    lines.push("- none");
  }

  const incomingYears = preview?.ledgerYears?.export || [];
  const currentYears = preview?.ledgerYears?.current || [];
  lines.push(
    "",
    `Ledger years in file: ${incomingYears.length ? incomingYears.join(", ") : "none"}`,
    `Ledger years currently in budget: ${currentYears.length ? currentYears.join(", ") : "none"}`,
    "",
    "Settings changes:"
  );

  const settingsChanges = preview?.settingsChanges || [];
  if (settingsChanges.length) {
    for (const change of settingsChanges) {
      lines.push(`- ${change.field}: ${displayValue(change.from)} → ${displayValue(change.to)}`);
    }
  } else {
    lines.push("- none");
  }

  lines.push("", "Conflicts:");
  const conflicts = preview?.conflicts || [];
  if (conflicts.length) {
    for (const conflict of conflicts) lines.push(`- ${describeConflict(conflict)}`);
    if (mode === "merge") lines.push("The import will be rejected until these conflicts are resolved.");
  } else {
    lines.push("- none");
  }

  lines.push("", mode === "replace" ? "Replace this budget with the imported data?" : "Merge this data into the budget?");
  return lines.join("\n");
}
