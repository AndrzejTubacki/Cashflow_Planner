import { requireHolidayCountry, requireIsoDate, requireIsoMonth } from "./cashflow-date-utils.js";
import { requireSupportedCurrency } from "./cashflow-fx-provider-utils.js";
import { roundMoneyAmount } from "./cashflow-money-utils.js";
import { badRequest } from "./cashflow-user-utils.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SOURCE_FIELDS = [
  "source_recurring_expense_id",
  "source_recurring_income_id",
  "source_one_off_id",
  "source_flex_id",
  "source_goal_id"
];
const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/;

const TABLE_COLUMNS = {
  settings: [
    "id", "ledger_currency", "timezone", "locale", "holiday_country", "future_periods",
    "minimum_reserve_enabled", "minimum_reserve_amount", "budget_period_income_id",
    "fx_buffer_percent", "fx_provider", "fx_used_currencies", "manual_fx_rates",
    "auto_backup_enabled", "backup_interval_minutes", "backup_retention_count", "backup_location",
    "ntfy_url", "notification_delivery_time", "notify_goal_impossible",
    "notify_necessary_underfunded", "notify_funding_shortfall", "notify_income_missing",
    "notify_pending_summary", "notify_goal_funded", "notify_fx_changed",
    "ntfy_priority_goal_impossible", "ntfy_priority_necessary_underfunded",
    "ntfy_priority_funding_shortfall", "ntfy_priority_income_missing",
    "ntfy_priority_pending_summary", "ntfy_priority_goal_funded", "ntfy_priority_fx_changed",
    "necessary_underfunded_repeat_days", "setup_completed", "setup_completed_at", "updated_at"
  ],
  fx_rates_cache: [
    "base_currency", "quote_currency", "currency", "rate_date", "rate", "effective_date",
    "source", "raw_json", "updated_at"
  ],
  ledger_currency_events: [
    "id", "old_currency", "new_currency", "old_balance", "converted_opening_balance",
    "fx_rate", "rate_date", "source", "details", "created_at"
  ],
  planned_transactions: [
    "id", "type", "operating_priority", "goal_priority", "created_at", "updated_at"
  ],
  recurring_expenses: [
    "id", "name", "currency", "amount", "prediction_strategy", "prediction_substitute_missing",
    "prediction_min_recorded_months", "necessary", "active", "repeat_every_months",
    "start_month_year", "anchor_type", "anchor_day_of_month", "anchor_offset_days",
    "anchor_business_day_adjustment", "anchor_holiday_country", "planned_transaction_id",
    "created_at", "updated_at"
  ],
  recurring_incomes: [
    "id", "name", "currency", "amount", "prediction_strategy", "prediction_substitute_missing",
    "prediction_min_recorded_months", "active", "repeat_every_months", "start_month_year",
    "anchor_type", "anchor_day_of_month", "anchor_offset_days",
    "anchor_business_day_adjustment", "anchor_holiday_country", "period_setting",
    "created_at", "updated_at"
  ],
  flex_transactions: [
    "id", "name", "currency", "amount", "active", "allow_split", "min_amount", "max_amount",
    "planned_transaction_id", "created_at", "updated_at"
  ],
  goals: [
    "id", "name", "currency", "amount", "active", "due_date", "planned_transaction_id",
    "created_at", "updated_at"
  ],
  one_off_transactions: [
    "id", "name", "currency", "amount", "type", "date", "created_at", "updated_at"
  ],
  pending_transactions: [
    "id", "name", "currency", "amount", "type", "date", ...SOURCE_FIELDS, "fx_rate",
    "buffered_fx_rate", "ledger_currency", "status", "funded_amount", "requested_amount",
    "ledger_amount", "running_balance", "pending_origin", "note", "occurrence_key", "created_at", "updated_at"
  ],
  confirmed_transactions: [
    "id", "name", "currency", "amount", "type", "date", "confirmed_date", "fx_rate",
    "buffered_fx_rate", "ledger_currency", "running_balance_pln", "ledger_amount",
    ...SOURCE_FIELDS, "occurrence_key", "created_at", "updated_at"
  ]
};

