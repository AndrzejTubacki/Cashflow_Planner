import { DEFAULT_FUTURE_PERIODS } from "./cashflow-constants.js";
import { calculateNextDate, todayWarsaw } from "./cashflow-date-utils.js";
export function buildPeriodSummariesFromDefinitions(settings, recurringIncomes, futureTransactions) {
    const today = todayWarsaw();
    const futurePeriods = Number(settings?.future_periods) || DEFAULT_FUTURE_PERIODS;
    const periods = buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods);

    const txsByPeriod = new Map();

    for (const tx of futureTransactions || []) {
      const key = tx.period;
      if (!txsByPeriod.has(key)) txsByPeriod.set(key, []);
      txsByPeriod.get(key).push(tx);
    }

    return periods.map(period => {
      const txs = txsByPeriod.get(period.key) || [];

      const income = txs.reduce((sum, tx) => {
        if (tx.type === "income") {
          return sum + Number(tx.ledger_amount || 0);
        }
        return sum;
      }, 0);

      const expenses = txs.reduce((sum, tx) => {
        if (tx.type !== "income") {
          return sum + Number(tx.ledger_amount || 0);
        }
        return sum;
      }, 0);

      const warningCount = txs.reduce((sum, tx) => {
        return ["partial", "underfunded"].includes(tx.status) ? sum + 1 : sum;
      }, 0);

      return {
        period: period.key,
        start_date: period.start,
        end_date: period.end,
        income,
        expenses,
        available_balance: Math.max(0, income - expenses),
        warning_count: warningCount,
        transaction_count: txs.length
      };
    });
  }

export function buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods) {
    const selectedIncome = recurringIncomes.find(i => i.id === settings?.budget_period_income_id);

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
    const base = new Date(`${today}T00:00:00Z`);

    // Wide search window so incomes repeating every X months still produce enough period boundaries.
    for (let i = -24; i <= futurePeriods * 12 + 24; i++) {
      const d = new Date(base);
      d.setUTCMonth(d.getUTCMonth() + i);

      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      const anchorDate = calculateNextDate(selectedIncome, year, month);

      if (anchorDate && !anchors.includes(anchorDate)) {
        anchors.push(anchorDate);
      }
    }

    anchors.sort();

    const periods = [];

    for (let i = 0; i < anchors.length - 1; i++) {
      const start = anchors[i];
      const nextStart = anchors[i + 1];

      if (nextStart < today) continue;
      if (periods.length >= futurePeriods) break;

      const endDate = new Date(`${nextStart}T00:00:00Z`);
      endDate.setUTCDate(endDate.getUTCDate() - 1);

      periods.push({
        key: start,
        year: Number(start.slice(0, 4)),
        month: Number(start.slice(5, 7)),
        start,
        end: endDate.toISOString().slice(0, 10),
        available: 0
      });
    }

    return periods;
  }

