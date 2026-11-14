import assert from "node:assert/strict";
import test from "node:test";
import { createCashflowPendingConfirmationService } from "../../src/server/cashflow-pending-confirmation-service.js";

test("confirmation preflight does not overlap reads on a transaction-bound PostgreSQL client", async () => {
  let active = false;
  const calls = [];
  const budgetStore = { backend: "postgres", transactionBound: true, transaction() {},
    async listPlanningRows(_id, table) {
      assert.equal(active, false, `overlapping ${table} query`);
      active = true;
      calls.push(table);
      await new Promise(resolve => setImmediate(resolve));
      active = false;
      return [];
    } };
  const service = createCashflowPendingConfirmationService({ budgetStore });
  await assert.rejects(service.confirmPendingTransaction("budget", "missing"), error => error.status === 404);
  assert.deepEqual(calls, ["pending_transactions", "settings", "ledger_currency_events", "recurring_incomes"]);
  assert.equal(active, false);
});

test("failed confirmation preflight starts no more queries before its owner rolls back", async () => {
  const calls = [];
  const budgetStore = { backend: "postgres", transactionBound: true, transaction() {},
    async listPlanningRows(_id, table) { calls.push(table); throw new Error("preflight read failed"); } };
  const service = createCashflowPendingConfirmationService({ budgetStore });
  await assert.rejects(service.confirmPendingTransaction("budget", "missing"), /preflight read failed/);
  assert.deepEqual(calls, ["pending_transactions"]);
});
