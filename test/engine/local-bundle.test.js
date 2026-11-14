import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { buildEngine } from "../../scripts/lib/engine-build.mjs";
import { completeSnapshot, reserveRequest } from "./fixtures.js";

test("shipped bundle confirms, restores and undoes without ambient platform facilities", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-local-bundle-"));
  try {
    await buildEngine(directory);
    const context = vm.createContext({});
    vm.runInContext(`
      globalThis.Intl = undefined;
      const OriginalDate = Date;
      globalThis.Date = class extends OriginalDate {
        constructor(...args) { if (!args.length) throw Error('Ambient clock prohibited'); super(...args); }
        static now() { throw Error('Ambient clock prohibited'); }
      };
      String.prototype.localeCompare = function() { throw Error('Locale ordering prohibited'); };
    `, context);
    vm.runInContext(await readFile(path.join(directory, "cashflow-engine.js"), "utf8"), context, { timeout: 10000 });
    function call(method, command) {
      context.commandJson = JSON.stringify(command);
      return JSON.parse(vm.runInContext(`CashflowEngine.${method}(commandJson)`, context, { timeout: 5000 }));
    }
    const snapshot = completeSnapshot();
    snapshot.budgetId = "local-bundle";
    snapshot.request.tables.one_off_transactions[0].date = snapshot.request.today;
    const timing = { today: snapshot.request.today, generationTimestamp: snapshot.request.generationTimestamp, idSeed: "bundle-confirm" };
    const calculated = call("calculateSnapshotJson", snapshot);
    assert.equal(calculated.ok, true);
    const occurrenceKey = calculated.plan.pendingRows[0].occurrence_key;
    const confirmed = call("confirmLocalOccurrenceJson", { snapshot, occurrenceKey, ...timing });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.snapshot.request.openingBalance, 200);
    const restored = call("refreshLocalSnapshotJson", { snapshot: confirmed.snapshot, ...timing });
    assert.equal(restored.ok, true);
    assert.equal(restored.snapshot.localHistory.length, 1);
    assert.equal(restored.snapshot.request.openingBalance, 200);
    const corrected = call("correctLocalConfirmationJson", { snapshot: restored.snapshot,
      confirmationId: restored.snapshot.localHistory[0].id, expectedCorrectionId: null,
      reason: "Correct actual amount", replacement: { amount: 250, date: timing.today }, ...timing, idSeed: "bundle-correction" });
    assert.equal(corrected.ok, true);
    assert.equal(corrected.snapshot.snapshotVersion, 2);
    assert.equal(corrected.snapshot.request.openingBalance, 250);
    assert.equal(corrected.snapshot.localAudit[0].row.amount, 300);
    assert.equal(corrected.snapshot.localAudit.at(-1).before.amount, 300);
    assert.equal(corrected.snapshot.localAudit.at(-1).after.amount, 250);
    assert.equal(call("refreshLocalSnapshotJson", { snapshot: corrected.snapshot, ...timing }).ok, true);
    assert.equal(call("confirmLocalOccurrenceJson", { snapshot: restored.snapshot, occurrenceKey, ...timing }).ok, false);
    const undone = call("undoLocalConfirmationJson", { snapshot: restored.snapshot,
      confirmationId: restored.snapshot.localLastConfirmationId, ...timing, idSeed: "bundle-undo" });
    assert.equal(undone.ok, true);
    assert.equal(undone.snapshot.request.openingBalance, 500);
    assert.equal(undone.snapshot.localHistory.length, 0);
    assert.equal(call("calculateSnapshotJson", undone.snapshot).plan.pendingRows.length, 1);
    const corrupt = structuredClone(confirmed.snapshot);
    corrupt.localHistory[0].amount = 1;
    assert.equal(call("refreshLocalSnapshotJson", { snapshot: corrupt, ...timing }).ok, false);
    const installment = call("confirmLocalOccurrenceJson", { snapshot, occurrenceKey, ...timing,
      amount: 100, idSeed: "bundle-installment" });
    assert.equal(installment.ok, true);
    assert.equal(installment.snapshot.request.openingBalance, 400);
    const installmentRestored = call("refreshLocalSnapshotJson", { snapshot: installment.snapshot, ...timing });
    assert.equal(installmentRestored.ok, true);
    const remainder = call("calculateSnapshotJson", installmentRestored.snapshot).plan.pendingRows[0];
    assert.equal(remainder.amount, 200);
    assert.equal(remainder.occurrence_key, "one_off_remainder:one-1:2");
    const flex = structuredClone(snapshot);
    flex.request.tables.flex_transactions.push({ id: "leisure", name: "Leisure", currency: "PLN", amount: 20,
      active: 1, allow_split: 0, planned_transaction_id: "leisure-plan" });
    flex.request.tables.planned_transactions.push({ id: "leisure-plan", operating_priority: 1 });
    const refreshedFlex = call("refreshLocalSnapshotJson", { snapshot: flex, ...timing });
    assert.equal(refreshedFlex.ok, true);
    const flexResult = call("calculateSnapshotJson", refreshedFlex.snapshot);
    const flexRows = [...flexResult.plan.futureRows, ...flexResult.plan.pendingRows].filter(row => row.source_flex_id === "leisure");
    assert.ok(flexRows.length > 0);
    for (const row of flexResult.plan.pendingRows.filter(row => row.source_flex_id)) {
      const funded = call("confirmLocalOccurrenceJson", { snapshot: refreshedFlex.snapshot, occurrenceKey: row.occurrence_key, ...timing });
      assert.equal(funded.ok, true);
      assert.equal(funded.snapshot.localHistory[0].source_flex_id, "leisure");
    }
    // The Android-facing bundle exposes reserve confirmation through the same
    // JSON command, including source-less audit replay and undo.
    const reserve = completeSnapshot();
    const reserveInput = reserveRequest();
    Object.assign(reserve.request, reserveInput, { tables: { ...reserve.request.tables, ...reserveInput.tables } });
    reserve.budgetId = "local-bundle-reserve";
    const reserveResult = call("confirmLocalOccurrenceJson", { snapshot: reserve,
      occurrenceKey: "reserve_transfer:2026-06:2026-07:out", early: true, amount: 80, ...timing, idSeed: "reserve" });
    assert.equal(reserveResult.ok, true, JSON.stringify(reserveResult));
    assert.equal(reserveResult.snapshot.localAudit[0].source, null);
    const reserveRestored = call("refreshLocalSnapshotJson", { snapshot: reserveResult.snapshot, ...timing });
    assert.equal(reserveRestored.ok, true);
    const reserveUndo = call("undoLocalConfirmationJson", { snapshot: reserveRestored.snapshot,
      confirmationId: reserveRestored.snapshot.localLastConfirmationId, ...timing, idSeed: "reserve-undo" });
    assert.equal(reserveUndo.ok, true);
    assert.equal(reserveUndo.snapshot.localHistory.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
