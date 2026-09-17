import { escapeHtml } from "../utils.js";
import { DEFAULT_LEDGER_CURRENCY } from "./constants.js";
import { renderAdminTab } from "./admin-tab.js";
import { renderBudgetManagerTab } from "./budget-manager-tab.js";
import { attachCashflowHandlers } from "./handlers.js";
import { renderLedgerTab } from "./ledger-tab.js";
import { renderOneOffTab } from "./one-off-tab.js";
import { renderPriorityTab } from "./priority-tab.js";
import {
  renderRecurringExpensesTab,
  renderRecurringIncomeTab
} from "./recurring-tabs.js";
import { renderSettingsTab } from "./settings-tab.js";
import {
  renderFlexTab,
  renderGoalsTab
} from "./target-tabs.js";
import {
  DEFAULT_UI_PREFERENCES,
  UI_DEFAULT_TAB_OPTIONS,
  UI_DENSITY_OPTIONS,
  UI_THEME_OPTIONS,
  normalizeUiPreferences
} from "./ui-preferences.js";
import {
  formatMessage,
  hasCapability,
  hasPermission,
  localeOf,
  renderProjectionWarnings,
  t
} from "./shared.js";

export { attachCashflowHandlers };

function renderValidationResult(locale, validationResult = null) {
  if (!validationResult) return "";

  const warnings = Array.isArray(validationResult.warnings) ? validationResult.warnings : [];
  const hasWarnings = warnings.length > 0;
  const title = hasWarnings
    ? formatMessage(
      locale,
      warnings.length === 1 ? "Validation found {count} warning" : "Validation found {count} warnings",
      { count: warnings.length }
    )
    : t(locale, "Validation passed");

  return `
      <div class="cashflow-validation cashflow-validation--${hasWarnings ? "warning" : "ok"}">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(hasWarnings ? t(locale, "Review the warnings below before trusting the projection.") : t(locale, "No validation warnings were found."))}</span>
      ${hasWarnings ? `
        <ul>
          ${warnings.slice(0, 8).map(warning => `
            <li>${escapeHtml(t(locale, warning?.message || warning?.type || "Validation warning"))}</li>
          `).join("")}
          ${warnings.length > 8 ? `<li>${escapeHtml(formatMessage(locale, "{count} more warnings not shown", { count: warnings.length - 8 }))}</li>` : ""}
        </ul>
      ` : ""}
    </div>
  `;
}

function normalizeCurrencyList(value, ledgerCurrency = DEFAULT_LEDGER_CURRENCY) {
  const activeLedgerCurrency = String(ledgerCurrency || DEFAULT_LEDGER_CURRENCY).trim().toUpperCase();
  const raw = Array.isArray(value)
    ? value
    : (() => {
        try {
          return JSON.parse(value || "[]");
        } catch {
          return [];
        }
      })();

  return [...new Set(
    raw
      .map(currency => String(currency || "").trim().toUpperCase())
      .filter(currency => currency && currency !== activeLedgerCurrency)
  )].sort();
}

