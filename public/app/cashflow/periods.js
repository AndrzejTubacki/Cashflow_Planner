import { formatMoney, renderStatCard, t } from "./shared.js";

export function renderBudgetPeriodStats(locale, cashflow) {
  if (!cashflow) return "";

  const settings = cashflow.settings || {};
  const recurringIncomes = cashflow.recurringIncomes || [];
  const activePeriodIncomeId = settings.budget_period_income_id;
  const activePeriodIncome = recurringIncomes.find(r => r.id === activePeriodIncomeId);
  const currentPeriod = (cashflow.periodSummaries || [])[0];

  const periodStartDate = currentPeriod?.start_date || "-";
  const periodEndDate = currentPeriod?.end_date || "-";
  const nextResetDate = currentPeriod?.end_date
    ? (() => {
        const d = new Date(`${currentPeriod.end_date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      })()
    : "-";

  const periodIncomeName = activePeriodIncome
    ? activePeriodIncome.name
    : t(locale, "Calendar month");

  return `
    <div class="metric-grid cashflow-budget-period">
      ${renderStatCard(t(locale, "Period start"), periodStartDate)}
      ${renderStatCard(t(locale, "Period end"), periodEndDate)}
      ${renderStatCard(t(locale, "Next reset"), nextResetDate)}
      ${renderStatCard(t(locale, "Defined by"), periodIncomeName)}
      ${currentPeriod ? renderStatCard(t(locale, "Period income"), formatMoney(currentPeriod.income, "PLN", locale)) : ""}
      ${currentPeriod ? renderStatCard(t(locale, "Period expenses"), formatMoney(currentPeriod.expenses, "PLN", locale)) : ""}
    </div>
  `;
}
