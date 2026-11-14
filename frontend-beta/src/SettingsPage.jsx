import { useState } from "react";
import AccountView from "./AccountView.jsx";
import AdminView from "./AdminView.jsx";
import SettingsView from "./SettingsView.jsx";
import { t } from "./i18n.js";

export default function SettingsPage({ activeTab, canAdmin, snapshot, onRefresh, notice, onDismissNotice, validationResult, onValidation, onDismissValidation, onSelectTab }) {
  // A restore replaces the saved settings; remount so the form shows them.
  // Other refreshes keep the form, so unsaved edits survive them.
  const [restoreGeneration, setRestoreGeneration] = useState(0);
  const tabs = [
    { id: "account", label: "Account" },
    { id: "budget", label: "Budget" },
    ...(canAdmin ? [{ id: "admin", label: "Admin" }] : [])
  ];
  const tab = tabs.some(option => option.id === activeTab) ? activeTab : "account";

  return (
    <section className="beta-settings-page">
      <div className="beta-view beta-settings-heading">
        <div className="beta-view-head">
          <h1>{t("Settings")}</h1>
          <p>{t("Manage your account, this budget, and instance-wide options in one place.")}</p>
        </div>
        <div className="beta-settings-tabs" role="tablist" aria-label={t("Settings sections")}>
          {tabs.map(option => (
            <button key={option.id} type="button" role="tab" aria-selected={tab === option.id}
              className={tab === option.id ? "is-active" : ""} onClick={() => onSelectTab(option.id)}>
              {t(option.label)}
            </button>
          ))}
        </div>
      </div>
      {tab === "account" ? (
        <AccountView embedded onRefresh={onRefresh} notice={notice} onDismissNotice={onDismissNotice} />
      ) : tab === "admin" && canAdmin ? (
        <AdminView embedded snapshot={snapshot} onRefresh={onRefresh} />
      ) : (
        <SettingsView key={`${snapshot?.session?.budgetId || ""}:${restoreGeneration}`} embedded snapshot={snapshot} onRefresh={onRefresh}
          onRestored={() => setRestoreGeneration(generation => generation + 1)} validationResult={validationResult}
          onValidation={onValidation} onDismissValidation={onDismissValidation} />
      )}
    </section>
  );
}
