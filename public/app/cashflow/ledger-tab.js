import { escapeHtml } from "../utils.js";
import { DEFAULT_LEDGER_CURRENCY } from "./constants.js";
import { renderFundingOverview } from "./funding.js";
import { renderBudgetPeriodStats } from "./periods.js";
import { formatMoney, groupBy, hasCapability, renderDetailsPanel, t } from "./shared.js";
import { renderTransactionTable } from "./transactions.js";

const EMPTY_VALUE = "-";

export function renderLedgerTab(locale, cashflow) {
  const ledgerCurrency = cashflow?.settings?.ledger_currency || DEFAULT_LEDGER_CURRENCY;
  const canMaintain = hasCapability(cashflow, "budget:maintain");
  const pending = (cashflow?.pendingTransactions || []).map(p => ({
    ...p,
    entityType: "pending",
    name: p.name || p.description || p.title || t(locale, "Pending"),
    currency: p.currency || DEFAULT_LEDGER_CURRENCY
  }));

  const future = (cashflow?.futureTransactions || []).map(f => ({
    ...f,
    entityType: "future",
    name: f.name || f.description || f.title || t(locale, "Future"),
    currency: f.currency || DEFAULT_LEDGER_CURRENCY
  }));

  const confirmed = (cashflow?.confirmedTransactions || cashflow?.confirmed || []).map(c => ({
    ...c,
    entityType: "confirmed",
    name: c.name || c.description || c.title || t(locale, "Confirmed"),
    currency: c.currency || DEFAULT_LEDGER_CURRENCY
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
          ? `<small>${formatMoney(summary.income, ledgerCurrency, locale)} / ${formatMoney(summary.expenses, ledgerCurrency, locale)}</small>`
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
        <div class="cashflow-panel-heading">
          <h3>${escapeHtml(t(locale, "Pending"))}</h3>
          ${canMaintain ? `<button type="button" class="btn-small" data-cashflow-recalculate-pending>
            ${escapeHtml(t(locale, "Recalculate pending"))}
          </button>` : ""}
        </div>
        <div data-pending-list>
          ${renderTransactionTable(pending, locale, {
            entityType: "pending",
            canConfirmPending: true,
            canDelete: tx => {
              const oneOffId = tx.source_one_off_id || tx.sourceOneOffId || "";
              return Boolean(oneOffId && String(tx.occurrence_key || tx.occurrenceKey || "").startsWith(`one_off_remainder:${oneOffId}:`));
            },
            deleteEntityType: "pending",
            deleteLabel: "Dismiss remainder",
            deleteConfirm: "Dismiss this remainder? The one-off target will be reduced to the confirmed total."
          })}
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
