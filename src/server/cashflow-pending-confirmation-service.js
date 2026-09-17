import { DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { requireIsoDate, todayInTimezone } from "./cashflow-date-utils.js";
import { hasOwn, requireMoneyAmount, requireNumber } from "./cashflow-input-validation.js";
import {
  applyLedgerRunningBalancePlan,
  createLedgerRunningBalancePlan
} from "./cashflow-ledger-balance-plan.js";
import { multiplyMoney } from "./cashflow-money-utils.js";
import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";
import { badRequest, notFound } from "./cashflow-user-utils.js";

export function createCashflowPendingConfirmationService({
  budgetStore = null,
  deletePendingOccurrence,
  findConfirmedOccurrence,
  getConfirmedFxForDate,
  newestConfirmedTransactionDate,
  newestConfirmedTransactionDateAsync = null,
  openLedgerDb,
  openPlanningDb,
  recalculateLedgerRunningBalance,
  runRecoverableUserMutation,
  withProjectionStatus,
  wouldLedgerGoNegativeAfterInsert,
  wouldLedgerGoNegativeAfterInsertAsync = null
}) {
  async function confirmPendingTransaction(userId, id, input = {}) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return await confirmPendingTransactionWithBudgetStore(userId, id, input);
    }

    const planningDb = openPlanningDb(userId);
    let pending;
    let settings;
    let confirmedDate;
    let ledgerType;
    let occurrenceKey;
    let pendingHadOccurrenceKey;
    let ledgerCurrency;
    let amount;

    try {
      pending = planningDb.prepare("SELECT * FROM pending_transactions WHERE id = ?").get(id);
      if (!pending) throw notFound("Pending transaction not found");

      settings = planningDb.prepare("SELECT * FROM settings WHERE id = 1").get();
      confirmedDate = hasOwn(input, "confirmed_date")
        ? requireIsoDate(input.confirmed_date, "confirmed_date")
        : requireIsoDate(pending.date || todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE), "confirmed_date");
      ledgerType = pending.type === "income" ? "income" : "expense";
      pendingHadOccurrenceKey = Boolean(pending.occurrence_key);
      occurrenceKey = pending.occurrence_key || occurrenceKeyFromRow({
        ...pending,
        type: ledgerType,
        date: confirmedDate
      });

      ledgerCurrency = settings?.ledger_currency || "PLN";
      const latestCurrencyEvent = planningDb.prepare(`
        SELECT *
        FROM ledger_currency_events
        WHERE old_currency != new_currency
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get();

      if (latestCurrencyEvent && confirmedDate < String(latestCurrencyEvent.rate_date || "").slice(0, 10)) {
        throw badRequest("Cannot confirm transaction before the latest ledger currency change");
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
          throw badRequest(
            "Period-setting income cannot be confirmed earlier than the newest confirmed ledger transaction"
          );
        }
      }

      amount = hasOwn(input, "amount")
        ? requireMoneyAmount(input.amount, "amount", { min: 0 })
        : requireMoneyAmount(pending.funded_amount ?? pending.amount, "amount", { min: 0 });
      if (hasOwn(input, "fx_rate")) requireNumber(input.fx_rate, "fx_rate", { min: 0, exclusiveMin: true });
      if (hasOwn(input, "buffered_fx_rate")) {
        requireNumber(input.buffered_fx_rate, "buffered_fx_rate", { min: 0, exclusiveMin: true });
      }
    } finally {
      planningDb.close();
    }

    const alreadyConfirmed = findConfirmedOccurrence(userId, occurrenceKey);
    if (alreadyConfirmed) {
      const db = openPlanningDb(userId);
      try {
        if (pendingHadOccurrenceKey) {
          deletePendingOccurrence(db, occurrenceKey);
        } else {
          db.prepare("DELETE FROM pending_transactions WHERE id = ?").run(id);
        }
      } finally {
        db.close();
      }
      return withProjectionStatus(userId, alreadyConfirmed);
    }

    const fx = await getConfirmedFxForDate(pending.currency, confirmedDate, settings, input, userId);
    const candidate = {
      id,
      amount,
      type: ledgerType,
      date: confirmedDate,
      created_at: new Date().toISOString(),
      fx_rate: fx.fxRate,
      buffered_fx_rate: fx.bufferedFxRate,
      ledger_currency: ledgerCurrency
    };
    const isLedgerConversion = String(occurrenceKey || "").startsWith("ledger_currency_conversion:");

    if (!isLedgerConversion && wouldLedgerGoNegativeAfterInsert(userId, candidate)) {
      throw badRequest("Cannot confirm transaction because it would make the ledger balance negative");
    }

    return runRecoverableUserMutation(userId, "confirm_pending_transaction", async () => {
      const year = confirmedDate.slice(0, 4);
      const ledgerDb = openLedgerDb(userId, year);
      let result;
      try {
        result = ledgerDb.transaction(() => {
          ledgerDb.prepare(`
            INSERT INTO confirmed_transactions (
              id, name, currency, amount, type, date, confirmed_date,
              fx_rate, buffered_fx_rate, ledger_currency, running_balance_pln,
              source_recurring_expense_id, source_recurring_income_id, source_one_off_id,
              source_flex_id, source_goal_id, occurrence_key, ledger_amount,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
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
            ledgerCurrency,
            pending.source_recurring_expense_id || null,
            pending.source_recurring_income_id || null,
            pending.source_one_off_id || null,
            pending.source_flex_id || null,
            pending.source_goal_id || null,
            occurrenceKey,
            multiplyMoney(amount, fx.bufferedFxRate)
          );

          return ledgerDb.prepare("SELECT * FROM confirmed_transactions WHERE id = ?").get(id);
        })();
      } finally {
        ledgerDb.close();
      }

      const db = openPlanningDb(userId);
      try {
        if (pendingHadOccurrenceKey) {
          deletePendingOccurrence(db, occurrenceKey);
        } else {
          db.prepare("DELETE FROM pending_transactions WHERE id = ?").run(id);
        }
      } finally {
        db.close();
      }

      recalculateLedgerRunningBalance(userId);
      return withProjectionStatus(userId, result);
    });
  }

  function rowById(rows, id) {
    return (rows || []).find(row => String(row?.id) === String(id)) || null;
  }

  async function findConfirmedOccurrenceWithBudgetStore(userId, occurrenceKey) {
    if (!occurrenceKey) return null;
    const rows = await budgetStore.listConfirmedTransactions(userId);
    return rows.find(row =>
      row.occurrence_key === occurrenceKey
      || (!row.occurrence_key && occurrenceKeyFromRow(row) === occurrenceKey)
    ) || null;
  }

  async function confirmPendingTransactionWithBudgetStore(userId, id, input = {}) {
    const planningRows = await Promise.all([
      budgetStore.listPlanningRows(userId, "pending_transactions"),
      budgetStore.listPlanningRows(userId, "settings"),
      budgetStore.listPlanningRows(userId, "ledger_currency_events"),
      budgetStore.listPlanningRows(userId, "recurring_incomes")
    ]);
    const [pendingRows, settingsRows, ledgerCurrencyEvents, recurringIncomes] = planningRows;
    const pending = rowById(pendingRows, id);
    if (!pending) throw notFound("Pending transaction not found");

    const settings = settingsRows?.[0] || {};
    const confirmedDate = hasOwn(input, "confirmed_date")
      ? requireIsoDate(input.confirmed_date, "confirmed_date")
      : requireIsoDate(pending.date || todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE), "confirmed_date");
    const ledgerType = pending.type === "income" ? "income" : "expense";
    const pendingHadOccurrenceKey = Boolean(pending.occurrence_key);
    const occurrenceKey = pending.occurrence_key || occurrenceKeyFromRow({
      ...pending,
      type: ledgerType,
      date: confirmedDate
    });
    const ledgerCurrency = settings?.ledger_currency || "PLN";

    const latestCurrencyEvent = [...(ledgerCurrencyEvents || [])]
      .filter(event => event.old_currency !== event.new_currency)
      .sort((a, b) =>
        String(b.created_at || "").localeCompare(String(a.created_at || ""))
        || String(b.id || "").localeCompare(String(a.id || ""))
      )[0] || null;
    if (latestCurrencyEvent && confirmedDate < String(latestCurrencyEvent.rate_date || "").slice(0, 10)) {
      throw badRequest("Cannot confirm transaction before the latest ledger currency change");
    }

    if (pending.source_recurring_income_id) {
      const income = (recurringIncomes || [])
        .find(row => row.id === pending.source_recurring_income_id);
      const newestConfirmed = typeof newestConfirmedTransactionDateAsync === "function"
        ? await newestConfirmedTransactionDateAsync(userId)
        : newestConfirmedTransactionDate(userId);
      if (income?.period_setting && newestConfirmed && confirmedDate < newestConfirmed) {
        throw badRequest(
          "Period-setting income cannot be confirmed earlier than the newest confirmed ledger transaction"
        );
      }
    }

    const amount = hasOwn(input, "amount")
      ? requireMoneyAmount(input.amount, "amount", { min: 0 })
      : requireMoneyAmount(pending.funded_amount ?? pending.amount, "amount", { min: 0 });
    if (hasOwn(input, "fx_rate")) requireNumber(input.fx_rate, "fx_rate", { min: 0, exclusiveMin: true });
    if (hasOwn(input, "buffered_fx_rate")) {
      requireNumber(input.buffered_fx_rate, "buffered_fx_rate", { min: 0, exclusiveMin: true });
    }

    const alreadyConfirmed = await findConfirmedOccurrenceWithBudgetStore(userId, occurrenceKey);
    if (alreadyConfirmed) {
      await budgetStore.deletePlanningRowsById(userId, "pending_transactions", [id]);
      return withProjectionStatus(userId, alreadyConfirmed);
    }

    const fx = await getConfirmedFxForDate(pending.currency, confirmedDate, settings, input, userId);
    const now = new Date().toISOString();
    const candidate = {
      id,
      amount,
      type: ledgerType,
      date: confirmedDate,
      created_at: now,
      fx_rate: fx.fxRate,
      buffered_fx_rate: fx.bufferedFxRate,
      ledger_currency: ledgerCurrency
    };
    const isLedgerConversion = String(occurrenceKey || "").startsWith("ledger_currency_conversion:");

    const negative = typeof wouldLedgerGoNegativeAfterInsertAsync === "function"
      ? await wouldLedgerGoNegativeAfterInsertAsync(userId, candidate, { ledgerCurrency, settings })
      : wouldLedgerGoNegativeAfterInsert(userId, candidate);
    if (!isLedgerConversion && negative) {
      throw badRequest("Cannot confirm transaction because it would make the ledger balance negative");
    }

    return runRecoverableUserMutation(userId, "confirm_pending_transaction", async () => {
      const year = Number(confirmedDate.slice(0, 4));
      const result = await budgetStore.transaction(async writer => {
        if (typeof writer.lockBudgetLedger === "function") {
          await writer.lockBudgetLedger(userId);
        }

        await writer.insertConfirmedTransactions(userId, [{
          amount,
          buffered_fx_rate: fx.bufferedFxRate,
          confirmed_date: confirmedDate,
          created_at: now,
          currency: pending.currency,
          date: confirmedDate,
          fx_rate: fx.fxRate,
          id,
          ledger_amount: multiplyMoney(amount, fx.bufferedFxRate),
          ledger_currency: ledgerCurrency,
          ledger_year: year,
          name: pending.name,
          occurrence_key: occurrenceKey,
          running_balance_pln: 0,
          source_flex_id: pending.source_flex_id || null,
          source_goal_id: pending.source_goal_id || null,
          source_one_off_id: pending.source_one_off_id || null,
          source_recurring_expense_id: pending.source_recurring_expense_id || null,
          source_recurring_income_id: pending.source_recurring_income_id || null,
          type: ledgerType,
          updated_at: now
        }]);

        const plan = await createLedgerRunningBalancePlan({
          budgetId: userId,
          budgetStore: writer,
          ledgerCurrency,
          openingBalance: 0
        });
        await applyLedgerRunningBalancePlan({
          budgetStore: writer,
          plan
        });
        await writer.deletePlanningRowsById(userId, "pending_transactions", [id]);

        return rowById(await writer.listConfirmedTransactions(userId, { ledgerYear: year }), id);
      });

      return withProjectionStatus(userId, result);
    });
  }

  return {
    confirmPendingTransaction
  };
}
