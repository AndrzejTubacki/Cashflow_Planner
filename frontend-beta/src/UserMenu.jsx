import { useEffect, useRef, useState } from "react";
import { apiFetch } from "./api.js";
import {
  applyUiPreferences,
  currentPreferenceScope,
  loadUiPreferences,
  saveUiPreferences,
  UI_DENSITY_OPTIONS,
  UI_THEME_OPTIONS
} from "./uiPreferences.js";

function UserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="10" cy="7" r="3.2" />
      <path d="M3.5 16.5c1.2-3 3.8-4.5 6.5-4.5s5.3 1.5 6.5 4.5" />
    </svg>
  );
}

function describeValidation(result) {
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  if (!warnings.length) return "Validation passed. No warnings found.";
  const lines = [`Validation found ${warnings.length} warning${warnings.length === 1 ? "" : "s"}:`];
  warnings.slice(0, 8).forEach(w => lines.push(`• ${w?.message || w?.type || "Validation warning"}`));
  if (warnings.length > 8) lines.push(`…and ${warnings.length - 8} more`);
  return lines.join("\n");
}

export default function UserMenu({ budgetLabel, canAdmin, canMaintain, canValidate, onSelectSection, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const scope = currentPreferenceScope();
  const [prefs, setPrefs] = useState(() => loadUiPreferences(scope));
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function handleClick(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function updatePrefs(next) {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    applyUiPreferences(merged);
    saveUiPreferences(scope, merged);
  }

  function go(section) {
    setOpen(false);
    onSelectSection(section);
  }

  async function handleValidate() {
    setBusy(true);
    try {
      const result = await apiFetch("/api/validate", { method: "POST" });
      window.alert(describeValidation(result));
    } catch (err) {
      window.alert(err.message || "Validation failed");
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  async function handleRegenerate() {
    setBusy(true);
    try {
      await apiFetch("/api/run-jobs", { method: "POST" });
      await onRefresh();
      window.alert("Projections regenerated.");
    } catch (err) {
      window.alert(err.message || "Failed to regenerate projections");
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  function switchToLegacy() {
    localStorage.setItem("cashflow_preferred_ui", "legacy");
    window.location.href = "/";
  }

  async function handleLogout() {
    setBusy(true);
    try {
      await apiFetch("/api/logout", { method: "POST" });
    } catch {
      // Logging out is a best-effort call to clear the server session; proceed regardless.
    }
    localStorage.removeItem("cashflow_budget_id");
    localStorage.removeItem("cashflow_user_id");
    localStorage.removeItem("cashflow_preferred_ui");
    window.location.href = "/";
  }

  return (
    <div className="beta-user-menu" ref={menuRef}>
      <button
        type="button"
        className="beta-user-menu-trigger"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Account menu: ${budgetLabel}`}
        title={budgetLabel}
      >
        <UserIcon />
        <span className="beta-user-menu-label">{budgetLabel}</span>
      </button>

      {open ? (
        <div className="beta-user-menu-panel" role="menu">
          <div className="beta-user-menu-section">
            <label className="beta-field beta-field-inline">
              <span>Theme</span>
              <select value={prefs.theme} onChange={e => updatePrefs({ theme: e.target.value })}>
                {UI_THEME_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
            <label className="beta-field beta-field-inline">
              <span>Density</span>
              <select value={prefs.density} onChange={e => updatePrefs({ density: e.target.value })}>
                {UI_DENSITY_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>
          </div>

          <div className="beta-user-menu-section">
            <button type="button" role="menuitem" onClick={() => go("budget")}>Switch budget</button>
            <button type="button" role="menuitem" onClick={() => go("settings")}>Settings</button>
            {canAdmin ? <button type="button" role="menuitem" onClick={() => go("admin")}>Admin</button> : null}
          </div>

          {canValidate || canMaintain ? (
            <div className="beta-user-menu-section">
              {canValidate ? (
                <button type="button" role="menuitem" disabled={busy} onClick={handleValidate}>Validate data</button>
              ) : null}
              {canMaintain ? (
                <button type="button" role="menuitem" disabled={busy} onClick={handleRegenerate}>Regenerate projections</button>
              ) : null}
            </div>
          ) : null}

          <div className="beta-user-menu-section">
            <button type="button" role="menuitem" onClick={switchToLegacy}>Switch to legacy UI</button>
            <button type="button" role="menuitem" disabled={busy} onClick={handleLogout}>Logout</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
