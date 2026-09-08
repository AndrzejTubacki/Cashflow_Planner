import { escapeHtml } from "../utils.js";
import {
  DEFAULT_LEDGER_CURRENCY,
  DEFAULT_TIMEZONE,
  HOLIDAY_COUNTRIES,
  SUPPORTED_FX_CURRENCIES,
  TIMEZONE_OPTIONS
} from "./constants.js";
import { formatMessage, t } from "./shared.js";

function renderMessage(error = "", message = "") {
  if (error) return `<div class="detail-note cashflow-warning">${escapeHtml(error)}</div>`;
  if (message) return `<div class="detail-note">${escapeHtml(message)}</div>`;
  return "";
}

function currencyOptions(selected = DEFAULT_LEDGER_CURRENCY) {
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

function renderAccountButton(account) {
  const id = account.id || account.userId || "";
  const isAccount = Object.prototype.hasOwnProperty.call(account, "status")
    || Object.prototype.hasOwnProperty.call(account, "email")
    || Object.prototype.hasOwnProperty.call(account, "globalRoles");
  const selectorAttribute = isAccount
    ? `data-cashflow-select-account="${escapeHtml(id)}"`
    : `data-cashflow-select-user="${escapeHtml(id)}"`;
  return `
    <button type="button" class="cashflow-user-card" ${selectorAttribute}>
      <strong>${escapeHtml(account.display_name || account.displayName || id)}</strong>
      <span>${escapeHtml(id)}</span>
    </button>
  `;
}

function renderInternalLoginPage(locale, providers = []) {
  const enabledProviders = Array.isArray(providers) ? providers : [];
  return `
    <section class="cashflow-shell-grid">
      <form class="cashflow-shell-panel cashflow-shell-form" data-cashflow-internal-login-form>
        <h3>${escapeHtml(t(locale, "Login"))}</h3>
        <label>
          <span>${escapeHtml(t(locale, "Email"))}</span>
          <input name="email" type="email" required autocomplete="username">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Password"))}</span>
          <input name="password" type="password" required minlength="12" maxlength="1024" autocomplete="current-password">
        </label>
        <button type="submit" class="cashflow-action cashflow-action--primary">
          ${escapeHtml(t(locale, "Login"))}
        </button>
      </form>

      ${enabledProviders.length ? `
        <div class="cashflow-shell-panel cashflow-shell-form" data-cashflow-provider-login-list>
          <h3>${escapeHtml(t(locale, "Provider login"))}</h3>
          ${enabledProviders.map(provider => `
            <button
              type="button"
              class="cashflow-action cashflow-action--secondary"
              data-cashflow-provider-login="${escapeHtml(provider.id || "")}"
            >
              ${escapeHtml(formatMessage(locale, "Continue with {provider}", { provider: provider.displayName || provider.id || "" }))}
            </button>
          `).join("")}
        </div>
      ` : ""}

      <form class="cashflow-shell-panel cashflow-shell-form" data-cashflow-password-token-form>
        <h3>${escapeHtml(t(locale, "Set password"))}</h3>
        <label>
          <span>${escapeHtml(t(locale, "Password token"))}</span>
          <input name="token" required autocomplete="off">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "New password"))}</span>
          <input name="password" type="password" required minlength="12" maxlength="1024" autocomplete="new-password">
        </label>
        <button type="submit" class="cashflow-action cashflow-action--secondary">
          ${escapeHtml(t(locale, "Set password"))}
        </button>
      </form>

      <form class="cashflow-shell-panel cashflow-shell-form" data-cashflow-internal-register-form>
        <h3>${escapeHtml(t(locale, "Register with invitation"))}</h3>
        <label>
          <span>${escapeHtml(t(locale, "Invitation token"))}</span>
          <input name="invitationToken" required autocomplete="off">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Email"))}</span>
          <input name="email" type="email" required autocomplete="username">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Display name"))}</span>
          <input name="displayName" required maxlength="120" autocomplete="name">
        </label>
        <label>
          <span>${escapeHtml(t(locale, "Password"))}</span>
          <input name="password" type="password" required minlength="12" maxlength="1024" autocomplete="new-password">
        </label>
        <button type="submit" class="cashflow-action cashflow-action--secondary">
          ${escapeHtml(t(locale, "Register"))}
        </button>
      </form>
    </section>
  `;
}

function renderExternalLoginPage(locale) {
  return `
    <section class="cashflow-shell-grid">
      <div class="cashflow-shell-panel cashflow-shell-form">
        <h3>${escapeHtml(t(locale, "External SSO"))}</h3>
        <button type="button" class="cashflow-action cashflow-action--primary" data-cashflow-external-login>
          ${escapeHtml(t(locale, "Continue with SSO"))}
        </button>
      </div>
    </section>
  `;
}

export function renderUserSelectionPage({ users = [], accounts = users, auth = null, error = "", message = "" } = {}) {
  const locale = null;
  const accountRows = Array.isArray(accounts) ? accounts : [];
  const internalMode = auth?.activeMode === "internal";
  const externalMode = auth?.activeMode === "external";

  return `
    <div class="cashflow-page cashflow-shell" data-cashflow-user-selection>
      <div class="cashflow-header">
        <div class="cashflow-header__main">
          <div>
            <div class="cashflow-title-line">
              <h2>${escapeHtml(t(locale, "Select account"))}</h2>
            </div>
            <p class="cashflow-eyebrow">${escapeHtml(t(locale, "Cashflow"))}</p>
          </div>
        </div>
      </div>

      ${renderMessage(error, message)}

      ${externalMode ? renderExternalLoginPage(locale) : internalMode ? renderInternalLoginPage(locale, auth?.internal?.providers || []) : `
        <section class="cashflow-shell-grid">
        <div class="cashflow-shell-panel">
          <h3>${escapeHtml(t(locale, "Accounts"))}</h3>
          <div class="cashflow-user-list">
            ${accountRows.length ? accountRows.map(renderAccountButton).join("") : `
              <div class="empty-state">
                <p>${escapeHtml(t(locale, "No accounts yet"))}</p>
              </div>
            `}
          </div>
        </div>

        <form class="cashflow-shell-panel cashflow-shell-form" data-cashflow-create-account-form data-cashflow-create-user-form>
          <h3>${escapeHtml(t(locale, "Create account"))}</h3>
          <label>
            <span>${escapeHtml(t(locale, "Account ID"))}</span>
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
      `}
    </div>
  `;
}

export function renderBudgetSelectionPage({ account = null, budgets = [], error = "", message = "" } = {}) {
  const locale = null;
  const accountName = account?.accountDisplayName || account?.displayName || account?.accountId || "";

  return `
    <div class="cashflow-page cashflow-shell" data-cashflow-budget-selection>
      <div class="cashflow-header">
        <div class="cashflow-header__main">
          <div>
            <div class="cashflow-title-line">
              <h2>${escapeHtml(t(locale, "Select budget"))}</h2>
            </div>
            <p class="cashflow-eyebrow">${escapeHtml(accountName || t(locale, "Cashflow"))}</p>
          </div>
        </div>
        <div class="cashflow-header__actions">
          <button type="button" class="cashflow-action cashflow-action--secondary" data-cashflow-logout>
            ${escapeHtml(t(locale, "Logout"))}
          </button>
        </div>
      </div>

      ${renderMessage(error, message)}

      <section class="cashflow-shell-grid">
        <div class="cashflow-shell-panel">
          <h3>${escapeHtml(t(locale, "Budgets"))}</h3>
          <div class="cashflow-user-list">
            ${budgets.length ? budgets.map(budget => `
              <button type="button" class="cashflow-user-card" data-cashflow-select-budget="${escapeHtml(budget.id)}" ${budget.status !== "active" ? "disabled" : ""}>
                <strong>${escapeHtml(budget.display_name || budget.id)}</strong>
                <span>${escapeHtml(budget.id)} · ${escapeHtml(t(locale, budget.role || "viewer"))} · ${escapeHtml(t(locale, budget.status || "active"))}</span>
              </button>
            `).join("") : `
              <div class="empty-state">
                <p>${escapeHtml(t(locale, "No budgets yet"))}</p>
              </div>
            `}
          </div>
        </div>

        <div class="cashflow-shell-panel cashflow-shell-form">
          <form data-cashflow-create-budget-form>
            <h3>${escapeHtml(t(locale, "Create budget"))}</h3>
            <label>
              <span>${escapeHtml(t(locale, "Budget name"))}</span>
              <input name="displayName" required maxlength="120">
            </label>
            <button type="submit" class="cashflow-action cashflow-action--primary">
              ${escapeHtml(t(locale, "Create and continue"))}
            </button>
          </form>

          <form data-cashflow-accept-invitation-form>
            <h3>${escapeHtml(t(locale, "Accept invitation"))}</h3>
            <label>
              <span>${escapeHtml(t(locale, "Invitation token"))}</span>
              <input name="token" required autocomplete="off">
            </label>
            <button type="submit" class="cashflow-action cashflow-action--secondary">
              ${escapeHtml(t(locale, "Accept invitation"))}
            </button>
          </form>
        </div>
      </section>
    </div>
  `;
}

export function renderSetupPage({ cashflow = null, error = "", message = "" } = {}) {
  const settings = cashflow?.settings || {};
  const locale = settings.locale || "en";
  const availableLocales = Array.isArray(cashflow?.availableLocales) ? cashflow.availableLocales : [];
  const ledgerCurrency = String(settings.ledger_currency || DEFAULT_LEDGER_CURRENCY).toUpperCase();
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
            <input name="timezone" value="${escapeHtml(settings.timezone || DEFAULT_TIMEZONE)}" list="cashflow-setup-timezones">
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
            <input type="text" inputmode="decimal" pattern="[0-9]+([.,][0-9]+)?" name="opening_balance" value="0">
          </label>
          <label>
            <span>${escapeHtml(t(locale, "Monthly income"))}</span>
            <input type="text" inputmode="decimal" pattern="[0-9]+([.,][0-9]+)?" name="income_amount" value="0">
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
