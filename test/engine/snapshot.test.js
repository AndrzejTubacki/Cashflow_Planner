import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { calculateSnapshot, calculateSnapshotJson } from "../../src/engine/snapshot.js";
import { openAppSnapshotStore } from "../../scripts/lib/app-snapshot-store.mjs";
import { completeSnapshot } from "./fixtures.js";

test("strict snapshot preserves identity/revision and rejects omitted ledger inputs", () => {
  const snapshot = completeSnapshot();
  const result = calculateSnapshot(snapshot);
  assert.equal(result.baseRevision, 0);
  assert.equal(result.budgetId, snapshot.budgetId);
  assert.equal(result.calculationId, snapshot.request.idSeed);
  for (const field of ["predictionRows", "confirmedRowsAfterToday", "handledOccurrenceKeys", "oneOffProgress",
    "confirmedFunding", "fxSnapshot", "settings", "tables"]) {
    const copy = completeSnapshot();
    delete copy.request[field];
    assert.equal(JSON.parse(calculateSnapshotJson(JSON.stringify(copy))).ok, false, field);
  }
  const missing = completeSnapshot();
  delete missing.request.tables.pending_transactions;
  assert.throws(() => calculateSnapshot(missing), /pending_transactions/);
  const mixed = completeSnapshot();
  mixed.request.tables.one_off_transactions[0].budget_id = "different-budget";
  assert.throws(() => calculateSnapshot(mixed), /another budget/);
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculateSnapshot({ ...snapshot, revision }), /revision/);
  }
});

test("SQLite app host rejects stale results from a second connection and supports recalculation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-app-revisions-"));
  const filename = path.join(directory, "app.sqlite");
  const first = openAppSnapshotStore(filename);
  const second = openAppSnapshotStore(filename);
  try {
    const snapshot = completeSnapshot();
    first.create(snapshot.budgetId, snapshot.request);
    const result = calculateSnapshot(first.read(snapshot.budgetId));
    const edited = second.read(snapshot.budgetId);
    edited.request.openingBalance = 100;
    second.update(snapshot.budgetId, edited.revision, edited.request);
    assert.throws(() => first.apply(result), { code: "STALE_SNAPSHOT" });
    assert.equal(first.read(snapshot.budgetId).result, null);
    const fresh = calculateSnapshot(first.read(snapshot.budgetId));
    const applied = first.apply(fresh);
    assert.equal(applied.revision, 2);
    assert.equal(applied.result.plan.futureRows[0].status, "underfunded");
    assert.throws(() => second.apply(fresh), { code: "STALE_SNAPSHOT" });
    assert.throws(() => second.update(snapshot.budgetId, 0, edited.request), { code: "STALE_SNAPSHOT" });
    assert.equal(second.read(snapshot.budgetId).revision, 2);
  } finally {
    first.close(); second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite result persistence rolls back revision and payload together on failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-app-rollback-"));
  const filename = path.join(directory, "app.sqlite");
  let store = openAppSnapshotStore(filename);
  const control = new Database(filename);
  try {
    const snapshot = completeSnapshot();
    store.create(snapshot.budgetId, snapshot.request);
    const result = calculateSnapshot(store.read(snapshot.budgetId));
    const altered = structuredClone(result);
    altered.plan.futureRows[0].ledger_amount = 1;
    assert.throws(() => store.apply(altered), /does not match/);
    control.exec(`CREATE TRIGGER fail_result BEFORE UPDATE OF result_json ON app_budget_snapshots
      WHEN NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected disk write failure'); END;`);
    assert.throws(() => store.apply(result), /injected disk write failure/);
    assert.equal(store.read(snapshot.budgetId).revision, 0);
    assert.equal(store.read(snapshot.budgetId).result, null);
    control.exec("DROP TRIGGER fail_result");
    store.apply(result);
    store.close();
    store = openAppSnapshotStore(filename);
    assert.equal(store.read(snapshot.budgetId).revision, 1);
    assert.deepEqual(store.read(snapshot.budgetId).result, result);
  } finally {
    store.close(); control.close();
    await rm(directory, { recursive: true, force: true });
  }
});