import path from "path";

import { requireHolidayCountry } from "./cashflow-date-utils.js";
import {
  FX_PROVIDER_IDS,
  SUPPORTED_FX_CURRENCIES,
  normalizeFxCurrencyList,
  normalizeManualFxPairs,
  normalizeManualFxRates,
  requireSupportedCurrency
} from "./cashflow-fx-provider-utils.js";
import {
  requireBoolean,
  requireNumber,
  validationError
} from "./cashflow-input-validation.js";

export const OPERATIONAL_SETTINGS_COLUMNS = new Set([
  "backup_location",
  "auto_backup_enabled",
  "backup_interval_minutes",
  "backup_retention_count",
  "ntfy_url",
  "notification_delivery_time",
  "notify_goal_impossible",
  "notify_necessary_underfunded",
  "notify_funding_shortfall",
  "notify_income_missing",
  "notify_pending_summary",
  "notify_goal_funded",
  "notify_fx_changed",
  "ntfy_priority_goal_impossible",
  "ntfy_priority_necessary_underfunded",
  "ntfy_priority_funding_shortfall",
  "ntfy_priority_income_missing",
  "ntfy_priority_pending_summary",
  "ntfy_priority_goal_funded",
  "ntfy_priority_fx_changed",
  "necessary_underfunded_repeat_days"
]);

export const USER_SETTINGS_UPDATE_KEYS = new Set([
  "future_periods",
  "locale",
  "ledger_currency",
  "timezone",
  "holiday_country",
  "minimum_reserve_enabled",
  "minimum_reserve_amount",
  "budget_period_income_id",
  "fx_buffer_percent",
  "fx_provider",
  "fx_used_currencies",
  "manual_fx_rates",
  ...OPERATIONAL_SETTINGS_COLUMNS
]);

const BOOLEAN_FIELDS = new Set([
  "minimum_reserve_enabled",
  "auto_backup_enabled",
  "notify_goal_impossible",
  "notify_necessary_underfunded",
  "notify_funding_shortfall",
  "notify_income_missing",
  "notify_pending_summary",
  "notify_goal_funded",
  "notify_fx_changed",
  "setup_completed"
]);

const PRIORITY_FIELDS = new Set([
  "ntfy_priority_goal_impossible",
  "ntfy_priority_necessary_underfunded",
  "ntfy_priority_funding_shortfall",
  "ntfy_priority_income_missing",
  "ntfy_priority_pending_summary",
  "ntfy_priority_goal_funded",
  "ntfy_priority_fx_changed"
]);

const PRIORITIES = new Set(["min", "low", "default", "high", "urgent"]);
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function requireTimezone(value, field = "timezone") {
  const timezone = String(value || "").trim();
  if (!timezone) {
    validationError(field, "required", `${field} is required`);
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    validationError(field, "unsupported_timezone", `${field} must be a supported IANA timezone`);
  }

  return timezone;
}

function requireLocale(value, normalizeLocale, field = "locale") {
  const locale = String(value || "").trim().toLowerCase();
  if (!locale || normalizeLocale(locale) !== locale) {
    validationError(field, "unsupported_locale", `${field} must be an available locale`);
  }
  return locale;
}

function requireCurrency(value, field) {
  try {
    return requireSupportedCurrency(value, field);
  } catch {
    validationError(field, "unsupported_currency", `${field} must be one of the supported currencies`);
  }
}

function requireHoliday(value, field) {
  try {
    return requireHolidayCountry(value, field);
  } catch {
    validationError(field, "unsupported_holiday_country", `${field} must be a supported holiday country`);
  }
}

function parseJsonValue(value, field) {
  if (typeof value === "object") return value;

  try {
    return JSON.parse(String(value));
  } catch {
    validationError(field, "invalid_json", `${field} must contain valid JSON`);
  }
}

