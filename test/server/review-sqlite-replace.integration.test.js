import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { createSqliteBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createCashflowDataPortabilityService } from "../../src/server/cashflow-data-portability-service.js";

async function withPopulatedBudget(work) {
  const harness = await createCashflowTestHarness({ userId: "review_replace" });
  try {
    const paths = createCashflowStoragePaths(harness.dataDir);
    const dbService = createCashflowDbService(paths);
    const budgetStore = createSqliteBudgetStore(dbService);
    const service = createCashflowDataPortabilityService({ budgetStore });
    const income = await harness.api("/api/one-off", {
      method: "POST", body: { name: "Opening income", currency: "PLN", amount: 1000, type: "income", date: harness.today }
    });
    const pendingIncome = (await harness.api("/api")).pendingTransactions.find(row => row.source_one_off_id === income.id);
    assert.ok(pendingIncome);
    await harness.api(`/api/pending/${encodeURIComponent(pendingIncome.id)}/confirm`, {
      method: "POST", body: { amount: 1000, confirmed_date: harness.today }
    });
    const expense = await harness.api("/api/recurring-expenses", {
      method: "POST", body: {
        name: "Original rent", currency: "PLN", amount: 100, necessary: 1,
        active: 1, priority: 1, anchor_type: "day_of_month", anchor_day_of_month: 20,
        anchor_business_day_adjustment: "none", repeat_every_months: 1
      }
    });
    const futureExpense = (await harness.api("/api")).futureTransactions.find(row => row.source_recurring_expense_id === expense.id);
    assert.ok(futureExpense);
    await harness.api(`/api/future/${encodeURIComponent(futureExpense.id)}/move-to-pending`, {
      method: "POST", body: { occurrenceKey: futureExpense.occurrence_key }
    });
    const original = await service.createBudgetSafetySnapshotAsync(harness.userId);
    assert.ok(original.payload.tables.pending_transactions.some(row => row.source_recurring_expense_id === expense.id));
    assert.ok(original.payload.tables.future_transactions.some(row => row.source_recurring_expense_id === expense.id));
    const assertIntegrity = () => {
      const db = dbService.openPlanningDb(harness.userId);
      try {
        assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
        assert.equal(db.pragma("defer_foreign_keys", { simple: true }), 0);
        assert.deepEqual(db.pragma("foreign_key_check"), []);
      } finally { db.close(); }
    };
    await work({ harness, budgetStore, service, original, expense, assertIntegrity });
  } finally { await harness.cleanup(); }
}

for (const operation of ["snapshot", "prepared-import"]) {
  test(`SQLite ${operation} replaces a populated budget without breaking pending/future foreign keys`, async () => withPopulatedBudget(async ({
    harness, service, original, expense, assertIntegrity
  }) => {
    let apply;
    if (operation === "snapshot") {
      const target = structuredClone(original);
      target.payload.tables.settings[0].future_periods = 3;
      target.payload.tables.recurring_expenses.find(row => row.id === expense.id).name = "Restored rent";
      apply = () => service.restoreBudgetSafetySnapshotAsync(target);
    } else {
      const exported = await harness.api("/api/export/full");
      const plan = await service.prepareFullImportPlanAsync(harness.userId, exported, "replace");
      // Mutate this already validated plan only to distinguish replacement from
      // an accidental no-op; the references themselves are actual exported data.
      plan.importPlan.writeBatches.find(batch => batch.tableName === "settings").rows[0].future_periods = 3;
      plan.importPlan.writeBatches.find(batch => batch.tableName === "recurring_expenses").rows[0].name = "Restored rent";
      apply = () => service.applyPreparedFullImportPlanAsync(plan);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await apply();
      assert.equal(result.ok, true);
      const restored = await service.createBudgetSafetySnapshotAsync(harness.userId);
      assert.equal(restored.payload.tables.settings[0].future_periods, 3);
      assert.equal(restored.payload.tables.recurring_expenses.find(row => row.id === expense.id).name, "Restored rent");
      assert.deepEqual(restored.payload.tables.pending_transactions, original.payload.tables.pending_transactions);
      assert.deepEqual(restored.payload.tables.future_transactions,
        operation === "snapshot" ? original.payload.tables.future_transactions : []);
      assertIntegrity();
    }
  }));

  test(`SQLite ${operation} rolls back all planning tables on a late insert failure`, async () => withPopulatedBudget(async ({
    harness, service, original, assertIntegrity
  }) => {
    let apply;
    if (operation === "snapshot") {
      const target = structuredClone(original);
      target.payload.tables.settings[0].future_periods = 3;
      target.payload.tables.pending_transactions[0].currency = null;
      apply = () => service.restoreBudgetSafetySnapshotAsync(target);
    } else {
      const plan = await service.prepareFullImportPlanAsync(harness.userId, await harness.api("/api/export/full"), "replace");
      plan.importPlan.writeBatches.find(batch => batch.tableName === "settings").rows[0].future_periods = 3;
      plan.importPlan.writeBatches.find(batch => batch.tableName === "pending_transactions").rows[0].currency = null;
      apply = () => service.applyPreparedFullImportPlanAsync(plan);
    }
    // A real NOT NULL failure after earlier table inserts, not a mocked writer.
    await assert.rejects(apply, /NOT NULL constraint failed: pending_transactions.currency/);
    const after = await service.createBudgetSafetySnapshotAsync(harness.userId);
    assert.deepEqual(after.payload.tables, original.payload.tables);
    assertIntegrity();
  }));
}