function parseFxRates(cashflow = null, fx = null) {
  if (fx && typeof fx === "object") {
    return fx;
  }

  const raw = cashflow?.latestProjectionSnapshot?.fx_rates_used;
  if (!raw) return {};

  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

function renderFxRateChip(currency, rates, ledgerCurrency = DEFAULT_LEDGER_CURRENCY) {
  const normalizedCurrency = String(currency || "").trim().toUpperCase();
  const normalizedLedgerCurrency = String(ledgerCurrency || DEFAULT_LEDGER_CURRENCY).trim().toUpperCase();
  const pairKey = `${normalizedCurrency}/${normalizedLedgerCurrency}`.toLowerCase();
  const legacyKey = normalizedCurrency.toLowerCase();
  const rate = Number(
    rates?.[pairKey]?.rate ||
    rates?.[`${normalizedCurrency}/${normalizedLedgerCurrency}`]?.rate ||
    rates?.[legacyKey]?.rate ||
    rates?.[normalizedCurrency]?.rate ||
    0
  );

  if (!rate) return "";

  return `
    <span class="cashflow-chip cashflow-chip--fx">
      ${escapeHtml(normalizedCurrency)}/${escapeHtml(normalizedLedgerCurrency)} <strong>${escapeHtml(rate.toFixed(4))}</strong>
    </span>
  `;
}

function renderFxTopBar(locale, cashflow = null, fx = null) {
  const rates = parseFxRates(cashflow, fx);
  const ledgerCurrency = String(cashflow?.settings?.ledger_currency || DEFAULT_LEDGER_CURRENCY).trim().toUpperCase();
  const configuredCurrencies = normalizeCurrencyList(cashflow?.settings?.fx_used_currencies, ledgerCurrency);
  const rateCurrencies = Object.keys(rates || {})
    .map(currency => {
      const normalized = String(currency || "").toUpperCase();
      if (normalized.includes("/")) {
        const [base, quote] = normalized.split("/");
        return quote === ledgerCurrency ? base : "";
      }
      return normalized === ledgerCurrency ? "" : normalized;
    })
    .filter(Boolean);
  const currencies = configuredCurrencies.length
    ? configuredCurrencies
    : [...new Set(rateCurrencies)].sort();

  const ledgerChip = `
    <span class="cashflow-chip">
      ${escapeHtml(t(locale, "Ledger"))}: <strong>${escapeHtml(ledgerCurrency)}</strong>
    </span>
  `;

  const fxChips = currencies
    .map(currency => renderFxRateChip(currency, rates, ledgerCurrency))
    .filter(Boolean);

  if (!fxChips.length) {
    return `<div class="cashflow-header__chips">${ledgerChip}</div>`;
  }

  if (fxChips.length <= 3) {
    return `<div class="cashflow-header__chips">${ledgerChip}${fxChips.join("")}</div>`;
  }

  const tickerItems = fxChips.join("");

  return `
    <div class="cashflow-header__chips cashflow-header__chips--ticker">
      ${ledgerChip}
      <div class="cashflow-fx-ticker" aria-label="${escapeHtml(t(locale, "FX rates"))}">
        <div class="cashflow-fx-ticker__track">
          ${tickerItems}
          ${tickerItems}
        </div>
      </div>
    </div>
  `;
}

export function renderCashflowVersionStatus(locale, versionCheck = null) {
  const status = versionCheck?.status || "checking";
  if (status === "checking") {
    return `<span class="cashflow-version-status cashflow-version-status--muted">${escapeHtml(t(locale, "Checking for updates"))}</span>`;
  }
  if (status === "current") {
    return `<span class="cashflow-version-status cashflow-version-status--current">${escapeHtml(t(locale, "Up to date"))}</span>`;
  }
  if (status === "available" && versionCheck?.latestVersion) {
    const href = versionCheck.htmlUrl || "https://github.com/AndrzejTubacki/Cashflow_Planner/releases";
    return `
      <a class="cashflow-version-status cashflow-version-status--available" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">
        ${escapeHtml(formatMessage(locale, "Update {version} available", { version: `v${versionCheck.latestVersion}` }))}
      </a>
    `;
  }
  return `<span class="cashflow-version-status cashflow-version-status--muted">${escapeHtml(t(locale, "Version check unavailable"))}</span>`;
}

function renderMenuLanguageSelect(locale, cashflow = null) {
  const locales = Array.isArray(cashflow?.availableLocales) ? cashflow.availableLocales : [];
  if (locales.length <= 1) return "";

  return `
    <label class="cashflow-menu-language">
      <span>${escapeHtml(t(locale, "Language"))}</span>
      <select data-cashflow-language-select aria-label="${escapeHtml(t(locale, "Language"))}">
        ${locales.map(option => `
          <option value="${escapeHtml(option.id)}"${option.id === locale ? " selected" : ""}>
            ${escapeHtml(option.label || option.id)}
          </option>
        `).join("")}
      </select>
    </label>
  `;
}

function renderPreferenceSelect(locale, name, labelKey, options, selected) {
  return `
    <label>
      <span>${escapeHtml(t(locale, labelKey))}</span>
      <select data-cashflow-ui-preference="${escapeHtml(name)}">
        ${options.map(option => `
          <option value="${escapeHtml(option.id)}"${option.id === selected ? " selected" : ""}>
            ${escapeHtml(t(locale, option.labelKey))}
          </option>
        `).join("")}
      </select>
    </label>
  `;
}

function renderUserMenu(locale, cashflow = null, canAdmin = false, uiPreferences = DEFAULT_UI_PREFERENCES) {
  const session = cashflow?.session || {};
  const label = session.displayName || session.accountDisplayName || session.userId || session.accountId || t(locale, "Account");
  const preferences = normalizeUiPreferences(uiPreferences);

  return `
    <details class="cashflow-user-menu">
      <summary class="cashflow-chip cashflow-chip--menu">
        ${escapeHtml(t(locale, "User"))}: <strong>${escapeHtml(label)}</strong>
      </summary>
      <div class="cashflow-user-menu__panel">
        <div class="cashflow-user-menu__section">
          <button type="button" data-cashflow-menu-tab="budgets">${escapeHtml(t(locale, "Budgets"))}</button>
          <button type="button" data-cashflow-menu-tab="settings">${escapeHtml(t(locale, "Settings"))}</button>
          ${canAdmin ? `<button type="button" data-cashflow-menu-tab="admin">${escapeHtml(t(locale, "Admin"))}</button>` : ""}
          <button type="button" data-cashflow-logout>${escapeHtml(t(locale, "Logout"))}</button>
        </div>
        <div class="cashflow-user-menu__section cashflow-user-menu__preferences" data-cashflow-ui-preferences>
          <strong>${escapeHtml(t(locale, "Display preferences"))}</strong>
          ${renderMenuLanguageSelect(locale, cashflow)}
          ${renderPreferenceSelect(locale, "theme", "Theme", UI_THEME_OPTIONS, preferences.theme)}
          ${renderPreferenceSelect(locale, "density", "Density", UI_DENSITY_OPTIONS, preferences.density)}
          ${renderPreferenceSelect(locale, "defaultTab", "Default landing tab", UI_DEFAULT_TAB_OPTIONS, preferences.defaultTab)}
          <small>${escapeHtml(t(locale, "Saved in this browser for the selected account."))}</small>
        </div>
      </div>
    </details>
  `;
}

function renderCashflowPageContent({
  cashflow = null,
  error = "",
  message = "",
  validationResult = null,
  fx = null,
  activeTab = "ledger",
  budgetManager = {},
  versionCheck = null,
  uiPreferences = DEFAULT_UI_PREFERENCES
}) {
  const locale = localeOf(cashflow);

  if (error && !cashflow) {
    return `
      <div class="cashflow-page" data-cashflow-page>
        <div class="empty-state">
          <h2>${escapeHtml(t(locale, "Error"))}</h2>
          <p>${escapeHtml(error)}</p>
          <button type="button" class="cashflow-action cashflow-action--secondary" data-cashflow-logout>
            ${escapeHtml(t(locale, "Return to user selection"))}
          </button>
        </div>
      </div>
    `;
  }

  const tabs = [
    { id: "ledger", label: t(locale, "Ledger") },
    { id: "recurring", label: t(locale, "Recurring expenses") },
    { id: "income", label: t(locale, "Recurring income") },
    { id: "oneoff", label: t(locale, "One-off") },
    { id: "goals", label: t(locale, "Goals") },
    { id: "flex", label: t(locale, "Flex") },
    { id: "priority", label: t(locale, "Priorities") },
    { id: "budgets", label: t(locale, "Budgets") },
    { id: "settings", label: t(locale, "Settings") }
  ];
  const canAdmin = hasPermission(cashflow, "admin");
  const canMaintain = hasCapability(cashflow, "budget:maintain");
  const canValidate = hasCapability(cashflow, "budget:validate");
  const effectiveActiveTab = activeTab === "admin" && !canAdmin ? "ledger" : activeTab;

  if (canAdmin) {
    tabs.push({ id: "admin", label: t(locale, "Admin") });
  }

  return `
    <div class="cashflow-page" data-cashflow-page>
      <div class="cashflow-header">
        <div class="cashflow-header__main">
          <div>
            <div class="cashflow-title-line">
              <h2>${escapeHtml(t(locale, "Cashflow"))}</h2>
              ${cashflow?.app?.version ? `
                <span class="cashflow-version">${escapeHtml(`v${cashflow.app.version}`)}</span>
                <span data-cashflow-version-status-root>${renderCashflowVersionStatus(locale, versionCheck)}</span>
              ` : ""}
            </div>
            <p class="cashflow-eyebrow">${escapeHtml(t(locale, "Financial planner"))}</p>
          </div>

          ${renderFxTopBar(locale, cashflow, fx)}
        </div>

        <div class="cashflow-header__actions">
          ${canMaintain ? `<button type="button" class="cashflow-action cashflow-action--secondary" data-cashflow-refresh-fx>
            ${escapeHtml(t(locale, "Refresh FX"))}
          </button>` : ""}
          ${canValidate ? `<button type="button" class="cashflow-action cashflow-action--secondary" data-cashflow-validate>
            ${escapeHtml(t(locale, "Validate"))}
          </button>` : ""}
          ${canMaintain ? `<button type="button" class="cashflow-action cashflow-action--primary" data-cashflow-run-jobs>
            ${escapeHtml(t(locale, "Regenerate"))}
          </button>` : ""}
          ${renderUserMenu(locale, cashflow, canAdmin, uiPreferences)}
        </div>
      </div>

      ${error ? `
        <div class="cashflow-notice cashflow-notice--error" data-cashflow-error-banner role="alert">
          <span>${escapeHtml(error)}</span>
          <button type="button" class="btn-small" data-cashflow-dismiss-error>
            ${escapeHtml(t(locale, "Dismiss"))}
          </button>
        </div>
      ` : ""}
      ${message ? `<div class="detail-note">${escapeHtml(message)}</div>` : ""}
      ${renderValidationResult(locale, validationResult)}
      ${renderProjectionWarnings(locale, cashflow)}

      <div class="cashflow-tabs" data-cashflow-tabs>
        <div class="tab-buttons" role="tablist" aria-label="${escapeHtml(t(locale, "Cashflow sections"))}">
          ${tabs.map(tab => `
            <button
              class="tab-button${effectiveActiveTab === tab.id ? " active" : ""}"
              data-cashflow-tab="${tab.id}"
              role="tab"
              aria-selected="${effectiveActiveTab === tab.id ? "true" : "false"}"
            >
              ${escapeHtml(tab.label)}
            </button>
          `).join("")}
        </div>

        <div class="tab-content">
          ${effectiveActiveTab === "ledger" ? renderLedgerTab(locale, cashflow) : ""}
          ${effectiveActiveTab === "recurring" ? renderRecurringExpensesTab(locale, cashflow) : ""}
          ${effectiveActiveTab === "income" ? renderRecurringIncomeTab(locale, cashflow) : ""}
          ${effectiveActiveTab === "oneoff" ? renderOneOffTab(locale, cashflow) : ""}
          ${effectiveActiveTab === "goals" ? renderGoalsTab(locale, cashflow) : ""}
          ${effectiveActiveTab === "flex" ? renderFlexTab(locale, cashflow) : ""}
          ${effectiveActiveTab === "priority" ? renderPriorityTab(locale, cashflow) : ""}
          ${effectiveActiveTab === "budgets" ? renderBudgetManagerTab(locale, cashflow, budgetManager) : ""}
          ${effectiveActiveTab === "settings" ? renderSettingsTab(locale, cashflow) : ""}
          ${effectiveActiveTab === "admin" && canAdmin ? renderAdminTab(locale, cashflow) : ""}
        </div>
      </div>
    </div>
  `;
}

export function renderCashflowPage(props) {
  return renderCashflowPageContent(props);
}

export function patchCashflowPage(root, props) {
  if (!root) return false;
  const nextHtml = renderCashflowPageContent(props);
  root.innerHTML = nextHtml;
  attachCashflowHandlers(root, props);
  return true;
}
