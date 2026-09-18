import { useState } from "react";
import { formatMoney } from "./format.js";
import { apiFetch } from "./api.js";
import EditModal from "./EditModal.jsx";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function OneOffTable({ rows, editable, adding, onStopAdding, onChanged }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);

  async function remove(row) {
    if (!window.confirm(`Delete "${row.name || "this transaction"}"?`)) return;
    setBusyId(row.id);
    setError("");
    try {
      await apiFetch(`/api/one-off/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      await onChanged();
    } catch (err) {
      setError(err.message || "Failed to delete");
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
            <th>Date</th>
            <th>Name</th>
            <th className="beta-num">Amount</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map(row => (
            <tr key={row.id}>
              <td className="beta-date-cell">{row.date || "-"}</td>
              <td><div className="beta-tx-name">{row.name || "Unnamed"}</div></td>
              <td className="beta-num">
                <span className={`beta-amt ${row.type === "income" ? "pos" : "neg"}`}>
                  {row.type === "income" ? "+" : "-"}{formatMoney(Math.abs(Number(row.amount) || 0), row.currency)}
                </span>
              </td>
              <td><span className={`beta-pill beta-pill-${row.status === "confirmed" ? "confirmed" : "pending"}`}>{row.status}</span></td>
              <td className="beta-row-actions">
                {editable ? (
                  <button type="button" className="beta-btn-small" onClick={() => setEditing(row)}>Edit</button>
                ) : null}
                {row.canDelete ? (
                  <button
                    type="button"
                    className="beta-btn-small beta-btn-danger"
                    disabled={busyId === row.id}
                    onClick={() => remove(row)}
                  >
                    Delete
                  </button>
                ) : null}
              </td>
            </tr>
          )) : (
            <tr><td colSpan={5} className="beta-empty">Nothing here.</td></tr>
          )}
        </tbody>
      </table>
      {editing ? (
        <EditModal
          entityType="one-off"
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await onChanged(); }}
        />
      ) : null}
      {adding ? (
        <EditModal
          entityType="one-off"
          onClose={onStopAdding}
          onSaved={async () => { onStopAdding(); await onChanged(); }}
        />
      ) : null}
    </div>
  );
}

export default function OneOffView({ snapshot, onRefresh }) {
  const [adding, setAdding] = useState(false);
  const now = todayIso();

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
        <h1>One-off</h1>
        <p>Single expenses or income that don&rsquo;t repeat.</p>
      </div>

      <div className="beta-panel">
        <div className="beta-panel-head">
          <h3>Future</h3>
          <button type="button" className="beta-btn-small" onClick={() => setAdding(true)}>+ Add transaction</button>
        </div>
        <OneOffTable rows={future} editable adding={adding} onStopAdding={() => setAdding(false)} onChanged={onRefresh} />
      </div>

      <div className="beta-panel">
        <h3>Past</h3>
        <OneOffTable rows={past} editable={false} adding={false} onStopAdding={() => {}} onChanged={onRefresh} />
      </div>
    </section>
  );
}
