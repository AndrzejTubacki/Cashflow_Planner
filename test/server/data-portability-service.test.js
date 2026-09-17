import assert from "node:assert/strict";
import test from "node:test";

import {
  createCashflowDataPortabilityService
} from "../../src/server/cashflow-data-portability-service.js";
import {
  createBudgetStoreImportPlanFromFullExport,
  createBudgetStorePayloadFromFullExport
} from "../../src/server/cashflow-budget-store-import-plan.js";

test("full export can read planning and ledger rows through the budget-store facade", async () => {
  const calls = [];
  const service = createCashflowDataPortabilityService({
    budgetStore: {
      async listConfirmedTransactions(budgetId, { ledgerYear }) {
        calls.push({ budgetId, ledgerYear, tableName: "confirmed_transactions" });
        return [{
          budget_id: budgetId,
          id: "confirmed-1",
          ledger_year: ledgerYear,
          name: "Confirmed row"
        }];
      },
      async listLedgerYears(budgetId) {
        calls.push({ budgetId, tableName: "ledger_years" });
        return [2026];
      },
      async listPlanningRows(budgetId, tableName) {
        calls.push({ budgetId, tableName });
        if (tableName === "settings") {
          return [{
            backup_location: "/private/backups",
            budget_id: budgetId,
            id: 1,
            ledger_currency: "PLN",
            ntfy_url: "https://ntfy.example.test/topic"
          }];
        }
        return [{
          budget_id: budgetId,
          id: `${tableName}-row`
        }];
      }
    },
    createBackup: () => {
      throw new Error("not needed");
    },
    generateId: prefix => `${prefix}_id`,
    listLedgerYears: () => {
      throw new Error("direct ledger-year listing should not be used");
    },
    loadAllConfirmedTransactions: () => [],
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async export");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async export");
    },
    recalculateLedgerRunningBalance: () => {},
    regenerateProjectionsAfterMutation: () => {},
    restoreBackupFromPath: () => {}
  });

  const exported = await service.exportFullDataAsync("household", "1.0.0");

  assert.equal(exported.format, "cashflow-full-export");
  assert.equal(exported.appVersion, "1.0.0");
  assert.equal(exported.userId, "household");
  assert.equal(exported.planning.settings[0].budget_id, undefined);
  assert.equal(exported.planning.settings[0].backup_location, undefined);
  assert.equal(exported.planning.settings[0].ntfy_url, undefined);
  assert.equal(exported.planning.pending_transactions[0].budget_id, undefined);
  assert.deepEqual(exported.ledgers["2026"], [{
    id: "confirmed-1",
    name: "Confirmed row"
  }]);
  assert.equal(calls.some(call => call.tableName === "settings"), true);
  assert.equal(calls.some(call => call.tableName === "confirmed_transactions"), true);
});

