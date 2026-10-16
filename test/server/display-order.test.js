import assert from "node:assert/strict";
import test from "node:test";
import { compareFutureRowsForDisplay, compareLedgerRowsForDisplay, confirmedRowsForDisplay } from "../../src/server/cashflow-display-order.js";
import { computeReservedBalanceByRowId } from "../../src/server/cashflow-planning-balance-plan.js";

test("display comparators prioritize date, then income, regardless of period, timestamp, ID, or allocation type", () => {
  const rows = [
    { id: "a", type: "goal_allocation", date: "2026-11-30", period: "2026-01", created_at: "a" },
    { id: "b", type: "expense", date: "2026-11-30", period: "2026-01", created_at: "a" },
    { id: "z", type: "income", date: "2026-11-30", period: "2026-12", created_at: "z" },
    { id: "earlier", type: "expense", date: "2026-11-29" }
  ];
  for (const compare of [compareLedgerRowsForDisplay, compareFutureRowsForDisplay]) {
    assert.deepEqual([...rows].sort(compare).slice(0, 2).map(row => row.id), ["earlier", "z"]);
    assert.equal(compare({}, {}), 0);
  }
});

test("confirmed display preserves per-currency opening balances and date-descending sections without mutating storage rows", () => {
  const rows = [
    { id: "a", type: "expense", date: "2026-11-30", amount: 10, ledger_amount: 10, running_balance_pln: 90, ledger_currency: "PLN" },
    { id: "z", type: "income", date: "2026-11-30", amount: 50, ledger_amount: 50, running_balance_pln: 140, ledger_currency: "PLN" },
    { id: "next", type: "expense", date: "2026-12-01", amount: 20, ledger_amount: 20, running_balance_pln: 120, ledger_currency: "PLN" },
    { id: "eur", type: "income", date: "2026-11-29", amount: 2, ledger_amount: 2, running_balance_pln: 12, ledger_currency: "EUR" }
  ];
  const before = structuredClone(rows);
  const displayed = confirmedRowsForDisplay(rows);
  assert.deepEqual(displayed.map(row => [row.id, row.running_balance]), [["next", 120], ["z", 150], ["a", 140], ["eur", 12]]);
  assert.deepEqual(rows, before);
});

test("pending reserved-balance walk uses income-first ordering just like its display", () => {
  const reserved = computeReservedBalanceByRowId({ settings: { ledger_currency: "PLN" }, today: "2026-10-16", pendingRows: [
    { id: "a-expense", date: "2026-11-30", type: "expense", ledger_amount: 10, occurrence_key: "reserve_transfer:a:b:out" },
    { id: "z-income", date: "2026-11-30", type: "income", ledger_amount: 10, occurrence_key: "reserve_transfer:a:b:in" }
  ] });
  assert.equal(reserved.get("z-income"), -10);
  assert.equal(reserved.get("a-expense"), 0);
});

test("confirmed display computes missing balances from zero rather than inventing an opening offset", () => {
  const rows = confirmedRowsForDisplay([
    { id: "a", type: "expense", date: "2026-11-30", amount: 5, ledger_amount: 5 },
    { id: "z", type: "income", date: "2026-11-30", amount: 10, ledger_amount: 10 }
  ]);
  assert.deepEqual(rows.map(row => row.running_balance), [10, 5]);
});