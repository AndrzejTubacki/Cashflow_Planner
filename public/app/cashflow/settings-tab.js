import { escapeHtml } from "../utils.js";
import {
  DEFAULT_LEDGER_CURRENCY,
  DEFAULT_TIMEZONE,
  FX_PROVIDER_OPTIONS,
  HOLIDAY_COUNTRIES,
  SUPPORTED_FX_CURRENCIES,
  TIMEZONE_OPTIONS
} from "./constants.js";
import { hasCapability, t } from "./shared.js";

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
      <span>${escapeHtml(t(locale, "Language"))}</span>
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
      <span>${escapeHtml(t(locale, "Ledger currency"))}</span>
      <select name="ledger_currency" data-ledger-currency>
        ${SUPPORTED_FX_CURRENCIES.map(currency => `
          <option value="${escapeHtml(currency)}"${currency === ledgerCurrency ? " selected" : ""}>
            ${escapeHtml(currency)}
          </option>
        `).join("")}
      </select>
    </label>

    <label>
      <span>${escapeHtml(t(locale, "Timezone"))}</span>
      <input name="timezone" value="${escapeHtml(settings.timezone || DEFAULT_TIMEZONE)}" list="cashflow-timezones">
      <datalist id="cashflow-timezones">
        ${TIMEZONE_OPTIONS.map(timezone => `
          <option value="${escapeHtml(timezone)}"></option>
        `).join("")}
      </datalist>
    </label>

    <label>
      <span>${escapeHtml(t(locale, "Default holiday country"))}</span>
      <select name="holiday_country">
        ${HOLIDAY_COUNTRIES.map(country => `
          <option value="${escapeHtml(country.code)}"${country.code === holidayCountry ? " selected" : ""}>
            ${escapeHtml(country.code)} - ${escapeHtml(t(locale, country.labelKey))}
          </option>
        `).join("")}
      </select>
    </label>

    <label>
      <span>${escapeHtml(t(locale, "FX buffer (%)"))}</span>
      <input type="number" name="fx_buffer_percent" value="${escapeHtml(String(settings.fx_buffer_percent ?? 0))}" min="0" max="100" step="0.5">
    </label>

    <label>
      <span>${escapeHtml(t(locale, "FX provider"))}</span>
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
      <span>${escapeHtml(t(locale, "Budget period income"))}</span>
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
      <span>${escapeHtml(t(locale, "Periods to generate"))}</span>
      <input type="number" name="future_periods" value="${escapeHtml(String(settings.future_periods ?? 11))}" min="1" max="60" step="1">
    </label>

    ${checkbox("minimum_reserve_enabled", t(locale, "Protect minimum reserve"), settings.minimum_reserve_enabled)}

    <label>
      <span>${escapeHtml(t(locale, "Minimum reserve"))}</span>
      <input type="text" inputmode="decimal" pattern="[0-9]+([.,][0-9]+)?" name="minimum_reserve_amount" value="${escapeHtml(String(settings.minimum_reserve_amount ?? 0))}">
    </label>
  `;

  const notifications = `
    <label>
      <span>${escapeHtml(t(locale, "Full ntfy URL"))}</span>
      <input type="url" name="ntfy_url" value="${escapeHtml(settings.ntfy_url || "")}" placeholder="https://ntfy.example.com/topic">
    </label>

    <label>
      <span>${escapeHtml(t(locale, "Delivery time"))}</span>
      <input type="time" name="notification_delivery_time" value="${escapeHtml(settings.notification_delivery_time || "08:00")}">
    </label>

    <label>
      <span>${escapeHtml(t(locale, "Repeat necessary-underfunded every X days"))}</span>
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
      <span>${escapeHtml(t(locale, "Full import file"))}</span>
      <input type="file" accept="application/json,.json" data-cashflow-full-import-file>
    </label>

    <label>
      <span>${escapeHtml(t(locale, "Full import mode"))}</span>
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
      <span>${escapeHtml(t(locale, "One-off CSV file"))}</span>
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
        ${renderDetailsSection(locale, "ntfy notifications", notifications)}
        ${renderDetailsSection(locale, "Data portability", dataPortability)}
      </form>
    </div>
  `;
}
