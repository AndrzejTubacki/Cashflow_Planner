import { useEffect, useState } from "react";
import { apiFetch } from "./api.js";
import { backupPermissions, stricterBackupPolicy, formatBackupSize, newestBackups, restoreSelectedBackup } from "./backups.js";
import { formatMessage, t } from "./i18n.js";

export default function BackupsPanel({ snapshot, draft, onChange, backend, onBackend, onRefresh, onRestored = () => {} }) {
  const permissions = backupPermissions(snapshot);
  const [backups, setBackups] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const limits = stricterBackupPolicy(snapshot?.backupPolicy, draft.retention);
  const visible = permissions.settings || permissions.create || permissions.restore;

  // Cancel stale reads when switching budgets or leaving Settings.
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setBusy("load");
    Promise.all([
      apiFetch("/api/system", { scoped: false }),
      permissions.restore ? apiFetch("/api/backups", { cache: "no-store" }) : Promise.resolve({ backups: [] })
    ]).then(([system, result]) => {
      if (!active) return;
      onBackend(system.databaseBackend);
      setBackups(newestBackups(result.backups));
    }).catch(err => {
      if (active) setError(err.message || t("Failed to load backups"));
    }).finally(() => { if (active) setBusy(""); });
    return () => { active = false; };
  }, [visible, permissions.restore, snapshot?.session?.budgetId, onBackend]);

  if (!visible) return null;

  function change(field, value) {
    onChange(previous => ({ ...previous, [field]: value }));
  }

  async function run(action, work) {
    setBusy(action);
    setError("");
    setMessage("");
    try { await work(); }
    catch (err) { setError(err.message || t("Backup operation failed")); }
    finally { setBusy(""); }
  }

  async function reload() {
    const system = await apiFetch("/api/system", { scoped: false });
    onBackend(system.databaseBackend);
    if (permissions.restore) setBackups(newestBackups((await apiFetch("/api/backups", { cache: "no-store" })).backups));
  }

  return <details className="beta-details" open>
    <summary>{t("Backups")}</summary>
    <div className="beta-settings-section">
      {error ? <div role="alert" className="beta-error">{error}</div> : null}
      {message ? <div role="status" className="beta-success">{message}</div> : null}
      {permissions.settings ? <>
        <p className="beta-hint">{t("Save backup preferences with the budget settings Save button.")}</p>
        <div className="beta-form-grid beta-form-grid-wide beta-form-grid-three">
          <label className="beta-field beta-field-checkbox">
            <input type="checkbox" checked={draft.enabled} onChange={e => change("enabled", e.target.checked)} />
            <span>{t("Automatic backups")}</span>
          </label>
          <label className="beta-field">
            <span>{t("Backup interval")}</span>
            <input type="number" required min="1" step="1" value={draft.interval} onChange={e => change("interval", e.target.value)} />
          </label>
          <label className="beta-field">
            <span>{t("Interval unit")}</span>
            <select value={draft.unit} onChange={e => change("unit", Number(e.target.value))}>
              <option value={1}>{t("Minutes")}</option>
              <option value={60}>{t("Hours")}</option>
              <option value={1440}>{t("Days")}</option>
            </select>
          </label>
          <label className="beta-field">
            <span>{t("Backup retention count")}</span>
            <input type="number" required min="1" step="1" value={draft.retention} onChange={e => change("retention", e.target.value)} />
          </label>
          {backend === "sqlite" ? <label className="beta-field">
            <span>{t("Backup location (optional)")}</span>
            <input type="text" value={draft.location} onChange={e => change("location", e.target.value)} />
            <small className="beta-hint">{t("Leave blank for the default location. Custom locations must be absolute paths under an operator-allowed backup root.")}</small>
          </label> : null}
        </div>
      </> : null}
      {limits.cap ? <p className="beta-hint">{formatMessage("The administrator limits this budget to {count} successful backups, below your retention count.", { count: limits.cap })}</p> : null}
      {limits.ageDays ? <p className="beta-hint">{formatMessage("The administrator removes successful backups older than {days} days even if your retention count is not reached. The newest backup and backups in use are kept.", { days: limits.ageDays })}</p> : null}
      {backend === "postgres" ? <p className="beta-hint">{t("PostgreSQL backups are stored in the database. Backup location does not apply, and retention follows the budget count and administrator limits.")}</p> : null}
      {backend === "sqlite" ? <p className="beta-hint">{t("SQLite backups are stored in server folders. Retention follows the budget count and administrator limits.")}</p> : null}
      <div className="beta-form-actions beta-form-actions-start">
        {permissions.create ? <button type="button" className="beta-btn-small" disabled={Boolean(busy)} onClick={() => run("create", async () => {
          await apiFetch("/api/backup", { method: "POST" });
          setMessage(t("Backup created."));
          await reload();
        })}>{busy === "create" ? t("Backing up...") : t("Back up now")}</button> : null}
        <button type="button" className="beta-btn-small" disabled={Boolean(busy)} onClick={() => run("load", reload)}>{busy === "load" ? t("Loading...") : t("Refresh backups")}</button>
      </div>
      {permissions.restore ? <>
        {!backups.length && !busy ? <p className="beta-hint">{t("No backups available.")}</p> : null}
        {backups.length ? <div className="beta-panel-table">
          <table>
            <thead>
              <tr><th>{t("Created")}</th><th>{t("Backup")}</th><th>{t("Size")}</th><th></th></tr>
            </thead>
            <tbody>
              {backups.map(backup => <tr key={backup.id}>
                <td><time dateTime={backup.createdAt}>{new Date(backup.createdAt).toLocaleString(snapshot?.settings?.locale || "en", { timeZone: snapshot?.settings?.timezone || "UTC" })}</time></td>
                <td><span className="beta-budget-meta">{backup.id}</span></td>
                <td>{formatBackupSize(backup.sizeBytes)}</td>
                <td>
                  <button type="button" className="beta-btn-small" disabled={Boolean(busy)} onClick={() => run("restore", async () => {
                    const restored = await restoreSelectedBackup(backup, { confirm: text => window.confirm(text), request: apiFetch, refresh: onRefresh });
                    if (restored) onRestored();
                  })}>{busy === "restore" ? t("Restoring...") : t("Restore backup")}</button>
                </td>
              </tr>)}
            </tbody>
          </table>
        </div> : null}
      </> : null}
    </div>
  </details>;
}
