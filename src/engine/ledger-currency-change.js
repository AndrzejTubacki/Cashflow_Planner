import { multiplyMoney, roundMoneyAmount } from './cashflow-money-utils.js';

/** Shared conversion arithmetic; never reinterpret amounts of older payments. */
export function ledgerConversionBalances(oldBalance, rate) {
  if (!Number.isFinite(oldBalance) || !Number.isFinite(rate) || rate <= 0) throw new Error('Invalid ledger conversion balance or rate');
  return { oldBalance: roundMoneyAmount(oldBalance), convertedOpeningBalance: multiplyMoney(oldBalance, rate) };
}

/** Storage-neutral browser-compatible audit and visible pending payment. IDs and
 * dates belong to the host, so embedded runtimes need no random/time APIs. */
export function ledgerConversionRecords(change, { eventId, pendingId, timestamp }) {
  const { oldCurrency, newCurrency, oldBalance, convertedOpeningBalance, rate, rateDate, source } = change;
  const amount = roundMoneyAmount(Math.abs(convertedOpeningBalance));
  return {
    event: { id: eventId, old_currency: oldCurrency, new_currency: newCurrency, old_balance: oldBalance,
      converted_opening_balance: convertedOpeningBalance, fx_rate: rate, rate_date: rateDate, source,
      details: JSON.stringify({ reason: 'settings-update' }), created_at: timestamp },
    pending: { id: pendingId, name: `Opening balance conversion ${oldCurrency} to ${newCurrency}`,
      currency: newCurrency, amount, type: convertedOpeningBalance >= 0 ? 'income' : 'expense', date: rateDate,
      fx_rate: 1, buffered_fx_rate: 1, ledger_currency: newCurrency, status: 'pending', funded_amount: amount,
      requested_amount: amount, ledger_amount: amount, pending_origin: 'system',
      occurrence_key: `ledger_currency_conversion:${pendingId}`, created_at: timestamp, updated_at: timestamp,
      note: JSON.stringify({ kind: 'ledger_currency_conversion', old_currency: oldCurrency, new_currency: newCurrency,
        old_balance: oldBalance, converted_balance: convertedOpeningBalance, fx_rate: rate, rate_date: rateDate, source }) }
  };
}