for (const operation of ["snapshot", "prepared-import"]) {
  test(`SQLite ${operation} rejects a failed async planning hook before any planning write`, async () => withPopulatedBudget(async ({
    harness, service, original, assertIntegrity
  }) => {
    const onBatch = async batch => {
      await Promise.resolve();
      if (batch.tableName === "pending_transactions") throw new Error("injected planning hook failure");
    };
    if (operation === "snapshot") {
      const target = structuredClone(original);
      target.payload.tables.settings[0].future_periods = 3;
      await assert.rejects(() => service.restoreBudgetSafetySnapshotAsync(target, { onBatch }), /injected planning hook failure/);
    } else {
      const plan = await service.prepareFullImportPlanAsync(harness.userId, await harness.api("/api/export/full"), "replace");
      plan.importPlan.writeBatches.find(batch => batch.tableName === "settings").rows[0].future_periods = 3;
      await assert.rejects(() => service.applyPreparedFullImportPlanAsync(plan, { onBatch }), /injected planning hook failure/);
    }
    assert.deepEqual((await service.createBudgetSafetySnapshotAsync(harness.userId)).payload.tables, original.payload.tables);
    assertIntegrity();
  }));
}

test("SQLite snapshot replacement rejects dangling references at commit and preserves the old budget", async () => withPopulatedBudget(async ({
  harness, service, original, assertIntegrity
}) => {
  const target = structuredClone(original);
  target.payload.tables.settings[0].future_periods = 3;
  target.payload.tables.pending_transactions[0].source_recurring_expense_id = "missing-expense";
  await assert.rejects(() => service.restoreBudgetSafetySnapshotAsync(target), /FOREIGN KEY constraint failed/);
  assert.deepEqual((await service.createBudgetSafetySnapshotAsync(harness.userId)).payload.tables, original.payload.tables);
  assertIntegrity();
}));


test("current full exports round-trip null and linked recurring income anchors through HTTP", async () => withPopulatedBudget(async ({ harness, expense }) => {
  const income = await harness.api("/api/recurring-incomes", {
    method: "POST", body: {
      name: "Anchor salary", currency: "PLN", amount: 1000, active: 1,
      anchor_type: "day_of_month", anchor_day_of_month: 20,
      anchor_business_day_adjustment: "none", repeat_every_months: 1
    }
  });
  for (const anchorIncomeId of [null, income.id]) {
    await harness.api(`/api/recurring-expenses/${encodeURIComponent(expense.id)}`, {
      method: "PUT", body: { anchor_income_id: anchorIncomeId }
    });
    const exported = await harness.api("/api/export/full");
    const preview = await harness.request("/api/import/full/preview", {
      method: "POST", body: { mode: "replace", export: exported }
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
    const result = await harness.request("/api/import/full", {
      method: "POST", body: { mode: "replace", export: exported }
    });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    const after = await harness.api("/api/export/full");
    assert.equal(after.planning.recurring_expenses.find(row => row.id === expense.id).anchor_income_id, anchorIncomeId);
  }
  for (const [anchor, reason] of [["missing-income", "source_not_found"], [{ invalid: true }, "invalid_id"]]) {
    const exported = await harness.api("/api/export/full");
    exported.planning.recurring_expenses[0].anchor_income_id = anchor;
    // Unsigned legacy/sample payloads are currently supported; isolate row validation.
    delete exported.checksum;
    const rejected = await harness.request("/api/import/full", {
      method: "POST", body: { mode: "replace", export: exported }
    });
    assert.equal(rejected.response.status, 400);
    assert.ok(rejected.body.details.some(detail => detail.field === "anchor_income_id" && detail.reason === reason));
  }
}));


test("SQLite prepared-import recovery restores its real snapshot after planning committed but ledger apply failed", async () => withPopulatedBudget(async ({
  harness, service, original, assertIntegrity
}) => {
  const plan = await service.prepareFullImportPlanAsync(harness.userId, await harness.api("/api/export/full"), "replace");
  plan.importPlan.writeBatches.find(batch => batch.tableName === "settings").rows[0].future_periods = 3;
  let reachedLedger = false;
  await assert.rejects(() => service.applyPreparedFullImportPlanWithRollbackAsync(harness.userId, plan, {
    onBatch: async batch => {
      if (batch.type !== "ledger") return;
      reachedLedger = true;
      const partial = await service.createBudgetSafetySnapshotAsync(harness.userId);
      assert.equal(partial.payload.tables.settings[0].future_periods, 3);
      throw new Error("injected ledger batch failure");
    }
  }), error => {
    assert.equal(error.rollback?.phase, "rolled_back");
    assert.equal(error.rollback.originalError, "injected ledger batch failure");
    return true;
  });
  assert.equal(reachedLedger, true);
  assert.deepEqual((await service.createBudgetSafetySnapshotAsync(harness.userId)).payload.tables, original.payload.tables);
  assertIntegrity();
}));
