import { normalizeLedgerCorrectionPayload as correctionPayload } from '../engine/ledger-correction-intent.js';
import { requireSupportedCurrency } from "../engine/cashflow-fx-provider-utils.js";
import { createHash } from "node:crypto";
import { requireIsoDate } from "../engine/cashflow-date-utils.js";
import { isReserveTransferOccurrenceKey } from "../engine/cashflow-occurrence-utils.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`Invalid ${label} fields`);
  }
}

/** Field shapes for planning-source operations. Shape only: the host applies the
 * server's own semantic validators and mutation functions inside its commit. */
const FIELD_TYPES = {
  name: "text", currency: "currency", amount: "money", active: "boolean", priority: "positiveInteger",
  type: "token", date: "date", due_date: "date",
  prediction_strategy: "token", prediction_substitute_missing: "token", prediction_min_recorded_months: "integer",
  repeat_every_months: "integer", start_month_year: "nullableToken", end_month_year: "nullableToken", anchor_type: "token", anchor_day_of_month: "nullableInteger",
  anchor_offset_days: "integer", anchor_business_day_adjustment: "token", anchor_holiday_country: "nullableToken",
  period_setting: "boolean", necessary: "boolean", anchor_income_id: "nullableToken",
  allow_split: "boolean", min_amount: "nullableMoney", max_amount: "nullableMoney"
};
const RECURRING = ["name", "currency", "amount", "active", "prediction_strategy", "prediction_substitute_missing",
  "prediction_min_recorded_months", "repeat_every_months", "start_month_year", "end_month_year", "anchor_type", "anchor_day_of_month",
  "anchor_offset_days", "anchor_business_day_adjustment", "anchor_holiday_country"];
/** Planning entities synchronized as create/update/delete intents (no derived rows). */
export const PLANNING_ENTITY_FIELDS = {
  "one-off": ["name", "currency", "amount", "type", "date"],
  "recurring-income": [...RECURRING, "period_setting"],
  "recurring-expense": [...RECURRING, "necessary", "anchor_income_id", "priority"],
  goal: ["name", "currency", "amount", "active", "due_date", "priority"],
  flex: ["name", "currency", "amount", "active", "allow_split", "min_amount", "max_amount", "priority"]
};
/** Every kind the contract can normalize; hosts advertise only what they apply. */
export const APP_OPERATION_KINDS = ["one-off.create", ...Object.keys(PLANNING_ENTITY_FIELDS).flatMap(entity =>
  [...(entity === "one-off" ? [] : [`${entity}.create`]), `${entity}.update`, `${entity}.delete`]),
  "occurrence.confirm", "ledger.correct", "one-off.dismiss-remainder", "settings.update"];

/** Financial settings a device may change. Notifications and operational/infrastructure settings are excluded. */
export const SYNC_SETTINGS_FIELDS = ["ledger_currency", "future_periods", "timezone", "holiday_country", "minimum_reserve_enabled",
  "minimum_reserve_amount", "budget_period_income_id", "fx_buffer_percent", "manual_fx_rates"];

function settingsPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new Error("Invalid operation payload");
  }
  const keys = Object.keys(payload);
  if (keys.length === 0 || keys.some(key => !SYNC_SETTINGS_FIELDS.includes(key))) throw new Error("Unsupported settings field");
  const result = {};
  for (const key of keys.sort()) {
    const value = payload[key];
    if (key === "ledger_currency") result[key] = requireSupportedCurrency(value);
    else if (key === "future_periods") result[key] = field("priority", value);
    else if (key === "timezone") {
      if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_+\-\/]{0,63}$/.test(value)) throw new Error("Invalid timezone");
      result[key] = value;
    } else if (key === "holiday_country") result[key] = field("anchor_type", value);
    else if (key === "minimum_reserve_enabled") result[key] = field("active", value);
    else if (key === "minimum_reserve_amount") result[key] = money(value, false);
    else if (key === "budget_period_income_id") result[key] = field("anchor_income_id", value);
    else if (key === "fx_buffer_percent") {
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Invalid fx_buffer_percent");
      result[key] = value;
    } else {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64) throw new Error("Invalid manual_fx_rates");
      result[key] = Object.fromEntries(Object.keys(value).sort().map(pair => {
        if (!/^[A-Z]{3}(\/[A-Z]{3})?$/.test(pair) || !Number.isFinite(value[pair]) || value[pair] <= 0 || value[pair] > 1000000) {
          throw new Error("Invalid manual_fx_rates");
        }
        return [pair, value[pair]];
      }));
    }
  }
  return result;
}

