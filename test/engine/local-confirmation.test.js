import assert from "node:assert/strict";
import test from "node:test";
import { completeSnapshot } from "./fixtures.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { confirmLocalOccurrence, refreshLocalSnapshot, undoLocalConfirmation } from "../../src/engine/local-confirmation.js";

function local(amount = 300, income = false) {
  const snapshot = completeSnapshot();
  snapshot.budgetId = "local-test";
  Object.assign(snapshot.request.tables.one_off_transactions[0], { date: snapshot.request.today, amount,
    type: income ? "income" : "expense" });
  return snapshot;
}
function confirm(snapshot, extra = {}) {
  const row = calculateSnapshot(snapshot).plan.pendingRows[0];
  return confirmLocalOccurrence({ snapshot, occurrenceKey: row?.occurrence_key,
    today: snapshot.request.today, generationTimestamp: "2026-06-01T12:00:00.000Z", idSeed: "local-confirm-1", ...extra });
}
/** Preserve v1 import coverage now that current commands emit audited v2. */
function legacy(snapshot) {
  const result = structuredClone(snapshot);
  result.snapshotVersion = 1;
  delete result.localAudit; delete result.localAuditVersion; delete result.localAuditLegacyCount;
  return result;
}
test("standalone business-day and month-end offsets preserve accepted dates across source months", () => {
  const cases = [
    { today: "2026-12-31", anchor_type: "day_of_month", anchor_day_of_month: 1,
      start_month_year: "2027-01", anchor_business_day_adjustment: "previous", anchor_holiday_country: "PL" },
    { today: "2027-01-04", anchor_type: "day_of_month", anchor_day_of_month: 1,
      start_month_year: "2027-01", anchor_business_day_adjustment: "next", anchor_holiday_country: "PL" },
    { today: "2028-03-02", anchor_type: "month_end", anchor_day_of_month: 1, anchor_offset_days: 2,
      start_month_year: "2028-02", anchor_business_day_adjustment: "none", anchor_holiday_country: "PL" },
    { today: "2026-11-12", anchor_type: "day_of_month", anchor_day_of_month: 11,
      start_month_year: "2026-11", anchor_business_day_adjustment: "next", anchor_holiday_country: "PL" },
    { today: "2026-11-11", anchor_type: "day_of_month", anchor_day_of_month: 11,
      start_month_year: "2026-11", anchor_business_day_adjustment: "next", anchor_holiday_country: "DE" }
  ];
  for (const income of [true, false]) for (const { today, ...anchor } of cases) {
    const snapshot = local();
    snapshot.request.today = today;
    snapshot.request.generationTimestamp = `${today}T12:00:00.000Z`;
    snapshot.request.tables.one_off_transactions = [];
    snapshot.request.tables.planned_transactions = income ? [] : [{ id: "plan", operating_priority: 1 }];
    snapshot.request.tables[income ? "recurring_incomes" : "recurring_expenses"] = [{ id: "cycle", name: "Cycle",
      amount: 100, currency: "PLN", active: 1, necessary: 1, ...(income ? {} : { planned_transaction_id: "plan" }),
      prediction_strategy: "fixed", repeat_every_months: 12, anchor_offset_days: 0, ...anchor }];
    const prepared = refreshLocalSnapshot({ snapshot, ...snapshot.request });
    const plan = calculateSnapshot(prepared).plan;
    const due = [...plan.pendingRows, ...plan.futureRows].find(row => row.date === today);
    assert.ok(due, JSON.stringify({ income, today, anchor }));
    const accepted = confirm(prepared, { occurrenceKey: due.occurrence_key,
      generationTimestamp: `${today}T12:00:00.000Z` });
    assert.equal(accepted.request.openingBalance, income ? 600 : 400);
    const reopened = refreshLocalSnapshot({ snapshot: structuredClone(accepted), ...accepted.request });
    assert.equal(reopened.localHistory[0].date, today);
    assert.equal(reopened.localHistory[0].occurrence_key, due.occurrence_key);
    const remaining = calculateSnapshot(reopened).plan;
    assert.ok(![...remaining.pendingRows, ...remaining.futureRows].some(row => row.occurrence_key === due.occurrence_key));
    const corrupt = legacy(reopened);
    corrupt.localHistory[0].date = "2026-06-15";
    corrupt.localHistory[0].ledger_year = 2026;
    corrupt.localHistory[0].occurrence_key = `recurring_${income ? "income" : "expense"}:cycle:${income ? "income" : "expense"}:2026-06-15`;
    corrupt.request.predictionRows = structuredClone(corrupt.localHistory);
    assert.throws(() => refreshLocalSnapshot({ snapshot: corrupt, ...corrupt.request }), /recurring anchor/);
  }
});

