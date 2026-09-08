export const DEFAULT_LEDGER_CURRENCY = "PLN";

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
  { code: "PL", labelKey: "Poland" },
  { code: "DE", labelKey: "Germany" }
];

export const FX_PROVIDER_OPTIONS = [
  {
    id: "disabled",
    labelKey: "Disabled",
    noteKey: "Only ledger-currency transactions can project without supplied rates."
  },
  {
    id: "manual",
    labelKey: "Manual rates",
    noteKey: "Use the rates entered below."
  },
  {
    id: "nbp",
    labelKey: "NBP",
    noteKey: "Polish central bank rates."
  },
  {
    id: "frankfurter",
    labelKey: "Frankfurter",
    noteKey: "ECB-backed rates for major currencies."
  }
];

export const FX_PROVIDER_NOTES = Object.fromEntries(
  FX_PROVIDER_OPTIONS.map(provider => [provider.id, provider.noteKey])
);

export const AUTH_MODES = ["none", "external", "internal"];

export const AUTH_PROVISIONING_MODES = ["deny_unknown", "allow_invited", "allow_any"];

export const AUTH_PROVIDER_KINDS = ["oidc", "google", "github", "facebook"];

export const PREDICTION_SUBSTITUTE_OPTIONS = [
  { value: "none", labelKey: "None" },
  { value: "starting_value", labelKey: "Starting value" },
  { value: "average_extreme_starting_value", labelKey: "Average of recorded extreme and starting value" },
  { value: "median_recorded", labelKey: "Median recorded" },
  { value: "last_confirmed", labelKey: "Last confirmed" },
  { value: "previous_year_same_month", labelKey: "Previous year same month" },
  { value: "require_min_recorded_months", labelKey: "Require minimum recorded months" }
];
