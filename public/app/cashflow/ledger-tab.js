import { escapeHtml } from "../utils.js";
import { renderFundingOverview } from "./funding.js";
import { renderBudgetPeriodStats } from "./periods.js";
import { formatMoney, groupBy, renderDetailsPanel, t } from "./shared.js";
import { renderTransactionTable } from "./transactions.js";

const EMPTY_VALUE = "-";

export function renderLedgerTab(locale, cashflow) {
  const pending = (cashflow?.pendingTransactions || []).map(p => ({
    ...p,
    entityType: "pending",
    name: p.name || p.description || p.title || t(locale, "Pending"),
    currency: p.currency || "PLN"
  }));

  const future = (cashflow?.futureTransactions || []).map(f => ({
    ...f,
    entityType: "future",
    name: f.name || f.description || f.title || t(locale, "Future"),
    currency: f.currency || "PLN"
  }));

  const confirmed = (cashflow?.confirmedTransactions || cashflow?.confirmed || []).map(c => ({
    ...c,
    entityType: "confirmed",
    name: c.name || c.description || c.title || t(locale, "Confirmed"),
    currency: c.currency || "PLN"
  }));

  const confirmedByYear = groupBy(confirmed, tx => String(tx.date || "").slice(0, 4) || EMPTY_VALUE);
  const futureByPeriod = groupBy(future, tx => tx.period || String(tx.date || "").slice(0, 7) || EMPTY_VALUE);

  const confirmedHtml = confirmed.length
    ? [...confirmedByYear.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([year, yearTxs]) => {
        const byMonth = groupBy(yearTxs, tx => String(tx.date || "").slice(0, 7) || EMPTY_VALUE);

        return renderDetailsPanel(
          year,
          [...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, monthTxs]) =>
            renderDetailsPanel(month, renderTransactionTable(monthTxs, locale, { entityType: "confirmed", canEdit: false }))
          ).join("")
        );
      }).join("")
    : `<p>${escapeHtml(t(locale, "No confirmed transactions in API response"))}</p>`;

  const futureHtml = future.length
    ? [...futureByPeriod.entries()].map(([period, txs]) => {
        const summary = (cashflow?.periodSummaries || []).find(p => p.period === period);
        const extra = summary
          ? `<small>${formatMoney(summary.income, "PLN", locale)} / ${formatMoney(summary.expenses, "PLN", locale)}</small>`
          : "";

        const title = summary
          ? `${summary.start_date || period} - ${summary.end_date || period}`
          : period;

        return renderDetailsPanel(
          title,
          renderTransactionTable(txs, locale, {
            entityType: "future",
            canEdit: false,
            canMoveToPending: true
          }),
          { extra }
        );
      }).join("")
    : `<p>${escapeHtml(t(locale, "No future transactions"))}</p>`;

  return `
    <div class="cashflow-tab-content" data-cashflow-ledger-tab>
      ${renderBudgetPeriodStats(locale, cashflow)}
      ${renderFundingOverview(locale, cashflow)}

      <div class="panel">
        <h3>${escapeHtml(t(locale, "Pending"))}</h3>
        <div data-pending-list>
          ${renderTransactionTable(pending, locale, { entityType: "pending", canConfirmPending: true })}
        </div>
      </div>

      <div class="panel">
        <h3>${escapeHtml(t(locale, "Confirmed"))}</h3>
        ${confirmedHtml}
      </div>

      <div class="panel">
        <h3>${escapeHtml(t(locale, "Future"))}</h3>
        ${futureHtml}
      </div>
    </div>
  `;
}