test("split flex refresh and confirmation use shared allocation bounds and accepted funding", () => {
  const snapshot = local();
  snapshot.request.tables.one_off_transactions = [];
  snapshot.request.tables.planned_transactions = [{ id: "flex-plan", operating_priority: 1 }];
  snapshot.request.tables.flex_transactions = [{ id: "split-flex", name: "Leisure", amount: 300, currency: "PLN",
    active: 1, allow_split: 1, min_amount: 20, max_amount: 80, planned_transaction_id: "flex-plan" }];
  const original = JSON.stringify(snapshot);
  function allocations(value) {
    const refreshed = refreshLocalSnapshot({ snapshot: value, ...value.request });
    const plan = calculateSnapshot(refreshed).plan;
    return [...plan.pendingRows, ...plan.futureRows].filter(row => row.source_flex_id === "split-flex");
  }
  const rows = allocations(snapshot);
  assert.ok(rows.length > 0);
  assert.ok(rows.every(row => row.amount >= 20 && row.amount <= 80));
  assert.ok(rows.reduce((sum, row) => sum + row.amount, 0) <= 300);
  const accepted = confirm(snapshot, { occurrenceKey: rows[0].occurrence_key });
  assert.equal(accepted.localHistory[0].amount, rows[0].amount);
  assert.equal(accepted.request.openingBalance, 500 - rows[0].amount);
  assert.deepEqual(accepted.request.confirmedFunding.source_flex_id, [["split-flex", rows[0].amount]]);
  assert.throws(() => confirm(accepted, { occurrenceKey: rows[0].occurrence_key, idSeed: "duplicate-flex" }), /already confirmed/);
  const reopened = refreshLocalSnapshot({ snapshot: structuredClone(accepted), ...accepted.request });
  assert.deepEqual(reopened.request.confirmedFunding.source_flex_id, [["split-flex", rows[0].amount]]);
  const undone = undoLocalConfirmation({ snapshot: accepted, confirmationId: accepted.localLastConfirmationId,
    ...accepted.request, idSeed: "undo-flex" });
  assert.equal(undone.request.openingBalance, 500);
  assert.deepEqual(undone.request.confirmedFunding.source_flex_id, []);
  // A target lowered below an accepted payment is simply complete (server parity).
  const overfunded = legacy(accepted);
  overfunded.request.tables.flex_transactions[0].amount = rows[0].amount - 1;
  assert.equal(refreshLocalSnapshot({ snapshot: overfunded, ...overfunded.request }).localHistory.length, 1);
  const insufficient = structuredClone(snapshot);
  insufficient.request.openingBalance = 10;
  assert.equal(allocations(insufficient).length, 0);
  const unlimited = structuredClone(snapshot);
  unlimited.request.tables.flex_transactions[0].max_amount = null;
  assert.equal(allocations(unlimited)[0].amount, 300);
  unlimited.request.tables.flex_transactions[0].max_amount = 0;
  unlimited.request.tables.flex_transactions[0].min_amount = 0;
  assert.equal(allocations(unlimited)[0].amount, 300);
  assert.equal(JSON.stringify(snapshot), original);
});

