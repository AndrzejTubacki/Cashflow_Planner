import assert from "node:assert/strict";
import test from "node:test";
import { validateLocalPlanning } from "../../src/engine/local-validation.js";

function request() {
  return { settings: { ledger_currency: "EUR", future_periods: 3 }, tables: {
    planned_transactions: [], one_off_transactions: [], recurring_expenses: [], goals: [],
    recurring_incomes: [{ id: "salary", name: "Salary", currency: "EUR", amount: 100,
      active: 1, prediction_strategy: "fixed", repeat_every_months: 1,
      anchor_type: "day_of_month", anchor_day_of_month: 5, anchor_offset_days: 0,
      anchor_business_day_adjustment: "none" }]
  } };
}

test("standalone accepts native fixed monthly sources", () => {
  assert.doesNotThrow(() => validateLocalPlanning(request()));
});

test("standalone calendar adjustments require supported countries and bounded effective offsets", () => {
  for (const country of ["PL", "DE"]) for (const adjustment of ["none", "previous", "next"]) {
    const input = request();
    Object.assign(input.tables.recurring_incomes[0], { anchor_type: "month_end", anchor_offset_days: -31,
      anchor_holiday_country: country, anchor_business_day_adjustment: adjustment });
    assert.doesNotThrow(() => validateLocalPlanning(input));
    input.tables.recurring_incomes[0].anchor_offset_days = 31;
    assert.doesNotThrow(() => validateLocalPlanning(input));
  }
  for (const change of [{ anchor_business_day_adjustment: "later" }, { anchor_holiday_country: "US" },
    { anchor_holiday_country: "pl" }, { anchor_offset_days: 1 },
    { anchor_type: "month_end", anchor_offset_days: 32 }, { anchor_type: "month_end", anchor_offset_days: -32 },
    { anchor_type: "month_end", anchor_offset_days: 0.5 }, { anchor_type: "month_end", anchor_offset_days: "1" }]) {
    const input = request(); Object.assign(input.tables.recurring_incomes[0], change);
    assert.throws(() => validateLocalPlanning(input), /Unsupported standalone recurring/);
  }
});

test("standalone fixed flex shares operating priorities and rejects hidden bounds", () => {
  const input = request();
  input.tables.flex_transactions = [{ id: "flex", name: "Leisure", amount: 20, currency: "EUR", active: 1,
    allow_split: 0, planned_transaction_id: "flex-plan" }];
  input.tables.planned_transactions.push({ id: "flex-plan", operating_priority: 1 });
  assert.doesNotThrow(() => validateLocalPlanning(input));
  for (const change of [{ allow_split: "0" }, { min_amount: 5 }, { max_amount: 20 }]) {
    const changed = structuredClone(input);
    Object.assign(changed.tables.flex_transactions[0], change);
    assert.throws(() => validateLocalPlanning(changed), /flex configuration/);
  }
  input.tables.recurring_expenses.push({ ...input.tables.recurring_incomes[0], id: "rent", planned_transaction_id: "rent-plan" });
  input.tables.planned_transactions.push({ id: "rent-plan", operating_priority: 1 });
  assert.throws(() => validateLocalPlanning(input), /Duplicate standalone priority/);
});

test("standalone split flex validates precise nonnegative ordered optional bounds", () => {
  const input = request();
  input.tables.flex_transactions = [{ id: "flex", name: "Split", amount: 100, currency: "EUR", active: 1,
    allow_split: 1, min_amount: 10, max_amount: 50, planned_transaction_id: "flex-plan" }];
  input.tables.planned_transactions.push({ id: "flex-plan", operating_priority: 1 });
  for (const change of [{}, { min_amount: null, max_amount: null }, { min_amount: 0, max_amount: 0 },
    { allow_split: true }, { min_amount: 150, max_amount: 200 }, { min_amount: 60, max_amount: null }]) {
    const changed = structuredClone(input);
    Object.assign(changed.tables.flex_transactions[0], change);
    assert.doesNotThrow(() => validateLocalPlanning(changed));
  }
  for (const change of [{ allow_split: "1" }, { min_amount: -1 }, { max_amount: "50" },
    { min_amount: 1.001 }, { max_amount: Infinity }, { min_amount: 60, max_amount: 50 },
    // Server parity: a zero maximum still bounds the minimum.
    { min_amount: 60, max_amount: 0 }]) {
    const changed = structuredClone(input);
    Object.assign(changed.tables.flex_transactions[0], change);
    assert.throws(() => validateLocalPlanning(changed), /flex configuration/);
  }
});

test("standalone refuses hidden recurrence restrictions and coerced flags", () => {
  for (const change of [{ repeat_every_months: "1" },
    { anchor_offset_days: "0" }, { period_setting: "0" }, { anchor_income_id: 0 }]) {
    const input = request();
    Object.assign(input.tables.recurring_incomes[0], change);
    assert.throws(() => validateLocalPlanning(input), /Unsupported standalone recurring/);
  }
});

test("standalone fixed recurrence accepts month-end and bounded interval with explicit start", () => {
  const input = request();
  Object.assign(input.tables.recurring_incomes[0], { anchor_type: "month_end", repeat_every_months: 3, start_month_year: "2026-01" });
  assert.doesNotThrow(() => validateLocalPlanning(input));
  for (const change of [{ repeat_every_months: 0 }, { repeat_every_months: 13 }, { repeat_every_months: 1.5 },
    { start_month_year: null }, { start_month_year: 202601 }, { start_month_year: "2026-13" }, { start_month_year: " 2026-01" }]) {
    const changed = structuredClone(input); Object.assign(changed.tables.recurring_incomes[0], change);
    assert.throws(() => validateLocalPlanning(changed));
  }
});

test("standalone expense necessity is an explicit boolean or integer flag", () => {
  const input = request();
  const row = input.tables.recurring_incomes.pop();
  input.tables.recurring_expenses.push({ ...row, planned_transaction_id: "plan", necessary: "false" });
  input.tables.planned_transactions.push({ id: "plan", operating_priority: 1 });
  assert.throws(() => validateLocalPlanning(input), /Unsupported standalone recurring/);
  input.tables.recurring_expenses[0].necessary = 0;
  assert.doesNotThrow(() => validateLocalPlanning(input));
});
