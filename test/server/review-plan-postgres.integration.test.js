import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createCashflowLedgerService } from "../../src/server/cashflow-ledger-service.js";
import { createCashflowPendingConfirmationService } from "../../src/server/cashflow-pending-confirmation-service.js";
import { createCashflowPlanMutationService } from "../../src/server/cashflow-plan-mutation-service.js";
import { createCashflowRecoveryService } from "../../src/server/cashflow-recovery-service.js";
import { createCashflowBackupService } from "../../src/server/cashflow-backup-service.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

const gated = { skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests" };
const stamp = "2026-01-01T00:00:00.000Z";
const confirmed = (id, amount, type, extra = {}) => ({
  id, name: id, amount, type, currency: "PLN", ledger_currency: "PLN", ledger_year: 2025,
  date: "2025-12-01", confirmed_date: "2025-12-01", fx_rate: 1, buffered_fx_rate: 1,
  ledger_amount: amount, running_balance_pln: 0, created_at: stamp, updated_at: stamp, ...extra
});

async function withStores(work) {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const a = await createPostgresBudgetStore({ databaseUrl });
    const b = await createPostgresBudgetStore({ databaseUrl });
    try {
      await global.initialize(); await a.initialize();
      for (const id of ["review_a", "review_b"]) {
        await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,$1,now(),now())", [id]);
        await pool.query("INSERT INTO settings (budget_id,updated_at) VALUES ($1,now())", [id]);
      }
      await work(a, b);
    } finally { await b.close(); await a.close(); await global.close(); }
  });
}

// Force both real preflight reads AND safety snapshots to finish before either
// replica writes. A losing read-only validation must never restore its old snapshot.
test("Postgres confirmations recheck shared balance under lock without rolling back the winner", gated, async () => {
  await withStores(async (a, b) => {
    await a.insertConfirmedTransactions("review_a", [confirmed("opening", 100, "income"),
      confirmed("old-currency", 900, "expense", { currency: "EUR", ledger_currency: "EUR" })]);
    await a.insertPlanningRows("review_a", "pending_transactions", ["expense_a", "expense_b"].map(id => ({
      id, name: id, currency: "PLN", amount: 80, type: "expense", date: "2026-01-01",
      funded_amount: 80, occurrence_key: id, created_at: stamp, updated_at: stamp
    })));
    let arrivals = 0, release, reject, timer;
    const gate = new Promise((resolve, fail) => { release = resolve; reject = fail; });
    let restores = 0;
    const preflights = [];
    const services = [a, b].map(store => {
      const ledger = createCashflowLedgerService({ budgetStore: store });
      const backup = createCashflowBackupService({
        budgetStore: store, generateId: prefix => `${prefix}_${crypto.randomUUID()}`,
        getSettingsAsync: async id => (await store.listPlanningRows(id, "settings"))[0],
        recalculateLedgerRunningBalanceAsync: ledger.recalculateLedgerRunningBalanceAsync,
        regenerateProjectionsAfterMutationAsync: async () => ({ projection_ok: true })
      });
      const recovery = createCashflowRecoveryService({
        budgetStore: store, logError: () => {}, logServerEvent: () => {},
        createBackupAsync: async (...args) => {
          const ref = await backup.createBackupAsync(...args);
          if (++arrivals === 1) timer = setTimeout(() => reject(new Error("snapshot barrier timed out")), 20000);
          if (arrivals === 2) { clearTimeout(timer); release(); }
          await gate;
          return ref;
        },
        restoreBackupFromPathAsync: async (...args) => {
          restores++;
          return backup.restoreBackupFromPathAsync(...args);
        }
      });
      return createCashflowPendingConfirmationService({
        budgetStore: store,
        getConfirmedFxForDate: async () => ({ fxRate: 1, bufferedFxRate: 1 }),
        wouldLedgerGoNegativeAfterInsertAsync: async (...args) => {
          const negative = await ledger.wouldLedgerGoNegativeAfterInsertAsync(...args);
          preflights.push(negative); return negative;
        },
        runRecoverableUserMutation: recovery.runRecoverableUserMutation,
        withProjectionStatus: (_id, result) => result
      });
    });
    const outcomes = await Promise.allSettled(services.map((service, index) =>
      service.confirmPendingTransaction("review_a", index ? "expense_b" : "expense_a")));
    clearTimeout(timer);
    assert.deepEqual(preflights, [false, false]);
    assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
    const denied = outcomes.find(result => result.status === "rejected");
    assert.equal(denied.reason.status, 400);
    assert.match(denied.reason.message, /balance negative/);
    assert.equal(restores, 0, "rejecting an unwritten candidate must not restore an older snapshot");
    const rows = (await a.listConfirmedTransactions("review_a")).filter(row => row.ledger_currency === "PLN");
    assert.equal(rows.length, 2);
    assert.equal(Number(rows.find(row => row.type === "expense").running_balance_pln), 20);
    assert.equal((await a.listPlanningRows("review_a", "pending_transactions")).length, 1);
  });
});

test("Postgres funded goal currency changes are rejected before changing goal or priority", gated, async () => {
  await withStores(async (a, b) => {
    const first = createCashflowPlanMutationService({ budgetStore: a, withProjectionStatus: (_id, row) => row });
    const second = createCashflowPlanMutationService({ budgetStore: b, withProjectionStatus: (_id, row) => row });
    for (const amount of [30, 60]) {
      const goal = await first.createGoal("review_a", { name: "Goal", currency: "PLN", amount: 60,
        due_date: "2026-06-01", priority: 1 });
      await a.insertConfirmedTransactions("review_a", [confirmed(`funded_${amount}`, amount, "expense", { source_goal_id: goal.id })]);
      await assert.rejects(second.updateGoal("review_a", goal.id, { currency: "EUR", name: "Changed", priority: 7 }),
        error => error.status === 400 && /Cannot change currency.*confirmed ledger history/.test(error.message));
      assert.equal((await a.listPlanningRows("review_a", "goals")).find(row => row.id === goal.id).currency, "PLN");
      assert.equal(Number((await a.listPlanningRows("review_a", "planned_transactions")).find(row => row.id === goal.planned_transaction_id).goal_priority), 1);
      assert.equal((await second.updateGoal("review_a", goal.id, { currency: "PLN", name: "Renamed" })).name, "Renamed");
    }
    const unfunded = await first.createGoal("review_a", { name: "Unfunded", currency: "PLN", amount: 60,
      due_date: "2026-06-01", priority: 2 });
    // An equal source ID in another budget must not impose this guard here.
    await b.insertConfirmedTransactions("review_b", [confirmed("other-budget", 60, "expense", { source_goal_id: unfunded.id })]);
    assert.equal((await second.updateGoal("review_a", unfunded.id, { currency: "EUR" })).currency, "EUR");
  });
});