test("due goal allocation records an expense, restores funding and supports latest undo", () => {
  const snapshot = local();
  snapshot.request.tables.one_off_transactions = [];
  snapshot.request.tables.planned_transactions = [{ id: "goal-plan", goal_priority: 1 }];
  snapshot.request.tables.goals = [{ id: "goal", name: "Reserve", amount: 700, currency: "PLN", active: 1,
    due_date: snapshot.request.today, planned_transaction_id: "goal-plan" }];
  const row = calculateSnapshot(snapshot).plan.futureRows.find(value => value.source_goal_id === "goal");
  assert.equal(row.type, "goal_allocation");
  assert.equal(row.amount, 500);
  const accepted = confirm(snapshot, { occurrenceKey: row.occurrence_key });
  assert.equal(accepted.localHistory[0].type, "expense");
  assert.equal(accepted.localHistory[0].occurrence_key, row.occurrence_key);
  assert.equal(accepted.request.openingBalance, 0);
  assert.deepEqual(accepted.request.confirmedFunding.source_goal_id, [["goal", 500]]);
  const restored = refreshLocalSnapshot({ snapshot: structuredClone(accepted), ...accepted.request });
  assert.equal(restored.localHistory.length, 1);
  assert.throws(() => confirm(restored, { occurrenceKey: row.occurrence_key, idSeed: "duplicate-goal" }), /already confirmed/);
  const undone = undoLocalConfirmation({ snapshot: accepted, confirmationId: accepted.localLastConfirmationId, ...accepted.request, idSeed: "undo-goal" });
  assert.equal(undone.request.openingBalance, 500);
  assert.deepEqual(undone.request.confirmedFunding.source_goal_id, []);
  const corrupt = legacy(accepted);
  corrupt.localHistory[0].occurrence_key = "goal:goal:expense:2026-06-01";
  assert.throws(() => refreshLocalSnapshot({ snapshot: corrupt, ...corrupt.request }), /funding history/);
  const future = structuredClone(snapshot);
  future.request.tables.goals[0].due_date = "2026-06-02";
  const futureRow = calculateSnapshot(future).plan.futureRows.find(value => value.source_goal_id === "goal");
  assert.throws(() => confirm(future, { occurrenceKey: futureRow.occurrence_key }), /due pending/);
});
test("standalone refresh rejects unsafe settings and duplicate funding priorities", () => {
  for (const settings of [{ future_periods: 25 }, { future_periods: 1.5 },
    { minimum_reserve_amount: -1 }, { minimum_reserve_amount: 1.001 },
    { minimum_reserve_enabled: "true" }, { fx_buffer_percent: 101 }, { fx_buffer_percent: -1 }, { fx_buffer_percent: "10" }]) {
    const snapshot = local(); Object.assign(snapshot.request.settings, settings);
    assert.throws(() => refreshLocalSnapshot({ snapshot, ...snapshot.request }), /standalone projection settings|future_periods must/);
  }
  const snapshot = local();
  snapshot.request.tables.planned_transactions = [{ id: "p1", goal_priority: 1 }, { id: "p2", goal_priority: 1 }];
  snapshot.request.tables.goals = ["p1", "p2"].map((plan, index) => ({ id: `g${index}`, name: "Goal", amount: 100,
    currency: "PLN", active: 1, due_date: "2026-07-01", planned_transaction_id: plan }));
  assert.throws(() => refreshLocalSnapshot({ snapshot, ...snapshot.request }), /Duplicate standalone priority/);
});

test("standalone sources and reserves reject amounts outside safely representable cents", () => {
  for (const value of [Number.MAX_SAFE_INTEGER, 1e20, Infinity]) {
    const source = local(value);
    assert.throws(() => refreshLocalSnapshot({ snapshot: source, ...source.request }));
    const reserve = local();
    reserve.request.settings.minimum_reserve_amount = value;
    assert.throws(() => refreshLocalSnapshot({ snapshot: reserve, ...reserve.request }));
  }
});

test("standalone confirmation rejects accumulated balance overflow without mutating its input", () => {
  const snapshot = local(20000000000000, true);
  snapshot.request.openingBalance = 80000000000000;
  const before = JSON.stringify(snapshot);
  assert.throws(() => confirm(snapshot), /balance exceeds safely representable cents/);
  assert.equal(JSON.stringify(snapshot), before);
});

test("standalone restore rejects unsafe intermediate balances even when the final balance is safe", () => {
  const snapshot = legacy(confirm(local(20000000000000, true)));
  snapshot.localOpeningBalance = 80000000000000;
  const source = { id: "later-expense", name: "Later expense", currency: "PLN", amount: 20000000000000,
    type: "expense", date: "2026-06-01" };
  snapshot.request.tables.one_off_transactions.push(source);
  snapshot.localHistory.push({ ...snapshot.localHistory[0], id: "later-confirmation", type: "expense",
    source_one_off_id: source.id, occurrence_key: "one_off:later-expense:expense:2026-06-01",
    created_at: "2026-06-01T12:01:00.000Z" });
  assert.throws(() => refreshLocalSnapshot({ snapshot, ...snapshot.request }), /balance exceeds safely representable cents/);
});