test("full export can be adapted into a budget-store import plan", async () => {
  const service = createCashflowDataPortabilityService({
    budgetStore: {
      async listConfirmedTransactions(budgetId, { ledgerYear }) {
        return [{
          id: "confirmed-1",
          ledger_year: ledgerYear,
          name: "Confirmed row",
          type: "income",
          date: "2026-01-05",
          confirmed_date: "2026-01-05",
          currency: "PLN",
          amount: 125,
          ledger_currency: "PLN",
          ledger_amount: 125,
          running_balance_pln: 125
        }];
      },
      async listLedgerYears() {
        return [2026];
      },
      async listPlanningRows(budgetId, tableName) {
        if (tableName === "settings") {
          return [{
            backup_location: "/private/backups",
            budget_id: budgetId,
            id: 1,
            ledger_currency: "PLN",
            locale: "en",
            ntfy_url: "https://ntfy.example.test/topic",
            timezone: "Europe/Warsaw"
          }];
        }
        if (tableName === "one_off_transactions") {
          return [{
            budget_id: budgetId,
            id: "oneoff-1",
            name: "One-off",
            type: "expense",
            date: "2026-02-01",
            currency: "PLN",
            amount: 20
          }];
        }
        return [];
      }
    },
    listLedgerYears: () => [],
    loadAllConfirmedTransactions: () => [],
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async export");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async export");
    }
  });

  const exported = await service.exportFullDataAsync("source-budget", "1.0.0");
  const payload = createBudgetStorePayloadFromFullExport({
    budgetId: "target-budget",
    exportData: exported
  });
  const plan = createBudgetStoreImportPlanFromFullExport({
    budgetId: "target-budget",
    exportData: exported
  });
  const mergePlan = createBudgetStoreImportPlanFromFullExport({
    budgetId: "target-budget",
    exportData: exported,
    includeSettings: false
  });

  assert.equal(payload.tables.settings[0].budget_id, "target-budget");
  assert.equal(payload.tables.settings[0].backup_location, undefined);
  assert.equal(payload.tables.settings[0].ntfy_url, undefined);
  assert.equal(payload.tables.one_off_transactions[0].budget_id, "target-budget");
  assert.equal(payload.tables.confirmed_transactions[0].budget_id, "target-budget");
  assert.equal(payload.tables.confirmed_transactions[0].ledger_year, 2026);
  assert.equal(plan.budgetCount, 1);
  assert.deepEqual(plan.budgetIds, ["target-budget"]);
  assert.deepEqual(plan.writeBatches.map(batch => ({
    ledgerYear: batch.ledgerYear || null,
    rows: batch.rows.length,
    tableName: batch.tableName,
    type: batch.type
  })), [
    { ledgerYear: null, rows: 1, tableName: "settings", type: "planning" },
    { ledgerYear: null, rows: 1, tableName: "one_off_transactions", type: "planning" },
    { ledgerYear: 2026, rows: 1, tableName: "confirmed_transactions", type: "ledger" }
  ]);
  assert.equal(mergePlan.writeBatches.some(batch => batch.tableName === "settings"), false);
});

test("confirmed ledger CSV export can read rows through the budget-store facade", async () => {
  const calls = [];
  const service = createCashflowDataPortabilityService({
    budgetStore: {
      async listConfirmedTransactions(budgetId, { ledgerYear }) {
        calls.push({ budgetId, ledgerYear, tableName: "confirmed_transactions" });
        return [{
          amount: 125.5,
          budget_id: budgetId,
          currency: "PLN",
          date: "2026-01-05",
          id: "confirmed-1",
          ledger_currency: "PLN",
          ledger_year: ledgerYear,
          name: "Confirmed row",
          running_balance_pln: 125.5,
          type: "income"
        }];
      },
      async listLedgerYears(budgetId) {
        calls.push({ budgetId, tableName: "ledger_years" });
        return [2026];
      }
    },
    listLedgerYears: () => {
      throw new Error("direct ledger-year listing should not be used");
    },
    loadAllConfirmedTransactions: () => {
      throw new Error("SQLite confirmed-ledger aggregate should not be used");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async CSV export");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async CSV export");
    }
  });

  const csv = await service.exportConfirmedLedgerCsvAsync("household");

  assert.match(csv, /^ledger_year,id,name,type,date,/);
  assert.match(csv, /"2026","confirmed-1","Confirmed row","income","2026-01-05"/);
  assert.match(csv, /"125.5"/);
  assert.equal(calls.some(call => call.tableName === "confirmed_transactions"), true);
});

