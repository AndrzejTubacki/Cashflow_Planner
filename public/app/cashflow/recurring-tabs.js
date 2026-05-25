import { escapeHtml } from "../utils.js";
import { formatMessage, t } from "./shared.js";
import { renderTransactionTable } from "./transactions.js";

export function renderRecurringExpensesTab(locale, cashflow) {
  const items = (cashflow?.recurringExpenses || []).map(r => {
    const total = Number(r.occurrence_total || 0);
    const funded = Number(r.occurrence_funded_count || 0);
    const partial = Number(r.occurrence_partial_count || 0);
    const underfunded = Number(r.occurrence_underfunded_count || 0);
    const skipped = Number(r.occurrence_skipped_count || 0);

    const occurrenceNote = total > 0
      ? [
          formatMessage(locale, "{funded}/{total} occurrences funded", { funded, total }),
          partial ? formatMessage(locale, "{count} partial", { count: partial }) : "",
          underfunded ? formatMessage(locale, "{count} underfunded", { count: underfunded }) : "",
          skipped ? formatMessage(locale, "{count} skipped", { count: skipped }) : ""
        ].filter(Boolean).join(" / ")
      : t(locale, "No occurrences in projection window");

    const currentPrediction = Number(r.current_prediction_amount ?? r.amount) || 0;
    const currentPredictionLedger = r.current_prediction_ledger_amount ?? null;

    return {
      ...r,
      entityType: "recurring-expense",
      date: r.anchor || r.period || r.anchor_type || "-",
      name: r.name,
      type: r.necessary ? t(locale, "Necessary") : t(locale, "Optional"),
      status: r.active ? "pending" : "disabled",
      amount: Number(r.amount) || 0,
      currency: r.currency || "PLN",
      ledger_amount: currentPrediction,
      ledger_amount_currency: r.currency || "PLN",
      ledger_amount_ledger_amount: currentPredictionLedger,
      ledger_currency: cashflow?.settings?.ledger_currency || "PLN",
      note: [
        r.active ? t(locale, "Active") : t(locale, "Disabled"),
        occurrenceNote
      ].join(" / ")
    };
  });

  return `
    <div class="cashflow-tab-content" data-cashflow-recurring-tab>
      <div class="panel">
        <div class="cashflow-panel-heading">
          <h3>${escapeHtml(t(locale, "Recurring expenses"))}</h3>
          <button class="btn-primary" data-cashflow-add-recurring>${escapeHtml(t(locale, "Add expense"))}</button>
        </div>
        <div data-recurring-list>
          ${renderTransactionTable(items, locale, {
            entityType: "recurring-expense",
            ledgerAmountLabel: t(locale, "Current prediction"),
            showRunningBalance: false
          })}
        </div>
      </div>
    </div>
  `;
}

export function renderRecurringIncomeTab(locale, cashflow) {
  const items = (cashflow?.recurringIncomes || []).map(r => ({
    ...r,
    entityType: "recurring-income",
    date: r.anchor || r.period || r.anchor_type || "-",
    type: "income",
    status: r.active ? "funded" : "pending",
    amount: Number(r.amount) || 0,
    currency: r.currency || "PLN",
    note: r.period_setting ? t(locale, "Defines budget period") : ""
  }));

  return `
    <div class="cashflow-tab-content" data-cashflow-income-tab>
      <div class="panel">
        <div class="cashflow-panel-heading">
          <h3>${escapeHtml(t(locale, "Recurring income"))}</h3>
          <div class="cashflow-tab-actions cashflow-panel-heading__actions">
            <button class="btn-primary" data-cashflow-add-income>${escapeHtml(t(locale, "Add income"))}</button>
          </div>
        </div>
        <div data-income-list>
          ${renderTransactionTable(items, locale, {
            entityType: "recurring-income",
            showLedgerAmount: false,
            showRunningBalance: false
          })}
        </div>
      </div>
    </div>
  `;
}