test("recurring history honors monthly anchors including short-month clamping", () => {
  const snapshot = local(); snapshot.request.tables.one_off_transactions = [];
  snapshot.request.tables.recurring_incomes = [{ id: "salary", name: "Salary", amount: 100, currency: "PLN", active: 1,
    prediction_strategy: "fixed", repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 31,
    anchor_business_day_adjustment: "none" }];
  const row = { id: "history", name: "Salary", type: "income", amount: 100, currency: "PLN", ledger_currency: "PLN",
    source_recurring_income_id: "salary", date: "2026-02-28", fx_rate: 1, buffered_fx_rate: 1,
    occurrence_key: "recurring_income:salary:income:2026-02-28", status: "confirmed", ledger_year: 2026,
    confirmed_date: "2026-02-28", created_at: "2026-02-28T12:00:00.000Z" };
  snapshot.localOpeningBalance = 500; snapshot.localHistory = [row];
  assert.equal(refreshLocalSnapshot({ snapshot, ...snapshot.request }).request.openingBalance, 600);
  snapshot.request.tables.recurring_incomes[0].active = 0;
  const paused = refreshLocalSnapshot({ snapshot, ...snapshot.request });
  assert.equal(paused.request.openingBalance, 600);
  assert.equal(calculateSnapshot(paused).plan.futureRows.filter(row => row.source_recurring_income_id === "salary").length, 0);
  assert.equal(paused.localHistory.length, 1);
  snapshot.request.tables.recurring_incomes[0].active = 1;
  row.date = "2026-02-27"; row.occurrence_key = "recurring_income:salary:income:2026-02-27";
  assert.throws(() => refreshLocalSnapshot({ snapshot, ...snapshot.request }), /recurring anchor/);
});

test("month-end interval recurrence confirms leap-day history and rejects off-cycle imports", () => {
  const snapshot = local();
  Object.assign(snapshot.request, { today: "2028-02-29", generationTimestamp: "2028-02-29T12:00:00.000Z" });
  snapshot.request.tables.one_off_transactions = [];
  snapshot.request.tables.recurring_incomes = [{ id: "cycle", name: "Cycle income", amount: 100, currency: "PLN", active: 1,
    prediction_strategy: "fixed", repeat_every_months: 3, start_month_year: "2028-02", anchor_type: "month_end",
    anchor_day_of_month: 1, anchor_offset_days: 0, anchor_business_day_adjustment: "none" }];
  const row = calculateSnapshot(snapshot).plan.futureRows.find(value => value.date === "2028-02-29");
  assert.ok(row);
  const accepted = confirm(snapshot, { occurrenceKey: row.occurrence_key, today: snapshot.request.today,
    generationTimestamp: snapshot.request.generationTimestamp });
  assert.equal(accepted.request.openingBalance, 600);
  assert.equal(refreshLocalSnapshot({ snapshot: accepted, ...accepted.request }).localHistory[0].date, "2028-02-29");
  const offCycle = legacy(accepted);
  offCycle.localHistory[0].date = "2028-01-31";
  offCycle.localHistory[0].occurrence_key = "recurring_income:cycle:income:2028-01-31";
  assert.throws(() => refreshLocalSnapshot({ snapshot: offCycle, ...offCycle.request }), /recurring anchor/);
});
test("local confirmation uses shared ledger calculations and does not regenerate handled one-offs", () => {
  const before = local();
  const after = confirm(before);
  assert.equal(after.revision, 1);
  assert.equal(after.request.openingBalance, 200);
  assert.equal(after.localHistory.length, 1);
  assert.equal(after.localHistory[0].ledger_amount, 300);
  assert.equal(calculateSnapshot(after).plan.pendingRows.length, 0);
  assert.equal(before.request.openingBalance, 500);
  assert.throws(() => confirm(after, { occurrenceKey: after.localHistory[0].occurrence_key }), /already confirmed/);
});
test("local confirmation rejects linked, future, unavailable funding and stale-day requests", () => {
  const linked = local(); linked.budgetId = "server-budget";
  assert.throws(() => confirm(linked), /standalone/);
  const future = local(); future.request.tables.one_off_transactions[0].date = "2026-06-10";
  assert.throws(() => confirm(future), /due pending/);
  assert.throws(() => confirm(local(1000)), /precise cents|due pending/);
  assert.throws(() => confirm(local(), { today: "2026-06-02" }), /Recalculate/);
});

