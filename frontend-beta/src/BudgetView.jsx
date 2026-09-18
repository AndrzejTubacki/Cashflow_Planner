import { useEffect, useState } from "react";
import { apiFetch, downloadFile } from "./api.js";

const ROLE_OPTIONS = ["manager", "editor", "viewer"];

function canManage(role) {
  return role === "owner" || role === "manager";
}

function canOwn(role) {
  return role === "owner";
}

function BudgetRow({ budget, isCurrent, onSwitch, onRename, onArchive, onRestore, onPurge, busy }) {
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
          {budget.id} &middot; {budget.role || "viewer"} &middot; {budget.status}
        </span>
      </div>
      <div className="beta-budget-row-actions">
        {dirty ? (
          <button type="button" className="beta-btn-small" disabled={busy} onClick={() => onRename(budget.id, name)}>
            Rename
          </button>
        ) : null}
        <button
          type="button"
          className="beta-btn-small"
          disabled={busy}
          onClick={() => downloadFile(`/api/budgets/${encodeURIComponent(budget.id)}/export`, `cashflow-${budget.id}-full-export.json`)}
        >
          Export
        </button>
        {isCurrent ? (
          <span className="beta-pill beta-pill-accent">Current</span>
        ) : isActive ? (
          <button type="button" className="beta-btn-small" disabled={busy} onClick={() => onSwitch(budget.id)}>
            Switch
          </button>
        ) : null}
        {canOwn(budget.role) && isActive ? (
          <button type="button" className="beta-btn-small" disabled={busy} onClick={() => onArchive(budget.id)}>
            Archive
          </button>
        ) : null}
        {canOwn(budget.role) && isArchived ? (
          <button type="button" className="beta-btn-small" disabled={busy} onClick={() => onRestore(budget.id)}>
            Restore
          </button>
        ) : null}
        {canOwn(budget.role) && isArchived ? (
          <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={() => onPurge(budget.id)}>
            Purge
          </button>
        ) : null}
      </div>
    </div>
  );
}

function MembersPanel({ budgetId, currentAccountId, currentRole, onChanged }) {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const result = await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/members`);
      setMembers(result.members || []);
    } catch (err) {
      setError(err.message || "Failed to load members");
    }
  }

  useEffect(() => { load(); }, [budgetId]);

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
      setError(err.message || "Failed to update member");
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(accountId) {
    if (!window.confirm("Remove this member from the budget?")) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/members/${encodeURIComponent(accountId)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message || "Failed to remove member");
    } finally {
      setBusy(false);
    }
  }

  async function transferOwnership(accountId) {
    if (!window.confirm("Transfer ownership to this member? You will become a manager.")) return;
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
      setError(err.message || "Failed to transfer ownership");
    } finally {
      setBusy(false);
    }
  }

  if (!canManage(currentRole)) return null;

  return (
    <div className="beta-panel">
      <h3>Members</h3>
      {error ? <div className="beta-error">{error}</div> : null}
      {members === null ? (
        <p className="beta-empty">{error ? "Couldn't load members." : "Loading..."}</p>
      ) : members.length ? (
        <div className="beta-panel-table">
          <table>
            <thead>
              <tr><th>Account</th><th>Role</th><th>Status</th><th></th></tr>
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
                      {isOwner ? "owner" : (
                        <select
                          value={role}
                          disabled={!editable || busy}
                          onChange={e => updateRole(accountId, e.target.value)}
                        >
                          {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      )}
                    </td>
                    <td>{member.status || "active"}</td>
                    <td className="beta-row-actions">
                      {!isOwner && editable ? (
                        <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={() => removeMember(accountId)}>
                          Remove
                        </button>
                      ) : null}
                      {currentRole === "owner" && !isSelf && !isOwner ? (
                        <button type="button" className="beta-btn-small" disabled={busy} onClick={() => transferOwnership(accountId)}>
                          Transfer ownership
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <p className="beta-empty">No members yet.</p>}
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

  async function load() {
    try {
      const [invResult, accResult] = await Promise.all([
        apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/invitations`),
        apiFetch("/api/accounts").catch(() => ({ accounts: [] }))
      ]);
      setInvitations(invResult.invitations || []);
      setAccounts(accResult.accounts || []);
    } catch (err) {
      setError(err.message || "Failed to load invitations");
    }
  }

  useEffect(() => { load(); }, [budgetId]);

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
      setError(err.message || "Failed to create invitation");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(invitationId) {
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/invitations/${encodeURIComponent(invitationId)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err.message || "Failed to revoke invitation");
    } finally {
      setBusy(false);
    }
  }

  if (!canManage(currentRole)) return null;

  return (
    <div className="beta-panel">
      <h3>Invitations</h3>
      {error ? <div className="beta-error">{error}</div> : null}
      {lastToken ? (
        <label className="beta-field">
          <span>Invitation token</span>
          <input readOnly value={lastToken} onFocus={e => e.target.select()} />
        </label>
      ) : null}

      <form className="beta-form-grid" onSubmit={handleCreate}>
        <label className="beta-field">
          <span>Account</span>
          <select value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">Invite by email</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.display_name || a.id} ({a.id})</option>)}
          </select>
        </label>
        <label className="beta-field">
          <span>Email</span>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} />
        </label>
        <label className="beta-field">
          <span>Role</span>
          <select value={role} onChange={e => setRole(e.target.value)}>
            {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <label className="beta-field">
          <span>Expires in hours</span>
          <input type="number" min="1" max="720" value={expiresInHours} onChange={e => setExpiresInHours(e.target.value)} />
        </label>
        <div className="beta-form-actions beta-form-actions-start">
          <button type="submit" className="beta-btn-primary" disabled={busy}>Create invitation</button>
        </div>
      </form>

      <div className="beta-budget-list">
        {invitations === null ? (
          <p className="beta-empty">{error ? "Couldn't load invitations." : "Loading..."}</p>
        ) : invitations.length ? invitations.map(invitation => (
          <div className="beta-budget-row" key={invitation.id}>
            <div className="beta-budget-row-main">
              <strong>{invitation.target_account_id || invitation.target_email || "Invitation"}</strong>
              <span className="beta-budget-meta">
                {invitation.role || "viewer"} &middot; {invitation.status} &middot; {invitation.expires_at || ""}
              </span>
            </div>
            <div className="beta-budget-row-actions">
              {invitation.status === "pending" ? (
                <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={() => revoke(invitation.id)}>
                  Revoke
                </button>
              ) : null}
            </div>
          </div>
        )) : <p className="beta-empty">No invitations.</p>}
      </div>
    </div>
  );
}

