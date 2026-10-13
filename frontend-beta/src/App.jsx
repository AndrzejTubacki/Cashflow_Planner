import { useCallback, useEffect, useState, useRef } from "react";
import Shell from "./Shell.jsx";
import LedgerView from "./LedgerView.jsx";
import RecurringView from "./RecurringView.jsx";
import OneOffView from "./OneOffView.jsx";
import PrioritiesView from "./PrioritiesView.jsx";
import TargetsView from "./TargetsView.jsx";
import BudgetView from "./BudgetView.jsx";
import SettingsView from "./SettingsView.jsx";
import AdminView from "./AdminView.jsx";
import AccountView from "./AccountView.jsx";
import { BudgetPickerView, SetupView, SignInView } from "./EntryViews.jsx";
import PlaceholderView from "./PlaceholderView.jsx";
import UserMenu from "./UserMenu.jsx";
import { NAV_SECTIONS } from "./NAV_SECTIONS.js";
import { apiFetch, fetchSession, fetchSnapshot, setCsrfToken } from "./api.js";
import { applyUiPreferences, currentPreferenceScope, loadUiPreferences } from "./uiPreferences.js";

function useHashSection() {
  const initial = window.location.hash.replace("#", "") || "ledger";
  const [section, setSection] = useState(
    NAV_SECTIONS.some(s => s.id === initial) ? initial : "ledger"
  );

  const select = useCallback(id => {
    setSection(id);
    window.location.hash = id;
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
  if (result === "linked") return { kind: "success", message: "Sign-in linked. You can use it on the sign-in page from now on." };
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
  const [errorMessage, setErrorMessage] = useState("");
  const [signInNotice, setSignInNotice] = useState("");
  const [pickingBudget, setPickingBudget] = useState(false);
  const [authNotice, setAuthNotice] = useState(() => takeAuthReturnNotice());
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
      const data = await fetchSnapshot();
      if (isCurrent()) {
        setSnapshot(data);
        setSignInNotice("");
        setStatus("app");
        localStorage.setItem("cashflow_preferred_ui", "beta");
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (err?.status === 401 || err?.status === 404) {
        clearStoredSelection();
        setSignInNotice("Your previous session has ended. Sign in again to continue.");
        setStatus("signin");
        return;
      }
      setErrorMessage(err.message || "Could not load your budget.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch("/api/logout", { method: "POST", scoped: false });
    } catch {
      window.alert("Couldn't confirm sign-out with the server. Close your browser to be safe.");
    }
    clearStoredSelection();
    localStorage.removeItem("cashflow_account_id");
    setSnapshot(null);
    setPickingBudget(false);
    setSignInNotice("");
    await load();
  }, [load]);

  const afterBudgetSelected = useCallback(async () => {
    setPickingBudget(false);
    await load();
  }, [load]);

  if (status === "loading") {
    return (
      <div className="beta-loading">
        <div className="beta-loading-mark" />
        <p>Starting the beta planner...</p>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="beta-loading">
        <div className="beta-error-card">
          <h2>Couldn&rsquo;t reach Cashflow</h2>
          <p>{errorMessage}</p>
          <button type="button" className="beta-btn-primary" onClick={() => { setStatus("loading"); load(); }}>Try again</button>
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
    || "This budget";
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
  const capabilities = snapshot?.session?.capabilities || [];
  const canMaintain = capabilities.includes("budget:maintain");
  const canValidate = capabilities.includes("budget:validate");
  const visibleSections = NAV_SECTIONS.filter(s => (!s.adminOnly || canAdmin) && !s.hideFromNav);

  return (
    <Shell
      activeSection={section}
      onSelectSection={selectSection}
      budgetLabel={budgetLabel}
      ledgerCurrency={settings.ledger_currency || "PLN"}
      sections={visibleSections}
    >
      <header className="beta-topbar">
        <span className="beta-topbar-title">{budgetLabel}</span>
        <div className="beta-topbar-spacer" />
        <UserMenu
          budgetLabel={budgetLabel}
          canAdmin={canAdmin}
          canMaintain={canMaintain}
          canValidate={canValidate}
          onSelectSection={selectSection}
          onRefresh={load}
          onSignOut={signOut}
        />
      </header>

      {section === "budget" ? (
        <BudgetView snapshot={snapshot} onRefresh={load} />
      ) : section === "admin" && canAdmin ? (
        <AdminView snapshot={snapshot} onRefresh={load} />
      ) : section === "admin" ? (
        <LedgerView snapshot={snapshot} onRefresh={load} />
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
      ) : section === "account" ? (
        <AccountView onRefresh={load} notice={authNotice} onDismissNotice={() => setAuthNotice(null)} />
      ) : section === "settings" ? (
        <SettingsView snapshot={snapshot} onRefresh={load} />
      ) : (
        <PlaceholderView label={NAV_SECTIONS.find(s => s.id === section)?.label || section} />
      )}
    </Shell>
  );
}
