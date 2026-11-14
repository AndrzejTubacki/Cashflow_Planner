import { DEFAULT_LEDGER_CURRENCY } from "./constants.js";
import { formatMoney, renderStatCard, t } from "./shared.js";

export function renderBudgetPeriodStats(locale, cashflow) {
  if (!cashflow) return "";

  const settings = cashflow.settings || {};
  const ledgerCurrency = settings.ledger_currency || DEFAULT_LEDGER_CURRENCY;
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
      ${renderStatCard(t(locale, "Period start"), periodStartDate, "", {
        locale,
        help: t(locale, "The first date in the currently displayed budget period.")
      })}
      ${renderStatCard(t(locale, "Period end"), periodEndDate, "", {
        locale,
        help: t(locale, "The last date in the currently displayed budget period.")
      })}
      ${renderStatCard(t(locale, "Next reset"), nextResetDate, "", {
        locale,
        help: t(locale, "The first date after this period. Future allocations after this date belong to the next period.")
      })}
      ${renderStatCard(t(locale, "Defined by"), periodIncomeName, "", {
        locale,
        help: t(locale, "Calendar month means normal months. An income name means that income defines payday-style periods.")
      })}
      ${currentPeriod ? renderStatCard(t(locale, "Period income"), formatMoney(currentPeriod.income, ledgerCurrency, locale), "", {
        locale,
        help: t(locale, "Income projected or confirmed inside this budget period in the active ledger currency.")
      }) : ""}
      ${currentPeriod ? renderStatCard(t(locale, "Period expenses"), formatMoney(currentPeriod.expenses, ledgerCurrency, locale), "", {
        locale,
        help: t(locale, "Expenses, goal allocations, and flex allocations projected or confirmed inside this budget period.")
      }) : ""}
    </div>
  `;
}
