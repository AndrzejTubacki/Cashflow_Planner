import assert from "node:assert/strict";
import test from "node:test";
import { LINKED_PARTS, prepareLinkedSnapshot, prepareLinkedSnapshotJson } from "../../src/engine/linked-snapshot.js";

const stamp = "2026-05-20T08:00:00.000Z";
function parts() {
  return {
    // The complete whitelisted settings record a real bootstrap carries.
    settings: [{ ledger_currency: "PLN", timezone: "Europe/Warsaw", holiday_country: "PL", future_periods: 3, minimum_reserve_enabled: 0,
      minimum_reserve_amount: 0, budget_period_income_id: null, fx_buffer_percent: 0, manual_fx_rates: "{}", necessary_underfunded_repeat_days: 1 }],
    planning: [
      { table: "one_off_transactions", row: { id: "desk", name: "Desk", currency: "PLN", amount: 300, type: "expense", date: "2026-05-18", created_at: stamp, updated_at: stamp } },
      { table: "pending_transactions", row: { id: "pending-desk", name: "Desk", currency: "PLN", amount: 300, funded_amount: 300, type: "expense",
        date: "2026-05-18", occurrence_key: "one_off:desk:expense:2026-05-18", source_one_off_id: "desk", ledger_currency: "PLN", status: "pending",
        requested_amount: 300, fx_rate: 1, buffered_fx_rate: 1, ledger_amount: 300, period: "2026-05",
        created_at: stamp, updated_at: stamp } }
    ],
    ledger: [{ id: "pay", name: "Pay", currency: "PLN", amount: 1000, type: "income", date: "2026-05-01", confirmed_date: "2026-05-01",
      fx_rate: 1, buffered_fx_rate: 1, ledger_currency: "PLN", ledger_amount: 1000, running_balance_pln: 1000,
      occurrence_key: "manual:pay", created_at: stamp, updated_at: stamp }],
    "currency-events": [], fx: [], "ledger-audit": [], "fx-snapshot": [{ snapshot: null }]
  };
}
const linked = (pending, value = parts()) => prepareLinkedSnapshot({ budgetId: "linked", epoch: "e", revision: 7, parts: value, pending,
  today: "2026-05-20", generationTimestamp: stamp, idSeed: "linked-test" });

test("the accepted replica alone prepares a calculable snapshot with its cursor", () => {
  const snapshot = linked([]);
  assert.deepEqual(snapshot.linked, { epoch: "e", revision: 7, provisionalOperationIds: [], unapplied: [] });
  assert.equal(snapshot.request.openingBalance, 1000);
  assert.deepEqual(snapshot.request.tables.future_transactions, []);
});

test("a provisional confirmation moves the pending row into the ledger with recomputed balances", () => {
  const snapshot = linked([{ operationId: "op-1", kind: "occurrence.confirm",
    payload: { occurrenceKey: "one_off:desk:expense:2026-05-18", amount: 250, confirmedDate: "2026-05-19", fxRate: null } }]);
  assert.equal(snapshot.request.openingBalance, 750);
  assert.equal(snapshot.request.tables.pending_transactions.length, 0);
  const row = snapshot.request.predictionRows.find(value => value.id === "pending-desk");
  assert.deepEqual([row.date, row.amount, row.ledger_amount, row.running_balance_pln], ["2026-05-19", 250, 250, 750]);
});

test('a provisional payment reserves its source before a later queued delete and cross-kind create', () => {
  const id = '33333333-3333-4333-8333-333333333333';
  const value = parts();
  value.planning[0].row.id = id;
  value.planning[1].row.source_one_off_id = id;
  value.planning[1].row.occurrence_key = `one_off:${id}:expense:2026-05-18`;
  const snapshot = linked([
    { operationId: 'record', kind: 'occurrence.confirm', payload: {
      occurrenceKey: value.planning[1].row.occurrence_key, amount: 250, confirmedDate: '2026-05-19', fxRate: null } },
    { operationId: 'delete', kind: 'one-off.delete', payload: { id } },
    { operationId: 'reuse', kind: 'goal.create', payload: { id, name: 'Different purpose', currency: 'PLN', amount: 100,
      active: true, priority: 1, due_date: '2026-06-30' } }
  ], value);
  assert.deepEqual(snapshot.linked.unapplied, [{ operationId: 'reuse', reason: 'SOURCE_EXISTS' }]);
  assert.equal(snapshot.request.tables.goals.length, 0);
  assert.equal(snapshot.request.openingBalance, 750);
});

test("intents that cannot be previewed are reported, not guessed", () => {
  const snapshot = linked([
    { operationId: "a", kind: "goal.update", payload: { id: "missing", amount: 1 } },
    { operationId: "b", kind: "one-off.create", payload: { id: "desk", name: "Again", currency: "PLN", amount: 1, type: "expense", date: "2026-06-01" } },
    { operationId: "c", kind: "occurrence.confirm", payload: { occurrenceKey: "recurring:upcoming", amount: 1, confirmedDate: "2026-05-20", fxRate: null } },
    { operationId: "d", kind: "ledger.replace", payload: {} },
    { operationId: "e", kind: "one-off.delete", payload: { id: "desk" } }
  ]);
  assert.deepEqual(snapshot.linked.unapplied.map(item => [item.operationId, item.reason]),
    [["a", "SOURCE_NOT_FOUND"], ["b", "SOURCE_EXISTS"], ["c", "OCCURRENCE_NOT_PREVIEWED"], ["d", "UNSUPPORTED_OPERATION"]]);
  assert.deepEqual(snapshot.linked.provisionalOperationIds, ["e"]);
  // A deleted source takes its own pending occurrence with it.
  assert.deepEqual(snapshot.request.tables.one_off_transactions, []);
  assert.deepEqual(snapshot.request.tables.pending_transactions, []);
});

