import assert from "node:assert/strict";
import test from "node:test";
import { completeSnapshot } from "./fixtures.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { confirmLocalOccurrence, refreshLocalSnapshot } from "../../src/engine/local-confirmation.js";
import { recurringOccurrencesInPeriod } from "../../src/engine/cashflow-date-utils.js";

const rent = extra => ({ id: "rent", name: "Rent", amount: 100, currency: "PLN", active: 1, necessary: 1, planned_transaction_id: "rent-plan",
  prediction_strategy: "fixed", repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 31,
  anchor_offset_days: 0, anchor_business_day_adjustment: "none", ...extra });

function local(today, tables) {
  const snapshot = completeSnapshot();
  snapshot.budgetId = "local-boundaries";
  Object.assign(snapshot.request, { today, generationTimestamp: `${today}T12:00:00.000Z` });
  Object.assign(snapshot.request.tables, { one_off_transactions: [], recurring_incomes: [], recurring_expenses: [],
    planned_transactions: [{ id: "rent-plan", operating_priority: 1 }], ...tables });
  return refreshLocalSnapshot({ snapshot, ...snapshot.request });
}
const rows = snapshot => { const plan = calculateSnapshot(snapshot).plan; return [...plan.pendingRows, ...plan.futureRows]; };

test("day-31 and leap-day anchors land on the last day of short months and on Feb 29 only in leap years", () => {
  const monthly = rent();
  assert.deepEqual(recurringOccurrencesInPeriod(monthly, { start: "2028-02-01", end: "2028-02-29" }), ["2028-02-29"]);
  assert.deepEqual(recurringOccurrencesInPeriod(monthly, { start: "2027-02-01", end: "2027-02-28" }), ["2027-02-28"]);
  assert.deepEqual(recurringOccurrencesInPeriod(monthly, { start: "2027-04-01", end: "2027-04-30" }), ["2027-04-30"]);
  const yearly = rent({ anchor_day_of_month: 29, repeat_every_months: 12, start_month_year: "2028-02" });
  for (const [year, day] of [[2028, "29"], [2029, "28"], [2031, "28"], [2032, "29"]]) {
    assert.deepEqual(recurringOccurrencesInPeriod(yearly, { start: `${year}-01-01`, end: `${year}-12-31` }), [`${year}-02-${day}`]);
  }
  // Accepted on the leap day itself, reopened on the following day.
  const snapshot = local("2028-02-29", { recurring_expenses: [monthly] });
  const due = rows(snapshot).find(row => row.date === "2028-02-29");
  const paid = confirmLocalOccurrence({ snapshot, occurrenceKey: due.occurrence_key, today: "2028-02-29",
    generationTimestamp: "2028-02-29T12:00:00.000Z", idSeed: "leap" });
  const reopened = refreshLocalSnapshot({ snapshot: paid, today: "2028-03-01", generationTimestamp: "2028-03-01T08:00:00.000Z", idSeed: "leap-reopen" });
  assert.equal(reopened.localHistory[0].date, "2028-02-29");
  assert.ok(rows(reopened).some(row => row.date === "2028-03-31"));
});

test("the ledger year follows the actual payment date across a year boundary", () => {
  // An overdue one-off from December stays due on January 1st; recurring rows start at today's period.
  const snapshot = local("2027-01-01", { planned_transactions: [], one_off_transactions: [
    { id: "gift", name: "Gift", amount: 60, currency: "PLN", date: "2026-12-31", type: "expense" },
    { id: "trip", name: "Trip", amount: 40, currency: "PLN", date: "2027-01-05", type: "expense" }] });
  const gift = rows(snapshot).find(row => row.source_one_off_id === "gift");
  const paid = confirmLocalOccurrence({ snapshot, occurrenceKey: gift.occurrence_key, today: "2027-01-01",
    generationTimestamp: "2027-01-01T12:00:00.000Z", idSeed: "y1", actualDate: "2027-01-01" });
  assert.equal(paid.localHistory[0].ledger_year, 2027);
  assert.match(paid.localHistory[0].occurrence_key, /2026-12-31$/);
  const reopened = refreshLocalSnapshot({ snapshot: paid, ...paid.request });
  const trip = rows(reopened).find(row => row.source_one_off_id === "trip");
  const early = confirmLocalOccurrence({ snapshot: reopened, occurrenceKey: trip.occurrence_key, today: "2027-01-01",
    generationTimestamp: "2027-01-01T13:00:00.000Z", idSeed: "y2", early: true, actualDate: "2026-12-30" });
  assert.equal(early.localHistory.find(row => row.source_one_off_id === "trip").ledger_year, 2026);
  assert.deepEqual(early.localHistory.map(row => row.date), ["2026-12-30", "2027-01-01"]);
  assert.equal(refreshLocalSnapshot({ snapshot: early, ...early.request }).request.openingBalance, early.request.openingBalance);
});

test("history dated after the calculation date is rejected, which is why native hosts never move today backwards", () => {
  const snapshot = local("2026-10-20", { planned_transactions: [], one_off_transactions: [{ id: "bill", name: "Bill", amount: 5, currency: "PLN", date: "2026-10-20", type: "expense" }] });
  const bill = rows(snapshot).find(row => row.source_one_off_id === "bill");
  const paid = confirmLocalOccurrence({ snapshot, occurrenceKey: bill.occurrence_key, today: "2026-10-20",
    generationTimestamp: "2026-10-20T00:30:00.000Z", idSeed: "tz" });
  assert.throws(() => refreshLocalSnapshot({ snapshot: paid, today: "2026-10-19", generationTimestamp: "2026-10-20T05:00:00.000Z", idSeed: "west" }),
    /audit date/);
});
