import {
  deleteCashflowEntity,
  postCashflowJson,
  runCashflowAction,
  validateCashflowAction
} from "./actions.js";
import { escapeHtml } from "../utils.js";
import { DEFAULT_LEDGER_CURRENCY, FX_PROVIDER_NOTES } from "./constants.js";
import { openCashflowModal } from "./modal.js";
import { localeOf, t } from "./shared.js";

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

function syncManualFxRateRows(form, locale) {
  const provider = form.querySelector("[data-fx-provider]")?.value || "nbp";
  const ledgerCurrency = String(form.querySelector("[data-ledger-currency]")?.value || DEFAULT_LEDGER_CURRENCY).toUpperCase();
  const note = form.querySelector("[data-fx-provider-note]");
  const selected = form.querySelector("[data-fx-currency-selected]");
  const container = form.querySelector("[data-manual-fx-rates]");

  if (note) {
    note.textContent = t(locale, FX_PROVIDER_NOTES[provider] || FX_PROVIDER_NOTES.nbp);
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
    container.innerHTML = `<small>${escapeHtml(t(locale, "Select at least one used currency to enter manual rates."))}</small>`;
    return;
  }

  container.innerHTML = currencies.map(currency => `
    <label data-manual-fx-rate-row="${currency}">
      <span>${currency} / ${ledgerCurrency}</span>
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

function currentBudgetId(root, cashflow) {
  return root.querySelector("[data-cashflow-budget-manager]")?.getAttribute("data-current-budget-id")
    || cashflow?.session?.budgetId
    || cashflow?.session?.userId
    || "";
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value || ""));
  return String(value || "").replace(/["\\\]]/g, "\\$&");
}

function dispatchBudgetRefresh(detail = {}) {
  window.dispatchEvent(new CustomEvent("cashflow-budget-manager-refresh", { detail }));
}

function dispatchBudgetSelectionCleared(detail = {}) {
  window.dispatchEvent(new CustomEvent("cashflow-budget-selection-cleared", { detail }));
}

function adminAuthPayload(form) {
  const value = name => String(form.querySelector(`[name="${name}"]`)?.value || "").trim();
  return {
    draftMode: value("draftMode") || "none",
    sessionIdleMinutes: Number(value("sessionIdleMinutes") || 720),
    sessionAbsoluteMinutes: Number(value("sessionAbsoluteMinutes") || 10080),
    draftConfig: {
      external: {
        adminGroups: value("external.adminGroups"),
        allowedDomains: value("external.allowedDomains"),
        assertionSecretEnv: value("external.assertionSecretEnv") || "CASHFLOW_EXTERNAL_AUTH_SECRET",
        assertionSecretHeader: value("external.assertionSecretHeader") || "x-cashflow-auth-secret",
        displayNameHeader: value("external.displayNameHeader"),
        emailHeader: value("external.emailHeader"),
        groupsHeader: value("external.groupsHeader"),
        provisioningMode: value("external.provisioningMode") || "deny_unknown",
        subjectHeader: value("external.subjectHeader") || "x-auth-request-user",
        trustedIssuer: value("external.trustedIssuer")
      },
      internal: {
        allowPasswordLogin: form.querySelector('input[name="internal.allowPasswordLogin"]')?.checked ? 1 : 0
      }
    }
  };
}

function adminProviderPayload(form) {
  const value = name => String(form.querySelector(`[name="${name}"]`)?.value || "").trim();
  const payload = {
    kind: value("kind") || "oidc",
    displayName: value("displayName"),
    enabled: form.querySelector('input[name="enabled"]')?.checked ? 1 : 0,
    issuer: value("issuer"),
    clientId: value("clientId"),
    redirectUri: value("redirectUri"),
    scope: value("scope"),
    authorizationEndpoint: value("authorizationEndpoint"),
    tokenEndpoint: value("tokenEndpoint"),
    userInfoEndpoint: value("userInfoEndpoint")
  };
  if (value("secretEnv")) payload.secretEnv = value("secretEnv");
  return payload;
}

async function downloadCashflowFile(apiClient, url, fallbackName) {
  const response = await apiClient.raw(url);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const disposition = response.headers.get("content-disposition") || "";
  const fileNameMatch = disposition.match(/filename="([^"]+)"/);

  link.href = objectUrl;
  link.download = fileNameMatch?.[1] || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

async function withBusyButton(button, busyLabel, fn) {
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = t(null, busyLabel);

  try {
    return await fn();
  } catch (error) {
    window.dispatchEvent(new CustomEvent("cashflow-error", {
      detail: {
        message: error.message
      }
    }));
    return null;
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

export function attachCashflowHandlers(root, props = {}) {
  if (!root) return;

  const cashflow = props.cashflow || null;
  const apiClient = props.apiClient;
  const locale = localeOf(cashflow);

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

  root.querySelectorAll("[data-cashflow-dismiss-error]").forEach(button => {
    button.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("cashflow-error-dismiss"));
    });
  });

  root.querySelectorAll("[data-cashflow-toggle-funding]").forEach(button => {
    button.addEventListener("click", () => {
      const overview = button.closest("[data-cashflow-funding-overview]");
      const grid = overview?.querySelector("[data-cashflow-funding-grid]");
      const expanded = button.getAttribute("aria-expanded") === "true";

      grid?.classList.toggle("cashflow-funding-overview--collapsed", expanded);
      button.setAttribute("aria-expanded", String(!expanded));
      button.textContent = expanded
        ? button.getAttribute("data-show-all-label")
        : button.getAttribute("data-show-less-label");
    });
  });

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
          apiClient,
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
        apiClient,
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
      const confirmMessage = btn.getAttribute("data-cashflow-delete-confirm") || "";
      if (!txId) return;

      deleteCashflowEntity(apiClient, btn, entityType, txId, confirmMessage);
    });
  });

  root.querySelectorAll("[data-cashflow-run-jobs]").forEach(btn => {
    btn.addEventListener("click", () => {
      runCashflowAction(
        apiClient,
        btn,
        "/api/run-jobs",
        "cashflow-regenerated"
      );
    });
  });

  root.querySelectorAll("[data-cashflow-refresh-fx]").forEach(btn => {
    btn.addEventListener("click", () => {
      runCashflowAction(
        apiClient,
        btn,
        "/api/fx/refresh",
        "cashflow-fx-refreshed"
      );
    });
  });

  root.querySelectorAll("[data-cashflow-validate]").forEach(btn => {
    btn.addEventListener("click", () => {
      validateCashflowAction(apiClient, btn);
    });
  });

  root.querySelectorAll("[data-cashflow-logout]").forEach(btn => {
    btn.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("cashflow-logout"));
    });
  });

  root.querySelectorAll("[data-cashflow-move-future-to-pending]").forEach(btn => {
    btn.addEventListener("click", () => {
      const txId = btn.getAttribute("data-cashflow-move-future-to-pending");
      const occurrenceKey = btn.getAttribute("data-cashflow-move-future-occurrence-key") || "";
      if (!txId) return;

      runCashflowAction(
        apiClient,
        btn,
        `/api/future/${encodeURIComponent(txId)}/move-to-pending`,
        "cashflow-future-moved-to-pending",
        { occurrenceKey }
      );
    });
  });

  root.querySelectorAll("[data-cashflow-recalculate-pending]").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!window.confirm(t(locale, "Delete pending and recalculate?"))) return;

      runCashflowAction(
        apiClient,
        btn,
        "/api/pending/recalculate",
        "cashflow-pending-recalculated"
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
        apiClient,
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

  const budgetManager = root.querySelector("[data-cashflow-budget-manager]");
  if (budgetManager) {
    budgetManager.querySelector("[data-cashflow-create-budget-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      withBusyButton(form.querySelector("button[type='submit']"), "Working...", async () => {
        const result = await postCashflowJson(apiClient, "/api/budgets", Object.fromEntries(new FormData(form)));
        dispatchBudgetRefresh(result);
      });
    });

    budgetManager.querySelectorAll("[data-cashflow-budget-select]").forEach(button => {
      button.addEventListener("click", () => {
        const budgetId = button.getAttribute("data-cashflow-budget-select");
        if (!budgetId) return;
        withBusyButton(button, "Working...", async () => {
          const result = await postCashflowJson(apiClient, `/api/budgets/${encodeURIComponent(budgetId)}/select`);
          window.dispatchEvent(new CustomEvent("cashflow-budget-selected", {
            detail: { budgetId, session: result.session }
          }));
        });
      });
    });

    budgetManager.querySelectorAll("[data-cashflow-budget-rename]").forEach(button => {
      button.addEventListener("click", () => {
        const budgetId = button.getAttribute("data-cashflow-budget-rename");
        const input = budgetManager.querySelector(`[data-cashflow-budget-name="${CSS.escape(budgetId)}"]`);
        if (!budgetId || !input) return;
        withBusyButton(button, "Working...", async () => {
          const result = await apiClient.json(`/api/budgets/${encodeURIComponent(budgetId)}`, {
            method: "PUT",
            body: { displayName: input.value }
          });
          dispatchBudgetRefresh(result);
        });
      });
    });

    budgetManager.querySelectorAll("[data-cashflow-budget-export]").forEach(button => {
      button.addEventListener("click", () => {
        const budgetId = button.getAttribute("data-cashflow-budget-export");
        if (!budgetId) return;
        withBusyButton(button, "Working...", () => downloadCashflowFile(apiClient, `/api/budgets/${encodeURIComponent(budgetId)}/export`, `cashflow-${budgetId}-full-export.json`));
      });
    });

    budgetManager.querySelectorAll("[data-cashflow-budget-archive]").forEach(button => {
      button.addEventListener("click", () => {
        const budgetId = button.getAttribute("data-cashflow-budget-archive");
        if (!budgetId || !window.confirm(t(locale, "Archive this budget?"))) return;
        withBusyButton(button, "Working...", async () => {
          const result = await postCashflowJson(apiClient, `/api/budgets/${encodeURIComponent(budgetId)}/archive`);
          if (budgetId === currentBudgetId(root, cashflow)) {
            dispatchBudgetSelectionCleared(result);
          } else {
            dispatchBudgetRefresh(result);
          }
        });
      });
    });

    budgetManager.querySelectorAll("[data-cashflow-budget-restore]").forEach(button => {
      button.addEventListener("click", () => {
        const budgetId = button.getAttribute("data-cashflow-budget-restore");
        if (!budgetId) return;
        withBusyButton(button, "Working...", async () => {
          const result = await postCashflowJson(apiClient, `/api/budgets/${encodeURIComponent(budgetId)}/restore`);
          dispatchBudgetRefresh(result);
        });
      });
    });

    budgetManager.querySelectorAll("[data-cashflow-budget-purge]").forEach(button => {
      button.addEventListener("click", () => {
        const budgetId = button.getAttribute("data-cashflow-budget-purge");
        if (!budgetId || !window.confirm(t(locale, "Purge this archived budget? A safety export is created first."))) return;
        withBusyButton(button, "Working...", async () => {
          const result = await apiClient.json(`/api/budgets/${encodeURIComponent(budgetId)}`, { method: "DELETE" });
          if (budgetId === currentBudgetId(root, cashflow)) {
            dispatchBudgetSelectionCleared(result);
          } else {
            dispatchBudgetRefresh(result);
          }
        });
      });
    });

    budgetManager.querySelectorAll("[data-cashflow-budget-leave]").forEach(button => {
      button.addEventListener("click", () => {
        const budgetId = button.getAttribute("data-cashflow-budget-leave");
        if (!budgetId || !window.confirm(t(locale, "Leave this budget?"))) return;
        withBusyButton(button, "Working...", async () => {
          const result = await postCashflowJson(apiClient, `/api/budgets/${encodeURIComponent(budgetId)}/leave`);
          dispatchBudgetSelectionCleared(result);
        });
      });
    });

    budgetManager.querySelectorAll("[data-cashflow-member-update]").forEach(button => {
      button.addEventListener("click", () => {
        const accountId = button.getAttribute("data-cashflow-member-update");
        const budgetId = currentBudgetId(root, cashflow);
        const role = budgetManager.querySelector(`[data-cashflow-member-role="${cssEscape(accountId)}"]`)?.value || "";
        if (!budgetId || !accountId || !role) return;
        withBusyButton(button, "Working...", async () => {
          const result = await apiClient.json(`/api/budgets/${encodeURIComponent(budgetId)}/members/${encodeURIComponent(accountId)}`, {
            method: "PUT",
            body: { role }
          });
          dispatchBudgetRefresh(result);
        });
      });
    });

    budgetManager.querySelectorAll("[data-cashflow-member-remove]").forEach(button => {
      button.addEventListener("click", () => {
        const accountId = button.getAttribute("data-cashflow-member-remove");
        const budgetId = currentBudgetId(root, cashflow);
        if (!budgetId || !accountId || !window.confirm(t(locale, "Remove this member?"))) return;
        withBusyButton(button, "Working...", async () => {
          const result = await apiClient.json(`/api/budgets/${encodeURIComponent(budgetId)}/members/${encodeURIComponent(accountId)}`, { method: "DELETE" });
          dispatchBudgetRefresh(result);
        });
      });
    });

    budgetManager.querySelectorAll("[data-cashflow-member-transfer]").forEach(button => {
      button.addEventListener("click", () => {
        const accountId = button.getAttribute("data-cashflow-member-transfer");
        const budgetId = currentBudgetId(root, cashflow);
        if (!budgetId || !accountId || !window.confirm(t(locale, "Transfer ownership to this member?"))) return;
        withBusyButton(button, "Working...", async () => {
          const result = await postCashflowJson(apiClient, `/api/budgets/${encodeURIComponent(budgetId)}/transfer-ownership`, { accountId });
          dispatchBudgetRefresh(result);
        });
      });
    });

    budgetManager.querySelector("[data-cashflow-budget-invite-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const budgetId = currentBudgetId(root, cashflow);
      if (!budgetId) return;
      withBusyButton(form.querySelector("button[type='submit']"), "Working...", async () => {
        const payload = Object.fromEntries(new FormData(form));
        payload.expiresInHours = Number(payload.expiresInHours || 168);
        if (!payload.accountId) delete payload.accountId;
        if (!payload.email) delete payload.email;
        const result = await postCashflowJson(apiClient, `/api/budgets/${encodeURIComponent(budgetId)}/invitations`, payload);
        window.dispatchEvent(new CustomEvent("cashflow-budget-invitation-created", { detail: result }));
      });
    });

    budgetManager.querySelectorAll("[data-cashflow-invitation-revoke]").forEach(button => {
      button.addEventListener("click", () => {
        const invitationId = button.getAttribute("data-cashflow-invitation-revoke");
        const budgetId = currentBudgetId(root, cashflow);
        if (!budgetId || !invitationId || !window.confirm(t(locale, "Revoke this invitation?"))) return;
        withBusyButton(button, "Working...", async () => {
          const result = await apiClient.json(`/api/budgets/${encodeURIComponent(budgetId)}/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" });
          dispatchBudgetRefresh(result);
        });
      });
    });
  }

  const settingsForm = root.querySelector("[data-cashflow-settings-form]");
  if (settingsForm) {
    const availableCurrencies = settingsForm.querySelector("[data-fx-currency-available]");
    const selectedCurrencies = settingsForm.querySelector("[data-fx-currency-selected]");

    settingsForm.querySelector("[data-fx-currency-add]")?.addEventListener("click", () => {
      moveSelectedOptions(availableCurrencies, selectedCurrencies);
      syncManualFxRateRows(settingsForm, locale);
    });

    settingsForm.querySelector("[data-fx-currency-remove]")?.addEventListener("click", () => {
      moveSelectedOptions(selectedCurrencies, availableCurrencies);
      syncManualFxRateRows(settingsForm, locale);
    });

    settingsForm.querySelector("[data-fx-provider]")?.addEventListener("change", () => {
      syncManualFxRateRows(settingsForm, locale);
    });

    settingsForm.querySelector("[data-ledger-currency]")?.addEventListener("change", () => {
      syncManualFxRateRows(settingsForm, locale);
    });

    syncManualFxRateRows(settingsForm, locale);

    settingsForm.querySelector("[data-cashflow-download-full-export]")?.addEventListener("click", (event) => {
      withBusyButton(event.currentTarget, "Working...", () => {
        const includeOperationalSettings = settingsForm.querySelector("[data-cashflow-export-operational-settings]")?.checked;
        const url = includeOperationalSettings
          ? "/api/export/full?includeOperationalSettings=1"
          : "/api/export/full";
        return downloadCashflowFile(apiClient, url, "cashflow-full-export.json");
      });
    });

    settingsForm.querySelector("[data-cashflow-download-ledger-csv]")?.addEventListener("click", (event) => {
      withBusyButton(event.currentTarget, "Working...", () => downloadCashflowFile(apiClient, "/api/export/confirmed-ledger.csv", "cashflow-confirmed-ledger.csv"));
    });

    settingsForm.querySelector("[data-cashflow-download-sample]")?.addEventListener("click", (event) => {
      withBusyButton(event.currentTarget, "Working...", () => downloadCashflowFile(apiClient, "/api/export/sample", "cashflow-sample-dataset.json"));
    });

    settingsForm.querySelector("[data-cashflow-import-full]")?.addEventListener("click", (event) => {
      withBusyButton(event.currentTarget, "Importing...", async () => {
        const input = settingsForm.querySelector("[data-cashflow-full-import-file]");
        const file = input?.files?.[0];
        if (!file) throw new Error(t(locale, "Choose a full export file first."));

        const text = await file.text();
        const exportData = JSON.parse(text);
        const mode = settingsForm.querySelector("[data-cashflow-full-import-mode]")?.value || "replace";
        const includeOperationalSettings = settingsForm.querySelector("[data-cashflow-import-operational-settings]")?.checked;
        const result = await postCashflowJson(apiClient, "/api/import/full", {
          mode,
          export: exportData,
          includeOperationalSettings
        });

        window.dispatchEvent(new CustomEvent("cashflow-refresh", { detail: result }));
      });
    });

    settingsForm.querySelector("[data-cashflow-import-oneoff-csv]")?.addEventListener("click", (event) => {
      withBusyButton(event.currentTarget, "Importing...", async () => {
        const input = settingsForm.querySelector("[data-cashflow-oneoff-csv-file]");
        const file = input?.files?.[0];
        if (!file) throw new Error(t(locale, "Choose a one-off CSV file first."));

        const mode = window.confirm(t(locale, "Replace unconfirmed one-off transactions before importing? Cancel appends instead."))
          ? "replace"
          : "append";
        const csv = await file.text();
        const result = await postCashflowJson(apiClient, "/api/import/one-offs-csv", { mode, csv });

        window.dispatchEvent(new CustomEvent("cashflow-refresh", { detail: result }));
      });
    });

    settingsForm.querySelector("[data-cashflow-load-sample]")?.addEventListener("click", (event) => {
      if (!window.confirm(t(locale, "Load sample dataset? Current data will be replaced after a safety backup."))) return;

      withBusyButton(event.currentTarget, "Importing...", async () => {
        const result = await postCashflowJson(apiClient, "/api/import/sample");
        window.dispatchEvent(new CustomEvent("cashflow-refresh", { detail: result }));
      });
    });

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
        "notify_fx_changed",
        "minimum_reserve_enabled"
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

  const adminForm = root.querySelector("[data-cashflow-admin-options-form]");
  if (adminForm) {
    adminForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormData(adminForm);
      const updates = Object.fromEntries(formData);
      updates.future_periods = Number(updates.future_periods || 11);
      updates.fx_buffer_percent = Number(updates.fx_buffer_percent || 0);

      window.dispatchEvent(new CustomEvent("cashflow-admin-options-update", { detail: updates }));
    });
  }

  const adminAuthForm = root.querySelector("[data-cashflow-admin-auth-form]");
  if (adminAuthForm) {
    adminAuthForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const button = adminAuthForm.querySelector("button[type='submit']");
      withBusyButton(button, "Working...", async () => {
        await apiClient.json("/api/admin/auth/draft", {
          method: "PUT",
          body: adminAuthPayload(adminAuthForm)
        });
        window.dispatchEvent(new CustomEvent("cashflow-refresh"));
      });
    });

    adminAuthForm.querySelector("[data-cashflow-admin-auth-test]")?.addEventListener("click", (event) => {
      withBusyButton(event.currentTarget, "Working...", async () => {
        await apiClient.json("/api/admin/auth/test", {
          method: "POST",
          body: {}
        });
        window.dispatchEvent(new CustomEvent("cashflow-refresh"));
      });
    });

    adminAuthForm.querySelector("[data-cashflow-admin-auth-activate]")?.addEventListener("click", (event) => {
      if (!window.confirm(t(locale, "Activate this auth draft?"))) return;
      withBusyButton(event.currentTarget, "Working...", async () => {
        await apiClient.json("/api/admin/auth/activate", {
          method: "POST",
          body: {}
        });
        window.dispatchEvent(new CustomEvent("cashflow-refresh"));
      });
    });
  }

  root.querySelectorAll("[data-cashflow-admin-provider-form]").forEach(form => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const providerId = String(form.querySelector('[name="providerId"]')?.value || "").trim();
      if (!providerId) return;
      const button = form.querySelector("button[type='submit']");
      withBusyButton(button, "Working...", async () => {
        await apiClient.json(`/api/admin/auth/providers/${encodeURIComponent(providerId)}`, {
          method: "PUT",
          body: adminProviderPayload(form)
        });
        window.dispatchEvent(new CustomEvent("cashflow-refresh"));
      });
    });
  });

  root.querySelectorAll("[data-cashflow-admin-provider-delete]").forEach(button => {
    button.addEventListener("click", () => {
      const providerId = button.getAttribute("data-cashflow-admin-provider-delete") || "";
      if (!providerId || !window.confirm(t(locale, "Delete this provider?"))) return;
      withBusyButton(button, "Working...", async () => {
        await apiClient.json(`/api/admin/auth/providers/${encodeURIComponent(providerId)}`, {
          method: "DELETE",
          body: {}
        });
        window.dispatchEvent(new CustomEvent("cashflow-refresh"));
      });
    });
  });

  root.querySelectorAll("[data-cashflow-admin-account-rename]").forEach(button => {
    button.addEventListener("click", () => {
      const accountId = button.getAttribute("data-cashflow-admin-account-rename");
      const input = root.querySelector(`[data-cashflow-admin-account-name="${cssEscape(accountId)}"]`);
      const emailInput = root.querySelector(`[data-cashflow-admin-account-email="${cssEscape(accountId)}"]`);
      if (!accountId || !input) return;

      withBusyButton(button, "Working...", async () => {
        const body = { displayName: input.value };
        if (emailInput?.value?.trim()) body.email = emailInput.value;
        await apiClient.json(`/api/admin/accounts/${encodeURIComponent(accountId)}`, {
          method: "PUT",
          body
        });
        window.dispatchEvent(new CustomEvent("cashflow-refresh"));
      });
    });
  });

  root.querySelectorAll("[data-cashflow-admin-password-token]").forEach(button => {
    button.addEventListener("click", () => {
      const accountId = button.getAttribute("data-cashflow-admin-password-token");
      const purpose = button.getAttribute("data-purpose") || "password_reset";
      if (!accountId) return;

      withBusyButton(button, "Working...", async () => {
        const result = await apiClient.json(`/api/admin/accounts/${encodeURIComponent(accountId)}/password-reset-token`, {
          method: "POST",
          body: { purpose }
        });
        const output = root.querySelector(`[data-cashflow-admin-password-token-output="${cssEscape(accountId)}"]`);
        if (output) {
          output.innerHTML = `${t(locale, "Password token")}: <code>${escapeHtml(result.token || "")}</code>`;
        }
      });
    });
  });

  root.querySelectorAll("[data-cashflow-admin-external-link]").forEach(button => {
    button.addEventListener("click", () => {
      const accountId = button.getAttribute("data-cashflow-admin-external-link");
      const subjectInput = root.querySelector(`[data-cashflow-admin-external-subject="${cssEscape(accountId)}"]`);
      if (!accountId || !subjectInput) return;

      withBusyButton(button, "Working...", async () => {
        await apiClient.json(`/api/admin/accounts/${encodeURIComponent(accountId)}/external-identity`, {
          method: "PUT",
          body: { subject: subjectInput.value }
        });
        window.dispatchEvent(new CustomEvent("cashflow-refresh"));
      });
    });
  });

  root.querySelectorAll("[data-cashflow-admin-account-status]").forEach(button => {
    button.addEventListener("click", () => {
      const accountId = button.getAttribute("data-cashflow-admin-account-status");
      const status = button.getAttribute("data-next-status") || "";
      if (!accountId || !status) return;
      if (status === "disabled" && !window.confirm(t(locale, "Disable this account?"))) return;

      withBusyButton(button, "Working...", async () => {
        await apiClient.json(`/api/admin/accounts/${encodeURIComponent(accountId)}`, {
          method: "PUT",
          body: { status }
        });
        window.dispatchEvent(new CustomEvent("cashflow-refresh"));
      });
    });
  });

  root.querySelectorAll("[data-cashflow-admin-account-admin]").forEach(button => {
    button.addEventListener("click", () => {
      const accountId = button.getAttribute("data-cashflow-admin-account-admin");
      const enabled = button.getAttribute("data-enabled") === "1";
      if (!accountId) return;
      if (!enabled && !window.confirm(t(locale, "Revoke system admin from this account?"))) return;

      withBusyButton(button, "Working...", async () => {
        await apiClient.json(`/api/admin/accounts/${encodeURIComponent(accountId)}/system-admin`, {
          method: "PUT",
          body: { enabled }
        });
        window.dispatchEvent(new CustomEvent("cashflow-refresh"));
      });
    });
  });

  root.querySelectorAll("[data-cashflow-admin-session-revoke]").forEach(button => {
    button.addEventListener("click", () => {
      const accountId = button.getAttribute("data-cashflow-admin-session-revoke");
      const sessionId = button.getAttribute("data-session-id") || "";
      if (!accountId || !sessionId || !window.confirm(t(locale, "Revoke this session?"))) return;

      withBusyButton(button, "Working...", async () => {
        await apiClient.json(`/api/admin/accounts/${encodeURIComponent(accountId)}/sessions/${encodeURIComponent(sessionId)}/revoke`, {
          method: "POST",
          body: {}
        });
        window.dispatchEvent(new CustomEvent("cashflow-refresh"));
      });
    });
  });

  root.querySelectorAll("[data-cashflow-admin-account-delete]").forEach(button => {
    button.addEventListener("click", () => {
      const accountId = button.getAttribute("data-cashflow-admin-account-delete");
      if (!accountId || !window.confirm(t(locale, "Delete this account?"))) return;

      withBusyButton(button, "Working...", async () => {
        await apiClient.json(`/api/admin/accounts/${encodeURIComponent(accountId)}`, {
          method: "DELETE"
        });
        window.dispatchEvent(new CustomEvent("cashflow-refresh"));
      });
    });
  });
}
