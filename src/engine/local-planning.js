import { fallbackAnchorDayForDependent } from "./cashflow-date-utils.js";
import { buildPeriodSummariesFromDefinitions, periodAnchorOverridesForIncome } from "./cashflow-period-utils.js";
import { calculateSnapshot } from "./snapshot.js";

/**
 * Fixed days for standalone expenses anchored to a recurring income that is
 * about to be deleted, using the server's re-anchoring rule. Read-only: the
 * native editor applies the days, so planning sources change in one place.
 */
export function localAnchorFallbackDays({ snapshot, incomeId }) {
  if (!snapshot?.budgetId?.startsWith("local-") || snapshot.writesSupported !== undefined) {
    throw new Error("Only standalone local budgets may be re-anchored");
  }
  const tables = snapshot.request?.tables;
  const income = (tables?.recurring_incomes ?? []).find(row => row.id === incomeId);
  if (!income) throw new Error("Anchor income no longer exists");
  const today = snapshot.request.today;
  return Object.fromEntries((tables.recurring_expenses ?? [])
    .filter(row => row.anchor_income_id === incomeId)
    .map(row => [row.id, fallbackAnchorDayForDependent(row, income, today)]));
}

export function localAnchorFallbackDaysJson(json) {
  try { return JSON.stringify({ ok: true, days: localAnchorFallbackDays(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: "LOCAL_REANCHOR_REJECTED", message: error.message } }); }
}

/**
 * Budget-period summaries for a standalone snapshot, using the server's period
 * builder: calendar months, or payday-to-payday when a period income is set.
 * Read-only; recalculates from the snapshot so the summary always matches it.
 */
export function localPeriodSummaries({ snapshot }) {
  if (!snapshot?.budgetId?.startsWith("local-") || snapshot.writesSupported !== undefined) {
    throw new Error("Only standalone local budgets may be summarized");
  }
  const request = snapshot.request;
  const plan = calculateSnapshot(snapshot).plan;
  return buildPeriodSummariesFromDefinitions(request.settings, request.tables.recurring_incomes ?? [], plan.futureRows, {
    anchorOverrides: periodAnchorOverridesForIncome(request.settings.budget_period_income_id, request.predictionRows ?? []),
    confirmedTransactions: snapshot.localHistory ?? [], pendingTransactions: plan.pendingRows, today: request.today
  });
}

export function localPeriodSummariesJson(json) {
  try { return JSON.stringify({ ok: true, periods: localPeriodSummaries(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: "LOCAL_PERIODS_REJECTED", message: error.message } }); }
}
