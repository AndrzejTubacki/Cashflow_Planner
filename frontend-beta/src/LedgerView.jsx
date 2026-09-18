import { useMemo, useState } from "react";
import { formatMoney } from "./format.js";
import { apiFetch, confirmPending } from "./api.js";
import EditModal from "./EditModal.jsx";

function Tile({ label, value }) {
  return (
    <div className="beta-tile">
      <span className="beta-tile-label">{label}</span>
      <span className="beta-tile-value">{value}</span>
    </div>
  );
}

function StatusPill({ status }) {
  return <span className={`beta-pill beta-pill-${status}`}>{status}</span>;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function fundingParts(item) {
  const target = Number(item.target_ledger_amount ?? item.amount ?? 0);
  const confirmed = Math.max(0, Number(item.already_funded_ledger || 0));
  const pending = Math.max(0, Number(item.pending_allocated_ledger || 0));
  const future = Math.max(0, Number(item.future_allocated_ledger || 0));
  const remaining = Math.max(0, Number(item.remaining_ledger ?? Math.max(0, target - (confirmed + pending + future))));
  const total = Math.max(target, confirmed + pending + future + remaining, 0.0001);
  return { target, confirmed, pending, future, remaining, total };
}

function isFullyConfirmed(item) {
  const parts = fundingParts(item);
  if (item.fx_missing) return false;
  return parts.target <= 0.0001 || parts.confirmed >= parts.target - 0.0001;
}

function FundingRow({ label, item, ledgerCurrency }) {
  const parts = fundingParts(item);
  const title = [
    `Confirmed ${formatMoney(parts.confirmed, ledgerCurrency)}`,
    `Pending ${formatMoney(parts.pending, ledgerCurrency)}`,
    `Future ${formatMoney(parts.future, ledgerCurrency)}`,
    `Missing ${formatMoney(parts.remaining, ledgerCurrency)}`
  ].join(" · ");
  const pct = Math.round(((parts.confirmed + parts.pending + parts.future) / parts.total) * 100);

  return (
    <div className="beta-funding-row" title={title}>
      <span className="beta-funding-row-label">{label}</span>
      <div className="beta-funding-bar">
        <div className="beta-funding-seg beta-funding-seg-confirmed" style={{ width: `${(parts.confirmed / parts.total) * 100}%` }} />
        <div className="beta-funding-seg beta-funding-seg-pending" style={{ width: `${(parts.pending / parts.total) * 100}%` }} />
        <div className="beta-funding-seg beta-funding-seg-future" style={{ width: `${(parts.future / parts.total) * 100}%` }} />
        <div className="beta-funding-seg beta-funding-seg-missing" style={{ width: `${(parts.remaining / parts.total) * 100}%` }} />
      </div>
      <span className="beta-funding-row-pct">{pct}%</span>
      <span className="beta-funding-row-date">{item.funded_by_date || "No date"}</span>
    </div>
  );
}

function FundingOverview({ snapshot, ledgerCurrency }) {
  const items = [
    ...(snapshot?.goals || []).map(item => ({ item, label: `Goal: ${item.name || "-"}` })),
    ...(snapshot?.flexTransactions || []).map(item => ({ item, label: `Flex: ${item.name || "-"}` }))
  ].filter(entry => !isFullyConfirmed(entry.item));

  if (!items.length) return null;

  return (
    <div className="beta-panel">
      <h3>Funding overview</h3>
      <div className="beta-funding-list">
        {items.map(entry => (
          <FundingRow key={`${entry.label}:${entry.item.id}`} label={entry.label} item={entry.item} ledgerCurrency={ledgerCurrency} />
        ))}
      </div>
    </div>
  );
}

function TxRow({ tx, status, ledgerCurrency, onConfirm, onMoveToPending, onDismiss, onEdit, confirming }) {
  const amount = Number(tx.amount) || 0;
  const isIncome = tx.type === "income";
  const runningBalance = tx.running_balance ?? tx.runningBalance;
  const reservedBalance = tx.reserved_balance ?? tx.reservedBalance;
  // Only pending rows are directly editable (name/amount/date) — matching
  // the legacy app, confirmed rows are ledger history and future rows are
  // regenerated projections, neither of which EditModal has a route for.
  const canEdit = status === "pending" && Boolean(onEdit);
  return (
    <tr>
      <td className="beta-date-cell">{tx.date || tx.confirmed_date || "-"}</td>
      <td>
        <div className="beta-tx-name">{tx.name || tx.description || "Untitled"}</div>
      </td>
      <td className="beta-num">
        <span className={`beta-amt ${isIncome ? "pos" : "neg"}`}>
          {isIncome ? "+" : "-"}
          {formatMoney(Math.abs(amount), tx.currency)}
        </span>
      </td>
      <td className="beta-num">
        {runningBalance !== undefined && runningBalance !== null
          ? formatMoney(runningBalance, ledgerCurrency)
          : "-"}
        {reservedBalance > 0.0001 ? (
          <div
            className="beta-reserved-note"
            title="Set aside via a reserve transfer for a shortfall in a future period"
          >
            +{formatMoney(reservedBalance, ledgerCurrency)} reserved
          </div>
        ) : null}
      </td>
      <td>
        <StatusPill status={status} />
      </td>
      <td className="beta-row-actions">
        {status === "pending" && onConfirm ? (
          <button
            type="button"
            className="beta-btn-small"
            disabled={confirming === tx.id}
            onClick={() => onConfirm(tx.id)}
          >
            {confirming === tx.id ? "..." : "Confirm"}
          </button>
        ) : null}
        {onMoveToPending ? (
          <button
            type="button"
            className="beta-btn-small"
            disabled={confirming === tx.id}
            onClick={() => onMoveToPending(tx)}
          >
            To pending
          </button>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            className="beta-btn-small"
            disabled={confirming === tx.id}
            onClick={() => onEdit(tx)}
          >
            Edit
          </button>
        ) : null}
        {onDismiss && tx.canDismiss ? (
          <button
            type="button"
            className="beta-btn-small beta-btn-danger"
            disabled={confirming === tx.id}
            onClick={() => onDismiss(tx)}
          >
            Dismiss
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function TxTable({ rows, status, ledgerCurrency, emptyLabel, onConfirm, onMoveToPending, onDismiss, onEdit, confirming }) {
  if (!rows.length) return <p className="beta-empty">{emptyLabel}</p>;
  return (
    <div className="beta-panel-table">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Description</th>
            <th className="beta-num">Amount</th>
            <th className="beta-num">Balance</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(tx => (
            <TxRow
              key={tx.id}
              tx={tx}
              status={status}
              ledgerCurrency={ledgerCurrency}
              onConfirm={onConfirm}
              onMoveToPending={onMoveToPending}
              onDismiss={onDismiss}
              onEdit={onEdit}
              confirming={confirming}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LedgerView({ snapshot, onRefresh }) {
  const [confirming, setConfirming] = useState(null);
  const [error, setError] = useState("");
  const [recalculating, setRecalculating] = useState(false);
  const [editing, setEditing] = useState(null);

  const settings = snapshot?.settings || {};
  const ledgerCurrency = settings.ledger_currency || "PLN";
  const currentPeriod = (snapshot?.periodSummaries || [])[0] || null;
  const canMaintain = (snapshot?.session?.capabilities || []).includes("budget:maintain");

  const recurringIncomes = snapshot?.recurringIncomes || [];
  const periodIncome = recurringIncomes.find(r => r.id === settings.budget_period_income_id);

  const pending = (snapshot?.pendingTransactions || []).map(p => ({
    ...p,
    canDismiss: Boolean(
      (p.source_one_off_id) && String(p.occurrence_key || "").startsWith(`one_off_remainder:${p.source_one_off_id}:`)
    )
  }));
  const future = snapshot?.futureTransactions || [];

  const confirmedYears = useMemo(() => {
    const confirmed = snapshot?.confirmedTransactions || snapshot?.confirmed || [];
    const byYear = groupBy(confirmed, tx => String(tx.date || "").slice(0, 4) || "-");
    return [...byYear.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([year, rows]) => {
        const byMonth = groupBy(rows, tx => String(tx.date || "").slice(0, 7) || "-");
        return {
          year,
          months: [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0]))
        };
      });
  }, [snapshot]);

  const futureByPeriod = useMemo(() => {
    const byPeriod = groupBy(future, tx => tx.period || String(tx.date || "").slice(0, 7) || "-");
    return [...byPeriod.entries()].map(([period, rows]) => ({
      period,
      rows,
      summary: (snapshot?.periodSummaries || []).find(p => p.period === period)
    }));
  }, [future, snapshot]);

  async function handleConfirm(id) {
    setConfirming(id);
    setError("");
    try {
      await confirmPending(id, {});
      await onRefresh();
    } catch (err) {
      setError(err.message || "Failed to confirm transaction");
    } finally {
      setConfirming(null);
    }
  }

  async function handleMoveToPending(tx) {
    setConfirming(tx.id);
    setError("");
    try {
      await apiFetch(`/api/future/${encodeURIComponent(tx.id)}/move-to-pending`, {
        method: "POST",
        body: { occurrenceKey: tx.occurrence_key || "" }
      });
      await onRefresh();
    } catch (err) {
      setError(err.message || "Failed to move to pending");
    } finally {
      setConfirming(null);
    }
  }

  async function handleDismiss(tx) {
    if (!window.confirm("Dismiss this remainder? The one-off target will be reduced to the confirmed total.")) return;
    setConfirming(tx.id);
    setError("");
    try {
      await apiFetch(`/api/pending/${encodeURIComponent(tx.id)}`, { method: "DELETE" });
      await onRefresh();
    } catch (err) {
      setError(err.message || "Failed to dismiss remainder");
    } finally {
      setConfirming(null);
    }
  }

  async function handleRecalculate() {
    if (!window.confirm("Delete pending and recalculate?")) return;
    setRecalculating(true);
    setError("");
    try {
      await apiFetch("/api/pending/recalculate", { method: "POST" });
      await onRefresh();
    } catch (err) {
      setError(err.message || "Failed to recalculate pending");
    } finally {
      setRecalculating(false);
    }
  }

  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>Ledger</h1>
        <p>Confirmed and pending transactions for this budget.</p>
      </div>

      {error ? <div className="beta-error">{error}</div> : null}

      <div className="beta-tiles">
        <Tile
          label="Period"
          value={currentPeriod ? `${currentPeriod.start_date || "-"} → ${currentPeriod.end_date || "-"}` : "-"}
        />
        <Tile label="Defined by" value={periodIncome ? periodIncome.name : "Calendar month"} />
        <Tile
          label="Period income"
          value={currentPeriod ? formatMoney(currentPeriod.income, ledgerCurrency) : "-"}
        />
        <Tile
          label="Period expenses"
          value={currentPeriod ? formatMoney(currentPeriod.expenses, ledgerCurrency) : "-"}
        />
      </div>

      <FundingOverview snapshot={snapshot} ledgerCurrency={ledgerCurrency} />

      <div className="beta-panel">
        <div className="beta-panel-head">
          <h3>Pending</h3>
          {canMaintain ? (
            <button type="button" className="beta-btn-small" disabled={recalculating} onClick={handleRecalculate}>
              {recalculating ? "Recalculating..." : "Recalculate pending"}
            </button>
          ) : null}
        </div>
        <TxTable
          rows={pending}
          status="pending"
          ledgerCurrency={ledgerCurrency}
          emptyLabel="No pending transactions."
          onConfirm={handleConfirm}
          onDismiss={handleDismiss}
          onEdit={setEditing}
          confirming={confirming}
        />
      </div>

      <div className="beta-panel">
        <h3>Confirmed</h3>
        {confirmedYears.length ? confirmedYears.map(({ year, months }) => (
          <details key={year} className="beta-details" open={confirmedYears[0]?.year === year}>
            <summary>{year}</summary>
            {months.map(([month, rows]) => (
              <details key={month} className="beta-details beta-details-nested">
                <summary>{month}</summary>
                <TxTable rows={rows} status="confirmed" ledgerCurrency={ledgerCurrency} emptyLabel="No confirmed transactions." confirming={confirming} />
              </details>
            ))}
          </details>
        )) : <p className="beta-empty">No confirmed transactions yet.</p>}
      </div>

      <div className="beta-panel">
        <h3>Future</h3>
        {futureByPeriod.length ? futureByPeriod.map(({ period, rows, summary }) => (
          <details key={period} className="beta-details">
            <summary>
              {summary ? `${summary.start_date || period} - ${summary.end_date || period}` : period}
              {summary ? (
                <span className="beta-details-summary-extra">
                  {formatMoney(summary.income, ledgerCurrency)} / {formatMoney(summary.expenses, ledgerCurrency)}
                </span>
              ) : null}
            </summary>
            <TxTable
              rows={rows}
              status="pending"
              ledgerCurrency={ledgerCurrency}
              emptyLabel="No future transactions."
              onMoveToPending={handleMoveToPending}
              confirming={confirming}
            />
          </details>
        )) : <p className="beta-empty">No future transactions.</p>}
      </div>

      {editing ? (
        <EditModal
          entityType="pending"
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await onRefresh(); }}
        />
      ) : null}
    </section>
  );
}
