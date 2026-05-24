import {
  deleteCashflowEntity,
  runCashflowAction,
  validateCashflowAction
} from "./actions.js";
import { openCashflowModal } from "./modal.js";

const FX_PROVIDER_NOTES = {
  disabled: "Only PLN transactions can project without supplied rates.",
  manual: "Use the rates entered below.",
  nbp: "Polish central bank rates.",
  frankfurter: "ECB-backed rates for major currencies."
};

function selectedOptionValues(select) {
  return [...(select?.options || [])]
    .map(option => String(option.value || "").trim().toUpperCase())
    .filter(Boolean);
}

function moveSelectedOptions(from, to) {
  if (!from || !to) return;

  [...from.selectedOptions].forEach(option => {
    option.selected = false;
    to.appendChild(option);
  });

  [...from.options]
    .sort((a, b) => a.value.localeCompare(b.value))
    .forEach(option => from.appendChild(option));

  [...to.options]
    .sort((a, b) => a.value.localeCompare(b.value))
    .forEach(option => to.appendChild(option));
}

function syncManualFxRateRows(form) {
  const provider = form.querySelector("[data-fx-provider]")?.value || "nbp";
  const note = form.querySelector("[data-fx-provider-note]");
  const selected = form.querySelector("[data-fx-currency-selected]");
  const container = form.querySelector("[data-manual-fx-rates]");

  if (note) {
    note.textContent = FX_PROVIDER_NOTES[provider] || FX_PROVIDER_NOTES.nbp;
  }

  if (!container) return;

  container.hidden = provider !== "manual";

  const existingRates = Object.fromEntries(
    [...container.querySelectorAll("[data-manual-fx-rate]")].map(input => [
      input.getAttribute("data-manual-fx-rate"),
      input.value
    ])
  );

  const currencies = selectedOptionValues(selected);

  if (!currencies.length) {
    container.innerHTML = "<small>Select at least one used currency to enter manual rates.</small>";
    return;
  }

  container.innerHTML = currencies.map(currency => `
    <label data-manual-fx-rate-row="${currency}">
      <span>${currency} / PLN</span>
      <input
        type="number"
        min="0.000001"
        step="0.000001"
        value="${existingRates[currency] || ""}"
        data-manual-fx-rate="${currency}"
        placeholder="1.000000"
      >
    </label>
  `).join("");
}

