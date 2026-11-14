import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { buildEngine } from "../../scripts/lib/engine-build.mjs";
import { calculateProjection } from "../../src/engine/index.js";
import { engineFixtures, completeSnapshot } from "./fixtures.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { portableLedgerAuditFixture } from '../helpers/ledger-audit-fixtures.js';

test("standalone artifact is reproducible and runs without a module loader or host APIs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-engine-bundle-"));
  try {
    const manifest = await buildEngine(directory);
    assert.deepEqual((await readdir(directory)).sort(), ["cashflow-engine.js", "manifest.json"]);
    const source = await readFile(path.join(directory, manifest.file), "utf8");
    assert.equal(manifest.sha256, createHash("sha256").update(source).digest("hex"));
    assert.deepEqual(await buildEngine(directory), manifest);
    const context = vm.createContext({});
    vm.runInContext(`
      const NativeDate = Date;
      globalThis.Date = class extends NativeDate {
        constructor(...args) { if (!args.length) throw new Error("Ambient clock forbidden"); super(...args); }
        static now() { throw new Error("Ambient clock forbidden"); }
      };
      globalThis.Intl = undefined;
    `, context);
    vm.runInContext(source, context, { timeout: 5000 });
    assert.equal(vm.runInContext("typeof process + ':' + typeof fetch + ':' + typeof require", context),
      "undefined:undefined:undefined");
    const audit = portableLedgerAuditFixture();
    context.auditRequest = JSON.stringify({ audit, budgetId: audit.budgetId });
    const prepared = JSON.parse(vm.runInContext('CashflowEngine.prepareLedgerAuditHashesJson(auditRequest)', context, { timeout: 5000 }));
    assert.equal(prepared.ok, true);
    const hashes = prepared.texts.map(text => [text, createHash('sha256').update(text).digest('hex')]);
    context.auditRequest = JSON.stringify({ audit, budgetId: audit.budgetId, hashes });
    const audited = JSON.parse(vm.runInContext('CashflowEngine.replayLedgerAuditFromHostJson(auditRequest)', context, { timeout: 5000 }));
    assert.equal(audited.ok, true);
    assert.deepEqual(audited.replay.rows.map(row => [row.id, row.amount]), [['income', 450], ['expense', 400]]);
    assert.deepEqual(audited.replay.corrections.map(event => event.status), ['blocked', 'accepted']);
    context.auditRequest = JSON.stringify({ audit, budgetId: audit.budgetId, hashes: [] });
    assert.equal(JSON.parse(vm.runInContext('CashflowEngine.replayLedgerAuditFromHostJson(auditRequest)', context, { timeout: 5000 })).ok, false);
    for (const fixture of engineFixtures()) {
      context.request = JSON.stringify(fixture);
      const result = JSON.parse(vm.runInContext("CashflowEngine.calculateProjectionJson(request)", context, { timeout: 5000 }));
      const { ok, ...actual } = result;
      assert.equal(ok, true);
      assert.deepEqual(actual, calculateProjection(fixture));
    }
    context.request = JSON.stringify(completeSnapshot());
    const response = JSON.parse(vm.runInContext("CashflowEngine.calculateSnapshotJson(request)", context, { timeout: 5000 }));
    const { ok, ...snapshotResult } = response;
    assert.equal(ok, true);
    assert.deepEqual(snapshotResult, calculateSnapshot(completeSnapshot()));
    const local = completeSnapshot();
    local.budgetId = "local-isolated";
    local.request.tables.one_off_transactions[0].date = local.request.today;
    context.request = JSON.stringify({ snapshot: local, today: local.request.today,
      generationTimestamp: local.request.generationTimestamp, idSeed: "isolated-refresh" });
    const refreshed = JSON.parse(vm.runInContext("CashflowEngine.refreshLocalSnapshotJson(request)", context, { timeout: 5000 }));
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.snapshot.request.openingBalance, 500);
    context.request = JSON.stringify({ snapshot: refreshed.snapshot,
      occurrenceKey: "one_off:one-1:expense:2026-06-01", today: local.request.today,
      generationTimestamp: local.request.generationTimestamp, idSeed: "isolated-confirm" });
    const confirmed = JSON.parse(vm.runInContext("CashflowEngine.confirmLocalOccurrenceJson(request)", context, { timeout: 5000 }));
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.snapshot.request.openingBalance, 200);
    context.request = JSON.stringify({ snapshot: confirmed.snapshot,
      confirmationId: confirmed.snapshot.localLastConfirmationId, today: local.request.today,
      generationTimestamp: local.request.generationTimestamp, idSeed: "isolated-undo" });
    const undone = JSON.parse(vm.runInContext("CashflowEngine.undoLocalConfirmationJson(request)", context, { timeout: 5000 }));
    assert.equal(undone.ok, true);
    assert.equal(undone.snapshot.request.openingBalance, 500);
    const download = { ...completeSnapshot(), writesSupported: false,
      snapshotToken: "a".repeat(64), revisionSemantics: "preview-only-not-server-revision" };
    download.request.predictionRows = [{ id: "income-record", type: "income", currency: "PLN", ledger_currency: "PLN",
      amount: 700, ledger_amount: 700, running_balance_pln: 700, date: "2026-06-10" }];
    download.request.confirmedRowsAfterToday = [...download.request.predictionRows];
    context.request = JSON.stringify({ snapshot: download, today: "2026-06-12",
      generationTimestamp: "2026-06-12T12:00:00.000Z", idSeed: "isolated-offline" });
    const offline = JSON.parse(vm.runInContext("CashflowEngine.refreshDownloadedSnapshotJson(request)", context, { timeout: 5000 }));
    assert.equal(offline.ok, true);
    assert.equal(offline.snapshot.request.openingBalance, 700);
    assert.equal(offline.snapshot.writesSupported, false);
    assert.equal(offline.snapshot.downloadedAt, download.request.generationTimestamp);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
