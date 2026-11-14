import assert from "node:assert/strict";
import test from "node:test";
import { completeSnapshot } from "./fixtures.js";
import { appendAuditedPayment } from "../../src/engine/local-audited-snapshot.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { confirmLocalOccurrence, refreshLocalSnapshot, correctLocalConfirmation, undoLocalConfirmation } from "../../src/engine/local-confirmation.js";

function confirm(snapshot, sourceId, idSeed, amount) {
  const plan = calculateSnapshot(snapshot).plan;
  const row = [...plan.pendingRows, ...plan.futureRows].find(value => ["source_one_off_id", "source_recurring_income_id", "source_goal_id", "source_flex_id"]
    .some(field => value[field] === sourceId));
  return confirmLocalOccurrence({ snapshot, ...snapshot.request, occurrenceKey: row.occurrence_key, idSeed, ...(amount === undefined ? {} : { amount }) });
}
function fixture() {
  const snapshot = completeSnapshot();
  snapshot.budgetId = "local-audited-workflow";
  snapshot.request.openingBalance = 0;
  snapshot.request.today = "2026-06-02";
  snapshot.request.generationTimestamp = "2026-06-02T12:00:00.000Z";
  snapshot.request.tables.one_off_transactions = [
    { id: "income", name: "Income", type: "income", amount: 500, currency: "PLN", date: "2026-06-01" },
    { id: "expense", name: "Expense", type: "expense", amount: 400, currency: "PLN", date: "2026-06-02" }
  ];
  return confirm(confirm(snapshot, "income", "income"), "expense", "expense");
}
function correction(snapshot, target, replacement, extra = {}) {
  return correctLocalConfirmation({ snapshot, ...snapshot.request, confirmationId: `confirmed-${target}`, replacement,
    expectedCorrectionId: null, reason: "Actual payment correction", idSeed: "correction", ...extra });
}

test("older blocked correction survives reopen, dependent correction, retry and full journal export", () => {
  const source = fixture();
  const originals = JSON.stringify(source.localAudit);
  assert.equal(source.snapshotVersion, 2);
  const blocked = correction(source, "income", { amount: 200, date: "2026-06-01" });
  assert.equal(blocked.localAudit.at(-1).status, "blocked");
  assert.equal(blocked.request.openingBalance, 100);
  assert.equal(blocked.revision, source.revision + 1);
  const reopened = refreshLocalSnapshot({ snapshot: JSON.parse(JSON.stringify(blocked)), ...blocked.request });
  const dependent = correction(reopened, "expense", { amount: 200, date: "2026-06-02" }, { idSeed: "dependent" });
  const resolved = correction(dependent, "income", { amount: 200, date: "2026-06-01" }, { idSeed: "retry", retryOf: "correction-correction" });
  assert.equal(resolved.request.openingBalance, 0);
  assert.equal(resolved.localAudit.at(-1).status, "accepted");
  assert.equal(JSON.stringify(resolved.localAudit.slice(0, 2)), originals);
  const backup = JSON.parse(JSON.stringify(resolved));
  assert.deepEqual(refreshLocalSnapshot({ snapshot: backup, ...backup.request }), resolved);
  assert.throws(() => correction(resolved, "income", null, { idSeed: "stale" }), /Stale/);
});

test("voided installments retain identities and can be paid again without reusing prior keys", () => {
  const initial = completeSnapshot(); initial.budgetId = "local-installment-audit";
  initial.request.tables.one_off_transactions[0].date = initial.request.today;
  const first = confirm(initial, "one-1", "first", 100);
  const second = confirm(first, "one-1", "second", 100);
  const voided = correction(second, "first", null);
  assert.equal(voided.request.openingBalance, 400);
  const repaid = confirm(voided, "one-1", "third", 200);
  assert.equal(repaid.localHistory.length, 2);
  assert.equal(repaid.localHistory.find(row => row.id === "confirmed-third").occurrence_key, "one_off_remainder:one-1:3");
  assert.equal(repaid.request.openingBalance, 200);
  assert.equal(calculateSnapshot(repaid).plan.pendingRows.length, 0);
  assert.equal(repaid.localAudit.filter(event => event.kind === "payment").length, 3);
  assert.deepEqual(refreshLocalSnapshot({ snapshot: repaid, ...repaid.request }), repaid);
});