test("full import preflight can produce replace and merge budget-store plans", async () => {
  const service = createCashflowDataPortabilityService({
    budgetStore: {
      async listConfirmedTransactions() {
        return [];
      },
      async listPlanningRows(budgetId, tableName) {
        if (tableName === "settings") {
          return [{
            backup_location: "/keep/operator/backups",
            budget_id: budgetId,
            id: 1,
            updated_at: "2026-01-01T00:00:00.000Z"
          }];
        }
        return [];
      }
    },
    createBackup: () => {
      throw new Error("preflight must not create backups");
    },
    generateId: prefix => `${prefix}-id`,
    listLedgerYears: () => [],
    loadAllConfirmedTransactions: () => {
      throw new Error("SQLite confirmed rows should not be loaded for async import preflight");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async import preflight");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async import preflight");
    },
    recalculateLedgerRunningBalance: () => {
      throw new Error("preflight must not recalculate ledgers");
    },
    regenerateProjectionsAfterMutation: () => {
      throw new Error("preflight must not regenerate projections");
    },
    restoreBackupFromPath: () => {
      throw new Error("preflight must not restore backups");
    }
  });
  const payload = service.exportSampleData();

  const replace = await service.prepareFullImportPlanAsync("target-budget", payload, "replace");
  const merge = await service.prepareFullImportPlanAsync("target-budget", payload, "merge");

  assert.equal(replace.ok, true);
  assert.equal(replace.mode, "replace");
  assert.equal(replace.importPlan.budgetIds[0], "target-budget");
  assert.equal(replace.importPlan.writeBatches.some(batch => batch.tableName === "settings"), true);
  assert.equal(replace.importPlan.writeBatches.some(batch =>
    batch.tableName === "future_transactions" && batch.type === "planning" && batch.rows.length === 0
  ), true);
  assert.equal(
    replace.importPlan.budgetPlans[0].planningTables.settings[0].backup_location,
    "/keep/operator/backups"
  );

  assert.equal(merge.ok, true);
  assert.equal(merge.mode, "merge");
  assert.equal(merge.importPlan.writeBatches.some(batch => batch.tableName === "settings"), false);
  assert.equal(merge.importPlan.writeBatches.some(batch => batch.rows.length === 0), false);
  assert.equal(merge.importPlan.writeBatches.some(batch => batch.tableName === "one_off_transactions"), true);
});

test("CSV one-off import preflight plans append and replace through budget-store reads", async () => {
  let nextId = 1;
  const service = createCashflowDataPortabilityService({
    budgetStore: {
      async listConfirmedTransactions() {
        return [{ source_one_off_id: "keep-confirmed" }];
      },
      async listPlanningRows(budgetId, tableName) {
        assert.equal(tableName, "one_off_transactions");
        return [
          { id: "delete-unconfirmed" },
          { id: "keep-confirmed" }
        ];
      }
    },
    generateId: prefix => `${prefix}-${nextId++}`,
    listLedgerYears: () => [],
    loadAllConfirmedTransactions: () => {
      throw new Error("SQLite confirmed rows should not be loaded for async CSV preflight");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async CSV preflight");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async CSV preflight");
    }
  });

  const csv = [
    "name,type,amount,currency,date",
    "Desk,expense,\"12,34\",PLN,2026-01-05"
  ].join("\n");

  const append = await service.prepareOneOffCsvImportPlanAsync("household", csv, "append");
  const replace = await service.prepareOneOffCsvImportPlanAsync("household", csv, "replace");

  assert.equal(append.mode, "append");
  assert.equal(append.imported, 1);
  assert.equal(append.rows[0].amount, 12.34);
  assert.deepEqual(append.deleteOneOffIds, []);

  assert.equal(replace.mode, "replace");
  assert.equal(replace.imported, 1);
  assert.deepEqual(replace.deleteOneOffIds, ["delete-unconfirmed"]);
  assert.deepEqual(replace.deletePendingSourceOneOffIds, ["delete-unconfirmed"]);
  assert.deepEqual(replace.deleteFutureSourceOneOffIds, ["delete-unconfirmed"]);
});

