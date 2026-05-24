import { todayWarsaw } from "./cashflow-date-utils.js";
import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";

export function createCashflowPendingConfirmationService({
  deletePendingOccurrence,
  findConfirmedOccurrence,
  getConfirmedFxForDate,
  newestConfirmedTransactionDate,
  openLedgerDb,
  openPlanningDb,
  recalculateLedgerRunningBalance,
  withProjectionStatus,
  wouldLedgerGoNegativeAfterInsert
}) {
  async function confirmPendingTransaction(userId, id, input = {}) {
    let result;

    const planningDb = openPlanningDb(userId);

    try {
      const pending = planningDb.prepare("SELECT * FROM pending_transactions WHERE id = ?").get(id);
      if (!pending) throw new Error("Pending transaction not found");

      const confirmedDate = String(input.confirmed_date || pending.date || todayWarsaw());
      const year = confirmedDate.slice(0, 4);
      const ledgerType = pending.type === "income" ? "income" : "expense";
      const occurrenceKey = pending.occurrence_key || occurrenceKeyFromRow({
        ...pending,
        type: ledgerType,
        date: confirmedDate
      });

      const settings = planningDb.prepare("SELECT * FROM settings WHERE id = 1").get();

      if (settings?.ledger_currency && settings.ledger_currency !== "PLN") {
        throw new Error("Only PLN ledger currency is supported");
      }

      if (pending.source_recurring_income_id) {
        const income = planningDb.prepare(`
          SELECT *
          FROM recurring_incomes
          WHERE id = ?
        `).get(pending.source_recurring_income_id);

        const newestConfirmed = newestConfirmedTransactionDate(userId);

        if (
          income?.period_setting &&
          newestConfirmed &&
          confirmedDate < newestConfirmed
        ) {
          throw new Error(
            "Period-setting income cannot be confirmed earlier than the newest confirmed ledger transaction"
          );
        }
      }

      const amount = Math.abs(Number(input.amount ?? pending.funded_amount ?? pending.amount) || 0);

      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error("Confirmed amount must be a non-negative number");
      }

      const alreadyConfirmed = findConfirmedOccurrence(userId, occurrenceKey);

      if (alreadyConfirmed) {
        deletePendingOccurrence(planningDb, occurrenceKey);
        result = alreadyConfirmed;
      } else {
        const fx = await getConfirmedFxForDate(pending.currency, confirmedDate, settings, input, userId);

        const candidate = {
          id,
          amount,
          type: ledgerType,
          date: confirmedDate,
          created_at: new Date().toISOString(),
          fx_rate: fx.fxRate,
          buffered_fx_rate: fx.bufferedFxRate
        };

        if (wouldLedgerGoNegativeAfterInsert(userId, candidate)) {
          throw new Error("Cannot confirm transaction because it would make the ledger balance negative");
        }

        const ledgerDb = openLedgerDb(userId, year);

        try {
          result = ledgerDb.transaction(() => {
            ledgerDb.prepare(`
              INSERT INTO confirmed_transactions (
                id, name, currency, amount, type, date, confirmed_date,
                fx_rate, buffered_fx_rate, running_balance_pln,
                source_recurring_expense_id, source_recurring_income_id, source_one_off_id,
                source_flex_id, source_goal_id, occurrence_key, ledger_amount,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            `).run(
              id,
              pending.name,
              pending.currency,
              amount,
              ledgerType,
              confirmedDate,
              confirmedDate,
              fx.fxRate,
              fx.bufferedFxRate,
              pending.source_recurring_expense_id || null,
              pending.source_recurring_income_id || null,
              pending.source_one_off_id || null,
              pending.source_flex_id || null,
              pending.source_goal_id || null,
              occurrenceKey,
              amount * fx.bufferedFxRate
            );

            return ledgerDb.prepare("SELECT * FROM confirmed_transactions WHERE id = ?").get(id);
          })();
        } finally {
          ledgerDb.close();
        }

        if (occurrenceKey) {
          deletePendingOccurrence(planningDb, occurrenceKey);
        } else {
          planningDb.prepare("DELETE FROM pending_transactions WHERE id = ?").run(id);
        }
      }
    } finally {
      planningDb.close();
    }

    recalculateLedgerRunningBalance(userId);
    return withProjectionStatus(userId, result);
  }

  return {
    confirmPendingTransaction
  };
}
