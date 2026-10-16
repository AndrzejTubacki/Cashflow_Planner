import { formatMessage, t } from "./i18n.js";
import { useMemo, useState } from "react";
import { formatMoney } from "./format.js";
import { apiFetch, confirmPending } from "./api.js";
import EditModal from "./EditModal.jsx";
import { transactionMoneyDisplay } from "./moneyDisplay.js";
import { sortFundingEntries } from "./parity.js";

function Tile({ label, value }) {
  return (
    <div className="beta-tile">
      <span className="beta-tile-label">{label}</span>
      <span className="beta-tile-value">{value}</span>
    </div>
  );
}

function StatusPill({ status }) {
  return <span className={`beta-pill beta-pill-${status}`}>{t(status)}</span>;
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

function FundingRow({ label, item, ledgerCurrency, today }) {
  const parts = fundingParts(item);
  const pct = Math.round(((parts.confirmed + parts.pending + parts.future) / parts.total) * 100);
  const dateState = !item.funded_by_date ? "missing" : item.funded_by_date < today ? "past" : "future";

  return (
    <div className="beta-funding-row">
      <span className="beta-funding-row-label">{label}</span>
      <div className="beta-funding-bar">
        <div className="beta-funding-seg beta-funding-seg-confirmed" style={{ width: `${(parts.confirmed / parts.total) * 100}%` }} />
        <div className="beta-funding-seg beta-funding-seg-pending" style={{ width: `${(parts.pending / parts.total) * 100}%` }} />
        <div className="beta-funding-seg beta-funding-seg-future" style={{ width: `${(parts.future / parts.total) * 100}%` }} />
        <div className="beta-funding-seg beta-funding-seg-missing" style={{ width: `${(parts.remaining / parts.total) * 100}%` }} />
      </div>
      <span className="beta-funding-row-pct">{pct}%</span>
      <span className={`beta-funding-row-date beta-funding-date-${dateState}`}>{item.funded_by_date || t("No date")}</span>
      <span className="beta-funding-amounts">
        {formatMessage("Confirmed {amount}", { amount: formatMoney(parts.confirmed, ledgerCurrency) })} · {" "}
        {formatMessage("Pending {amount}", { amount: formatMoney(parts.pending, ledgerCurrency) })} · {" "}
        {formatMessage("Future {amount}", { amount: formatMoney(parts.future, ledgerCurrency) })} · {" "}
        {formatMessage("Missing {amount}", { amount: formatMoney(parts.remaining, ledgerCurrency) })}
      </span>
    </div>
  );
}

function FundingOverview({ snapshot, ledgerCurrency }) {
  const [showAll, setShowAll] = useState(false);
  const items = sortFundingEntries([
    ...(snapshot?.goals || []).map(item => ({ item, name: item.name, label: formatMessage("Goal: {name}", { name: item.name || "-" }) })),
    ...(snapshot?.flexTransactions || []).map(item => ({ item, name: item.name, label: formatMessage("Flex: {name}", { name: item.name || "-" }) }))
  ].filter(entry => !isFullyConfirmed(entry.item)));

  if (!items.length) return null;

  return (
    <div className="beta-panel">
      <h3>{t("Funding overview")}</h3>
      <div className="beta-funding-legend">
        <span className="beta-funding-legend-confirmed">{t("Confirmed")}</span>
        <span className="beta-funding-legend-pending">{t("Pending")}</span>
        <span className="beta-funding-legend-future">{t("Future")}</span>
        <span className="beta-funding-legend-missing">{t("Missing")}</span>
      </div>
      <div className="beta-funding-list">
        {(showAll ? items : items.slice(0, 6)).map(entry => (
          <FundingRow key={`${entry.label}:${entry.item.id}`} label={entry.label} item={entry.item} ledgerCurrency={ledgerCurrency} today={snapshot?.today || ""} />
        ))}
      </div>
      {items.length > 6 ? <button type="button" className="beta-btn-small" onClick={() => setShowAll(value => !value)}>{showAll ? t("Show less") : t("Show all")}</button> : null}
    </div>
  );
}

// Some rows carry machine metadata (JSON) in note, e.g. the first-run opening balance.
function isReadableNote(note) {
  const text = String(note || "").trim();
  if (!text) return false;
  if (!/^[[{]/.test(text)) return true;
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}

function TxRow({ tx, status: sectionStatus, ledgerCurrency, onConfirm, onRegenerate, onMoveToPending, onDismiss, onEdit, confirming }) {
  const money = transactionMoneyDisplay(tx, ledgerCurrency);
  const isIncome = tx.type === "income";
  const runningBalance = tx.running_balance ?? tx.runningBalance;
  const reservedBalance = tx.reserved_balance ?? tx.reservedBalance;
  const status = tx.status || sectionStatus;
  // Only pending rows are directly editable (name/amount/date) — matching
  // the legacy app, confirmed rows are ledger history and future rows are
  // regenerated projections, neither of which EditModal has a route for.
  const canEdit = sectionStatus === "pending" && Boolean(onEdit);
  return (
    <tr>
      <td className="beta-date-cell">{tx.date || tx.confirmed_date || "-"}</td>
      <td>
        <div className="beta-tx-name">{tx.name || tx.description || t("Untitled")}</div>
        {isReadableNote(tx.note) ? <div className="beta-tx-detail">{tx.note}</div> : null}
        {tx.warning ? <div className="beta-tx-detail beta-tx-warning">{String(tx.warning)}</div> : null}
      </td>
      <td className="beta-num">
        <span className={`beta-amt ${isIncome ? "pos" : "neg"}`}>
          {Math.abs(money.displayAmount) < 0.005 ? "" : isIncome ? "+" : "-"}
          {formatMoney(Math.abs(money.displayAmount), money.currency)}
        </span>
        {money.currency !== money.ledgerCurrency && money.ledgerAmount !== null ? (
          <div className="beta-tx-detail">({formatMoney(Math.abs(money.ledgerAmount), money.ledgerCurrency)})</div>
        ) : null}
        {money.isPartiallyFunded && money.requested !== null ? (
          <div className="beta-tx-detail">{formatMessage("of {amount} requested", { amount: formatMoney(Math.abs(money.requested), money.currency) })}</div>
        ) : null}
      </td>
      <td className="beta-num">
        {runningBalance !== undefined && runningBalance !== null
          ? formatMoney(runningBalance, money.runningBalanceCurrency)
          : "-"}
        {reservedBalance > 0.0001 ? (
          <div
            className="beta-reserved-note"
            title={t("Set aside via a reserve transfer for a shortfall in a future period")}
          >
            {formatMessage("Reserved: +{amount}", { amount: formatMoney(reservedBalance, money.runningBalanceCurrency) })}</div>
        ) : null}
      </td>
      <td>
        <StatusPill status={status} />
      </td>
      <td className="beta-row-actions">
        {sectionStatus === "pending" && onConfirm ? (
          <button
            type="button"
            className="beta-btn-small"
            disabled={confirming === tx.id}
            onClick={() => onConfirm(tx.id)}
          >
            {confirming === tx.id ? "..." : t("Confirm")}
          </button>
        ) : null}
        {sectionStatus === "pending" && onRegenerate ? (
          <button type="button" className="beta-btn-small" disabled={confirming === tx.id}
            onClick={() => onRegenerate(tx)}>{t("Regenerate")}</button>
        ) : null}
        {onMoveToPending ? (
          <button
            type="button"
            className="beta-btn-small"
            disabled={confirming === tx.id}
            onClick={() => onMoveToPending(tx)}
          >{t("To pending")}</button>
        ) : null}
        {canEdit ? (
          <button
            type="button"
            className="beta-btn-small"
            disabled={confirming === tx.id}
            onClick={() => onEdit(tx)}
          >{t("Edit")}</button>
        ) : null}
        {onDismiss && tx.canDismiss ? (
          <button
            type="button"
            className="beta-btn-small beta-btn-danger"
            disabled={confirming === tx.id}
            onClick={() => onDismiss(tx)}
          >{t("Dismiss")}</button>
        ) : null}
      </td>
    </tr>
  );
}

function TxTable({ rows, status, ledgerCurrency, emptyLabel, onConfirm, onRegenerate, onMoveToPending, onDismiss, onEdit, confirming }) {
  if (!rows.length) return <p className="beta-empty">{emptyLabel}</p>;
  return (
    <div className="beta-panel-table">
      <table>
        <thead>
          <tr>
            <th>{t("Date")}</th>
            <th>{t("Description")}</th>
            <th className="beta-num">{t("Amount")}</th>
            <th className="beta-num">{t("Balance")}</th>
            <th>{t("Status")}</th>
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
              onRegenerate={onRegenerate}
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
  const nextResetDate = currentPeriod?.end_date ? (() => {
    const date = new Date(`${currentPeriod.end_date}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  })() : "-";

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
    if (!window.confirm(t("Confirm this transaction? This is irreversible and cannot be undone."))) return;
    setConfirming(id);
    setError("");
    try {
      await confirmPending(id, {});
      await onRefresh();
    } catch (err) {
      setError(err.message || t("Failed to confirm transaction"));
    } finally {
      setConfirming(null);
    }
  }

  // Rebuild from the source plan, without promising a future date or deleting it.
  async function handleRegenerate(tx) {
    if (!window.confirm(t("Remove this pending transaction and regenerate? It may return to pending, appear in future, or disappear if no longer needed."))) return;
    setConfirming(tx.id);
    setError("");
    try {
      await apiFetch(`/api/pending/${encodeURIComponent(tx.id)}/regenerate`, { method: "POST" });
      await onRefresh();
    } catch (err) {
      setError(err.message || t("Failed to regenerate pending transaction"));
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
      setError(err.message || t("Failed to move to pending"));
    } finally {
      setConfirming(null);
    }
  }

  async function handleDismiss(tx) {
    if (!window.confirm(t("Dismiss this remainder? The one-off target will be reduced to the confirmed total."))) return;
    setConfirming(tx.id);
    setError("");
    try {
      await apiFetch(`/api/pending/${encodeURIComponent(tx.id)}`, { method: "DELETE" });
      await onRefresh();
    } catch (err) {
      setError(err.message || t("Failed to dismiss remainder"));
    } finally {
      setConfirming(null);
    }
  }

  async function handleRecalculate() {
    if (!window.confirm(t("Delete pending and recalculate?"))) return;
    setRecalculating(true);
    setError("");
    try {
      await apiFetch("/api/pending/recalculate", { method: "POST" });
      await onRefresh();
    } catch (err) {
      setError(err.message || t("Failed to recalculate pending"));
    } finally {
      setRecalculating(false);
    }
  }

  return (
    <section className="beta-view">
      <div className="beta-view-head">
        <h1>{t("Ledger")}</h1>
        <p>{t("Confirmed and pending transactions for this budget.")}</p>
      </div>

      {error ? <div className="beta-error beta-dismissible">{error}<button type="button" onClick={() => setError("")} aria-label={t("Dismiss error")}>&times;</button></div> : null}

      <div className="beta-tiles">
        <Tile
          label={t("Period")}
          value={currentPeriod ? `${currentPeriod.start_date || "-"} → ${currentPeriod.end_date || "-"}` : "-"}
        />
        <Tile label={t("Defined by")} value={periodIncome ? periodIncome.name : t("Calendar month")} />
        <Tile
          label={t("Period income")}
          value={currentPeriod ? formatMoney(currentPeriod.income, ledgerCurrency) : "-"}
        />
        <Tile
          label={t("Period expenses")}
          value={currentPeriod ? formatMoney(currentPeriod.expenses, ledgerCurrency) : "-"}
        />
      </div>
      <p className="beta-hint">{formatMessage("The current period includes transactions from {start} through {end}. The next period starts on {reset}.", {
        start: currentPeriod?.start_date || "-", end: currentPeriod?.end_date || "-", reset: nextResetDate
      })}</p>

      <FundingOverview snapshot={snapshot} ledgerCurrency={ledgerCurrency} />

      <div className="beta-panel">
        <div className="beta-panel-head">
          <h3>{t("Pending")}</h3>
          {canMaintain ? (
            <button type="button" className="beta-btn-small" disabled={recalculating} onClick={handleRecalculate}>
              {recalculating ? t("Recalculating...") : t("Recalculate pending")}
            </button>
          ) : null}
        </div>
        <TxTable
          rows={pending}
          status="pending"
          ledgerCurrency={ledgerCurrency}
          emptyLabel={t("No pending transactions.")}
          onConfirm={handleConfirm}
          onRegenerate={(snapshot?.session?.capabilities || []).includes("planner:write") ? handleRegenerate : null}
          onDismiss={handleDismiss}
          onEdit={setEditing}
          confirming={confirming}
        />
      </div>

      <div className="beta-panel">
        <h3>{t("Confirmed")}</h3>
        {confirmedYears.length ? confirmedYears.map(({ year, months }) => (
          <details key={year} className="beta-details" open={confirmedYears[0]?.year === year}>
            <summary>{year}</summary>
            {months.map(([month, rows]) => (
              <details key={month} className="beta-details beta-details-nested">
                <summary>{month}</summary>
                <TxTable rows={rows} status="confirmed" ledgerCurrency={ledgerCurrency} emptyLabel={t("No confirmed transactions.")} confirming={confirming} />
              </details>
            ))}
          </details>
        )) : <p className="beta-empty">{t("No confirmed transactions yet.")}</p>}
      </div>

      <div className="beta-panel">
        <h3>{t("Future")}</h3>
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
              emptyLabel={t("No future transactions.")}
              onMoveToPending={handleMoveToPending}
              confirming={confirming}
            />
          </details>
        )) : <p className="beta-empty">{t("No future transactions.")}</p>}
      </div>

      {editing ? (
        <EditModal
          entityType="pending"
          item={editing}
          today={snapshot?.today}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await onRefresh(); }}
        />
      ) : null}
    </section>
  );
}