test("prospective source edit/deletion retains original evidence and accepted money", () => {
  const initial = completeSnapshot(); initial.budgetId = "local-prospective";
  initial.request.tables.one_off_transactions = [];
  initial.request.tables.recurring_incomes = [{ id: "salary", name: "Salary", amount: 100, currency: "PLN", active: 1,
    prediction_strategy: "fixed", repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 1,
    anchor_business_day_adjustment: "none" }];
  const accepted = confirm(initial, "salary", "salary");
  const edited = structuredClone(accepted);
  Object.assign(edited.request.tables.recurring_incomes[0], { name: "Future salary", amount: 5, anchor_day_of_month: 2 });
  edited.revision++;
  const refreshed = refreshLocalSnapshot({ snapshot: edited, ...edited.request });
  assert.equal(refreshed.request.openingBalance, 600);
  assert.equal(refreshed.localHistory[0].amount, 100);
  assert.equal(refreshed.localAudit[0].source.row.amount, 100);
  refreshed.request.tables.recurring_incomes = [];
  const deleted = refreshLocalSnapshot({ snapshot: refreshed, ...refreshed.request });
  assert.equal(deleted.request.openingBalance, 600);
  const corrected = correctLocalConfirmation({ snapshot: deleted, ...deleted.request, confirmationId: "confirmed-salary",
    expectedCorrectionId: null, reason: "Correct retired source payment", replacement: { amount: 90, date: "2026-06-01" }, idSeed: "retired" });
  assert.equal(corrected.request.openingBalance, 590);
  assert.equal(corrected.request.tables.recurring_incomes.length, 0);
});

test("audited mirrors cannot rewrite payment facts while derived balances are recalculated", () => {
  const source = fixture();
  for (const mutate of [value => { value.localHistory[0].amount = 1; },
    value => { value.localAudit[0].row.ledger_amount = 1; },
    value => { value.localAudit[0].source.row.budget_id = "local-other"; },
    value => { value.localAuditVersion = 2; }]) {
    const changed = structuredClone(source); mutate(changed);
    assert.throws(() => refreshLocalSnapshot({ snapshot: changed, ...changed.request }));
  }
  source.request.openingBalance = 999999;
  source.localHistory[0].running_balance_pln = 999999;
  assert.equal(refreshLocalSnapshot({ snapshot: source, ...source.request }).request.openingBalance, 100);
  assert.throws(() => calculateSnapshot({ ...source, budgetId: "remote-budget" }), /standalone/);
});

test("legacy same-time installment ordering upgrades without inventing acceptance order", () => {
  const initial = completeSnapshot(); initial.budgetId = "local-legacy-order";
  initial.request.tables.one_off_transactions[0].date = initial.request.today;
  const first = confirm(initial, "one-1", "z-first", 100);
  const second = confirm(first, "one-1", "a-second", 100);
  const legacy = structuredClone(second);
  legacy.snapshotVersion = 1;
  delete legacy.localAudit; delete legacy.localAuditVersion; delete legacy.localAuditLegacyCount;
  const upgraded = refreshLocalSnapshot({ snapshot: legacy, ...legacy.request });
  assert.equal(upgraded.localAuditLegacyCount, 2);
  assert.ok(upgraded.localAudit.every(event => !Object.hasOwn(event, "policyVersion")));
  assert.equal(upgraded.request.openingBalance, 300);
  const undone = undoLocalConfirmation({ snapshot: upgraded, ...upgraded.request, confirmationId: upgraded.localLastConfirmationId, idSeed: "legacy-undo" });
  assert.equal(undone.request.openingBalance, 400);
  assert.equal(undone.localAudit.length, 3);
});

test("goal and split-flex corrections rebuild funding and preserve captured allocation constraints", () => {
  for (const goal of [true, false]) {
    const initial = completeSnapshot(); initial.budgetId = "local-funding-audit";
    initial.request.tables.one_off_transactions = [];
    initial.request.tables.planned_transactions = [{ id: "plan", [goal ? "goal_priority" : "operating_priority"]: 1 }];
    initial.request.tables[goal ? "goals" : "flex_transactions"] = [{ id: "funding", name: "Funding", amount: goal ? 700 : 300,
      currency: "PLN", active: 1, planned_transaction_id: "plan", ...(goal ? { due_date: initial.request.today }
        : { allow_split: 1, min_amount: 20, max_amount: 80 }) }];
    const accepted = confirm(initial, "funding", "funding");
    const originalAmount = accepted.localHistory[0].amount;
    const corrected = correction(accepted, "funding", { amount: goal ? 300 : 50, date: initial.request.today });
    assert.deepEqual(corrected.request.confirmedFunding[goal ? "source_goal_id" : "source_flex_id"], [["funding", goal ? 300 : 50]]);
    assert.equal(corrected.localAudit[0].row.amount, originalAmount);
    const voided = correction(corrected, "funding", null, { idSeed: "void-funding", expectedCorrectionId: "correction-correction" });
    assert.deepEqual(voided.request.confirmedFunding[goal ? "source_goal_id" : "source_flex_id"], []);
    assert.equal(voided.request.openingBalance, 500);
    if (!goal) {
      const futurePolicy = structuredClone(accepted);
      futurePolicy.request.tables.flex_transactions[0].max_amount = 40;
      const reopened = refreshLocalSnapshot({ snapshot: futurePolicy, ...futurePolicy.request });
      const historical = correction(reopened, "funding", { amount: 70, date: initial.request.today });
      assert.equal(historical.localAudit.at(-1).status, "accepted");
      const aboveOriginalCap = correction(reopened, "funding", { amount: 90, date: initial.request.today });
      assert.equal(aboveOriginalCap.localAudit.at(-1).status, "accepted");
    } else {
      const tomorrow = refreshLocalSnapshot({ snapshot: accepted, ...accepted.request, today: "2026-06-02", generationTimestamp: "2026-06-02T12:00:00.000Z" });
      const afterDeadline = correction(tomorrow, "funding", { amount: 300, date: "2026-06-02" });
      assert.equal(afterDeadline.localAudit.at(-1).status, "accepted");
      assert.equal(afterDeadline.request.openingBalance, 200);
      assert.equal(afterDeadline.localAudit.at(-1).policyVersion, 2);
      assert.deepEqual(refreshLocalSnapshot({ snapshot: afterDeadline, ...afterDeadline.request }), afterDeadline);
    }
  }
});


