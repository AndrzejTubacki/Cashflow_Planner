import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { createSqliteBudgetStore, createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createPostgresGlobalSchemaSql } from "../../src/server/cashflow-postgres-global-schema.js";
import { FINANCIAL_JOURNAL_SCHEMA } from "../../src/server/cashflow-financial-journal.js";
import { createFinancialOperationService } from "../../src/server/cashflow-financial-operation-service.js";
import { createCashflowPlanMutationService } from "../../src/server/cashflow-plan-mutation-service.js";
import { createCashflowProjectionStateService } from "../../src/server/cashflow-projection-state-service.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";
import { createLedgerCorrectionService } from "../../src/server/cashflow-ledger-correction-service.js";
import { LEDGER_AUDIT_SCHEMA } from "../../src/server/cashflow-ledger-audit-store.js";

const budgetId = "planning-ops";
const helpers = createCashflowProjectionStateService({});

/** Exercise immutable originals after a real correction removes every effective
 * payment. The authorization/journal host must still reserve those source IDs. */
async function voidHistoricalPayments(store) {
  const transaction = store.backend === 'postgres' ? work => store.transaction(work)
    : work => store.planningTransaction(budgetId, work);
  return transaction(async (writer, connection) => {
    if (store.backend === 'postgres') await writer.lockBudgetLedger(budgetId);
    const query = async (sql, values = []) => {
      if (store.backend === 'postgres') {
        let index = 0;
        return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), values)).rows;
      }
      const statement = connection.prepare(sql);
      return statement.reader ? statement.all(...values) : (statement.run(...values), []);
    };
    // Test setup only; runtime schema registration has its own migration tests.
    if (store.backend === 'postgres') await connection.query(LEDGER_AUDIT_SCHEMA);
    else connection.exec(LEDGER_AUDIT_SCHEMA);
    const service = createLedgerCorrectionService({ budgetId, writer, query });
    await service.audit.ensureLegacyBaseline({ capturedAt: '2026-10-23T00:00:00.000Z' });
    const facts = await service.audit.originals();
    // Remove outflows first so each individually reviewed void stays affordable.
    for (const original of [...facts].sort((a,b) => (a.row.type === 'income') - (b.row.type === 'income'))) {
      const result = await service.correct({ id: randomUUID(), targetId: original.row.id, actorId: 'synthetic-reviewer',
        expectedCorrectionId: null, replacement: null, reason: 'Reviewed void', today: '2026-10-23',
        createdAt: '2026-10-23T00:00:00.000Z' });
      assert.equal(result.event.status, 'accepted');
    }
    return service.audit.exportSnapshot();
  });
}


/** Planning-source intents go through the server's own validated mutations on
 * the host transaction; one revision per accepted operation, nothing on failure. */
