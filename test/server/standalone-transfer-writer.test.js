import { currencyTransferFixture } from '../helpers/currency-transfer-fixture.js';
import { setTodayOverrideForTests } from '../../src/server/cashflow-date-utils.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createPostgresGlobalSchemaSql } from '../../src/server/cashflow-postgres-global-schema.js';
import { createCashflowFxCacheService } from '../../src/server/cashflow-fx-cache-service.js';
import { prepareStandaloneTransferWrite } from '../../src/server/cashflow-standalone-transfer-writer.js';
import { prepareStandaloneTransferRates } from '../../src/server/cashflow-standalone-transfer-rates.js';
import { applyProjectionGenerationPlanToBudgetStore } from '../../src/server/cashflow-projection-engine-service.js';
import { standaloneTransferDestination } from '../../src/server/cashflow-standalone-transfer-record.js';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { completeSnapshot } from '../engine/fixtures.js';
import { calculateSnapshot } from '../../src/engine/snapshot.js';
import { confirmLocalOccurrence, correctLocalConfirmation } from '../../src/engine/local-confirmation.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';

const timing = { today: '2026-06-02', generationTimestamp: '2026-06-02T12:00:00.000Z', idSeed: 'transfer-writer' };
const upgraded = { allowStandaloneOrigins: true };
const fx = createCashflowFxCacheService({ normalizeCurrency: value => String(value).toUpperCase() });
const readFxSnapshot = ({ writer, budgetId, today }) => fx.getCachedFxSnapshotAsync(budgetId, today, writer);
const destination = index => standaloneTransferDestination({ instanceId: '11111111-1111-4111-8111-111111111111',
  accountId: 'synthetic-owner', deviceId: 'synthetic-device', transferId: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}` });

/** Synthetic standalone commands create actual provenance. No imported balance
 * or made-up server audit is used as a substitute for payment history. */
function fixtures() {
  const paid = standaloneOriginAuditFixture().snapshot;
  const voided = correctLocalConfirmation({ snapshot: paid, ...timing, confirmationId: 'confirmed-original',
    replacement: null, expectedCorrectionId: null, reason: 'Synthetic void', idSeed: 'void' });
  const repaid = confirmLocalOccurrence({ snapshot: voided, ...timing,
    occurrenceKey: 'one_off_remainder:source:2', idSeed: 'repaid', amount: 100 });
  const empty = completeSnapshot();
  Object.assign(empty, { budgetId: 'local-empty-transfer', name: 'Signed empty opening' });
  Object.assign(empty.request, timing, { openingBalance: -50 });
  empty.request.tables.one_off_transactions = [];
  const foreign = standaloneOriginAuditFixture({ currency: 'EUR', amount: 50 }).snapshot;
  foreign.request.fxSnapshot['eur/pln'].rate = 5;
  const manual = structuredClone(foreign);
  manual.request.fxSnapshot['eur/pln'].effectiveDate = '2020-01-01';
  const rich = completeSnapshot();
  Object.assign(rich, { budgetId: 'local-rich-transfer', name: 'Forecast and funding' });
  Object.assign(rich.request, timing);
  rich.request.tables.one_off_transactions = [];
  rich.request.tables.planned_transactions = [{ id: 'rent-plan', operating_priority: 1 },
    { id: 'goal-plan', goal_priority: 1 }, { id: 'flex-plan', operating_priority: 2 }];
  const recurring = { currency: 'PLN', active: 1, repeat_every_months: 1, anchor_type: 'day_of_month',
    anchor_day_of_month: 1, anchor_business_day_adjustment: 'none', prediction_strategy: 'fixed' };
  rich.request.tables.recurring_incomes = [{ ...recurring, id: 'salary', name: 'Salary', amount: 600,
    prediction_strategy: '12month_min', prediction_substitute_missing: 'last_confirmed' }];
  rich.request.tables.recurring_expenses = [{ ...recurring, id: 'rent', name: 'Rent', amount: 100, necessary: 1, planned_transaction_id: 'rent-plan' }];
  rich.request.tables.goals = [{ id: 'goal', name: 'Goal', amount: 200, currency: 'PLN', active: 1,
    due_date: '2026-06-20', planned_transaction_id: 'goal-plan' }];
  rich.request.tables.flex_transactions = [{ id: 'flex', name: 'Split flex', amount: 100, currency: 'PLN', active: 1,
    allow_split: 1, min_amount: 10, max_amount: 30, planned_transaction_id: 'flex-plan' }];
  let funded = rich;
  for (const id of ['salary', 'rent', 'goal', 'flex']) {
    const plan = calculateSnapshot(funded).plan;
    const row = [...plan.pendingRows, ...plan.futureRows].find(row => ['source_recurring_income_id',
      'source_recurring_expense_id', 'source_goal_id', 'source_flex_id'].some(key => row[key] === id));
    assert.ok(row);
    funded = confirmLocalOccurrence({ snapshot: funded, ...timing, occurrenceKey: row.occurrence_key,
      idSeed: id, ...(row.date > timing.today ? { early: true } : {}) });
  }
  funded.request.tables.recurring_incomes[0].amount = 5;
  funded.request.tables.recurring_expenses[0].active = 0;
  return [empty, paid, voided, repaid, foreign, manual, funded];
}

/** A private empty file on SQLite or an uncommitted parent on PostgreSQL is
 * fixture allocation, not an implementation of authenticated publication. */
async function withStore(work) {
  const root = await mkdtemp(path.join(tmpdir(), 'cashflow-transfer-writer-'));
  const db = createCashflowDbService(createCashflowStoragePaths(root));
  const store = createSqliteBudgetStore({ ...db, ...upgraded });
  try {
    await work({ store, create: async budgetId => db.openPlanningDb(budgetId).close(),
      transaction: (budgetId, callback) => store.planningTransaction(budgetId, callback) });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
}

async function exercise({ store, create, transaction }) {
  let index = 0;
  for (const source of fixtures()) {
    const budgetId = destination(++index);
    await create(budgetId);
    const sourceJson = JSON.stringify(source);
    const plan = prepareStandaloneTransferWrite({ sourceJson, budgetId, readFxSnapshot, ...timing });
    const preview = plan.preview();
    preview.balance = 99999;
    assert.notEqual(plan.preview().balance, preview.balance);
    await assert.rejects(plan.write(store), /fresh unpublished/);
    await assert.rejects(transaction(budgetId, async writer => {
      await plan.write(writer);
      throw new Error('Injected late publication failure');
    }), /Injected late publication failure/);
    assert.equal(await store.exportLedgerAuditSnapshot(budgetId), null);
    assert.deepEqual(await store.listConfirmedTransactions(budgetId), []);
    assert.deepEqual(await store.listPlanningRows(budgetId, 'one_off_transactions'), []);
    const result = await transaction(budgetId, async writer => {
      const result = await plan.write(writer);
      await applyProjectionGenerationPlanToBudgetStore({ budgetStore: writer, budgetId, plan: result.calculation.plan });
      return result;
    });
    assert.equal(result.snapshot.request.openingBalance, plan.preview().balance);
    assert.equal(result.ledgerAudit.origin.sourceBudgetId, source.budgetId);
    assert.equal(result.ledgerAudit.origin.openingBalance, source.localOpeningBalance ?? source.request.openingBalance);
    assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), result.ledgerAudit);
    assert.equal((await store.listConfirmedTransactions(budgetId)).length, plan.preview().paymentCount);
    assert.equal((await store.listPlanningRows(budgetId, 'settings'))[0].setup_completed == true, true);
    await assert.rejects(transaction(budgetId, writer => plan.write(writer)), /fresh unpublished/);
    assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), result.ledgerAudit);
    assert.equal(JSON.stringify(source), sourceJson);
  }
}

test('fresh SQLite transfer writer retains real financial state and rolls back late publication failure', () => withStore(exercise));
test('fresh PostgreSQL transfer writer retains real financial state and rolls back late publication failure', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  const store = await createPostgresBudgetStore({ databaseUrl, ...upgraded });
  try {
    await store.initialize();
    await exercise({ store, create: budgetId => pool.query(
      "INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Synthetic transfer writer',now(),now())", [budgetId]),
    transaction: (_budgetId, callback) => store.transaction(callback) });
  } finally { await store.close(); }
}));

/** Pre-existing targets and silent write failures must not turn into accepted
 * financial transfers, even when the SQL operation itself reports no error. */
async function refusalCases({ store, create, transaction }) {
  const source = standaloneOriginAuditFixture().snapshot;
  const budgetId = destination(100);
  await create(budgetId);
  const plan = prepareStandaloneTransferWrite({ sourceJson: JSON.stringify(source), budgetId, readFxSnapshot, ...timing });
  const existing = { id: 'existing', name: 'Retained remote item', amount: 1, type: 'income', currency: 'PLN',
    date: timing.today, created_at: timing.generationTimestamp, updated_at: timing.generationTimestamp };
  await store.insertPlanningRows(budgetId, 'one_off_transactions', [existing]);
  await assert.rejects(transaction(budgetId, writer => plan.write(writer)), /fresh unpublished/);
  assert.equal((await store.listPlanningRows(budgetId, 'one_off_transactions'))[0].id, 'existing');
  assert.equal(await store.exportLedgerAuditSnapshot(budgetId), null);
  await store.replacePlanningRows(budgetId, 'one_off_transactions', []);
  await assert.rejects(transaction(budgetId, writer => plan.write(new Proxy(writer, {
    get(target, key) {
      if (key === 'insertPlanningRows') return async () => ({ inserted: 0 });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }))), /sources were not retained/);
  assert.equal(await store.exportLedgerAuditSnapshot(budgetId), null);
  assert.deepEqual(await store.listConfirmedTransactions(budgetId), []);
  assert.ok(!(await store.listPlanningRows(budgetId, 'settings'))[0]?.setup_completed);
  // A rate can be unused by today's fully paid source. Its durable loss must
  // still refuse the transfer rather than waiting for a future foreign bill.
  const foreign = fixtures().find(value => value.budgetId === 'local-origin-audit'
    && value.request.fxSnapshot?.['eur/pln']);
  const foreignPlan = prepareStandaloneTransferWrite({ sourceJson: JSON.stringify(foreign), budgetId, readFxSnapshot, ...timing });
  for (const [method, error] of [['upsertFxRates', /exchange rates were not retained/],
    ['replacePlanningRows', /settings were not retained/]]) {
    await assert.rejects(transaction(budgetId, writer => foreignPlan.write(new Proxy(writer, {
      get(target, key) {
        if (key === method) return async () => ({ inserted: 0 });
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    }))), error);
    assert.equal(await store.exportLedgerAuditSnapshot(budgetId), null);
    assert.deepEqual(await store.listConfirmedTransactions(budgetId), []);
    assert.deepEqual(await store.listPlanningRows(budgetId, 'fx_rates_cache'), []);
  }
  await assert.rejects(transaction(budgetId, writer => foreignPlan.write(new Proxy(writer, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === 'listPlanningRows') return async (id, table) => {
        const rows = await target.listPlanningRows(id, table);
        return table === 'one_off_transactions' ? rows.map(row => ({ ...row, amount: row.amount + 1 })) : rows;
      };
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }))), /source changed in storage/);
  assert.equal(await store.exportLedgerAuditSnapshot(budgetId), null);
}
test('SQLite transfer refuses existing sources and ignored source writes without replacing retained state', () => withStore(refusalCases));
test('PostgreSQL transfer refuses existing sources and ignored source writes without replacing retained state', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  const store = await createPostgresBudgetStore({ databaseUrl, ...upgraded });
  try {
    await store.initialize();
    await refusalCases({ store, create: budgetId => pool.query(
      "INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Synthetic refusal',now(),now())", [budgetId]),
    transaction: (_budgetId, callback) => store.transaction(callback) });
  } finally { await store.close(); }
}));

/** Materializing existing history and planning does not record a new FX payment.
 * Stale planning observations and historical actual rates retain their dates and values.
 * The publication host still requires its separate explicit provider-rate review. */
async function staleRateCase({ store, create, transaction }) {
  const source = standaloneOriginAuditFixture({ currency: 'EUR', amount: 50 }).snapshot;
  Object.assign(source.request.fxSnapshot['eur/pln'], { effectiveDate: '2026-05-01', source: 'nbp' });
  const budgetId = destination(200);
  // Shared preflight and calculation accept this authentic standalone source.
  const plan = prepareStandaloneTransferWrite({ sourceJson: JSON.stringify(source), budgetId, readFxSnapshot, ...timing });
  await create(budgetId);
  const retained = await transaction(budgetId, writer => plan.write(writer));
  assert.equal(retained.snapshot.request.fxSnapshot['eur/pln'].rate, source.request.fxSnapshot['eur/pln'].rate);
  assert.equal((await store.listPlanningRows(budgetId, 'fx_rates_cache'))[0].rate_date, '2026-05-01');
  assert.equal(retained.snapshot.request.predictionRows[0].fx_rate, 4.2);
  assert.ok(await store.exportLedgerAuditSnapshot(budgetId));
  const historical = JSON.stringify(source.localAudit);
  const reviewed = await prepareStandaloneTransferRates({ sourceJson: JSON.stringify(source), ...timing,
    fetchRate: async request => {
      assert.deepEqual(request, { provider: 'nbp', baseCurrency: 'EUR', quoteCurrency: 'PLN' });
      return { source: 'nbp', rate: 5, effectiveDate: '2026-06-01' };
    } });
  const refreshedBudgetId = destination(201);
  await create(refreshedBudgetId);
  const refreshedPlan = prepareStandaloneTransferWrite({ sourceJson: reviewed.sourceJson, budgetId: refreshedBudgetId, readFxSnapshot, ...timing });
  const result = await transaction(refreshedBudgetId, writer => refreshedPlan.write(writer));
  assert.equal(result.snapshot.request.fxSnapshot['eur/pln'].rate, 5);
  assert.equal(result.snapshot.request.predictionRows[0].fx_rate, 4.2);
  assert.equal(result.snapshot.request.openingBalance, 290);
  assert.equal(JSON.stringify(JSON.parse(reviewed.sourceJson).localAudit), historical);
}
test('SQLite transfer retains stale planning rates without changing historical actual rates', () => withStore(staleRateCase));
test('PostgreSQL transfer retains stale planning rates without changing historical actual rates', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  const store = await createPostgresBudgetStore({ databaseUrl, ...upgraded });
  try {
    await store.initialize();
    await staleRateCase({ store, create: budgetId => pool.query(
      "INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Synthetic stale FX',now(),now())", [budgetId]),
    transaction: (_budgetId, callback) => store.transaction(callback) });
  } finally { await store.close(); }
}));

/** Exercise the owning writer, readback and persisted forecast for every currency
 * outcome, including H5 recomputations and a return to the initial currency. */
async function currencyCases({ store, create, transaction }) {
  const previous = setTodayOverrideForTests(timing.today);
  try {
    let index = 400;
    for (const stage of ['pending', 'confirmed', 'voided', 'returned']) for (const reviewed of [false, true]) {
      const source = currencyTransferFixture(stage, reviewed);
      const budgetId = destination(index++);
      await create(budgetId);
      const plan = prepareStandaloneTransferWrite({ sourceJson: JSON.stringify(source), budgetId, readFxSnapshot, ...timing });
      const result = await transaction(budgetId, writer => plan.write(writer));
      assert.equal(result.snapshot.request.openingBalance, source.request.openingBalance);
      assert.deepEqual(result.ledgerAudit.origin.events, source.localAudit);
      assert.equal((await store.listPlanningRows(budgetId, 'pending_transactions')).length, stage === 'pending' ? 1 : 0);
      assert.deepEqual((await store.listConfirmedTransactions(budgetId)).map(row => [row.id, row.amount, row.ledger_currency]).sort(),
        source.localHistory.map(row => [row.id, row.amount, row.ledger_currency]).sort());
      assert.equal(await store.ledgerOpeningBalance(budgetId, 'EUR'), 0);
      assert.equal(await store.ledgerOpeningBalance(budgetId, 'PLN'), 500);
      const future = rows => rows.map(row => [row.occurrence_key, row.amount, row.ledger_amount, row.ledger_currency, row.type, row.date]);
      assert.ok(result.calculation.plan.futureRows.some(row => row.source_one_off_id === 'future'));
      assert.deepEqual(future(result.calculation.plan.futureRows), future(calculateSnapshot(source).plan.futureRows));
      assert.deepEqual(calculateSnapshot(result.snapshot).plan, result.calculation.plan);
      await transaction(budgetId, async writer => {
        await applyProjectionGenerationPlanToBudgetStore({ budgetId, budgetStore: writer, plan: result.calculation.plan, ...timing });
      });
      assert.deepEqual(await store.exportLedgerAuditSnapshot(budgetId), result.ledgerAudit);
      const events = await store.listPlanningRows(budgetId, 'ledger_currency_events');
      assert.equal(events.length, stage === 'returned' ? 2 : 1);
      assert.equal(result.snapshot.request.fxSnapshot[stage === 'returned' ? 'eur/pln' : 'pln/eur'].effectiveDate, '2020-01-01');
    }
  } finally { setTodayOverrideForTests(previous); }
}
test('SQLite currency transfer retains pending/confirmed/voided/returned conversions and H5 reviews', () => withStore(currencyCases));
test('PostgreSQL currency transfer retains pending/confirmed/voided/returned conversions and H5 reviews', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
  await pool.query(createPostgresGlobalSchemaSql());
  const store = await createPostgresBudgetStore({ databaseUrl, ...upgraded });
  try {
    await store.initialize();
    await currencyCases({ store, create: budgetId => pool.query(
      "INSERT INTO budgets (id,storage_key,display_name,created_at,updated_at) VALUES ($1,$1,'Synthetic currency transfer',now(),now())", [budgetId]),
      transaction: (_budgetId, callback) => store.transaction(callback) });
  } finally { await store.close(); }
}));