test("prepared CSV one-off import plans apply through backend-neutral store writers", async () => {
  let nextId = 1;
  const calls = [];
  const repo = {
    async deletePlanningRowsById(budgetId, tableName, ids) {
      calls.push(["delete", budgetId, tableName, ids]);
      return { deleted: ids.length };
    },
    async insertPlanningRows(budgetId, tableName, rows) {
      calls.push(["insert", budgetId, tableName, rows.map(row => row.id)]);
      return { inserted: rows.length };
    },
    async listPlanningRows(budgetId, tableName) {
      calls.push(["list", budgetId, tableName]);
      if (tableName === "pending_transactions") {
        return [
          { id: "pending-delete", source_one_off_id: "delete-unconfirmed" },
          { id: "pending-keep", source_one_off_id: "keep-confirmed" }
        ];
      }
      if (tableName === "future_transactions") {
        return [
          { id: "future-delete", source_one_off_id: "delete-unconfirmed" }
        ];
      }
      return [];
    }
  };
  const service = createCashflowDataPortabilityService({
    budgetStore: {
      async listConfirmedTransactions() {
        return [{ source_one_off_id: "keep-confirmed" }];
      },
      async listPlanningRows(budgetId, tableName) {
        if (tableName === "one_off_transactions") {
          return [
            { id: "delete-unconfirmed" },
            { id: "keep-confirmed" }
          ];
        }
        return [];
      },
      async transaction(fn) {
        calls.push(["begin"]);
        const result = await fn(repo);
        calls.push(["commit"]);
        return result;
      }
    },
    generateId: prefix => `${prefix}-${nextId++}`,
    listLedgerYears: () => [],
    loadAllConfirmedTransactions: () => [],
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async CSV apply");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async CSV apply");
    }
  });
  const csv = [
    "name,type,amount,currency,date",
    "Desk,expense,12.34,PLN,2026-01-05"
  ].join("\n");

  const plan = await service.prepareOneOffCsvImportPlanAsync("household", csv, "replace");
  const result = await service.applyPreparedOneOffCsvImportPlanAsync("household", plan);

  assert.deepEqual(result, {
    deletedFutureRows: 1,
    deletedOneOffs: 1,
    deletedPendingRows: 1,
    inserted: 1,
    mode: "replace",
    ok: true
  });
  assert.deepEqual(calls, [
    ["begin"],
    ["list", "household", "pending_transactions"],
    ["list", "household", "future_transactions"],
    ["delete", "household", "pending_transactions", ["pending-delete"]],
    ["delete", "household", "future_transactions", ["future-delete"]],
    ["delete", "household", "one_off_transactions", ["delete-unconfirmed"]],
    ["insert", "household", "one_off_transactions", ["oneoff-1"]],
    ["commit"]
  ]);
});

test("prepared full import plans apply through backend-neutral store writers", async () => {
  const calls = [];
  const batchSummaries = [];
  const repo = {
    async insertConfirmedTransactions(budgetId, rows) {
      calls.push(["repo-insert-ledger", budgetId, rows.length]);
      return { inserted: rows.length };
    },
    async insertPlanningRows(budgetId, tableName, rows) {
      calls.push(["repo-insert-planning", budgetId, tableName, rows.length]);
      return { inserted: rows.length };
    },
    async replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows) {
      calls.push(["repo-replace-ledger", budgetId, ledgerYear, rows.length]);
      return { inserted: rows.length, ledgerYear, replaced: true };
    },
    async replacePlanningRows(budgetId, tableName, rows) {
      calls.push(["repo-replace-planning", budgetId, tableName, rows.length]);
      return { inserted: rows.length, replaced: true };
    }
  };
  const budgetStore = {
    async insertConfirmedTransactions() {
      throw new Error("outer ledger insert should not be used inside transaction");
    },
    async insertPlanningRows() {
      throw new Error("outer planning insert should not be used inside transaction");
    },
    async listConfirmedTransactions() {
      return [];
    },
    async listPlanningRows(budgetId, tableName) {
      if (tableName === "settings") {
        return [{
          budget_id: budgetId,
          id: 1,
          updated_at: "2026-01-01T00:00:00.000Z"
        }];
      }
      return [];
    },
    async replaceConfirmedTransactionsForYear() {
      throw new Error("outer ledger replace should not be used inside transaction");
    },
    async replacePlanningRows() {
      throw new Error("outer planning replace should not be used inside transaction");
    },
    async transaction(fn) {
      calls.push(["begin"]);
      const result = await fn(repo);
      calls.push(["commit"]);
      return result;
    }
  };
  const service = createCashflowDataPortabilityService({
    budgetStore,
    generateId: prefix => `${prefix}-id`,
    listLedgerYears: () => [],
    loadAllConfirmedTransactions: () => [],
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async prepared import apply");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async prepared import apply");
    }
  });
  const payload = service.exportSampleData();

  const replace = await service.prepareFullImportPlanAsync("target-budget", payload, "replace");
  const replaceResult = await service.applyPreparedFullImportPlanAsync(replace, {
    onBatch: summary => batchSummaries.push(["replace", summary.tableName, summary.rows])
  });

  const merge = await service.prepareFullImportPlanAsync("target-budget", payload, "merge");
  const mergeResult = await service.applyPreparedFullImportPlanAsync(merge, {
    onBatch: summary => batchSummaries.push(["merge", summary.tableName, summary.rows])
  });

  assert.equal(replaceResult.mode, "replace");
  assert.equal(mergeResult.mode, "append");
  assert.equal(calls.filter(call => call[0] === "begin").length, 2);
  assert.equal(calls.filter(call => call[0] === "commit").length, 2);
  assert.equal(calls.some(call =>
    call[0] === "repo-replace-planning" && call[2] === "future_transactions" && call[3] === 0
  ), true);
  assert.equal(calls.some(call => call[0] === "repo-insert-planning" && call[2] === "settings"), false);
  assert.equal(calls.some(call => call[0] === "repo-insert-planning" && call[2] === "one_off_transactions"), true);
  assert.equal(batchSummaries.some(summary =>
    summary[0] === "replace" && summary[1] === "future_transactions" && summary[2] === 0
  ), true);
});

