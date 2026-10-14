import { formatMessage, t } from "./i18n.js";
import { useState } from "react";
import { formatMoney } from "./format.js";
import { apiFetch } from "./api.js";
import EditModal from "./EditModal.jsx";
import { recurringExpensePredictionDisplay } from "./moneyDisplay.js";

function describeAnchor(r, incomeById) {
  const repeat = Number(r.repeat_every_months) || 1;
  const repeatLabel = repeat > 1 ? ` · ${formatMessage("Repeats every {count} months", { count: repeat })}` : "";

  if (r.anchor_income_id) {
    const offset = Number(r.anchor_offset_days) || 0;
    const incomeName = incomeById?.get(r.anchor_income_id)?.name || t("Selected income");
    const anchor = offset === 0
      ? formatMessage("Same day as {income}", { income: incomeName })
      : offset > 0
        ? formatMessage("After {income}: {count} days", { count: offset, income: incomeName })
        : formatMessage("Before {income}: {count} days", { count: Math.abs(offset), income: incomeName });
    return `${anchor}${repeatLabel}`;
  }

  const base = r.anchor_type === "day_of_month"
    ? formatMessage("Day {day} of month", { day: r.anchor_day_of_month || "?" })
    : t("Month end");
  const offset = Number(r.anchor_offset_days) || 0;
  const offsetLabel = offset > 0
    ? ` · ${formatMessage("Days after: {count}", { count: offset })}`
    : offset < 0 ? ` · ${formatMessage("Days before: {count}", { count: Math.abs(offset) })}` : "";
  return `${base}${offsetLabel}${repeatLabel}`;
}

function occurrenceSummary(r) {
  const total = Number(r.occurrence_total || 0);
  if (!total) return t("No occurrences in projection window");
  const funded = Number(r.occurrence_funded_count || 0);
  const parts = [formatMessage("Funded occurrences: {funded}/{total}", { funded, total })];
  if (r.occurrence_partial_count) parts.push(formatMessage("Partly funded: {count}", { count: r.occurrence_partial_count }));
  if (r.occurrence_underfunded_count) parts.push(formatMessage("Underfunded: {count}", { count: r.occurrence_underfunded_count }));
  if (r.occurrence_skipped_count) parts.push(formatMessage("Skipped: {count}", { count: r.occurrence_skipped_count }));
  return parts.join(" / ");
}

function EmptyRow({ colSpan, label }) {
  return (
    <tr>
      <td colSpan={colSpan} className="beta-empty">{label}</td>
    </tr>
  );
}

