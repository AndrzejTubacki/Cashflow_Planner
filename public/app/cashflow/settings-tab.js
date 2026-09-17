import { escapeHtml } from "../utils.js";
import {
  DEFAULT_LEDGER_CURRENCY,
  DEFAULT_TIMEZONE,
  FX_PROVIDER_OPTIONS,
  HOLIDAY_COUNTRIES,
  SUPPORTED_FX_CURRENCIES,
  TIMEZONE_OPTIONS
} from "./constants.js";
import { hasCapability, renderHelpPopover, t } from "./shared.js";

function parseArraySetting(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObjectSetting(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (!value) return {};

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function observedForeignCurrencies(cashflow, ledgerCurrency = DEFAULT_LEDGER_CURRENCY) {
  const rows = [
    ...(cashflow?.recurringExpenses || []),
    ...(cashflow?.recurringIncomes || []),
    ...(cashflow?.oneOffs || []),
    ...(cashflow?.flexTransactions || []),
    ...(cashflow?.goals || []),
    ...(cashflow?.pendingTransactions || [])
  ];

  return [...new Set(rows
    .map(row => String(row.currency || "").toUpperCase())
    .filter(currency => currency && currency !== ledgerCurrency && SUPPORTED_FX_CURRENCIES.includes(currency))
  )].sort();
}

function renderFxCurrencySelector(locale, selectedCurrencies, ledgerCurrency = DEFAULT_LEDGER_CURRENCY) {
  const selected = new Set(selectedCurrencies);
  const availableCurrencies = SUPPORTED_FX_CURRENCIES.filter(currency => currency !== ledgerCurrency && !selected.has(currency));

  const options = (currencies) => currencies.map(currency => `
    <option value="${escapeHtml(currency)}">${escapeHtml(currency)}</option>
  `).join("");

  return `
    <div class="cashflow-m2m" data-fx-currency-selector>
      <div class="cashflow-m2m__column">
        <span>${escapeHtml(t(locale, "Available currencies"))}</span>
        <select multiple size="10" data-fx-currency-available>
          ${options(availableCurrencies)}
        </select>
      </div>

      <div class="cashflow-m2m__controls">
        <button type="button" class="btn-small" data-fx-currency-add>&gt;</button>
        <button type="button" class="btn-small" data-fx-currency-remove>&lt;</button>
      </div>

      <div class="cashflow-m2m__column">
        <span>${escapeHtml(t(locale, "Used currencies"))}</span>
        <select multiple size="10" name="fx_used_currencies" data-fx-currency-selected>
          ${options(selectedCurrencies)}
        </select>
      </div>
    </div>
  `;
}

function renderManualFxRates(locale, selectedCurrencies, manualRates, ledgerCurrency = DEFAULT_LEDGER_CURRENCY) {
  return `
    <div class="cashflow-manual-rates" data-manual-fx-rates>
      ${selectedCurrencies.length ? selectedCurrencies.map(currency => `
        <label data-manual-fx-rate-row="${escapeHtml(currency)}">
          <span>${escapeHtml(currency)} / ${escapeHtml(ledgerCurrency)}</span>
          <input
            type="number"
            min="0.000001"
            step="0.000001"
            value="${escapeHtml(String(manualRates[`${currency}/${ledgerCurrency}`] ?? manualRates[currency] ?? ""))}"
            data-manual-fx-rate="${escapeHtml(currency)}"
            placeholder="1.000000"
          >
        </label>
      `).join("") : `
        <small>${escapeHtml(t(locale, "Select at least one used currency to enter manual rates."))}</small>
      `}
    </div>
  `;
}

function renderDetailsSection(locale, titleKey, body) {
  return `
    <details class="cashflow-details cashflow-details-panel cashflow-settings-section">
      <summary class="cashflow-details-panel__summary">
        <div class="cashflow-details-panel__title">
          <span class="cashflow-details-panel__chevron">&gt;</span>
          <strong>${escapeHtml(t(locale, titleKey))}</strong>
        </div>
      </summary>
      <div class="cashflow-details-panel__body">
        <fieldset>
          <legend>${escapeHtml(t(locale, titleKey))}</legend>
          ${body}
        </fieldset>
      </div>
    </details>
  `;
}

function fieldLabel(locale, labelKey, helpKey = "") {
  const label = t(locale, labelKey);
  return `
    <span class="cashflow-field-label">
      ${escapeHtml(label)}
      ${helpKey ? renderHelpPopover(locale, label, t(locale, helpKey)) : ""}
    </span>
  `;
}

export function renderSettingsTab(locale, cashflow) {
  const settings = cashflow?.settings || {};
  const availableLocales = Array.isArray(cashflow?.availableLocales) && cashflow.availableLocales.length
    ? cashflow.availableLocales
    : [{ id: "en", label: "English" }];
  const selectedLocale = String(settings.locale || "en");
  const recurringIncomes = cashflow?.budgetPeriodIncomeOptions || cashflow?.recurringIncomes || [];
  const fxProvider = String(settings.fx_provider || "nbp");
  const ledgerCurrency = String(settings.ledger_currency || DEFAULT_LEDGER_CURRENCY).toUpperCase();
  const holidayCountry = String(settings.holiday_country || "PL").toUpperCase();
  const storedFxCurrencies = parseArraySetting(settings.fx_used_currencies);
  const selectedFxCurrencies = storedFxCurrencies.length
    ? storedFxCurrencies.filter(currency => currency !== ledgerCurrency)
    : observedForeignCurrencies(cashflow, ledgerCurrency);
  const manualFxRates = parseObjectSetting(settings.manual_fx_rates);
  const canMaintain = hasCapability(cashflow, "budget:maintain");

  const priorityLabels = {
    min: "Min",
    low: "Low",
    default: "Default",
    high: "High",
    urgent: "Urgent"
  };
  const priorityOptions = (selected) => Object.entries(priorityLabels).map(([value, labelKey]) =>
    `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(t(locale, labelKey))}</option>`
  ).join("");

  const checkbox = (name, label, checked) => `
    <label class="cashflow-checkbox">
      <input type="checkbox" name="${escapeHtml(name)}" value="1" ${Number(checked) === 1 ? "checked" : ""}>
      <span>${escapeHtml(label)}</span>
    </label>
  `;

  const notificationRow = (type, label) => {
    const notifyKey = `notify_${type}`;
    const priorityKey = `ntfy_priority_${type}`;

    return `
      <div class="cashflow-notification-row">
        ${checkbox(notifyKey, label, settings[notifyKey])}
        <label>
          <span>${escapeHtml(t(locale, "ntfy priority"))}</span>
          <select name="${escapeHtml(priorityKey)}">
            ${priorityOptions(settings[priorityKey] || "default")}
          </select>
        </label>
      </div>
    `;
  };

  const general = `
    <label>
      ${fieldLabel(locale, "Language", "Language controls labels and formatting in the app.")}
      <select name="locale">
        ${availableLocales.map(option => `
          <option value="${escapeHtml(option.id)}"${option.id === selectedLocale ? " selected" : ""}>
            ${escapeHtml(option.label || option.id)}
          </option>
        `).join("")}
      </select>
    </label>
  `;

  const currencyExchange = `
    <label>
      ${fieldLabel(locale, "Ledger currency", "Ledger currency is used for balances, summaries, and projections. Changing it creates a pending conversion row.")}
      <select name="ledger_currency" data-ledger-currency>
        ${SUPPORTED_FX_CURRENCIES.map(currency => `
          <option value="${escapeHtml(currency)}"${currency === ledgerCurrency ? " selected" : ""}>
            ${escapeHtml(currency)}
          </option>
        `).join("")}
      </select>
    </label>

    <label>
      ${fieldLabel(locale, "Timezone", "Timezone controls the app's idea of today and background schedule dates.")}
      <input name="timezone" value="${escapeHtml(settings.timezone || DEFAULT_TIMEZONE)}" list="cashflow-timezones">
      <datalist id="cashflow-timezones">
        ${TIMEZONE_OPTIONS.map(timezone => `
          <option value="${escapeHtml(timezone)}"></option>
        `).join("")}
      </datalist>
    </label>

    <label>
      ${fieldLabel(locale, "Default holiday country", "Holiday country is the default calendar used when recurring dates move around weekends or holidays.")}
      <select name="holiday_country">
        ${HOLIDAY_COUNTRIES.map(country => `
          <option value="${escapeHtml(country.code)}"${country.code === holidayCountry ? " selected" : ""}>
            ${escapeHtml(country.code)} - ${escapeHtml(t(locale, country.labelKey))}
          </option>
        `).join("")}
      </select>
    </label>

    <label>
      ${fieldLabel(locale, "FX buffer (%)", "FX buffer adds a percentage cushion to foreign-currency expenses only.")}
      <input type="number" name="fx_buffer_percent" value="${escapeHtml(String(settings.fx_buffer_percent ?? 0))}" min="0" max="100" step="0.5">
    </label>

    <label>
      ${fieldLabel(locale, "FX provider", "FX provider controls where exchange rates come from.")}
      <select name="fx_provider" data-fx-provider>
        ${FX_PROVIDER_OPTIONS.map(provider => `
          <option value="${escapeHtml(provider.id)}"${provider.id === fxProvider ? " selected" : ""}>
            ${escapeHtml(t(locale, provider.labelKey))}
          </option>
        `).join("")}
      </select>
      <small data-fx-provider-note>
        ${escapeHtml(t(locale, (FX_PROVIDER_OPTIONS.find(provider => provider.id === fxProvider) || FX_PROVIDER_OPTIONS[2]).noteKey))}
      </small>
    </label>

    ${renderFxCurrencySelector(locale, selectedFxCurrencies, ledgerCurrency)}
    ${renderManualFxRates(locale, selectedFxCurrencies, manualFxRates, ledgerCurrency)}

    ${canMaintain ? `<div class="cashflow-tab-actions">
      <button type="button" class="btn-small" data-cashflow-refresh-fx>
        ${escapeHtml(t(locale, "Refresh FX rates"))}
      </button>
    </div>` : ""}
  `;

  const budgetPeriod = `
    <label>
      ${fieldLabel(locale, "Budget period income", "Budget period income chooses the recurring income that starts each budget period. Calendar month uses normal months.")}
      <select name="budget_period_income_id">
        <option value="">${escapeHtml(t(locale, "Calendar month"))}</option>
        ${recurringIncomes.map(r => `
          <option value="${escapeHtml(r.id)}" ${r.id === settings.budget_period_income_id ? "selected" : ""}>
            ${escapeHtml(r.name)}${r.active ? "" : ` (${escapeHtml(t(locale, "Inactive"))})`}
          </option>
        `).join("")}
      </select>
    </label>

    <label>
      ${fieldLabel(locale, "Periods to generate", "Periods to generate controls how many future budget periods Cashflow plans.")}
      <input type="number" name="future_periods" value="${escapeHtml(String(settings.future_periods ?? 11))}" min="1" max="60" step="1">
    </label>

    ${checkbox("minimum_reserve_enabled", t(locale, "Protect minimum reserve"), settings.minimum_reserve_enabled)}

    <label>
      ${fieldLabel(locale, "Minimum reserve", "Minimum reserve is money Cashflow keeps unavailable for projected spending.")}
      <input type="text" inputmode="decimal" pattern="[0-9]+([.,][0-9]+)?" name="minimum_reserve_amount" value="${escapeHtml(String(settings.minimum_reserve_amount ?? 0))}">
    </label>

    <label>
      ${fieldLabel(locale, "Ledger history compaction", "Ledger history compaction replaces old detailed confirmed rows with one balance row after a safety backup.")}
      <input type="number" name="ledger_history_compaction_months" value="${escapeHtml(String(settings.ledger_history_compaction_months ?? 0))}" min="0" max="600" step="1">
      <small>${escapeHtml(t(locale, "Use 0 to keep detailed ledger history forever."))}</small>
    </label>

    ${canMaintain ? `<div class="cashflow-tab-actions">
      <button type="button" class="btn-small" data-cashflow-compact-ledger-history>
        ${escapeHtml(t(locale, "Compact ledger history now"))}
      </button>
    </div>` : ""}
  `;

  const notifications = `
    <p class="cashflow-field-help">${escapeHtml(t(locale, "Cashflow checks the ledger and sends queued notifications at the same profile-local time."))}</p>

    <label>
      ${fieldLabel(locale, "Notification service", "Notification service chooses where Cashflow sends queued alerts.")}
      <select name="notification_channel">
        <option value="ntfy" ${(settings.notification_channel || "ntfy") === "ntfy" ? "selected" : ""}>ntfy</option>
        <option value="discord" ${settings.notification_channel === "discord" ? "selected" : ""}>Discord</option>
      </select>
    </label>

    <label>
      ${fieldLabel(locale, "Full ntfy URL", "Full ntfy URL is the complete ntfy topic address.")}
      <input type="url" name="ntfy_url" value="${escapeHtml(settings.ntfy_url || "")}" placeholder="https://ntfy.example.com/topic">
    </label>

    <label>
      ${fieldLabel(locale, "ntfy access token", "ntfy access token authenticates protected ntfy topics. Treat it as a secret; leave it blank for public topics.")}
      <input type="text" name="ntfy_auth_token" value="${escapeHtml(settings.ntfy_auth_token || "")}" autocomplete="off" placeholder="tk_...">
    </label>

    <label>
      ${fieldLabel(locale, "Discord webhook URL", "Discord webhook URL is the Discord endpoint for queued alerts. Treat it as a secret.")}
      <input type="url" name="discord_webhook_url" value="${escapeHtml(settings.discord_webhook_url || "")}" placeholder="https://discord.com/api/webhooks/...">
    </label>

    <label>
      ${fieldLabel(locale, "Ledger check and notification time", "Ledger check and notification time is when due rows move to pending and queued alerts are sent.")}
      <input type="time" name="notification_delivery_time" value="${escapeHtml(settings.notification_delivery_time || "08:00")}">
    </label>

    <label>
      ${fieldLabel(locale, "Repeat necessary-underfunded every X days", "Repeat necessary-underfunded every X days limits repeat alerts for the same shortfall.")}
      <input type="number" name="necessary_underfunded_repeat_days" value="${escapeHtml(String(settings.necessary_underfunded_repeat_days ?? 1))}" min="1" step="1">
    </label>

    ${notificationRow("goal_impossible", t(locale, "Goal impossible"))}
    ${notificationRow("necessary_underfunded", t(locale, "Necessary transaction underfunded"))}
    ${notificationRow("funding_shortfall", t(locale, "Funding shortfall"))}
    ${notificationRow("income_missing", t(locale, "Missing income"))}
    ${notificationRow("pending_summary", t(locale, "Pending summary"))}
    ${notificationRow("goal_funded", t(locale, "Goal funded"))}
    ${notificationRow("fx_changed", t(locale, "FX changed projection"))}
  `;

  const dataPortability = `
    <div class="cashflow-settings-actions">
      <button type="button" class="btn-small" data-cashflow-download-full-export>
        ${escapeHtml(t(locale, "Download full export"))}
      </button>
      <button type="button" class="btn-small" data-cashflow-download-ledger-csv>
        ${escapeHtml(t(locale, "Download confirmed ledger CSV"))}
      </button>
      <button type="button" class="btn-small" data-cashflow-download-sample>
        ${escapeHtml(t(locale, "Download sample dataset"))}
      </button>
    </div>

    <label class="cashflow-checkbox">
      <input type="checkbox" data-cashflow-export-operational-settings>
      <span>${escapeHtml(t(locale, "Include operational settings in full export"))}</span>
    </label>

    <label>
      ${fieldLabel(locale, "Full import file", "Full import reads a Cashflow JSON export from your computer.")}
      <input type="file" accept="application/json,.json" data-cashflow-full-import-file>
    </label>

    <label>
      ${fieldLabel(locale, "Full import mode", "Full import mode controls whether imported JSON replaces this budget or merges compatible rows.")}
      <select data-cashflow-full-import-mode>
        <option value="replace">${escapeHtml(t(locale, "Replace after backup"))}</option>
        <option value="merge">${escapeHtml(t(locale, "Merge"))}</option>
      </select>
    </label>

    <label class="cashflow-checkbox">
      <input type="checkbox" data-cashflow-import-operational-settings>
      <span>${escapeHtml(t(locale, "Include operational settings during full import"))}</span>
    </label>

    <div class="cashflow-tab-actions">
      <button type="button" class="btn-small" data-cashflow-import-full>
        ${escapeHtml(t(locale, "Import full export"))}
      </button>
    </div>

    <label>
      ${fieldLabel(locale, "One-off CSV file", "One-off CSV import accepts exact columns only: name,type,amount,currency,date.")}
      <input type="file" accept="text/csv,.csv" data-cashflow-oneoff-csv-file>
      <small>${escapeHtml(t(locale, "CSV columns: name,type,amount,currency,date"))}</small>
    </label>

    <div class="cashflow-tab-actions">
      <button type="button" class="btn-small" data-cashflow-import-oneoff-csv>
        ${escapeHtml(t(locale, "Import one-off CSV"))}
      </button>
      <button type="button" class="btn-small" data-cashflow-load-sample>
        ${escapeHtml(t(locale, "Load sample dataset"))}
      </button>
    </div>
  `;

  return `
    <div class="cashflow-tab-content" data-cashflow-settings-tab>
      <form class="panel cashflow-settings-form" data-cashflow-settings-form>
        <div class="cashflow-panel-heading cashflow-settings-heading">
          <h3>${escapeHtml(t(locale, "Settings"))}</h3>
          <button type="submit" class="btn-primary">${escapeHtml(t(locale, "Save"))}</button>
        </div>

        ${renderDetailsSection(locale, "General", general)}
        ${renderDetailsSection(locale, "Currency & Exchange", currencyExchange)}
        ${renderDetailsSection(locale, "Budget period", budgetPeriod)}
        ${renderDetailsSection(locale, "Notifications", notifications)}
        ${renderDetailsSection(locale, "Data portability", dataPortability)}
      </form>
    </div>
  `;
}