async function exercise({ store, epoch, head, sourceRows }) {
  const host = createFinancialOperationService({ budgetStore: store,
    authorize: async () => ({ instanceId: "unused", accountId: "unused", budgetId }),
    project: async () => {},
    planMutations: ({ store: hostStore }) => createCashflowPlanMutationService({ budgetStore: hostStore,
      requireStartMonthYearIfNeeded: helpers.requireStartMonthYearIfNeeded, normalizeRecurringInput: helpers.normalizeRecurringInput,
      withProjectionStatus: (_id, row) => row }) });
  let revision = 0;
  const op = (kind, payload) => ({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: revision, kind, payload });
  const accept = async operation => { const result = await host.apply(operation); revision = result.revision; return result; };
  const salary = randomUUID(), rent = randomUUID(), goal = randomUUID(), flex = randomUUID();
  await accept(op("recurring-income.create", { id: salary, name: "Salary", currency: "PLN", amount: 5000,
    anchor_type: "day_of_month", anchor_day_of_month: 10 }));
  const created = op("recurring-expense.create", { id: rent, name: "Rent", currency: "PLN", amount: 1500, necessary: true,
    anchor_income_id: salary, anchor_offset_days: 2, prediction_strategy: "12month_max" });
  await accept(created);
  assert.equal((await sourceRows("recurring_expenses")).find(row => row.id === rent).anchor_income_id, salary);
  // Replays return the original receipt without another revision or row.
  assert.equal((await host.apply(created)).replayed, true);
  assert.equal(await head(), 2);
  await assert.rejects(() => host.apply({ ...created, payload: { ...created.payload, amount: 1600 } }), /OPERATION_ID_REUSED/);
  await accept(op("recurring-expense.update", { id: rent, amount: 1600 }));
  assert.equal(Number((await sourceRows("recurring_expenses")).find(row => row.id === rent).amount), 1600);
  await accept(op("goal.create", { id: goal, name: "Holiday", currency: "PLN", amount: 3000, due_date: "2027-06-01" }));
  await accept(op("goal.update", { id: goal, amount: 3500 }));
  await accept(op("flex.create", { id: flex, name: "Leisure", currency: "PLN", amount: 400, allow_split: true, min_amount: 50, max_amount: null }));
  // History-checked deletes read the ledger inside the same transaction.
  await accept(op("flex.delete", { id: flex }));
  assert.equal((await sourceRows("flex_transactions")).some(row => row.id === flex), false);
  // Failures commit nothing and advance nothing.
  for (const [operation, pattern] of [
    [op("goal.create", { id: goal, name: "Duplicate", currency: "PLN", amount: 1, due_date: "2027-06-01" }), /SOURCE_EXISTS/],
    [op("goal.update", { id: randomUUID(), amount: 1 }), /SOURCE_NOT_FOUND/],
    [op("recurring-expense.create", { id: randomUUID(), name: "Bad anchor", currency: "PLN", amount: 1, anchor_income_id: "missing-income" }), /Anchor income not found/],
    [op("recurring-income.delete", { id: salary }), /anchors other recurring expenses/]
  ]) {
    const before = await head();
    await assert.rejects(() => host.apply(operation), pattern);
    assert.equal(await head(), before);
  }
  await assert.rejects(() => host.apply(op("goal.update", { id: goal, balance: 1 })), /Unsupported operation payload field/);
  await assert.rejects(() => host.apply(op("goal.update", { id: goal })), /at least one field/);
  // Deleting an anchor income needs the server's explicit fixed-day choice.
  await accept(op("recurring-income.delete", { id: salary, fallbackAnchorsToFixedDay: true }));
  const detached = (await sourceRows("recurring_expenses")).find(row => row.id === rent);
  assert.equal(detached.anchor_income_id, null);
  assert.equal(Number(detached.anchor_day_of_month) >= 1, true);
  const page = await host.changes({ budgetId, epoch, afterRevision: 0, limit: 100 });
  const kinds = ["recurring-income.create", "recurring-expense.create", "recurring-expense.update", "goal.create", "goal.update", "flex.create",
    "flex.delete", "recurring-income.delete"];
  assert.deepEqual(page.changes.map(change => change.kind), kinds);
  assert.equal(page.headRevision, kinds.length);

  // A deleted paid source remains a historical identity. Recreating any kind
  // with that ID would attach the old payments to a new, unrelated plan.
  const paidSource = randomUUID();
  await accept(op('one-off.create', { id: paidSource, name: 'Historical source', currency: 'PLN', amount: 10, type: 'income', date: '2026-06-01' }));
  await store.insertConfirmedTransactions(budgetId, [{ id: 'historical-payment', name: 'Accepted historical payment', currency: 'PLN',
    amount: 10, type: 'income', date: '2018-01-01', confirmed_date: '2018-01-01', ledger_year: 2018,
    fx_rate: 1, buffered_fx_rate: 1, ledger_amount: 10, ledger_currency: 'PLN', running_balance_pln: 10,
    source_one_off_id: paidSource, occurrence_key: `one_off:${paidSource}:income:2026-06-01`,
    created_at: '2018-01-01T00:00:00.000Z', updated_at: '2018-01-01T00:00:00.000Z' }]);
  await accept(op('one-off.delete', { id: paidSource }));
  const historicIds = [paidSource];
  for (const field of ['source_recurring_income_id', 'source_recurring_expense_id', 'source_goal_id', 'source_flex_id']) {
    const id = randomUUID(); historicIds.push(id);
    await store.insertConfirmedTransactions(budgetId, [{ id: `history-${field}`, name: 'Legacy accepted payment', currency: 'PLN',
      amount: 1, type: field === 'source_recurring_income_id' ? 'income' : 'expense', date: '2018-02-01', confirmed_date: '2018-02-01', ledger_year: 2018,
      fx_rate: 1, buffered_fx_rate: 1, ledger_amount: 1, ledger_currency: 'PLN', running_balance_pln: 1,
      [field]: id, occurrence_key: `legacy:${id}:2018-02-01`, created_at: '2018-02-01T00:00:00.000Z', updated_at: '2018-02-01T00:00:00.000Z' }]);
  }
  const retained = await store.listConfirmedTransactions(budgetId);
  const headBeforeReuse = await head();
  const newSources = [
    ['one-off.create', { name: 'Unrelated source', currency: 'PLN', amount: 10, type: 'income', date: '2026-06-01' }],
    ['recurring-income.create', { name: 'Unrelated income', currency: 'PLN', amount: 10, anchor_type: 'day_of_month', anchor_day_of_month: 1 }],
    ['recurring-expense.create', { name: 'Unrelated bill', currency: 'PLN', amount: 10 }],
    ['goal.create', { name: 'Unrelated goal', currency: 'PLN', amount: 10, due_date: '2027-01-01' }],
    ['flex.create', { name: 'Unrelated flex', currency: 'PLN', amount: 10 }]
  ];
  for (const id of historicIds) for (const [kind, payload] of newSources) {
    await assert.rejects(() => host.apply(op(kind, { id, ...payload })), /SOURCE_EXISTS/);
    assert.equal(await head(), headBeforeReuse);
    for (const table of ['one_off_transactions', 'recurring_incomes', 'recurring_expenses', 'goals', 'flex_transactions']) {
      assert.equal((await sourceRows(table)).some(row => row.id === id), false);
    }
    assert.deepEqual(await store.listConfirmedTransactions(budgetId), retained);
  }
  await assert.rejects(() => host.apply(op('one-off.create', { id: goal, ...newSources[0][1] })), /SOURCE_EXISTS/);
  assert.equal(await head(), headBeforeReuse);
  assert.equal(retained.find(row => row.id === 'historical-payment').source_one_off_id, paidSource);
  const audit = await voidHistoricalPayments(store);
  assert.equal((await store.listConfirmedTransactions(budgetId)).length, 0);
  for (const id of historicIds) for (const [kind, payload] of newSources) {
    await assert.rejects(() => host.apply(op(kind, { id, ...payload })), /SOURCE_EXISTS/);
    assert.equal(await head(), headBeforeReuse, 'Voided-payment identity rejection must not advance sync');
    for (const table of ['one_off_transactions', 'recurring_incomes', 'recurring_expenses', 'goals', 'flex_transactions']) {
      assert.equal((await sourceRows(table)).some(row => row.id === id), false);
    }
  }
  assert.equal(audit.originals.length, 5);
  assert.equal(audit.corrections.length, 5);

  await accept(op('one-off.create', { id: randomUUID(), name: 'Actually new source', currency: 'PLN', amount: 10,
    type: 'income', date: '2026-06-01' }));
  assert.deepEqual(await store.listConfirmedTransactions(budgetId), []);
}

test("planning-source operations apply server mutations atomically on SQLite", async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId, today: "2026-06-01" });
  const service = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
  const store = createSqliteBudgetStore(service);
  const epoch = randomUUID();
  const sql = (text, args = []) => { const db = service.openPlanningDb(budgetId); try { const statement = db.prepare(text); return statement.reader ? statement.all(...args) : statement.run(...args); } finally { db.close(); } };
  try {
    const db = service.openPlanningDb(budgetId); try { db.exec(FINANCIAL_JOURNAL_SCHEMA); } finally { db.close(); }
    sql("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 0)", [budgetId, epoch]);
    await exercise({ store, epoch, head: async () => sql("SELECT revision FROM cashflow_sync_heads")[0].revision,
      sourceRows: async table => sql(`SELECT * FROM ${table}`) });
  } finally { await harness.cleanup(); }
});

