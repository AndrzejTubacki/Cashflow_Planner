export function createCashflowPredictionService({
  listLedgerYears,
  openLedgerDb
}) {
  function loadConfirmedTransactions(userId, sinceDate = null) {
    const rows = [];

    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        const result = ledgerDb.prepare(`
          SELECT *
          FROM confirmed_transactions
          ${sinceDate ? "WHERE date >= ?" : ""}
          ORDER BY date ASC
        `).all(...(sinceDate ? [sinceDate] : []));

        rows.push(...result);
      } finally {
        ledgerDb.close();
      }
    }

    return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  function twelveMonthsAgoDate(today) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 12);
    return d.toISOString().slice(0, 10);
  }

  function predictedAmountForRecurringExpense(userId, expense, today) {
    if (expense.prediction_strategy !== "12month_max") {
      return Number(expense.amount || 0);
    }

    const since = twelveMonthsAgoDate(today);
    const rows = loadConfirmedTransactions(userId, since)
      .filter(tx => tx.source_recurring_expense_id === expense.id && tx.type === "expense");

    if (!rows.length) return Number(expense.amount || 0);

    return Math.max(...rows.map(tx => Number(tx.amount || 0)));
  }

  function predictedAmountForRecurringIncome(userId, income, today) {
    if (income.prediction_strategy !== "12month_min") {
      return Number(income.amount || 0);
    }

    const since = twelveMonthsAgoDate(today);
    const rows = loadConfirmedTransactions(userId, since)
      .filter(tx => tx.source_recurring_income_id === income.id && tx.type === "income");

    if (!rows.length) return Number(income.amount || 0);

    return Math.min(...rows.map(tx => Number(tx.amount || 0)));
  }
  return {
    loadConfirmedTransactions,
    predictedAmountForRecurringExpense,
    predictedAmountForRecurringIncome
  };
}

