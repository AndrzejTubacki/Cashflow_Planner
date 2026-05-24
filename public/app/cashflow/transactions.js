import { escapeHtml } from "../utils.js";
import { asNumber, formatMoney, renderStatusBadge, t, transactionTypeLabel } from "./shared.js";

const EMPTY_VALUE = "-";
const DEFAULT_LEDGER_CURRENCY = "PLN";

function normalizeCurrencyCode(currency) {
  return String(currency || DEFAULT_LEDGER_CURRENCY).trim().toUpperCase() || DEFAULT_LEDGER_CURRENCY;
}

function hasMoneyValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function renderMoneyStack(amount, currency, locale, ledgerAmount = null, ledgerCurrency = DEFAULT_LEDGER_CURRENCY) {
  const displayCurrency = normalizeCurrencyCode(currency);
  const normalizedLedgerCurrency = normalizeCurrencyCode(ledgerCurrency);
  const shouldShowLedgerEquivalent =
    displayCurrency !== normalizedLedgerCurrency && hasMoneyValue(ledgerAmount);

  return `
    <div class="cashflow-amount-cell">
      <strong>${formatMoney(amount, displayCurrency, locale)}</strong>
      ${shouldShowLedgerEquivalent
        ? `<small>(${formatMoney(ledgerAmount, normalizedLedgerCurrency, locale)})</small>`
        : ""}
    </div>
  `;
}

function renderAmountCell(tx, locale) {
  const currency = tx.currency || DEFAULT_LEDGER_CURRENCY;
  const amount = asNumber(tx.amount, 0);
  const requested = tx.requested_amount ?? tx.requestedAmount;
  const funded = tx.funded_amount ?? tx.fundedAmount;
  const ledgerCurrency = tx.ledger_currency || tx.ledgerCurrency || DEFAULT_LEDGER_CURRENCY;
  const explicitLedgerAmount =
    tx.amount_ledger_amount ??
    tx.amountLedgerAmount ??
    tx.funded_ledger_amount ??
    tx.fundedLedgerAmount;
  const fallbackLedgerAmount = tx.ledger_amount ?? tx.ledgerAmount;
  const fallbackLedgerAmountCurrency =
    tx.ledger_amount_currency ||
    tx.ledgerAmountCurrency ||
    tx.ledger_currency ||
    tx.ledgerCurrency ||
    DEFAULT_LEDGER_CURRENCY;
  const ledgerAmount = hasMoneyValue(explicitLedgerAmount)
    ? explicitLedgerAmount
    : normalizeCurrencyCode(fallbackLedgerAmountCurrency) === normalizeCurrencyCode(ledgerCurrency)
      ? fallbackLedgerAmount
      : null;

  if (requested !== undefined && requested !== null && asNumber(requested) !== amount) {
    return `
      <div class="cashflow-amount-cell">
        <strong>${formatMoney(funded ?? amount, currency, locale)}</strong>
        ${normalizeCurrencyCode(currency) !== normalizeCurrencyCode(ledgerCurrency) && hasMoneyValue(ledgerAmount)
          ? `<small>(${formatMoney(ledgerAmount, ledgerCurrency, locale)})</small>`
          : ""}
        <small>${escapeHtml(t(locale, "of", "of"))} ${formatMoney(requested, currency, locale)}</small>
      </div>
    `;
  }

  return renderMoneyStack(amount, currency, locale, ledgerAmount, ledgerCurrency);
}

function renderLedgerAmountCell(tx, locale) {
  const ledgerAmount = tx.ledger_amount ?? tx.ledgerAmount;

  if (!hasMoneyValue(ledgerAmount)) {
    return EMPTY_VALUE;
  }

  const displayCurrency =
    tx.ledger_amount_currency ||
    tx.ledgerAmountCurrency ||
    tx.ledger_currency ||
    tx.ledgerCurrency ||
    DEFAULT_LEDGER_CURRENCY;
  const ledgerCurrency = tx.ledger_currency || tx.ledgerCurrency || DEFAULT_LEDGER_CURRENCY;
  const ledgerEquivalent =
    tx.ledger_amount_ledger_amount ??
    tx.ledgerAmountLedgerAmount ??
    null;

  return renderMoneyStack(ledgerAmount, displayCurrency, locale, ledgerEquivalent, ledgerCurrency);
}

function renderLedgerCell(tx, locale) {
  const ledgerAmount = tx.ledger_amount ?? tx.ledgerAmount;
  const runningBalance = tx.running_balance ?? tx.runningBalance;

  if (ledgerAmount === undefined && runningBalance === undefined) {
    return EMPTY_VALUE;
  }

  return `
    <div class="cashflow-ledger-cell">
      ${ledgerAmount !== undefined && ledgerAmount !== null
        ? `<small>${escapeHtml(t(locale, "PLN", "PLN"))}: ${formatMoney(ledgerAmount, "PLN", locale)}</small>`
        : ""}
      ${runningBalance !== undefined && runningBalance !== null
        ? `<small>${escapeHtml(t(locale, "Balance", "Balance"))}: ${formatMoney(runningBalance, "PLN", locale)}</small>`
        : ""}
    </div>
  `;
}