test("planning-source operations apply server mutations atomically on PostgreSQL", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
  const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
  const epoch = randomUUID();
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, "settings", [{ id: 1, updated_at: "2026-06-01T00:00:00Z" }]);
    await pool.query(FINANCIAL_JOURNAL_SCHEMA);
    await pool.query("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ($1, $2, 0)", [budgetId, epoch]);
    await exercise({ store, epoch, head: async () => Number((await pool.query("SELECT revision FROM cashflow_sync_heads")).rows[0].revision),
      sourceRows: table => store.listPlanningRows(budgetId, table) });
  } finally { await store.close(); }
}));

import { createCashflowPendingConfirmationService } from "../../src/server/cashflow-pending-confirmation-service.js";
import { createCashflowPendingTransitionService } from "../../src/server/cashflow-pending-transition-service.js";
import { createCashflowLedgerService } from "../../src/server/cashflow-ledger-service.js";

/** Server confirmation semantics on the host transaction (no projection stub
 * reaches the ledger). Each accepted confirmation is exactly one revision. */
function confirmationHost(store, { afterRecord = null, currencyOptions = {} } = {}) {
  return createFinancialOperationService({ budgetStore: store, afterRecord,
    authorize: async () => ({ instanceId: "unused", accountId: "unused", budgetId }), project: async () => {},
    ledgerActions: ({ store: hostStore }) => {
      const ledger = createCashflowLedgerService({ budgetStore: hostStore });
      const confirmation = createCashflowPendingConfirmationService({ budgetStore: hostStore,
        // Mirrors the real service's offline branches; a network lookup is never allowed here.
        getConfirmedFxForDate: async (currency, _date, settings, input) => {
          if (currency === (settings?.ledger_currency || "PLN")) return { fxRate: 1, bufferedFxRate: 1 };
          if (input.fx_rate) return { fxRate: input.fx_rate, bufferedFxRate: input.buffered_fx_rate || input.fx_rate };
          throw new Error("The sync host must not fetch rates inside the commit");
        },
        runRecoverableUserMutation: () => { throw new Error("Atomic confirmation must not restore snapshots"); },
        wouldLedgerGoNegativeAfterInsertAsync: ledger.wouldLedgerGoNegativeAfterInsertAsync,
        newestConfirmedTransactionDateAsync: async () => null, withProjectionStatus: (_id, row) => row });
      const transition = createCashflowPendingTransitionService({ budgetStore: hostStore,
        normalizePendingStatus: helpers.normalizePendingStatus, withProjectionStatus: (_id, row) => row });
      return { updateSettings: createCashflowSettingsService({ budgetStore: hostStore, ...currencyOptions,
          withProjectionStatus: (_id, row) => row }).updateSettings,
        confirmPendingTransaction: confirmation.confirmPendingTransaction,
        moveFutureTransactionToPending: transition.moveFutureTransactionToPending };
    } });
}
const stamp = "2026-06-01T00:00:00.000Z";
const occurrence = (id, extra = {}) => ({ id, name: id, amount: 100, funded_amount: 100, currency: "PLN", type: "income",
  date: "2026-06-01", occurrence_key: `key-${id}`, created_at: stamp, updated_at: stamp, ...extra });

async function exerciseConfirmations({ store, epoch, head }) {
  await store.insertPlanningRows(budgetId, "pending_transactions", [occurrence("salary"), occurrence("euro", { currency: "EUR", amount: 50, funded_amount: 50 })]);
  const { updated_at: _updated, ...future } = occurrence("bonus", { date: "2026-07-01" });
  await store.insertPlanningRows(budgetId, "future_transactions", [{ ...future, period: "2026-07", generation_timestamp: stamp }]);
  const host = confirmationHost(store);
  let revision = 0;
  const op = payload => ({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: revision, kind: "occurrence.confirm", payload });
  const accept = async operation => { const result = await host.apply(operation); revision = result.revision; return result; };
  const salary = op({ occurrenceKey: "key-salary", amount: 40, confirmedDate: "2026-06-01", fxRate: null });
  const receipt = await accept(salary);
  assert.equal(receipt.sourceId, null);
  assert.equal((await host.apply(salary)).replayed, true);
  let ledger = await store.listConfirmedTransactions(budgetId);
  assert.deepEqual(ledger.map(row => [row.occurrence_key, Number(row.amount)]), [["key-salary", 40]]);
  assert.equal((await store.listPlanningRows(budgetId, "pending_transactions")).some(row => row.occurrence_key === "key-salary"), false);
  // An upcoming occurrence is moved to pending and confirmed in the same commit.
  await accept(op({ occurrenceKey: "key-bonus", amount: 100, confirmedDate: "2026-06-01", fxRate: null }));
  assert.ok((await store.listConfirmedTransactions(budgetId)).some(row => row.occurrence_key === "key-bonus"));
  for (const [payload, pattern] of [[{ occurrenceKey: "key-euro", amount: 50, confirmedDate: "2026-06-01", fxRate: null }, /FX_RATE_REQUIRED/],
    [{ occurrenceKey: "key-missing", amount: 5, confirmedDate: "2026-06-01", fxRate: null }, /OCCURRENCE_NOT_FOUND/]]) {
    const before = await head();
    await assert.rejects(() => host.apply(op(payload)), pattern);
    assert.equal(await head(), before);
  }
  await accept(op({ occurrenceKey: "key-euro", amount: 50, confirmedDate: "2026-06-01", fxRate: 4.25 }));
  ledger = await store.listConfirmedTransactions(budgetId);
  const euro = ledger.find(row => row.occurrence_key === "key-euro");
  assert.deepEqual([Number(euro.fx_rate), Number(euro.ledger_amount)], [4.25, 212.5]);
  assert.equal(await head(), 3);
  const page = await host.changes({ budgetId, epoch, afterRevision: 0, limit: 10 });
  assert.deepEqual(page.changes.map(change => change.payload.occurrenceKey), ["key-salary", "key-bonus", "key-euro"]);
}

/** Fault injection after the financial change, its receipt and its change-log
 * entry are written (afterRecord runs last inside the transaction): nothing of
 * the three may persist, and the same operation then applies exactly once. */
