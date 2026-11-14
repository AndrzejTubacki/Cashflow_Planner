import { prepareLinkedLedgerAuditHashes } from '../../src/engine/linked-ledger-audit.js';
import { auditSha256 } from '../../src/engine/audit-sha256.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withStandaloneTransferPublisherFixture } from '../helpers/standalone-transfer-publisher-fixture.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createLedgerCorrectionService } from '../../src/server/cashflow-ledger-correction-service.js';
import { createCashflowSettingsService } from '../../src/server/cashflow-settings-service.js';
import { setTodayOverrideForTests } from '../../src/server/cashflow-date-utils.js';
import { BOOTSTRAP_PARTS, readFinancialBootstrapPart } from '../../src/server/cashflow-app-bootstrap-records.js';
import { materializeLinkedStandalone } from '../../src/engine/linked-materialization.js';
import { reviewLocalCorrection, applyReviewedLocalCorrection } from '../../src/engine/local-correction-review.js';
import { confirmLocalOccurrence, refreshLocalSnapshot } from '../../src/engine/local-confirmation.js';
import { standaloneLedgerOrigin, replayStandaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
const timing = { today: '2026-10-28', generationTimestamp: '2026-10-28T12:00:00.000Z', idSeed: 'h8' };
const budgetId = 'transfer-existing';
/** Real isolated writers, native settings switches, audit capture and bootstrap;
 * no application listener or external database is opened by SQLite tests. */
async function exercise(f, stage) {
  const previous = setTodayOverrideForTests(timing.today);
  const tx = work => f.budget.backend === 'postgres' ? f.budget.transaction(work) : f.budget.planningTransaction(budgetId, work);
  const audited = work => tx(async (writer, connection) => {
    const query = async (sql, args = []) => {
      if (f.budget.backend === 'postgres') { let n = 0; return (await connection.query(sql.replace(/\?/g, () => `$${++n}`), args)).rows; }
      const statement = connection.prepare(sql); return statement.reader ? statement.all(...args) : (statement.run(...args), []);
    };
    const service = createLedgerCorrectionService({ budgetId, writer, query, allowStandaloneOrigins: true });
    await service.audit.ensureLegacyBaseline({ capturedAt: timing.generationTimestamp });
    return work(writer, service, query);
  });
  async function payment(id, currency, type, amount, occurrenceKey = `one_off:${id}:${type}:${timing.today}`) {
    await audited(async (writer, service) => {
      const source = occurrenceKey.startsWith('one_off:') ? id : null;
      if (source) await writer.insertPlanningRows(budgetId, 'one_off_transactions', [{ id, name: id, currency, type, amount, date: timing.today, created_at: timing.generationTimestamp, updated_at: timing.generationTimestamp }]);
      await writer.insertConfirmedTransactions(budgetId, [{ id: 'paid-' + id, name: id, currency, ledger_currency: currency,
        amount, type, fx_rate: 1, buffered_fx_rate: 1, ledger_amount: amount, date: timing.today, confirmed_date: timing.today,
        ledger_year: 2026, occurrence_key: occurrenceKey, source_one_off_id: source,
        running_balance_pln: amount, created_at: timing.generationTimestamp, updated_at: timing.generationTimestamp }]);
      await service.capturePayment({ paymentId: 'paid-' + id, actorId: 'transfer-owner', capturedAt: timing.generationTimestamp });
    });
  }
  try {
    await payment('income', 'PLN', 'income', 500);
    if (stage === 'untracked') await audited(async (_writer, _service, query) => {
      await query('DELETE FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]);
    });
    const settings = createCashflowSettingsService({ budgetStore: f.budget.backend === 'postgres' ? f.budget : null,
      openPlanningDb: f.db.openPlanningDb, latestConfirmedBalance: () => 500,
      getCachedFxRate: () => 0.25, getCachedFxRateAsync: async () => 0.25 });
    await settings.updateSettings(budgetId, { ledger_currency: 'EUR', fx_provider: 'manual', manual_fx_rates: '{"PLN/EUR":0.25}' });
    let events = await tx(writer => writer.listPlanningRows(budgetId, 'ledger_currency_events'));
    const order = JSON.parse(typeof events[0].details === 'string' ? events[0].details : JSON.stringify(events[0].details)).acceptanceOrder;
    assert.deepEqual(order.paymentIds, ['paid-income']);
    assert.equal(order.eventId, events[0].id); assert.equal(order.afterSequence, stage === 'untracked' ? 0 : 1);
    assert.deepEqual(order.previousEventIds, []);
    if (!['pending', 'untracked'].includes(stage)) {
      const pending = (await tx(writer => writer.listPlanningRows(budgetId, 'pending_transactions'))).find(row => row.id === order.conversionId);
      await payment('conversion', 'EUR', 'income', 125, pending.occurrence_key);
      await tx(writer => writer.deletePlanningRowsById(budgetId, 'pending_transactions', [pending.id]));
      if (stage === 'voided') await audited(async (_writer, service) => {
        assert.equal((await service.correct({ id: 'void-conversion', targetId: 'paid-conversion', expectedCorrectionId: null,
          replacement: null, reason: 'Void conversion', actorId: 'transfer-owner', createdAt: timing.generationTimestamp, today: timing.today })).event.status, 'accepted');
      });
      if (stage === 'funding') await payment('spend', 'EUR', 'expense', 120);
    }
    if (stage === 'untracked') await audited(async () => {});
    const parts = await tx(async writer => {
      const result = {};
      for (const part of BOOTSTRAP_PARTS) result[part] = await readFinancialBootstrapPart({ writer, budgetId }, part);
      return JSON.parse(JSON.stringify(result));
    });
    assert.deepEqual(JSON.parse(typeof parts['currency-events'][0].details === 'string' ? parts['currency-events'][0].details : JSON.stringify(parts['currency-events'][0].details)).acceptanceOrder, order);
    const materialization = { version: 1, identity: 'local-native-h8', name: 'Native KEEP', budgetId,
      epoch: 'epoch', revision: 1, parts, ...timing };
    materialization.auditHashes = prepareLinkedLedgerAuditHashes(materialization).texts.map(text => [text, auditSha256(text)]);
    const copy = materializeLinkedStandalone(materialization);
    const command = { snapshot: copy, ...timing, confirmationId: 'paid-income', expectedCorrectionId: null,
      reason: 'Review income before switch', replacement: { amount: 400, date: timing.today } };
    const review = reviewLocalCorrection(command);
    assert.equal(review.status, stage === 'funding' ? 'blocked' : 'accepted', review.failureCode);
    assert.equal(review.changes.length, 1); assert.equal(review.changes[0].after.event.converted_opening_balance, 100);
    assert.equal(review.changes[0].outcome, ['pending', 'untracked'].includes(stage) ? 'pending' : stage === 'voided' ? 'voided' : 'confirmed');
    if (stage === 'funding') assert.equal(review.failureCode, 'history_overdraft');
    const revised = applyReviewedLocalCorrection({ ...command, review });
    assert.deepEqual(revised.localAudit[0], copy.localAudit[0]);
    const reopened = refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(revised)), ...timing });
    assert.deepEqual(reopened.localHistory, revised.localHistory);
    if (['pending', 'untracked'].includes(stage)) {
      const paid = confirmLocalOccurrence({ snapshot: reopened, ...timing, idSeed: 'native-conversion-paid',
        occurrenceKey: reopened.request.tables.pending_transactions[0].occurrence_key });
      assert.equal(paid.localHistory.find(row => row.id === 'confirmed-native-conversion-paid').amount, 100);
      assert.deepEqual(refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(paid)), ...timing }).localHistory, paid.localHistory);
    }
    const origin = standaloneLedgerOrigin(revised, timing.generationTimestamp);
    assert.equal(replayStandaloneLedgerOrigin({ origin, budgetId: 'uploaded-h8', utf8ByteLength: s => Buffer.byteLength(s) }).rows.length, revised.localHistory.length);
  } finally { setTodayOverrideForTests(previous); }
}
for (const stage of ['pending', 'confirmed', 'voided', 'funding', 'untracked']) {
  test(`SQLite native KEEP ${stage}: reviewed pre-switch correction, backup and re-upload replay`, () => withStandaloneTransferPublisherFixture(f => exercise(f, stage)));
  test(`PostgreSQL native KEEP ${stage}: reviewed pre-switch correction, backup and re-upload replay`, {
    skip: postgresRuntimeTestsEnabled() ? false : 'owner runs disposable PostgreSQL'
  }, () => withDisposablePostgresDb(({ databaseUrl }) => withStandaloneTransferPublisherFixture(f => exercise(f, stage), databaseUrl)));
}
