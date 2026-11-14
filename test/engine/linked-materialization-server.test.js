import test from 'node:test';
import assert from 'node:assert/strict';
import { withStandaloneTransferPublisherFixture } from '../helpers/standalone-transfer-publisher-fixture.js';
import { BOOTSTRAP_PARTS, readFinancialBootstrapPart } from '../../src/server/cashflow-app-bootstrap-records.js';
import { createLedgerCorrectionService } from '../../src/server/cashflow-ledger-correction-service.js';
import { ledgerConversionRecords } from '../../src/engine/ledger-currency-change.js';
import { materializeLinkedStandalone, materializeLinkedStandaloneJson } from '../../src/engine/linked-materialization.js';
import { refreshLocalSnapshot } from '../../src/engine/local-confirmation.js';
import { prepareLinkedLedgerAuditHashes } from '../../src/engine/linked-ledger-audit.js';
import { createCashflowFxCacheService } from '../../src/server/cashflow-fx-cache-service.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { standaloneLedgerOrigin, replayStandaloneLedgerOrigin } from '../../src/engine/standalone-ledger-origin.js';
import { validateLocalPlanning } from '../../src/engine/local-validation.js';
import { auditSha256 } from '../../src/engine/audit-sha256.js';
const budgetId = 'transfer-existing';
const timing = { today: '2026-10-28', generationTimestamp: '2026-10-28T12:00:00.000Z', idSeed: 'server-keep' };
/** Real writer/correction capture and bootstrap readers, without an HTTP listener.
 * Unlike origin fixtures this is a native server audit with database defaults,
 * nullable columns, deleted sources, partial FX, correction and pending conversion. */