const REQUIRED_FIELDS = {
  fx_rates_cache: ["base_currency", "currency", "rate_date", "rate", "source", "updated_at"],
  ledger_currency_events: [
    "id", "old_currency", "new_currency", "old_balance", "converted_opening_balance",
    "fx_rate", "rate_date", "source", "created_at"
  ],
  planned_transactions: ["id", "type", "created_at", "updated_at"],
  recurring_expenses: [
    "id", "name", "currency", "amount", "prediction_strategy", "repeat_every_months",
    "anchor_type", "planned_transaction_id", "created_at", "updated_at"
  ],
  recurring_incomes: [
    "id", "name", "currency", "amount", "prediction_strategy", "repeat_every_months",
    "anchor_type", "created_at", "updated_at"
  ],
  flex_transactions: [
    "id", "name", "currency", "amount", "planned_transaction_id",
    "created_at", "updated_at"
  ],
  goals: ["id", "name", "currency", "amount", "due_date", "planned_transaction_id", "created_at", "updated_at"],
  one_off_transactions: ["id", "name", "currency", "amount", "type", "date", "created_at", "updated_at"],
  pending_transactions: ["id", "name", "currency", "amount", "type", "date", "created_at", "updated_at"],
  confirmed_transactions: [
    "id", "name", "currency", "amount", "type", "date", "confirmed_date",
    "running_balance_pln", "created_at", "updated_at"
  ]
};

function detail(table, row, value, field, reason) {
  return {
    table,
    row: row + 1,
    id: typeof value?.id === "string" ? value.id : null,
    field,
    reason
  };
}

function fail(details, message = "Full import contains invalid rows") {
  throw badRequest(message, details);
}

function isPresent(row, field) {
  return Object.prototype.hasOwnProperty.call(row || {}, field);
}

function requireString(details, table, index, row, field, { id = false } = {}) {
  if (!isPresent(row, field) || typeof row[field] !== "string" || !row[field].trim()) {
    details.push(detail(table, index, row, field, "required"));
    return null;
  }
  const value = row[field].trim();
  if (id && !ID_PATTERN.test(row[field])) {
    details.push(detail(table, index, row, field, "invalid_id"));
    return null;
  }
  return value;
}

function optionalString(details, table, index, row, field) {
  if (!isPresent(row, field) || row[field] === null) return null;
  if (typeof row[field] !== "string") {
    details.push(detail(table, index, row, field, "must_be_string"));
    return null;
  }
  return row[field];
}

function optionalId(details, table, index, row, field) {
  if (!isPresent(row, field) || row[field] === null) return null;
  if (typeof row[field] !== "string" || !ID_PATTERN.test(row[field])) {
    details.push(detail(table, index, row, field, "invalid_id"));
    return null;
  }
  return row[field];
}

function requireNumber(details, table, index, row, field, options = {}) {
  const {
    allowNull = false,
    integer = false,
    min = null,
    exclusiveMin = false,
    max = null,
    money = false
  } = options;
  if (allowNull && (!isPresent(row, field) || row[field] === null)) return null;
  const value = row[field];
  if (
    !isPresent(row, field)
    || value === null
    || typeof value === "boolean"
    || (typeof value === "string" && !value.trim())
    || !Number.isFinite(Number(value))
  ) {
    details.push(detail(table, index, row, field, "must_be_finite_number"));
    return null;
  }
  const number = Number(value);
  if (integer && !Number.isInteger(number)) details.push(detail(table, index, row, field, "must_be_integer"));
  if (min !== null && (exclusiveMin ? number <= min : number < min)) {
    details.push(detail(table, index, row, field, exclusiveMin ? "must_be_positive" : "below_minimum"));
  }
  if (max !== null && number > max) details.push(detail(table, index, row, field, "above_maximum"));
  const normalized = money ? roundMoneyAmount(number) : number;
  row[field] = normalized;
  return normalized;
}