export function attachCashflowHandlers(root, props = {}) {
  if (!root) return;

  const cashflow = props.cashflow || null;

  const tabButtons = root.querySelectorAll("[data-cashflow-tab]");
  if (tabButtons.length) {
    tabButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const tabId = btn.getAttribute("data-cashflow-tab");
        if (tabId) {
          sessionStorage.setItem("cashflow_active_tab", tabId);
          window.dispatchEvent(new CustomEvent("cashflow-tab-change", { detail: { tabId } }));
        }
      });
    });
  }

  const addButtons = [
    { selector: "[data-cashflow-add-recurring]", type: "recurring-expense" },
    { selector: "[data-cashflow-add-income]", type: "recurring-income" },
    { selector: "[data-cashflow-add-oneoff]", type: "one-off" },
    { selector: "[data-cashflow-add-goal]", type: "goal" },
    { selector: "[data-cashflow-add-flex]", type: "flex" }
  ];

  addButtons.forEach(({ selector, type }) => {
    root.querySelectorAll(selector).forEach(btn => {
      btn.addEventListener("click", () => {
        openCashflowModal({
          cashflow,
          entityType: type,
          action: "create"
        });
      });
    });
  });

  const editButtons = root.querySelectorAll("[data-edit-tx]");
  editButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const txId = btn.getAttribute("data-edit-tx");
      const entityType = btn.getAttribute("data-edit-entity") || "pending";

      if (entityType === "future" || entityType === "confirmed") {
        return;
      }

      openCashflowModal({
        cashflow,
        entityType,
        action: "edit",
        id: txId
      });
    });
  });

  root.querySelectorAll("[data-cashflow-delete-tx]").forEach(btn => {
    btn.addEventListener("click", () => {
      const txId = btn.getAttribute("data-cashflow-delete-tx");
      const entityType = btn.getAttribute("data-cashflow-delete-entity") || "one-off";
      if (!txId) return;

      deleteCashflowEntity(btn, entityType, txId);
    });
  });

  root.querySelectorAll("[data-cashflow-run-jobs]").forEach(btn => {
    btn.addEventListener("click", () => {
      runCashflowAction(
        btn,
        "/api/run-jobs",
        "cashflow-regenerated"
      );
    });
  });

  root.querySelectorAll("[data-cashflow-refresh-fx]").forEach(btn => {
    btn.addEventListener("click", () => {
      runCashflowAction(
        btn,
        "/api/fx/refresh",
        "cashflow-fx-refreshed"
      );
    });
  });

  root.querySelectorAll("[data-cashflow-validate]").forEach(btn => {
    btn.addEventListener("click", () => {
      validateCashflowAction(btn);
    });
  });

  root.querySelectorAll("[data-cashflow-move-future-to-pending]").forEach(btn => {
    btn.addEventListener("click", () => {
      const txId = btn.getAttribute("data-cashflow-move-future-to-pending");
      const occurrenceKey = btn.getAttribute("data-cashflow-move-future-occurrence-key") || "";
      if (!txId) return;

      runCashflowAction(
        btn,
        `/api/future/${encodeURIComponent(txId)}/move-to-pending`,
        "cashflow-future-moved-to-pending",
        { occurrenceKey }
      );
    });
  });

  root.querySelectorAll("[data-cashflow-confirm-pending]").forEach(btn => {
    btn.addEventListener("click", () => {
      const txId = btn.getAttribute("data-cashflow-confirm-pending");
      const confirmedDate = btn.getAttribute("data-cashflow-confirm-pending-date") || "";
      const amount = Number(btn.getAttribute("data-cashflow-confirm-pending-amount") || 0);
      if (!txId) return;

      runCashflowAction(
        btn,
        `/api/pending/${encodeURIComponent(txId)}/confirm`,
        "cashflow-pending-confirmed",
        {
          amount,
          confirmed_date: confirmedDate
        }
      );
    });
  });

  const settingsForm = root.querySelector("[data-cashflow-settings-form]");
  if (settingsForm) {
    const availableCurrencies = settingsForm.querySelector("[data-fx-currency-available]");
    const selectedCurrencies = settingsForm.querySelector("[data-fx-currency-selected]");

    settingsForm.querySelector("[data-fx-currency-add]")?.addEventListener("click", () => {
      moveSelectedOptions(availableCurrencies, selectedCurrencies);
      syncManualFxRateRows(settingsForm);
    });

    settingsForm.querySelector("[data-fx-currency-remove]")?.addEventListener("click", () => {
      moveSelectedOptions(selectedCurrencies, availableCurrencies);
      syncManualFxRateRows(settingsForm);
    });

    settingsForm.querySelector("[data-fx-provider]")?.addEventListener("change", () => {
      syncManualFxRateRows(settingsForm);
    });

    syncManualFxRateRows(settingsForm);

    settingsForm.addEventListener("submit", (e) => {
      e.preventDefault();

      const formData = new FormData(settingsForm);
      const updates = Object.fromEntries(formData);

      const checkboxNames = [
        "notify_goal_impossible",
        "notify_necessary_underfunded",
        "notify_funding_shortfall",
        "notify_income_missing",
        "notify_pending_summary",
        "notify_goal_funded",
        "notify_fx_changed"
      ];

      checkboxNames.forEach(name => {
        updates[name] = settingsForm.querySelector(`input[name="${name}"]`)?.checked ? 1 : 0;
      });

      updates.future_periods = Number(updates.future_periods || 11);
      updates.fx_buffer_percent = Number(updates.fx_buffer_percent || 0);
      updates.necessary_underfunded_repeat_days = Number(updates.necessary_underfunded_repeat_days || 1);
      updates.fx_used_currencies = selectedOptionValues(selectedCurrencies);
      updates.manual_fx_rates = Object.fromEntries(
        [...settingsForm.querySelectorAll("[data-manual-fx-rate]")].map(input => [
          input.getAttribute("data-manual-fx-rate"),
          Number(input.value || 0)
        ]).filter(([, rate]) => Number.isFinite(rate) && rate > 0)
      );

      window.dispatchEvent(new CustomEvent("cashflow-settings-update", { detail: updates }));
    });
  }
}
