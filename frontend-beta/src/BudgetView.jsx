import { formatParts, t } from "./i18n.js";
import { useEffect, useState } from "react";
import { apiFetch, downloadFile } from "./api.js";

const ROLE_OPTIONS = ["manager", "editor", "viewer"];

function canManage(role) {
  return role === "owner" || role === "manager";
}

function canOwn(role) {
  return role === "owner";
}

function BudgetRow({ budget, isCurrent, onSwitch, onRename, onExport, onArchive, onRestore, onPurge, busy }) {
  const [name, setName] = useState(budget.display_name || budget.id);
  const isActive = budget.status === "active";
  const isArchived = budget.status === "archived";
  const dirty = name !== (budget.display_name || budget.id);

  return (
    <div className="beta-budget-row">
      <div className="beta-budget-row-main">
        {canManage(budget.role) ? (
          <input
            className="beta-budget-name-input"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        ) : (
          <strong>{budget.display_name || budget.id}</strong>
        )}
        <span className="beta-budget-meta">
          {budget.id} &middot; {t(budget.role || "viewer")} &middot; {t(budget.status)}
        </span>
      </div>
      <div className="beta-budget-row-actions">
        {dirty ? (
          <button type="button" className="beta-btn-small" disabled={busy} onClick={() => onRename(budget.id, name)}>{t("Rename")}</button>
        ) : null}
        <button
          type="button"
          className="beta-btn-small"
          disabled={busy}
          onClick={() => onExport(budget.id)}
        >{t("Export")}</button>
        {isCurrent ? (
          <span className="beta-pill beta-pill-accent">{t("Current")}</span>
        ) : isActive ? (
          <button type="button" className="beta-btn-small" disabled={busy} onClick={() => onSwitch(budget.id)}>{t("Switch")}</button>
        ) : null}
        {canOwn(budget.role) && isActive ? (
          <button type="button" className="beta-btn-small" disabled={busy} onClick={() => onArchive(budget.id)}>{t("Archive")}</button>
        ) : null}
        {canOwn(budget.role) && isArchived ? (
          <button type="button" className="beta-btn-small" disabled={busy} onClick={() => onRestore(budget.id)}>{t("Restore")}</button>
        ) : null}
        {canOwn(budget.role) && isArchived ? (
          <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={() => onPurge(budget.id)}>{t("Purge")}</button>
        ) : null}
      </div>
    </div>
  );
}