function optionalNumber(details, table, index, row, field, options = {}) {
  const { allowNull = true, ...numberOptions } = options;
  if (!isPresent(row, field)) return null;
  if (row[field] === null && allowNull) return null;
  return requireNumber(details, table, index, row, field, numberOptions);
}

function booleanField(details, table, index, row, field, { optional = false } = {}) {
  if (optional && !isPresent(row, field)) return;
  if (![true, false, 0, 1].includes(row[field])) {
    details.push(detail(table, index, row, field, "must_be_boolean_or_zero_or_one"));
    return;
  }
  row[field] = row[field] === true || row[field] === 1 ? 1 : 0;
}

function enumField(details, table, index, row, field, allowed, { optional = false } = {}) {
  if (optional && !isPresent(row, field)) return;
  if (!allowed.includes(row[field])) details.push(detail(table, index, row, field, "unsupported_value"));
}

function dateField(details, table, index, row, field, { optional = false } = {}) {
  if (optional && (!isPresent(row, field) || row[field] === null)) return;
  try {
    row[field] = requireIsoDate(row[field], field);
  } catch {
    details.push(detail(table, index, row, field, "invalid_date"));
  }
}

function monthField(details, table, index, row, field) {
  if (!isPresent(row, field) || row[field] === null) return;
  try {
    row[field] = requireIsoMonth(row[field], field);
  } catch {
    details.push(detail(table, index, row, field, "invalid_month"));
  }
}

function currencyField(details, table, index, row, field, { optional = false } = {}) {
  if (optional && !isPresent(row, field)) return;
  try {
    row[field] = requireSupportedCurrency(row[field], field);
  } catch {
    details.push(detail(table, index, row, field, "unsupported_currency"));
  }
}

function timestampField(details, table, index, row, field, { optional = false } = {}) {
  if (optional && (!isPresent(row, field) || row[field] === null)) return;
  const value = typeof row[field] === "string" ? row[field].trim() : "";
  const match = value.match(TIMESTAMP_PATTERN);
  let valid = Boolean(match) && Number.isFinite(Date.parse(value));
  if (match) {
    try {
      requireIsoDate(match[1], field);
    } catch {
      valid = false;
    }
    valid = valid
      && Number(match[2]) <= 23
      && Number(match[3]) <= 59
      && Number(match[4]) <= 59;
  }
  if (!valid) {
    details.push(detail(table, index, row, field, "invalid_timestamp"));
    return;
  }
  row[field] = value;
}

function jsonField(details, table, index, row, field, { optional = false } = {}) {
  if (optional && (!isPresent(row, field) || row[field] === null)) return;
  if (typeof row[field] !== "string") {
    details.push(detail(table, index, row, field, "must_be_json_string"));
    return;
  }
  try {
    JSON.parse(row[field]);
  } catch {
    details.push(detail(table, index, row, field, "invalid_json"));
  }
}

function validateShape(details, table, rows) {
  const allowed = new Set(TABLE_COLUMNS[table]);
  const required = REQUIRED_FIELDS[table] || [];
  const ids = new Set();

  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      details.push(detail(table, index, row, null, "must_be_object"));
      return;
    }
    for (const field of Object.keys(row)) {
      if (!allowed.has(field)) details.push(detail(table, index, row, field, "unknown_field"));
    }
    for (const field of required) {
      if (!isPresent(row, field) || row[field] === null || row[field] === "") {
        details.push(detail(table, index, row, field, "required"));
      }
    }
    if (table !== "fx_rates_cache" && table !== "settings") {
      const id = requireString(details, table, index, row, "id", { id: true });
      if (id) {
        if (ids.has(id)) details.push(detail(table, index, row, "id", "duplicate_id"));
        ids.add(id);
      }
    }
  });
}