async function exercise(f) {
  const transaction = f.budget.backend === 'postgres' ? work => f.budget.transaction(work) : work => f.budget.planningTransaction(budgetId, work);
  const parts = await transaction(async (writer, connection) => {
    const query = async (sql, args = []) => {
      if (f.budget.backend === 'postgres') { let i = 0; return (await connection.query(sql.replace(/\?/g, () => `$${++i}`), args)).rows; }
      const s = connection.prepare(sql); return s.reader ? s.all(...args) : (s.run(...args), []);
    };
    const service = createLedgerCorrectionService({ budgetId, writer, query });
    await service.audit.ensureLegacyBaseline({ capturedAt: timing.generationTimestamp });
    for (const [id, type, amount, currency, rate, balance] of [['income', 'income', 500, 'PLN', 1, 500], ['foreign', 'expense', 10, 'EUR', 4, 460]]) {
      await writer.insertPlanningRows(budgetId, 'one_off_transactions', [{ id, name: id, type, amount: id === 'foreign' ? 20 : amount, currency, date: timing.today, created_at: timing.generationTimestamp, updated_at: timing.generationTimestamp }]);
      await writer.insertConfirmedTransactions(budgetId, [{ id: 'payment-' + id, name: id, type, amount, currency, date: timing.today,
        confirmed_date: timing.today, ledger_year: 2026, ledger_currency: 'PLN', fx_rate: rate, buffered_fx_rate: rate,
        ledger_amount: amount * rate, running_balance_pln: balance, source_one_off_id: id, occurrence_key: 'one_off:' + id,
        created_at: id === 'income' ? '2026-10-28T11:00:00.000Z' : '2026-10-28T11:01:00.000Z', updated_at: timing.generationTimestamp }]);
      await service.capturePayment({ paymentId: 'payment-' + id, actorId: 'transfer-owner', capturedAt: timing.generationTimestamp });
    }
    const corrected = await service.correct({ id: 'correct-foreign', targetId: 'payment-foreign', expectedCorrectionId: null,
      replacement: { amount: 8, date: timing.today, fx_rate: 4 }, reason: 'Reviewed partial', actorId: 'transfer-owner',
      createdAt: timing.generationTimestamp, today: timing.today });
    assert.equal(corrected.event.status, 'accepted', corrected.event.failureCode);
    await writer.deletePlanningRowsById(budgetId, 'one_off_transactions', ['foreign']);
    const conversion = ledgerConversionRecords({ oldCurrency: 'PLN', newCurrency: 'EUR', oldBalance: 468,
      convertedOpeningBalance: 117, rate: 0.25, rateDate: timing.today, source: 'manual' },
      { eventId: 'currency-event', pendingId: 'conversion', timestamp: timing.generationTimestamp });
    await writer.insertPlanningRows(budgetId, 'ledger_currency_events', [conversion.event]);
    await writer.insertPlanningRows(budgetId, 'pending_transactions', [conversion.pending]);
    await writer.updatePlanningRowsById(budgetId, 'settings', [{ id: 1, ledger_currency: 'EUR', fx_provider: 'manual', manual_fx_rates: '{"PLN/EUR":0.25}' }]);
    const result = {};
    for (const part of BOOTSTRAP_PARTS) result[part] = await readFinancialBootstrapPart({ writer, budgetId }, part,
      { fxSnapshot: () => createCashflowFxCacheService({ normalizeCurrency: value => value.toUpperCase() }).getCachedFxSnapshotAsync(budgetId, timing.today, writer) });
    return JSON.parse(JSON.stringify(result));
  });
  const command = { version: 1, budgetId, identity: 'local-server-keep', name: 'Server KEEP', epoch: 'epoch', revision: 8, parts, ...timing,
    intentions: [{ operationId: 'retained-review', state: 'queued', kind: 'ledger.correct', payload: {
      targetId: 'payment-foreign', expectedCorrectionId: null, replacement: null, reason: 'Retained for local review', retryOf: null } }] };
  command.auditHashes = prepareLinkedLedgerAuditHashes(command).texts.map(text => [text, auditSha256(text)]);
  const invalid = structuredClone(command);
  invalid.parts['fx-snapshot'][0].snapshot['pln/eur'].source = 'private-marker';
  const rejected = JSON.parse(materializeLinkedStandaloneJson(JSON.stringify(invalid)));
  assert.deepEqual(rejected.error, { code: 'LINKED_MATERIALIZATION_REJECTED', message: 'Linked materialization rejected',
    reason: 'FX_SOURCE_UNSUPPORTED', recordKind: 'fx-snapshot', check: 'REBUILD_JOURNAL' });
  assert.ok(!JSON.stringify(rejected).includes('private-marker'));
  const alteredAudit = structuredClone(command);
  alteredAudit.parts['ledger-audit'].find(record => record.kind === 'correction').value.status = 'blocked';
  const auditError = JSON.parse(materializeLinkedStandaloneJson(JSON.stringify(alteredAudit))).error;
  assert.equal(auditError.reason, 'CORRECTION_RESULT_DIFFERS_FROM_FINANCIAL_REPLAY');
  assert.equal(auditError.recordKind, 'audit-correction');
  assert.equal(auditError.check, 'VERIFY_AUDIT_RECORD');
  const alteredConversion = structuredClone(command);
  alteredConversion.parts['currency-events'][0].converted_opening_balance = 999;
  const currencyError = JSON.parse(materializeLinkedStandaloneJson(JSON.stringify(alteredConversion))).error;
  assert.equal(currencyError.reason, 'ALTERED_CONVERSION_AMOUNT');
  assert.equal(currencyError.recordKind, 'ledger_currency_events');
  for (const jsonb of [false, true]) {
    const input = structuredClone(command);
    if (jsonb) input.parts['currency-events'].forEach(row => { if (typeof row.details === 'string') row.details = JSON.parse(row.details); });
    const envelope = JSON.parse(materializeLinkedStandaloneJson(JSON.stringify(input)));
    assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
    const copy = materializeLinkedStandalone(input);
    assert.equal(copy.localHistory.length, 2);
    assert.equal(copy.localIntentions[0].reason, 'EXPLICIT_REVIEW_REQUIRED');
    assert.equal(copy.localIntentions[0].reviewRequired, true);
    assert.equal(copy.request.fxSnapshot['eur/eur'], undefined);
    const oldOutput = structuredClone(copy.request);
    oldOutput.fxSnapshot['eur/eur'] = { rate: 1, effectiveDate: timing.today, source: 'same-currency' };
    assert.throws(() => validateLocalPlanning(oldOutput, { requireRates: false }), error =>
      error.reason === 'FX_IDENTITY_PAIR_NOT_FOREIGN' && error.recordKind === 'fx-snapshot');
    assert.equal(copy.request.fxSnapshot['pln/eur'].rate, 0.25);
    assert.equal(typeof input.parts['currency-events'][0].rate_date, 'string');
    const origin = standaloneLedgerOrigin(copy, timing.generationTimestamp);
    assert.equal(replayStandaloneLedgerOrigin({ origin, budgetId: 'uploaded-native', utf8ByteLength: text => Buffer.byteLength(text) }).rows.length, 2);
    assert.equal(copy.request.openingBalance, 0);
    assert.equal(copy.request.tables.pending_transactions.length, 1);
    assert.equal(refreshLocalSnapshot({ snapshot: copy, ...timing }).request.openingBalance, 0);
  }
}
test('native server partial FX/correction/conversion bootstrap survives KEEP on SQLite and JSONB-shaped wire', () => withStandaloneTransferPublisherFixture(exercise));

test('PostgreSQL native server KEEP bootstrap retains JSONB and DATE driver shapes', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable PostgreSQL tests'
}, () => withDisposablePostgresDb(({ databaseUrl }) => withStandaloneTransferPublisherFixture(exercise, databaseUrl)));
