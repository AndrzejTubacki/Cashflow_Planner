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
