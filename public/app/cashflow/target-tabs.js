import { escapeHtml } from "../utils.js";
import { formatMoney, t } from "./shared.js";
import { renderTransactionTable } from "./transactions.js";

const EMPTY_VALUE = "-";

export function renderGoalsTab(locale, cashflow) {
  const items = (cashflow?.goals || []).map(g => {
    const originalTarget = Number(g.amount || 0);
    const targetLedger = Number(g.target_ledger_amount || 0);

    const fundedLedger =
      Number(g.already_funded_ledger || 0) +
      Number(g.pending_allocated_ledger || 0) +
      Number(g.future_allocated_ledger || 0);

    const fundedOriginal = targetLedger > 0
      ? Math.min(originalTarget, (fundedLedger / targetLedger) * originalTarget)
      : 0;

    return {
      ...g,
      entityType: "goal",
      date: g.due_date || g.target_date || EMPTY_VALUE,
      name: g.name,
      type: "goal_allocation",
      status: g.fx_missing ? "underfunded" : (Number(g.remaining_ledger || 0) > 0 ? "partial" : "funded"),

      // These must stay in the goal's native currency.
      amount: originalTarget,
      requested_amount: originalTarget,
      funded_amount: fundedOriginal,
      funded_ledger_amount: fundedLedger,
      currency: g.currency || "PLN",

      // These are separate PLN ledger values.
      ledger_amount: targetLedger,
      running_balance: null,

      note: [
        `${t(locale, "Priority", "Priority")}: ${g.priority ?? EMPTY_VALUE}`,
        `${t(locale, "Target in PLN", "Target in PLN")}: ${targetLedger ? formatMoney(targetLedger, "PLN", locale) : EMPTY_VALUE}`,
        `${t(locale, "Remaining", "Remaining")}: ${g.remaining_ledger === null ? EMPTY_VALUE : formatMoney(g.remaining_ledger, "PLN", locale)}`
      ].join(" / ")
    };
  });

  return `
    <div class="cashflow-tab-content" data-cashflow-goals-tab>
      <div class="panel">
        <div class="cashflow-panel-heading">
          <h3>${escapeHtml(t(locale, "Goals", "Goals"))}</h3>
          <div class="cashflow-tab-actions">
            <button class="btn-primary" data-cashflow-add-goal>${escapeHtml(t(locale, "Add goal", "Add goal"))}</button>
          </div>
        </div>
        <div data-goals-list>
          ${renderTransactionTable(items, locale, {
            entityType: "goal",
            canDelete: tx => Number(tx.already_funded_ledger || 0) <= 0,
            deleteEntityType: "goal"
          })}
        </div>
      </div>
    </div>
  `;
}

export function renderFlexTab(locale, cashflow) {
  const items = (cashflow?.flexTransactions || []).map(f => {
    const originalTarget = Number(f.amount || 0);
    const targetLedger = Number(f.target_ledger_amount || 0);

    const fundedLedger =
      Number(f.already_funded_ledger || 0) +
      Number(f.pending_allocated_ledger || 0) +
      Number(f.future_allocated_ledger || 0);

    const fundedOriginal = targetLedger > 0
      ? Math.min(originalTarget, (fundedLedger / targetLedger) * originalTarget)
      : 0;

    return {
      ...f,
      entityType: "flex",
      date: f.funded_by_date || EMPTY_VALUE,
      name: f.name,
      type: "expense",
      status: f.fx_missing ? "underfunded" : (Number(f.remaining_ledger || 0) > 0 ? "partial" : "funded"),

      amount: originalTarget,
      requested_amount: originalTarget,
      funded_amount: fundedOriginal,
      funded_ledger_amount: fundedLedger,
      currency: f.currency || "PLN",

      ledger_amount: targetLedger,
      running_balance: null,

      note: [
        `${t(locale, "Priority", "Priority")}: ${f.priority ?? EMPTY_VALUE}`,
        f.allow_split ? t(locale, "Splittable", "Splittable") : t(locale, "Full only", "Full only"),
        f.funded_by_date ? `${t(locale, "Funded by", "Funded by")}: ${f.funded_by_date}` : t(locale, "No funding date", "No funding date"),
        `${t(locale, "Target in PLN", "Target in PLN")}: ${targetLedger ? formatMoney(targetLedger, "PLN", locale) : EMPTY_VALUE}`,
        `${t(locale, "Remaining", "Remaining")}: ${f.remaining_ledger === null ? EMPTY_VALUE : formatMoney(f.remaining_ledger, "PLN", locale)}`
      ].join(" / ")
    };
  });

  return `
    <div class="cashflow-tab-content" data-cashflow-flex-tab>
      <div class="panel">
        <div class="cashflow-panel-heading">
          <h3>${escapeHtml(t(locale, "Flex", "Flex"))}</h3>
          <div class="cashflow-tab-actions">
            <button class="btn-primary" data-cashflow-add-flex>${escapeHtml(t(locale, "Add flex", "Add flex"))}</button>
          </div>
        </div>
        <div data-flex-list>
          ${renderTransactionTable(items, locale, {
            entityType: "flex",
            canDelete: tx => Number(tx.already_funded_ledger || 0) <= 0,
            deleteEntityType: "flex"
          })}
        </div>
      </div>
    </div>
  `;
}