test("one-off installments preserve exact progress, remainder identity, reopen and latest undo", () => {
  const before = local();
  const first = confirm(before, { amount: 100 });
  assert.equal(first.localHistory[0].amount, 100);
  assert.equal(first.request.openingBalance, 400);
  const remaining = calculateSnapshot(first).plan.pendingRows.find(row => row.source_one_off_id === "one-1");
  assert.equal(remaining.occurrence_key, "one_off_remainder:one-1:2");
  assert.equal(remaining.amount, 200);
  const second = confirm(first, { amount: 50, occurrenceKey: remaining.occurrence_key, idSeed: "installment-2" });
  assert.equal(second.request.openingBalance, 350);
  assert.equal(second.localHistory.length, 2);
  const reopened = refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(second)), ...second.request });
  const remainder = calculateSnapshot(reopened).plan.pendingRows.find(row => row.source_one_off_id === "one-1");
  assert.equal(remainder.occurrence_key, "one_off_remainder:one-1:3");
  assert.equal(remainder.amount, 150);
  const undone = undoLocalConfirmation({ snapshot: second, confirmationId: second.localLastConfirmationId,
    ...second.request, idSeed: "undo-installment" });
  assert.equal(undone.request.openingBalance, 400);
  assert.equal(calculateSnapshot(undone).plan.pendingRows[0].occurrence_key, "one_off_remainder:one-1:3");
  assert.equal(undone.localAudit.at(-1).kind, "correction");
  assert.equal(undone.localAudit.at(-1).before.id, second.localLastConfirmationId);
  assert.equal(before.localHistory, undefined);
});

test("one-off installment validation rejects malformed amounts and changed imported chains", () => {
  for (const amount of ["100", null, true, 0, -1, 1.001, Infinity]) {
    assert.throws(() => confirm(local(), { amount }), /amount/);
  }
  const first = confirm(local(), { amount: 100 });
  for (const mutate of [snapshot => { snapshot.localHistory[0].occurrence_key = "one_off_remainder:one-1:2"; },
    snapshot => { snapshot.localHistory[0].amount = 301; }]) {
    const changed = legacy(first); mutate(changed);
    assert.throws(() => refreshLocalSnapshot({ snapshot: changed, ...changed.request }), /installment history|recorded ledger amount/);
  }
  const second = confirm(first, { amount: 100, occurrenceKey: "one_off_remainder:one-1:2", idSeed: "later-installment" });
  const changed = legacy(second);
  changed.localHistory[1].occurrence_key = "one_off_remainder:one-1:3";
  assert.throws(() => refreshLocalSnapshot({ snapshot: changed, ...changed.request }), /installment history/);
  const fractional = structuredClone(first);
  fractional.localHistory[0].amount = 1.001;
  fractional.localHistory[0].ledger_amount = 1.001;
  assert.throws(() => refreshLocalSnapshot({ snapshot: fractional, ...fractional.request }), /history/);
});

test("one-off installment completion and income use shared totals without duplicate remainders", () => {
  const first = confirm(local(100, true), { amount: 40 });
  assert.equal(first.request.openingBalance, 540);
  const final = confirm(first, { amount: 60, occurrenceKey: "one_off_remainder:one-1:2", idSeed: "final-installment" });
  assert.equal(final.request.openingBalance, 600);
  assert.equal(calculateSnapshot(final).plan.pendingRows.length, 0);
  assert.throws(() => confirm(final, { occurrenceKey: "one_off_remainder:one-1:2", idSeed: "replay" }), /already confirmed/);
  const changed = legacy(final);
  // Either installment alone completes the one-off, so neither can have followed the other.
  for (const row of changed.localHistory) row.amount = row.ledger_amount = 100;
  assert.throws(() => refreshLocalSnapshot({ snapshot: changed, ...changed.request }), /installment history/);
});