function PredictionDetails({ row, ledgerCurrency }) {
  const prediction = recurringExpensePredictionDisplay(row, ledgerCurrency);
  return (
    <div className="beta-tx-detail">{t("Current prediction:")} {formatMoney(prediction.amount, prediction.currency)}
      {prediction.currency !== prediction.ledgerCurrency && prediction.ledgerAmount !== null
        ? ` (${formatMoney(prediction.ledgerAmount, prediction.ledgerCurrency)})`
        : ""}
    </div>
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
      setError(err.message || t("Failed to delete"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="beta-modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="beta-modal" role="dialog" aria-modal="true">
        <div className="beta-modal-head">
          <h2>{t("Reassign anchored expenses")}</h2>
          <button type="button" className="beta-modal-close" onClick={onClose} aria-label={t("Close")}>&times;</button>
        </div>
        <div className="beta-modal-form">
          {error ? <div className="beta-error beta-dismissible">{error}<button type="button" onClick={() => setError("")} aria-label={t("Dismiss error")}>&times;</button></div> : null}
          <p>{dependents.length === 1
            ? formatMessage("1 recurring expense is anchored to “{income}”: {expenses}. Deleting it requires another anchor for that expense.", {
              income: income.name,
              expenses: dependents.map(d => d.name).join(", ")
            })
            : formatMessage("There are {count} recurring expenses anchored to “{income}”: {expenses}. Deleting it requires another anchor for those expenses.", {
              count: dependents.length,
              income: income.name,
              expenses: dependents.map(d => d.name).join(", ")
            })}</p>
          <div className="beta-form-grid">
            {otherIncomes.length ? (
              <label className="beta-field beta-field-checkbox">
                <input type="radio" name="anchor-conflict-mode" checked={mode === "reassign"} onChange={() => setMode("reassign")} />
                <span>{t("Anchor them to a different income instead")}</span>
              </label>
            ) : null}
            {mode === "reassign" && otherIncomes.length ? (
              <label className="beta-field">
                <span>{t("Income")}</span>
                <select value={reassignToId} onChange={e => setReassignToId(e.target.value)}>
                  {otherIncomes.map(inc => <option key={inc.id} value={inc.id}>{inc.name}</option>)}
                </select>
              </label>
            ) : null}
            <label className="beta-field beta-field-checkbox">
              <input type="radio" name="anchor-conflict-mode" checked={mode === "fixed"} onChange={() => setMode("fixed")} />
              <span>{t("Convert them to a fixed day-of-month instead (keeping their current date)")}</span>
            </label>
          </div>
          <div className="beta-form-actions">
            <button type="button" className="beta-btn-small" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
            <button type="button" className="beta-btn-primary" onClick={confirm} disabled={busy || (mode === "reassign" && !reassignToId)}>
              {busy ? t("Deleting...") : t("Delete income")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecurringTable({ rows, kind, adding, onStopAdding, onChanged, incomes = [], settings = {}, today, usedPriorities = [] }) {
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
      setError(err.message || t("Failed to update"));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(row) {
    if (!window.confirm(row.name ? formatMessage("Delete “{name}”?", { name: row.name }) : t("Delete this item?"))) return;
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
        setError(err.message || t("Failed to delete"));
      }
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
            <th className="beta-num">{t("Amount")}</th>
            <th>{t("Anchor")}</th>
            <th>{isExpense ? t("Occurrences") : t("Notes")}</th>
            <th>{t("Status")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map(row => (
            <tr key={row.id} className={row.active ? "" : "beta-row-inactive"}>
              <td>
                <div className="beta-tx-name">{row.name || t("Unnamed")}</div>
                {isExpense ? (
                  <span className="beta-pill beta-pill-muted">{row.necessary ? t("Necessary") : t("Optional")}</span>
                ) : row.period_setting ? (
                  <span className="beta-pill beta-pill-muted">{t("Defines period")}</span>
                ) : null}
              </td>
              <td className="beta-num">
                {formatMoney(row.amount, row.currency)}
                {isExpense ? <PredictionDetails row={row} ledgerCurrency={settings.ledger_currency || "PLN"} /> : null}
              </td>
              <td>{describeAnchor(row, incomeById)}</td>
              <td>{isExpense ? occurrenceSummary(row) : (row.period_setting ? t("Defines budget period") : "")}</td>
              <td>
                <span className={`beta-pill ${row.active ? "beta-pill-confirmed" : "beta-pill-pending"}`}>
                  {row.active ? t("Active") : t("Disabled")}
                </span>
              </td>
              <td className="beta-row-actions">
                <button type="button" className="beta-btn-small" onClick={() => setEditing(row)}>{t("Edit")}</button>
                <button
                  type="button"
                  className="beta-btn-small"
                  disabled={busyId === row.id}
                  onClick={() => toggleActive(row)}
                >
                  {row.active ? t("Disable") : t("Enable")}
                </button>
                <button
                  type="button"
                  className="beta-btn-small beta-btn-danger"
                  disabled={busyId === row.id}
                  onClick={() => remove(row)}
                >{t("Delete")}</button>
              </td>
            </tr>
          )) : <EmptyRow colSpan={6} label={isExpense ? t("No recurring expenses yet.") : t("No recurring income yet.")} />}
        </tbody>
      </table>
      {editing ? (
        <EditModal
          entityType={isExpense ? "recurring-expense" : "recurring-income"}
          item={editing}
          recurringIncomes={incomes}
          settings={settings}
          today={today}
          usedPriorities={usedPriorities}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await onChanged(); }}
        />
      ) : null}
      {adding ? (
        <EditModal
          entityType={isExpense ? "recurring-expense" : "recurring-income"}
          recurringIncomes={incomes}
          settings={settings}
          today={today}
          usedPriorities={usedPriorities}
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
        <h1>{t("Recurring")}</h1>
        <p>{t("Recurring expenses and income that drive each period’s projection.")}</p>
      </div>

      <div className="beta-panel">
        <div className="beta-panel-head">
          <h3>{t("Expenses")}</h3>
          <button type="button" className="beta-btn-small" onClick={() => setAddingKind("expense")}>{t("Add expense")}</button>
        </div>
        <RecurringTable
          rows={expenses}
          kind="expense"
          adding={addingKind === "expense"}
          onStopAdding={() => setAddingKind(null)}
          onChanged={onRefresh}
          incomes={incomes}
          settings={snapshot?.settings || {}}
          today={snapshot?.today}
          usedPriorities={[...expenses, ...(snapshot?.flexTransactions || [])]}
        />
      </div>

      <div className="beta-panel">
        <div className="beta-panel-head">
          <h3>{t("Income")}</h3>
          <button type="button" className="beta-btn-small" onClick={() => setAddingKind("income")}>{t("Add income")}</button>
        </div>
        <RecurringTable
          rows={incomes}
          kind="income"
          adding={addingKind === "income"}
          onStopAdding={() => setAddingKind(null)}
          onChanged={onRefresh}
          settings={snapshot?.settings || {}}
          today={snapshot?.today}
        />
      </div>
    </section>
  );
}
