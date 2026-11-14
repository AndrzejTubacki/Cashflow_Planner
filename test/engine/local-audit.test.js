import assert from "node:assert/strict";
import test from "node:test";
import { completeSnapshot } from "./fixtures.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { confirmLocalOccurrence } from "../../src/engine/local-confirmation.js";
import { appendLocalCorrection, captureLocalSource, replayLocalAudit } from "../../src/engine/local-audit.js";

/** Build genuine accepted facts through the current financial confirmation
 * path; journal tests must not succeed by rejecting unrelated fake metadata. */
function fixture() {
  let snapshot = completeSnapshot();
  snapshot.budgetId = "local-audit-test";
  snapshot.request.openingBalance = 0;
  snapshot.request.today = "2026-06-02";
  snapshot.request.tables.one_off_transactions = [
    { id: "income", name: "Income", type: "income", currency: "PLN", amount: 500, date: "2026-06-01" },
    { id: "expense", name: "Expense", type: "expense", currency: "PLN", amount: 400, date: "2026-06-02" }
  ];
  for (const id of ["income", "expense"]) {
    const plan = calculateSnapshot(snapshot).plan;
    const row = [...plan.pendingRows, ...plan.futureRows].find(value => value.source_one_off_id === id);
    snapshot = confirmLocalOccurrence({ snapshot, occurrenceKey: row.occurrence_key, today: snapshot.request.today,
      generationTimestamp: "2026-06-02T12:00:00.000Z", idSeed: id });
  }
  const events = snapshot.localHistory.map(row => ({ kind: "payment", id: row.id, row,
    source: captureLocalSource(row, snapshot.request.tables) }));
  return { events, opening: 0, settings: snapshot.request.settings, today: "2026-06-02", budgetId: snapshot.budgetId };
}
function correct(state, targetId, requested, extra = {}) {
  return appendLocalCorrection({ ...state, targetId, requested, id: "correction-one", expectedCorrectionId: null,
    reason: "Correct actual payment", createdAt: "2026-06-02T12:01:00.000Z", ...extra });
}

test("older corrections retain original facts, blocked intentions and explicit dependency retries", () => {
  const state = fixture();
  const original = JSON.stringify(state.events);
  const blocked = correct(state, "confirmed-income", { amount: 200, date: "2026-06-01" });
  assert.equal(blocked.at(-1).status, "blocked");
  assert.equal(blocked.at(-1).failureCode, "history_overdraft");
  assert.equal(replayLocalAudit({ ...state, events: blocked }).rows.at(-1).running_balance_pln, 100);
  const reducedExpense = correct({ ...state, events: blocked }, "confirmed-expense", { amount: 200, date: "2026-06-02" }, { id: "reduce-expense" });
  assert.equal(reducedExpense.at(-1).status, "accepted");
  const retry = correct({ ...state, events: reducedExpense }, "confirmed-income", { amount: 200, date: "2026-06-01" },
    { id: "retry-income", retryOf: "correction-one" });
  const restored = replayLocalAudit({ ...state, events: JSON.parse(JSON.stringify(retry)) });
  assert.equal(restored.rows.at(-1).running_balance_pln, 0);
  assert.equal(restored.heads.get("confirmed-income"), "retry-income");
  assert.equal(restored.entries.get("correction-one").status, "blocked");
  assert.equal(JSON.stringify(retry.slice(0, 2)), original);
  assert.equal(JSON.stringify(state.events), original);
  assert.equal(retry.at(-1).before.amount, 500);
  assert.equal(retry.at(-1).after.amount, 200);
});

test("void and replacement preserve audit links and reject stale correction reviews", () => {
  const state = fixture();
  const events = correct(state, "confirmed-expense", null);
  assert.equal(replayLocalAudit({ ...state, events }).rows.length, 1);
  assert.equal(events.at(-1).before.amount, 400);
  assert.equal(events.at(-1).after, null);
  assert.throws(() => correct({ ...state, events }, "confirmed-expense", { amount: 300, date: state.today }), /Stale/);
  const replacement = correct({ ...state, events }, "confirmed-expense", { amount: 300, date: state.today },
    { id: "replacement", expectedCorrectionId: "correction-one" });
  assert.equal(replayLocalAudit({ ...state, events: replacement }).rows.at(-1).running_balance_pln, 200);
  assert.equal(replacement.at(-1).before, null);
});

