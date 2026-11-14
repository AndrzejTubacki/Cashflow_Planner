import assert from "node:assert/strict";
import test from "node:test";
import { completeSnapshot } from "./fixtures.js";
import { DEVICE_NOTIFICATION_TYPES, deviceNotifications, deviceNotificationsJson } from "../../src/engine/device-notifications.js";

function budget() {
  const snapshot = completeSnapshot();
  snapshot.request.openingBalance = 30;
  // Server settings say nothing; the device's own choice decides.
  snapshot.request.settings = { ledger_currency: "PLN", future_periods: 2, notify_necessary_underfunded: 0 };
  snapshot.request.tables.one_off_transactions = [{ id: "bill", name: "Bill", type: "expense", currency: "PLN", amount: 20, date: "2026-06-01" }];
  snapshot.request.tables.planned_transactions = [{ id: "plan-1", operating_priority: 1 }];
  snapshot.request.tables.recurring_expenses = [{ id: "rent", planned_transaction_id: "plan-1", active: 1, name: "Rent", currency: "PLN",
    amount: 100, necessary: 1, anchor_type: "day_of_month", anchor_day_of_month: 5, priority: 1, created_at: "2026-01-01" }];
  return snapshot;
}

test("device alerts follow the device's choices with structured values for wording", () => {
  const all = deviceNotifications({ snapshot: budget(), types: DEVICE_NOTIFICATION_TYPES });
  const underfunded = all.notifications.find(row => row.notification_type === "necessary_underfunded");
  assert.deepEqual(underfunded.params, { name: "Rent", amount: underfunded.params.amount, currency: "PLN" });
  assert.ok(Number(underfunded.params.amount) > 0);
  const pending = all.notifications.find(row => row.notification_type === "pending_summary");
  assert.deepEqual(pending.params, { count: 1 });
  assert.equal(pending.dedupe_key, "pending_summary:2026-06-01");
  assert.ok(all.summary.snapshot_timestamp);
  const some = deviceNotifications({ snapshot: budget(), types: ["pending_summary"] });
  assert.deepEqual(some.notifications.map(row => row.notification_type), ["pending_summary"]);
  assert.deepEqual(deviceNotifications({ snapshot: budget(), types: [] }).notifications, []);
});

test("necessary underfunded alerts repeat only per chosen interval", () => {
  const key = days => deviceNotifications({ snapshot: budget(), types: ["necessary_underfunded"], repeatDays: days })
    .notifications[0].dedupe_key;
  assert.match(key(1), /^necessary_underfunded:rent:bucket-\d+$/);
  assert.notEqual(key(1), key(7));
  assert.throws(() => deviceNotifications({ snapshot: budget(), types: [], repeatDays: 0 }), /Repeat interval/);
  assert.throws(() => deviceNotifications({ snapshot: budget(), types: ["spam"] }), /Unknown notification type/);
});

test("missing income: an income past its date and still unconfirmed, once per occurrence", () => {
  const snapshot = budget();
  snapshot.request.tables.one_off_transactions = [];
  snapshot.request.tables.recurring_incomes = [{ id: "salary", name: "Salary", amount: 1000, currency: "PLN", active: 1,
    anchor_type: "day_of_month", anchor_day_of_month: 10, prediction_strategy: "fixed", repeat_every_months: 1 }];
  const on = today => { const copy = structuredClone(snapshot); copy.request.today = today;
    return deviceNotifications({ snapshot: copy, types: ["income_missing"] }).notifications; };
  assert.deepEqual(on("2026-06-09"), [], "not due yet");
  assert.deepEqual(on("2026-06-10"), [], "due today is not missing yet");
  const missing = on("2026-06-12");
  assert.deepEqual(missing.map(row => [row.dedupe_key, row.params]),
    [["income_missing:salary:2026-06-10:2026-06-12", { name: "Salary", date: "2026-06-10" }]]);
  const confirmed = structuredClone(snapshot); confirmed.request.today = "2026-06-12";
  confirmed.request.handledOccurrenceKeys = ["recurring_income:salary:income:2026-06-10"];
  assert.deepEqual(deviceNotifications({ snapshot: confirmed, types: ["income_missing"] }).notifications, []);
});

test("an exchange-rate change that moves the forecast is reported against the previous check", () => {
  const snapshot = budget();
  snapshot.request.openingBalance = 3000;
  snapshot.request.tables.recurring_expenses[0].currency = "EUR";
  snapshot.request.fxSnapshot = { "eur/pln": { rate: 4, source: "manual", effectiveDate: "2026-06-01" } };
  const first = deviceNotifications({ snapshot, types: ["fx_changed"] });
  assert.deepEqual(first.notifications, []);
  const later = structuredClone(snapshot);
  later.request.fxSnapshot = { "eur/pln": { rate: 5, source: "manual", effectiveDate: "2026-06-01" } };
  const second = deviceNotifications({ snapshot: later, types: ["fx_changed"], previousSummary: first.summary });
  assert.deepEqual(second.notifications.map(row => row.notification_type), ["fx_changed"]);
  assert.equal(JSON.parse(deviceNotificationsJson("{}")).ok, false);
});
