import { t } from "./i18n.js";

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function currencyCode(value, fallback = "PLN") {
  return String(value || fallback).trim().toUpperCase() || fallback;
}

// Projection and ledger rows use several generations of snake/camel-case fields.
export function transactionMoneyDisplay(tx, fallbackLedgerCurrency = "PLN") {
  const amount = Number(tx?.amount) || 0;
  const requestedRaw = tx?.requested_amount ?? tx?.requestedAmount;
  const fundedRaw = tx?.funded_amount ?? tx?.fundedAmount;
  const requested = hasValue(requestedRaw) ? Number(requestedRaw) : null;
  const funded = hasValue(fundedRaw) ? Number(fundedRaw) : amount;
  const isPartiallyFunded = requested !== null && Math.abs(requested - amount) > 0.0001;
  const currency = currencyCode(tx?.currency);
  const ledgerCurrency = currencyCode(tx?.ledger_currency ?? tx?.ledgerCurrency, fallbackLedgerCurrency);
  const explicitLedgerAmount = tx?.amount_ledger_amount
    ?? tx?.amountLedgerAmount
    ?? tx?.funded_ledger_amount
    ?? tx?.fundedLedgerAmount;
  const fallbackLedgerAmount = tx?.ledger_amount ?? tx?.ledgerAmount;
  const fallbackLedgerAmountCurrency = currencyCode(
    tx?.ledger_amount_currency ?? tx?.ledgerAmountCurrency ?? ledgerCurrency,
    ledgerCurrency
  );
  const ledgerAmount = hasValue(explicitLedgerAmount)
    ? Number(explicitLedgerAmount)
    : hasValue(fallbackLedgerAmount) && fallbackLedgerAmountCurrency === ledgerCurrency
      ? Number(fallbackLedgerAmount)
      : null;

  return {
    currency,
    displayAmount: isPartiallyFunded ? funded : amount,
    isPartiallyFunded,
    ledgerAmount: Number.isFinite(ledgerAmount) ? ledgerAmount : null,
    ledgerCurrency,
    requested: Number.isFinite(requested) ? requested : null,
    runningBalanceCurrency: ledgerCurrency
  };
}

export function recurringExpensePredictionDisplay(row, fallbackLedgerCurrency = "PLN") {
  const currency = currencyCode(row?.currency);
  const ledgerCurrency = currencyCode(row?.ledger_currency ?? row?.ledgerCurrency, fallbackLedgerCurrency);
  const amount = Number(row?.current_prediction_amount ?? row?.amount) || 0;
  const ledgerRaw = row?.current_prediction_ledger_amount ?? row?.currentPredictionLedgerAmount;
  const ledgerAmount = hasValue(ledgerRaw) && Number.isFinite(Number(ledgerRaw)) ? Number(ledgerRaw) : null;
  return { amount, currency, ledgerAmount, ledgerCurrency };
}

// Keep the posted ledger amount separate from the native amount conversion.
export function transactionLedgerDisplay(tx, fallbackLedgerCurrency = "PLN") {
  const raw = tx?.ledger_amount ?? tx?.ledgerAmount;
  if (!hasValue(raw) || !Number.isFinite(Number(raw))) return null;
  const native = transactionMoneyDisplay(tx, fallbackLedgerCurrency);
  const currency = currencyCode(tx?.ledger_amount_currency ?? tx?.ledgerAmountCurrency, native.ledgerCurrency);
  const equivalentRaw = tx?.ledger_amount_ledger_amount ?? tx?.ledgerAmountLedgerAmount;
  const equivalent = hasValue(equivalentRaw) && Number.isFinite(Number(equivalentRaw)) ? Number(equivalentRaw) : null;
  const amount = Number(raw);
  if (currency === native.currency && Math.abs(amount - native.displayAmount) < 0.0001
    && (equivalent === null || equivalent === native.ledgerAmount)) return null;
  return { amount, currency, equivalent, ledgerCurrency: native.ledgerCurrency };
}

export function transactionTypeLabel(type) {
  const labels = { income: t("Income"), expense: t("Expense"), goal_allocation: t("Goal allocation") };
  return labels[type] || type || "-";
}