test("audit replay rejects altered links, before/after facts, scopes and forged acceptance", () => {
  const state = fixture();
  const blocked = correct(state, "confirmed-income", { amount: 200, date: "2026-06-01" });
  const accepted = correct(state, "confirmed-expense", { amount: 200, date: state.today });
  for (const mutate of [
    events => { events.at(-1).before.amount = 1; },
    events => { events.at(-1).after.amount = 1; },
    events => { events.at(-1).expectedCorrectionId = "missing"; },
    events => { events.at(-1).source.row.budget_id = "local-foreign"; },
    events => { events.at(-1).retryOf = "missing"; },
    events => { events[0].row.ledger_amount = 1; },
    events => { events.push(events[0]); }
  ]) {
    const changed = structuredClone(accepted); mutate(changed);
    assert.throws(() => replayLocalAudit({ ...state, events: changed }));
  }
  blocked.at(-1).status = "accepted";
  blocked.at(-1).failureCode = null;
  assert.throws(() => replayLocalAudit({ ...state, events: blocked }), /dependencies/);
});

test("invalid requests cannot silently change accepted money; over-target amounts follow the server", () => {
  const state = fixture();
  for (const requested of [{ amount: 0, date: state.today }, { amount: "100", date: state.today },
    { amount: 1.001, date: state.today }, { amount: 100, date: "2026-06-03" }]) {
    assert.throws(() => correct(state, "confirmed-expense", requested));
  }
  assert.throws(() => correct(state, "confirmed-expense", null, { reason: " " }));
  const above = correct(state, "confirmed-expense", { amount: 450, date: state.today });
  assert.equal(above.at(-1).status, "accepted");
  assert.equal(replayLocalAudit({ ...state, events: above }).rows.at(-1).running_balance_pln, 50);
  // Intentions blocked by the earlier per-source cap stay readable as recorded.
  const legacyBlocked = structuredClone(above);
  delete legacyBlocked.at(-1).policyVersion;
  Object.assign(legacyBlocked.at(-1), { status: "blocked", failureCode: "source_limit", after: null });
  assert.equal(replayLocalAudit({ ...state, events: legacyBlocked }).rows.at(-1).amount, 400);
  const forged = correct(state, "confirmed-expense", { amount: 300, date: state.today });
  Object.assign(forged.at(-1), { status: "blocked", failureCode: "source_limit", after: null });
  assert.throws(() => replayLocalAudit({ ...state, events: forged }), /differs from financial dependencies/);
});

test("legacy baselines validate whole-history funding without inventing acceptance order", () => {
  const state = fixture();
  const reversed = [...state.events].reverse();
  assert.equal(replayLocalAudit({ ...state, events: reversed, legacyCount: 2 }).rows.at(-1).running_balance_pln, 100);
  const extra = structuredClone(state.events[1]);
  extra.id = extra.row.id = "extra-installment";
  extra.row.amount = extra.row.ledger_amount = 1;
  extra.row.occurrence_key = "one_off_remainder:expense:2";
  // In some order the 1 came first and the 400 overpaid what was left.
  assert.equal(replayLocalAudit({ ...state, events: [...state.events, extra], legacyCount: 3 }).rows.length, 3);
  extra.row.amount = extra.row.ledger_amount = 400;
  assert.throws(() => replayLocalAudit({ ...state, opening: 1000, events: [...state.events, extra], legacyCount: 3 }), /legacy local audit funding/);
  const following = structuredClone(extra);
  assert.throws(() => replayLocalAudit({ ...state, opening: 1000, events: [...state.events, following] }), /follows a completed source/);
  extra.source.row.amount = 1000;
  assert.throws(() => replayLocalAudit({ ...state, events: [...state.events, extra], legacyCount: 3 }), /Legacy source evidence is inconsistent/);
});

test("retired source identifiers cannot be reused for another financial entity kind", () => {
  const state = fixture();
  const extra = structuredClone(state.events[1]);
  extra.id = extra.row.id = "reused-kind";
  delete extra.row.source_one_off_id;
  extra.row.source_goal_id = "income";
  extra.row.amount = extra.row.ledger_amount = 1;
  extra.row.occurrence_key = "goal:income:goal_allocation:2026-06-02";
  extra.source = { table: "goals", row: { id: "income", name: "Reused", currency: "PLN", amount: 10,
    active: 1, due_date: "2026-06-02", planned_transaction_id: "plan" }, plan: { id: "plan", goal_priority: 1 } };
  assert.throws(() => replayLocalAudit({ ...state, events: [...state.events, extra] }), /identity changed entity kind/);
});