test("due-today recurring partials close only their dated occurrence without a remainder", () => {
  const snapshot = local();
  snapshot.request.tables.one_off_transactions = [];
  snapshot.request.tables.recurring_incomes = [{ id: "salary", name: "Salary", amount: 100, currency: "PLN", active: 1,
    prediction_strategy: "fixed", repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 1,
    anchor_business_day_adjustment: "none" }];
  const plan = calculateSnapshot(snapshot).plan;
  const row = plan.futureRows.find(value => value.source_recurring_income_id === "salary");
  assert.ok(row);
  const partial = confirm(snapshot, { occurrenceKey: row.occurrence_key, amount: 50 });
  assert.equal(partial.request.openingBalance, 550);
  assert.equal(partial.localHistory[0].amount, 50);
  assert.equal(partial.request.tables.recurring_incomes[0].amount, 100);
  const partialPlan = calculateSnapshot(partial).plan;
  assert.equal([...partialPlan.pendingRows, ...partialPlan.futureRows].filter(value => value.occurrence_key === row.occurrence_key).length, 0);
  assert.ok(partialPlan.futureRows.some(value => value.source_recurring_income_id === "salary" && value.amount === 100));
  assert.equal(refreshLocalSnapshot({ snapshot: partial, ...partial.request }).request.openingBalance, 550);
  const accepted = confirm(snapshot, { occurrenceKey: row.occurrence_key });
  assert.equal(accepted.request.openingBalance, 600);
  assert.equal(accepted.localHistory[0].source_recurring_income_id, "salary");
  assert.throws(() => confirm(accepted, { occurrenceKey: row.occurrence_key, idSeed: "duplicate" }), /already confirmed/);
  const later = plan.futureRows.find(value => value.date > snapshot.request.today);
  assert.ok(later);
  assert.throws(() => confirm(snapshot, { occurrenceKey: later.occurrence_key }), /due pending/);
  assert.equal(snapshot.request.tables.recurring_incomes[0].amount, 100);
});

test("partial discretionary recurring expense records only funded cents and can be undone", () => {
  const snapshot = local();
  snapshot.request.openingBalance = 50;
  snapshot.request.tables.one_off_transactions = [];
  snapshot.request.tables.planned_transactions = [{ id: "expense-plan", operating_priority: 1 }];
  snapshot.request.tables.recurring_expenses = [{ id: "expense", name: "Discretionary", amount: 100, currency: "PLN", active: 1,
    necessary: 0, planned_transaction_id: "expense-plan", prediction_strategy: "fixed", repeat_every_months: 1,
    anchor_type: "day_of_month", anchor_day_of_month: 1, anchor_business_day_adjustment: "none" }];
  const plan = calculateSnapshot(snapshot).plan;
  const row = [...plan.pendingRows, ...plan.futureRows].find(value => value.source_recurring_expense_id === "expense");
  assert.equal(row.amount, 50);
  assert.throws(() => confirm(snapshot, { occurrenceKey: row.occurrence_key, amount: 51 }), /overdraw/);
  const accepted = confirm(snapshot, { occurrenceKey: row.occurrence_key, amount: 25 });
  assert.equal(accepted.request.openingBalance, 25);
  assert.equal(accepted.localHistory[0].amount, 25);
  assert.equal(refreshLocalSnapshot({ snapshot: accepted, ...accepted.request }).request.openingBalance, 25);
  const undone = undoLocalConfirmation({ snapshot: accepted, confirmationId: accepted.localLastConfirmationId,
    ...accepted.request, idSeed: "undo-partial-expense" });
  assert.equal(undone.request.openingBalance, 50);
  const corrupt = legacy(accepted);
  corrupt.localHistory[0].amount = 101; corrupt.localHistory[0].ledger_amount = 101;
  assert.throws(() => refreshLocalSnapshot({ snapshot: corrupt, ...corrupt.request }), /overdraft/);
});
test("confirmed income increases the local balance using shared arithmetic", () => {
  const after = confirm(local(100, true));
  assert.equal(after.request.openingBalance, 600);
});