test("data portability can create and restore budget-store safety snapshots", async () => {
  const calls = [];
  const service = createCashflowDataPortabilityService({
    budgetStore: {
      async listConfirmedTransactions(budgetId) {
        calls.push(["list-ledger", budgetId]);
        return [{
          amount: 100,
          budget_id: budgetId,
          confirmed_date: "2026-01-01",
          created_at: "2026-01-01T00:00:00.000Z",
          currency: "PLN",
          date: "2026-01-01",
          id: "confirmed-1",
          ledger_amount: 100,
          ledger_currency: "PLN",
          ledger_year: 2026,
          name: "Confirmed",
          running_balance_pln: 100,
          type: "income",
          updated_at: "2026-01-01T00:00:00.000Z"
        }];
      },
      async listLedgerYears() {
        return [2026];
      },
      async listPlanningRows(budgetId, tableName) {
        calls.push(["list-planning", budgetId, tableName]);
        if (tableName === "settings") {
          return [{
            budget_id: budgetId,
            id: 1,
            ledger_currency: "PLN",
            locale: "en",
            timezone: "UTC",
            updated_at: "2026-01-01T00:00:00.000Z"
          }];
        }
        return [];
      },
      async replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows) {
        calls.push(["replace-ledger", budgetId, ledgerYear, rows.length]);
        return { inserted: rows.length, ledgerYear, replaced: true };
      },
      async replacePlanningRows(budgetId, tableName, rows) {
        calls.push(["replace-planning", budgetId, tableName, rows.length]);
        return { inserted: rows.length, replaced: true };
      }
    },
    generateId: prefix => `${prefix}-id`,
    listLedgerYears: () => [],
    loadAllConfirmedTransactions: () => [],
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async safety snapshots");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async safety snapshots");
    }
  });

  const snapshot = await service.createBudgetSafetySnapshotAsync("household", "import_test");
  const restore = await service.restoreBudgetSafetySnapshotAsync(snapshot);

  assert.equal(snapshot.format, "cashflow-budget-store-snapshot");
  assert.deepEqual(snapshot.budgetIds, ["household"]);
  assert.equal(snapshot.reason, "import_test");
  assert.equal(restore.ok, true);
  assert.equal(restore.writeBatchCount >= 1, true);
  assert.equal(calls.some(call => call[0] === "replace-planning" && call[2] === "settings"), true);
  assert.equal(calls.some(call => call[0] === "replace-ledger" && call[2] === 2026), true);
});

