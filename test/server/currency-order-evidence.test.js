import { normalizeLedgerAuditFact } from '../../src/engine/ledger-audit-fact.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withStandaloneTransferPublisherFixture } from '../helpers/standalone-transfer-publisher-fixture.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createFinancialJournal } from '../../src/server/cashflow-financial-journal.js';
import { hostPlanningStore } from '../../src/server/cashflow-financial-operation-service.js';
import { createCashflowSettingsService } from '../../src/server/cashflow-settings-service.js';
import { createLedgerCorrectionService } from '../../src/server/cashflow-ledger-correction-service.js';
import { setTodayOverrideForTests } from '../../src/server/cashflow-date-utils.js';
import { BOOTSTRAP_PARTS, readFinancialBootstrapPart } from '../../src/server/cashflow-app-bootstrap-records.js';
import { prepareLinkedLedgerAuditHashes } from '../../src/engine/linked-ledger-audit.js';
import { materializeLinkedStandalone } from '../../src/engine/linked-materialization.js';
import { reviewLocalCorrection, applyReviewedLocalCorrection } from '../../src/engine/local-correction-review.js';
import { refreshLocalSnapshot } from '../../src/engine/local-confirmation.js';
import { auditSha256 } from '../../src/engine/audit-sha256.js';
const budgetId = 'transfer-existing';
const timing = { today: '2026-10-28', generationTimestamp: '2026-10-28T12:00:00.000Z', idSeed: 'receipt-rebase' };
/** The native writer and real journal share an owning transaction. Test the
 * receipt/feed transport and explicit old-history rebase without an HTTP host. */
