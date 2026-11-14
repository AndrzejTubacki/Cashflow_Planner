import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { currencyTransferFixture, currencyTiming } from '../helpers/currency-transfer-fixture.js';
import { withStandaloneTransferPublisherFixture } from '../helpers/standalone-transfer-publisher-fixture.js';
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from '../helpers/postgres-test-db.js';
import { createStandaloneTransferHttpHost } from '../../src/server/cashflow-standalone-transfer-http.js';
import { appSyncCapabilities } from '../../src/server/cashflow-app-sync-contract.js';
import { setTodayOverrideForTests } from '../../src/server/cashflow-date-utils.js';
import { BOOTSTRAP_PARTS, readFinancialBootstrapPart } from '../../src/server/cashflow-app-bootstrap-records.js';
import { createCashflowFxCacheService } from '../../src/server/cashflow-fx-cache-service.js';
import { prepareLinkedLedgerAuditHashes } from '../../src/engine/linked-ledger-audit.js';
import { prepareLinkedSnapshot } from '../../src/engine/linked-snapshot.js';
const upgraded = { allowStandaloneOrigins: true };
/** Real HTTP host methods and full publisher without binding a listening socket.
 * Verify persisted native bootstrap parts and replay after lost acknowledgements. */
async function exercise(f) {
  const previous = setTodayOverrideForTests(currencyTiming.today);
  try {
    const { protocolVersion, financialModelVersion, stateVersion, engineProtocolVersion, engineVersion } = appSyncCapabilities();
    const compatibility = { protocolVersion, financialModelVersion, stateVersion, engineProtocolVersion, engineVersion };
    const host = createStandaloneTransferHttpHost({ publisher: f.publisher(), now: () => Date.parse(currencyTiming.generationTimestamp),
      fetchRate: () => { throw new Error('Manual rate must not be fetched'); } });
    const probe = f.lookup(f.input());
    assert.deepEqual(await host.formats(f.tokens.accessToken, probe), { ...probe, sourceVersions: [1, 2, 3] });
    const noCreate = await f.enroll(false);
    await assert.rejects(host.formats(noCreate.accessToken, probe));
    // Current transfer format and its old writer remain supported.
    const legacy = f.input();
    const { sourceJson, ...scope } = legacy;
    const legacyBody = { ...scope, source: JSON.parse(sourceJson), compatibility: { ...compatibility, engineVersion: '0.4.0-poc' } };
    assert.equal((await host.review(f.tokens.accessToken, legacyBody)).compatibility.engineVersion, '0.4.0-poc');
    assert.equal((await host.submit(f.tokens.accessToken, legacyBody)).state, 'accepted');
    for (const stage of ['pending', 'confirmed', 'voided', 'returned']) for (const reviewed of [false, true]) {
      const source = currencyTransferFixture(stage, reviewed);
      const { sourceJson: _source, ...scope } = f.input(source);
      const body = { ...scope, source, compatibility };
      await assert.rejects(host.review(f.tokens.accessToken, { ...body, compatibility: legacyBody.compatibility }), { code: 'COMPATIBILITY_REQUIRED' });
      const review = await host.review(f.tokens.accessToken, body);
      assert.equal(review.source.transferVersion, 2);
      assert.deepEqual(review.source.localAudit, source.localAudit);
      const frozen = { ...body, source: review.source };
      // Unknown acceptance is recovered with the same identity and frozen proof.
      const interrupted = createStandaloneTransferHttpHost({ publisher: f.publisher({ afterCommit: () => { throw new Error('Lost acknowledgement'); } }) });
      await assert.rejects(interrupted.submit(f.tokens.accessToken, frozen), /Lost acknowledgement/);
      const receipt = await host.submit(f.tokens.accessToken, frozen);
      assert.equal(receipt.state, 'accepted');
      assert.deepEqual((await host.result(f.tokens.accessToken, f.lookup(scope))).receipt, receipt);
      const budgetId = receipt.budgetId;
      const fx = createCashflowFxCacheService({ normalizeCurrency: value => value.toUpperCase() });
      const read = async writer => {
        const parts = {};
        for (const part of BOOTSTRAP_PARTS) parts[part] = await readFinancialBootstrapPart({ writer, budgetId, ...currencyTiming }, part,
          { ...upgraded, fxSnapshot: ({ writer, budgetId, today }) => fx.getCachedFxSnapshotAsync(budgetId, today, writer) });
        return JSON.parse(JSON.stringify(parts));
      };
      const parts = f.budget.backend === 'sqlite' ? await f.budget.planningTransaction(budgetId, read) : await f.budget.transaction(read);
      const command = { budgetId, epoch: '11111111-1111-4111-8111-111111111111', revision: 0, parts, ...currencyTiming };
      const hashes = prepareLinkedLedgerAuditHashes(command, upgraded).texts.map(text => [text, createHash('sha256').update(text).digest('hex')]);
      const linked = prepareLinkedSnapshot({ ...command, auditHashes: hashes }, upgraded);
      assert.equal(linked.request.openingBalance, source.request.openingBalance);
      assert.deepEqual(linked.linked.acceptedAudit.origin.events, source.localAudit);
      assert.equal(linked.request.tables.pending_transactions.filter(row => row.occurrence_key?.startsWith('ledger_currency_conversion:')).length, stage === 'pending' ? 1 : 0);
      if (stage === 'pending') {
        const conversion = linked.request.tables.pending_transactions.find(row => row.occurrence_key?.startsWith('ledger_currency_conversion:'));
        assert.equal(conversion.id, source.request.tables.pending_transactions[0].id);
        assert.equal(conversion.amount, source.request.tables.pending_transactions[0].amount);
      }
      assert.equal(parts['currency-events'].length, stage === 'returned' ? 2 : 1);
    }
  } finally { setTodayOverrideForTests(previous); }
}
test('SQLite versioned currency transfer negotiates, recovers and downloads verified native replay', () => withStandaloneTransferPublisherFixture(exercise));
test('PostgreSQL versioned currency transfer negotiates, recovers and downloads verified native replay', {
  skip: postgresRuntimeTestsEnabled() ? false : 'enable disposable Postgres tests'
}, () => withDisposablePostgresDb(({ databaseUrl }) => withStandaloneTransferPublisherFixture(exercise, databaseUrl)));
