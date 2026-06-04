import { requireHolidayCountry, requireIsoDate, requireIsoMonth } from "./cashflow-date-utils.js";
import { requireSupportedCurrency } from "./cashflow-fx-provider-utils.js";
import {
  hasOwn,
  rejectCallerSuppliedId,
  requireBoolean,
  requireEnum,
  requireNullableNumber,
  requireNumber
} from "./cashflow-input-validation.js";

const PREDICTION_SUBSTITUTES = [
  "none",
  "starting_value",
  "average_extreme_starting_value",
  "median_recorded",
  "last_confirmed",
  "previous_year_same_month",
  "require_min_recorded_months"
];

function normalizeIfPresent(next, field, normalize) {
  if (hasOwn(next, field)) next[field] = normalize(next[field], field);
}

function validateCommon(next, kind) {
  normalizeIfPresent(next, "currency", requireSupportedCurrency);
  if (hasOwn(next, "amount")) {
    next.amount = requireNumber(next.amount, "amount", { min: kind === "goal" ? 0.01 : 0 });
  }
  if (hasOwn(next, "active")) next.active = requireBoolean(next.active, "active");
}

function validateRecurring(next, kind) {
  const strategies = kind === "recurring-expense" ? ["fixed", "12month_max"] : ["fixed", "12month_min"];
  normalizeIfPresent(next, "prediction_strategy", (value, field) => requireEnum(value, field, strategies));
  normalizeIfPresent(next, "prediction_substitute_missing", (value, field) => requireEnum(value, field, PREDICTION_SUBSTITUTES));
  normalizeIfPresent(next, "prediction_min_recorded_months", (value, field) => requireNumber(value, field, {
    min: 1,
    max: 12,
    integer: true
  }));
  normalizeIfPresent(next, "repeat_every_months", (value, field) => requireNumber(value, field, {
    min: 1,
    max: 12,
    integer: true
  }));
  normalizeIfPresent(next, "start_month_year", (value, field) => value === null || value === ""
    ? null
    : requireIsoMonth(value, field));
  normalizeIfPresent(next, "anchor_type", (value, field) => requireEnum(value, field, ["day_of_month", "month_end"]));
  normalizeIfPresent(next, "anchor_day_of_month", (value, field) => requireNullableNumber(value, field, {
    min: 1,
    max: 31,
    integer: true
  }));
  normalizeIfPresent(next, "anchor_offset_days", (value, field) => requireNumber(value, field, { integer: true }));
  normalizeIfPresent(next, "anchor_business_day_adjustment", (value, field) => requireEnum(value, field, ["none", "previous", "next"]));
  normalizeIfPresent(next, "anchor_holiday_country", requireHolidayCountry);

  if (kind === "recurring-expense") {
    if (hasOwn(next, "necessary")) next.necessary = requireBoolean(next.necessary, "necessary");
    normalizeIfPresent(next, "priority", (value, field) => requireNumber(value, field, { min: 1, integer: true }));
  } else if (hasOwn(next, "period_setting")) {
    next.period_setting = requireBoolean(next.period_setting, "period_setting");
  }
}

export function validatePlanMutationInput(kind, input = {}, { create = false } = {}) {
  // Validate before FX/network work so malformed requests cannot cause external side effects.
  const next = { ...(input || {}) };
  if (create) rejectCallerSuppliedId(next);

  validateCommon(next, kind);

  if (kind === "recurring-expense" || kind === "recurring-income") {
    validateRecurring(next, kind);
  } else if (kind === "goal") {
    normalizeIfPresent(next, "priority", (value, field) => requireNumber(value, field, { min: 1, integer: true }));
    normalizeIfPresent(next, "due_date", requireIsoDate);
  } else if (kind === "flex") {
    normalizeIfPresent(next, "priority", (value, field) => requireNumber(value, field, { min: 1, integer: true }));
    if (hasOwn(next, "allow_split")) next.allow_split = requireBoolean(next.allow_split, "allow_split");
    normalizeIfPresent(next, "min_amount", (value, field) => requireNullableNumber(value, field, { min: 0 }));
    normalizeIfPresent(next, "max_amount", (value, field) => requireNullableNumber(value, field, { min: 0 }));
  } else if (kind === "one-off") {
    normalizeIfPresent(next, "type", (value, field) => requireEnum(value, field, ["income", "expense"]));
    normalizeIfPresent(next, "date", requireIsoDate);
  } else if (kind === "pending") {
    normalizeIfPresent(next, "date", requireIsoDate);
  }

  return next;
}