function remainderPayload(payload) {
  exact(payload, ["occurrenceKey"], "remainder payload");
  if (typeof payload.occurrenceKey !== "string" || !/^one_off_remainder:[A-Za-z0-9_-]{1,64}:[1-9][0-9]{0,8}$/.test(payload.occurrenceKey)) {
    throw new Error("Only a generated one-off remainder can be dismissed");
  }
  return { occurrenceKey: payload.occurrenceKey };
}

/** Confirm one generated/pending occurrence with the actual amount, payment date
 * and (for another currency) the actual rate. No balances or plans are uploaded. */
function confirmationPayload(payload) {
  exact(payload, ["occurrenceKey", "amount", "confirmedDate", "fxRate"], "confirmation payload");
  if (typeof payload.occurrenceKey !== "string" || !payload.occurrenceKey || payload.occurrenceKey.length > 256
    || /[\u0000-\u001f\u007f]/.test(payload.occurrenceKey)
    || (payload.occurrenceKey.startsWith("reserve_transfer:") && !isReserveTransferOccurrenceKey(payload.occurrenceKey))) {
    throw new Error("Invalid occurrence identity");
  }
  const amount = money(payload.amount, false);
  if (amount <= 0 && !payload.occurrenceKey.startsWith("ledger_currency_conversion:")
    && !isReserveTransferOccurrenceKey(payload.occurrenceKey)) throw new Error("Invalid operation amount");
  requireIsoDate(payload.confirmedDate);
  if (payload.fxRate !== null && (!Number.isFinite(payload.fxRate) || payload.fxRate <= 0 || payload.fxRate > 1000000)) {
    throw new Error("Invalid exchange rate");
  }
  return { amount, confirmedDate: payload.confirmedDate, fxRate: payload.fxRate, occurrenceKey: payload.occurrenceKey };
}