function MembersPanel({ budgetId, currentAccountId, currentRole, onChanged }) {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [roleDrafts, setRoleDrafts] = useState({});

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const result = await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/members`);
        if (active) setMembers(result.members || []);
      } catch (err) {
        if (active) setError(err.message || t("Failed to load members"));
      }
    }
    load();
    return () => { active = false; };
  }, [budgetId]);

  // Keep a non-cancellable load for explicit refreshes
  async function load() {
    try {
      const result = await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/members`);
      setMembers(result.members || []);
    } catch (err) {
      setError(err.message || t("Failed to load members"));
    }
  }

  async function updateRole(accountId, role) {
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/members/${encodeURIComponent(accountId)}`, {
        method: "PUT",
        body: { role }
      });
      await load();
    } catch (err) {
      setError(err.message || t("Failed to update member"));
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(accountId) {
    if (!window.confirm(t("Remove this member from the budget?"))) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/members/${encodeURIComponent(accountId)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message || t("Failed to remove member"));
    } finally {
      setBusy(false);
    }
  }

  async function transferOwnership(accountId) {
    if (!window.confirm(t("Transfer ownership to this member? You will become a manager."))) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/transfer-ownership`, {
        method: "POST",
        body: { accountId }
      });
      await load();
      await onChanged();
    } catch (err) {
      setError(err.message || t("Failed to transfer ownership"));
    } finally {
      setBusy(false);
    }
  }

  if (!canManage(currentRole)) return null;

  return (
    <div className="beta-panel">
      <h3>{t("Members")}</h3>
      {error ? <div className="beta-error beta-dismissible">{error}<button type="button" onClick={() => setError("")} aria-label={t("Dismiss error")}>&times;</button></div> : null}
      {members === null ? (
        <p className="beta-empty">{error ? t("Couldn't load members.") : t("Loading...")}</p>
      ) : members.length ? (
        <div className="beta-panel-table">
          <table>
            <thead>
              <tr><th>{t("Account")}</th><th>{t("Role")}</th><th>{t("Status")}</th><th></th></tr>
            </thead>
            <tbody>
              {members.map(member => {
                const accountId = member.account_id || member.accountId || member.id;
                const role = member.role || "viewer";
                const isSelf = accountId === currentAccountId;
                const isOwner = role === "owner";
                const editable = !isOwner && (currentRole === "owner" || role !== "owner");
                return (
                  <tr key={accountId}>
                    <td>
                      <div className="beta-tx-name">{member.display_name || accountId}</div>
                      <span className="beta-budget-meta">{accountId}</span>
                    </td>
                    <td>
                      {isOwner ? t("Owner") : (
                        <select
                          value={roleDrafts[accountId] ?? role}
                          disabled={!editable || busy}
                          onChange={e => setRoleDrafts(current => ({ ...current, [accountId]: e.target.value }))}
                        >
                          {ROLE_OPTIONS.map(r => <option key={r} value={r}>{t(r)}</option>)}
                        </select>
                      )}
                    </td>
                    <td>{t(member.status || "active")}</td>
                    <td className="beta-row-actions">
                      {!isOwner && editable && roleDrafts[accountId] && roleDrafts[accountId] !== role ? (
                        <button type="button" className="beta-btn-small" disabled={busy} onClick={() => updateRole(accountId, roleDrafts[accountId])}>{t("Save role")}</button>
                      ) : null}
                      {!isOwner && editable ? (
                        <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={() => removeMember(accountId)}>{t("Remove")}</button>
                      ) : null}
                      {currentRole === "owner" && !isSelf && !isOwner ? (
                        <button type="button" className="beta-btn-small" disabled={busy} onClick={() => transferOwnership(accountId)}>{t("Transfer ownership")}</button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="beta-empty">{t("No members yet.")}</p>}
    </div>
  );
}

function InvitationsPanel({ budgetId, currentRole }) {
  const [invitations, setInvitations] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastToken, setLastToken] = useState("");
  const [accountId, setAccountId] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [expiresInHours, setExpiresInHours] = useState(168);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [invResult, accResult] = await Promise.all([
          apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/invitations`),
          apiFetch("/api/accounts").catch(() => ({ accounts: [] }))
        ]);
        if (active) {
          setInvitations(invResult.invitations || []);
          setAccounts(accResult.accounts || []);
        }
      } catch (err) {
        if (active) setError(err.message || t("Failed to load invitations"));
      }
    }
    load();
    return () => { active = false; };
  }, [budgetId]);

  // Keep a non-cancellable load for explicit refreshes
  async function load() {
    try {
      const [invResult, accResult] = await Promise.all([
        apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/invitations`),
        apiFetch("/api/accounts").catch(() => ({ accounts: [] }))
      ]);
      setInvitations(invResult.invitations || []);
      setAccounts(accResult.accounts || []);
    } catch (err) {
      setError(err.message || t("Failed to load invitations"));
    }
  }

  async function handleCreate(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/invitations`, {
        method: "POST",
        body: {
          accountId: accountId || undefined,
          email: email || undefined,
          role,
          expiresInHours: Number(expiresInHours) || 168
        }
      });
      setLastToken(result.invitation?.token || "");
      setEmail("");
      setAccountId("");
      await load();
    } catch (err) {
      setError(err.message || t("Failed to create invitation"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(invitationId) {
    if (!window.confirm(t("Revoke this invitation? The token will stop working immediately."))) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message || t("Failed to revoke invitation"));
    } finally {
      setBusy(false);
    }
  }

  if (!canManage(currentRole)) return null;

  return (
    <div className="beta-panel">
      <h3>{t("Invitations")}</h3>
      {error ? <div className="beta-error beta-dismissible">{error}<button type="button" onClick={() => setError("")} aria-label={t("Dismiss error")}>&times;</button></div> : null}
      {lastToken ? (
        <div className="beta-token-result">
          <label className="beta-field">
            <span>{t("Invitation token")}</span>
            <input readOnly value={lastToken} onFocus={e => e.target.select()} />
          </label>
          <button type="button" className="beta-btn-small" onClick={() => setLastToken("")}>{t("Dismiss")}</button>
        </div>
      ) : null}

      <form className="beta-form-grid" onSubmit={handleCreate}>
        <label className="beta-field">
          <span>{t("Account")}</span>
          <select value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">{t("Invite by email")}</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.display_name || a.id} ({a.id})</option>)}
          </select>
        </label>
        <label className="beta-field">
          <span>{t("Email")}</span>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} />
        </label>
        <label className="beta-field">
          <span>{t("Role")}</span>
          <select value={role} onChange={e => setRole(e.target.value)}>
            {ROLE_OPTIONS.map(r => <option key={r} value={r}>{t(r)}</option>)}
          </select>
        </label>
        <label className="beta-field">
          <span>{t("Expires in hours")}</span>
          <input type="number" min="1" max="720" value={expiresInHours} onChange={e => setExpiresInHours(e.target.value)} />
        </label>
        <div className="beta-form-actions beta-form-actions-start">
          <button type="submit" className="beta-btn-primary" disabled={busy}>{t("Create invitation")}</button>
        </div>
      </form>

      <div className="beta-budget-list">
        {invitations === null ? (
          <p className="beta-empty">{error ? t("Couldn't load invitations.") : t("Loading...")}</p>
        ) : invitations.length ? invitations.map(invitation => (
          <div className="beta-budget-row" key={invitation.id}>
            <div className="beta-budget-row-main">
              <strong>{invitation.target_account_id || invitation.target_email || t("Invitation")}</strong>
              <span className="beta-budget-meta">
                {t(invitation.role || "viewer")} &middot; {t(invitation.status)} &middot; {invitation.expires_at || ""}
              </span>
            </div>
            <div className="beta-budget-row-actions">
              {invitation.status === "pending" ? (
                <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={() => revoke(invitation.id)}>{t("Revoke")}</button>
              ) : null}
            </div>
          </div>
        )) : <p className="beta-empty">{t("No invitations.")}</p>}
      </div>
    </div>
  );
}

export default function BudgetView({ snapshot, onRefresh, onCurrentBudgetRemoved }) {
  const [budgets, setBudgets] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const currentBudgetId = snapshot?.session?.budgetId || snapshot?.session?.userId || "";
  const currentAccountId = snapshot?.session?.accountId || "";
  const currentRole = snapshot?.session?.budgetRole
    || (budgets || []).find(b => b.id === currentBudgetId)?.role
    || "";

  async function loadBudgets() {
    try {
      const result = await apiFetch("/api/budgets");
      setBudgets(result.budgets || []);
      setLoadError("");
    } catch (err) {
      setLoadError(err.message || t("Failed to load budgets"));
    }
  }

  useEffect(() => {
    loadBudgets();
  }, []);

  async function handleSwitch(budgetId) {
    setBusy(true);
    setActionError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/select`, { method: "POST" });
      localStorage.setItem("cashflow_budget_id", budgetId);
      localStorage.setItem("cashflow_user_id", budgetId);
      await onRefresh();
      await loadBudgets();
    } catch (err) {
      setActionError(err.message || t("Failed to switch budget"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(budgetId, displayName) {
    setBusy(true);
    setActionError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}`, {
        method: "PUT",
        body: { displayName }
      });
      await loadBudgets();
      if (budgetId === currentBudgetId) await onRefresh();
    } catch (err) {
      setActionError(err.message || t("Failed to rename budget"));
    } finally {
      setBusy(false);
    }
  }

  async function handleExport(budgetId) {
    // Keep row actions coordinated by the parent so one busy/error state covers the whole list.
    setBusy(true);
    setActionError("");
    try {
      await downloadFile(
        `/api/budgets/${encodeURIComponent(budgetId)}/export`,
        `cashflow-${budgetId}-full-export.json`
      );
    } catch (err) {
      setActionError(formatMessage("Export failed: {error}", { error: err.message }));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(event) {
    event.preventDefault();
    setCreating(true);
    setActionError("");
    try {
      await apiFetch("/api/budgets", { method: "POST", body: { displayName: newName.trim() } });
      setNewName("");
      await loadBudgets();
    } catch (err) {
      setActionError(err.message || t("Failed to create budget"));
    } finally {
      setCreating(false);
    }
  }

  async function handleArchive(budgetId) {
    if (!window.confirm(t("Archive this budget? It can be restored later."))) return;
    setBusy(true);
    setActionError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/archive`, { method: "POST" });
      if (budgetId === currentBudgetId) {
        onCurrentBudgetRemoved();
        return;
      }
      await loadBudgets();
    } catch (err) {
      setActionError(err.message || t("Failed to archive budget"));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore(budgetId) {
    setBusy(true);
    setActionError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/restore`, { method: "POST" });
      await loadBudgets();
    } catch (err) {
      setActionError(err.message || t("Failed to restore budget"));
    } finally {
      setBusy(false);
    }
  }

  async function handlePurge(budgetId) {
    if (!window.confirm(t("Permanently delete this archived budget? This cannot be undone."))) return;
    setBusy(true);
    setActionError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}`, { method: "DELETE" });
      if (budgetId === currentBudgetId) {
        onCurrentBudgetRemoved();
        return;
      }
      await loadBudgets();
    } catch (err) {
      setActionError(err.message || t("Failed to purge budget"));
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave() {
    if (!window.confirm(t("Leave this budget? You will lose access unless invited again."))) return;
    setBusy(true);
    setActionError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(currentBudgetId)}/leave`, { method: "POST" });
      await onRefresh();
      await loadBudgets();
    } catch (err) {
      setActionError(err.message || t("Failed to leave budget"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>{t("Budget")}</h1>
        <p>{t("Switch between budgets you have access to, or start a new one.")}</p>
      </div>

      {actionError ? <div className="beta-error beta-dismissible">{actionError}<button type="button" onClick={() => setActionError("")} aria-label={t("Dismiss error")}>&times;</button></div> : null}
      {loadError ? (
        <div className="beta-error beta-dismissible">
          {formatParts("Couldn’t load budgets: {error}. Try reloading the page. If that doesn’t help, open the {legacyApp} once to refresh your session, then come back.", {
            error: loadError,
            legacyApp: <a href="/">{t("Legacy app")}</a>
          })}<button type="button" onClick={() => setLoadError("")} aria-label={t("Dismiss error")}>&times;</button></div>
      ) : null}

      <form className="beta-panel beta-inline-form" onSubmit={handleCreate}>
        <div className="beta-form-grid">
          <label className="beta-field">
            <span>{t("New budget name")}</span>
            <input
              type="text"
              required
              maxLength={120}
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder={t("Household 2026")}
            />
          </label>
        </div>
        <div className="beta-form-actions">
          <button type="submit" className="beta-btn-primary" disabled={creating}>
            {creating ? t("Creating...") : t("Create budget")}
          </button>
        </div>
      </form>

      <div className="beta-panel">
        <h3>{t("Your budgets")}</h3>
        {budgets === null ? (
          <p className="beta-empty">{loadError ? t("Couldn't load your budgets.") : t("Loading...")}</p>
        ) : budgets.length ? (
          <div className="beta-budget-list">
            {budgets.map(budget => (
              <BudgetRow
                key={budget.id}
                budget={budget}
                isCurrent={budget.id === currentBudgetId}
                onSwitch={handleSwitch}
                onRename={handleRename}
                onExport={handleExport}
                onArchive={handleArchive}
                onRestore={handleRestore}
                onPurge={handlePurge}
                busy={busy}
              />
            ))}
          </div>
        ) : (
          <p className="beta-empty">{t("No budgets yet.")}</p>
        )}
      </div>

      <div className="beta-panel">
        <h3>{t("Current budget")}</h3>
        <div className="beta-budget-row">
          <div className="beta-budget-row-main">
            <strong>{snapshot?.session?.displayName || currentBudgetId || t("Budget")}</strong>
            <span className="beta-budget-meta">{currentBudgetId} &middot; {t(currentRole || "viewer")}</span>
          </div>
          <div className="beta-budget-row-actions">
            {currentRole && currentRole !== "owner" ? (
              <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={handleLeave}>{t("Leave budget")}</button>
            ) : null}
          </div>
        </div>
      </div>

      {currentBudgetId ? (
        <MembersPanel
          budgetId={currentBudgetId}
          currentAccountId={currentAccountId}
          currentRole={currentRole}
          onChanged={onRefresh}
        />
      ) : null}
      {currentBudgetId ? (
        <InvitationsPanel budgetId={currentBudgetId} currentRole={currentRole} />
      ) : null}
    </section>
  );
}