function requireFxCurrencyList(value, ledgerCurrency) {
  const parsed = parseJsonValue(value, "fx_used_currencies");
  if (!Array.isArray(parsed)) {
    validationError("fx_used_currencies", "must_be_array", "fx_used_currencies must be an array");
  }

  const normalized = parsed.map(currency => String(currency || "").trim().toUpperCase());
  for (const currency of normalized) {
    if (!SUPPORTED_FX_CURRENCIES.includes(currency)) {
      validationError("fx_used_currencies", "unsupported_currency", "fx_used_currencies contains an unsupported currency");
    }
  }

  return JSON.stringify(normalizeFxCurrencyList(normalized, ledgerCurrency));
}

function requireManualFxRates(value, ledgerCurrency) {
  const parsed = parseJsonValue(value, "manual_fx_rates");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    validationError("manual_fx_rates", "must_be_object", "manual_fx_rates must be an object");
  }

  for (const [rawPair, rawRate] of Object.entries(parsed)) {
    const parts = String(rawPair || "").trim().toUpperCase().split("/");
    if (parts.length > 2 || parts.some(part => !part)) {
      validationError("manual_fx_rates", "invalid_pair", `manual_fx_rates contains an invalid pair: ${rawPair}`);
    }

    const [base, quote = ledgerCurrency] = parts;
    if (!SUPPORTED_FX_CURRENCIES.includes(base) || !SUPPORTED_FX_CURRENCIES.includes(quote)) {
      validationError("manual_fx_rates", "unsupported_pair", `manual_fx_rates contains an unsupported pair: ${rawPair}`);
    }

    if (
      typeof rawRate === "boolean"
      || rawRate === null
      || rawRate === undefined
      || (typeof rawRate === "string" && rawRate.trim() === "")
    ) {
      validationError("manual_fx_rates", "rate_must_be_positive", `manual_fx_rates rate must be positive for ${rawPair}`);
    }

    const rate = Number(rawRate);
    if (!Number.isFinite(rate) || rate <= 0) {
      validationError("manual_fx_rates", "rate_must_be_positive", `manual_fx_rates rate must be positive for ${rawPair}`);
    }

    if (base === quote) {
      if (parts.length === 2) {
        validationError("manual_fx_rates", "same_currency_pair", `manual_fx_rates contains a same-currency pair: ${rawPair}`);
      }
      continue;
    }
  }

  return JSON.stringify({
    ...normalizeManualFxRates(parsed),
    ...normalizeManualFxPairs(parsed, ledgerCurrency)
  });
}

function configuredBackupAllowedRoots() {
  return String(process.env.CASHFLOW_BACKUP_ALLOWED_ROOTS || "")
    .split(",")
    .map(root => root.trim())
    .filter(Boolean)
    .map(root => path.resolve(root));
}

function requireBackupLocation(value) {
  if (value === null || value === undefined || value === "") return null;

  const backupLocation = String(value).trim();
  if (!path.isAbsolute(backupLocation)) {
    validationError("backup_location", "must_be_absolute", "backup_location must be an absolute path");
  }

  const resolved = path.resolve(backupLocation);
  const allowed = configuredBackupAllowedRoots().some(root =>
    resolved === root || resolved.startsWith(`${root}${path.sep}`)
  );

  if (!allowed) {
    validationError("backup_location", "outside_allowed_roots", "backup_location must be under an allowed backup root");
  }

  return resolved;
}

