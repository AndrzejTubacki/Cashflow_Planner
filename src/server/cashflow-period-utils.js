import { DEFAULT_FUTURE_PERIODS, DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { calculateNextDate, todayInTimezone } from "./cashflow-date-utils.js";
import { addMoneyAmounts, roundMoneyAmount, subtractMoneyAmounts } from "./cashflow-money-utils.js";

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

export function periodAnchorOverridesForIncome(incomeId, rows = []) {
  const normalizedIncomeId = String(incomeId || "").trim();
  if (!normalizedIncomeId) return new Map();

  const prefix = `recurring_income:${normalizedIncomeId}:income:`;
  const overrides = new Map();

  for (const row of rows || []) {
    if (String(row?.source_recurring_income_id || "") !== normalizedIncomeId) continue;
    if (String(row?.type || "") !== "income") continue;

    const occurrenceKey = String(row?.occurrence_key || "");
    if (!occurrenceKey.startsWith(prefix)) continue;

    const scheduledDate = occurrenceKey.slice(prefix.length);
    const actualDate = String(row?.date || row?.confirmed_date || "").slice(0, 10);
    if (!isIsoDate(scheduledDate) || !isIsoDate(actualDate)) continue;

    overrides.set(scheduledDate, actualDate);
  }

  return overrides;
}

export function buildPeriodSummariesFromDefinitions(settings, recurringIncomes, futureTransactions, options = {}) {
  const today = options.today || todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE);
  const futurePeriods = Number(settings?.future_periods) || DEFAULT_FUTURE_PERIODS;
  const ledgerCurrency = settings?.ledger_currency || "PLN";
  const periods = buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods, options);

  const txsByPeriod = new Map();

  const periodForDate = date => periods.find(period => date >= period.start && date <= period.end);
  const periodForPendingDate = date => {
    if (!periods.length) return null;
    if (date < periods[0].start) return periods[0];
    return periodForDate(date);
  };

  const addToPeriod = (periodKey, tx) => {
    if (String(tx.ledger_currency || "PLN") !== ledgerCurrency) return;
    if (!periodKey) return;
    if (!txsByPeriod.has(periodKey)) txsByPeriod.set(periodKey, []);
    txsByPeriod.get(periodKey).push(tx);
  };

  for (const tx of futureTransactions || []) {
    addToPeriod(tx.period || periodForDate(String(tx.date || ""))?.key, tx);
  }

  for (const tx of options.pendingTransactions || []) {
    const period = periodForPendingDate(String(tx.date || ""));
    addToPeriod(period?.key, tx);
  }

  for (const tx of options.confirmedTransactions || []) {
    const period = periodForDate(String(tx.date || ""));
    addToPeriod(period?.key, tx);
  }

  return periods.map(period => {
    const txs = txsByPeriod.get(period.key) || [];

    const income = addMoneyAmounts(
      ...txs
        .filter(tx => tx.type === "income")
        .map(tx => tx.ledger_amount)
    );

    const expenses = addMoneyAmounts(
      ...txs
        .filter(tx => tx.type !== "income")
        .map(tx => tx.ledger_amount)
    );

    const warningCount = txs.reduce((sum, tx) => {
      return ["partial", "underfunded"].includes(tx.status) ? sum + 1 : sum;
    }, 0);

    return {
      period: period.key,
      start_date: period.start,
      end_date: period.end,
      income: roundMoneyAmount(income),
      expenses: roundMoneyAmount(expenses),
      available_balance: subtractMoneyAmounts(income, expenses),
      warning_count: warningCount,
      transaction_count: txs.length
    };
  });
}

export function buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods, options = {}) {
  const selectedIncome = recurringIncomes.find(i =>
    i.id === settings?.budget_period_income_id &&
    Number(i.active) === 1 &&
    Number(i.period_setting) === 1
  );

  if (!selectedIncome) {
    const periods = [];
    const base = new Date(`${today}T00:00:00Z`);

    for (let i = 0; i < futurePeriods; i++) {
      const d = new Date(base);
      d.setUTCMonth(d.getUTCMonth() + i);

      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      const key = `${year}-${String(month).padStart(2, "0")}`;
      const start = `${key}-01`;
      const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

      periods.push({
        key,
        year,
        month,
        start,
        end,
        available: 0
      });
    }

    return periods;
  }

  const anchors = [];
  const anchorOverrides = options.anchorOverrides instanceof Map
    ? options.anchorOverrides
    : new Map(Object.entries(options.anchorOverrides || {}));
  const base = new Date(`${today}T00:00:00Z`);

  // Wide search window so incomes repeating every X months still produce enough period boundaries.
  for (let i = -24; i <= futurePeriods * 12 + 24; i++) {
    const d = new Date(base);
    d.setUTCMonth(d.getUTCMonth() + i);

    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const scheduledAnchorDate = calculateNextDate(selectedIncome, year, month);
    const anchorDate = anchorOverrides.get(scheduledAnchorDate) || scheduledAnchorDate;

    if (anchorDate && !anchors.includes(anchorDate)) {
      anchors.push(anchorDate);
    }
  }

  anchors.sort();

  const periods = [];

  for (let i = 0; i < anchors.length - 1; i++) {
    const start = anchors[i];
    const nextStart = anchors[i + 1];

    const endDate = new Date(`${nextStart}T00:00:00Z`);
    endDate.setUTCDate(endDate.getUTCDate() - 1);
    const end = endDate.toISOString().slice(0, 10);

    if (end < today) continue;
    if (periods.length >= futurePeriods) break;

    periods.push({
      key: start,
      year: Number(start.slice(0, 4)),
      month: Number(start.slice(5, 7)),
      start,
      end,
      available: 0
    });
  }

  return periods;
}
