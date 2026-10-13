import { escapeHtml } from "../utils.js";
import { cashflowApiForEntity } from "./actions.js";
import { renderCashflowModalFields } from "./modal-fields.js";
import { formatMessage, localeOf, t } from "./shared.js";

function findCashflowEntity(cashflow, entityType, id) {
  const lists = {
    "recurring-expense": cashflow?.recurringExpenses || [],
    "recurring-income": cashflow?.recurringIncomes || [],
    "one-off": cashflow?.oneOffs || [],
    "goal": cashflow?.goals || [],
    "flex": cashflow?.flexTransactions || [],
    "pending": cashflow?.pendingTransactions || []
  };

  return (lists[entityType] || []).find(item => item.id === id) || null;
}

function cashflowModalTitle(locale, entityType, action) {
  const labels = {
    "recurring-expense": t(locale, "recurring expense"),
    "recurring-income": t(locale, "recurring income"),
    "one-off": t(locale, "one-off transaction"),
    "goal": t(locale, "goal"),
    "flex": t(locale, "flex transaction"),
    "pending": t(locale, "pending transaction")
  };

  const verb = action === "edit"
    ? t(locale, "Edit")
    : t(locale, "Add");

  return `${verb} ${labels[entityType] || entityType}`;
}

function syncCashflowAnchorFields(modal) {
  const anchorSelect = modal.querySelector("[data-cashflow-anchor-type]");
  const predictionSelect = modal.querySelector("[data-prediction-strategy]");
  const predictionSubstituteSelect = modal.querySelector('select[name="prediction_substitute_missing"]');
  const repeatInput = modal.querySelector("[data-repeat-every-months]");
  const allowSplitInput = modal.querySelector("[data-allow-split]");

  const setHidden = (selector, hidden) => {
    modal.querySelectorAll(selector).forEach(el => {
      el.hidden = hidden;

      el.querySelectorAll("input, select, textarea").forEach(input => {
        input.disabled = hidden;
      });
    });
  };

  const applyAnchorVisibility = () => {
    if (!anchorSelect) return;

    const isDay = anchorSelect.value === "day_of_month";
    const isMonthEnd = anchorSelect.value === "month_end";

    setHidden("[data-anchor-day-field]", !isDay);
    setHidden("[data-anchor-month-end-field]", !isMonthEnd);

    const adjustment = modal.querySelector('select[name="anchor_business_day_adjustment"]')?.value || "none";
    const needsHolidayCountry = isMonthEnd && adjustment !== "none";

    setHidden("[data-anchor-holiday-country-field]", !needsHolidayCountry);
  };

  const applyRepeatVisibility = () => {
    if (!repeatInput) return;

    const repeatEveryMonths = Number(repeatInput.value || 1);
    const needsStartMonth = repeatEveryMonths > 1;

    setHidden("[data-start-month-year-field]", !needsStartMonth);

    const startInput = modal.querySelector('input[name="start_month_year"]');
    if (startInput) {
      startInput.required = needsStartMonth;
    }
  };

  const applyFlexVisibility = () => {
    if (!allowSplitInput) return;

    const allowSplit = allowSplitInput.checked;
    setHidden("[data-flex-split-field]", !allowSplit);
  };

  const applyPredictionVisibility = () => {
    if (!predictionSelect) return;

    const usesTwelveMonthPrediction = predictionSelect.value === "12month_min" ||
      predictionSelect.value === "12month_max";
    const usesMinimumRecordedMonths = usesTwelveMonthPrediction &&
      predictionSubstituteSelect?.value === "require_min_recorded_months";

    setHidden("[data-prediction-substitute-field]", !usesTwelveMonthPrediction);
    setHidden("[data-prediction-min-recorded-months-field]", !usesMinimumRecordedMonths);
  };

  anchorSelect?.addEventListener("change", applyAnchorVisibility);
  predictionSelect?.addEventListener("change", applyPredictionVisibility);
  predictionSubstituteSelect?.addEventListener("change", applyPredictionVisibility);
  repeatInput?.addEventListener("input", applyRepeatVisibility);
  repeatInput?.addEventListener("change", applyRepeatVisibility);
  allowSplitInput?.addEventListener("change", applyFlexVisibility);

  modal.querySelector('select[name="anchor_business_day_adjustment"]')
    ?.addEventListener("change", applyAnchorVisibility);

  applyAnchorVisibility();
  applyPredictionVisibility();
  applyRepeatVisibility();
  applyFlexVisibility();
}