function renderTransactionRow(tx, locale, options = {}) {
  const showLedgerAmount = options.showLedgerAmount !== false;
  const showRunningBalance = options.showRunningBalance !== false;
  const entityType = options.entityType || tx.entityType || tx.source_type || "";
  const canEdit = typeof options.canEdit === "function"
    ? options.canEdit(tx)
    : options.canEdit !== false;
  const canMoveToPending = typeof options.canMoveToPending === "function"
    ? options.canMoveToPending(tx)
    : Boolean(options.canMoveToPending);
  const canConfirmPending = typeof options.canConfirmPending === "function"
    ? options.canConfirmPending(tx)
    : Boolean(options.canConfirmPending);
  const canDelete = typeof options.canDelete === "function"
    ? options.canDelete(tx)
    : Boolean(options.canDelete);
  const deleteEntityType = options.deleteEntityType || entityType;

  const runningBalance = tx.running_balance ?? tx.runningBalance;

  return `
    <tr data-tx-id="${escapeHtml(tx.id)}" data-tx-type="${escapeHtml(entityType)}">
      <td>${escapeHtml(tx.date || tx.period || tx.due_date || EMPTY_VALUE)}</td>
      <td>
        <strong>${escapeHtml(tx.name || EMPTY_VALUE)}</strong>
        ${tx.note ? `<small class="cashflow-note">${escapeHtml(tx.note)}</small>` : ""}
        ${tx.warning ? `<small class="cashflow-warning-text">${escapeHtml(String(tx.warning))}</small>` : ""}
      </td>
      <td>${escapeHtml(transactionTypeLabel(locale, tx.type))}</td>
      <td>${renderStatusBadge(locale, tx.status)}</td>
      <td>${renderAmountCell(tx, locale)}</td>
      ${showLedgerAmount ? `<td>${renderLedgerAmountCell(tx, locale)}</td>` : ""}
      ${showRunningBalance
        ? `<td>${
            runningBalance !== undefined && runningBalance !== null
              ? `<strong>${formatMoney(runningBalance, tx.ledger_currency || tx.ledgerCurrency || DEFAULT_LEDGER_CURRENCY, locale)}</strong>`
              : EMPTY_VALUE
          }</td>`
        : ""}
      <td>
        ${canConfirmPending
          ? `<button type="button" class="btn-small" data-cashflow-confirm-pending="${escapeHtml(tx.id)}" data-cashflow-confirm-pending-date="${escapeHtml(tx.date || "")}" data-cashflow-confirm-pending-amount="${escapeHtml(tx.funded_amount ?? tx.amount ?? "")}">${escapeHtml(t(locale, "Confirm", "Confirm"))}</button>`
          : ""}
        ${canMoveToPending
          ? `<button type="button" class="btn-small" data-cashflow-move-future-to-pending="${escapeHtml(tx.id)}" data-cashflow-move-future-occurrence-key="${escapeHtml(tx.occurrence_key || "")}">${escapeHtml(t(locale, "To pending", "To pending"))}</button>`
          : ""}
        ${canEdit
          ? `<button class="btn-small" data-edit-tx="${escapeHtml(tx.id)}" data-edit-entity="${escapeHtml(entityType)}">${escapeHtml(t(locale, "Edit", "Edit"))}</button>`
          : ""}
        ${canDelete
          ? `<button type="button" class="btn-small" data-cashflow-delete-tx="${escapeHtml(tx.id)}" data-cashflow-delete-entity="${escapeHtml(deleteEntityType)}">${escapeHtml(t(locale, "Delete", "Delete"))}</button>`
          : ""}
      </td>
    </tr>
  `;
}

function renderTransactionTable(transactions, locale, options = {}) {
  if (!transactions.length) {
    return `<p>${escapeHtml(t(locale, "None", "None"))}</p>`;
  }

  const showLedgerAmount = options.showLedgerAmount !== false;
  const showRunningBalance = options.showRunningBalance !== false;
  const ledgerAmountLabel = options.ledgerAmountLabel || t(locale, "Ledger amount", "Ledger amount");

  return `
    <table class="cashflow-table">
      <thead>
        <tr>
          <th>${escapeHtml(t(locale, "Date", "Date"))}</th>
          <th>${escapeHtml(t(locale, "Name", "Name"))}</th>
          <th>${escapeHtml(t(locale, "Type", "Type"))}</th>
          <th>${escapeHtml(t(locale, "Status", "Status"))}</th>
          <th>${escapeHtml(t(locale, "Amount", "Amount"))}</th>
          ${showLedgerAmount ? `<th>${escapeHtml(ledgerAmountLabel)}</th>` : ""}
          ${showRunningBalance ? `<th>${escapeHtml(t(locale, "Running balance", "Running balance"))}</th>` : ""}
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${transactions.map(tx => renderTransactionRow(tx, locale, options)).join("")}
      </tbody>
    </table>
  `;
}

export { renderLedgerCell, renderTransactionTable };
