export const SUPPORTED_FX_CURRENCIES = [
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP",
  "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR",
  "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR"
];

export const DEFAULT_TIMEZONE = "Europe/Warsaw";

export const TIMEZONE_OPTIONS = [
  DEFAULT_TIMEZONE,
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo"
];

export const HOLIDAY_COUNTRIES = [
  { code: "PL", label: "Poland" },
  { code: "DE", label: "Germany" }
];

export const FX_PROVIDER_OPTIONS = [
  { id: "disabled", label: "Disabled", note: "Only ledger-currency transactions can project without supplied rates." },
  { id: "manual", label: "Manual rates", note: "Use the rates entered below." },
  { id: "nbp", label: "NBP", note: "Polish central bank rates." },
  { id: "frankfurter", label: "Frankfurter", note: "ECB-backed rates for major currencies." }
];

export const PREDICTION_SUBSTITUTE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "starting_value", label: "Starting value" },
  { value: "average_extreme_starting_value", label: "Average of recorded extreme and starting value" },
  { value: "median_recorded", label: "Median recorded" },
  { value: "last_confirmed", label: "Last confirmed" },
  { value: "previous_year_same_month", label: "Previous year same month" },
  { value: "require_min_recorded_months", label: "Require minimum recorded months" }
];

export const NOTIFICATION_PRIORITY_OPTIONS = ["min", "low", "default", "high", "urgent"];

export const AUTH_MODE_OPTIONS = [
  { value: "none", label: "None" },
  { value: "external", label: "External SSO" },
  { value: "internal", label: "Internal login" }
];

export const AUTH_PROVISIONING_OPTIONS = [
  { value: "deny_unknown", label: "Deny unknown identities" },
  { value: "allow_invited", label: "Allow invited identities only" },
  { value: "allow_any", label: "Allow any authenticated identity" }
];

export const AUTH_PROVIDER_KINDS = ["oidc", "google", "github", "facebook"];

export const NOTIFICATION_TYPES = [
  { key: "goal_impossible", label: "Goal impossible" },
  { key: "necessary_underfunded", label: "Necessary transaction underfunded" },
  { key: "funding_shortfall", label: "Funding shortfall" },
  { key: "income_missing", label: "Missing income" },
  { key: "pending_summary", label: "Pending summary" },
  { key: "goal_funded", label: "Goal funded" },
  { key: "fx_changed", label: "FX changed projection" }
];
