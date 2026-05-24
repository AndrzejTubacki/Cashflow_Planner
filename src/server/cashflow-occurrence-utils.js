export function makeOccurrenceKey({
  type,
  date,
  sourceRecurringExpenseId = null,
  sourceRecurringIncomeId = null,
  sourceOneOffId = null,
  sourceFlexId = null,
  sourceGoalId = null
}) {
  const source =
    sourceRecurringExpenseId ? `recurring_expense:${sourceRecurringExpenseId}` :
    sourceRecurringIncomeId ? `recurring_income:${sourceRecurringIncomeId}` :
    sourceOneOffId ? `one_off:${sourceOneOffId}` :
    sourceFlexId ? `flex:${sourceFlexId}` :
    sourceGoalId ? `goal:${sourceGoalId}` :
    "manual";

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
    sourceGoalId: row.source_goal_id || null
  });
}