test("multiple confirmations preserve opening balance and never double-spend the same occurrence", () => {
  const snapshot = local(100, true);
  snapshot.request.tables.one_off_transactions.push({ id: "expense-2", name: "Bill", type: "expense",
    currency: "PLN", amount: 200, date: snapshot.request.today });
  const incomeKey = calculateSnapshot(snapshot).plan.pendingRows.find(row => row.type === "income").occurrence_key;
  const first = confirm(snapshot, { occurrenceKey: incomeKey });
  assert.equal(first.request.openingBalance, 600);
  const expense = calculateSnapshot(first).plan.pendingRows.find(row => row.type === "expense");
  const second = confirm(first, { occurrenceKey: expense.occurrence_key, idSeed: "second-confirm" });
  assert.equal(second.request.openingBalance, 400);
  assert.equal(second.localHistory.length, 2);
  assert.equal(second.localOpeningBalance, 500);
  assert.equal(calculateSnapshot(second).plan.pendingRows.length, 0);
});

test("local refresh recomputes balances and progress from history rather than imported aggregates", () => {
  const snapshot = confirm(local());
  snapshot.request.openingBalance = 999999;
  snapshot.localHistory[0].running_balance_pln = 999999;
  snapshot.request.oneOffProgress = [];
  const after = refreshLocalSnapshot({ snapshot, today: "2026-06-02", generationTimestamp: "2026-06-02T12:00:00.000Z", idSeed: "refresh" });
  assert.equal(after.request.openingBalance, 200);
  assert.equal(after.request.today, "2026-06-02");
  assert.equal(calculateSnapshot(after).plan.pendingRows.length, 0);
  const empty = local();
  assert.equal(refreshLocalSnapshot({ snapshot: empty, ...empty.request }).request.openingBalance, 500);
  after.localHistory.push(after.localHistory[0]);
  assert.throws(() => refreshLocalSnapshot({ snapshot: after, ...after.request }), /duplicate/);
});

test("confirmation cannot trust inflated imported balances or reuse a ledger identifier", () => {
  const first = confirm(local(300));
  first.request.tables.one_off_transactions.push({ id: "next-bill", name: "Next bill", type: "expense",
    currency: "PLN", amount: 400, date: first.request.today });
  first.request.openingBalance = 9999;
  assert.throws(() => confirm(first, { occurrenceKey: "one_off:next-bill:expense:2026-06-01", idSeed: "new-confirm" }), /fully funded|due pending|precise cents/);
  first.request.tables.one_off_transactions[1].amount = 50;
  assert.throws(() => confirm(first, { occurrenceKey: "one_off:next-bill:expense:2026-06-01" }), /identifier already used/);
});

test("standalone history rejects invalid dates, missing identifiers and unsupported workflow state", () => {
  for (const change of [snapshot => { snapshot.localHistory[0].date = "2026-02-30"; },
    snapshot => { delete snapshot.localHistory[0].id; },
    snapshot => { snapshot.request.tables.pending_transactions.push({ id: "manual", amount: 1 }); },
    snapshot => { snapshot.localHistory[0].amount = 1000; }]) {
    const snapshot = confirm(local());
    change(snapshot);
    assert.throws(() => refreshLocalSnapshot({ snapshot, ...snapshot.request }));
  }
});

test("backdated local confirmation cannot create history that fails on the next reopen", () => {
  const first = confirm(local(500, true));
  first.request.tables.one_off_transactions.push({ id: "backdated", name: "Earlier bill", type: "expense",
    currency: "PLN", amount: 600, date: "2026-05-31" });
  assert.throws(() => confirm(first, {
    occurrenceKey: "one_off:backdated:expense:2026-05-31", idSeed: "backdated-confirm"
  }), /historical local overdraft|due pending/);
});

test("standalone import rejects unsupported source values and duplicate IDs", () => {
  for (const mutate of [row => { row.currency = "EUR"; }, row => { row.amount = -1; },
    row => { row.amount = 1.001; }, row => { row.name = ""; }, row => { row.date = "2026-02-30"; }]) {
    const snapshot = local(); mutate(snapshot.request.tables.one_off_transactions[0]);
    assert.throws(() => refreshLocalSnapshot({ snapshot, ...snapshot.request }));
  }
  const duplicate = local();
  duplicate.request.tables.one_off_transactions.push({ ...duplicate.request.tables.one_off_transactions[0] });
  assert.throws(() => refreshLocalSnapshot({ snapshot: duplicate, ...duplicate.request }), /Duplicate/);
});