test("prepared full import rollback restores a budget-store safety snapshot", async () => {
  const calls = [];
  let transactionCount = 0;
  const budgetStore = {
    async listConfirmedTransactions() {
      return [];
    },
    async listLedgerYears() {
      return [];
    },
    async listPlanningRows(budgetId, tableName) {
      calls.push(["list", budgetId, tableName]);
      if (tableName === "settings") {
        return [{
          budget_id: budgetId,
          id: 1,
          ledger_currency: "PLN",
          locale: "en",
          timezone: "UTC",
          updated_at: "2026-01-01T00:00:00.000Z"
        }];
      }
      return [];
    },
    async insertConfirmedTransactions() {
      throw new Error("outer insert ledger should not be used");
    },
    async insertPlanningRows() {
      throw new Error("outer insert planning should not be used");
    },
    async replaceConfirmedTransactionsForYear() {
      throw new Error("outer replace ledger should not be used");
    },
    async replacePlanningRows() {
      throw new Error("outer replace planning should not be used");
    },
    async transaction(fn) {
      transactionCount += 1;
      calls.push(["begin", transactionCount]);
      const applyRepo = {
        async insertConfirmedTransactions() {
          return { inserted: 0 };
        },
        async insertPlanningRows() {
          return { inserted: 0 };
        },
        async replaceConfirmedTransactionsForYear() {
          return { inserted: 0, replaced: true };
        },
        async replacePlanningRows(budgetId, tableName, rows) {
          calls.push(["apply-replace", tableName, rows.length]);
          if (tableName === "one_off_transactions") {
            throw new Error("planned apply failure");
          }
          return { inserted: rows.length, replaced: true };
        }
      };
      const restoreRepo = {
        async listLedgerYears() {
          return [];
        },
        async replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows) {
          calls.push(["restore-ledger", ledgerYear, rows.length]);
          return { inserted: rows.length, replaced: true };
        },
        async replacePlanningRows(budgetId, tableName, rows) {
          calls.push(["restore-planning", tableName, rows.length]);
          return { inserted: rows.length, replaced: true };
        }
      };
      try {
        const result = await fn(transactionCount === 1 ? applyRepo : restoreRepo);
        calls.push(["commit", transactionCount]);
        return result;
      } catch (error) {
        calls.push(["rollback", transactionCount]);
        throw error;
      }
    }
  };
  const logs = [];
  const service = createCashflowDataPortabilityService({
    budgetStore,
    generateId: prefix => `${prefix}-id`,
    listLedgerYears: () => [],
    loadAllConfirmedTransactions: () => [],
    logError: (kind, details) => logs.push(["error", kind, details]),
    logServerEvent: (kind, details) => logs.push(["event", kind, details]),
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async rollback import");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async rollback import");
    }
  });

  const preflight = await service.prepareFullImportPlanAsync(
    "household",
    service.exportSampleData(),
    "replace"
  );

  await assert.rejects(
    () => service.applyPreparedFullImportPlanWithRollbackAsync("household", preflight),
    error => {
      assert.match(error.message, /rolled back/);
      assert.equal(error.rollback.phase, "rolled_back");
      assert.equal(error.rollback.safetySnapshot.format, "cashflow-budget-store-snapshot");
      assert.deepEqual(error.rollback.safetySnapshot.budgetIds, ["household"]);
      assert.doesNotMatch(JSON.stringify(error), /Sample rent|Sample salary/);
      return true;
    }
  );

  assert.equal(calls.some(call => call[0] === "restore-planning" && call[1] === "settings"), true);
  assert.equal(logs.some(call => call[1] === "cashflow_async_import_failed_before_rollback"), true);
  assert.equal(logs.some(call => call[1] === "cashflow_async_import_rolled_back"), true);
});

