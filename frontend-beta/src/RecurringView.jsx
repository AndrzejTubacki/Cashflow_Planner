import { useState } from "react";
import { formatMoney } from "./format.js";
import { apiFetch } from "./api.js";
import EditModal from "./EditModal.jsx";

function describeAnchor(r, incomeById) {
  const repeat = Number(r.repeat_every_months) || 1;
  const repeatLabel = repeat > 1 ? `, every ${repeat} months` : "";

  if (r.anchor_income_id) {
    const offset = Number(r.anchor_offset_days) || 0;
    const incomeName = incomeById?.get(r.anchor_income_id)?.name || "an income";
    const offsetLabel = offset === 0 ? "same day as" : offset > 0 ? `${offset}d after` : `${Math.abs(offset)}d before`;
    return `${offsetLabel} ${incomeName}${repeatLabel}`;
  }

  const base = r.anchor_type === "day_of_month"
    ? `Day ${r.anchor_day_of_month || "?"} of month`
    : "Month end";
  const offset = Number(r.anchor_offset_days) || 0;
  const offsetLabel = offset ? ` ${offset > 0 ? "+" : ""}${offset}d` : "";
  return `${base}${offsetLabel}${repeatLabel}`;
}

function occurrenceSummary(r) {
  const total = Number(r.occurrence_total || 0);
  if (!total) return "No occurrences in projection window";
  const funded = Number(r.occurrence_funded_count || 0);
  const parts = [`${funded}/${total} funded`];
  if (r.occurrence_partial_count) parts.push(`${r.occurrence_partial_count} partial`);
  if (r.occurrence_underfunded_count) parts.push(`${r.occurrence_underfunded_count} underfunded`);
  if (r.occurrence_skipped_count) parts.push(`${r.occurrence_skipped_count} skipped`);
  return parts.join(" / ");
}

function EmptyRow({ colSpan, label }) {
  return (
    <tr>
      <td colSpan={colSpan} className="beta-empty">{label}</td>
    </tr>
  );
}

