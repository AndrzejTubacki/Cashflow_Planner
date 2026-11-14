import assert from "node:assert/strict";
import test from "node:test";
import { completeSnapshot } from "./fixtures.js";
import { refreshDownloadedSnapshot, refreshDownloadedSnapshotJson } from "../../src/engine/download-refresh.js";
import { refreshLocalSnapshot } from "../../src/engine/local-confirmation.js";

function downloaded() {
  return { ...completeSnapshot(), writesSupported: false, snapshotToken: "a".repeat(64),
    revisionSemantics: "preview-only-not-server-revision", consistency: "postgres-repeatable-read",
    fxSource: "last-projection-no-refresh" };
}
function command(snapshot) {
  return { snapshot, today: "2026-06-12", generationTimestamp: "2026-06-12T12:00:00.000Z", idSeed: "offline-refresh" };
}
test("offline download refresh rebuilds date-sensitive balances and retains read-only provenance", () => {
  const original = downloaded();
  original.request.predictionRows = [{ id: "confirmed", type: "income", currency: "PLN", ledger_currency: "PLN",
    amount: 700, ledger_amount: 700, running_balance_pln: 700, date: "2026-06-10" }];
  original.request.confirmedRowsAfterToday = [...original.request.predictionRows];
  const before = JSON.stringify(original);
  const next = refreshDownloadedSnapshot(command(original));
  assert.equal(next.request.openingBalance, 700);
  assert.equal(next.request.confirmedRowsAfterToday.length, 0);
  assert.equal(next.request.today, "2026-06-12");
  assert.equal(next.writesSupported, false);
  assert.equal(next.snapshotToken, original.snapshotToken);
  assert.equal(next.downloadedAt, original.request.generationTimestamp);
  assert.equal(next.revision, original.revision);
  assert.equal(next.offlineRecalculated, true);
  assert.equal(JSON.stringify(original), before);
  assert.throws(() => refreshLocalSnapshot({ snapshot: next, ...next.request }), /standalone/);
  assert.equal(refreshDownloadedSnapshot(command(next)).downloadedAt, next.downloadedAt);
});
test("offline download refresh rejects local, unmarked, unsupported and backwards inputs", () => {
  for (const change of [s => { s.writesSupported = true; }, s => { delete s.writesSupported; },
    s => { s.snapshotToken = "fake"; }, s => { s.revisionSemantics = "cursor"; },
    s => { s.localHistory = []; }]) {
    const input = downloaded(); change(input);
    assert.throws(() => refreshDownloadedSnapshot(command(input)), /read-only/);
  }
  assert.throws(() => refreshDownloadedSnapshot({ ...command(downloaded()), today: "2026-05-01" }), /backwards/);
  assert.equal(JSON.parse(refreshDownloadedSnapshotJson("not-json")).ok, false);
  assert.equal(JSON.parse(refreshDownloadedSnapshotJson(JSON.stringify(command(downloaded())))).ok, true);
});

test("empty retained history preserves the explicit balance across repeated offline refreshes", () => {
  const original = downloaded();
  const first = refreshDownloadedSnapshot(command(original));
  assert.equal(first.request.openingBalance, 500);
  assert.equal(refreshDownloadedSnapshot(command(first)).request.openingBalance, 500);
});

test('read-only offline refresh preserves server-reserved installment identity without inventing paid money', () => {
  const original = downloaded();
  const source = original.request.tables.one_off_transactions[0];
  original.request.oneOffProgress = [[`${source.id}:${source.type}:${source.currency}`, {
    sourceId: source.id, type: source.type, currency: source.currency, confirmedAmount: 0, confirmedCount: 7 }]];
  const before = structuredClone(original);
  const next = refreshDownloadedSnapshot(command(original));
  assert.equal(next.request.oneOffProgress[0][1].confirmedCount, 7);
  assert.equal(next.request.oneOffProgress[0][1].confirmedAmount, 0);
  assert.equal(refreshDownloadedSnapshot(command(next)).request.oneOffProgress[0][1].confirmedCount, 7);
  assert.deepEqual(original, before);
});

test("future history retains opening balance until its ledger date becomes current", () => {
  const original = downloaded();
  original.request.predictionRows = [{ id: "later", type: "income", amount: 100, ledger_amount: 100,
    currency: "PLN", ledger_currency: "PLN", date: "2026-06-20", running_balance_pln: 600 }];
  original.request.confirmedRowsAfterToday = [...original.request.predictionRows];
  const first = refreshDownloadedSnapshot(command(original));
  assert.equal(first.request.openingBalance, 500);
  assert.equal(first.request.confirmedRowsAfterToday.length, 1);
  const later = refreshDownloadedSnapshot({ ...command(first), today: "2026-06-20", generationTimestamp: "2026-06-20T12:00:00.000Z" });
  assert.equal(later.request.openingBalance, 600);
  assert.equal(later.request.confirmedRowsAfterToday.length, 0);
});