export default function BudgetView({ snapshot, onRefresh }) {
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
      setLoadError(err.message || "Failed to load budgets");
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
      setActionError(err.message || "Failed to switch budget");
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
      setActionError(err.message || "Failed to rename budget");
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate(event) {
    event.preventDefault();
    setCreating(true);
    setActionError("");
    try {
      await apiFetch("/api/budgets", { method: "POST", body: { displayName: newName.trim() || "New budget" } });
      setNewName("");
      await loadBudgets();
    } catch (err) {
      setActionError(err.message || "Failed to create budget");
    } finally {
      setCreating(false);
    }
  }

  async function handleArchive(budgetId) {
    if (!window.confirm("Archive this budget? It can be restored later.")) return;
    setBusy(true);
    setActionError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}/archive`, { method: "POST" });
      await loadBudgets();
    } catch (err) {
      setActionError(err.message || "Failed to archive budget");
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
      setActionError(err.message || "Failed to restore budget");
    } finally {
      setBusy(false);
    }
  }

  async function handlePurge(budgetId) {
    if (!window.confirm("Permanently delete this archived budget? This cannot be undone.")) return;
    setBusy(true);
    setActionError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(budgetId)}`, { method: "DELETE" });
      await loadBudgets();
    } catch (err) {
      setActionError(err.message || "Failed to purge budget");
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave() {
    if (!window.confirm("Leave this budget? You will lose access unless invited again.")) return;
    setBusy(true);
    setActionError("");
    try {
      await apiFetch(`/api/budgets/${encodeURIComponent(currentBudgetId)}/leave`, { method: "POST" });
      await onRefresh();
      await loadBudgets();
    } catch (err) {
      setActionError(err.message || "Failed to leave budget");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>Budget</h1>
        <p>Switch between budgets you have access to, or start a new one.</p>
      </div>

      {actionError ? <div className="beta-error">{actionError}</div> : null}
      {loadError ? (
        <div className="beta-error">
          {loadError}. Try reloading the page — if that doesn&rsquo;t help, open the{" "}
          <a href="/">legacy app</a> once to refresh your session, then come back.
        </div>
      ) : null}

      <form className="beta-panel beta-inline-form" onSubmit={handleCreate}>
        <div className="beta-form-grid">
          <label className="beta-field">
            <span>New budget name</span>
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Household 2026"
            />
          </label>
        </div>
        <div className="beta-form-actions">
          <button type="submit" className="beta-btn-primary" disabled={creating}>
            {creating ? "Creating..." : "Create budget"}
          </button>
        </div>
      </form>

      <div className="beta-panel">
        <h3>Your budgets</h3>
        {budgets === null ? (
          <p className="beta-empty">{loadError ? "Couldn't load your budgets." : "Loading..."}</p>
        ) : budgets.length ? (
          <div className="beta-budget-list">
            {budgets.map(budget => (
              <BudgetRow
                key={budget.id}
                budget={budget}
                isCurrent={budget.id === currentBudgetId}
                onSwitch={handleSwitch}
                onRename={handleRename}
                onArchive={handleArchive}
                onRestore={handleRestore}
                onPurge={handlePurge}
                busy={busy}
              />
            ))}
          </div>
        ) : (
          <p className="beta-empty">No budgets yet.</p>
        )}
      </div>

      <div className="beta-panel">
        <h3>Current budget</h3>
        <div className="beta-budget-row">
          <div className="beta-budget-row-main">
            <strong>{snapshot?.session?.displayName || currentBudgetId || "Budget"}</strong>
            <span className="beta-budget-meta">{currentBudgetId} &middot; {currentRole || "viewer"}</span>
          </div>
          <div className="beta-budget-row-actions">
            {currentRole && currentRole !== "owner" ? (
              <button type="button" className="beta-btn-small beta-btn-danger" disabled={busy} onClick={handleLeave}>
                Leave budget
              </button>
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
