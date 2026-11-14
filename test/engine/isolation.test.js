import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { calculateProjection, calculateProjectionJson } from "../../src/engine/index.js";
import { projectionRequest, partialRequest, reserveRequest, engineFixtures } from "./fixtures.js";

test("JSON engine is deterministic, isolated per request, and does not mutate inputs", () => {
  const request = partialRequest();
  const original = JSON.stringify(request);
  const first = calculateProjection(request);
  calculateProjection(projectionRequest({ idSeed: "different" }));
  assert.deepEqual(calculateProjection(request), first);
  assert.equal(JSON.stringify(request), original);
  assert.ok(first.plan.futureRows.some(row => row.status === "partial" && row.funded_amount === 30));
  assert.ok(first.plan.notificationRows.length > 0);
  assert.ok(first.plan.notificationRows.every(row => row.queued_at === request.generationTimestamp));
});

test("engine rejects incompatible, non-JSON and non-finite requests explicitly", () => {
  for (const request of [projectionRequest({ protocolVersion: 2 }), projectionRequest({ openingBalance: NaN }),
    projectionRequest({ openingBalance: Infinity }), projectionRequest({ today: "2026-02-30" }),
    projectionRequest({ idSeed: "" }), projectionRequest({ generationTimestamp: "invalid" }),
    projectionRequest({ generationTimestamp: "2026-02-30T00:00:00.000Z" }),
    projectionRequest({ settings: { future_periods: 121 } }), projectionRequest({ oneOffProgress: [["id", Infinity]] }),
    projectionRequest({ oneOffProgress: [["id", 1], ["id", 2]] }), projectionRequest({ tables: new Map() }),
    projectionRequest({ predictionRows: [null] }), projectionRequest({ confirmedRowsAfterToday: [4] }),
    projectionRequest({ confirmedFunding: [] })]) {
    assert.throws(() => calculateProjection(request));
  }
  const response = JSON.parse(calculateProjectionJson("not json"));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "CALCULATION_FAILED");
});

test("history fixture exercises recurring maximum prediction rather than the starting amount", () => {
  const fixture = engineFixtures()[3];
  const { plan } = calculateProjection(fixture);
  const row = plan.futureRows.find(item => item.source_recurring_expense_id === "expense-1");
  assert.equal(row.requested_amount, 120);
});

test("JSON facade preserves two-pass cross-period reserve funding", () => {
  const { plan } = calculateProjection(reserveRequest());
  const transfers = plan.futureRows.filter(row => row.occurrence_key.startsWith("reserve_transfer:"));
  assert.equal(transfers.length, 2);
  assert.deepEqual(transfers.map(row => row.ledger_amount), [100, 100]);
  const bill = plan.futureRows.find(row => row.source_one_off_id === "bill-1");
  assert.equal(bill.status, "funded");
  assert.equal(bill.ledger_amount, 100);
  const goal = plan.futureRows.find(row => row.source_goal_id === "goal-1");
  assert.equal(goal.status, "partial");
  assert.equal(goal.ledger_amount, 50);
});

test("JSON facade applies FX buffer only to foreign-currency spending", () => {
  const request = projectionRequest({
    openingBalance: 1000,
    settings: { ledger_currency: "PLN", future_periods: 1, fx_buffer_percent: 10 },
    fxSnapshot: { "eur/pln": { rate: 4, source: "manual" } },
    tables: { one_off_transactions: [
      { id: "native", name: "Native", type: "expense", currency: "PLN", amount: 100, date: "2026-06-10" },
      { id: "foreign", name: "Foreign", type: "expense", currency: "EUR", amount: 100, date: "2026-06-11" }
    ] }
  });
  const { plan } = calculateProjection(request);
  assert.equal(plan.futureRows.find(row => row.source_one_off_id === "native").ledger_amount, 100);
  assert.equal(plan.futureRows.find(row => row.source_one_off_id === "foreign").ledger_amount, 440);
});

test("non-finite calculation output is rejected instead of serialized as null", () => {
  const request = projectionRequest();
  request.tables.one_off_transactions[0].amount = "not-money";
  assert.equal(JSON.parse(calculateProjectionJson(JSON.stringify(request))).ok, false);
});

test("engine loads and runs without Node globals, Intl, or ambient date", () => {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules",
    fileURLToPath(new URL("../../scripts/engine-isolation-probe.mjs", import.meta.url))], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS:/);
});

test("extracted calculations match the recorded pre-extraction results", async () => {
  // Synthetic plans recorded from the pre-extraction algorithm. Keep the
  // historical oracle in the public tree so a fresh clone needs no private Git history.
  const baseline = JSON.parse(await readFile(new URL("./projection-baseline.json", import.meta.url), "utf8"));
  const fixtures = engineFixtures();
  assert.equal(fixtures.length, baseline.length);
  for (const [index, request] of fixtures.entries()) {
    const plan = calculateProjection(request).plan;
    // Notification params were added later for device wording only.
    plan.notificationRows = plan.notificationRows.map(({ params, ...row }) => row);
    assert.deepEqual(plan, baseline[index], `projection fixture ${index + 1}`);
  }
});
