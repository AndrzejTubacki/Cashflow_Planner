import assert from "node:assert/strict";
import test from "node:test";
import { completeSnapshot } from "./fixtures.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { confirmLocalOccurrence, refreshLocalSnapshot } from "../../src/engine/local-confirmation.js";
import { validateLocalPlanning } from "../../src/engine/local-validation.js";
import { localAnchorFallbackDays, localAnchorFallbackDaysJson } from "../../src/engine/local-planning.js";

const today = "2026-06-10";

function recurring(overrides = {}) {
  return { name: "Cycle", amount: 100, currency: "PLN", active: 1, prediction_strategy: "fixed",
    repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 10, anchor_offset_days: 0,
    anchor_business_day_adjustment: "none", ...overrides };
}

/** Standalone budget with one income (salary) and one expense (rent). */
function local({ income = {}, expense = {} } = {}) {
  const snapshot = completeSnapshot();
  snapshot.budgetId = "local-recurring-options";
  Object.assign(snapshot.request, { today, generationTimestamp: `${today}T12:00:00.000Z` });
  const tables = snapshot.request.tables;
  tables.one_off_transactions = [];
  tables.planned_transactions = [{ id: "rent-plan", operating_priority: 1 }];
  tables.recurring_incomes = [recurring({ id: "salary", name: "Salary", amount: 500, ...income })];
  tables.recurring_expenses = [recurring({ id: "rent", name: "Rent", planned_transaction_id: "rent-plan", necessary: 1, ...expense })];
  return snapshot;
}

function rows(snapshot, source) {
  const plan = calculateSnapshot(snapshot).plan;
  return [...plan.pendingRows, ...plan.futureRows].filter(row => row.source_recurring_expense_id === source)
    .sort((a, b) => a.date.localeCompare(b.date));
}

test("standalone accepts server prediction strategies, substitutes and existing income anchors", () => {
  for (const substitute of [undefined, 0, "none", "median_recorded", "require_min_recorded_months"]) {
    const input = local({ income: { prediction_strategy: "12month_min", prediction_substitute_missing: substitute },
      expense: { prediction_strategy: "12month_max", prediction_substitute_missing: substitute, prediction_min_recorded_months: 12,
        anchor_income_id: "salary", anchor_offset_days: -3 } });
    assert.doesNotThrow(() => validateLocalPlanning(input.request));
  }
});

test("standalone rejects mismatched strategies, unknown substitutes and dangling or income-side anchors", () => {
  const rejected = [
    { income: { prediction_strategy: "12month_max" } },
    { expense: { prediction_strategy: "12month_min" } },
    { expense: { prediction_substitute_missing: "average" } },
    { expense: { prediction_min_recorded_months: 13 } },
    { expense: { prediction_min_recorded_months: 0 } },
    { expense: { anchor_income_id: "deleted-income" } },
    { expense: { anchor_income_id: "salary", anchor_offset_days: 32 } },
    { income: { anchor_income_id: "salary" } },
    // A plain fixed day still cannot carry a hidden offset.
    { expense: { anchor_offset_days: 2 } }
  ];
  for (const change of rejected) {
    assert.throws(() => validateLocalPlanning(local(change).request), /Unsupported standalone recurring/, JSON.stringify(change));
  }
});

test("history prediction uses accepted local payments while fixed prediction uses the source amount", () => {
  for (const strategy of ["fixed", "12month_max"]) {
    const snapshot = refreshLocalSnapshot({ snapshot: local({ expense: { prediction_strategy: strategy } }), ...local().request });
    const due = rows(snapshot, "rent").find(row => row.date === today);
    const accepted = confirmLocalOccurrence({ snapshot, occurrenceKey: due.occurrence_key, today,
      generationTimestamp: `${today}T12:00:00.000Z`, idSeed: `rent-${strategy}`, amount: 80 });
    accepted.request.tables.recurring_expenses[0].amount = 50;
    const reopened = refreshLocalSnapshot({ snapshot: accepted, ...accepted.request });
    const next = rows(reopened, "rent").find(row => row.date > today);
    assert.equal(next.amount, strategy === "fixed" ? 50 : 80, strategy);
  }
});

test("income-anchored expenses follow the income date plus offset through refresh", () => {
  const snapshot = local({ income: { anchor_day_of_month: 20 }, expense: { anchor_income_id: "salary", anchor_offset_days: 2 } });
  const prepared = refreshLocalSnapshot({ snapshot, ...snapshot.request });
  assert.deepEqual(rows(prepared, "rent").slice(0, 2).map(row => row.date), ["2026-06-22", "2026-07-22"]);
});

test("deleting an anchor income yields the server's fixed fallback day for each dependent", () => {
  const snapshot = local({ income: { anchor_day_of_month: 20 }, expense: { anchor_income_id: "salary", anchor_offset_days: 2 } });
  assert.deepEqual(localAnchorFallbackDays({ snapshot, incomeId: "salary" }), { rent: 22 });
  // Past this cycle's anchored date, the next cycle's date is used.
  snapshot.request.today = "2026-06-25";
  assert.deepEqual(localAnchorFallbackDays({ snapshot, incomeId: "salary" }), { rent: 22 });
  assert.deepEqual(localAnchorFallbackDays({ snapshot: local(), incomeId: "salary" }), {});
  const missing = JSON.parse(localAnchorFallbackDaysJson(JSON.stringify({ snapshot, incomeId: "other" })));
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "LOCAL_REANCHOR_REJECTED");
  const server = structuredClone(snapshot); server.budgetId = "server-budget";
  assert.throws(() => localAnchorFallbackDays({ snapshot: server, incomeId: "salary" }), /standalone/);
});
