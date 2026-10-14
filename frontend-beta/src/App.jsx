import { useCallback, useEffect, useState, useRef } from "react";
import Shell from "./Shell.jsx";
import LedgerView from "./LedgerView.jsx";
import RecurringView from "./RecurringView.jsx";
import OneOffView from "./OneOffView.jsx";
import PrioritiesView from "./PrioritiesView.jsx";
import TargetsView from "./TargetsView.jsx";
import BudgetView from "./BudgetView.jsx";
import SettingsPage from "./SettingsPage.jsx";
import { BudgetPickerView, SetupView, SignInView } from "./EntryViews.jsx";
import PlaceholderView from "./PlaceholderView.jsx";
import ProjectionWarnings from "./ProjectionWarnings.jsx";
import UserMenu from "./UserMenu.jsx";
import { NAV_SECTIONS } from "./NAV_SECTIONS.js";
import { apiFetch, fetchSession, fetchSnapshot, setCsrfToken } from "./api.js";
import { applyUiPreferences, currentPreferenceScope, loadUiPreferences } from "./uiPreferences.js";
import { setLocale, t } from "./i18n.js";
import { parseProjectionFxRates } from "./parity.js";

function normalizedSection(rawValue) {
  const raw = String(rawValue || "").replace(/^#/, "");
  if (raw === "account") return "settings/account";
  if (raw === "admin") return "settings/admin";
  if (raw === "settings") return "settings/account";
  if (["settings/account", "settings/budget", "settings/admin"].includes(raw)) return raw;
  return NAV_SECTIONS.some(section => section.id === raw) ? raw : "ledger";
}

function useHashSection() {
  const initial = window.location.hash || loadUiPreferences(currentPreferenceScope()).defaultTab;
  const [section, setSection] = useState(() => normalizedSection(initial));

  const select = useCallback(id => {
    const normalized = normalizedSection(id);
    setSection(normalized);
    window.location.hash = normalized;
  }, []);

  useEffect(() => {
    const onHashChange = () => setSection(normalizedSection(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return [section, select];
}

// Provider sign-in comes back as /beta/?cashflow_auth=linked or ?cashflow_auth_error=<reason>.
function takeAuthReturnNotice() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("cashflow_auth_error");
  const result = params.get("cashflow_auth");
  if (!error && !result) return null;
  params.delete("cashflow_auth_error");
  params.delete("cashflow_auth");
  const query = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  if (error) return { kind: "error", message: error };
  if (result === "linked") return { kind: "success", message: t("Sign-in linked. You can use it on the sign-in page from now on.") };
  return null;
}

function clearStoredSelection() {
  localStorage.removeItem("cashflow_budget_id");
  localStorage.removeItem("cashflow_user_id");
}

export default function App() {
  // loading -> signin | budgets | app; error only when the server can't be reached at all.
  const [status, setStatus] = useState("loading");
  const [auth, setAuth] = useState(null);
  const [session, setSession] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [ownAccount, setOwnAccount] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [signInNotice, setSignInNotice] = useState("");
  const [pickingBudget, setPickingBudget] = useState(false);
  const [authNotice, setAuthNotice] = useState(() => takeAuthReturnNotice());
  const [validationResult, setValidationResult] = useState(null);
  const [versionCheck, setVersionCheck] = useState({ status: "checking" });
  const [section, selectSection] = useHashSection();

  useEffect(() => {
    // base.css's dark/light tokens are gated on data-cashflow-theme (the
    // same attribute the legacy app sets via applyUiPreferences). Without
    // it, neither the light override nor the system-preference media query
    // ever matches, and the page is stuck on the bare :root defaults (dark)
    // regardless of the browser's actual color-scheme preference. Reads the
    // same localStorage keys as legacy, so a theme/density choice made in
    // either app carries over to the other.
    applyUiPreferences(loadUiPreferences(currentPreferenceScope()));
  }, []);

  const loadCounter = useRef(0);
  const load = useCallback(async () => {
    const currentRequestId = ++loadCounter.current;
    const isCurrent = () => currentRequestId === loadCounter.current;
    try {
      const authResult = await apiFetch("/api/auth/config", { cache: "no-store", scoped: false })
        .catch(() => ({ auth: { activeMode: "none" } }));
      const authConfig = authResult?.auth || { activeMode: "none" };
      if (isCurrent()) setAuth(authConfig);
      let sessionResult = await fetchSession();

      // Browsers that only ever used the budget header (no session cookie) get one
      // re-established for the budget they already had, instead of a sign-in screen.
      const storedBudget = localStorage.getItem("cashflow_budget_id") || localStorage.getItem("cashflow_user_id") || "";
      if (!sessionResult?.session?.authenticated && authConfig.activeMode === "none" && storedBudget) {
        const recovered = await apiFetch("/api/session/select", {
          method: "POST",
          body: { budgetId: storedBudget },
          scoped: false
        }).catch(() => null);
        if (!recovered) clearStoredSelection();
        sessionResult = await fetchSession();
      }

      if (currentRequestId === loadCounter.current && sessionResult?.csrfToken) {
        setCsrfToken(sessionResult.csrfToken);
      }
      if (!isCurrent()) return;
      const nextSession = sessionResult?.session || {};
      setSession(nextSession);
      if (nextSession.accountId) localStorage.setItem("cashflow_account_id", nextSession.accountId);
      applyUiPreferences(loadUiPreferences(nextSession.accountId || nextSession.budgetId || nextSession.userId || currentPreferenceScope()));

      if (!nextSession.authenticated) {
        clearStoredSelection();
        setStatus("signin");
        return;
      }

      const budgetId = String(nextSession.budgetId || nextSession.userId || "").trim();
      if (!budgetId) {
        clearStoredSelection();
        setStatus("budgets");
        return;
      }

      localStorage.setItem("cashflow_budget_id", budgetId);
      localStorage.setItem("cashflow_user_id", budgetId);
      const [data, accountResult] = await Promise.all([
        fetchSnapshot(),
        apiFetch("/api/account", { cache: "no-store", scoped: false })
      ]);
      if (isCurrent()) {
        setLocale(data?.settings?.locale);
        setSnapshot(data);
        setOwnAccount(accountResult?.account || null);
        setSignInNotice("");
        setStatus("app");
        localStorage.setItem("cashflow_preferred_ui", "beta");
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (err?.status === 401 || err?.status === 404) {
        clearStoredSelection();
        setSignInNotice(t("Your previous session has ended. Sign in again to continue."));
        setStatus("signin");
        return;
      }
      setErrorMessage(err.message || t("Could not load your budget."));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (session?.accountId && !window.location.hash) {
      selectSection(loadUiPreferences(session.accountId).defaultTab);
    }
  }, [session?.accountId, selectSection]);

  useEffect(() => {
    const installed = snapshot?.app?.version;
    const isAdmin = (snapshot?.session?.permissions || []).includes("admin");
    if (!installed || !isAdmin) return undefined;
    let active = true;
    fetch("https://api.github.com/repos/AndrzejTubacki/Cashflow_Planner/releases/latest", {
      cache: "no-store", headers: { accept: "application/vnd.github+json" }
    }).then(response => response.ok ? response.json() : Promise.reject(new Error("release check failed")))
      .then(release => {
        if (!active) return;
        const latest = String(release.tag_name || release.name || "").replace(/^v/i, "");
        const newer = latest.localeCompare(String(installed), undefined, { numeric: true }) > 0;
        setVersionCheck(newer ? { status: "available", latest, url: release.html_url } : { status: "current" });
      }).catch(() => { if (active) setVersionCheck({ status: "unavailable" }); });
    return () => { active = false; };
  }, [snapshot?.app?.version, snapshot?.session?.permissions]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/api/logout", { method: "POST", scoped: false });
    } catch {
      window.alert(t("Couldn't confirm sign-out with the server. Close your browser to be safe."));
    }
    clearStoredSelection();
    localStorage.removeItem("cashflow_account_id");
    setSnapshot(null);
    setOwnAccount(null);
    setPickingBudget(false);
    setSignInNotice("");
    await load();
  }, [load]);

  const afterBudgetSelected = useCallback(async () => {
    setPickingBudget(false);
    await load();
  }, [load]);

  const returnToBudgetPicker = useCallback(() => {
    clearStoredSelection();
    setSnapshot(null);
    setSession(current => current ? { ...current, budgetId: null, userId: null } : current);
    setPickingBudget(true);
  }, []);

  if (status === "loading") {
    return (
      <div className="beta-loading">
        <div className="beta-loading-mark" />
        <p>{t("Starting the beta planner...")}</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="beta-loading">
        <div className="beta-error-card">
          <h2>{t("Couldn't reach Cashflow")}</h2>
          <p>{errorMessage}</p>
          <button type="button" className="beta-btn-primary" onClick={() => { setStatus("loading"); load(); }}>{t("Try again")}</button>
        </div>
      </div>
    );
  }

  if (status === "signin") {
    return (
      <SignInView
        auth={auth}
        notice={authNotice?.kind === "error" ? authNotice.message : signInNotice}
        onSignedIn={async () => { setAuthNotice(null); await load(); }}
      />
    );
  }

  if (status === "budgets" || pickingBudget) {
    return (
      <BudgetPickerView
        session={session}
        authError={authNotice?.kind === "error" ? authNotice.message : ""}
        onSelected={async () => { setAuthNotice(null); await afterBudgetSelected(); }}
        onSignOut={signOut}
      />
    );
  }

  const settings = snapshot?.settings || {};
  const budgetLabel = snapshot?.session?.displayName
    || snapshot?.session?.accountDisplayName
    || snapshot?.session?.userId
    || t("This budget");
  const setupRequired = Boolean(snapshot?.setup_required);

  if (setupRequired) {
    return (
      <SetupView
        snapshot={snapshot}
        onDone={load}
        onSignOut={signOut}
        onSwitchBudget={() => setPickingBudget(true)}
      />
    );
  }

  const canAdmin = (snapshot?.session?.permissions || []).includes("admin");
  const visibleSections = NAV_SECTIONS.filter(s => (!s.adminOnly || canAdmin) && !s.hideFromNav);
  const settingsTab = section.startsWith("settings/") ? section.split("/")[1] : "account";
  const ledgerCurrency = String(settings.ledger_currency || "PLN").toUpperCase();
  let enabledFxCurrencies = [];
  try {
    const rawCurrencies = typeof settings.fx_used_currencies === "string" ? JSON.parse(settings.fx_used_currencies) : settings.fx_used_currencies;
    enabledFxCurrencies = Array.isArray(rawCurrencies) ? rawCurrencies.map(value => String(value).toUpperCase()).filter(value => value !== ledgerCurrency) : [];
  } catch { enabledFxCurrencies = []; }
  const topbarFxRates = parseProjectionFxRates(snapshot, ledgerCurrency).filter(({ pair }) => {
    const [from, to] = pair.split("/");
    return from !== to && to === ledgerCurrency && enabledFxCurrencies.includes(from);
  });

  return (
    <Shell
      activeSection={section.startsWith("settings/") ? "settings" : section}
      onSelectSection={selectSection}
      budgetLabel={budgetLabel}
      ledgerCurrency={ledgerCurrency}
      sections={visibleSections}
      installedVersion={snapshot?.app?.version}
      updateNotice={canAdmin && versionCheck.status === "available" ? versionCheck : null}
    >
      <header className="beta-topbar">
        <span className="beta-topbar-title">{budgetLabel}</span>
        {topbarFxRates.length ? <span className="beta-topbar-fx">{topbarFxRates.map(({ pair, rate }) => `${pair.split("/")[0]} ${rate.toFixed(4)}`).join(" · ")}</span> : null}
        <div className="beta-topbar-spacer" />
        <UserMenu
          account={ownAccount}
          onSelectSettings={() => selectSection("settings/account")}
          onSignOut={signOut}
        />
      </header>

      <ProjectionWarnings snapshot={snapshot} onRefresh={load} />
      {section === "budget" ? (
        <BudgetView snapshot={snapshot} onRefresh={load} onCurrentBudgetRemoved={returnToBudgetPicker} />
      ) : section === "ledger" ? (
        <LedgerView snapshot={snapshot} onRefresh={load} />
      ) : section === "recurring" ? (
        <RecurringView snapshot={snapshot} onRefresh={load} />
      ) : section === "oneoff" ? (
        <OneOffView snapshot={snapshot} onRefresh={load} />
      ) : section === "priorities" ? (
        <PrioritiesView snapshot={snapshot} onRefresh={load} />
      ) : section === "targets" ? (
        <TargetsView snapshot={snapshot} onRefresh={load} />
      ) : section.startsWith("settings/") ? (
        <SettingsPage activeTab={settingsTab} canAdmin={canAdmin} snapshot={snapshot} onRefresh={load}
          notice={authNotice} onDismissNotice={() => setAuthNotice(null)} validationResult={validationResult}
          onValidation={setValidationResult} onDismissValidation={() => setValidationResult(null)}
          onSelectTab={tab => selectSection(`settings/${tab}`)} />
      ) : (
        <PlaceholderView label={NAV_SECTIONS.find(s => s.id === section)?.label || section} />
      )}
    </Shell>
  );
}
