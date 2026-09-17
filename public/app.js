import {
  attachCashflowHandlers,
  renderCashflowVersionStatus,
  renderCashflowPage
} from "./app/cashflow.js";
import {
  renderBudgetSelectionPage,
  renderSetupPage,
  renderUserSelectionPage
} from "./app/cashflow/session-pages.js";
import { createCashflowApiClient } from "./app/cashflow/api-client.js";
import {
  formatMessage,
  hasPermission,
  loadLocale,
  localeOf,
  t
} from "./app/cashflow/shared.js";
import {
  applyUiPreferences,
  loadUiPreferences,
  normalizeUiPreferences,
  saveUiPreferences
} from "./app/cashflow/ui-preferences.js";

const root = document.getElementById("cashflowRoot");
const RELEASE_API_URL = "https://api.github.com/repos/AndrzejTubacki/Cashflow_Planner/releases/latest";
const initialAccountId = localStorage.getItem("cashflow_account_id") || "";
const initialUiPreferences = loadUiPreferences(initialAccountId);

const state = {
  accountSession: null,
  accounts: [],
  auth: {
    activeMode: "none",
    internal: {
      allowPasswordLogin: true
    }
  },
  budgets: [],
  budgetManager: {
    accounts: [],
    budgets: [],
    invitations: [],
    lastInvitation: null,
    members: []
  },
  cashflow: null,
  csrfToken: "",
  error: "",
  message: "",
  users: [],
  selectedAccountId: initialAccountId,
  selectedUserId: localStorage.getItem("cashflow_budget_id") || localStorage.getItem("cashflow_user_id") || "",
  validationResult: null,
  fx: null,
  activeTab: sessionStorage.getItem("cashflow_active_tab") || initialUiPreferences.defaultTab,
  versionCheck: null,
  uiPreferences: initialUiPreferences
};

let versionCheckStarted = false;
applyUiPreferences(state.uiPreferences);

function selectedUserId() {
  return String(state.selectedUserId || "").trim();
}

function uiPreferenceScope() {
  return String(state.selectedAccountId || state.accountSession?.accountId || state.selectedUserId || "default").trim() || "default";
}

function refreshUiPreferences({ useDefaultTab = false } = {}) {
  state.uiPreferences = loadUiPreferences(uiPreferenceScope());
  applyUiPreferences(state.uiPreferences);
  if (useDefaultTab && !sessionStorage.getItem("cashflow_active_tab")) {
    state.activeTab = state.uiPreferences.defaultTab;
  }
}

const apiClient = createCashflowApiClient({
  getBudgetId: selectedUserId,
  getCsrfToken: () => state.csrfToken
});

function clearSelectedUserState() {
  state.selectedUserId = "";
  state.selectedAccountId = "";
  state.accountSession = null;
  state.cashflow = null;
  state.csrfToken = "";
  state.error = "";
  state.message = "";
  state.budgets = [];
  state.budgetManager = {
    accounts: [],
    budgets: [],
    invitations: [],
    lastInvitation: null,
    members: []
  };
  state.validationResult = null;
  localStorage.removeItem("cashflow_account_id");
  localStorage.removeItem("cashflow_budget_id");
  localStorage.removeItem("cashflow_user_id");
}

function enforceActiveTabPermissions() {
  if (state.activeTab === "admin" && !hasPermission(state.cashflow, "admin")) {
    state.activeTab = "ledger";
    sessionStorage.setItem("cashflow_active_tab", "ledger");
  }
}

function compareVersions(left, right) {
  const leftParts = String(left || "").replace(/^v/i, "").split(".").map(part => Number.parseInt(part, 10) || 0);
  const rightParts = String(right || "").replace(/^v/i, "").split(".").map(part => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }

  return 0;
}

