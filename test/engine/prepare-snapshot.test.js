import assert from "node:assert/strict";
import test from "node:test";
import { prepareSnapshot } from "../../src/engine/prepare-snapshot.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { completeSnapshot } from "./fixtures.js";

test("complete history prepares installments, currency-scoped funding, and opening balance", () => {
  const original = completeSnapshot();
  const history = [
    { id: "income", type: "income", currency: "PLN", ledger_currency: "PLN", amount: 500,
      ledger_amount: 500, date: "2026-05-01", running_balance_pln: 500 },
    { id: "part", type: "expense", currency: "PLN", ledger_currency: "PLN", amount: 100,
      ledger_amount: 100, date: "2026-05-20", running_balance_pln: 400, source_one_off_id: "one-1" },
    { id: "old-goal", type: "expense", currency: "EUR", ledger_currency: "EUR", amount: 20,
      ledger_amount: 20, date: "2026-05-21", source_goal_id: "goal" },
    { id: "future-goal", type: "expense", currency: "PLN", ledger_currency: "PLN", amount: 10,
      ledger_amount: 10, date: "2026-06-20", source_goal_id: "goal" }
  ];
  const snapshot = prepareSnapshot({ budgetId: original.budgetId, revision: 3,
    ...original.request, confirmedRows: history });
  assert.equal(snapshot.request.openingBalance, 400);
  assert.deepEqual(snapshot.request.confirmedFunding.source_goal_id, [["goal", 10]]);
  assert.equal(snapshot.request.confirmedRowsAfterToday.length, 1);
  assert.deepEqual(snapshot.request.oneOffProgress, [["one-1:expense:PLN", {
    sourceId: "one-1", type: "expense", currency: "PLN", confirmedAmount: 100, confirmedCount: 1
  }]]);
  const result = calculateSnapshot(snapshot);
  assert.equal(result.baseRevision, 3);
  const row = result.plan.futureRows.find(item => item.source_one_off_id === "one-1");
  assert.equal(row.requested_amount, 200);
});

test("PostgreSQL date and JSON storage types become plain engine inputs", () => {
  const original = completeSnapshot();
  const snapshot = prepareSnapshot({ budgetId: original.budgetId, revision: 0, ...original.request,
    confirmedRows: [{ id: "pg-income", type: "income", currency: "PLN", ledger_currency: "PLN",
      amount: 500, ledger_amount: 500, running_balance_pln: 500,
      date: new Date(2026, 4, 1), created_at: new Date("2026-05-01T12:00:00Z") }] });
  assert.equal(snapshot.request.predictionRows[0].date, "2026-05-01");
  assert.equal(snapshot.request.predictionRows[0].created_at, "2026-05-01T12:00:00.000Z");
  assert.equal(snapshot.request.openingBalance, 500);
  assert.doesNotThrow(() => calculateSnapshot(snapshot));
});