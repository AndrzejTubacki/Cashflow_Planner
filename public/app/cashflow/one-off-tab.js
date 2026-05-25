import { escapeHtml } from "../utils.js";
import { renderDetailsPanel, t } from "./shared.js";
import { renderTransactionTable } from "./transactions.js";

export function renderOneOffTab(locale, cashflow) {
  const now = new Date().toISOString().slice(0, 10);
  const confirmedOneOffIds = new Set(
    (cashflow?.confirmedTransactions || [])
      .map(tx => tx.source_one_off_id)
      .filter(Boolean)
  );
  const pendingOneOffIds = new Set(
    (cashflow?.pendingTransactions || [])
      .map(tx => tx.source_one_off_id)
      .filter(Boolean)
  );

  const items = (cashflow?.oneOffs || []).map(o => {
    const isConfirmed = confirmedOneOffIds.has(o.id);
    const isPending = pendingOneOffIds.has(o.id);

    return {
      ...o,
      entityType: "one-off",
      date: o.date || o.created_at || "-",
      name: o.name || o.description || t(locale, "One-off"),
      type: o.type || "expense",
      status: isConfirmed ? "confirmed" : isPending || (o.date && o.date < now) ? "pending" : "funded",
      amount: Number(o.amount) || 0,
      currency: o.currency || "PLN",
      isConfirmed,
      isPending,
      canDelete: !isConfirmed
    };
  });

  const past = items.filter(i => i.isConfirmed || i.date < now);
  const future = items.filter(i => !i.isConfirmed && i.date >= now);

  return `
    <div class="cashflow-tab-content" data-cashflow-oneoff-tab>
      <div class="panel">
        <div class="cashflow-panel-heading">
          <h3>${escapeHtml(t(locale, "One-off"))}</h3>
          <div class="cashflow-tab-actions">
            <button class="btn-primary" data-cashflow-add-oneoff>${escapeHtml(t(locale, "Add transaction"))}</button>
          </div>
        </div>

        ${renderDetailsPanel(
          t(locale, "Future"),
          renderTransactionTable(future, locale, {
            entityType: "one-off",
            canEdit: true,
            canDelete: tx => tx.canDelete,
            deleteEntityType: "one-off"
          })
        )}

        ${renderDetailsPanel(
          t(locale, "Past"),
          renderTransactionTable(past, locale, {
            entityType: "one-off",
            canEdit: false,
            canDelete: tx => tx.canDelete,
            deleteEntityType: "one-off"
          })
        )}
      </div>
    </div>
  `;
}
