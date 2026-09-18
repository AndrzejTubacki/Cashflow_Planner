import { useCallback, useEffect, useState } from "react";
import Shell from "./Shell.jsx";
import LedgerView from "./LedgerView.jsx";
import RecurringView from "./RecurringView.jsx";
import OneOffView from "./OneOffView.jsx";
import PrioritiesView from "./PrioritiesView.jsx";
import TargetsView from "./TargetsView.jsx";
import BudgetView from "./BudgetView.jsx";
import SettingsView from "./SettingsView.jsx";
import AdminView from "./AdminView.jsx";
import PlaceholderView from "./PlaceholderView.jsx";
import UserMenu from "./UserMenu.jsx";
import { NAV_SECTIONS } from "./NAV_SECTIONS.js";
import { fetchSession, fetchSnapshot, setCsrfToken } from "./api.js";
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

export default function App() {
  const [status, setStatus] = useState("loading");
  const [snapshot, setSnapshot] = useState(null);
  const [errorMessage, setErrorMessage] = useState("");
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

  const load = useCallback(async () => {
    try {
      const sessionResult = await fetchSession();
      if (sessionResult?.csrfToken) setCsrfToken(sessionResult.csrfToken);

      const data = await fetchSnapshot();
      setSnapshot(data);
      setStatus("ready");
      localStorage.setItem("cashflow_preferred_ui", "beta");
    } catch (err) {
      setErrorMessage(err.message || "Could not load your budget.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    load();
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
          <h2>Couldn&rsquo;t load your budget here</h2>
          <p>{errorMessage}</p>
          <p>
            Open the <a href="/">legacy app</a> first to sign in and pick a budget, then come back
            to <code>/beta</code>. Sessions are shared between both.
          </p>
        </div>
      </div>
    );
  }

  const settings = snapshot?.settings || {};
  const budgetLabel = snapshot?.session?.displayName
    || snapshot?.session?.accountDisplayName
    || snapshot?.session?.userId
    || "This budget";
  const setupRequired = Boolean(snapshot?.setup_required);
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
        />
      </header>

      {section === "budget" ? (
        <BudgetView snapshot={snapshot} onRefresh={load} />
      ) : section === "admin" && canAdmin ? (
        <AdminView snapshot={snapshot} onRefresh={load} />
      ) : section === "admin" ? (
        <LedgerView snapshot={snapshot} onRefresh={load} />
      ) : setupRequired ? (
        <section className="beta-view">
          <div className="beta-view-head">
            <h1>This budget needs first-time setup</h1>
            <p>Beta doesn&rsquo;t have the first-run setup form yet.</p>
          </div>
          <div className="beta-placeholder">
            <strong>Finish setup in the legacy app, or switch budgets</strong>
            Open the <a href="/">legacy app</a> to set an opening balance and finish setup for this
            budget, then come back &mdash; or use the <a href="#budget" onClick={() => selectSection("budget")}>Budget tab</a> to
            switch to one that&rsquo;s already set up.
          </div>
        </section>
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
      ) : section === "settings" ? (
        <SettingsView snapshot={snapshot} onRefresh={load} />
      ) : (
        <PlaceholderView label={NAV_SECTIONS.find(s => s.id === section)?.label || section} />
      )}
    </Shell>
  );
}
