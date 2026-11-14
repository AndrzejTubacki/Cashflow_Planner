import test from 'node:test';
import assert from 'node:assert/strict';
import { withStandaloneTransferPublisherFixture } from '../helpers/standalone-transfer-publisher-fixture.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createCashflowSettingsService } from '../../src/server/cashflow-settings-service.js';
import { hostPlanningStore } from '../../src/server/cashflow-financial-operation-service.js';
import { readFinancialBootstrapPart } from '../../src/server/cashflow-app-bootstrap-records.js';
import { setTodayOverrideForTests } from '../../src/server/cashflow-date-utils.js';

const budgetId = 'transfer-existing';
const stamp = '2026-10-28T12:00:00.000Z';

/** Model pre-H8 accepted rows, including an older writer adding a payment after
 * audit capture. Settings must preserve those facts without inventing originals
 * or relaxing the separate full-audit integrity gate. */
async function exercise(f, history, directSqlite = false) {
  const previous = setTodayOverrideForTests('2026-10-28');
  const run = work => {
    const transact = f.budget.backend === 'postgres'
      ? callback => f.budget.transaction(callback)
      : callback => f.budget.planningTransaction(budgetId, callback);
    return transact(async (writer, connection) => {
      if (f.budget.backend === 'postgres') await writer.lockBudgetLedger(budgetId);
      const query = async (sql, args = []) => {
        if (f.budget.backend === 'postgres') {
          let index = 0;
          return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), args)).rows;
        }
        const statement = connection.prepare(sql);
        return statement.reader ? statement.all(...args) : (statement.run(...args), []);
      };
      return work({ writer, query });
    });
  };
  const payment = (id, amount) => ({ id, name: id, currency: 'PLN', ledger_currency: 'PLN',
    type: 'income', amount, ledger_amount: amount, fx_rate: 1, buffered_fx_rate: 1,
    running_balance_pln: amount + (history === 'partial' && id === 'legacy-income' ? 200 : 0),
    date: id === 'retained-income' ? '2026-10-27' : '2026-10-28',
    confirmed_date: id === 'retained-income' ? '2026-10-27' : '2026-10-28', ledger_year: 2026,
    occurrence_key: `manual:${id}`, created_at: stamp, updated_at: stamp });
  const auditRows = () => run(async ({ query }) => ({
    state: await query('SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]),
    originals: await query('SELECT * FROM cashflow_ledger_originals WHERE budget_id = ? ORDER BY sequence_number', [budgetId]),
    corrections: await query('SELECT * FROM cashflow_ledger_corrections WHERE budget_id = ? ORDER BY sequence_number', [budgetId])
  }));
  try {
    await run(async ({ writer, query }) => {
      if (history === 'partial') {
        await writer.insertConfirmedTransactions(budgetId, [payment('retained-income', 200)]);
        await writer.prepareLedgerAuditCapture(budgetId, stamp);
      } else if (history === 'incomplete') {
        await query('INSERT INTO cashflow_ledger_audit_state (budget_id, last_sequence, baseline_complete) VALUES (?, 0, 0)', [budgetId]);
      }
      await writer.insertConfirmedTransactions(budgetId, [payment('legacy-income', 500)]);
    });
    const beforeAudit = await auditRows();
    const beforePayments = await f.budget.listConfirmedTransactions(budgetId);
    const total = history === 'partial' ? 700 : 500;
    const service = createCashflowSettingsService(directSqlite ? {
      openPlanningDb: f.db.openPlanningDb,
      latestConfirmedBalance: () => total
    } : { budgetStore: f.budget });
    // Device financial operations use this transaction-bound store facade on
    // SQLite; browser settings use the direct synchronous service path.
    const update = updates => !directSqlite && f.budget.backend === 'sqlite'
      ? run(({ writer }) => createCashflowSettingsService({ budgetStore: hostPlanningStore(writer) }).updateSettings(budgetId, updates))
      : service.updateSettings(budgetId, updates);
    assert.equal((await service.getSettingsAsync(budgetId)).ledger_currency, 'PLN');
    await update({ future_periods: 9 });
    assert.equal((await service.getSettingsAsync(budgetId)).future_periods, 9);
    assert.deepEqual(await run(({ writer }) => writer.listPlanningRows(budgetId, 'ledger_currency_events')), []);
    await update({ ledger_currency: 'EUR', manual_fx_rates: { 'PLN/EUR': 0.25 } });
    assert.equal((await service.getSettingsAsync(budgetId)).ledger_currency, 'EUR');
    const events = await run(({ writer }) => readFinancialBootstrapPart({ writer, budgetId }, 'currency-events'));
    assert.equal(events.length, 1);
    const details = typeof events[0].details === 'string' ? JSON.parse(events[0].details) : events[0].details;
    assert.equal(details.acceptanceOrder.afterSequence, history === 'partial' ? 1 : 0);
    assert.deepEqual(details.acceptanceOrder.paymentIds, beforePayments.map(row => row.id).sort());
    assert.deepEqual(details.acceptanceOrder.previousEventIds, []);
    assert.equal(Number(events[0].old_balance), total);
    assert.equal(Number(events[0].converted_opening_balance), total * 0.25);
    const pending = await f.budget.listPlanningRows(budgetId, 'pending_transactions');
    assert.equal(pending.length, 1);
    assert.equal(Number(pending[0].amount), total * 0.25);
    assert.deepEqual(JSON.parse(pending[0].note).acceptanceOrder, details.acceptanceOrder);
    assert.deepEqual(await f.budget.listConfirmedTransactions(budgetId), beforePayments);
    assert.deepEqual(await auditRows(), beforeAudit);
    // Historical currency events predate acceptanceOrder too. Bootstrap and
    // ordinary settings saves must accept their absence without a journal rebase.
    delete details.acceptanceOrder;
    await run(({ writer }) => writer.updatePlanningRowsById(budgetId, 'ledger_currency_events', [
      { id: events[0].id, details: JSON.stringify(details) }
    ]));
    const legacyEvents = await run(({ writer }) => readFinancialBootstrapPart({ writer, budgetId }, 'currency-events'));
    const legacyDetails = typeof legacyEvents[0].details === 'string' ? JSON.parse(legacyEvents[0].details) : legacyEvents[0].details;
    assert.equal(legacyDetails.acceptanceOrder, undefined);
    assert.equal(legacyEvents[0].orderResolution, undefined);
    await update({ future_periods: 10 });
    assert.equal((await service.getSettingsAsync(budgetId)).future_periods, 10);
    assert.deepEqual(await auditRows(), beforeAudit);
    // Missing originals remain an explicit audit gap, never silently repaired
    // or treated as complete proof by a currency settings update.
    if (history === 'partial') await assert.rejects(run(({ writer }) => writer.exportLedgerAuditSnapshot(budgetId)),
      /Accepted payment has no retained original evidence/);
    if (history === 'incomplete') await assert.rejects(run(({ writer }) => writer.exportLedgerAuditSnapshot(budgetId)),
      /Complete legacy baseline required/);
  } finally { setTodayOverrideForTests(previous); }
}

for (const history of ['absent', 'partial', 'incomplete']) {
  test(`SQLite direct settings accept pre-H8 ${history} audit history`, () =>
    withStandaloneTransferPublisherFixture(f => exercise(f, history, true)));
  test(`SQLite store settings accept pre-H8 ${history} audit history`, () =>
    withStandaloneTransferPublisherFixture(f => exercise(f, history)));
  test(`PostgreSQL settings accept pre-H8 ${history} audit history`, {
    skip: postgresRuntimeTestsEnabled() ? false : 'owner runs disposable PostgreSQL'
  }, () => withDisposablePostgresDb(({ databaseUrl }) =>
    withStandaloneTransferPublisherFixture(f => exercise(f, history), databaseUrl)));
}
