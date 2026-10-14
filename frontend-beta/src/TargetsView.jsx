import { formatMessage, t } from "./i18n.js";
import { useState } from "react";
import { formatMoney } from "./format.js";
import { apiFetch } from "./api.js";
import EditModal from "./EditModal.jsx";

function fundedFraction(row) {
  const target = Number(row.target_ledger_amount || 0);
  if (!target) return 0;
  const funded = Number(row.already_funded_ledger || 0)
    + Number(row.pending_allocated_ledger || 0)
    + Number(row.future_allocated_ledger || 0);
  return Math.min(1, funded / target);
}

function StatusPill({ row }) {
  const status = row.fx_missing
    ? "underfunded"
    : Number(row.remaining_ledger || 0) > 0 ? "partial" : "funded";
  return <span className={`beta-pill beta-pill-${status === "funded" ? "confirmed" : "pending"}`}>{t(status)}</span>;
}

function TargetTable({ rows, kind, adding, onStopAdding, onChanged, today, usedPriorities }) {
  const isGoal = kind === "goal";
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);

  async function remove(row) {
    if (!window.confirm(row.name ? formatMessage("Delete “{name}”?", { name: row.name }) : t("Delete this item?"))) return;
    setBusyId(row.id);
    setError("");
    try {
      const url = isGoal ? `/api/goals/${encodeURIComponent(row.id)}` : `/api/flex/${encodeURIComponent(row.id)}`;
      await apiFetch(url, { method: "DELETE" });
      await onChanged();
    } catch (err) {
      setError(err.message || t("Failed to delete"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="beta-panel-table">
      {error ? <div className="beta-error beta-dismissible">{error}<button type="button" onClick={() => setError("")} aria-label={t("Dismiss error")}>&times;</button></div> : null}
      <table>
        <thead>
          <tr>
            <th>{t("Name")}</th>
            <th className="beta-num">{t("Target")}</th>
            <th>{t("Progress")}</th>
            <th>{t("Status")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map(row => {
            const pct = Math.round(fundedFraction(row) * 100);
            const canDelete = Number(row.already_funded_ledger || 0) <= 0;
            return (
              <tr key={row.id}>
                <td>
                  <div className="beta-tx-name">{row.name || t("Unnamed")}</div>
                  {isGoal && row.due_date ? <span className="beta-pill beta-pill-muted">{t("Due")} {row.due_date}</span> : null}
                  {!isGoal && row.allow_split ? <span className="beta-pill beta-pill-muted">{t("Splittable")}</span> : null}
                </td>
                <td className="beta-num">{formatMoney(row.amount, row.currency)}</td>
                <td>
                  <div className="beta-progress">
                    <div className="beta-progress-bar" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="beta-progress-label">{pct}%</span>
                </td>
                <td><StatusPill row={row} /></td>
                <td className="beta-row-actions">
                  <button type="button" className="beta-btn-small" onClick={() => setEditing(row)}>{t("Edit")}</button>
                  <button
                    type="button"
                    className="beta-btn-small beta-btn-danger"
                    disabled={busyId === row.id || !canDelete}
                    title={canDelete ? "" : t("Fully funded goals/flex can't be deleted here")}
                    onClick={() => remove(row)}
                  >{t("Delete")}</button>
                </td>
              </tr>
            );
          }) : (
            <tr><td colSpan={5} className="beta-empty">{t("Nothing here yet.")}</td></tr>
          )}
        </tbody>
      </table>
      {editing ? (
        <EditModal
          entityType={isGoal ? "goal" : "flex"}
          item={editing}
          today={today}
          usedPriorities={usedPriorities}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await onChanged(); }}
        />
      ) : null}
      {adding ? (
        <EditModal
          entityType={isGoal ? "goal" : "flex"}
          today={today}
          usedPriorities={usedPriorities}
          onClose={onStopAdding}
          onSaved={async () => { onStopAdding(); await onChanged(); }}
        />
      ) : null}
    </div>
  );
}

export default function TargetsView({ snapshot, onRefresh }) {
  const [addingKind, setAddingKind] = useState(null);
  const goals = snapshot?.goals || [];
  const flex = snapshot?.flexTransactions || [];

  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>{t("Targets")}</h1>
        <p>{t("Goals and flex spending funded once recurring expenses and income are covered.")}</p>
      </div>

      <div className="beta-panel">
        <div className="beta-panel-head">
          <h3>{t("Goals")}</h3>
          <button type="button" className="beta-btn-small" onClick={() => setAddingKind("goal")}>{t("Add goal")}</button>
        </div>
        <TargetTable
          rows={goals}
          kind="goal"
          adding={addingKind === "goal"}
          onStopAdding={() => setAddingKind(null)}
          onChanged={onRefresh}
          today={snapshot?.today}
          usedPriorities={goals}
        />
      </div>

      <div className="beta-panel">
        <div className="beta-panel-head">
          <h3>{t("Flex")}</h3>
          <button type="button" className="beta-btn-small" onClick={() => setAddingKind("flex")}>{t("Add flex")}</button>
        </div>
        <TargetTable
          rows={flex}
          kind="flex"
          adding={addingKind === "flex"}
          onStopAdding={() => setAddingKind(null)}
          onChanged={onRefresh}
          today={snapshot?.today}
          usedPriorities={[...(snapshot?.recurringExpenses || []), ...flex]}
        />
      </div>
    </section>
  );
}