// The original rejection remains evidence even when an explicit new review uses
// the actual-date rule. Neither reopen nor upgrade accepts it silently.
test("legacy late-goal rejection stays blocked; explicit retry, void and restoration use actual dates", () => {
  const initial = completeSnapshot(); initial.budgetId = "local-goal-policy";
  initial.request.tables.one_off_transactions = [];
  initial.request.tables.planned_transactions = [{ id: "plan", goal_priority: 1 }];
  initial.request.tables.goals = [{ id: "goal", name: "Goal", amount: 700, currency: "PLN", active: 1,
    planned_transaction_id: "plan", due_date: "2026-06-01" }];
  const accepted = confirm(initial, "goal", "goal", 200);
  const tomorrow = refreshLocalSnapshot({ snapshot: accepted, ...accepted.request,
    today: "2026-06-02", generationTimestamp: "2026-06-02T12:00:00.000Z" });
  const late = correction(tomorrow, "goal", { amount: 250, date: "2026-06-02" });
  const legacy = structuredClone(late);
  const event = legacy.localAudit.at(-1);
  delete event.policyVersion;
  Object.assign(event, { status: "blocked", failureCode: "source_date", after: null });
  // Restore the unchanged accepted mirrors of a real legacy rejection.
  legacy.localHistory = structuredClone(tomorrow.localHistory);
  legacy.request.predictionRows = structuredClone(tomorrow.request.predictionRows);
  const reopened = refreshLocalSnapshot({ snapshot: legacy, ...legacy.request });
  assert.equal(reopened.localAudit.at(-1).status, "blocked");
  assert.equal(reopened.request.openingBalance, 300);
  const retained = JSON.stringify(reopened.localAudit);
  const retry = correction(reopened, "goal", event.requested, { idSeed: "retry", retryOf: event.id });
  assert.equal(retry.localAudit.at(-1).status, "accepted");
  assert.equal(retry.request.openingBalance, 250);
  assert.equal(JSON.stringify(retry.localAudit.slice(0, -1)), retained);
  const voided = correction(retry, "goal", null, { idSeed: "void", expectedCorrectionId: "correction-retry" });
  const restored = correction(voided, "goal", event.requested, { idSeed: "restore", expectedCorrectionId: "correction-void" });
  assert.equal(restored.localHistory[0].date, "2026-06-02");
  assert.deepEqual(restored.request.confirmedFunding.source_goal_id, [["goal", 250]]);
  assert.equal(restored.localAudit[0].source.row.due_date, "2026-06-01");
  for (const policyVersion of [1, 3, "2", null]) {
    const malformed = structuredClone(restored); malformed.localAudit.at(-1).policyVersion = policyVersion;
    assert.throws(() => refreshLocalSnapshot({ snapshot: malformed, ...malformed.request }), /policy version/);
  }
  // A new confirmation after a late correction must also replay that history.
  const addition = structuredClone(restored);
  addition.request.tables.one_off_transactions = [{ id: "later", name: "Later income", type: "income",
    amount: 100, currency: "PLN", date: "2026-06-02" }];
  assert.equal(confirm(addition, "later", "later").request.openingBalance, 350);
  // Actual confirmation may be late, while its immutable scheduled occurrence
  // and captured source deadline remain on the original allocation day.
  const refreshed = refreshLocalSnapshot({ snapshot: initial, ...initial.request,
    today: "2026-06-02", generationTimestamp: "2026-06-02T12:00:00.000Z" });
  const row = { ...accepted.localAudit[0].row, date: "2026-06-02", confirmed_date: "2026-06-02" };
  const paidLate = appendAuditedPayment(refreshed, row, { ...refreshed.request, idSeed: "late-payment" });
  assert.equal(paidLate.localHistory[0].date, "2026-06-02");
  assert.equal(paidLate.localAudit[0].policyVersion, 2);
  assert.deepEqual(refreshLocalSnapshot({ snapshot: paidLate, ...paidLate.request }), paidLate);
});
