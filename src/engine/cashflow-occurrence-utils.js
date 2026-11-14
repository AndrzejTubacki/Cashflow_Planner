import { requireIsoDate } from "./cashflow-date-utils.js";

const RESERVE_TRANSFER_OCCURRENCE_KEY_PATTERN = /^reserve_transfer:(\d{4}-\d{2}(?:-\d{2})?):(\d{4}-\d{2}(?:-\d{2})?):(in|out)$/;

/** Periods are calendar months or validated income-anchor dates. */
function isValidPeriodKey(value) {
  if (/^\d{4}-\d{2}$/.test(value)) {
    const month = Number(value.slice(5, 7));
    return Number.isInteger(month) && month >= 1 && month <= 12;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    try {
      requireIsoDate(value);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Parses a reserve-transfer occurrence key (`reserve_transfer:{sourcePeriod}:{targetPeriod}:in|out`),
 * verifying that both period keys use the same valid period format (`YYYY-MM` or `YYYY-MM-DD`)
 * and that the source period precedes the target period.
 */
export function parseReserveTransferOccurrenceKey(value) {
  const match = RESERVE_TRANSFER_OCCURRENCE_KEY_PATTERN.exec(String(value || ""));
  if (!match) return null;
  const [, sourcePeriodKey, targetPeriodKey, side] = match;
  if (!isValidPeriodKey(sourcePeriodKey) || !isValidPeriodKey(targetPeriodKey)
    || sourcePeriodKey.length !== targetPeriodKey.length || !(sourcePeriodKey < targetPeriodKey)) {
    return null;
  }
  return {
    sourcePeriodKey,
    targetPeriodKey,
    side,
    type: side === "in" ? "income" : "expense"
  };
}

/** Recognize only generated reserve identities, never an arbitrary prefix. */
export function isReserveTransferOccurrenceKey(value) {
  return Boolean(parseReserveTransferOccurrenceKey(value));
}

export function makeOccurrenceKey({
  type,
  date,
  sourceRecurringExpenseId = null,
  sourceRecurringIncomeId = null,
  sourceOneOffId = null,
  sourceFlexId = null,
  sourceGoalId = null,
  rowId = null
}) {
  const source =
    sourceRecurringExpenseId ? `recurring_expense:${sourceRecurringExpenseId}` :
    sourceRecurringIncomeId ? `recurring_income:${sourceRecurringIncomeId}` :
    sourceOneOffId ? `one_off:${sourceOneOffId}` :
    sourceFlexId ? `flex:${sourceFlexId}` :
    sourceGoalId ? `goal:${sourceGoalId}` :
    `manual:${rowId || "generated"}`;

  return `${source}:${type}:${date}`;
}

export function occurrenceKeyFromRow(row) {
  return makeOccurrenceKey({
    type: row.type,
    date: row.date,
    sourceRecurringExpenseId: row.source_recurring_expense_id || null,
    sourceRecurringIncomeId: row.source_recurring_income_id || null,
    sourceOneOffId: row.source_one_off_id || null,
    sourceFlexId: row.source_flex_id || null,
    sourceGoalId: row.source_goal_id || null,
    rowId: row.id || null
  });
}
