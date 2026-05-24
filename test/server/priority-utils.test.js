import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizePriority,
  priorityColumnForDomain,
  priorityTypesForDomain
} from "../../src/server/cashflow-priority-utils.js";

test("normalizePriority keeps positive integers", () => {
  assert.equal(normalizePriority(3), 3);
});

test("normalizePriority falls back to 1 for invalid values", () => {
  assert.equal(normalizePriority(0), 1);
  assert.equal(normalizePriority(-2), 1);
  assert.equal(normalizePriority(2.5), 1);
  assert.equal(normalizePriority("abc"), 1);
});

test("goal priority uses separate priority column and domain", () => {
  assert.equal(priorityColumnForDomain("goal"), "goal_priority");
  assert.deepEqual(priorityTypesForDomain("goal"), ["goal"]);
});

test("operating priority covers recurring expenses and flex transactions", () => {
  assert.equal(priorityColumnForDomain("operating"), "operating_priority");
  assert.deepEqual(priorityTypesForDomain("operating"), ["recurring_expense", "flex"]);
});