async function exerciseFaultAtomicity({ store, epoch, head, operationCount }) {
  await store.insertPlanningRows(budgetId, "pending_transactions", [occurrence("salary")]);
  let fail = true;
  const host = confirmationHost(store, { afterRecord: async () => { if (fail) throw new Error("injected commit fault"); } });
  const operation = { version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: 0, kind: "occurrence.confirm",
    payload: { occurrenceKey: "key-salary", amount: 40, confirmedDate: "2026-06-01", fxRate: null } };
  await assert.rejects(() => host.apply(operation), /injected commit fault/);
  assert.equal(await head(), 0);
  assert.equal(await operationCount(), 0);
  assert.deepEqual(await store.listConfirmedTransactions(budgetId), []);
  assert.ok((await store.listPlanningRows(budgetId, "pending_transactions")).some(row => row.occurrence_key === "key-salary"));
  fail = false;
  const accepted = await host.apply(operation);
  assert.deepEqual([accepted.revision, accepted.replayed], [1, false]);
  assert.equal((await store.listConfirmedTransactions(budgetId)).length, 1);
  assert.equal(await operationCount(), 1);
  assert.equal((await host.apply(operation)).replayed, true);
  assert.equal((await store.listConfirmedTransactions(budgetId)).length, 1);
}

test("a fault after recording rolls back the ledger change, receipt and change entry on SQLite", async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId, today: "2026-06-01" });
  const service = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
  const epoch = randomUUID();
  const sql = text => { const db = service.openPlanningDb(budgetId); try { return db.prepare(text).all(); } finally { db.close(); } };
  try {
    const db = service.openPlanningDb(budgetId);
    try {
      db.exec(FINANCIAL_JOURNAL_SCHEMA);
      db.prepare("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 0)").run(budgetId, epoch);
    } finally { db.close(); }
    await exerciseFaultAtomicity({ store: createSqliteBudgetStore(service), epoch,
      head: async () => sql("SELECT revision FROM cashflow_sync_heads")[0].revision,
      operationCount: async () => sql("SELECT COUNT(*) AS count FROM cashflow_sync_operations")[0].count });
  } finally { await harness.cleanup(); }
});

test("a fault after recording rolls back the ledger change, receipt and change entry on PostgreSQL", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
  const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
  const epoch = randomUUID();
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, "settings", [{ id: 1, ledger_currency: "PLN", updated_at: stamp }]);
    await pool.query(FINANCIAL_JOURNAL_SCHEMA);
    await pool.query("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ($1, $2, 0)", [budgetId, epoch]);
    await exerciseFaultAtomicity({ store, epoch,
      head: async () => Number((await pool.query("SELECT revision FROM cashflow_sync_heads")).rows[0].revision),
      operationCount: async () => Number((await pool.query("SELECT COUNT(*) AS count FROM cashflow_sync_operations")).rows[0].count) });
  } finally { await store.close(); }
}));

test("occurrence confirmations apply the server's ledger semantics atomically on PostgreSQL", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
  const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
  const epoch = randomUUID();
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, "settings", [{ id: 1, ledger_currency: "PLN", updated_at: stamp }]);
    await pool.query(FINANCIAL_JOURNAL_SCHEMA);
    await pool.query("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ($1, $2, 0)", [budgetId, epoch]);
    await exerciseConfirmations({ store, epoch,
      head: async () => Number((await pool.query("SELECT revision FROM cashflow_sync_heads")).rows[0].revision) });
  } finally { await store.close(); }
}));

test("occurrence confirmations apply the server's ledger semantics atomically on SQLite", async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId, today: "2026-06-01" });
  const service = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
  const store = createSqliteBudgetStore(service);
  const epoch = randomUUID();
  const sql = text => { const db = service.openPlanningDb(budgetId); try { return db.prepare(text).all(); } finally { db.close(); } };
  try {
    const db = service.openPlanningDb(budgetId);
    try {
      db.exec(FINANCIAL_JOURNAL_SCHEMA);
      db.prepare("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 0)").run(budgetId, epoch);
    } finally { db.close(); }
    await exerciseConfirmations({ store, epoch, head: async () => sql("SELECT revision FROM cashflow_sync_heads")[0].revision });
  } finally { await harness.cleanup(); }
});

import { createCashflowSettingsService } from "../../src/server/cashflow-settings-service.js";

function settingsAndRemainderHost(store) {

  return createFinancialOperationService({ budgetStore: store,
    authorize: async () => ({ instanceId: "unused", accountId: "unused", budgetId }), project: async () => {},
    planMutations: ({ store: hostStore }) => createCashflowPlanMutationService({ budgetStore: hostStore,
      requireStartMonthYearIfNeeded: helpers.requireStartMonthYearIfNeeded, normalizeRecurringInput: helpers.normalizeRecurringInput,
      withProjectionStatus: (_id, row) => row }),
    ledgerActions: context => ({
      updateSettings: createCashflowSettingsService({ budgetStore: context.store, withProjectionStatus: (_id, row) => row }).updateSettings }) });
}

async function exerciseSettings({ store, epoch, settingsRow }) {
  const host = settingsAndRemainderHost(store);
  const op = (payload, baseRevision) => ({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision, kind: "settings.update", payload });
  const accepted = await host.apply(op({ future_periods: 6, minimum_reserve_enabled: true, minimum_reserve_amount: 250.5,
    fx_buffer_percent: 2, manual_fx_rates: { "EUR/PLN": 4.3 }, timezone: "Europe/Warsaw" }, 0));
  assert.equal(accepted.revision, 1);
  const settings = await settingsRow();
  assert.deepEqual([Number(settings.future_periods), Number(settings.minimum_reserve_amount), Number(settings.fx_buffer_percent), settings.timezone],
    [6, 250.5, 2, "Europe/Warsaw"]);
  for (const payload of [{}, { ledger_currency: "XXX" }, { ntfy_topic: "x" }, { fx_buffer_percent: 101 }, { manual_fx_rates: { "eur/pln": 4 } }]) {
    await assert.rejects(() => host.apply(op(payload, 1)), /settings field|fx_buffer_percent|manual_fx_rates|supported currencies/, JSON.stringify(payload));
  }
  // Server validation still applies: an unknown period income is refused and nothing changes.
  await assert.rejects(() => host.apply(op({ budget_period_income_id: "missing-income" }, 1)));
  assert.equal(Number((await settingsRow()).future_periods), 6);
}

