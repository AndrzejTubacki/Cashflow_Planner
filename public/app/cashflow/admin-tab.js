import { escapeHtml } from "../utils.js";
import { SUPPORTED_FX_CURRENCIES } from "./session-pages.js";
import { t } from "./shared.js";

const FX_PROVIDERS = [
  { id: "disabled", label: "Disabled" },
  { id: "manual", label: "Manual rates" },
  { id: "nbp", label: "NBP" },
  { id: "frankfurter", label: "Frankfurter" }
];

const TIMEZONE_OPTIONS = [
  "Europe/Warsaw",
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo"
];

function renderCurrencyOptions(selected) {
  return SUPPORTED_FX_CURRENCIES.map(currency => `
    <option value="${escapeHtml(currency)}"${currency === selected ? " selected" : ""}>
      ${escapeHtml(currency)}
    </option>
  `).join("");
}

export function renderAdminTab(locale, cashflow = null) {
  const options = cashflow?.admin?.options || {};
  const availableLocales = Array.isArray(cashflow?.availableLocales) && cashflow.availableLocales.length
    ? cashflow.availableLocales
    : [{ id: "en", label: "English" }];
  const selectedCurrency = String(options.ledger_currency || "PLN").toUpperCase();
  const selectedLocale = String(options.locale || "en");
  const selectedProvider = String(options.fx_provider || "nbp");

  return `
    <div class="cashflow-tab-content">
      <form class="cashflow-settings-grid" data-cashflow-admin-options-form>
        <fieldset>
          <legend>${escapeHtml(t(locale, "Global options"))}</legend>
          <label>
            <span>${escapeHtml(t(locale, "Default ledger currency"))}</span>
            <select name="ledger_currency">
              ${renderCurrencyOptions(selectedCurrency)}
            </select>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Default language"))}</span>
            <select name="locale">
              ${availableLocales.map(option => `
                <option value="${escapeHtml(option.id)}"${option.id === selectedLocale ? " selected" : ""}>
                  ${escapeHtml(option.label || option.id)}
                </option>
              `).join("")}
            </select>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Default timezone"))}</span>
            <input name="timezone" value="${escapeHtml(options.timezone || "Europe/Warsaw")}" list="cashflow-admin-timezones">
            <datalist id="cashflow-admin-timezones">
              ${TIMEZONE_OPTIONS.map(timezone => `<option value="${escapeHtml(timezone)}"></option>`).join("")}
            </datalist>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Default projection horizon"))}</span>
            <input type="number" name="future_periods" value="${escapeHtml(String(options.future_periods || 11))}" min="1" max="60">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Default FX provider"))}</span>
            <select name="fx_provider">
              ${FX_PROVIDERS.map(provider => `
                <option value="${escapeHtml(provider.id)}"${provider.id === selectedProvider ? " selected" : ""}>
                  ${escapeHtml(t(locale, provider.label))}
                </option>
              `).join("")}
            </select>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Default FX buffer (%)"))}</span>
            <input type="number" name="fx_buffer_percent" value="${escapeHtml(String(options.fx_buffer_percent ?? 0))}" min="0" max="100" step="0.5">
          </label>
        </fieldset>

        <div class="settings-actions">
          <button type="submit" class="btn-primary">
            ${escapeHtml(t(locale, "Save global options"))}
          </button>
        </div>
      </form>
    </div>
  `;
}