function validateCommonEntity(details, table, index, row, { amountMin = 0, amountExclusive = false } = {}) {
  requireString(details, table, index, row, "name");
  currencyField(details, table, index, row, "currency");
  requireNumber(details, table, index, row, "amount", {
    min: amountMin,
    exclusiveMin: amountExclusive,
    money: true
  });
  timestampField(details, table, index, row, "created_at");
  timestampField(details, table, index, row, "updated_at");
}

function validateRecurring(details, table, index, row, kind) {
  validateCommonEntity(details, table, index, row);
  enumField(details, table, index, row, "prediction_strategy", kind === "expense" ? ["fixed", "12month_max"] : ["fixed", "12month_min"]);
  enumField(details, table, index, row, "prediction_substitute_missing", [
    "none", "starting_value", "average_extreme_starting_value", "median_recorded",
    "last_confirmed", "previous_year_same_month", "require_min_recorded_months"
  ], { optional: true });
  optionalNumber(details, table, index, row, "prediction_min_recorded_months", {
    allowNull: false,
    min: 1,
    max: 12,
    integer: true
  });
  booleanField(details, table, index, row, "active", { optional: true });
  requireNumber(details, table, index, row, "repeat_every_months", { min: 1, max: 12, integer: true });
  monthField(details, table, index, row, "start_month_year");
  enumField(details, table, index, row, "anchor_type", ["day_of_month", "month_end"]);
  optionalNumber(details, table, index, row, "anchor_day_of_month", { min: 1, max: 31, integer: true });
  optionalNumber(details, table, index, row, "anchor_offset_days", { integer: true });
  enumField(details, table, index, row, "anchor_business_day_adjustment", ["none", "previous", "next"], { optional: true });
  if (isPresent(row, "anchor_holiday_country") && row.anchor_holiday_country !== null) {
    try {
      row.anchor_holiday_country = requireHolidayCountry(row.anchor_holiday_country);
    } catch {
      details.push(detail(table, index, row, "anchor_holiday_country", "unsupported_holiday_country"));
    }
  }
  if (row.anchor_type === "day_of_month" && !Number.isInteger(Number(row.anchor_day_of_month))) {
    details.push(detail(table, index, row, "anchor_day_of_month", "required_for_day_of_month"));
  }
  if (Number(row.repeat_every_months) > 1 && !row.start_month_year) {
    details.push(detail(table, index, row, "start_month_year", "required_for_multi_month_schedule"));
  }
  if (kind === "expense") {
    booleanField(details, table, index, row, "necessary", { optional: true });
    requireString(details, table, index, row, "planned_transaction_id", { id: true });
  } else {
    booleanField(details, table, index, row, "period_setting", { optional: true });
  }
}

function validateSources(details, table, index, row, { requireImported = null, expectedTypes = null } = {}) {
  const sources = SOURCE_FIELDS
    .map(field => [field, optionalId(details, table, index, row, field)])
    .filter(([, value]) => value);
  if (sources.length > 1) details.push(detail(table, index, row, null, "multiple_sources"));
  if (!sources.length) return;

  const [field, id] = sources[0];
  if (requireImported && !requireImported[field]?.has(id)) {
    details.push(detail(table, index, row, field, "source_not_found"));
  }
  if (expectedTypes?.[field] && !expectedTypes[field].includes(row.type)) {
    details.push(detail(table, index, row, "type", "source_type_mismatch"));
  }
}