/** A partly paid one-off: confirm 40 of 100 (revision 2, after settings), then
 * dismiss the generated remainder through the server service (revision 3). */
async function exerciseRemainder({ store, epoch }) {
  await store.insertPlanningRows(budgetId, "one_off_transactions", [{ id: "laptop", name: "Laptop", amount: 100, currency: "PLN",
    type: "income", date: "2026-06-01", created_at: stamp, updated_at: stamp }]);
  await store.insertPlanningRows(budgetId, "pending_transactions", [occurrence("laptop-1", { source_one_off_id: "laptop", occurrence_key: "one_off:laptop:income:2026-06-01" })]);
  const confirmer = confirmationHost(store);
  await confirmer.apply({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: 1, kind: "occurrence.confirm",
    payload: { occurrenceKey: "one_off:laptop:income:2026-06-01", amount: 40, confirmedDate: "2026-06-01", fxRate: null } });
  await store.insertPlanningRows(budgetId, "pending_transactions", [occurrence("laptop-2", { source_one_off_id: "laptop", amount: 60, funded_amount: 60,
    occurrence_key: "one_off_remainder:laptop:2" })]);
  const host = settingsAndRemainderHost(store);
  await assert.rejects(() => host.apply({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: 2, kind: "one-off.dismiss-remainder",
    payload: { occurrenceKey: "one_off:laptop:income:2026-06-01" } }), /generated one-off remainder/);
  const dismissed = await host.apply({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: 2, kind: "one-off.dismiss-remainder",
    payload: { occurrenceKey: "one_off_remainder:laptop:2" } });
  assert.equal(dismissed.revision, 3);
  assert.equal(Number((await store.listPlanningRows(budgetId, "one_off_transactions")).find(row => row.id === "laptop").amount), 40);
  assert.equal((await store.listPlanningRows(budgetId, "pending_transactions")).some(row => row.source_one_off_id === "laptop"), false);
}

test("financial settings and remainder dismissal sync through server services on SQLite", async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId, today: "2026-06-01" });
  const service = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
  const store = createSqliteBudgetStore(service);
  const epoch = randomUUID();
  try {
    const db = service.openPlanningDb(budgetId);
    try { db.exec(FINANCIAL_JOURNAL_SCHEMA); db.prepare("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 0)").run(budgetId, epoch); } finally { db.close(); }
    await exerciseSettings({ store, epoch, settingsRow: async () => (await store.listPlanningRows(budgetId, "settings"))[0] });
    await exerciseRemainder({ store, epoch });
  } finally { await harness.cleanup(); }
});

test("financial settings and remainder dismissal sync through server services on PostgreSQL", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
  const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
  const epoch = randomUUID();
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, "settings", [{ id: 1, ledger_currency: "PLN", updated_at: stamp }]);
    await pool.query(FINANCIAL_JOURNAL_SCHEMA);
    await pool.query("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ($1, $2, 0)", [budgetId, epoch]);
    await exerciseSettings({ store, epoch, settingsRow: async () => (await store.listPlanningRows(budgetId, "settings"))[0] });
    await exerciseRemainder({ store, epoch });
  } finally { await store.close(); }
}));

import { createFinancialJournal } from "../../src/server/cashflow-financial-journal.js";

/** Retention prunes change-feed payloads only: replays and receipt lookups keep
 * working across the floor; cursors below it expire and require a bootstrap. */
async function exerciseRetention({ store, epoch, transaction, queryFor }) {
  const host = createFinancialOperationService({ budgetStore: store, authorize: async () => ({}), project: async () => {} });
  const ops = [];
  for (let revision = 0; revision < 3; revision++) {
    const operation = { version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: revision, kind: "one-off.create",
      payload: { id: randomUUID(), name: `Retained ${revision}`, currency: "PLN", amount: 10, type: "income", date: "2026-06-10" } };
    await host.apply(operation); ops.push(operation);
  }
  const journal = connection => createFinancialJournal({ query: queryFor(connection), authorize: async () => {}, mutate: async () => {} });
  const pruned = await transaction(connection => journal(connection).prune(budgetId, 2));
  assert.equal(pruned.retainedAfter, 2);
  assert.equal((await host.apply(ops[0])).replayed, true);
  assert.equal((await host.lookup({ budgetId, epoch, operationId: ops[1].operationId })).revision, 2);
  await assert.rejects(() => host.changes({ budgetId, epoch, afterRevision: 1, limit: 10 }), /CURSOR_EXPIRED/);
  const page = await host.changes({ budgetId, epoch, afterRevision: 2, limit: 10 });
  assert.deepEqual([page.headRevision, page.changes.length, page.changes[0].payload.name], [3, 1, "Retained 2"]);
  await assert.rejects(() => host.apply({ ...ops[0], payload: { ...ops[0].payload, amount: 11 } }), /OPERATION_ID_REUSED/);
  await assert.rejects(() => transaction(connection => journal(connection).prune(budgetId, 4)), /INVALID_CURSOR/);
}

test("journal retention keeps receipts and expires old cursors on SQLite", async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId, today: "2026-06-01" });
  const service = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
  const store = createSqliteBudgetStore(service);
  const epoch = randomUUID();
  try {
    const db = service.openPlanningDb(budgetId);
    try { db.exec(FINANCIAL_JOURNAL_SCHEMA); db.prepare("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 0)").run(budgetId, epoch); } finally { db.close(); }
    await exerciseRetention({ store, epoch, transaction: work => store.planningTransaction(budgetId, (_writer, connection) => work(connection)),
      queryFor: connection => async (sql, args = []) => { const statement = connection.prepare(sql); return statement.reader ? statement.all(...args) : (statement.run(...args), []); } });
  } finally { await harness.cleanup(); }
});

test("journal retention keeps receipts and expires old cursors on PostgreSQL", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
  const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
  const epoch = randomUUID();
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, "settings", [{ id: 1, updated_at: stamp }]);
    await pool.query(FINANCIAL_JOURNAL_SCHEMA);
    await pool.query("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ($1, $2, 0)", [budgetId, epoch]);
    await exerciseRetention({ store, epoch, transaction: work => store.transaction((_writer, connection) => work(connection)),
      queryFor: connection => async (sql, args = []) => { let index = 0; return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), args)).rows; } });
  } finally { await store.close(); }
}));

