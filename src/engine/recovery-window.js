import { buildBudgetPeriods } from "./cashflow-period-utils.js";
import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";

/** Recover only occurrences already offered by the planner (or explicitly
 * regenerated), never invent a backlog of unrelated historical schedules.
 * Resolve scheduled dates from stable keys because pending dates may be edited.
 * Build each old period separately, retaining income-anchored boundaries. */
export function recoveryWindow({ settings, recurringIncomes, today, futurePeriods, anchorOverrides, candidates, regeneratedRows = [] }) {
  const current = buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods, { anchorOverrides });
  const byKey = new Map(current.map(period => [period.key, period]));
  const recoveryOccurrenceKeys = new Set();
  for (const row of [...candidates, ...regeneratedRows]) {
    const key = row.occurrence_key || occurrenceKeyFromRow(row);
    const date = /:(\d{4}-\d{2}-\d{2})$/.exec(key || "")?.[1];
    if (!date || date > today) continue;
    if (date >= current[0].start && !regeneratedRows.includes(row)
      && !(date < today && (row.source_recurring_expense_id || row.source_recurring_income_id))) continue;
    recoveryOccurrenceKeys.add(key);
    if (date < current[0].start) {
      const period = buildBudgetPeriods(settings, recurringIncomes, date, 1, { anchorOverrides })[0];
      if (period) byKey.set(period.key, period);
    }
  }
  return { recoveryOccurrenceKeys, currentPeriodStart: current[0].start,
    periods: [...byKey.values()].sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0) };
}