test("creates get the server's defaults and priority renumbering", () => {
  const snapshot = linked([
    { operationId: "1", kind: "flex.create", payload: { id: "fun", name: "Fun", currency: "PLN", amount: 100, allow_split: true, min_amount: 10, max_amount: null } },
    { operationId: "2", kind: "recurring-expense.create", payload: { id: "rent", name: "Rent", currency: "PLN", amount: 900, necessary: true, priority: 1 } },
    { operationId: "3", kind: "recurring-income.create", payload: { id: "salary", name: "Salary", currency: "PLN", amount: 4000, period_setting: true } }
  ]);
  const planned = Object.fromEntries(snapshot.request.tables.planned_transactions.map(row => [row.id, row.operating_priority]));
  assert.deepEqual(planned, { "planned-provisional-fun": 2, "planned-provisional-rent": 1 });
  const rent = snapshot.request.tables.recurring_expenses[0];
  assert.deepEqual([rent.necessary, rent.active, rent.anchor_type, rent.prediction_strategy, rent.anchor_holiday_country], [1, 1, "month_end", "fixed", "PL"]);
  assert.equal(snapshot.request.settings.budget_period_income_id, "salary");
});

test("malformed replicas are refused through the JSON bridge", () => {
  for (const broken of [{ ...parts(), "fx-snapshot": undefined }, { ...parts(), settings: [] },
    { ...parts(), planning: [{ table: "users", row: { id: "x" } }] }]) {
    const response = JSON.parse(prepareLinkedSnapshotJson(JSON.stringify({ budgetId: "linked", epoch: "e", revision: 1, parts: broken,
      today: "2026-05-20", generationTimestamp: stamp, idSeed: "x" })));
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "LINKED_SNAPSHOT_REJECTED");
  }
  assert.equal(LINKED_PARTS.length, 7);
});

// Settings previews must change calculation inputs, not merely their display fields.
test("settings intentions select and clear the period income without touching accepted rows", () => {
  const value = parts();
  const create = { operationId: "income", kind: "recurring-income.create", payload: { id: "salary", name: "Salary", currency: "PLN", amount: 1000 } };
  const select = { operationId: "settings", kind: "settings.update", payload: { budget_period_income_id: "salary", future_periods: 6 } };
  const selected = linked([create, select], value);
  assert.equal(selected.request.settings.budget_period_income_id, "salary");
  assert.equal(selected.request.tables.recurring_incomes[0].period_setting, 1);
  assert.equal(selected.request.settings.future_periods, 6);
  const cleared = linked([create, select, { operationId: "clear", kind: "settings.update", payload: { budget_period_income_id: null } }], value);
  assert.equal(cleared.request.tables.recurring_incomes[0].period_setting, 0);
  const missing = linked([{ ...select, payload: { budget_period_income_id: "gone", future_periods: 12 } }], value);
  assert.deepEqual(missing.linked.unapplied, [{ operationId: "settings", reason: "SOURCE_NOT_FOUND" }]);
  assert.equal(missing.request.settings.future_periods, 3);
  assert.equal(value.settings[0].budget_period_income_id, null);
});

test("manual-provider settings intentions replace planning rates while retaining accepted FX and money", () => {
  const value = parts();
  value.settings[0].fx_provider = "manual";
  value["fx-snapshot"][0].snapshot = { eur: { rate: 4, source: "manual", effectiveDate: "2026-05-01" } };
  const accepted = JSON.stringify(value);
  const snapshot = linked([{ operationId: "settings", kind: "settings.update", payload: { manual_fx_rates: { "EUR/PLN": 4.3 }, fx_buffer_percent: 10 } },
    { operationId: "foreign", kind: "one-off.create", payload: { id: "foreign", name: "Foreign", currency: "EUR", amount: 10, type: "expense", date: "2026-06-01" } }], value);
  assert.equal(snapshot.request.fxSnapshot["eur/pln"].rate, 4.3);
  assert.equal(snapshot.request.fxSnapshot.eur, undefined);
  assert.equal(snapshot.request.openingBalance, 1000);
  assert.equal(JSON.stringify(value), accepted);
  assert.equal(linked([{ operationId: "clear", kind: "settings.update", payload: { manual_fx_rates: {} } }], value).request.fxSnapshot.eur, undefined);
});

test("manual overrides do not replace cached provider rates when the server uses NBP", () => {
  const value = parts();
  value.settings[0].fx_provider = "nbp";
  value["fx-snapshot"][0].snapshot = { eur: { rate: 4.2, source: "nbp", effectiveDate: "2026-05-19" } };
  const snapshot = linked([{ operationId: "settings", kind: "settings.update", payload: { manual_fx_rates: { EUR: 4.3 } } }], value);
  assert.deepEqual(snapshot.request.fxSnapshot, value["fx-snapshot"][0].snapshot);
});
