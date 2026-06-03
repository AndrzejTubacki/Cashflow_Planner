import { escapeHtml } from "../utils.js";
import { t } from "./shared.js";

export const SUPPORTED_FX_CURRENCIES = [
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP",
  "HKD", "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR",
  "NOK", "NZD", "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR"
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

const HOLIDAY_COUNTRIES = [
  { code: "PL", labelKey: "Poland" },
  { code: "DE", labelKey: "Germany" }
];

function renderMessage(error = "", message = "") {
  if (error) return `<div class="detail-note cashflow-warning">${escapeHtml(error)}</div>`;
  if (message) return `<div class="detail-note">${escapeHtml(message)}</div>`;
  return "";
}

function currencyOptions(selected = "PLN") {
  return SUPPORTED_FX_CURRENCIES.map(currency => `
    <option value="${escapeHtml(currency)}"${currency === selected ? " selected" : ""}>
      ${escapeHtml(currency)}
    </option>
  `).join("");
}

function localeOptions(locales = [], selected = "en") {
  const options = locales.length ? locales : [{ id: "en", label: "English" }];
  return options.map(locale => `
    <option value="${escapeHtml(locale.id)}"${locale.id === selected ? " selected" : ""}>
      ${escapeHtml(locale.label || locale.id)}
    </option>
  `).join("");
}

export function renderUserSelectionPage({ users = [], error = "", message = "" } = {}) {
  const locale = null;

  return `
    <div class="cashflow-page cashflow-shell" data-cashflow-user-selection>
      <div class="cashflow-header">
        <div class="cashflow-header__main">
          <div>
            <div class="cashflow-title-line">
              <h2>${escapeHtml(t(locale, "Select user"))}</h2>
            </div>
            <p class="cashflow-eyebrow">${escapeHtml(t(locale, "Cashflow"))}</p>
          </div>
        </div>
      </div>

      ${renderMessage(error, message)}

      <section class="cashflow-shell-grid">
        <div class="cashflow-shell-panel">
          <h3>${escapeHtml(t(locale, "Users"))}</h3>
          <div class="cashflow-user-list">
            ${users.length ? users.map(user => `
              <button type="button" class="cashflow-user-card" data-cashflow-select-user="${escapeHtml(user.id)}">
                <strong>${escapeHtml(user.display_name || user.id)}</strong>
                <span>${escapeHtml(user.id)}</span>
              </button>
            `).join("") : `
              <div class="empty-state">
                <p>${escapeHtml(t(locale, "No users yet"))}</p>
              </div>
            `}
          </div>
        </div>

        <form class="cashflow-shell-panel cashflow-shell-form" data-cashflow-create-user-form>
          <h3>${escapeHtml(t(locale, "Create user"))}</h3>
          <label>
            <span>${escapeHtml(t(locale, "User ID"))}</span>
            <input name="userId" required maxlength="64" pattern="[A-Za-z0-9_-]{1,64}" autocomplete="username">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Display name"))}</span>
            <input name="displayName" maxlength="120">
          </label>
          <button type="submit" class="cashflow-action cashflow-action--primary">
            ${escapeHtml(t(locale, "Create and continue"))}
          </button>
        </form>
      </section>
    </div>
  `;
}

export function renderSetupPage({ cashflow = null, error = "", message = "" } = {}) {
  const settings = cashflow?.settings || {};
  const locale = settings.locale || "en";
  const availableLocales = Array.isArray(cashflow?.availableLocales) ? cashflow.availableLocales : [];
  const ledgerCurrency = String(settings.ledger_currency || "PLN").toUpperCase();
  const holidayCountry = String(settings.holiday_country || "PL").toUpperCase();

  return `
    <div class="cashflow-page cashflow-shell" data-cashflow-setup>
      <div class="cashflow-header">
        <div class="cashflow-header__main">
          <div>
            <div class="cashflow-title-line">
              <h2>${escapeHtml(t(locale, "First-run setup"))}</h2>
            </div>
            <p class="cashflow-eyebrow">${escapeHtml(cashflow?.session?.displayName || cashflow?.session?.userId || t(locale, "Cashflow"))}</p>
          </div>
        </div>
        <div class="cashflow-header__actions">
          <button type="button" class="cashflow-action cashflow-action--secondary" data-cashflow-logout>
            ${escapeHtml(t(locale, "Logout"))}
          </button>
        </div>
      </div>

      ${renderMessage(error, message)}

      <form class="cashflow-shell-panel cashflow-setup-form" data-cashflow-setup-form>
        <div class="cashflow-form-grid">
          <label>
            <span>${escapeHtml(t(locale, "Ledger currency"))}</span>
            <select name="ledger_currency">
              ${currencyOptions(ledgerCurrency)}
            </select>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Language"))}</span>
            <select name="locale">
              ${localeOptions(availableLocales, locale)}
            </select>
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Timezone"))}</span>
            <input name="timezone" value="${escapeHtml(settings.timezone || "Europe/Warsaw")}" list="cashflow-setup-timezones">
            <datalist id="cashflow-setup-timezones">
              ${TIMEZONE_OPTIONS.map(timezone => `<option value="${escapeHtml(timezone)}"></option>`).join("")}
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
            <span>${escapeHtml(t(locale, "Projection horizon"))}</span>
            <input type="number" name="future_periods" value="${escapeHtml(String(settings.future_periods || 11))}" min="1" max="60">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Opening balance"))}</span>
            <input type="number" name="opening_balance" value="0" step="0.01">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Monthly income"))}</span>
            <input type="number" name="income_amount" value="0" min="0" step="0.01">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Income name"))}</span>
            <input name="income_name" value="${escapeHtml(t(locale, "Income"))}">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Income day"))}</span>
            <input type="number" name="income_anchor_day" value="1" min="1" max="31">
          </label>
        </div>
        <label class="cashflow-checkbox">
          <input type="checkbox" name="income_enabled" value="1" checked>
          <span>${escapeHtml(t(locale, "Create recurring income"))}</span>
        </label>
        <div class="settings-actions">
          <button type="submit" class="btn-primary">
            ${escapeHtml(t(locale, "Complete setup"))}
          </button>
        </div>
      </form>
    </div>
  `;
}