function AnchorConflictModal({ income, dependents, otherIncomes, onClose, onResolved }) {
  const [mode, setMode] = useState(otherIncomes.length ? "reassign" : "fixed");
  const [reassignToId, setReassignToId] = useState(otherIncomes[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const body = mode === "reassign"
        ? { reassignAnchorsToIncomeId: reassignToId }
        : { fallbackAnchorsToFixedDay: true };
      await apiFetch(`/api/recurring-incomes/${encodeURIComponent(income.id)}`, { method: "DELETE", body });
      await onResolved();
    } catch (err) {
      setError(err.message || "Failed to delete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="beta-modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="beta-modal" role="dialog" aria-modal="true">
        <div className="beta-modal-head">
          <h2>Reassign anchored expenses</h2>
          <button type="button" className="beta-modal-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="beta-modal-form">
          {error ? <div className="beta-error">{error}</div> : null}
          <p>
            {dependents.length === 1 ? "1 recurring expense" : `${dependents.length} recurring expenses`} anchor
            to &ldquo;{income.name}&rdquo;: {dependents.map(d => d.name).join(", ")}. Deleting it needs somewhere
            for {dependents.length === 1 ? "that expense" : "those expenses"} to anchor instead.
          </p>
          <div className="beta-form-grid">
            {otherIncomes.length ? (
              <label className="beta-field beta-field-checkbox">
                <input type="radio" name="anchor-conflict-mode" checked={mode === "reassign"} onChange={() => setMode("reassign")} />
                <span>Anchor them to a different income instead</span>
              </label>
            ) : null}
            {mode === "reassign" && otherIncomes.length ? (
              <label className="beta-field">
                <span>Income</span>
                <select value={reassignToId} onChange={e => setReassignToId(e.target.value)}>
                  {otherIncomes.map(inc => <option key={inc.id} value={inc.id}>{inc.name}</option>)}
                </select>
              </label>
            ) : null}
            <label className="beta-field beta-field-checkbox">
              <input type="radio" name="anchor-conflict-mode" checked={mode === "fixed"} onChange={() => setMode("fixed")} />
              <span>Convert them to a fixed day-of-month instead (keeping their current date)</span>
            </label>
          </div>
          <div className="beta-form-actions">
            <button type="button" className="beta-btn-small" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className="beta-btn-primary" onClick={confirm} disabled={busy || (mode === "reassign" && !reassignToId)}>
              {busy ? "Deleting..." : "Delete income"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecurringTable({ rows, kind, adding, onStopAdding, onChanged, incomes = [] }) {
  const isExpense = kind === "expense";
  const incomeById = new Map(incomes.map(income => [income.id, income]));
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [anchorConflict, setAnchorConflict] = useState(null);

  async function toggleActive(row) {
    setBusyId(row.id);
    setError("");
    try {
      const url = isExpense ? `/api/recurring-expenses/${encodeURIComponent(row.id)}` : `/api/recurring-incomes/${encodeURIComponent(row.id)}`;
      await apiFetch(url, { method: "PUT", body: { active: !row.active } });
      await onChanged();
    } catch (err) {
      setError(err.message || "Failed to update");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row) {
    if (!window.confirm(`Delete "${row.name || "this item"}"?`)) return;
    setBusyId(row.id);
    setError("");
    try {
      const url = isExpense ? `/api/recurring-expenses/${encodeURIComponent(row.id)}` : `/api/recurring-incomes/${encodeURIComponent(row.id)}`;
      await apiFetch(url, { method: "DELETE" });
      await onChanged();
    } catch (err) {
      if (!isExpense && err.status === 409 && err.details?.anchorDependents) {
        setAnchorConflict({ income: row, dependents: err.details.anchorDependents });
      } else {
        setError(err.message || "Failed to delete");
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="beta-panel-table">
      {error ? <div className="beta-error">{error}</div> : null}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th className="beta-num">Amount</th>
            <th>Anchor</th>
            <th>{isExpense ? "Occurrences" : "Notes"}</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map(row => (
            <tr key={row.id} className={row.active ? "" : "beta-row-inactive"}>
              <td>
                <div className="beta-tx-name">{row.name || "Unnamed"}</div>
                {isExpense ? (
                  <span className="beta-pill beta-pill-muted">{row.necessary ? "Necessary" : "Optional"}</span>
                ) : row.period_setting ? (
                  <span className="beta-pill beta-pill-muted">Defines period</span>
                ) : null}
              </td>
              <td className="beta-num">{formatMoney(row.amount, row.currency)}</td>
              <td>{describeAnchor(row, incomeById)}</td>
              <td>{isExpense ? occurrenceSummary(row) : (row.period_setting ? "Defines budget period" : "")}</td>
              <td>
                <span className={`beta-pill ${row.active ? "beta-pill-confirmed" : "beta-pill-pending"}`}>
                  {row.active ? "active" : "disabled"}
                </span>
              </td>
              <td className="beta-row-actions">
                <button type="button" className="beta-btn-small" onClick={() => setEditing(row)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="beta-btn-small"
                  disabled={busyId === row.id}
                  onClick={() => toggleActive(row)}
                >
                  {row.active ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  className="beta-btn-small beta-btn-danger"
                  disabled={busyId === row.id}
                  onClick={() => remove(row)}
                >
                  Delete
                </button>
              </td>
            </tr>
          )) : <EmptyRow colSpan={6} label={`No recurring ${isExpense ? "expenses" : "income"} yet.`} />}
        </tbody>
      </table>
      {editing ? (
        <EditModal
          entityType={isExpense ? "recurring-expense" : "recurring-income"}
          item={editing}
          recurringIncomes={incomes}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await onChanged(); }}
        />
      ) : null}
      {adding ? (
        <EditModal
          entityType={isExpense ? "recurring-expense" : "recurring-income"}
          recurringIncomes={incomes}
          onClose={onStopAdding}
          onSaved={async () => { onStopAdding(); await onChanged(); }}
        />
      ) : null}
      {anchorConflict ? (
        <AnchorConflictModal
          income={anchorConflict.income}
          dependents={anchorConflict.dependents}
          otherIncomes={rows.filter(r => r.id !== anchorConflict.income.id)}
          onClose={() => setAnchorConflict(null)}
          onResolved={async () => { setAnchorConflict(null); await onChanged(); }}
        />
      ) : null}
    </div>
  );
}

export default function RecurringView({ snapshot, onRefresh }) {
  const [addingKind, setAddingKind] = useState(null);
  const expenses = snapshot?.recurringExpenses || [];
  const incomes = snapshot?.recurringIncomes || [];

  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>Recurring</h1>
        <p>Recurring expenses and income that drive each period&rsquo;s projection.</p>
      </div>

      <div className="beta-panel">
        <div className="beta-panel-head">
          <h3>Expenses</h3>
          <button type="button" className="beta-btn-small" onClick={() => setAddingKind("expense")}>
            + Add expense
          </button>
        </div>
        <RecurringTable
          rows={expenses}
          kind="expense"
          adding={addingKind === "expense"}
          onStopAdding={() => setAddingKind(null)}
          onChanged={onRefresh}
          incomes={incomes}
        />
      </div>

      <div className="beta-panel">
        <div className="beta-panel-head">
          <h3>Income</h3>
          <button type="button" className="beta-btn-small" onClick={() => setAddingKind("income")}>
            + Add income
          </button>
        </div>
        <RecurringTable
          rows={incomes}
          kind="income"
          adding={addingKind === "income"}
          onStopAdding={() => setAddingKind(null)}
          onChanged={onRefresh}
        />
      </div>
    </section>
  );
}