test("the retention rule prunes inside accepted submissions once a batch accumulates", async () => {
  const { journalRetentionFloor } = await import("../../src/server/cashflow-financial-journal.js");
  assert.equal(journalRetentionFloor(10500), 500);
  assert.equal(journalRetentionFloor(5), 0);
  const harness = await createCashflowTestHarness({ userId: budgetId, today: "2026-06-01" });
  const service = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
  const epoch = randomUUID();
  try {
    const db = service.openPlanningDb(budgetId);
    try {
      db.exec(FINANCIAL_JOURNAL_SCHEMA);
      db.prepare("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 0)").run(budgetId, epoch);
      const query = async (sql, args = []) => { const statement = db.prepare(sql); return statement.reader ? statement.all(...args) : (statement.run(...args), []); };
      const journal = createFinancialJournal({ query, authorize: async () => {}, mutate: async () => {}, retainedRevisions: 2, pruneBatch: 2 });
      for (let revision = 0; revision < 5; revision++) {
        await journal.apply({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: revision, kind: "one-off.create",
          payload: { id: randomUUID(), name: `Batch ${revision}`, currency: "PLN", amount: 1, type: "income", date: "2026-06-10" } });
      }
      const head = await journal.head(budgetId);
      // Revision 4 reaches floor 2 (a full batch past 0) and prunes; revision 5's floor 3 waits for the next batch.
      assert.deepEqual([head.revision, head.retainedAfter], [5, 2]);
      assert.equal(db.prepare("SELECT count(*) AS n FROM cashflow_sync_operations WHERE payload_pruned = 1").get().n, 2);
      await assert.rejects(() => journal.changes({ budgetId, epoch, afterRevision: 1, limit: 10 }), /CURSOR_EXPIRED/);
      assert.equal((await journal.changes({ budgetId, epoch, afterRevision: 2, limit: 10 })).changes.length, 3);
    } finally { db.close(); }
  } finally { await harness.cleanup(); }
});

test("two PostgreSQL replicas racing on one budget serialize under the budget lock", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
  const replicaA = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
  const replicaB = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
  const epoch = randomUUID();
  try {
    await replicaA.initialize();
    await replicaA.insertPlanningRows(budgetId, "settings", [{ id: 1, ledger_currency: "PLN", updated_at: stamp }]);
    await pool.query(FINANCIAL_JOURNAL_SCHEMA);
    await pool.query("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ($1, $2, 0)", [budgetId, epoch]);
    const hosts = [confirmationHost(replicaA), confirmationHost(replicaB)];
    const create = (name, baseRevision) => ({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision, kind: "one-off.create",
      payload: { id: randomUUID(), name, currency: "PLN", amount: 10, type: "income", date: "2026-06-10" } });
    // Different operations on the same base: exactly one wins, the other conflicts.
    for (let round = 0; round < 5; round++) {
      const head = Number((await pool.query("SELECT revision FROM cashflow_sync_heads")).rows[0].revision);
      const outcomes = await Promise.allSettled(hosts.map((host, index) => host.apply(create(`race-${round}-${index}`, head))));
      assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1, `round ${round}`);
      assert.match(String(outcomes.find(result => result.status === "rejected").reason?.message), /REVISION_CONFLICT/);
    }
    assert.equal(Number((await pool.query("SELECT revision FROM cashflow_sync_heads")).rows[0].revision), 5);
    // The same operation from both replicas applies once; the other is a replay or a conflict, never a second source.
    const same = create("same-id", 5);
    const duplicate = await Promise.allSettled(hosts.map(host => host.apply(same)));
    const accepted = duplicate.filter(result => result.status === "fulfilled").map(result => result.value);
    assert.ok(accepted.length >= 1 && accepted.every(result => result.revision === 6));
    assert.equal(accepted.filter(result => !result.replayed).length, 1);
    assert.equal((await replicaA.listPlanningRows(budgetId, "one_off_transactions")).filter(row => row.id === same.payload.id).length, 1);
    // Two confirmations of one occurrence: one ledger row only.
    await replicaA.insertPlanningRows(budgetId, "pending_transactions", [occurrence("raced")]);
    const confirm = baseRevision => ({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision, kind: "occurrence.confirm",
      payload: { occurrenceKey: "key-raced", amount: 100, confirmedDate: "2026-06-01", fxRate: null } });
    await Promise.allSettled(hosts.map(host => host.apply(confirm(6))));
    assert.equal((await replicaA.listConfirmedTransactions(budgetId)).filter(row => row.occurrence_key === "key-raced").length, 1);
    assert.equal(Number((await pool.query("SELECT revision FROM cashflow_sync_heads")).rows[0].revision), 7);
  } finally { await replicaA.close(); await replicaB.close(); }
}));


import { readFinancialBootstrapPart } from "../../src/server/cashflow-app-bootstrap-records.js";
import { setTodayOverrideForTests } from "../../src/server/cashflow-date-utils.js";

/** Real settings + confirmation services share the operation's writer on both
 * stores. Rejections/faults must not leak a setting, event, pending row or receipt. */
