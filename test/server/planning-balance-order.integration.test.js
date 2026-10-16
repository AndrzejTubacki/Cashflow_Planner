import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { createSqliteBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createPlanningRunningBalancePlan, applyPlanningRunningBalancePlan } from "../../src/server/cashflow-planning-balance-plan.js";
import { initializeLedgerSchema } from "../../src/server/cashflow-schema.js";
import { renderLedgerTab } from "../../public/app/cashflow/ledger-tab.js";

test("all snapshot buckets put same-day income first and show matching balances without rewriting history", async () => {
  const harness = await createCashflowTestHarness({ userId: "all_bucket_order", today: "2026-10-16" });
  const store = createSqliteBudgetStore({ openPlanningDb: () => harness.openPlanningDb() });
  try {
    const stamp = "2026-10-16T08:00:00.000Z";
    const row = (id, type, amount, extra = {}) => ({
      id, name: id, type, amount, ledger_amount: amount, ledger_currency: "PLN", currency: "PLN",
      date: "2026-10-16", created_at: stamp, updated_at: stamp, status: "pending", ...extra
    });
    await store.insertPlanningRows(harness.userId, "pending_transactions", [
      row("a-pending-expense", "expense", 10), row("z-pending-income", "income", 50)
    ]);
    await store.insertPlanningRows(harness.userId, "future_transactions", [
      row("a-future-expense", "expense", 20, { period: "2026-10" }),
      row("z-future-income", "income", 100, { period: "2026-11" })
    ].map(({ updated_at, ...tx }) => ({ ...tx, status: "funded", generation_timestamp: stamp })));
    const ledger = harness.openLedgerDb("2026");
    try {
      initializeLedgerSchema(ledger);
      const insert = ledger.prepare(`INSERT INTO confirmed_transactions
        (id, name, currency, amount, type, date, confirmed_date, ledger_currency, ledger_amount,
         running_balance_pln, fx_rate, buffered_fx_rate, created_at, updated_at)
        VALUES (?, ?, 'PLN', ?, ?, '2026-10-16', '2026-10-16', 'PLN', ?, ?, 1, 1, ?, ?)`);
      // A retained opening balance of 100: expense confirmed before income.
      insert.run("a-confirmed-expense", "a-confirmed-expense", 20, "expense", 20, 80, stamp, stamp);
      insert.run("z-confirmed-income", "z-confirmed-income", 50, "income", 50, 130, stamp, stamp);
    } finally { ledger.close(); }
    const pending = await store.listPlanningRows(harness.userId, "pending_transactions");
    const future = await store.listPlanningRows(harness.userId, "future_transactions");
    const readConfirmed = () => {
      const db = harness.openLedgerDb("2026");
      try { return db.prepare("SELECT * FROM confirmed_transactions ORDER BY id").all(); }
      finally { db.close(); }
    };
    const confirmed = readConfirmed();
    const plan = createPlanningRunningBalancePlan({ pendingRows: pending, futureRows: future,
      confirmedRows: confirmed, settings: { ledger_currency: "PLN" }, today: harness.today });
    await applyPlanningRunningBalancePlan({ budgetId: harness.userId, budgetStore: store, plan });
    for (const snapshot of [harness.cashflow.getSnapshot(harness.userId), await harness.cashflow.getSnapshotAsync(harness.userId)]) {
      for (const [key, ids, balances] of [
        ["pendingTransactions", ["z-pending-income", "a-pending-expense"], [180, 170]],
        ["futureTransactions", ["z-future-income", "a-future-expense"], [270, 250]],
        ["confirmedTransactions", ["z-confirmed-income", "a-confirmed-expense"], [150, 130]]
      ]) {
        assert.deepEqual(snapshot[key].map(tx => tx.id), ids, key);
        assert.deepEqual(snapshot[key].map(tx => tx.running_balance), balances, key);
        const html = renderLedgerTab("en", snapshot);
        assert.ok(html.indexOf(`data-tx-id="${ids[0]}"`) < html.indexOf(`data-tx-id="${ids[1]}"`));
      }
    }
    assert.deepEqual(readConfirmed(), confirmed, "display must not rewrite history");
    assert.deepEqual(harness.errors, []);
  } finally { await harness.cleanup(); }
});

test("same-day ledger balances follow display order without changing funded rows", async () => {
  const harness = await createCashflowTestHarness({ userId: "balance_order_test", today: "2026-10-16" });
  const store = createSqliteBudgetStore({ openPlanningDb: () => harness.openPlanningDb() });
  try {
    const stamp = "2026-10-16T08:00:00.000Z";
    // IDs deliberately put expenses before income in the old balance walk.
    const rows = [
      { id: "opening", date: "2026-11-26", type: "income", amount: 5048.38, ledger_amount: 5048.38 },
      { id: "a-rent", type: "expense", amount: 4000, ledger_amount: 4000 },
      { id: "b-food", type: "expense", amount: 3500, ledger_amount: 3500 },
      { id: "c-bus", type: "expense", amount: 2500, ledger_amount: 2500 },
      { id: "d-accountant", type: "expense", amount: 500, ledger_amount: 500 },
      { id: "e-income", type: "income", currency: "EUR", amount: 2125, ledger_amount: 9284.34 },
      { id: "f-fuel", type: "expense", amount: 2000, ledger_amount: 2000 },
      { id: "g-partial", type: "expense", amount: 1832.72, ledger_amount: 1832.72, requested_amount: 3200, status: "partial" },
      { id: "h-unfunded", type: "expense", amount: 0, ledger_amount: 0, requested_amount: 200, status: "underfunded" }
    ].map(row => ({
      name: row.id, currency: "PLN", date: "2026-11-30", period: "2026-11",
      status: "funded", requested_amount: row.amount, funded_amount: row.amount,
      generation_timestamp: stamp, created_at: stamp, ledger_currency: "PLN", ...row
    }));
    await store.insertPlanningRows(harness.userId, "future_transactions", rows);
    const before = await store.listPlanningRows(harness.userId, "future_transactions");
    const settings = (await store.listPlanningRows(harness.userId, "settings"))[0];
    const plan = createPlanningRunningBalancePlan({ futureRows: before, settings, today: harness.today });
    await applyPlanningRunningBalancePlan({ budgetId: harness.userId, budgetStore: store, plan });
    const after = await store.listPlanningRows(harness.userId, "future_transactions");
    const withoutBalance = records => records.map(({ running_balance, ...row }) => row)
      .sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(withoutBalance(after), withoutBalance(before), "only running balances may change");

    for (const snapshot of [harness.cashflow.getSnapshot(harness.userId), await harness.cashflow.getSnapshotAsync(harness.userId)]) {
      const displayed = snapshot.futureTransactions;
      assert.equal(displayed[1].id, "e-income");
      assert.equal(displayed[1].running_balance, 14332.72);
      let balance = 0;
      for (const row of displayed) {
        balance = Math.round((balance + (row.type === "income" ? row.ledger_amount : -row.ledger_amount)) * 100) / 100;
        assert.equal(row.running_balance, balance, row.id);
      }
      assert.equal(balance, 0);
    }
    assert.deepEqual(harness.errors, []);
  } finally {
    await harness.cleanup();
  }
});