test("one-step local undo restores balances and makes the occurrence pending again", () => {
  const before = confirm(local());
  const command = { snapshot: before, confirmationId: before.localLastConfirmationId,
    today: before.request.today, generationTimestamp: before.request.generationTimestamp, idSeed: "undo-1" };
  const undone = undoLocalConfirmation(command);
  assert.equal(undone.revision, 2);
  assert.equal(undone.request.openingBalance, 500);
  assert.equal(undone.localHistory.length, 0);
  assert.equal(calculateSnapshot(undone).plan.pendingRows.length, 1);
  assert.equal(before.localHistory.length, 1);
  assert.throws(() => undoLocalConfirmation({ ...command, confirmationId: "other" }), /last locally/);
  assert.throws(() => undoLocalConfirmation({ ...command, snapshot: undone }), /last locally/);
  assert.throws(() => undoLocalConfirmation({ ...command, snapshot: { ...before, budgetId: "server" } }), /standalone/);
});

test("history requires matching sources occurrence keys and undo references", () => {
  for (const mutate of [snapshot => { snapshot.localHistory[0].occurrence_key = "fake"; },
    snapshot => { snapshot.localHistory[0].source_one_off_id = "missing"; },
    snapshot => { snapshot.localHistory[0].source_recurring_income_id = "ambiguous"; },
    snapshot => { snapshot.localLastConfirmationId = "missing"; }]) {
    const snapshot = confirm(local()); mutate(snapshot);
    assert.throws(() => refreshLocalSnapshot({ snapshot, ...snapshot.request }));
  }
});

test("standalone opening balance rejects silent rounding and unsafe cents", () => {
  for (const opening of [0.001, Number.MAX_SAFE_INTEGER, "500", null]) {
    const snapshot = local();
    snapshot.localOpeningBalance = opening;
    // Null is not an explicit valid opening balance: the source fallback must
    // also be invalid rather than letting a nullish field mask malformed data.
    snapshot.request.openingBalance = opening;
    assert.throws(() => refreshLocalSnapshot({ snapshot, ...snapshot.request }));
  }
});

test("standalone history requires exact confirmation dates and ordering metadata", () => {
  for (const patch of [{ created_at: "not-a-timestamp" }, { created_at: "2026-02-30T12:00:00Z" },
    { created_at: "2026-06-01T25:00:00Z" }, { created_at: null }, { status: "pending" },
    { ledger_year: "2026" }, { ledger_year: 2025 }, { confirmed_date: "2026-06-02" },
    { confirmed_date: "2026-05-01" }, { confirmed_date: null }]) {
    const snapshot = confirm(local());
    Object.assign(snapshot.localHistory[0], patch);
    assert.throws(() => refreshLocalSnapshot({ snapshot, ...snapshot.request }), /history/);
  }
});

test("payments may exceed the allocation like on the server, but never overdraw", () => {
  const paid = confirm(local(), { amount: 350 });
  assert.equal(paid.request.openingBalance, 150);
  assert.equal(calculateSnapshot(paid).plan.pendingRows.length, 0, "an overpaid one-off is complete, with no remainder");
  const reopened = refreshLocalSnapshot({ snapshot: structuredClone(paid), ...paid.request });
  assert.equal(reopened.localHistory[0].amount, 350);
  assert.throws(() => confirm(local(), { amount: 500.01 }), /overdraw/);

  const snapshot = local();
  snapshot.request.tables.one_off_transactions = [];
  snapshot.request.tables.planned_transactions = [{ id: "food-plan", operating_priority: 1 }];
  snapshot.request.tables.recurring_expenses = [{ id: "food", name: "Groceries", amount: 120, currency: "PLN", active: 1,
    necessary: 0, planned_transaction_id: "food-plan", prediction_strategy: "fixed", repeat_every_months: 1,
    anchor_type: "day_of_month", anchor_day_of_month: 1, anchor_business_day_adjustment: "none" }];
  const plan = calculateSnapshot(snapshot).plan;
  const row = [...plan.pendingRows, ...plan.futureRows].find(value => value.source_recurring_expense_id === "food");
  const over = confirm(snapshot, { occurrenceKey: row.occurrence_key, amount: 130 });
  assert.equal(over.request.openingBalance, 370);
  assert.equal(refreshLocalSnapshot({ snapshot: structuredClone(over), ...over.request }).localHistory[0].amount, 130);
});