async function checkLatestVersion() {
  if (versionCheckStarted || !state.cashflow?.app?.version) return;
  versionCheckStarted = true;
  state.versionCheck = { status: "checking" };

  try {
    const response = await fetch(RELEASE_API_URL, {
      cache: "no-store",
      headers: { accept: "application/vnd.github+json" }
    });
    if (!response.ok) throw new Error("Version check failed");

    const latest = await response.json();
    const latestVersion = String(latest?.tag_name || latest?.name || "").replace(/^v/i, "");
    if (!latestVersion) throw new Error("Version check failed");

    state.versionCheck = compareVersions(latestVersion, state.cashflow.app.version) > 0
      ? { status: "available", latestVersion, htmlUrl: latest?.html_url || "" }
      : { status: "current", latestVersion };
  } catch {
    state.versionCheck = { status: "unavailable" };
  }

  updateVersionStatus();
}

function updateVersionStatus() {
  const target = root.querySelector("[data-cashflow-version-status-root]");
  if (!target) return;
  target.innerHTML = renderCashflowVersionStatus(localeOf(state.cashflow), state.versionCheck);
}

function render() {
  if (state.selectedAccountId && !selectedUserId()) {
    root.innerHTML = renderBudgetSelectionPage({
      account: state.accountSession,
      budgets: state.budgets,
      error: state.error,
      message: state.message
    });
    attachShellHandlers();
    return;
  }

  if (!selectedUserId()) {
    root.innerHTML = renderUserSelectionPage({
      accounts: state.accounts.length ? state.accounts : state.users,
      users: state.users,
      auth: state.auth,
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
  attachCashflowHandlers(root, { apiClient, cashflow: state.cashflow });
}

async function loadUsers(messageKey = "") {
  state.message = "";
  state.error = "";
  state.cashflow = null;

  try {
    const authResult = await apiClient.json("/api/auth/config", { cache: "no-store", scoped: false }).catch(() => ({
      auth: {
        activeMode: "none",
        internal: {
          allowPasswordLogin: true
        }
      }
    }));
    state.auth = authResult.auth || state.auth;

    if (state.auth.activeMode !== "none" && !state.selectedAccountId && !selectedUserId()) {
      const sessionResult = await apiClient.json("/api/session", { cache: "no-store", scoped: false }).catch(() => null);
      const session = sessionResult?.session || {};
      if (session.authenticated && session.accountId) {
        state.csrfToken = String(sessionResult?.csrfToken || "");
        state.selectedAccountId = String(session.accountId || "").trim();
        state.accountSession = session;
        localStorage.setItem("cashflow_account_id", state.selectedAccountId);
        await loadBudgets(messageKey);
        return;
      }
    }

    const shouldLoadPublicSelectors = state.auth.activeMode === "none";
    const [accountsResult, usersResult] = await Promise.all([
      shouldLoadPublicSelectors
        ? apiClient.json("/api/accounts", { cache: "no-store", scoped: false }).catch(() => ({ accounts: [] }))
        : Promise.resolve({ accounts: [] }),
      shouldLoadPublicSelectors
        ? apiClient.json("/api/users", { cache: "no-store", scoped: false }).catch(() => ({ users: [] }))
        : Promise.resolve({ users: [] })
    ]);
    state.accounts = Array.isArray(accountsResult.accounts) ? accountsResult.accounts : [];
    state.users = Array.isArray(usersResult.users) ? usersResult.users : [];
    state.message = messageKey ? t(null, messageKey) : "";
  } catch (error) {
    state.error = error.message || t(null, "Failed to list accounts");
  }

  render();
}

async function loadBudgets(messageKey = "") {
  state.error = "";
  state.message = "";

  try {
    const result = await apiClient.json("/api/budgets", { cache: "no-store", scoped: false });
    state.budgets = Array.isArray(result.budgets) ? result.budgets : [];
    state.message = messageKey ? t(null, messageKey) : "";
  } catch (error) {
    state.error = error.message || t(null, "Failed to list budgets");
  }

  render();
}

async function loadBudgetManagerData({ preserveInvitation = false } = {}) {
  if (!state.cashflow?.session?.accountId) return;

  const budgetId = selectedUserId();
  const manager = {
    accounts: [],
    budgets: [],
    invitations: [],
    lastInvitation: preserveInvitation ? state.budgetManager.lastInvitation : null,
    members: []
  };

  const [accountsResult, budgetsResult] = await Promise.all([
    apiClient.json("/api/accounts", { cache: "no-store", scoped: false }).catch(() => ({ accounts: [] })),
    apiClient.json("/api/budgets", { cache: "no-store", scoped: false }).catch(() => ({ budgets: [] }))
  ]);
  manager.accounts = Array.isArray(accountsResult.accounts) ? accountsResult.accounts : [];
  manager.budgets = Array.isArray(budgetsResult.budgets) ? budgetsResult.budgets : [];

  const currentBudget = manager.budgets.find(budget => budget.id === budgetId);
  const currentRole = currentBudget?.role || state.cashflow?.session?.budgetRole || "";

  if (budgetId && (currentRole === "owner" || currentRole === "manager")) {
    const [membersResult, invitationsResult] = await Promise.all([
      apiClient.json(`/api/budgets/${encodeURIComponent(budgetId)}/members`, { cache: "no-store", scoped: false }).catch(() => ({ members: [] })),
      apiClient.json(`/api/budgets/${encodeURIComponent(budgetId)}/invitations`, { cache: "no-store", scoped: false }).catch(() => ({ invitations: [] }))
    ]);
    manager.members = Array.isArray(membersResult.members) ? membersResult.members : [];
    manager.invitations = Array.isArray(invitationsResult.invitations) ? invitationsResult.invitations : [];
  }

  state.budgetManager = manager;
}

async function loadCashflow(messageKey = "") {
  state.message = "";
  state.error = "";
  state.validationResult = null;

  try {
    state.cashflow = await apiClient.json("/api", { cache: "no-store" });
    const locale = localeOf(state.cashflow);
    await loadLocale(locale);
    document.documentElement.lang = locale;
    enforceActiveTabPermissions();
    state.accountSession = state.cashflow.session || state.accountSession;
    state.selectedAccountId = state.cashflow.session?.accountId || state.selectedAccountId;
    if (state.selectedAccountId) localStorage.setItem("cashflow_account_id", state.selectedAccountId);
    refreshUiPreferences({ useDefaultTab: true });
    await loadBudgetManagerData({ preserveInvitation: true });
    state.message = messageKey ? t(locale, messageKey) : "";
    void checkLatestVersion();
  } catch (error) {
    state.error = error.message || t(null, "Failed to load cashflow");
  }

  render();
}

async function resumeSelectedUser() {
  try {
    const result = await apiClient.json("/api/session", { cache: "no-store" });
    const session = result?.session || {};
    state.csrfToken = String(result?.csrfToken || "");

    if (!session.authenticated || session.userId !== selectedUserId()) {
      const error = new Error("Selected user is no longer available. Choose a user to continue.");
      error.status = 404;
      throw error;
    }

    state.accountSession = session;
    state.selectedAccountId = session.accountId || state.selectedAccountId;
    if (state.selectedAccountId) localStorage.setItem("cashflow_account_id", state.selectedAccountId);
    await loadCashflow();
  } catch (error) {
    if (error?.status === 401 || error?.status === 404) {
      clearSelectedUserState();
      await loadLocale("en");
      document.documentElement.lang = "en";
      await loadUsers("Selected user is no longer available. Choose a user to continue.");
      return;
    }

    state.error = error.message || t(null, "Failed to load session");
    render();
  }
}

async function resumeSelectedAccount() {
  try {
    const result = await apiClient.json("/api/session", { cache: "no-store", scoped: false });
    const session = result?.session || {};
    state.csrfToken = String(result?.csrfToken || "");

    if (!session.authenticated || session.accountId !== state.selectedAccountId) {
      const error = new Error("Selected account is no longer available. Choose an account to continue.");
      error.status = 404;
      throw error;
    }

    state.accountSession = session;
    await loadBudgets();
  } catch (error) {
    if (error?.status === 401 || error?.status === 404) {
      clearSelectedUserState();
      await loadLocale("en");
      document.documentElement.lang = "en";
      await loadUsers("Selected account is no longer available. Choose an account to continue.");
      return;
    }

    state.error = error.message || t(null, "Failed to load session");
    render();
  }
}

function attachShellHandlers() {
  root.querySelector("[data-cashflow-external-login]")?.addEventListener("click", async () => {
    try {
      const result = await apiClient.json("/api/auth/external/login", {
        method: "POST",
        body: {},
        scoped: false
      });
      state.csrfToken = String(result?.csrfToken || "");
      state.selectedAccountId = String(result?.session?.accountId || "").trim();
      state.accountSession = result?.session || null;
      state.budgets = Array.isArray(result?.budgets) ? result.budgets : [];
      state.selectedUserId = "";
      if (state.selectedAccountId) localStorage.setItem("cashflow_account_id", state.selectedAccountId);
      localStorage.removeItem("cashflow_budget_id");
      localStorage.removeItem("cashflow_user_id");
      refreshUiPreferences({ useDefaultTab: true });
      render();
    } catch (error) {
      state.error = error.message || t(null, "Failed to log in with external authentication");
      render();
    }
  });

  root.querySelectorAll("[data-cashflow-provider-login]").forEach(button => {
    button.addEventListener("click", async () => {
      const providerId = button.getAttribute("data-cashflow-provider-login") || "";
      if (!providerId) return;

      try {
        const result = await apiClient.json(`/api/auth/providers/${encodeURIComponent(providerId)}/login/start`, {
          method: "POST",
          body: {},
          scoped: false
        });
        if (result?.authorizationUrl) {
          window.location.assign(result.authorizationUrl);
          return;
        }
        throw new Error(t(null, "Provider login did not return an authorization URL"));
      } catch (error) {
        state.error = error.message || t(null, "Failed to start provider login");
        render();
      }
    });
  });

  root.querySelector("[data-cashflow-internal-login-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      const result = await apiClient.json("/api/auth/internal/login", {
        method: "POST",
        body: Object.fromEntries(formData),
        scoped: false
      });
      state.csrfToken = String(result?.csrfToken || "");
      state.selectedAccountId = String(result?.session?.accountId || "").trim();
      state.accountSession = result?.session || null;
      state.budgets = Array.isArray(result?.budgets) ? result.budgets : [];
      state.selectedUserId = "";
      if (state.selectedAccountId) localStorage.setItem("cashflow_account_id", state.selectedAccountId);
      localStorage.removeItem("cashflow_budget_id");
      localStorage.removeItem("cashflow_user_id");
      refreshUiPreferences({ useDefaultTab: true });
      render();
    } catch (error) {
      state.error = error.message || t(null, "Failed to log in");
      render();
    }
  });

  root.querySelector("[data-cashflow-password-token-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      await apiClient.json("/api/auth/internal/password", {
        method: "POST",
        body: Object.fromEntries(formData),
        scoped: false
      });
      await loadUsers("Password set. You can log in now.");
    } catch (error) {
      state.error = error.message || t(null, "Failed to set internal login password");
      render();
    }
  });

  root.querySelector("[data-cashflow-internal-register-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      const result = await apiClient.json("/api/auth/internal/register", {
        method: "POST",
        body: Object.fromEntries(formData),
        scoped: false
      });
      state.csrfToken = String(result?.csrfToken || "");
      state.selectedAccountId = String(result?.session?.accountId || "").trim();
      state.selectedUserId = String(result?.session?.budgetId || "").trim();
      state.accountSession = result?.session || null;
      state.budgets = Array.isArray(result?.budgets) ? result.budgets : [];
      if (state.selectedAccountId) localStorage.setItem("cashflow_account_id", state.selectedAccountId);
      refreshUiPreferences({ useDefaultTab: true });
      if (state.selectedUserId) {
        localStorage.setItem("cashflow_budget_id", state.selectedUserId);
        localStorage.setItem("cashflow_user_id", state.selectedUserId);
        await loadCashflow("Account registered");
      } else {
        render();
      }
    } catch (error) {
      state.error = error.message || t(null, "Failed to register account");
      render();
    }
  });

  root.querySelectorAll("[data-cashflow-select-account]").forEach(button => {
    button.addEventListener("click", async () => {
      const accountId = button.getAttribute("data-cashflow-select-account");
      if (!accountId) return;

      try {
        const result = await apiClient.json("/api/session/select-account", {
          method: "POST",
          body: { accountId },
          scoped: false
        });
        state.csrfToken = String(result?.csrfToken || "");
        state.selectedAccountId = String(result?.session?.accountId || accountId).trim();
        state.accountSession = result?.session || null;
        state.budgets = Array.isArray(result?.budgets) ? result.budgets : [];
        state.selectedUserId = "";
        localStorage.setItem("cashflow_account_id", state.selectedAccountId);
        localStorage.removeItem("cashflow_budget_id");
        refreshUiPreferences({ useDefaultTab: true });
        render();
      } catch (error) {
        state.error = error.message || t(null, "Failed to select account");
        render();
      }
    });
  });

  root.querySelectorAll("[data-cashflow-select-user]").forEach(button => {
    button.addEventListener("click", async () => {
      const userId = button.getAttribute("data-cashflow-select-user");
      if (!userId) return;

      try {
        const result = await apiClient.json("/api/session/select", {
          method: "POST",
          body: { userId },
          scoped: false
        });
        const session = result?.session || {};
        state.csrfToken = String(result?.csrfToken || "");
        state.selectedAccountId = String(session.accountId || "").trim();
        state.selectedUserId = String(session.budgetId || session.userId || userId).trim();
        state.accountSession = session;
        if (state.selectedAccountId) localStorage.setItem("cashflow_account_id", state.selectedAccountId);
        localStorage.setItem("cashflow_budget_id", state.selectedUserId);
        localStorage.setItem("cashflow_user_id", state.selectedUserId);
        refreshUiPreferences({ useDefaultTab: true });
        await loadCashflow();
      } catch (error) {
        state.error = error.message || t(null, "Failed to select user");
        render();
      }
    });
  });

  root.querySelector("[data-cashflow-create-account-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      const result = await apiClient.json("/api/accounts", {
        method: "POST",
        body: Object.fromEntries(formData),
        scoped: false
      });
      state.csrfToken = String(result?.csrfToken || "");
      state.selectedAccountId = String(result?.session?.accountId || formData.get("userId") || "").trim();
      state.accountSession = result?.session || null;
      state.budgets = Array.isArray(result?.budgets) ? result.budgets : [];
      localStorage.setItem("cashflow_account_id", state.selectedAccountId);
      refreshUiPreferences({ useDefaultTab: true });
      render();
    } catch (error) {
      state.error = error.message || t(null, "Failed to create account");
      render();
    }
  });

  root.querySelectorAll("[data-cashflow-select-budget]").forEach(button => {
    button.addEventListener("click", async () => {
      const budgetId = button.getAttribute("data-cashflow-select-budget");
      if (!budgetId) return;

      try {
        const result = await apiClient.json(`/api/budgets/${encodeURIComponent(budgetId)}/select`, {
          method: "POST",
          body: {},
          scoped: false
        });
        state.selectedUserId = budgetId;
        state.accountSession = result?.session || state.accountSession;
        localStorage.setItem("cashflow_budget_id", budgetId);
        localStorage.setItem("cashflow_user_id", budgetId);
        await loadCashflow();
      } catch (error) {
        state.error = error.message || t(null, "Failed to select budget");
        render();
      }
    });
  });

  root.querySelector("[data-cashflow-create-budget-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      const created = await apiClient.json("/api/budgets", {
        method: "POST",
        body: Object.fromEntries(formData),
        scoped: false
      });
      const budgetId = created?.budget?.id || "";
      if (budgetId) {
        await apiClient.json(`/api/budgets/${encodeURIComponent(budgetId)}/select`, {
          method: "POST",
          body: {},
          scoped: false
        });
        state.selectedUserId = budgetId;
        localStorage.setItem("cashflow_budget_id", budgetId);
        localStorage.setItem("cashflow_user_id", budgetId);
        await loadCashflow();
      } else {
        await loadBudgets("Budget created");
      }
    } catch (error) {
      state.error = error.message || t(null, "Failed to create budget");
      render();
    }
  });

  root.querySelector("[data-cashflow-accept-invitation-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      await apiClient.json("/api/invitations/accept", {
        method: "POST",
        body: Object.fromEntries(formData),
        scoped: false
      });
      await loadBudgets("Invitation accepted");
    } catch (error) {
      state.error = error.message || t(null, "Failed to accept invitation");
      render();
    }
  });

  root.querySelector("[data-cashflow-setup-form]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const payload = Object.fromEntries(formData);
    payload.future_periods = Number(payload.future_periods || 11);
    payload.income_anchor_day = Number(payload.income_anchor_day || 1);
    payload.income_enabled = form.querySelector("input[name='income_enabled']")?.checked ? 1 : 0;

    try {
      state.cashflow = await apiClient.json("/api/setup", {
        method: "POST",
        body: payload
      });
      const locale = localeOf(state.cashflow);
      await loadLocale(locale);
      document.documentElement.lang = locale;
      enforceActiveTabPermissions();
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

window.addEventListener("cashflow-budget-manager-refresh", async () => {
  try {
    await loadBudgetManagerData();
    await loadCashflow();
  } catch (error) {
    state.error = error.message || t(null, "Failed to refresh budget manager");
    render();
  }
});

window.addEventListener("cashflow-budget-invitation-created", async (event) => {
  try {
    state.budgetManager.lastInvitation = event.detail?.invitation || null;
    await loadBudgetManagerData({ preserveInvitation: true });
    render();
  } catch (error) {
    state.error = error.message || t(null, "Failed to refresh budget manager");
    render();
  }
});

window.addEventListener("cashflow-budget-selected", async (event) => {
  const budgetId = event.detail?.budgetId || "";
  if (!budgetId) return;
  state.selectedUserId = budgetId;
  state.accountSession = event.detail?.session || state.accountSession;
  localStorage.setItem("cashflow_budget_id", budgetId);
  localStorage.setItem("cashflow_user_id", budgetId);
  await loadCashflow("Budget selected");
});

window.addEventListener("cashflow-budget-selection-cleared", async () => {
  state.selectedUserId = "";
  state.cashflow = null;
  localStorage.removeItem("cashflow_budget_id");
  localStorage.removeItem("cashflow_user_id");
  await loadBudgets("Budget selection cleared");
});

window.addEventListener("cashflow-saved", () => {
  state.message = t(null, "Saved");
});

window.addEventListener("cashflow-error", (event) => {
  state.error = event.detail?.message || t(null, "Cashflow request failed");
  state.validationResult = null;
  render();
});

window.addEventListener("cashflow-error-dismiss", () => {
  state.error = "";
  render();
});

window.addEventListener("cashflow-ui-preferences-change", (event) => {
  state.uiPreferences = saveUiPreferences(uiPreferenceScope(), normalizeUiPreferences({
    ...state.uiPreferences,
    ...(event.detail || {})
  }));
  applyUiPreferences(state.uiPreferences);
});

window.addEventListener("cashflow-language-change", async (event) => {
  const locale = String(event.detail?.locale || "").trim();
  if (!locale) return;

  try {
    await apiClient.json("/api/settings", {
      method: "PUT",
      body: { locale }
    });
    await loadCashflow("Settings saved");
  } catch (error) {
    state.error = error.message || t(null, "Failed to save settings");
    render();
  }
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
    await apiClient.json("/api/settings", {
      method: "PUT",
      body: event.detail || {}
    });
    await loadCashflow("Settings saved");
  } catch (error) {
    state.error = error.message || t(null, "Failed to save settings");
    render();
  }
});

window.addEventListener("cashflow-admin-options-update", async (event) => {
  try {
    await apiClient.json("/api/admin/options", {
      method: "PUT",
      body: event.detail || {}
    });
    await loadCashflow("Global options saved");
  } catch (error) {
    state.error = error.message || t(null, "Failed to save admin options");
    render();
  }
});

window.addEventListener("cashflow-logout", async () => {
  try {
    await apiClient.json("/api/logout", {
      method: "POST",
      body: {}
    });
  } catch {
    // Logout is local for now; future auth can make this endpoint stateful.
  }

  clearSelectedUserState();
  await loadLocale("en");
  document.documentElement.lang = "en";
  await loadUsers();
});

if (selectedUserId()) {
  void resumeSelectedUser();
} else if (state.selectedAccountId) {
  void resumeSelectedAccount();
} else {
  void loadUsers();
}