async function exerciseCurrencyChanges({ store, epoch }) {
  const host = confirmationHost(store);
  let revision = 0;
  const operation = (kind, payload) => ({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: revision, kind, payload });
  const apply = async (kind, payload) => { const result = await host.apply(operation(kind, payload)); revision = result.revision; return result; };
  const zero = await apply('settings.update', { ledger_currency: 'CZK', manual_fx_rates: {} });
  assert.equal(JSON.parse(zero.pendingConversion.note).source, 'zero-balance');
  await apply('occurrence.confirm', { occurrenceKey: zero.pendingConversion.occurrence_key, amount: 0, confirmedDate: zero.pendingConversion.date, fxRate: null });
  const zeroBack = await apply('settings.update', { ledger_currency: 'PLN', manual_fx_rates: {} });
  await apply('occurrence.confirm', { occurrenceKey: zeroBack.pendingConversion.occurrence_key, amount: 0, confirmedDate: zeroBack.pendingConversion.date, fxRate: null });
  await store.insertPlanningRows(budgetId, "pending_transactions", [occurrence("original-currency-payment")]);
  await apply("occurrence.confirm", { occurrenceKey: "key-original-currency-payment", amount: 100, confirmedDate: "2026-06-01", fxRate: null });
  const original = (await store.listConfirmedTransactions(budgetId)).find(row => row.id === "original-currency-payment");
  await assert.rejects(() => host.apply(operation("settings.update", { ledger_currency: "EUR", manual_fx_rates: {} })), /Missing FX rate/);
  assert.equal((await store.listPlanningRows(budgetId, "settings"))[0].ledger_currency, "PLN");
  assert.equal((await store.listPlanningRows(budgetId, "ledger_currency_events")).length, 2);

  const switchOp = operation("settings.update", { ledger_currency: "EUR", manual_fx_rates: { "PLN/EUR": 0.25 } });
  const switched = await host.apply(switchOp); revision = switched.revision;
  const pending = switched.pendingConversion;
  assert.equal(Number(pending.amount), 25);
  assert.equal(pending.currency, "EUR");
  assert.equal((await store.listPlanningRows(budgetId, "settings"))[0].ledger_currency, "EUR");
  const events = await store.listPlanningRows(budgetId, "ledger_currency_events");
  const conversionEvent = events.find(row => row.old_currency === "PLN" && row.new_currency === "EUR");
  assert.deepEqual([events.length, Number(conversionEvent.old_balance), Number(conversionEvent.converted_opening_balance)], [3, 100, 25]);
  assert.equal((await host.apply(switchOp)).replayed, true);
  assert.equal((await host.lookup({ budgetId, epoch, operationId: switchOp.operationId })).pendingConversion.id, pending.id);
  const changes = await host.changes({ budgetId, epoch, afterRevision: revision - 1, limit: 10 });
  assert.equal(changes.changes[0].pendingConversion.id, pending.id);
  await assert.rejects(() => host.apply(operation("settings.update", { ledger_currency: "USD", manual_fx_rates: { "EUR/USD": 2 } })), /pending ledger currency conversion/);
  const transaction = store.backend === 'postgres' ? work => store.transaction(work) : work => store.planningTransaction(budgetId, work);
  await transaction(async writer => {
    const context = { writer, budgetId };
    assert.equal((await readFinancialBootstrapPart(context, 'currency-events')).some(row => row.id === conversionEvent.id), true);
    assert.equal((await readFinancialBootstrapPart(context, 'planning')).find(record => record.table === 'pending_transactions').row.id, pending.id);
  });
  await apply("occurrence.confirm", { occurrenceKey: pending.occurrence_key, amount: 25, confirmedDate: pending.date, fxRate: null });
  const history = await store.listConfirmedTransactions(budgetId);
  assert.deepEqual(history.find(row => row.id === original.id), original);
  assert.equal(history.find(row => row.occurrence_key === pending.occurrence_key).ledger_currency, "EUR");
  assert.equal((await store.listPlanningRows(budgetId, "pending_transactions")).length, 0);

  const failedOp = operation("settings.update", { ledger_currency: "USD", manual_fx_rates: { "EUR/USD": 2 } });
  await assert.rejects(() => confirmationHost(store, { afterRecord: () => { throw new Error("conversion rollback probe"); } }).apply(failedOp), /rollback probe/);
  assert.equal((await store.listPlanningRows(budgetId, "settings"))[0].ledger_currency, "EUR");
  assert.equal((await store.listPlanningRows(budgetId, "ledger_currency_events")).length, 3);
  assert.equal((await store.listPlanningRows(budgetId, "pending_transactions")).length, 0);
  assert.equal(await host.lookup({ budgetId, epoch, operationId: failedOp.operationId }), null);

  // Cached inverse precedes the provider; the next change uses provider fallback.
  const cachedHost = confirmationHost(store, { currencyOptions: { getCachedFxRateAsync: async (_id, base, _date, quote) => base === 'USD' && quote === 'EUR' ? 0.5 : null,
    fetchProviderRate: async () => { throw new Error('cache must win'); } } });
  const cached = await cachedHost.apply(operation('settings.update', { ledger_currency: 'USD', manual_fx_rates: {} })); revision = cached.revision;
  assert.equal(JSON.parse(cached.pendingConversion.note).source, 'inverse-cache');
  await apply('occurrence.confirm', { occurrenceKey: cached.pendingConversion.occurrence_key, amount: 50, confirmedDate: cached.pendingConversion.date, fxRate: null });
  const providerHost = confirmationHost(store, { currencyOptions: { fetchProviderRate: async () => ({ rate: 0.5, source: 'synthetic-provider' }) } });
  const provided = await providerHost.apply(operation('settings.update', { ledger_currency: 'GBP', manual_fx_rates: {} })); revision = provided.revision;
  assert.equal(JSON.parse(provided.pendingConversion.note).source, 'synthetic-provider');
  await apply('occurrence.confirm', { occurrenceKey: provided.pendingConversion.occurrence_key, amount: 25, confirmedDate: provided.pendingConversion.date, fxRate: null });
}

test("ledger currency settings operations produce syncable conversions atomically on SQLite", async () => {
  const harness = await createCashflowTestHarness({ userId: budgetId, today: "2026-06-01" });
  const service = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
  const store = createSqliteBudgetStore(service); const epoch = randomUUID();
  try {
    const db = service.openPlanningDb(budgetId);
    try { db.exec(FINANCIAL_JOURNAL_SCHEMA); db.prepare("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 0)").run(budgetId, epoch); } finally { db.close(); }
    await exerciseCurrencyChanges({ store, epoch });
  } finally { await harness.cleanup(); }
});

test("ledger currency settings operations produce syncable conversions atomically on PostgreSQL", {
  skip: !postgresRuntimeTestsEnabled()
}, async () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1,$1,'Synthetic',now(),now())", [budgetId]);
  const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 }); const epoch = randomUUID();
  // Pin the calendar as the SQLite variant's harness does: the exercise confirms payments dated 2026-06-01.
  const previousToday = setTodayOverrideForTests("2026-06-01");
  try {
    await store.initialize();
    await store.insertPlanningRows(budgetId, "settings", [{ id: 1, ledger_currency: "PLN", updated_at: stamp }]);
    await pool.query(FINANCIAL_JOURNAL_SCHEMA);
    await pool.query("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ($1, $2, 0)", [budgetId, epoch]);
    await exerciseCurrencyChanges({ store, epoch });
  } finally { setTodayOverrideForTests(previousToday); await store.close(); }
}));

