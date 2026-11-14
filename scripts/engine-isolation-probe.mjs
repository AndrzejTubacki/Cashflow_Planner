import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createHash } from 'node:crypto';
import { portableLedgerAuditFixture } from '../test/helpers/ledger-audit-fixtures.js';
import { standaloneOriginAuditFixture } from '../test/helpers/standalone-origin-fixture.js';
import { calculateProjection } from "../src/engine/index.js";
import { engineFixtures } from "../test/engine/fixtures.js";

// This is a dependency/ambient-global test, not Android or cross-engine verification.
const root = fileURLToPath(new URL("../src/engine/", import.meta.url));
const context = vm.createContext({});
vm.runInContext(`
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) throw new Error("Ambient clock access forbidden");
      super(...args);
    }
    static now() { throw new Error("Ambient clock access forbidden"); }
  };
  globalThis.Intl = undefined;
`, context);
const cache = new Map();

async function load(filename) {
  if (cache.has(filename)) return;
  assert.ok(filename.startsWith(root), "Engine dependencies must stay inside src/engine");
  const source = await readFile(filename, "utf8");
  assert.doesNotMatch(source, /\b(?:process|Buffer|fetch|require)\b/, filename);
  const module = new vm.SourceTextModule(source, { context, identifier: filename });
  cache.set(filename, module);
  for (const specifier of module.dependencySpecifiers) {
    assert.ok(specifier.startsWith("./"), `Nonlocal engine dependency: ${specifier}`);
    await load(path.resolve(path.dirname(filename), specifier));
  }
}

const entry = path.join(root, "index.js");
await load(entry);
const auditEntry = path.join(root, 'ledger-audit-replay.js');
await load(auditEntry);
const transportEntry = path.join(root, 'ledger-audit-transport.js');
await load(transportEntry);
const module = cache.get(entry);
await module.link((specifier, parent) => cache.get(path.resolve(path.dirname(parent.identifier), specifier)));
await module.evaluate();
const auditModule = cache.get(auditEntry);
if (auditModule.status === "unlinked") await auditModule.link((specifier, parent) => cache.get(path.resolve(path.dirname(parent.identifier), specifier)));
await auditModule.evaluate();
const transportModule = cache.get(transportEntry);
if (transportModule.status === "unlinked") await transportModule.link((specifier, parent) => cache.get(path.resolve(path.dirname(parent.identifier), specifier)));
await transportModule.evaluate();
for (const request of engineFixtures()) {
  const response = JSON.parse(module.namespace.calculateProjectionJson(JSON.stringify(request)));
  assert.equal(response.ok, true, JSON.stringify(response));
  const { ok, ...actual } = response;
  assert.deepEqual(actual, calculateProjection(request));
}
// Native hosts supply SHA-256/UTF-8 primitives. Financial replay itself runs
// wholly inside the restricted realm, with no structuredClone or Node APIs.
context.auditReplay = auditModule.namespace.createLedgerAuditReplay({
  digestText: text => createHash('sha256').update(text).digest('hex'),
  utf8ByteLength: text => Buffer.byteLength(text)
});
context.auditJson = JSON.stringify(portableLedgerAuditFixture());
const replayed = JSON.parse(vm.runInContext(`JSON.stringify((() => {
  const result = auditReplay.replayLedgerAuditSnapshot(JSON.parse(auditJson), 'portable-audit');
  return { rows: result.rows, heads: [...result.heads], statuses: [...result.corrections.values()].map(event => event.status) };
})())`, context, { timeout: 5000 }));
assert.deepEqual(replayed.rows.map(row => [row.id, row.amount]), [['income', 450], ['expense', 400]]);
assert.deepEqual(replayed.heads, [['income', 'retry'], ['expense', null]]);
assert.deepEqual(replayed.statuses, ['blocked', 'accepted']);
assert.throws(() => vm.runInContext(`(() => {
  const damaged = JSON.parse(auditJson); damaged.corrections[0].status = 'accepted';
  auditReplay.replayLedgerAuditSnapshot(damaged, 'portable-audit');
})()`, context, { timeout: 5000 }), /financial replay/);
// The optional next-format replay must also work entirely inside the portable
// realm. Current hosts stay closed; imported JSON cannot enable this policy.
context.originJson = JSON.stringify(standaloneOriginAuditFixture().audit);
context.originReplay = auditModule.namespace.createLedgerAuditReplay({
  digestText: text => createHash('sha256').update(text).digest('hex'),
  utf8ByteLength: text => Buffer.byteLength(text), allowStandaloneOrigins: true
});
const origin = JSON.parse(vm.runInContext(`JSON.stringify((() => {
  const result = originReplay.replayLedgerAuditSnapshot(JSON.parse(originJson), 'server-origin-audit');
  return { rows: result.rows, opening: result.opening, heads: [...result.heads] };
})())`, context, { timeout: 5000 }));
assert.equal(origin.rows[0].amount, 400);
assert.deepEqual(origin.opening, { amount: 500, ledgerCurrency: 'PLN' });
assert.deepEqual(origin.heads, [['confirmed-original', null]]);
assert.throws(() => vm.runInContext(`auditReplay.replayLedgerAuditSnapshot(JSON.parse(originJson), 'server-origin-audit')`,
  context, { timeout: 5000 }), /upgraded host/);
context.originTransport = transportModule.namespace;
const framing = JSON.parse(vm.runInContext(`JSON.stringify((() => {
  const audit = JSON.parse(originJson);
  audit.origin.events[0].row.note = 'ż🌍'.repeat(12000);
  const options = { allowStandaloneOrigins: true };
  const records = originTransport.encodeLedgerAuditRecords(audit, options);
  const restored = originTransport.decodeLedgerAuditRecords(JSON.parse(JSON.stringify(records)), 'server-origin-audit', options);
  const replay = originReplay.replayLedgerAuditSnapshot(restored, 'server-origin-audit');
  return { same: JSON.stringify(records) === JSON.stringify(originTransport.encodeLedgerAuditRecords(restored, options)),
    chunks: records[0].value.originChunks, opening: replay.opening.amount, amount: replay.rows[0].amount };
})())`, context, { timeout: 5000 }));
// Key order is canonicalized by transport; compare semantic proof values.
assert.equal(framing.same, true);
assert.ok(framing.chunks > 1);
assert.equal(framing.opening, 500);
assert.equal(framing.amount, 400);
assert.equal(vm.runInContext('typeof structuredClone', context), 'undefined');
assert.equal(vm.runInContext("typeof process", context), "undefined");
assert.equal(vm.runInContext("typeof Buffer", context), "undefined");
assert.equal(vm.runInContext("typeof fetch", context), "undefined");
console.log(`PASS: ${cache.size} engine modules; ${engineFixtures().length} fixtures plus blocked/retried and standalone-origin audit replay/framing; no Node globals, Intl, ambient clock or structuredClone required.`);