function requireNtfyUrl(value) {
  if (value === null || value === undefined || value === "") return null;

  const ntfyUrl = String(value).trim();
  try {
    const parsed = new URL(ntfyUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported protocol");
  } catch {
    validationError("ntfy_url", "must_be_http_url", "ntfy_url must be a full http(s) URL, for example https://ntfy.example.com/topic");
  }

  return ntfyUrl;
}

export function validateAndNormalizeSettings(values = {}, options = {}) {
  // Keep validation independent from database writes so imports can fail before safety backups or mutations.
  const {
    allowedKeys = USER_SETTINGS_UPDATE_KEYS,
    allowedKeysOnly = false,
    currentSettings = {},
    includeOperationalSettings = true,
    normalizeLocale = value => String(value || "en").trim().toLowerCase()
  } = options;
  if (allowedKeysOnly) {
    const unknownField = Object.keys(values || {}).find(key => !allowedKeys.has(key));
    if (unknownField) {
      validationError(unknownField, "unsupported_setting", `${unknownField} is not a supported setting`);
    }
  }

  const next = { ...(values || {}) };

  if (!includeOperationalSettings) {
    for (const field of OPERATIONAL_SETTINGS_COLUMNS) {
      delete next[field];
    }
  }

  const has = field => Object.prototype.hasOwnProperty.call(next, field);
  const ledgerCurrency = has("ledger_currency")
    ? requireCurrency(next.ledger_currency, "ledger_currency")
    : requireCurrency(currentSettings.ledger_currency || "PLN", "ledger_currency");

  if (has("ledger_currency")) next.ledger_currency = ledgerCurrency;
  if (has("locale")) next.locale = requireLocale(next.locale, normalizeLocale);
  if (has("timezone")) next.timezone = requireTimezone(next.timezone);
  if (has("holiday_country")) next.holiday_country = requireHoliday(next.holiday_country, "holiday_country");

  if (has("future_periods")) {
    next.future_periods = requireNumber(next.future_periods, "future_periods", { min: 1, max: 60, integer: true });
  }
  if (has("minimum_reserve_amount")) {
    next.minimum_reserve_amount = requireNumber(next.minimum_reserve_amount, "minimum_reserve_amount", { min: 0 });
  }
  if (has("fx_buffer_percent")) {
    next.fx_buffer_percent = requireNumber(next.fx_buffer_percent, "fx_buffer_percent", { min: 0, max: 100 });
  }
  if (has("backup_interval_minutes")) {
    next.backup_interval_minutes = requireNumber(next.backup_interval_minutes, "backup_interval_minutes", { min: 1, integer: true });
  }
  if (has("backup_retention_count")) {
    next.backup_retention_count = requireNumber(next.backup_retention_count, "backup_retention_count", { min: 1, integer: true });
  }
  if (has("necessary_underfunded_repeat_days")) {
    next.necessary_underfunded_repeat_days = requireNumber(next.necessary_underfunded_repeat_days, "necessary_underfunded_repeat_days", { min: 1, integer: true });
  }

  for (const field of BOOLEAN_FIELDS) {
    if (has(field)) next[field] = requireBoolean(next[field], field);
  }

  if (has("fx_provider")) {
    const provider = String(next.fx_provider || "").trim().toLowerCase();
    if (!FX_PROVIDER_IDS.includes(provider)) {
      validationError("fx_provider", "unsupported_provider", "fx_provider must be a supported provider");
    }
    next.fx_provider = provider;
  }

  if (has("fx_used_currencies")) {
    next.fx_used_currencies = requireFxCurrencyList(next.fx_used_currencies, ledgerCurrency);
  }
  if (has("manual_fx_rates")) {
    next.manual_fx_rates = requireManualFxRates(next.manual_fx_rates, ledgerCurrency);
  }

  if (has("backup_location")) next.backup_location = requireBackupLocation(next.backup_location);
  if (has("ntfy_url")) next.ntfy_url = requireNtfyUrl(next.ntfy_url);

  if (has("notification_delivery_time")) {
    const time = String(next.notification_delivery_time || "").trim();
    if (!TIME_PATTERN.test(time)) {
      validationError("notification_delivery_time", "invalid_time", "notification_delivery_time must be a valid HH:MM value");
    }
    next.notification_delivery_time = time;
  }

  for (const field of PRIORITY_FIELDS) {
    if (!has(field)) continue;
    const priority = String(next[field] ?? "default").trim().toLowerCase();
    if (!PRIORITIES.has(priority)) {
      validationError(field, "unsupported_priority", `${field} must be a supported ntfy priority`);
    }
    next[field] = priority;
  }

  if (has("budget_period_income_id") && next.budget_period_income_id === "") {
    next.budget_period_income_id = null;
  }

  return next;
}
