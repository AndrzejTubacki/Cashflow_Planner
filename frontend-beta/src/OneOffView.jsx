import { formatMessage, t } from "./i18n.js";
import { todayIso } from "./format.js";
import { useState } from "react";
import { formatMoney } from "./format.js";
import { apiFetch } from "./api.js";
import EditModal from "./EditModal.jsx";


function OneOffTable({ rows, editable, adding, onStopAdding, onChanged, today }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);

  async function remove(row) {
    const question = row.name
      ? formatMessage("Delete “{name}”?", { name: row.name })
      : t("Delete this transaction?");
    if (!window.confirm(question)) return;
    setBusyId(row.id);
    setError("");
    try {
      await apiFetch(`/api/one-off/${encodeURIComponent(row.id)}`, { method: "DELETE" });
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
            <th>{t("Date")}</th>
            <th>{t("Name")}</th>
            <th className="beta-num">{t("Amount")}</th>
            <th>{t("Status")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map(row => (
            <tr key={row.id}>
              <td className="beta-date-cell">{row.date || "-"}</td>
              <td><div className="beta-tx-name">{row.name || t("Unnamed")}</div></td>
              <td className="beta-num">
                <span className={`beta-amt ${row.type === "income" ? "pos" : "neg"}`}>
                  {row.type === "income" ? "+" : "-"}{formatMoney(Math.abs(Number(row.amount) || 0), row.currency)}
                </span>
              </td>
              <td><span className={`beta-pill beta-pill-${row.status === "confirmed" ? "confirmed" : "pending"}`}>{t(row.status)}</span></td>
              <td className="beta-row-actions">
                {editable ? (
                  <button type="button" className="beta-btn-small" onClick={() => setEditing(row)}>{t("Edit")}</button>
                ) : null}
                {row.canDelete ? (
                  <button
                    type="button"
                    className="beta-btn-small beta-btn-danger"
                    disabled={busyId === row.id}
                    onClick={() => remove(row)}
                  >{t("Delete")}</button>
                ) : null}
              </td>
            </tr>
          )) : (
            <tr><td colSpan={5} className="beta-empty">{t("Nothing here.")}</td></tr>
          )}
        </tbody>
      </table>
      {editing ? (
        <EditModal
          entityType="one-off"
          item={editing}
          today={today}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await onChanged(); }}
        />
      ) : null}
      {adding ? (
        <EditModal
          entityType="one-off"
          today={today}
          onClose={onStopAdding}
          onSaved={async () => { onStopAdding(); await onChanged(); }}
        />
      ) : null}
    </div>
  );
}

export default function OneOffView({ snapshot, onRefresh }) {
  const [adding, setAdding] = useState(false);
  const now = snapshot?.today || todayIso();

  const confirmedIds = new Set(
    (snapshot?.confirmedTransactions || []).map(tx => tx.source_one_off_id).filter(Boolean)
  );
  const pendingIds = new Set(
    (snapshot?.pendingTransactions || []).map(tx => tx.source_one_off_id).filter(Boolean)
  );

  const items = (snapshot?.oneOffs || []).map(o => {
    const isConfirmed = confirmedIds.has(o.id);
    const isPending = pendingIds.has(o.id);
    return {
      ...o,
      status: isConfirmed ? "confirmed" : isPending || (o.date && o.date < now) ? "pending" : "funded",
      isConfirmed,
      canDelete: !isConfirmed
    };
  });

  const future = items.filter(i => !i.isConfirmed && i.date >= now);
  const past = items.filter(i => i.isConfirmed || i.date < now);

  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>{t("One-off")}</h1>
        <p>{t("Single expenses or income that don’t repeat.")}</p>
      </div>

      <div className="beta-panel">
        <div className="beta-panel-head">
          <h3>{t("Future")}</h3>
          <button type="button" className="beta-btn-small" onClick={() => setAdding(true)}>{t("Add transaction")}</button>
        </div>
        <OneOffTable rows={future} editable adding={adding} onStopAdding={() => setAdding(false)} onChanged={onRefresh} today={now} />
      </div>

      <div className="beta-panel">
        <h3>{t("Past")}</h3>
        <OneOffTable rows={past} editable={false} adding={false} onStopAdding={() => {}} onChanged={onRefresh} today={now} />
      </div>
    </section>
  );
}
