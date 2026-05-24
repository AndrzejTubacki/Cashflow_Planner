import { escapeHtml } from "../utils.js";
import { t } from "./shared.js";

const FX_PROVIDER_OPTIONS = [
  { id: "disabled", label: "Disabled", note: "Only PLN transactions can project without supplied rates." },
  { id: "manual", label: "Manual rates", note: "Use the rates entered below." },
  { id: "nbp", label: "NBP", note: "Polish central bank rates." },
  { id: "frankfurter", label: "Frankfurter", note: "ECB-backed rates for major currencies." }
];

const SUPPORTED_FX_CURRENCIES = [
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP",
  "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR",
  "NOK", "NZD", "PHP", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR"
];

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

function observedForeignCurrencies(cashflow) {
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
    .filter(currency => currency && currency !== "PLN" && SUPPORTED_FX_CURRENCIES.includes(currency))
  )].sort();
}

function renderFxCurrencySelector(selectedCurrencies) {
  const selected = new Set(selectedCurrencies);
  const availableCurrencies = SUPPORTED_FX_CURRENCIES.filter(currency => !selected.has(currency));

  const options = (currencies) => currencies.map(currency => `
    <option value="${escapeHtml(currency)}">${escapeHtml(currency)}</option>
  `).join("");

  return `
    <div class="cashflow-m2m" data-fx-currency-selector>
      <div class="cashflow-m2m__column">
        <span>Available currencies</span>
        <select multiple size="10" data-fx-currency-available>
          ${options(availableCurrencies)}
        </select>
      </div>

      <div class="cashflow-m2m__controls">
        <button type="button" class="btn-small" data-fx-currency-add>&gt;</button>
        <button type="button" class="btn-small" data-fx-currency-remove>&lt;</button>
      </div>

      <div class="cashflow-m2m__column">
        <span>Used currencies</span>
        <select multiple size="10" name="fx_used_currencies" data-fx-currency-selected>
          ${options(selectedCurrencies)}
        </select>
      </div>
    </div>
  `;
}

