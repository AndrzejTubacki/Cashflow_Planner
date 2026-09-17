function twelveMonthsAgoDatePure(today) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 12);
  return d.toISOString().slice(0, 10);
}

function recordedMonthCountPure(rows) {
  const months = new Set(rows.map(tx => String(tx.date || "").slice(0, 7)).filter(Boolean));
  return months.size;
}

function normalExtremePure(amounts, direction) {
  return direction === "min" ? Math.min(...amounts) : Math.max(...amounts);
}

function medianAmountPure(amounts) {
  const sorted = [...amounts].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compareConfirmedRowsPure(a, b) {
  const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
  if (dateCompare !== 0) return dateCompare;
  const createdCompare = String(a.created_at || "").localeCompare(String(b.created_at || ""));
  if (createdCompare !== 0) return createdCompare;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function previousYearMonthPure(occurrenceDate) {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(occurrenceDate || ""));
  if (!match) return "";
  return `${String(Number(match[1]) - 1).padStart(4, "0")}-${match[2]}`;
}

function normalizeMinRecordedMonthsPure(value) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return 6;
  return Math.max(1, Math.min(12, parsed));
}

function normalizePredictionNamePure(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizePredictionCurrencyPure(value) {
  return String(value || "").trim().toUpperCase();
}

export function rowsInPredictionWindowPure(rows, occurrenceDate) {
  const cutoffDate = String(occurrenceDate || "");
  const startDate = twelveMonthsAgoDatePure(cutoffDate);
  return rows.filter(tx => {
    const txDate = String(tx.date || "");
    return txDate >= startDate && txDate <= cutoffDate;
  });
}

export function matchesRecurringPredictionSourcePure(tx, item, { sourceColumn, type }) {
  if (tx?.type !== type) return false;

  const sourceId = String(tx?.[sourceColumn] || "");
  if (sourceId === item.id) return true;
  if (sourceId) return false;

  const itemName = normalizePredictionNamePure(item?.name);
  const txName = normalizePredictionNamePure(tx?.name);
  if (!itemName || !txName || itemName !== txName) return false;

  const itemCurrency = normalizePredictionCurrencyPure(item?.currency);
  const txCurrency = normalizePredictionCurrencyPure(tx?.currency);
  return Boolean(itemCurrency && txCurrency && itemCurrency === txCurrency);
}

export function predictedTwelveMonthAmountPure({
  rows,
  startingAmount,
  direction,
  substituteMissing,
  occurrenceDate,
  minRecordedMonths
}) {
  const amounts = rows.map(tx => Number(tx.amount || 0));

  if (!amounts.length) return startingAmount;
  if (recordedMonthCountPure(rows) >= 12 || substituteMissing === "none") {
    return normalExtremePure(amounts, direction);
  }

  const extreme = normalExtremePure(amounts, direction);

  if (substituteMissing === "starting_value") {
    return normalExtremePure([...amounts, startingAmount], direction);
  }

  if (substituteMissing === "average_extreme_starting_value") {
    return normalExtremePure([...amounts, (extreme + startingAmount) / 2], direction);
  }

  if (substituteMissing === "median_recorded") {
    return medianAmountPure(amounts);
  }

  if (substituteMissing === "last_confirmed") {
    const latest = [...rows].sort(compareConfirmedRowsPure).at(-1);
    return latest ? Number(latest.amount || 0) : startingAmount;
  }

  if (substituteMissing === "previous_year_same_month") {
    const targetMonth = previousYearMonthPure(occurrenceDate);
    const matching = rows
      .filter(tx => String(tx.date || "").slice(0, 7) === targetMonth)
      .sort(compareConfirmedRowsPure)
      .at(-1);

    return matching ? Number(matching.amount || 0) : startingAmount;
  }

  if (substituteMissing === "require_min_recorded_months") {
    return recordedMonthCountPure(rows) < normalizeMinRecordedMonthsPure(minRecordedMonths)
      ? startingAmount
      : normalExtremePure(amounts, direction);
  }

  return normalExtremePure(amounts, direction);
}

/**
 * Pure variant of predictedAmountForRecurringExpense: `confirmedRows` is a
 * required array (already loaded by the caller), so this never touches a
 * database. Behaviorally identical to the factory's sync/async versions when
 * they're called with a real confirmedRows array (their only DB-touching
 * branch is the one this function doesn't have).
 */
export function predictedAmountForRecurringExpensePure({ expense, today, occurrenceDate = today, confirmedRows = [] }) {
  const startingAmount = Number(expense.amount || 0);
  if (expense.prediction_strategy !== "12month_max") return startingAmount;

  const predictionDate = occurrenceDate || today;
  const rows = rowsInPredictionWindowPure(confirmedRows, predictionDate)
    .filter(tx => matchesRecurringPredictionSourcePure(tx, expense, {
      sourceColumn: "source_recurring_expense_id",
      type: "expense"
    }));

  return predictedTwelveMonthAmountPure({
    rows,
    startingAmount,
    direction: "max",
    substituteMissing: expense.prediction_substitute_missing || "none",
    occurrenceDate,
    minRecordedMonths: expense.prediction_min_recorded_months
  });
}

/** Pure variant of predictedAmountForRecurringIncome — see the expense version's note. */
export function predictedAmountForRecurringIncomePure({ income, today, occurrenceDate = today, confirmedRows = [] }) {
  const startingAmount = Number(income.amount || 0);
  if (income.prediction_strategy !== "12month_min") return startingAmount;

  const predictionDate = occurrenceDate || today;
  const rows = rowsInPredictionWindowPure(confirmedRows, predictionDate)
    .filter(tx => matchesRecurringPredictionSourcePure(tx, income, {
      sourceColumn: "source_recurring_income_id",
      type: "income"
    }));

  return predictedTwelveMonthAmountPure({
    rows,
    startingAmount,
    direction: "min",
    substituteMissing: income.prediction_substitute_missing || "none",
    occurrenceDate,
    minRecordedMonths: income.prediction_min_recorded_months
  });
}

export function createCashflowPredictionService({
  budgetStore = null,
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

  async function loadConfirmedTransactionsAsync(userId, sinceDate = null) {
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return loadConfirmedTransactions(userId, sinceDate);
    }

    const rows = await budgetStore.listConfirmedTransactions(userId);
    return rows
      .filter(row => !sinceDate || String(row.date || "") >= sinceDate)
      .sort(compareConfirmedRows);
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

  function confirmedRowsForPrediction(userId, today, confirmedRows = null) {
    if (Array.isArray(confirmedRows)) return confirmedRows;
    return loadConfirmedTransactions(userId, twelveMonthsAgoDate(today));
  }

  async function confirmedRowsForPredictionAsync(userId, today, confirmedRows = null) {
    if (Array.isArray(confirmedRows)) return confirmedRows;
    return await loadConfirmedTransactionsAsync(userId, twelveMonthsAgoDate(today));
  }

  function rowsInPredictionWindow(rows, occurrenceDate) {
    const cutoffDate = String(occurrenceDate || "");
    const startDate = twelveMonthsAgoDate(cutoffDate);

    return rows.filter(tx => {
      const txDate = String(tx.date || "");
      return txDate >= startDate && txDate <= cutoffDate;
    });
  }

  function normalizePredictionName(value) {
    return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function normalizePredictionCurrency(value) {
    return String(value || "").trim().toUpperCase();
  }

  function matchesRecurringPredictionSource(tx, item, {
    sourceColumn,
    type
  }) {
    if (tx?.type !== type) return false;

    const sourceId = String(tx?.[sourceColumn] || "");
    if (sourceId === item.id) return true;
    if (sourceId) return false;

    const itemName = normalizePredictionName(item?.name);
    const txName = normalizePredictionName(tx?.name);
    if (!itemName || !txName || itemName !== txName) return false;

    const itemCurrency = normalizePredictionCurrency(item?.currency);
    const txCurrency = normalizePredictionCurrency(tx?.currency);
    return Boolean(itemCurrency && txCurrency && itemCurrency === txCurrency);
  }

  function predictedAmountForRecurringExpense(userId, expense, today, occurrenceDate = today, confirmedRows = null) {
    const startingAmount = Number(expense.amount || 0);

    if (expense.prediction_strategy !== "12month_max") {
      return startingAmount;
    }

    const predictionDate = occurrenceDate || today;
    const rows = rowsInPredictionWindow(
      confirmedRowsForPrediction(userId, predictionDate, confirmedRows),
      predictionDate
    )
      .filter(tx => matchesRecurringPredictionSource(tx, expense, {
        sourceColumn: "source_recurring_expense_id",
        type: "expense"
      }));

    return predictedTwelveMonthAmount({
      rows,
      startingAmount,
      direction: "max",
      substituteMissing: expense.prediction_substitute_missing || "none",
      occurrenceDate,
      minRecordedMonths: expense.prediction_min_recorded_months
    });
  }

  async function predictedAmountForRecurringExpenseAsync(
    userId,
    expense,
    today,
    occurrenceDate = today,
    confirmedRows = null
  ) {
    const startingAmount = Number(expense.amount || 0);

    if (expense.prediction_strategy !== "12month_max") {
      return startingAmount;
    }

    const predictionDate = occurrenceDate || today;
    const rows = rowsInPredictionWindow(
      await confirmedRowsForPredictionAsync(userId, predictionDate, confirmedRows),
      predictionDate
    )
      .filter(tx => matchesRecurringPredictionSource(tx, expense, {
        sourceColumn: "source_recurring_expense_id",
        type: "expense"
      }));

    return predictedTwelveMonthAmount({
      rows,
      startingAmount,
      direction: "max",
      substituteMissing: expense.prediction_substitute_missing || "none",
      occurrenceDate,
      minRecordedMonths: expense.prediction_min_recorded_months
    });
  }

  function predictedAmountForRecurringIncome(userId, income, today, occurrenceDate = today, confirmedRows = null) {
    const startingAmount = Number(income.amount || 0);

    if (income.prediction_strategy !== "12month_min") {
      return startingAmount;
    }

    const predictionDate = occurrenceDate || today;
    const rows = rowsInPredictionWindow(
      confirmedRowsForPrediction(userId, predictionDate, confirmedRows),
      predictionDate
    )
      .filter(tx => matchesRecurringPredictionSource(tx, income, {
        sourceColumn: "source_recurring_income_id",
        type: "income"
      }));

    return predictedTwelveMonthAmount({
      rows,
      startingAmount,
      direction: "min",
      substituteMissing: income.prediction_substitute_missing || "none",
      occurrenceDate,
      minRecordedMonths: income.prediction_min_recorded_months
    });
  }

  async function predictedAmountForRecurringIncomeAsync(
    userId,
    income,
    today,
    occurrenceDate = today,
    confirmedRows = null
  ) {
    const startingAmount = Number(income.amount || 0);

    if (income.prediction_strategy !== "12month_min") {
      return startingAmount;
    }

    const predictionDate = occurrenceDate || today;
    const rows = rowsInPredictionWindow(
      await confirmedRowsForPredictionAsync(userId, predictionDate, confirmedRows),
      predictionDate
    )
      .filter(tx => matchesRecurringPredictionSource(tx, income, {
        sourceColumn: "source_recurring_income_id",
        type: "income"
      }));

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
    loadConfirmedTransactionsAsync,
    confirmedRowsForPrediction,
    confirmedRowsForPredictionAsync,
    predictedAmountForRecurringExpense,
    predictedAmountForRecurringExpenseAsync,
    predictedAmountForRecurringIncome,
    predictedAmountForRecurringIncomeAsync
  };
}