function money(value, nullable) {
  if (nullable && value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 9999999999.99 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) {
    throw new Error("Invalid operation amount");
  }
  return Math.round(value * 100) / 100;
}
function field(name, value) {
  switch (FIELD_TYPES[name]) {
    case "text":
      if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${name}`);
      return value;
    case "currency": if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw new Error(`Invalid ${name}`); return value;
    case "money": return money(value, false);
    case "nullableMoney": return money(value, true);
    case "boolean": if (typeof value !== "boolean") throw new Error(`Invalid ${name}`); return value;
    case "positiveInteger": if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`); return value;
    case "integer": if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${name}`); return value;
    case "nullableInteger": if (value !== null && !Number.isSafeInteger(value)) throw new Error(`Invalid ${name}`); return value;
    case "date": requireIsoDate(value); return value;
    case "token": if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error(`Invalid ${name}`); return value;
    case "nullableToken": if (value !== null && (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value))) throw new Error(`Invalid ${name}`); return value;
    default: throw new Error(`Unsupported ${name}`);
  }
}
/** Sorted keys and normalized values give one fingerprint per intent. */
function planningPayload(kind, payload) {
  const [entity, action] = kind.split(".");
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.getPrototypeOf(payload) !== Object.prototype) {
    throw new Error("Invalid operation payload");
  }
  if (typeof payload.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.id)) throw new Error("Invalid operation entity identity");
  if (action === "create" && !UUID.test(payload.id)) throw new Error("New entities need a client-chosen UUID");
  const allowed = action === "delete"
    ? (entity === "recurring-income" ? ["reassignAnchorsToIncomeId", "fallbackAnchorsToFixedDay"] : [])
    : PLANNING_ENTITY_FIELDS[entity];
  const keys = Object.keys(payload).filter(key => key !== "id");
  if (keys.some(key => !allowed.includes(key))) throw new Error("Unsupported operation payload field");
  if (action === "update" && keys.length === 0) throw new Error("An update must change at least one field");
  const result = { id: UUID.test(payload.id) ? payload.id.toLowerCase() : payload.id };
  for (const key of keys.sort()) {
    if (key === "reassignAnchorsToIncomeId") result[key] = field("anchor_income_id", payload[key]);
    else if (key === "fallbackAnchorsToFixedDay") { if (typeof payload[key] !== "boolean") throw new Error("Invalid fallback choice"); result[key] = payload[key]; }
    else result[key] = field(key, payload[key]);
  }
  return result;
}

/** Draft v1: one atomic intent per operation, no balances, FX or generated plan uploads. */
export function normalizeAppOperation(input) {
  exact(input, ["version", "operationId", "budgetId", "epoch", "baseRevision", "kind", "payload"], "operation");
  if (input.version !== 1 || !APP_OPERATION_KINDS.includes(input.kind)) throw new Error("Unsupported operation protocol or kind");
  if (!UUID.test(input.operationId) || !UUID.test(input.epoch)
    || typeof input.operationId !== "string" || typeof input.epoch !== "string") throw new Error("Invalid operation identity");
  if (typeof input.budgetId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.budgetId)) throw new Error("Invalid operation budget");
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 || input.baseRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid operation revision");
  }
  if (input.kind !== "one-off.create") {
    return { version: 1, operationId: input.operationId.toLowerCase(), budgetId: input.budgetId,
      epoch: input.epoch.toLowerCase(), baseRevision: input.baseRevision, kind: input.kind,
      payload: input.kind === "ledger.correct" ? correctionPayload(input.payload)
        : input.kind === "occurrence.confirm" ? confirmationPayload(input.payload)
        : input.kind === "settings.update" ? settingsPayload(input.payload)
          : input.kind === "one-off.dismiss-remainder" ? remainderPayload(input.payload) : planningPayload(input.kind, input.payload) };
  }
  // one-off.create keeps its original exact shape so existing fingerprints stay valid.
  const p = input.payload;
  exact(p, ["id", "name", "currency", "amount", "type", "date"], "one-off payload");
  if (typeof p.id !== "string" || !UUID.test(p.id) || typeof p.name !== "string"
    || !p.name.trim() || p.name !== p.name.trim() || p.name.length > 100
    || /[\u0000-\u001f\u007f]/.test(p.name)) throw new Error("Invalid one-off identity or name");
  if (typeof p.currency !== "string" || !/^[A-Z]{3}$/.test(p.currency)
    || !Number.isFinite(p.amount) || p.amount <= 0 || Math.round(p.amount * 100) <= 0 || p.amount > 9999999999.99
    || Math.abs(p.amount * 100 - Math.round(p.amount * 100)) > 0.00001
    || !["income", "expense"].includes(p.type)) throw new Error("Invalid one-off amount, currency or type");
  requireIsoDate(p.date);
  // Fixed key order plus normalized UUID case gives one fingerprint regardless
  // of JSON object insertion order. Values are copied, never mutated in place.
  return { version: 1, operationId: input.operationId.toLowerCase(), budgetId: input.budgetId,
    epoch: input.epoch.toLowerCase(), baseRevision: input.baseRevision, kind: input.kind,
    payload: { id: p.id.toLowerCase(), name: p.name, currency: p.currency,
      amount: Math.round(p.amount * 100) / 100, type: p.type, date: p.date } };
}

export function appOperationFingerprint(operation) {
  return createHash("sha256").update(JSON.stringify(normalizeAppOperation(operation))).digest("hex");
}

export function appOperationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Journal-only cursor contract; not compatible with snapshot fingerprints. */
export function normalizeAppChangesRequest(input) {
  exact(input, ["budgetId", "epoch", "afterRevision", "limit"], "change request");
  if (typeof input.budgetId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.budgetId)
    || typeof input.epoch !== "string" || !UUID.test(input.epoch)
    || !Number.isSafeInteger(input.afterRevision) || input.afterRevision < 0
    || input.afterRevision > Number.MAX_SAFE_INTEGER
    || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("Invalid change cursor or page size");
  }
  return { budgetId: input.budgetId, epoch: input.epoch.toLowerCase(),
    afterRevision: input.afterRevision, limit: input.limit };
}

/** Receipt lookup never needs a financial payload or a current engine. It is
 * still bound to an exact budget/epoch/operation and requires current access. */
export function normalizeAppResultRequest(input) {
  exact(input, ["budgetId", "epoch", "operationId"], "result lookup");
  if (typeof input.budgetId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.budgetId)
    || typeof input.epoch !== "string" || !UUID.test(input.epoch)
    || typeof input.operationId !== "string" || !UUID.test(input.operationId)) throw new Error("Invalid result lookup identity");
  return { budgetId: input.budgetId, epoch: input.epoch.toLowerCase(), operationId: input.operationId.toLowerCase() };
}
