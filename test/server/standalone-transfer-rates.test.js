import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareStandaloneTransferRates } from '../../src/server/cashflow-standalone-transfer-rates.js';
import { standaloneOriginAuditFixture } from '../helpers/standalone-origin-fixture.js';
import { calculateSnapshot } from '../../src/engine/snapshot.js';
import { createCashflowFxCacheService } from '../../src/server/cashflow-fx-cache-service.js';

const timing = { today: '2026-06-02', generationTimestamp: '2026-06-02T12:00:00.000Z', idSeed: 'rate-review' };
const reviewed = (source, fetchRate) => prepareStandaloneTransferRates({ sourceJson: JSON.stringify(source), fetchRate, ...timing });
function fixture(provider = 'nbp', date = '2026-05-01') {
  const snapshot = standaloneOriginAuditFixture({ currency: 'EUR', amount: 50 }).snapshot;
  Object.assign(snapshot.request.fxSnapshot['eur/pln'], { source: provider, effectiveDate: date });
  return snapshot;
}

test('transfer review preserves old manual observations and all confirmed FX without provider requests', async () => {
  const source = fixture('manual', '2020-01-01');
  source.request.fxSnapshot['eur/pln'].fetchedAt = '2020-01-01T12:00:00.000Z';
  const before = JSON.stringify(source);
  const result = await reviewed(source, () => { throw new Error('Manual rates must not be fetched'); });
  const after = JSON.parse(result.sourceJson);
  assert.deepEqual(result.refreshed, []);
  for (const key of ['localHistory', 'localAudit', 'revision', 'localOpeningBalance']) assert.deepEqual(after[key], source[key]);
  assert.deepEqual(after.request.fxSnapshot, source.request.fxSnapshot);
  assert.equal(JSON.stringify(source), before);
});

test('transfer review refreshes only provider planning observations and exposes changed future costs', async () => {
  for (const provider of ['nbp', 'frankfurter']) {
    const source = fixture(provider);
    source.request.settings.fx_buffer_percent = 0;
    source.request.fxSnapshot['eur/pln'].fetchedAt = '2026-05-01T12:00:00.000Z';
    source.request.tables.one_off_transactions.push({ id: 'future', type: 'expense', name: 'Future foreign bill',
      amount: 10, currency: 'EUR', date: '2026-06-10' });
    source.request.fxSnapshot['usd/pln'] = { rate: 3.5, source: 'manual', effectiveDate: '2020-01-01' };
    const before = JSON.stringify(source);
    const calls = [];
    const result = await reviewed(source, async input => {
      calls.push(input);
      return { rate: 5, source: provider, effectiveDate: '2026-06-01' };
    });
    assert.deepEqual(calls, [{ provider, baseCurrency: 'EUR', quoteCurrency: 'PLN' }]);
    const after = JSON.parse(result.sourceJson);
    for (const key of ['localHistory', 'localAudit', 'revision', 'localOpeningBalance']) assert.deepEqual(after[key], source[key]);
    assert.equal(after.localHistory[0].fx_rate, 4.2);
    assert.equal(after.request.openingBalance, 290);
    assert.equal(after.request.fxSnapshot['eur/pln'].rate, 5);
    assert.equal(after.request.fxSnapshot['eur/pln'].fetchedAt, timing.generationTimestamp);
    assert.deepEqual(after.request.fxSnapshot['usd/pln'], source.request.fxSnapshot['usd/pln']);
    assert.equal(result.refreshed[0].before.rate, 4.2);
    assert.equal(result.refreshed[0].after.rate, 5);
    const futureCost = snapshot => calculateSnapshot(snapshot).plan.futureRows.find(row => row.source_one_off_id === 'future').ledger_amount;
    assert.equal(futureCost(source), 42);
    assert.equal(futureCost(after), 50);
    assert.equal(JSON.stringify(source), before);
  }
});

test('transfer review refreshes a recent provider rate once per pair', async () => {
  const source = fixture('nbp', '2026-06-02');
  let calls = 0;
  const result = await reviewed(source, async () => { calls++; return { rate: 4.5, source: 'nbp', effectiveDate: '2026-06-02' }; });
  const rates = JSON.parse(result.sourceJson).request.fxSnapshot;
  assert.equal(calls, 1);
  assert.equal(rates['eur/pln'].rate, 4.5);
});

test('transfer review rejects unknown or conflicting rate provenance before any provider request', async () => {
  for (const source of [fixture('unknown'), fixture('nbp')]) {
    if (source.request.fxSnapshot['eur/pln'].source === 'nbp') source.request.fxSnapshot.eur = { rate: 4.2, source: 'manual' };
    await assert.rejects(reviewed(source, () => { assert.fail('Invalid provenance must be refused before fetching'); }), /source|aliases|exchange rates/);
  }
});

test('transfer review rejects failed, stale, future or wrong-pair provider responses without changing the source', async () => {
  const source = fixture();
  const before = JSON.stringify(source);
  for (const bad of [{ rate: 0 }, { rate: Infinity }, { rate: '5' }, { source: 'manual' },
    { effectiveDate: '2026-05-01' }, { effectiveDate: '2026-06-03' }, { effectiveDate: '2026-02-30' },
    { baseCurrency: 'USD' }, { quoteCurrency: 'EUR' }]) {
    await assert.rejects(reviewed(source, async () => ({ rate: 5, source: 'nbp', effectiveDate: '2026-06-01', ...bad })), /unusable/);
    assert.equal(JSON.stringify(source), before);
  }
  source.request.fxSnapshot['usd/pln'] = { rate: 3.5, source: 'nbp', effectiveDate: '2026-05-01' };
  const original = JSON.stringify(source);
  let calls = 0;
  await assert.rejects(reviewed(source, async () => {
    if (++calls === 2) throw new Error('synthetic private provider details');
    return { rate: 5, source: 'nbp', effectiveDate: '2026-06-01' };
  }), error => error.code === 'TRANSFER_RATE_REFRESH_FAILED' && !error.message.includes('private'));
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(source), original);
});

test('transfer refresh can use the existing provider adapter with currency-only synthetic HTTP requests', async () => {
  const urls = [];
  const fx = createCashflowFxCacheService({ normalizeCurrency: value => String(value).toUpperCase(),
    fetchImpl: async url => {
      urls.push(String(url));
      return { ok: true, json: async () => ({ base: 'EUR', date: '2026-06-01', rates: { PLN: 5 } }) };
    } });
  const source = fixture('frankfurter');
  const result = await reviewed(source, ({ provider, baseCurrency, quoteCurrency }) =>
    fx.fetchProviderRate(provider, baseCurrency, null, quoteCurrency));
  assert.deepEqual(urls, ['https://api.frankfurter.app/latest?from=EUR&to=PLN']);
  assert.equal(JSON.parse(result.sourceJson).request.fxSnapshot['eur/pln'].rate, 5);
});
