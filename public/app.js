import {
  attachCashflowHandlers,
  renderCashflowPage
} from "./app/cashflow.js";
import {
  renderSetupPage,
  renderUserSelectionPage
} from "./app/cashflow/session-pages.js";
import {
  formatMessage,
  loadLocale,
  localeOf,
  t
} from "./app/cashflow/shared.js";

const root = document.getElementById("cashflowRoot");

const state = {
  cashflow: null,
  error: "",
  message: "",
  users: [],
  selectedUserId: localStorage.getItem("cashflow_user_id") || "",
  validationResult: null,
  fx: null,
  activeTab: sessionStorage.getItem("cashflow_active_tab") || "ledger"
};

function selectedUserId() {
  return String(state.selectedUserId || "").trim();
}

async function cashflowFetch(url, options = {}) {
  const headers = {
    ...(options.headers || {})
  };
  const userId = selectedUserId();

  if (userId) {
    headers["x-cashflow-user-id"] = userId;
  }

  return fetch(url, {
    ...options,
    headers
  });
}

window.cashflowFetch = cashflowFetch;

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || formatMessage(null, "Request failed with status {status}", { status: response.status }));
  }

  return payload;
}

async function fetchCashflowJson(url, options = {}) {
  const response = await cashflowFetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || formatMessage(null, "Request failed with status {status}", { status: response.status }));
  }

  return payload;
}

function render() {
  if (!selectedUserId()) {
    root.innerHTML = renderUserSelectionPage({
      users: state.users,
      error: state.error,
      message: state.message
    });
    attachShellHandlers();
    return;
  }

  if (state.cashflow?.setup_required) {
    root.innerHTML = renderSetupPage({
      cashflow: state.cashflow,
      error: state.error,
      message: state.message
    });
    attachShellHandlers();
    return;
  }

  root.innerHTML = renderCashflowPage(state);
  attachCashflowHandlers(root, { cashflow: state.cashflow });
}

async function loadUsers(messageKey = "") {
  state.message = "";
  state.error = "";
  state.cashflow = null;

  try {
    const result = await fetchJson("/api/users", { cache: "no-store" });
    state.users = Array.isArray(result.users) ? result.users : [];
    state.message = messageKey ? t(null, messageKey) : "";
  } catch (error) {
    state.error = error.message || t(null, "Failed to list users");
  }

  render();
}

async function loadCashflow(messageKey = "") {
  state.message = "";
  state.error = "";
  state.validationResult = null;

  try {
    state.cashflow = await fetchCashflowJson("/api", { cache: "no-store" });
    const locale = localeOf(state.cashflow);
    await loadLocale(locale);
    document.documentElement.lang = locale;
    state.message = messageKey ? t(locale, messageKey) : "";
  } catch (error) {
    state.error = error.message || t(null, "Failed to load cashflow");
  }

  render();
}

function attachShellHandlers() {
  root.querySelectorAll("[data-cashflow-select-user]").forEach(button => {
    button.addEventListener("click", async () => {
      const userId = button.getAttribute("data-cashflow-select-user");
      if (!userId) return;

      try {
        await fetchJson("/api/session/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId })
        });
        state.selectedUserId = userId;
        localStorage.setItem("cashflow_user_id", userId);
        await loadCashflow();
      } catch (error) {
        state.error = error.message || t(null, "Failed to select user");
        render();
      }
    });
  });

  root.querySelector("[data-cashflow-create-user-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      const result = await fetchJson("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(formData))
      });
      const userId = result?.session?.userId || formData.get("userId");
      state.selectedUserId = String(userId || "").trim();
      localStorage.setItem("cashflow_user_id", state.selectedUserId);
      await loadCashflow();
    } catch (error) {
      state.error = error.message || t(null, "Failed to create user");
      render();
    }
  });

  root.querySelector("[data-cashflow-setup-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData);
    payload.future_periods = Number(payload.future_periods || 11);
    payload.opening_balance = Number(payload.opening_balance || 0);
    payload.income_amount = Number(payload.income_amount || 0);
    payload.income_anchor_day = Number(payload.income_anchor_day || 1);
    payload.income_enabled = form.querySelector("input[name='income_enabled']")?.checked ? 1 : 0;

    try {
      state.cashflow = await fetchCashflowJson("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const locale = localeOf(state.cashflow);
      await loadLocale(locale);
      document.documentElement.lang = locale;
      state.message = t(locale, "Setup completed");
      state.error = "";
      render();
    } catch (error) {
      state.error = error.message || t(null, "Failed to complete first-run setup");
      render();
    }
  });

  root.querySelectorAll("[data-cashflow-logout]").forEach(button => {
    button.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("cashflow-logout"));
    });
  });
}

window.addEventListener("cashflow-tab-change", (event) => {
  const tabId = event.detail?.tabId;
  if (!tabId) return;

  state.activeTab = tabId;
  sessionStorage.setItem("cashflow_active_tab", tabId);
  render();
});

window.addEventListener("cashflow-refresh", () => {
  if (selectedUserId()) {
    void loadCashflow();
  } else {
    void loadUsers();
  }
});

window.addEventListener("cashflow-saved", () => {
  state.message = t(null, "Saved");
});

window.addEventListener("cashflow-error", (event) => {
  state.error = event.detail?.message || t(null, "Cashflow request failed");
  state.validationResult = null;
  render();
});

window.addEventListener("cashflow-validated", (event) => {
  const result = event.detail || {};
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];

  state.error = "";
  state.message = warnings.length
    ? formatMessage(
      null,
      warnings.length === 1 ? "Validation found {count} warning" : "Validation found {count} warnings",
      { count: warnings.length }
    )
    : t(null, "Validation passed");
  state.validationResult = result;
  render();
});

window.addEventListener("cashflow-settings-update", async (event) => {
  try {
    await fetchCashflowJson("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event.detail || {})
    });
    await loadCashflow("Settings saved");
  } catch (error) {
    state.error = error.message || t(null, "Failed to save settings");
    render();
  }
});

window.addEventListener("cashflow-admin-options-update", async (event) => {
  try {
    await fetchCashflowJson("/api/admin/options", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event.detail || {})
    });
    await loadCashflow("Global options saved");
  } catch (error) {
    state.error = error.message || t(null, "Failed to save admin options");
    render();
  }
});

window.addEventListener("cashflow-logout", async () => {
  try {
    await fetchCashflowJson("/api/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
  } catch {
    // Logout is local for now; future auth can make this endpoint stateful.
  }

  state.selectedUserId = "";
  state.cashflow = null;
  state.error = "";
  state.message = "";
  state.validationResult = null;
  localStorage.removeItem("cashflow_user_id");
  await loadLocale("en");
  document.documentElement.lang = "en";
  await loadUsers();
});

if (selectedUserId()) {
  void loadCashflow();
} else {
  void loadUsers();
}
