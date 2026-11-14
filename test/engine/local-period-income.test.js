import assert from "node:assert/strict";
import test from "node:test";
import { completeSnapshot } from "./fixtures.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { confirmLocalOccurrence, refreshLocalSnapshot } from "../../src/engine/local-confirmation.js";
import { validateLocalPlanning } from "../../src/engine/local-validation.js";
import { localPeriodSummaries, localPeriodSummariesJson } from "../../src/engine/local-planning.js";

const today = "2026-06-10";
const income = (id, day, extra = {}) => ({ id, name: id, amount: 1000, currency: "PLN", active: 1, prediction_strategy: "fixed",
  repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: day, anchor_offset_days: 0,
  anchor_business_day_adjustment: "none", ...extra });

function local({ incomes = [income("salary", 10, { period_setting: 1 })], periodIncome = "salary", oneOffs = [] } = {}) {
  const snapshot = completeSnapshot();
  snapshot.budgetId = "local-period-income";
  Object.assign(snapshot.request, { today, generationTimestamp: `${today}T12:00:00.000Z` });
  Object.assign(snapshot.request.tables, { one_off_transactions: oneOffs, recurring_incomes: incomes, recurring_expenses: [], planned_transactions: [] });
  snapshot.request.settings = { ...snapshot.request.settings, budget_period_income_id: periodIncome, future_periods: 3 };
  return snapshot;
}

test("exactly the selected income may set budget periods", () => {
  assert.doesNotThrow(() => validateLocalPlanning(local().request));
  assert.doesNotThrow(() => validateLocalPlanning(local({ incomes: [income("salary", 10)], periodIncome: null }).request));
  for (const change of [
    { periodIncome: null },
    { incomes: [income("salary", 10)] },
    { incomes: [income("salary", 10, { period_setting: 1 }), income("bonus", 20, { period_setting: 1 })] },
    { incomes: [income("salary", 10, { period_setting: 1 }), income("bonus", 20)], periodIncome: "bonus" },
    { incomes: [income("salary", 10, { period_setting: 2 })] }
  ]) assert.throws(() => validateLocalPlanning(local(change).request), /period income|recurring configuration/, JSON.stringify(change));
});

test("budget periods run payday to payday with a period income and by month without one", () => {
  const paydays = localPeriodSummaries({ snapshot: refreshLocalSnapshot({ snapshot: local(), ...local().request }) });
  assert.deepEqual(paydays.slice(0, 2).map(period => [period.start_date, period.end_date]), [["2026-06-10", "2026-07-09"], ["2026-07-10", "2026-08-09"]]);
  assert.equal(paydays[0].income, 1000);
  const plain = local({ incomes: [income("salary", 10)], periodIncome: null });
  const months = localPeriodSummaries({ snapshot: refreshLocalSnapshot({ snapshot: plain, ...plain.request }) });
  assert.deepEqual(months[0].start_date, "2026-06-01");
  assert.equal(JSON.parse(localPeriodSummariesJson(JSON.stringify({ snapshot: { budgetId: "server" } }))).ok, false);
});

test("the period income cannot be dated before newer ledger history", () => {
  const bill = { id: "bill", name: "Bill", amount: 50, currency: "PLN", date: today, type: "expense" };
  let snapshot = refreshLocalSnapshot({ snapshot: local({ oneOffs: [bill] }), ...local().request });
  const rows = () => { const plan = calculateSnapshot(snapshot).plan; return [...plan.pendingRows, ...plan.futureRows]; };
  const confirm = (row, extra) => confirmLocalOccurrence({ snapshot, occurrenceKey: row.occurrence_key, today,
    generationTimestamp: `${today}T12:00:00.000Z`, idSeed: `p-${row.name}`, ...extra });
  snapshot = confirm(rows().find(row => row.source_one_off_id === "bill"), {});
  const salary = rows().find(row => row.source_recurring_income_id === "salary" && row.date === today);
  assert.throws(() => confirm(salary, { actualDate: "2026-06-09" }), /Period-setting income/);
  assert.equal(confirm(salary, {}).localHistory.length, 2);
});