test("merge conflict detection can read existing rows through the budget-store facade", async () => {
  const calls = [];
  const service = createCashflowDataPortabilityService({
    budgetStore: {
      async listConfirmedTransactions(budgetId) {
        calls.push({ budgetId, tableName: "confirmed_transactions" });
        return [{
          id: "confirmed-existing",
          occurrence_key: "shared-key"
        }];
      },
      async listPlanningRows(budgetId, tableName) {
        calls.push({ budgetId, tableName });
        if (tableName === "fx_rates_cache") {
          return [{
            base_currency: "EUR",
            quote_currency: "PLN",
            rate_date: "2026-01-01"
          }];
        }
        if (tableName === "one_off_transactions") {
          return [{ id: "oneoff-existing" }];
        }
        if (tableName === "pending_transactions") {
          return [{
            id: "pending-existing",
            occurrence_key: "pending-shared-key"
          }];
        }
        return [];
      }
    },
    listLedgerYears: () => [],
    loadAllConfirmedTransactions: () => {
      throw new Error("SQLite confirmed rows should not be loaded for async conflict checks");
    },
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async conflict checks");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async conflict checks");
    }
  });

  const conflicts = await service.collectMergeConflictsAsync("household", {
    planning: {
      fx_rates_cache: [{
        base_currency: "EUR",
        quote_currency: "PLN",
        rate_date: "2026-01-01"
      }],
      flex_transactions: [],
      goals: [],
      ledger_currency_events: [],
      one_off_transactions: [{ id: "oneoff-existing" }],
      pending_transactions: [{
        id: "confirmed-existing",
        occurrence_key: "pending-shared-key"
      }],
      planned_transactions: [],
      recurring_expenses: [],
      recurring_incomes: []
    },
    ledgers: {
      "2026": [{
        id: "pending-existing",
        occurrence_key: "shared-key"
      }]
    }
  });

  assert.deepEqual(conflicts, [
    { table: "fx_rates_cache", id: "EUR/PLN/2026-01-01", reason: "already_exists" },
    { table: "one_off_transactions", id: "oneoff-existing", reason: "already_exists" },
    { table: "occurrence_keys", id: "pending-shared-key", reason: "already_exists" },
    { table: "occurrence_keys", id: "shared-key", reason: "already_exists" },
    { table: "ledger_2026.confirmed_transactions", id: "pending-existing", reason: "already_exists" },
    { table: "pending_transactions", id: "confirmed-existing", reason: "already_exists" }
  ]);
  assert.equal(calls.some(call => call.tableName === "pending_transactions"), true);
  assert.equal(calls.some(call => call.tableName === "confirmed_transactions"), true);
});

function successfulReplaceBudgetStore(calls) {
  return {
    async listConfirmedTransactions() {
      return [];
    },
    async listLedgerYears() {
      return [];
    },
    async listPlanningRows(budgetId, tableName) {
      calls.push(["list", budgetId, tableName]);
      if (tableName === "settings") {
        return [{
          budget_id: budgetId,
          id: 1,
          ledger_currency: "PLN",
          locale: "en",
          timezone: "UTC",
          updated_at: "2026-01-01T00:00:00.000Z"
        }];
      }
      return [];
    },
    async insertConfirmedTransactions() {
      throw new Error("outer insert ledger should not be used");
    },
    async insertPlanningRows() {
      throw new Error("outer insert planning should not be used");
    },
    async replaceConfirmedTransactionsForYear() {
      throw new Error("outer replace ledger should not be used");
    },
    async replacePlanningRows() {
      throw new Error("outer replace planning should not be used");
    },
    async transaction(fn) {
      calls.push(["begin"]);
      const repo = {
        async listLedgerYears() {
          return [];
        },
        async insertConfirmedTransactions() {
          return { inserted: 0 };
        },
        async insertPlanningRows() {
          return { inserted: 0 };
        },
        async replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows) {
          calls.push(["replace-ledger", ledgerYear, rows.length]);
          return { inserted: rows.length, replaced: true };
        },
        async replacePlanningRows(budgetId, tableName, rows) {
          calls.push(["replace-planning", tableName, rows.length]);
          return { inserted: rows.length, replaced: true };
        }
      };
      const result = await fn(repo);
      calls.push(["commit"]);
      return result;
    }
  };
}

