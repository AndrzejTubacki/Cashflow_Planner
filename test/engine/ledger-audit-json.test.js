import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalAuditValue } from '../../src/engine/ledger-audit-json.js';
import { createLedgerAuditReplay } from '../../src/engine/ledger-audit-replay.js';

test('audit JSON copies plain financial evidence deterministically without mutating it', () => {
  const input = { z: [{ currency: 'PLN', amount: 12.34 }], a: 'Zażółć 🪙' };
  const before = structuredClone(input);
  const copied = canonicalAuditValue(input);
  assert.deepEqual(input, before);
  assert.deepEqual(copied, input);
  assert.equal(JSON.stringify(copied), '{"a":"Zażółć 🪙","z":[{"amount":12.34,"currency":"PLN"}]}');
  copied.z[0].amount = 99;
  assert.equal(input.z[0].amount, 12.34);
});

test('audit JSON refuses values and sparse arrays that JSON would silently drop or rewrite', () => {
  for (const input of [undefined, NaN, Infinity, 1n, () => {}, new Date(), new Map(),
    { missing: undefined }, [, 1], { values: [1, , 2] }, Object.assign([1], { lost: 2 }), { [Symbol('lost')]: 1 }]) {
    assert.throws(() => canonicalAuditValue(input), /Unsupported ledger audit value/);
  }
});

test('portable audit replay needs trusted host hashing and UTF-8 primitives', () => {
  for (const host of [{}, { digestText: () => '' }, { utf8ByteLength: () => 0 }]) {
    assert.throws(() => createLedgerAuditReplay(host), /Trusted audit hashing/);
  }
});
