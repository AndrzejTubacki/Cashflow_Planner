import {
  attachCashflowHandlers,
  renderCashflowPage
} from "./app/cashflow.js";
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
  validationResult: null,
  fx: null,
  activeTab: sessionStorage.getItem("cashflow_active_tab") || "ledger"
};

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "x-cashflow-user-id": "local"
    }
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || formatMessage(null, "Request failed with status {status}", { status: response.status }));
  }

  return payload;
}

function render() {
  root.innerHTML = renderCashflowPage(state);
  attachCashflowHandlers(root, { cashflow: state.cashflow });
}

async function loadCashflow(messageKey = "") {
  state.message = "";
  state.error = "";
  state.validationResult = null;

  try {
    state.cashflow = await fetchJson("/api", { cache: "no-store" });
    const locale = localeOf(state.cashflow);
    await loadLocale(locale);
    document.documentElement.lang = locale;
    state.message = messageKey ? t(locale, messageKey) : "";
  } catch (error) {
    state.error = error.message || t(null, "Failed to load cashflow");
  }

  render();
}

window.addEventListener("cashflow-tab-change", (event) => {
  const tabId = event.detail?.tabId;
  if (!tabId) return;

  state.activeTab = tabId;
  sessionStorage.setItem("cashflow_active_tab", tabId);
  render();
});

window.addEventListener("cashflow-refresh", () => {
  void loadCashflow();
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
    await fetchJson("/api/settings", {
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

void loadCashflow();
