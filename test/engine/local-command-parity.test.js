import assert from "node:assert/strict";
import test from "node:test";
import { engineFixtures, localCommandFixtures, completeSnapshot } from "./fixtures.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { confirmLocalOccurrence, correctLocalConfirmation, refreshLocalSnapshot } from "../../src/engine/local-confirmation.js";
import * as entry from "../../src/engine/app-entry.js";

test("every local command fixture succeeds through the embedded JSON entry points", () => {
  const fixtures = localCommandFixtures({ refresh: refreshLocalSnapshot, confirm: confirmLocalOccurrence, correct: correctLocalConfirmation });
  assert.equal(fixtures.length, 8);
  for (const { method, input } of fixtures) {
    const result = JSON.parse(entry[method](JSON.stringify(input)));
    assert.equal(result.ok, true, `${method}: ${result.error?.message}`);
  }
});

test("new projection fixtures exercise income anchors and an uncapped split", () => {
  const fixtures = engineFixtures();
  const run = request => { const base = completeSnapshot(); return calculateSnapshot({ ...base, budgetId: "parity-check",
    request: { ...base.request, ...request, tables: { ...base.request.tables, ...request.tables } } }).plan; };
  const anchored = run(fixtures[8]);
  const rent = [...anchored.pendingRows, ...anchored.futureRows].filter(row => row.source_recurring_expense_id === "rent");
  assert.ok(rent.length > 0 && rent.every(row => row.date.endsWith("-22")));
  const flex = run(fixtures[9]);
  const allocations = [...flex.pendingRows, ...flex.futureRows].filter(row => row.source_flex_id === "flex");
  assert.ok(allocations.length > 0 && allocations.every(row => row.amount >= 40));
});
