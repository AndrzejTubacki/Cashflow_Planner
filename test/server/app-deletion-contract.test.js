import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { normalizeAppDeletion, appDeletionFingerprint } from "../../src/server/cashflow-app-deletion-contract.js";
import { normalizeAppOperation } from "../../src/server/cashflow-app-operation-contract.js";
import { openSqliteOperationJournal } from "../../scripts/lib/app-operation-journal.mjs";

function deletion() {
  return { version: 1, operationId: randomUUID(), budgetId: "synthetic-deletion",
    epoch: randomUUID(), baseRevision: 1, kind: "one-off.delete", payload: { id: randomUUID() } };
}

test("draft deletion fingerprint preserves envelope identity and normalizes UUIDs", () => {
  const input = deletion();
  const alternate = Object.fromEntries(Object.entries(input).reverse());
  alternate.operationId = input.operationId.toUpperCase();
  alternate.epoch = input.epoch.toUpperCase();
  alternate.payload = { id: input.payload.id.toUpperCase() };
  assert.deepEqual(normalizeAppDeletion(input), input);
  assert.equal(appDeletionFingerprint(alternate), appDeletionFingerprint(input));
  for (const change of [{ operationId: randomUUID() }, { epoch: randomUUID() }, { baseRevision: 2 },
    { budgetId: "other" }, { payload: { id: randomUUID() } }]) {
    assert.notEqual(appDeletionFingerprint({ ...input, ...change }), appDeletionFingerprint(input));
  }
});

test("draft deletion rejects arbitrary financial data and malformed envelopes", () => {
  const input = deletion();
  for (const payload of [null, [], {}, { id: 123 }, { id: "bad" },
    { id: input.payload.id, amount: 0 }, { id: input.payload.id, confirmed: true }]) {
    assert.throws(() => normalizeAppDeletion({ ...input, payload }));
  }
  for (const change of [{ version: 2 }, { kind: "budget.delete" }, { baseRevision: -1 },
    { baseRevision: "1" }, { baseRevision: Number.MAX_SAFE_INTEGER }, { plan: {} },
    { operationId: null }, { budgetId: "../foreign" }]) {
    assert.throws(() => normalizeAppDeletion({ ...input, ...change }));
  }
});

test("draft deletions remain disabled in the actual reference journal", () => {
  const journal = openSqliteOperationJournal(":memory:");
  try {
    const head = journal.create("synthetic-deletion");
    const input = { ...deletion(), epoch: head.epoch, baseRevision: 0 };
    // The protocol contract now defines one-off.delete for the financial host;
    // this synthetic create-only reference journal must still refuse it.
    assert.equal(normalizeAppOperation(input).kind, "one-off.delete");
    assert.throws(() => journal.apply(input), /Unsupported/);
    assert.equal(journal.receiptCount(input.budgetId), 0);
    assert.equal(journal.head(input.budgetId).revision, 0);
    assert.deepEqual(journal.sources(input.budgetId), []);
  } finally { journal.close(); }
});