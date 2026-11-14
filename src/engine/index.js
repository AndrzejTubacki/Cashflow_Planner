import { recoveryWindow } from "./recovery-window.js";
import { DEFAULT_FUTURE_PERIODS } from "./cashflow-constants.js";
import { requireIsoDate } from "./cashflow-date-utils.js";
import { roundMoneyAmount } from "./cashflow-money-utils.js";
import { buildBudgetPeriods, periodAnchorOverridesForIncome } from "./cashflow-period-utils.js";
import {
  buildProjectionFundingState, buildProjectionInputRowsFromPlanningTables,
  computeGoalAndFlexTargetLedgerAmounts, computeProjectionPlan, computeReserveClaims,
  findLockedReserveClaims, makeProjectionConverter
} from "./cashflow-projection.js";

export const ENGINE_PROTOCOL_VERSION = 1;
export const ENGINE_VERSION = "0.5.0";

// Validate before serialization: JSON would otherwise silently turn NaN into null.
function assertJsonValue(value, path = "$", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value)) throw new Error(`Invalid JSON value at ${path}`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Expected plain JSON data at ${path}`);
  }
  seen.add(value);
  for (const [key, child] of Object.entries(value)) assertJsonValue(child, `${path}.${key}`, seen);
  seen.delete(value);
}

function arrayField(input, name) {
  const value = input[name] ?? [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}

function rowField(input, name) {
  const rows = arrayField(input, name);
  if (rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error(`${name} must contain row objects`);
  }
  return rows;
}

function entryMap(value, name) {
  if (!Array.isArray(value) || value.some(entry => !Array.isArray(entry) || entry.length !== 2
    || typeof entry[0] !== "string" || typeof entry[1] !== "number" || !Number.isFinite(entry[1]))) {
    throw new Error(`${name} must contain [string, finite number] entries`);
  }
  if (new Set(value.map(entry => entry[0])).size !== value.length) throw new Error(`${name} contains duplicate keys`);
  return new Map(value);
}

function progressMap(entries) {
  if (!Array.isArray(entries)) throw new Error("oneOffProgress must be an array");
  const progress = new Map();
  for (const entry of entries) {
    const [key, value] = Array.isArray(entry) ? entry : [];
    if (!Array.isArray(entry) || entry.length !== 2 || typeof key !== "string" || !value || typeof value !== "object"
      || typeof value.sourceId !== "string" || !["income", "expense"].includes(value.type)
      || typeof value.currency !== "string" || key !== `${value.sourceId}:${value.type}:${value.currency}`
      || !Number.isFinite(value.confirmedAmount) || value.confirmedAmount < 0
      || !Number.isSafeInteger(value.confirmedCount) || value.confirmedCount < 1 || progress.has(key)) {
      throw new Error("oneOffProgress requires unique [sourceId:type:currency, progress record] entries");
    }
    progress.set(key, value);
  }
  return progress;
}

/**
 * Calculate from a storage-prepared JSON snapshot, without accessing storage or clocks.
 * The adapter must provide consistent ledger aggregates (including openingBalance)
 * and the revision it will check when applying the result. This does not persist or
 * authorize financial actions, and is not a synchronization endpoint.
 */
export function calculateProjection(request) {
  assertJsonValue(request);
  if (!request || Array.isArray(request)) throw new Error("A projection request object is required");
  if (request.protocolVersion !== ENGINE_PROTOCOL_VERSION) throw new Error("Unsupported engine protocol version");
  const today = requireIsoDate(request.today, "today");
  if (typeof request.generationTimestamp !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(request.generationTimestamp)
    || !Number.isFinite(Date.parse(request.generationTimestamp))
    || new Date(request.generationTimestamp).toISOString() !== request.generationTimestamp) {
    throw new Error("generationTimestamp must be an ISO UTC timestamp with milliseconds");
  }
  if (typeof request.idSeed !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.idSeed)) {
    throw new Error("idSeed must be a unique calculation identifier (1–128 letters, digits, underscores or hyphens)");
  }
  if (typeof request.openingBalance !== "number" || !Number.isFinite(request.openingBalance)) {
    throw new Error("An explicit finite openingBalance is required");
  }
  // Clone all inputs: core funding/period structures are mutable and must be per-call.
  const input = JSON.parse(JSON.stringify(request));
  const settings = input.settings ?? input.tables?.settings?.[0] ?? {};
  const tables = input.tables ?? {};
  if (typeof settings !== "object" || !settings || Array.isArray(settings)
    || typeof tables !== "object" || !tables || Array.isArray(tables)) {
    throw new Error("settings and tables must be objects");
  }
  for (const [name, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error(`tables.${name} must be an array of row objects`);
    }
  }
  const futurePeriods = Number(settings.future_periods) || DEFAULT_FUTURE_PERIODS;
  if (!Number.isInteger(futurePeriods) || futurePeriods < 1 || futurePeriods > 120) {
    throw new Error("future_periods must be an integer from 1 to 120");
  }
  const rows = buildProjectionInputRowsFromPlanningTables({ settings, tables });
  const { recurringIncomes, recurringExpenses, goals, flexes, oneOffs, pendingPeriodIncomeRows, previousSnapshot } = rows;
  const ledgerCurrency = settings.ledger_currency || "PLN";
  const fxSnapshot = input.fxSnapshot ?? null;
  const convert = makeProjectionConverter({ settings, fxSnapshot, ledgerCurrency });
  const { goalTargetLedger, flexTargetLedger } = computeGoalAndFlexTargetLedgerAmounts({ goals, flexes, convert });
  const predictionRows = rowField(input, "predictionRows");
  const confirmedRowsAfterToday = rowField(input, "confirmedRowsAfterToday");
  const handledOccurrenceKeys = arrayField(input, "handledOccurrenceKeys");
  if (handledOccurrenceKeys.some(key => typeof key !== "string")) throw new Error("handledOccurrenceKeys must contain strings");
  const oneOffProgress = progressMap(input.oneOffProgress ?? []);
  const confirmedFunding = input.confirmedFunding ?? {};
  if (!confirmedFunding || typeof confirmedFunding !== "object" || Array.isArray(confirmedFunding)) {
    throw new Error("confirmedFunding must be an object");
  }
  const sourceGoalFunding = entryMap(confirmedFunding.source_goal_id ?? [], "confirmedFunding.source_goal_id");
  const sourceFlexFunding = entryMap(confirmedFunding.source_flex_id ?? [], "confirmedFunding.source_flex_id");
  const anchorOverrides = periodAnchorOverridesForIncome(settings.budget_period_income_id,
    [...predictionRows, ...pendingPeriodIncomeRows]);
  const recovery = input.recoveryRows === undefined ? null : recoveryWindow({
    settings, recurringIncomes, today, futurePeriods, anchorOverrides,
    candidates: rowField(input, "recoveryRows")
  });
  let counter = 0;
  // A fresh seed per logical calculation is the host's responsibility, not a clock default.
  const generateId = prefix => `${prefix}-${input.idSeed}-${++counter}`;
  function argumentsForPass() {
    return {
      confirmedRowsAfterToday, convert, flexes, flexTargetLedger, fxSnapshot, goals, goalTargetLedger,
      fundingState: buildProjectionFundingState({ goals, flexes, goalTargetLedger, flexTargetLedger,
        ledgerCurrency, confirmedFunding: { source_goal_id: sourceGoalFunding, source_flex_id: sourceFlexFunding },
        pendingRows: tables.pending_transactions || [], futureRows: tables.future_transactions || [] }),
      generateId, generationTimestamp: input.generationTimestamp,
      handledOccurrenceKeys: new Set(handledOccurrenceKeys), ledgerCurrency, oneOffProgress, oneOffs,
      openingBalance: input.openingBalance, pendingRows: tables.pending_transactions || [],
      // Each pass mutates period balances; never share recovery period objects.
      periods: recovery ? JSON.parse(JSON.stringify(recovery.periods)) : buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods, { anchorOverrides }),
      ...(recovery ? { recoveryOccurrenceKeys: recovery.recoveryOccurrenceKeys, currentPeriodStart: recovery.currentPeriodStart } : {}),
      predictionRows, previousSnapshot, recurringExpenses, recurringIncomes, settings, today,
      reserveFloor: Number(settings.minimum_reserve_enabled || 0) === 1
        ? Math.max(0, roundMoneyAmount(settings.minimum_reserve_amount || 0)) : 0
    };
  }
  const discoveryArgs = argumentsForPass();
  const discovery = computeProjectionPlan({ ...discoveryArgs, discoveryOnly: true });
  const reserveClaims = computeReserveClaims({
    periods: discoveryArgs.periods, periodsAvailable: discovery.periodsAvailable,
    deficitsByPeriod: discovery.deficitsByPeriod,
    lockedClaims: findLockedReserveClaims([...predictionRows, ...confirmedRowsAfterToday, ...(tables.pending_transactions || [])], ledgerCurrency)
  });
  const plan = computeProjectionPlan({ ...argumentsForPass(), reserveClaims });
  assertJsonValue(plan);
  return { protocolVersion: ENGINE_PROTOCOL_VERSION, engineVersion: ENGINE_VERSION, plan };
}

/** String bridge suitable for an embedded runtime; errors remain explicit JSON. */
export function calculateProjectionJson(requestJson) {
  try {
    if (typeof requestJson !== "string") throw new Error("Request must be a JSON string");
    return JSON.stringify({ ok: true, ...calculateProjection(JSON.parse(requestJson)) });
  } catch (error) {
    return JSON.stringify({ ok: false, protocolVersion: ENGINE_PROTOCOL_VERSION,
      engineVersion: ENGINE_VERSION, error: { code: "CALCULATION_FAILED", message: error.message } });
  }
}

export { changeLocalLedgerCurrency, changeLocalLedgerCurrencyJson } from "./local-ledger-currency.js";
