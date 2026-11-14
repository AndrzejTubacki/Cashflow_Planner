import assert from "node:assert/strict";
import test from "node:test";
import { completeSnapshot } from "./fixtures.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { confirmLocalOccurrence, refreshLocalSnapshot } from "../../src/engine/local-confirmation.js";

const today = "2026-06-10";
let seeds = 0;

function local(tables) {
  const snapshot = completeSnapshot();
  snapshot.budgetId = "local-actual-date";
  Object.assign(snapshot.request, { today, generationTimestamp: `${today}T12:00:00.000Z` });
  Object.assign(snapshot.request.tables, { one_off_transactions: [], recurring_incomes: [], recurring_expenses: [],
    planned_transactions: [], ...tables });
  return refreshLocalSnapshot({ snapshot, ...snapshot.request });
}

function due(snapshot, predicate) {
  const plan = calculateSnapshot(snapshot).plan;
  return [...plan.pendingRows, ...plan.futureRows].find(row => row.date <= today && predicate(row));
}

function confirm(snapshot, row, extra) {
  return confirmLocalOccurrence({ snapshot, occurrenceKey: row.occurrence_key, today,
    generationTimestamp: `${today}T12:00:00.000Z`, idSeed: `seed-${++seeds}`, ...extra });
}

const oneOff = { id: "laptop", name: "Laptop", amount: 300, currency: "PLN", date: today, type: "expense" };
const rent = { id: "rent", name: "Rent", amount: 100, currency: "PLN", active: 1, necessary: 1, planned_transaction_id: "rent-plan",
  prediction_strategy: "fixed", repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 10,
  anchor_offset_days: 0, anchor_business_day_adjustment: "none" };

test("an actual payment date is the ledger date while the occurrence identity is unchanged", () => {
  const snapshot = local({ one_off_transactions: [oneOff] });
  const row = due(snapshot, value => value.source_one_off_id === "laptop");
  const paid = confirm(snapshot, row, { amount: 100, actualDate: "2026-05-28" });
  const [history] = paid.localHistory;
  assert.equal(history.date, "2026-05-28");
  assert.equal(history.ledger_year, 2026);
  assert.equal(history.confirmed_date, today);
  assert.equal(history.occurrence_key, row.occurrence_key);
  // Reopening validates the retained original and keeps the installment chain.
  const reopened = refreshLocalSnapshot({ snapshot: paid, ...paid.request });
  const remainder = due(reopened, value => value.source_one_off_id === "laptop");
  assert.equal(remainder.amount, 200);
  assert.match(remainder.occurrence_key, /^one_off_remainder:laptop:2$/);
  const closed = confirm(reopened, remainder, { actualDate: "2025-12-31" });
  assert.deepEqual(closed.localHistory.map(value => [value.date, value.ledger_year]).sort(),
    [["2025-12-31", 2025], ["2026-05-28", 2026]]);
  assert.equal(due(refreshLocalSnapshot({ snapshot: closed, ...closed.request }), value => value.source_one_off_id === "laptop"), undefined);
});

test("a recurring payment made on another day closes its scheduled occurrence", () => {
  const snapshot = local({ planned_transactions: [{ id: "rent-plan", operating_priority: 1 }], recurring_expenses: [rent] });
  const row = due(snapshot, value => value.source_recurring_expense_id === "rent");
  const paid = refreshLocalSnapshot({ snapshot: confirm(snapshot, row, { actualDate: "2026-06-08" }), request: undefined,
    today, generationTimestamp: `${today}T12:00:00.000Z`, idSeed: "reopen" });
  assert.equal(paid.localHistory[0].date, "2026-06-08");
  assert.equal(due(paid, value => value.occurrence_key === row.occurrence_key), undefined);
});

test("future, malformed and omitted actual dates", () => {
  const snapshot = local({ one_off_transactions: [oneOff] });
  const row = due(snapshot, value => value.source_one_off_id === "laptop");
  assert.throws(() => confirm(snapshot, row, { actualDate: "2026-06-11" }), /no later than today/);
  assert.throws(() => confirm(snapshot, row, { actualDate: "2026-02-30" }), /actualDate/);
  assert.equal(confirm(snapshot, row, {}).localHistory[0].date, today);
});

test("tampered originals cannot move an occurrence off its schedule through the payment date", () => {
  const snapshot = local({ planned_transactions: [{ id: "rent-plan", operating_priority: 1 }], recurring_expenses: [rent] });
  const row = due(snapshot, value => value.source_recurring_expense_id === "rent");
  const paid = confirm(snapshot, row, { actualDate: "2026-06-08" });
  for (const key of [row.occurrence_key.replace(today, "2026-06-09"), row.occurrence_key.replace(today, "2026-06-11")]) {
    const tampered = structuredClone(paid);
    tampered.localAudit[0].row.occurrence_key = key;
    tampered.localHistory[0].occurrence_key = key;
    tampered.request.predictionRows[0].occurrence_key = key;
    assert.throws(() => refreshLocalSnapshot({ snapshot: tampered, ...tampered.request }), /audit/i, key);
  }
});

test("an upcoming occurrence can be recorded early only when explicitly requested", () => {
  const upcoming = { ...oneOff, id: "trip", name: "Trip", date: "2026-07-01" };
  const snapshot = local({ one_off_transactions: [upcoming],
    planned_transactions: [{ id: "rent-plan", operating_priority: 1 }], recurring_expenses: [rent] });
  const plan = calculateSnapshot(snapshot).plan;
  const future = [...plan.pendingRows, ...plan.futureRows];
  const trip = future.find(row => row.source_one_off_id === "trip");
  const july = future.find(row => row.source_recurring_expense_id === "rent" && row.date === "2026-07-10");
  assert.throws(() => confirm(snapshot, trip, {}), /Only due pending/);
  assert.throws(() => confirm(snapshot, trip, { early: "yes" }), /explicit/);
  assert.throws(() => confirm(snapshot, trip, { early: true, actualDate: "2026-07-01" }), /no later than today/);
  const dueRent = future.find(row => row.source_recurring_expense_id === "rent" && row.date === today);
  assert.throws(() => confirm(snapshot, dueRent, { early: true }), /upcoming/);
  const paid = confirm(snapshot, trip, { early: true, amount: 100 });
  assert.equal(paid.localHistory[0].date, today);
  assert.match(paid.localHistory[0].occurrence_key, /2026-07-01$/);
  const reopened = refreshLocalSnapshot({ snapshot: paid, ...paid.request });
  const remaining = calculateSnapshot(reopened).plan;
  const tripRows = [...remaining.pendingRows, ...remaining.futureRows].filter(row => row.source_one_off_id === "trip");
  assert.deepEqual(tripRows.map(row => [row.amount, row.date]), [[200, "2026-07-01"]]);
  const rentPaid = refreshLocalSnapshot({ snapshot: confirm(reopened, july, { early: true, actualDate: "2026-06-09" }),
    today, generationTimestamp: `${today}T12:00:00.000Z`, idSeed: "reopen-early" });
  const after = calculateSnapshot(rentPaid).plan;
  assert.ok(![...after.pendingRows, ...after.futureRows].some(row => row.occurrence_key === july.occurrence_key));
  assert.ok([...after.pendingRows, ...after.futureRows].some(row => row.source_recurring_expense_id === "rent" && row.date === "2026-08-10"));
});
