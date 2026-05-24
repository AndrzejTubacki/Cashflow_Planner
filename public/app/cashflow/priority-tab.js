import { escapeHtml } from "../utils.js";
import { asNumber, formatMoney, t } from "./shared.js";

const EMPTY_VALUE = "-";

export function renderPriorityTab(locale, cashflow) {
  const recurring = (cashflow?.recurringExpenses || []).map(item => ({
    ...item,
    entityType: "recurring-expense",
    priorityDomain: "operating",
    label: t(locale, "Recurring expense", "Recurring expense")
  }));

  const flex = (cashflow?.flexTransactions || []).map(item => ({
    ...item,
    entityType: "flex",
    priorityDomain: "operating",
    label: t(locale, "Flex", "Flex")
  }));

  const goals = (cashflow?.goals || []).map(item => ({
    ...item,
    entityType: "goal",
    priorityDomain: "goal",
    label: t(locale, "Goal", "Goal")
  }));

  const operating = [...recurring, ...flex].sort((a, b) => asNumber(a.priority, 9999) - asNumber(b.priority, 9999));
  const goalPriority = goals.sort((a, b) => asNumber(a.priority, 9999) - asNumber(b.priority, 9999));

  const renderPriorityList = (items, emptyText) => {
    if (!items.length) return `<p>${escapeHtml(emptyText)}</p>`;

    return `
      <table class="cashflow-table">
        <thead>
          <tr>
            <th>${escapeHtml(t(locale, "Priority", "Priority"))}</th>
            <th>${escapeHtml(t(locale, "Type", "Type"))}</th>
            <th>${escapeHtml(t(locale, "Name", "Name"))}</th>
            <th>${escapeHtml(t(locale, "Amount", "Amount"))}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${items.map(item => `
            <tr>
              <td>${escapeHtml(String(item.priority ?? EMPTY_VALUE))}</td>
              <td>${escapeHtml(item.label)}</td>
              <td>${escapeHtml(item.name || EMPTY_VALUE)}</td>
              <td>${formatMoney(item.amount, item.currency || "PLN", locale)}</td>
              <td>
                <button class="btn-small" data-edit-tx="${escapeHtml(item.id)}" data-edit-entity="${escapeHtml(item.entityType)}">${escapeHtml(t(locale, "Edit", "Edit"))}</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  };

  return `
    <div class="cashflow-tab-content" data-cashflow-priority-tab>
      <div class="panel">
        <h3>${escapeHtml(t(locale, "Operating priority", "Operating priority"))}</h3>
        ${renderPriorityList(operating, t(locale, "No operating priorities", "No operating priorities"))}
      </div>

      <div class="panel">
        <h3>${escapeHtml(t(locale, "Goal priority", "Goal priority"))}</h3>
        ${renderPriorityList(goalPriority, t(locale, "No goals", "No goals"))}
      </div>
    </div>
  `;
}