async function exercise(f) {
  const previous = setTodayOverrideForTests(timing.today);
  const run = work => {
    const transaction = f.budget.backend === 'postgres' ? callback => f.budget.transaction(callback) : callback => f.budget.planningTransaction(budgetId, callback);
    return transaction(async (writer, connection) => {
      if (f.budget.backend === 'postgres') await writer.lockBudgetLedger(budgetId);
      const query = async (sql, args = []) => {
        if (f.budget.backend === 'postgres') { let n = 0; return (await connection.query(sql.replace(/\?/g, () => `$${++n}`), args)).rows; }
        const statement = connection.prepare(sql); return statement.reader ? statement.all(...args) : (statement.run(...args), []);
      };
      const journal = createFinancialJournal({ query, authorize: async () => {}, mutate: async operation => {
        if (operation.kind === 'occurrence.confirm') {
          const audit = createLedgerCorrectionService({ budgetId, writer, query });
          await audit.audit.ensureLegacyBaseline({ capturedAt: timing.generationTimestamp });
          await writer.insertConfirmedTransactions(budgetId, [{ id: 'native-income', name: 'Native income', currency: 'PLN', ledger_currency: 'PLN',
            type: 'income', amount: 500, ledger_amount: 500, fx_rate: 1, buffered_fx_rate: 1, running_balance_pln: 500,
            date: timing.today, confirmed_date: timing.today, ledger_year: 2026, occurrence_key: operation.payload.occurrenceKey,
            created_at: timing.generationTimestamp, updated_at: timing.generationTimestamp }]);
          await audit.capturePayment({ paymentId: 'native-income', actorId: 'transfer-owner', capturedAt: timing.generationTimestamp });
          return { confirmedTransaction: normalizeLedgerAuditFact((await writer.exportLedgerAuditSnapshot(budgetId)).originals[0].row, budgetId) };
        }
        const service = createCashflowSettingsService({ budgetStore: hostPlanningStore(writer), getCachedFxRateAsync: async () => 0.25 });
        await service.updateSettings(budgetId, operation.payload);
        return { pendingConversion: (await writer.listPlanningRows(budgetId, 'pending_transactions')).find(row => row.occurrence_key.startsWith('ledger_currency_conversion:')) };
      } });
      return work({ writer, query, journal });
    });
  };
  try {
    // Pin fixture initialization before the settings UPDATE: PostgreSQL cannot
    // update a singleton that was never inserted by budget creation.
    const initialSettings = await run(({ writer }) => writer.listPlanningRows(budgetId, 'settings'));
    assert.equal(initialSettings.length, 1);
    assert.equal(Number(initialSettings[0].id), 1);
    const projectionFields = ['future_periods', 'minimum_reserve_enabled', 'minimum_reserve_amount', 'fx_buffer_percent'];
    for (const field of projectionFields) assert.notEqual(initialSettings[0][field], undefined, field);
    const head = await run(({ journal }) => journal.bootstrap(budgetId));
    const scope = { version: 1, budgetId, epoch: head.epoch };
    await run(({ journal }) => journal.apply({ ...scope, operationId: randomUUID(), baseRevision: 0, kind: 'occurrence.confirm',
      payload: { occurrenceKey: 'manual:native-income', amount: 500, confirmedDate: timing.today, fxRate: null } }));
    const receipt = await run(({ journal }) => journal.apply({ ...scope, operationId: randomUUID(), baseRevision: 1, kind: 'settings.update', payload: { ledger_currency: 'EUR', manual_fx_rates: { 'PLN/EUR': 0.25 } } }));
    const order = JSON.parse(receipt.pendingConversion.note).acceptanceOrder;
    assert.deepEqual(order.paymentIds, ['native-income']); assert.equal(order.afterSequence, 1);
    assert.equal(order.conversionId, receipt.pendingConversion.id);
    const changes = await run(({ journal }) => journal.changes({ budgetId, epoch: head.epoch, afterRevision: 0, limit: 10 }));
    assert.deepEqual(JSON.parse(changes.changes[1].pendingConversion.note).acceptanceOrder, order);
    assert.deepEqual(await run(({ journal }) => journal.lookup({ budgetId, epoch: head.epoch, operationId: receipt.operationId })), receipt);
    // Model a pre-H8 settings event. Keep every original event field; only its
    // then-unwritten ordering field is absent. Accepted receipts still exist.
    await run(async ({ writer }) => {
      const event = (await writer.listPlanningRows(budgetId, 'ledger_currency_events'))[0];
      const details = typeof event.details === 'string' ? JSON.parse(event.details) : event.details;
      delete details.acceptanceOrder;
      await writer.updatePlanningRowsById(budgetId, 'ledger_currency_events', [{ id: event.id, details: JSON.stringify(details) }]);
    });
    const parts = await run(async ({ writer }) => {
      const parts = {};
      for (const part of BOOTSTRAP_PARTS) parts[part] = await readFinancialBootstrapPart({ writer, budgetId }, part);
      return JSON.parse(JSON.stringify(parts));
    });
    assert.equal(parts.settings.length, 1);
    assert.equal(parts.settings[0].ledger_currency, 'EUR');
    for (const field of projectionFields) assert.equal(parts.settings[0][field], initialSettings[0][field], field);
    assert.equal(parts['currency-events'][0].orderResolution.headRevision, 2);
    assert.equal(parts['currency-events'][0].orderResolution.records[1].result.pendingConversion.id, order.conversionId);
    const input = { version: 1, identity: 'local-receipt-h8', name: 'Reviewed old KEEP', budgetId, epoch: head.epoch, revision: 2, parts, ...timing };
    input.auditHashes = prepareLinkedLedgerAuditHashes(input).texts.map(text => [text, auditSha256(text)]);
    const copy = materializeLinkedStandalone(input);
    const command = { snapshot: copy, ...timing, confirmationId: 'native-income', expectedCorrectionId: null,
      reason: 'Review original server acceptance', replacement: { amount: 400, date: timing.today } };
    const review = reviewLocalCorrection(command);
    assert.equal(review.status, 'accepted', review.failureCode);
    assert.equal(review.orderingResolution.basis, 'accepted-journal-receipts');
    assert.deepEqual(review.orderingResolution.switches[0].resolution.proof, parts['currency-events'][0].orderResolution);
    const revised = applyReviewedLocalCorrection({ ...command, review });
    assert.deepEqual(revised.localAudit[0], copy.localAudit[0]);
    assert.deepEqual(refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(revised)), ...timing }).localHistory, revised.localHistory);
    assert.equal(revised.request.tables.pending_transactions[0].amount, 100);
  } finally { setTodayOverrideForTests(previous); }
}
test('SQLite currency ordering survives receipt/feed/bootstrap and explicitly rebases a legacy KEEP', () => withStandaloneTransferPublisherFixture(exercise));
test('PostgreSQL currency ordering survives receipt/feed/bootstrap and explicitly rebases a legacy KEEP', {
  skip: postgresRuntimeTestsEnabled() ? false : 'owner runs disposable PostgreSQL'
}, () => withDisposablePostgresDb(({ databaseUrl }) => withStandaloneTransferPublisherFixture(exercise, databaseUrl)));