function renderManualFxRates(selectedCurrencies, manualRates) {
  return `
    <div class="cashflow-manual-rates" data-manual-fx-rates>
      ${selectedCurrencies.length ? selectedCurrencies.map(currency => `
        <label data-manual-fx-rate-row="${escapeHtml(currency)}">
          <span>${escapeHtml(currency)} / PLN</span>
          <input
            type="number"
            min="0.000001"
            step="0.000001"
            value="${escapeHtml(String(manualRates[currency] ?? ""))}"
            data-manual-fx-rate="${escapeHtml(currency)}"
            placeholder="1.000000"
          >
        </label>
      `).join("") : `
        <small>Select at least one used currency to enter manual rates.</small>
      `}
    </div>
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
  const storedFxCurrencies = parseArraySetting(settings.fx_used_currencies);
  const selectedFxCurrencies = storedFxCurrencies.length
    ? storedFxCurrencies
    : observedForeignCurrencies(cashflow);
  const manualFxRates = parseObjectSetting(settings.manual_fx_rates);

  const priorities = ["min", "low", "default", "high", "urgent"];
  const priorityOptions = (selected) => priorities.map(p =>
    `<option value="${escapeHtml(p)}"${selected === p ? " selected" : ""}>${escapeHtml(p)}</option>`
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
          <span>${escapeHtml(t(locale, "Priorytet ntfy", "ntfy priority"))}</span>
          <select name="${escapeHtml(priorityKey)}">
            ${priorityOptions(settings[priorityKey] || "default")}
          </select>
        </label>
      </div>
    `;
  };

  return `
    <div class="cashflow-tab-content" data-cashflow-settings-tab>
      <form class="panel cashflow-settings-form" data-cashflow-settings-form>
        <div class="cashflow-panel-heading cashflow-settings-heading">
          <h3>${escapeHtml(t(locale, "Ustawienia", "Settings"))}</h3>
          <button type="submit" class="btn-primary">${escapeHtml(t(locale, "Zapisz", "Save"))}</button>
        </div>

        <details class="cashflow-details cashflow-details-panel cashflow-settings-section">
          <summary class="cashflow-details-panel__summary">
            <div class="cashflow-details-panel__title">
              <span class="cashflow-details-panel__chevron">&gt;</span>
              <strong>${escapeHtml(t(locale, "General", "General"))}</strong>
            </div>
          </summary>
          <div class="cashflow-details-panel__body">
          <fieldset>
          <legend>${escapeHtml(t(locale, "General", "General"))}</legend>

          <label>
            <span>${escapeHtml(t(locale, "Język", "Language"))}</span>
            <select name="locale">
              ${availableLocales.map(option => `
                <option value="${escapeHtml(option.id)}"${option.id === selectedLocale ? " selected" : ""}>
                  ${escapeHtml(option.label || option.id)}
                </option>
              `).join("")}
            </select>
          </label>
          </fieldset>
          </div>
        </details>

        <details class="cashflow-details cashflow-details-panel cashflow-settings-section">
          <summary class="cashflow-details-panel__summary">
            <div class="cashflow-details-panel__title">
              <span class="cashflow-details-panel__chevron">&gt;</span>
              <strong>${escapeHtml(t(locale, "Waluta i kurs", "Currency & Exchange"))}</strong>
            </div>
          </summary>
          <div class="cashflow-details-panel__body">
          <fieldset>
          <legend>${escapeHtml(t(locale, "Waluta i kurs", "Currency & Exchange"))}</legend>

          <label>
            <span>${escapeHtml(t(locale, "Waluta ledger", "Ledger currency"))}</span>
            <strong>PLN</strong>
            <small>${escapeHtml(t(locale, "Stała waluta ledger - backend nie pozwala jej zmienić.", "Fixed ledger currency - backend does not allow changing it."))}</small>
          </label>

          <label>
            <span>${escapeHtml(t(locale, "Bufor FX (%)", "FX buffer (%)"))}</span>
            <input type="number" name="fx_buffer_percent" value="${escapeHtml(String(settings.fx_buffer_percent ?? 0))}" min="0" max="100" step="0.5">
          </label>

          <label>
            <span>${escapeHtml(t(locale, "Dostawca FX", "FX provider"))}</span>
            <select name="fx_provider" data-fx-provider>
              ${FX_PROVIDER_OPTIONS.map(provider => `
                <option value="${escapeHtml(provider.id)}"${provider.id === fxProvider ? " selected" : ""}>
                  ${escapeHtml(provider.label)}
                </option>
              `).join("")}
            </select>
            <small data-fx-provider-note>
              ${escapeHtml((FX_PROVIDER_OPTIONS.find(provider => provider.id === fxProvider) || FX_PROVIDER_OPTIONS[2]).note)}
            </small>
          </label>

          ${renderFxCurrencySelector(selectedFxCurrencies)}
          ${renderManualFxRates(selectedFxCurrencies, manualFxRates)}

          <div class="cashflow-tab-actions">
            <button type="button" class="btn-small" data-cashflow-refresh-fx>
              ${escapeHtml(t(locale, "Odśwież kursy FX", "Refresh FX rates"))}
            </button>
          </div>
          </fieldset>
          </div>
        </details>

        <details class="cashflow-details cashflow-details-panel cashflow-settings-section">
          <summary>${escapeHtml(t(locale, "Okres budżetowy", "Budget period"))}</summary>
          <fieldset>
          <legend>${escapeHtml(t(locale, "Okres budżetowy", "Budget period"))}</legend>
          <label>
            <span>${escapeHtml(t(locale, "Przychód definiujący okres", "Budget period income"))}</span>
            <select name="budget_period_income_id">
              <option value="">${escapeHtml(t(locale, "Miesiąc kalendarzowy", "Calendar month"))}</option>
              ${recurringIncomes.map(r => `
                <option value="${escapeHtml(r.id)}" ${r.id === settings.budget_period_income_id ? "selected" : ""}>
                  ${escapeHtml(r.name)}${r.active ? "" : ` (${escapeHtml(t(locale, "nieaktywny", "inactive"))})`}
                </option>
              `).join("")}
            </select>
          </label>

          <label>
            <span>${escapeHtml(t(locale, "Liczba okresów do wygenerowania", "Periods to generate"))}</span>
            <input type="number" name="future_periods" value="${escapeHtml(String(settings.future_periods ?? 11))}" min="1" max="60" step="1">
          </label>
          </fieldset>
        </details>

        <details class="cashflow-details cashflow-details-panel cashflow-settings-section">
          <summary>${escapeHtml(t(locale, "Powiadomienia ntfy", "ntfy notifications"))}</summary>
          <fieldset>
          <legend>${escapeHtml(t(locale, "Powiadomienia ntfy", "ntfy notifications"))}</legend>

          <label>
            <span>${escapeHtml(t(locale, "Pełny URL ntfy", "Full ntfy URL"))}</span>
            <input type="url" name="ntfy_url" value="${escapeHtml(settings.ntfy_url || "")}" placeholder="https://ntfy.example.com/topic">
          </label>

          <label>
            <span>${escapeHtml(t(locale, "Godzina wysyłki", "Delivery time"))}</span>
            <input type="time" name="notification_delivery_time" value="${escapeHtml(settings.notification_delivery_time || "08:00")}">
          </label>

          <label>
            <span>${escapeHtml(t(locale, "Powtarzaj niedofinansowane niezbędne co X dni", "Repeat necessary-underfunded every X days"))}</span>
            <input type="number" name="necessary_underfunded_repeat_days" value="${escapeHtml(String(settings.necessary_underfunded_repeat_days ?? 1))}" min="1" step="1">
          </label>

          ${notificationRow("goal_impossible", t(locale, "Cel niemożliwy do sfinansowania", "Goal impossible"))}
          ${notificationRow("necessary_underfunded", t(locale, "Niezbędna transakcja niedofinansowana", "Necessary transaction underfunded"))}
          ${notificationRow("funding_shortfall", t(locale, "Brak środków", "Funding shortfall"))}
          ${notificationRow("income_missing", t(locale, "Brak oczekiwanego dochodu", "Missing income"))}
          ${notificationRow("pending_summary", t(locale, "Podsumowanie oczekujących", "Pending summary"))}
          ${notificationRow("goal_funded", t(locale, "Cel sfinansowany", "Goal funded"))}
          ${notificationRow("fx_changed", t(locale, "FX zmienił projekcję", "FX changed projection"))}
          </fieldset>
        </details>
      </form>
    </div>
  `;
}
