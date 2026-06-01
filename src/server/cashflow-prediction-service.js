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

  function recordedMonthCount(rows) {
    const months = new Set(rows.map(tx => String(tx.date || "").slice(0, 7)).filter(Boolean));
    return months.size;
  }

  function normalExtreme(amounts, direction) {
    return direction === "min"
      ? Math.min(...amounts)
      : Math.max(...amounts);
  }

  function medianAmount(amounts) {
    const sorted = [...amounts].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function compareConfirmedRows(a, b) {
    const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
    if (dateCompare !== 0) return dateCompare;

    const createdCompare = String(a.created_at || "").localeCompare(String(b.created_at || ""));
    if (createdCompare !== 0) return createdCompare;

    return String(a.id || "").localeCompare(String(b.id || ""));
  }

  function previousYearMonth(occurrenceDate) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(occurrenceDate || ""));
    if (!match) return "";

    return `${String(Number(match[1]) - 1).padStart(4, "0")}-${match[2]}`;
  }

  function normalizeMinRecordedMonths(value) {
    const parsed = Math.trunc(Number(value));

    if (!Number.isFinite(parsed)) return 6;
    return Math.max(1, Math.min(12, parsed));
  }

  function predictedTwelveMonthAmount({
    rows,
    startingAmount,
    direction,
    substituteMissing,
    occurrenceDate,
    minRecordedMonths
  }) {
    const amounts = rows.map(tx => Number(tx.amount || 0));

    if (!amounts.length) return startingAmount;
    if (recordedMonthCount(rows) >= 12 || substituteMissing === "none") {
      return normalExtreme(amounts, direction);
    }

    const extreme = normalExtreme(amounts, direction);

    if (substituteMissing === "starting_value") {
      return normalExtreme([...amounts, startingAmount], direction);
    }

    if (substituteMissing === "average_extreme_starting_value") {
      return normalExtreme([...amounts, (extreme + startingAmount) / 2], direction);
    }

    if (substituteMissing === "median_recorded") {
      return medianAmount(amounts);
    }

    if (substituteMissing === "last_confirmed") {
      const latest = [...rows].sort(compareConfirmedRows).at(-1);
      return latest ? Number(latest.amount || 0) : startingAmount;
    }

    if (substituteMissing === "previous_year_same_month") {
      const targetMonth = previousYearMonth(occurrenceDate);
      const matching = rows
        .filter(tx => String(tx.date || "").slice(0, 7) === targetMonth)
        .sort(compareConfirmedRows)
        .at(-1);

      return matching ? Number(matching.amount || 0) : startingAmount;
    }

    if (substituteMissing === "require_min_recorded_months") {
      return recordedMonthCount(rows) < normalizeMinRecordedMonths(minRecordedMonths)
        ? startingAmount
        : normalExtreme(amounts, direction);
    }

    return normalExtreme(amounts, direction);
  }

  function predictedAmountForRecurringExpense(userId, expense, today, occurrenceDate = today) {
    const startingAmount = Number(expense.amount || 0);

    if (expense.prediction_strategy !== "12month_max") {
      return startingAmount;
    }

    const since = twelveMonthsAgoDate(today);
    const rows = loadConfirmedTransactions(userId, since)
      .filter(tx => tx.source_recurring_expense_id === expense.id && tx.type === "expense");

    return predictedTwelveMonthAmount({
      rows,
      startingAmount,
      direction: "max",
      substituteMissing: expense.prediction_substitute_missing || "none",
      occurrenceDate,
      minRecordedMonths: expense.prediction_min_recorded_months
    });
  }

  function predictedAmountForRecurringIncome(userId, income, today, occurrenceDate = today) {
    const startingAmount = Number(income.amount || 0);

    if (income.prediction_strategy !== "12month_min") {
      return startingAmount;
    }

    const since = twelveMonthsAgoDate(today);
    const rows = loadConfirmedTransactions(userId, since)
      .filter(tx => tx.source_recurring_income_id === income.id && tx.type === "income");

    return predictedTwelveMonthAmount({
      rows,
      startingAmount,
      direction: "min",
      substituteMissing: income.prediction_substitute_missing || "none",
      occurrenceDate,
      minRecordedMonths: income.prediction_min_recorded_months
    });
  }
  return {
    loadConfirmedTransactions,
    predictedAmountForRecurringExpense,
    predictedAmountForRecurringIncome
  };
}