export function normalizeCashflowNumericInput(value) {
  const raw = String(value ?? "").trim();
  return /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(raw)
    ? raw.replace(",", ".")
    : raw;
}

function coerceCashflowModalPayload(entityType, form) {
  const formData = new FormData(form);
  const data = Object.fromEntries(formData);

  const numericFields = [
    "amount",
    "priority",
    "repeat_every_months",
    "anchor_day_of_month",
    "anchor_offset_days",
    "prediction_min_recorded_months",
    "min_amount",
    "max_amount"
  ];

  for (const field of numericFields) {
    if (data[field] === "" || data[field] === undefined) {
      delete data[field];
    } else if (data[field] !== undefined) {
      const normalized = normalizeCashflowNumericInput(data[field]);
      const parsed = Number(normalized);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid numeric value provided for ${field.replace(/_/g, " ")}`);
      }
      data[field] = parsed;
    }
  }

  const checkboxFields = [
    "active",
    "necessary",
    "period_setting",
    "allow_split"
  ];

  for (const field of checkboxFields) {
    if (form.querySelector(`input[name="${field}"]`)) {
      data[field] = form.querySelector(`input[name="${field}"]`)?.checked ? 1 : 0;
    }
  }

  if (data.currency) {
    data.currency = String(data.currency).toUpperCase();
  }

  if (entityType === "pending") {
    delete data.currency;
  }

  return data;
}

export function closeCashflowModal() {
  document.querySelector("[data-cashflow-modal-root]")?.remove();
}

const PASSWORD_TOKEN_EXPIRY_OPTIONS = [
  { hours: 1, label: "1 hour" },
  { hours: 4, label: "4 hours" },
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" }
];
const PASSWORD_TOKEN_DEFAULT_EXPIRY_HOURS = 24;

// navigator.clipboard only exists in secure contexts; plain-http LAN installs need the legacy path.
async function copyTextToClipboard(text, input) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the selection-based copy.
    }
  }
  input.focus();
  input.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

function formatTokenExpiry(locale, expiresAt) {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return String(expiresAt || "");
  try {
    return date.toLocaleString(locale || undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return date.toLocaleString();
  }
}

function renderPasswordTokenResult(locale, { token, expiresAt, purpose, accountLabel, email, internalLoginActive }) {
  return `
    <label>
      <span>${escapeHtml(t(locale, "Password token"))}</span>
      <div class="cashflow-token-copy">
        <input readonly value="${escapeHtml(token)}" data-cashflow-token-value aria-label="${escapeHtml(t(locale, "Password token"))}">
        <button type="button" class="cashflow-action cashflow-action--primary" data-cashflow-token-copy>
          ${escapeHtml(t(locale, "Copy"))}
        </button>
      </div>
    </label>
    <p class="cashflow-token-status" data-cashflow-token-copy-status aria-live="polite"></p>

    <p>${escapeHtml(formatMessage(locale, "Valid until {date}. It can be used once.", { date: formatTokenExpiry(locale, expiresAt) }))}</p>

    ${internalLoginActive ? "" : `
      <div class="cashflow-modal__error">
        ${escapeHtml(t(locale, "Internal login is not the active authentication mode, so the login page does not show the Set password form yet. Activate internal login under Authentication before sending this token."))}
      </div>
    `}

    <div class="cashflow-token-instructions">
      <h4>${escapeHtml(t(locale, "How to use it"))}</h4>
      <ol>
        <li>${escapeHtml(formatMessage(locale, "Send the token to {account} privately. Anyone who has it can set this account's password.", { account: accountLabel }))}</li>
        <li>${escapeHtml(t(locale, "They open Cashflow and find the Set password form on the login page."))}</li>
        <li>${escapeHtml(t(locale, "They paste the token, choose a password of at least 12 characters, and select Set password."))}</li>
        <li>${escapeHtml(email
          ? formatMessage(locale, "They then log in with {email} and the new password.", { email })
          : t(locale, "They then log in with their email and the new password."))}</li>
      </ol>
      ${purpose === "password_reset" ? `<p>${escapeHtml(t(locale, "Setting the new password signs this account out of every existing session."))}</p>` : ""}
      <p>${escapeHtml(t(locale, "This is the only time the token is shown. If it is lost, create a new one."))}</p>
    </div>
  `;
}

export function openPasswordTokenModal({
  apiClient,
  locale = null,
  accountId,
  accountLabel = "",
  email = "",
  purpose = "password_reset",
  internalLoginActive = true
}) {
  closeCashflowModal();

  const label = accountLabel || accountId;
  const title = purpose === "password_setup"
    ? t(locale, "Create password setup token")
    : t(locale, "Create password reset token");

  const root = document.createElement("div");
  root.setAttribute("data-cashflow-modal-root", "");
  root.setAttribute("data-cashflow-password-token-modal", "");
  root.className = "cashflow-modal-root";

  root.innerHTML = `
    <div class="cashflow-modal-backdrop" data-cashflow-modal-close></div>

    <div class="cashflow-modal" role="dialog" aria-modal="true" aria-labelledby="cashflow-password-token-title">
      <div class="cashflow-modal__header">
        <h3 id="cashflow-password-token-title">${escapeHtml(title)}</h3>
        <button type="button" class="btn-small" data-cashflow-modal-close aria-label="${escapeHtml(t(locale, "Cancel"))}">x</button>
      </div>

      <form class="cashflow-modal__form" data-cashflow-admin-token-form>
        <p>${escapeHtml(formatMessage(locale, "Account: {account}", { account: label }))}</p>
        <label>
          <span>${escapeHtml(t(locale, "Token expires after"))}</span>
          <select name="expiresInHours" id="cashflow-password-token-expiry">
            ${PASSWORD_TOKEN_EXPIRY_OPTIONS.map(option => `
              <option value="${option.hours}"${option.hours === PASSWORD_TOKEN_DEFAULT_EXPIRY_HOURS ? " selected" : ""}>
                ${escapeHtml(t(locale, option.label))}
              </option>
            `).join("")}
          </select>
        </label>
        <p>${escapeHtml(t(locale, "Creating a token cancels any earlier unused token for this account."))}</p>

        <div class="cashflow-modal__error" data-cashflow-modal-error hidden></div>

        <div class="cashflow-modal__actions">
          <button type="button" class="cashflow-action cashflow-action--secondary" data-cashflow-modal-close>
            ${escapeHtml(t(locale, "Cancel"))}
          </button>
          <button type="submit" class="cashflow-action cashflow-action--primary">
            ${escapeHtml(t(locale, "Create token"))}
          </button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(root);

  const bindClose = () => {
    root.querySelectorAll("[data-cashflow-modal-close]").forEach(btn => {
      btn.addEventListener("click", closeCashflowModal);
    });
  };
  bindClose();

  root.querySelector("[data-cashflow-admin-token-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const errorBox = root.querySelector("[data-cashflow-modal-error]");
    const submitButton = form.querySelector('button[type="submit"]');
    const expiresInHours = Number(form.elements.expiresInHours.value);

    errorBox.hidden = true;
    errorBox.textContent = "";
    submitButton.disabled = true;

    try {
      const result = await apiClient.json(`/api/admin/accounts/${encodeURIComponent(accountId)}/password-reset-token`, {
        method: "POST",
        body: { purpose, expiresInHours }
      });

      form.innerHTML = `
        ${renderPasswordTokenResult(locale, {
          token: String(result?.token || ""),
          expiresAt: result?.expiresAt,
          purpose: result?.purpose || purpose,
          accountLabel: result?.account?.display_name || result?.account?.displayName || label,
          email: result?.account?.email || email,
          internalLoginActive
        })}
        <div class="cashflow-modal__actions">
          <button type="button" class="cashflow-action cashflow-action--secondary" data-cashflow-modal-close>
            ${escapeHtml(t(locale, "Done"))}
          </button>
        </div>
      `;
      bindClose();

      const tokenInput = form.querySelector("[data-cashflow-token-value]");
      const copyButton = form.querySelector("[data-cashflow-token-copy]");
      const copyStatus = form.querySelector("[data-cashflow-token-copy-status]");
      copyButton?.addEventListener("click", async () => {
        const copied = await copyTextToClipboard(tokenInput.value, tokenInput);
        copyStatus.textContent = copied
          ? t(locale, "Copied to clipboard.")
          : t(locale, "Copy failed. Select the token and copy it manually.");
        if (copied) copyButton.textContent = t(locale, "Copied");
      });
      tokenInput?.addEventListener("focus", () => tokenInput.select());
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = error.message || t(locale, "Failed to create password setup token");
      submitButton.disabled = false;
    }
  });
}

export function openCashflowModal({ apiClient, cashflow, entityType, action = "create", id = null }) {
  const locale = localeOf(cashflow);
  const item = action === "edit" ? findCashflowEntity(cashflow, entityType, id) : {};

  if (action === "edit" && !item) {
    window.dispatchEvent(new CustomEvent("cashflow-error", {
      detail: {
        message: formatMessage(locale, "Could not find {entityType} {id}", { entityType, id })
      }
    }));
    return;
  }

  closeCashflowModal();

  const root = document.createElement("div");
  root.setAttribute("data-cashflow-modal-root", "");
  root.className = "cashflow-modal-root";

  root.innerHTML = `
    <div class="cashflow-modal-backdrop" data-cashflow-modal-close></div>

    <div class="cashflow-modal" role="dialog" aria-modal="true">
      <div class="cashflow-modal__header">
        <h3>${escapeHtml(cashflowModalTitle(locale, entityType, action))}</h3>
        <button type="button" class="btn-small" data-cashflow-modal-close aria-label="${escapeHtml(t(locale, "Cancel"))}">x</button>
      </div>

      <form class="cashflow-modal__form" data-cashflow-modal-form>
        ${renderCashflowModalFields(locale, entityType, item, cashflow)}

        <div class="cashflow-modal__error" data-cashflow-modal-error hidden></div>

        <div class="cashflow-modal__actions">
          <button type="button" class="cashflow-action cashflow-action--secondary" data-cashflow-modal-close>
            ${escapeHtml(t(locale, "Cancel"))}
          </button>
          <button type="submit" class="cashflow-action cashflow-action--primary">
            ${escapeHtml(action === "edit" ? t(locale, "Save") : t(locale, "Add"))}
          </button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(root);
  syncCashflowAnchorFields(root);

  root.querySelectorAll("[data-cashflow-modal-close]").forEach(btn => {
    btn.addEventListener("click", closeCashflowModal);
  });

  root.querySelector("[data-cashflow-modal-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const form = event.currentTarget;
    const errorBox = root.querySelector("[data-cashflow-modal-error]");
    const submitButton = form.querySelector('button[type="submit"]');

    errorBox.hidden = true;
    errorBox.textContent = "";
    submitButton.disabled = true;

    try {
      const payload = coerceCashflowModalPayload(entityType, form);
      const url = cashflowApiForEntity(entityType, action === "edit" ? id : null);
      const method = action === "edit" ? "PUT" : "POST";
      const body = await apiClient.json(url, {
        method,
        body: payload
      });

      closeCashflowModal();

      window.dispatchEvent(new CustomEvent("cashflow-saved", {
        detail: body
      }));

      window.dispatchEvent(new CustomEvent("cashflow-refresh", {}));
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = error.message || t(locale, "Failed to save");
    } finally {
      submitButton.disabled = false;
    }
  });
}