import { createCashflowSetupService } from '../../src/server/cashflow-setup-service.js';

/** Device create-budget and browser first-run setup call this same service.
 * Keep unrelated pending income out, retain provenance, and replace the staged
 * opening atomically so it cannot be confirmed twice after a currency switch. */
async function exerciseSetupOpeningCurrency(store, dbService, mode, seedHead, confirmed = false) {
  const setup = createCashflowSetupService({ budgetStore: store, ...dbService,
    regenerateProjectionsAfterMutation: () => {}, regenerateProjectionsAfterMutationAsync: async () => {} });
  const result = await setup.completeSetup(budgetId, { currency: 'EUR', opening_balance: 75,
    income_enabled: false, timezone: 'Europe/Warsaw', holiday_country: 'PL', locale: 'en', future_periods: 3 });
  assert.equal((await store.listConfirmedTransactions(budgetId)).length, 0);
  const epoch = randomUUID();
  await seedHead(epoch);
  const host = confirmationHost(store);
  let revision = 0;
  const operation = () => ({ version: 1, operationId: randomUUID(), budgetId, epoch, baseRevision: revision,
    kind: 'settings.update', payload: { ledger_currency: 'PLN', manual_fx_rates: { 'EUR/PLN': 4 } } });
  if (confirmed) {
    const row = (await store.listPlanningRows(budgetId, 'pending_transactions'))[0];
    const receipt = await host.apply({ ...operation(), kind: 'occurrence.confirm', payload: {
      occurrenceKey: row.occurrence_key, amount: 75, confirmedDate: row.date, fxRate: null } });
    revision = receipt.revision;
  }
  await store.insertPlanningRows(budgetId, 'pending_transactions', [occurrence('unrelated', { currency: 'EUR', ledger_currency: 'EUR', ledger_amount: 100 })]);
  if (mode === 'device') {
    await assert.rejects(() => host.apply({ ...operation(), payload: { ledger_currency: 'PLN', manual_fx_rates: {} } }), /Missing FX rate/);
    await assert.rejects(() => confirmationHost(store, { afterRecord: () => { throw new Error('opening rollback'); } }).apply(operation()), /opening rollback/);
    assert.equal((await store.listPlanningRows(budgetId, 'settings'))[0].ledger_currency, 'EUR');
    if (!confirmed) assert.ok((await store.listPlanningRows(budgetId, 'pending_transactions')).some(row => row.id === result.created.openingBalanceId));
    const receipt = await host.apply(operation());
    assert.equal(Number(receipt.pendingConversion.amount), 300);
  } else {
    const ledger = createCashflowLedgerService({ budgetStore: store, ...dbService });
    await createCashflowSettingsService({ budgetStore: store, ...dbService,
      latestConfirmedBalance: ledger.latestConfirmedBalance,
      latestConfirmedBalanceAsync: ledger.latestConfirmedBalanceAsync }).updateSettings(budgetId, operation().payload);
  }
  const pending = await store.listPlanningRows(budgetId, 'pending_transactions');
  assert.equal(pending.some(row => row.id === result.created.openingBalanceId), false);
  assert.ok(pending.some(row => row.id === 'unrelated'));
  const conversion = pending.find(row => row.occurrence_key.startsWith('ledger_currency_conversion:'));
  assert.equal(Number(conversion.amount), 300);
  const event = (await store.listPlanningRows(budgetId, 'ledger_currency_events'))[0];
  assert.equal(Number(event.old_balance), 75);
  assert.equal(Number(event.converted_opening_balance), 300);
  // PostgreSQL returns the JSONB details parsed; SQLite returns the stored text.
  const details = typeof event.details === 'string' ? JSON.parse(event.details) : event.details;
  if (!confirmed) assert.equal(details.firstRunOpeningRows[0].id, result.created.openingBalanceId);
  assert.equal((await store.listConfirmedTransactions(budgetId)).length, confirmed ? 1 : 0);
  await host.apply({ ...operation(), baseRevision: revision + 1, kind: 'occurrence.confirm', payload: {
    occurrenceKey: conversion.occurrence_key, amount: 300, confirmedDate: conversion.date, fxRate: null } });
  assert.equal(await createCashflowLedgerService({ budgetStore: store }).latestConfirmedBalanceAsync(budgetId), 300);

}

for (const mode of ['device', 'browser']) for (const confirmed of [false, true]) {
  test(`SQLite ${mode} currency switch includes ${confirmed ? 'confirmed' : 'staged'} setup opening without payments`, async () => {
    const harness = await createCashflowTestHarness({ userId: budgetId, today: '2026-06-01' });
    const dbService = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
    const store = createSqliteBudgetStore(dbService);
    try {
      await exerciseSetupOpeningCurrency(store, dbService, mode, async epoch => {
        const db = dbService.openPlanningDb(budgetId);
        try { db.exec(FINANCIAL_JOURNAL_SCHEMA); db.prepare('INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 0)').run(budgetId, epoch); }
        finally { db.close(); }
      }, confirmed);
    } finally { await harness.cleanup(); }
  });
  test(`PostgreSQL ${mode} currency switch includes ${confirmed ? 'confirmed' : 'staged'} setup opening without payments`, {
    skip: !postgresRuntimeTestsEnabled()
  }, () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    await pool.query(createPostgresGlobalSchemaSql());
    await pool.query("INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Opening regression',now(),now())", [budgetId]);
    const store = await createPostgresBudgetStore({ databaseUrl, poolMax: 2 });
    const previousToday = setTodayOverrideForTests('2026-06-01');
    try {
      await store.initialize();
      await store.insertPlanningRows(budgetId, 'settings', [{ id: 1, ledger_currency: 'PLN', updated_at: stamp }]);
      await exerciseSetupOpeningCurrency(store, null, mode, async epoch => {
        await pool.query(FINANCIAL_JOURNAL_SCHEMA);
        await pool.query('INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES ($1,$2,0)', [budgetId, epoch]);
      }, confirmed);
    } finally { setTodayOverrideForTests(previousToday); await store.close(); }
  }));
}
