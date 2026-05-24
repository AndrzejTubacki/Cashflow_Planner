import { escapeHtml } from "../utils.js";
import { cashflowApiForEntity } from "./actions.js";
import { renderCashflowModalFields } from "./modal-fields.js";
import { localeOf, t } from "./shared.js";

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
    "recurring-expense": t(locale, "wydatek cykliczny", "recurring expense"),
    "recurring-income": t(locale, "dochód cykliczny", "recurring income"),
    "one-off": t(locale, "transakcję jednorazową", "one-off transaction"),
    "goal": t(locale, "cel", "goal"),
    "flex": t(locale, "transakcję elastyczną", "flex transaction"),
    "pending": t(locale, "transakcję oczekującą", "pending transaction")
  };

  const verb = action === "edit"
    ? t(locale, "Edytuj", "Edit")
    : t(locale, "Dodaj", "Add");

  return `${verb} ${labels[entityType] || entityType}`;
}

function syncCashflowAnchorFields(modal) {
  const anchorSelect = modal.querySelector("[data-cashflow-anchor-type]");
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

  anchorSelect?.addEventListener("change", applyAnchorVisibility);
  repeatInput?.addEventListener("input", applyRepeatVisibility);
  repeatInput?.addEventListener("change", applyRepeatVisibility);
  allowSplitInput?.addEventListener("change", applyFlexVisibility);

  modal.querySelector('select[name="anchor_business_day_adjustment"]')
    ?.addEventListener("change", applyAnchorVisibility);

  applyAnchorVisibility();
  applyRepeatVisibility();
  applyFlexVisibility();
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
    "min_amount",
    "max_amount"
  ];

  for (const field of numericFields) {
    if (data[field] === "" || data[field] === undefined) {
      delete data[field];
    } else if (data[field] !== undefined) {
      data[field] = Number(data[field]);
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

export function openCashflowModal({ cashflow, entityType, action = "create", id = null }) {
  const locale = localeOf(cashflow);
  const item = action === "edit" ? findCashflowEntity(cashflow, entityType, id) : {};

  if (action === "edit" && !item) {
    window.dispatchEvent(new CustomEvent("cashflow-error", {
      detail: {
        message: `Could not find ${entityType} ${id}`
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
        <button type="button" class="btn-small" data-cashflow-modal-close>x</button>
      </div>

      <form class="cashflow-modal__form" data-cashflow-modal-form>
        ${renderCashflowModalFields(locale, entityType, item, cashflow)}

        <div class="cashflow-modal__error" data-cashflow-modal-error hidden></div>

        <div class="cashflow-modal__actions">
          <button type="button" class="cashflow-action cashflow-action--secondary" data-cashflow-modal-close>
            ${escapeHtml(t(locale, "Anuluj", "Cancel"))}
          </button>
          <button type="submit" class="cashflow-action cashflow-action--primary">
            ${escapeHtml(action === "edit" ? t(locale, "Zapisz", "Save") : t(locale, "Dodaj", "Add"))}
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

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error || `Request failed with status ${response.status}`);
      }

      closeCashflowModal();

      window.dispatchEvent(new CustomEvent("cashflow-saved", {
        detail: body
      }));

      window.dispatchEvent(new CustomEvent("cashflow-refresh", {}));
    } catch (error) {
      errorBox.hidden = false;
      errorBox.textContent = error.message || "Failed to save";
    } finally {
      submitButton.disabled = false;
    }
  });
}