function validateRows(exportData, options = {}) {
  const { validateBudgetPeriodIncome = true } = options;
  const details = [];
  const planning = exportData.planning;
  for (const table of Object.keys(TABLE_COLUMNS).filter(name => name !== "confirmed_transactions")) {
    validateShape(details, table, planning[table] || []);
  }
  for (const [year, rows] of Object.entries(exportData.ledgers)) {
    validateShape(details, `confirmed_transactions`, rows);
  }
  if (details.length) fail(details);

  const fxKeys = new Set();
  const settings = planning.settings[0];
  if (settings.id !== 1) details.push(detail("settings", 0, settings, "id", "must_equal_one"));
  timestampField(details, "settings", 0, settings, "updated_at");
  timestampField(details, "settings", 0, settings, "setup_completed_at", { optional: true });

  planning.fx_rates_cache.forEach((row, index) => {
    currencyField(details, "fx_rates_cache", index, row, "base_currency");
    currencyField(details, "fx_rates_cache", index, row, "quote_currency", { optional: true });
    currencyField(details, "fx_rates_cache", index, row, "currency");
    dateField(details, "fx_rates_cache", index, row, "rate_date");
    dateField(details, "fx_rates_cache", index, row, "effective_date", { optional: true });
    requireNumber(details, "fx_rates_cache", index, row, "rate", { min: 0, exclusiveMin: true });
    requireString(details, "fx_rates_cache", index, row, "source");
    jsonField(details, "fx_rates_cache", index, row, "raw_json", { optional: true });
    timestampField(details, "fx_rates_cache", index, row, "updated_at");
    if (row.currency !== row.base_currency) details.push(detail("fx_rates_cache", index, row, "currency", "must_match_base_currency"));
    const key = `${row.base_currency}/${row.quote_currency || "PLN"}/${row.rate_date}`;
    if (fxKeys.has(key)) details.push(detail("fx_rates_cache", index, row, null, "duplicate_pair_date"));
    fxKeys.add(key);
  });

  planning.ledger_currency_events.forEach((row, index) => {
    currencyField(details, "ledger_currency_events", index, row, "old_currency");
    currencyField(details, "ledger_currency_events", index, row, "new_currency");
    requireNumber(details, "ledger_currency_events", index, row, "old_balance", { money: true });
    requireNumber(details, "ledger_currency_events", index, row, "converted_opening_balance", { money: true });
    requireNumber(details, "ledger_currency_events", index, row, "fx_rate", { min: 0, exclusiveMin: true });
    dateField(details, "ledger_currency_events", index, row, "rate_date");
    requireString(details, "ledger_currency_events", index, row, "source");
    jsonField(details, "ledger_currency_events", index, row, "details", { optional: true });
    timestampField(details, "ledger_currency_events", index, row, "created_at");
  });

  planning.planned_transactions.forEach((row, index) => {
    enumField(details, "planned_transactions", index, row, "type", ["recurring_expense", "flex", "goal"]);
    optionalNumber(details, "planned_transactions", index, row, "operating_priority", { min: 1, integer: true });
    optionalNumber(details, "planned_transactions", index, row, "goal_priority", { min: 1, integer: true });
    timestampField(details, "planned_transactions", index, row, "created_at");
    timestampField(details, "planned_transactions", index, row, "updated_at");
  });

  planning.recurring_expenses.forEach((row, index) => validateRecurring(details, "recurring_expenses", index, row, "expense"));
  planning.recurring_incomes.forEach((row, index) => validateRecurring(details, "recurring_incomes", index, row, "income"));
  planning.flex_transactions.forEach((row, index) => {
    validateCommonEntity(details, "flex_transactions", index, row);
    booleanField(details, "flex_transactions", index, row, "active", { optional: true });
    booleanField(details, "flex_transactions", index, row, "allow_split", { optional: true });
    optionalNumber(details, "flex_transactions", index, row, "min_amount", { min: 0, money: true });
    optionalNumber(details, "flex_transactions", index, row, "max_amount", { min: 0, money: true });
    requireString(details, "flex_transactions", index, row, "planned_transaction_id", { id: true });
    if (row.min_amount !== null && row.max_amount !== null && Number(row.min_amount) > Number(row.max_amount)) {
      details.push(detail("flex_transactions", index, row, "min_amount", "greater_than_max_amount"));
    }
  });
  planning.goals.forEach((row, index) => {
    validateCommonEntity(details, "goals", index, row, { amountMin: 0, amountExclusive: true });
    booleanField(details, "goals", index, row, "active", { optional: true });
    dateField(details, "goals", index, row, "due_date");
    requireString(details, "goals", index, row, "planned_transaction_id", { id: true });
  });
  planning.one_off_transactions.forEach((row, index) => {
    validateCommonEntity(details, "one_off_transactions", index, row);
    enumField(details, "one_off_transactions", index, row, "type", ["income", "expense"]);
    dateField(details, "one_off_transactions", index, row, "date");
  });

  const sourceSets = {
    source_recurring_expense_id: new Set(planning.recurring_expenses.map(row => row.id)),
    source_recurring_income_id: new Set(planning.recurring_incomes.map(row => row.id)),
    source_one_off_id: new Set(planning.one_off_transactions.map(row => row.id)),
    source_flex_id: new Set(planning.flex_transactions.map(row => row.id)),
    source_goal_id: new Set(planning.goals.map(row => row.id))
  };
  const expectedTypes = {
    source_recurring_expense_id: ["expense"],
    source_recurring_income_id: ["income"],
    source_one_off_id: ["income", "expense"],
    source_flex_id: ["expense"],
    source_goal_id: ["goal_allocation"]
  };
  const oneOffTypes = new Map(planning.one_off_transactions.map(row => [row.id, row.type]));
  const occurrenceKeys = new Map();

  planning.pending_transactions.forEach((row, index) => {
    validateCommonEntity(details, "pending_transactions", index, row);
    enumField(details, "pending_transactions", index, row, "type", ["income", "expense", "goal_allocation"]);
    dateField(details, "pending_transactions", index, row, "date");
    currencyField(details, "pending_transactions", index, row, "ledger_currency", { optional: true });
    enumField(details, "pending_transactions", index, row, "status", ["pending", "partial", "underfunded", "funded"], { optional: true });
    enumField(details, "pending_transactions", index, row, "pending_origin", ["projection", "scheduled", "manual", "system"], { optional: true });
    for (const field of ["fx_rate", "buffered_fx_rate"]) optionalNumber(details, "pending_transactions", index, row, field, { min: 0, exclusiveMin: true });
    for (const field of ["funded_amount", "requested_amount", "ledger_amount"]) {
      optionalNumber(details, "pending_transactions", index, row, field, { min: 0, money: true });
    }
    optionalNumber(details, "pending_transactions", index, row, "running_balance", { money: true });
    optionalString(details, "pending_transactions", index, row, "note");
    validateSources(details, "pending_transactions", index, row, { requireImported: sourceSets, expectedTypes });
    if (row.source_one_off_id && oneOffTypes.get(row.source_one_off_id) !== row.type) {
      details.push(detail("pending_transactions", index, row, "type", "source_type_mismatch"));
    }
    timestampField(details, "pending_transactions", index, row, "created_at");
    timestampField(details, "pending_transactions", index, row, "updated_at");
    if (row.occurrence_key !== null && row.occurrence_key !== undefined) {
      requireString(details, "pending_transactions", index, row, "occurrence_key");
      if (occurrenceKeys.has(row.occurrence_key)) details.push(detail("pending_transactions", index, row, "occurrence_key", "duplicate_occurrence_key"));
      occurrenceKeys.set(row.occurrence_key, true);
    }
  });

  const plannedById = new Map(planning.planned_transactions.map(row => [row.id, row]));
  const planOwners = new Map();
  for (const [table, expectedType] of [["recurring_expenses", "recurring_expense"], ["flex_transactions", "flex"], ["goals", "goal"]]) {
    planning[table].forEach((row, index) => {
      const plan = plannedById.get(row.planned_transaction_id);
      if (!plan) details.push(detail(table, index, row, "planned_transaction_id", "planned_transaction_not_found"));
      else if (plan.type !== expectedType) details.push(detail(table, index, row, "planned_transaction_id", "planned_transaction_type_mismatch"));
      if (planOwners.has(row.planned_transaction_id)) details.push(detail(table, index, row, "planned_transaction_id", "planned_transaction_has_multiple_owners"));
      planOwners.set(row.planned_transaction_id, true);
    });
  }
  planning.planned_transactions.forEach((row, index) => {
    if (!planOwners.has(row.id)) details.push(detail("planned_transactions", index, row, "id", "planned_transaction_has_no_owner"));
  });

  const budgetIncomeId = planning.settings[0]?.budget_period_income_id;
  if (validateBudgetPeriodIncome && budgetIncomeId !== null && budgetIncomeId !== undefined) {
    optionalId(details, "settings", 0, planning.settings[0], "budget_period_income_id");
  }
  if (validateBudgetPeriodIncome && budgetIncomeId) {
    const income = planning.recurring_incomes.find(row => row.id === budgetIncomeId);
    if (!income || (income.active !== undefined && Number(income.active) !== 1) || Number(income.period_setting) !== 1) {
      details.push(detail("settings", 0, planning.settings[0], "budget_period_income_id", "invalid_period_setting_income"));
    }
  }

  const ledgerIds = new Set();
  const pendingIds = new Set(planning.pending_transactions.map(row => row.id));
  for (const [year, rows] of Object.entries(exportData.ledgers)) {
    rows.forEach((row, index) => {
      if (ledgerIds.has(row.id)) {
        details.push(detail(`ledger_${year}.confirmed_transactions`, index, row, "id", "duplicate_id"));
      }
      if (pendingIds.has(row.id)) {
        details.push(detail(`ledger_${year}.confirmed_transactions`, index, row, "id", "duplicate_id"));
      }
      ledgerIds.add(row.id);
      validateCommonEntity(details, `ledger_${year}.confirmed_transactions`, index, row);
      enumField(details, `ledger_${year}.confirmed_transactions`, index, row, "type", ["income", "expense"]);
      dateField(details, `ledger_${year}.confirmed_transactions`, index, row, "date");
      dateField(details, `ledger_${year}.confirmed_transactions`, index, row, "confirmed_date");
      if (String(row.confirmed_date || "").slice(0, 4) !== year) {
        details.push(detail(`ledger_${year}.confirmed_transactions`, index, row, "confirmed_date", "ledger_year_mismatch"));
      }
      currencyField(details, `ledger_${year}.confirmed_transactions`, index, row, "ledger_currency", { optional: true });
      for (const field of ["fx_rate", "buffered_fx_rate"]) optionalNumber(details, `ledger_${year}.confirmed_transactions`, index, row, field, { min: 0, exclusiveMin: true });
      requireNumber(details, `ledger_${year}.confirmed_transactions`, index, row, "running_balance_pln", { money: true });
      optionalNumber(details, `ledger_${year}.confirmed_transactions`, index, row, "ledger_amount", { min: 0, money: true });
      validateSources(details, `ledger_${year}.confirmed_transactions`, index, row);
      timestampField(details, `ledger_${year}.confirmed_transactions`, index, row, "created_at");
      timestampField(details, `ledger_${year}.confirmed_transactions`, index, row, "updated_at");
      if (row.occurrence_key !== null && row.occurrence_key !== undefined) {
        requireString(details, `ledger_${year}.confirmed_transactions`, index, row, "occurrence_key");
        if (occurrenceKeys.has(row.occurrence_key)) {
          details.push(detail(`ledger_${year}.confirmed_transactions`, index, row, "occurrence_key", "duplicate_occurrence_key"));
        }
        occurrenceKeys.set(row.occurrence_key, true);
      }
    });
  }

  if (details.length) fail(details);
}

export function validateFullImportRows(exportData, options = {}) {
  validateRows(exportData, options);
  return exportData;
}
