import { escapeHtml } from "../utils.js";
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
  formatMessage,
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

function normalizeCurrencyList(value) {
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
      .filter(currency => currency && currency !== "PLN")
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

function renderFxRateChip(currency, rates) {
  const key = String(currency || "").toLowerCase();
  const rate = Number(rates?.[key]?.rate || rates?.[currency]?.rate || 0);

  if (!rate) return "";

  return `
    <span class="cashflow-chip cashflow-chip--fx">
      ${escapeHtml(currency)}/PLN <strong>${escapeHtml(rate.toFixed(4))}</strong>
    </span>
  `;
}

function renderFxTopBar(locale, cashflow = null, fx = null) {
  const rates = parseFxRates(cashflow, fx);
  const configuredCurrencies = normalizeCurrencyList(cashflow?.settings?.fx_used_currencies);
  const rateCurrencies = Object.keys(rates || {})
    .map(currency => String(currency || "").toUpperCase())
    .filter(currency => currency && currency !== "PLN");
  const currencies = configuredCurrencies.length
    ? configuredCurrencies
    : [...new Set(rateCurrencies)].sort();

  const ledgerChip = `
    <span class="cashflow-chip">
      ${escapeHtml(t(locale, "Ledger"))}: <strong>PLN</strong>
    </span>
  `;

  const fxChips = currencies
    .map(currency => renderFxRateChip(currency, rates))
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

function renderCashflowPageContent({
  cashflow = null,
  error = "",
  message = "",
  validationResult = null,
  fx = null,
  activeTab = "ledger"
}) {
  const locale = localeOf(cashflow);

  if (error) {
    return `
      <div class="cashflow-page" data-cashflow-page>
        <div class="empty-state">
          <h2>${escapeHtml(t(locale, "Error"))}</h2>
          <p>${escapeHtml(error)}</p>
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
    { id: "settings", label: t(locale, "Settings") }
  ];

  return `
    <div class="cashflow-page" data-cashflow-page>
      <div class="cashflow-header">
        <div class="cashflow-header__main">
          <div>
            <div class="cashflow-title-line">
              <h2>${escapeHtml(t(locale, "Cashflow"))}</h2>
              ${cashflow?.app?.version ? `
                <span class="cashflow-version">${escapeHtml(`v${cashflow.app.version}`)}</span>
              ` : ""}
            </div>
            <p class="cashflow-eyebrow">${escapeHtml(t(locale, "Financial planner"))}</p>
          </div>

          ${renderFxTopBar(locale, cashflow, fx)}
        </div>

        <div class="cashflow-header__actions">
          <button type="button" class="cashflow-action cashflow-action--secondary" data-cashflow-refresh-fx>
            ${escapeHtml(t(locale, "Refresh FX"))}
          </button>
          <button type="button" class="cashflow-action cashflow-action--secondary" data-cashflow-validate>
            ${escapeHtml(t(locale, "Validate"))}
          </button>
          <button type="button" class="cashflow-action cashflow-action--primary" data-cashflow-run-jobs>
            ${escapeHtml(t(locale, "Regenerate"))}
          </button>
        </div>
      </div>

      ${message ? `<div class="detail-note">${escapeHtml(message)}</div>` : ""}
      ${renderValidationResult(locale, validationResult)}
      ${renderProjectionWarnings(locale, cashflow)}

      <div class="cashflow-tabs" data-cashflow-tabs>
        <div class="tab-buttons">
          ${tabs.map(tab => `
            <button class="tab-button${activeTab === tab.id ? " active" : ""}" data-cashflow-tab="${tab.id}">
              ${escapeHtml(tab.label)}
            </button>
          `).join("")}
        </div>

        <div class="tab-content">
          ${activeTab === "ledger" ? renderLedgerTab(locale, cashflow) : ""}
          ${activeTab === "recurring" ? renderRecurringExpensesTab(locale, cashflow) : ""}
          ${activeTab === "income" ? renderRecurringIncomeTab(locale, cashflow) : ""}
          ${activeTab === "oneoff" ? renderOneOffTab(locale, cashflow) : ""}
          ${activeTab === "goals" ? renderGoalsTab(locale, cashflow) : ""}
          ${activeTab === "flex" ? renderFlexTab(locale, cashflow) : ""}
          ${activeTab === "priority" ? renderPriorityTab(locale, cashflow) : ""}
          ${activeTab === "settings" ? renderSettingsTab(locale, cashflow) : ""}
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
