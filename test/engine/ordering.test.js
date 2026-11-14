import assert from "node:assert/strict";
import test from "node:test";
import { compareEngineText } from "../../src/engine/cashflow-ordering.js";
import { calculateProjection } from "../../src/engine/index.js";
import { engineFixtures } from "./fixtures.js";
import { sortConfirmedRowsForBalance } from "../../src/engine/cashflow-ledger-balance-utils.js";

test("engine tie-break order is explicit UTF-16 rather than host locale", () => {
  const ids = ["z", "ą", "a", "A", "_", "10", "2", "😀"];
  assert.deepEqual([...ids].sort(compareEngineText), ["10", "2", "A", "_", "a", "z", "ą", "😀"]);
  assert.equal(compareEngineText(null, ""), 0);
  const rows = ids.map(id => ({ id, date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" }));
  assert.deepEqual(sortConfirmedRowsForBalance(rows).map(row => row.id), [...ids].sort(compareEngineText));
});

test("all financial fixtures execute with localeCompare disabled", () => {
  const original = String.prototype.localeCompare;
  const fixtures = engineFixtures();
  const expected = fixtures.map(calculateProjection);
  try {
    String.prototype.localeCompare = () => { throw new Error("Ambient locale comparison forbidden"); };
    assert.deepEqual(fixtures.map(calculateProjection), expected);
  } finally {
    String.prototype.localeCompare = original;
  }
});