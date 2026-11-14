import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";
import { requireIsoDate } from "./cashflow-date-utils.js";
import { calculateProjection, ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "./index.js";

export const SNAPSHOT_VERSION = 1;
const REQUIRED_TABLES = [
  "planned_transactions", "recurring_expenses", "recurring_incomes", "flex_transactions",
  "goals", "one_off_transactions", "pending_transactions", "future_transactions", "projection_snapshots"
];
const REQUIRED_LEDGER_FIELDS = [
  "predictionRows", "confirmedRowsAfterToday", "handledOccurrenceKeys", "oneOffProgress"
];

/** Strict app-host contract. Explicit empty inputs are different from missing history. */
export function calculateSnapshot(snapshot) {
  if (!snapshot || ![SNAPSHOT_VERSION, 2].includes(snapshot.snapshotVersion)) throw new Error("Unsupported snapshot version");
  if (snapshot.snapshotVersion === 2 && (typeof snapshot.budgetId !== "string" || !snapshot.budgetId.startsWith("local-")
    || snapshot.writesSupported !== undefined || snapshot.localAuditVersion !== 1 || !Array.isArray(snapshot.localAudit)
    || !Number.isSafeInteger(snapshot.localAuditLegacyCount) || snapshot.localAuditLegacyCount < 0)) throw new Error("Audited snapshots need standalone journal evidence");
  if (typeof snapshot.budgetId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(snapshot.budgetId)) {
    throw new Error("A valid budgetId is required");
  }
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new Error("revision must be a nonnegative safe integer");
  }
  const request = snapshot.request;
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("request is required");
  if (!request.settings || typeof request.settings !== "object" || Array.isArray(request.settings)) {
    throw new Error("Explicit settings are required");
  }
  if (!request.tables || typeof request.tables !== "object" || Array.isArray(request.tables)) {
    throw new Error("Explicit planning tables are required");
  }
  for (const name of REQUIRED_TABLES) {
    if (!Array.isArray(request.tables[name])) throw new Error(`Explicit tables.${name} is required`);
  }
  for (const name of REQUIRED_LEDGER_FIELDS) {
    if (!Array.isArray(request[name])) throw new Error(`Explicit ${name} is required`);
  }
  if (!request.confirmedFunding || !Array.isArray(request.confirmedFunding.source_goal_id)
    || !Array.isArray(request.confirmedFunding.source_flex_id)) {
    throw new Error("Explicit confirmedFunding source_goal_id and source_flex_id are required");
  }
  if (!Object.prototype.hasOwnProperty.call(request, "fxSnapshot")) throw new Error("Explicit fxSnapshot is required (null is allowed)");
  // Catch accidentally mixed budgets without requiring a storage-specific budget_id column.
  for (const [name, rows] of Object.entries(request.tables)) {
    if (!Array.isArray(rows)) throw new Error(`tables.${name} must be an array`);
  }
  const scopedRows = [...Object.values(request.tables).flat(),
    ...request.predictionRows, ...request.confirmedRowsAfterToday, request.settings];
  for (const row of scopedRows) {
    if (row && Object.prototype.hasOwnProperty.call(row, "budget_id") && row.budget_id !== snapshot.budgetId) {
      throw new Error("Snapshot contains data belonging to another budget");
    }
  }
  // Recovery hints are local derived choices, never journal/pending mirrors or
  // accepted ledger amounts. Linked snapshots keep their server-prepared behavior.
  const standalone = snapshot.budgetId.startsWith("local-") && snapshot.writesSupported === undefined && !snapshot.linked;
  if (snapshot.localRecoveryRows !== undefined && (!standalone || !Array.isArray(snapshot.localRecoveryRows))) {
    throw new Error("Standalone recovery choices must be an array");
  }
  for (const row of snapshot.localRecoveryRows || []) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).some(key => !["occurrence_key", "date", "type", "source_recurring_expense_id", "source_recurring_income_id"].includes(key))
      || typeof (row.source_recurring_expense_id || row.source_recurring_income_id) !== "string"
      || Boolean(row.source_recurring_expense_id) === Boolean(row.source_recurring_income_id)
      || row.type !== (row.source_recurring_income_id ? "income" : "expense")
      || row.occurrence_key !== occurrenceKeyFromRow(row)) throw new Error("Invalid standalone recovery choice");
    requireIsoDate(row.date, "recovery.date");
  }
  const { recoveryRows: ignored, ...projectionRequest } = request;
  const result = calculateProjection({ ...projectionRequest,
    ...(standalone && snapshot.localRecoveryRows ? { recoveryRows: snapshot.localRecoveryRows } : {}) });
  return { snapshotVersion: snapshot.snapshotVersion, budgetId: snapshot.budgetId,
    baseRevision: snapshot.revision, calculationId: request.idSeed, ...result };
}

/** App bridge: malformed or incomplete snapshots never produce an applicable plan. */
export function calculateSnapshotJson(snapshotJson) {
  try {
    if (typeof snapshotJson !== "string") throw new Error("Snapshot must be a JSON string");
    return JSON.stringify({ ok: true, ...calculateSnapshot(JSON.parse(snapshotJson)) });
  } catch (error) {
    return JSON.stringify({ ok: false, snapshotVersion: SNAPSHOT_VERSION,
      protocolVersion: ENGINE_PROTOCOL_VERSION, engineVersion: ENGINE_VERSION,
      error: { code: "SNAPSHOT_CALCULATION_FAILED", message: error.message } });
  }
}