test("importOneOffCsvAsync applies an append import and regenerates projections through a Postgres budget store", async () => {
  const calls = [];
  let projectionRegenerated = 0;
  const repo = {
    async insertPlanningRows(budgetId, tableName, rows) {
      calls.push(["insert", budgetId, tableName, rows.map(row => row.id)]);
      return { inserted: rows.length };
    }
  };

  const service = createCashflowDataPortabilityService({
    budgetStore: {
      backend: "postgres",
      async transaction(fn) {
        calls.push(["begin"]);
        const result = await fn(repo);
        calls.push(["commit"]);
        return result;
      }
    },
    generateId: prefix => `${prefix}-1`,
    listLedgerYears: () => [],
    loadAllConfirmedTransactions: () => [],
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async CSV import");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async CSV import");
    },
    regenerateProjectionsAfterMutationAsync: async userId => {
      assert.equal(userId, "household");
      projectionRegenerated += 1;
      return { projection_ok: true, projection_error: null };
    }
  });

  const csv = [
    "name,type,amount,currency,date",
    "Desk,expense,12.34,PLN,2026-01-05"
  ].join("\n");

  const result = await service.importOneOffCsvAsync("household", csv, "append");

  assert.equal(result.ok, true);
  assert.equal(result.mode, "append");
  assert.equal(result.imported, 1);
  assert.equal(result._projection.projection_ok, true);
  assert.equal(projectionRegenerated, 1);
  assert.deepEqual(calls, [
    ["begin"],
    ["insert", "household", "one_off_transactions", ["oneoff-1"]],
    ["commit"]
  ]);
});

test("importFullDataAsync applies a replace import, recalculates balances, and regenerates projections through a Postgres budget store", async () => {
  const calls = [];
  let balanceRecalculated = 0;
  let projectionRegenerated = 0;
  const budgetStore = { backend: "postgres", ...successfulReplaceBudgetStore(calls) };

  const service = createCashflowDataPortabilityService({
    budgetStore,
    generateId: prefix => `${prefix}-id`,
    listLedgerYears: () => [],
    loadAllConfirmedTransactions: () => [],
    logError: () => {},
    logServerEvent: () => {},
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async full import");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async full import");
    },
    recalculateLedgerRunningBalanceAsync: async userId => {
      assert.equal(userId, "household");
      balanceRecalculated += 1;
    },
    regenerateProjectionsAfterMutationAsync: async userId => {
      assert.equal(userId, "household");
      projectionRegenerated += 1;
      return { projection_ok: true, projection_error: null };
    }
  });

  const result = await service.importFullDataAsync("household", service.exportSampleData(), "replace");

  assert.equal(result.ok, true);
  assert.equal(result.mode, "replace");
  assert.equal(result.safetyBackup.format, "cashflow-budget-store-snapshot");
  assert.equal(result._projection.projection_ok, true);
  assert.equal(balanceRecalculated, 1);
  assert.equal(projectionRegenerated, 1);
  // Two transactions: one for the pre-import safety snapshot capture, one to apply the import.
  assert.equal(calls.filter(call => call[0] === "begin").length, 1);
  assert.equal(calls.some(call => call[0] === "replace-planning" && call[1] === "settings"), true);
});

test("importFullDataAsync rolls back when projection regeneration fails after a successful apply", async () => {
  const calls = [];
  const budgetStore = { backend: "postgres", ...successfulReplaceBudgetStore(calls) };
  const logs = [];

  const service = createCashflowDataPortabilityService({
    budgetStore,
    generateId: prefix => `${prefix}-id`,
    listLedgerYears: () => [],
    loadAllConfirmedTransactions: () => [],
    logError: (kind, details) => logs.push(["error", kind, details]),
    logServerEvent: (kind, details) => logs.push(["event", kind, details]),
    openLedgerDb: () => {
      throw new Error("SQLite ledger DB should not be opened for async full import");
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async full import");
    },
    recalculateLedgerRunningBalanceAsync: async () => {},
    regenerateProjectionsAfterMutationAsync: async () => ({
      projection_ok: false,
      projection_error: "boom"
    })
  });

  await assert.rejects(
    () => service.importFullDataAsync("household", service.exportSampleData(), "replace"),
    error => {
      assert.match(error.message, /rolled back/);
      assert.match(error.message, /boom/);
      assert.equal(error.rollback.phase, "rolled_back");
      return true;
    }
  );

  assert.equal(logs.some(call => call[1] === "cashflow_async_import_rolled_back"), true);
});
