import assert from "node:assert/strict";
import test from "node:test";
import { completeSnapshot } from "./fixtures.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { confirmLocalOccurrence, correctLocalConfirmation, refreshLocalSnapshot } from "../../src/engine/local-confirmation.js";
import { validateLocalPlanning } from "../../src/engine/local-validation.js";

const today = "2026-06-10";
const timing = { today, generationTimestamp: `${today}T12:00:00.000Z` };
const eurRate = { rate: 4.3, source: "manual", effectiveDate: "2026-06-09" };

function local({ fx = { "eur/pln": eurRate }, buffer, oneOffs } = {}) {
  const snapshot = completeSnapshot();
  snapshot.budgetId = "local-fx";
  Object.assign(snapshot.request, timing, { fxSnapshot: fx, openingBalance: 1000 });
  snapshot.request.settings = { ...snapshot.request.settings, ledger_currency: "PLN", ...(buffer === undefined ? {} : { fx_buffer_percent: buffer }) };
  Object.assign(snapshot.request.tables, { recurring_incomes: [], recurring_expenses: [], planned_transactions: [],
    one_off_transactions: oneOffs ?? [{ id: "hotel", name: "Hotel", amount: 100, currency: "EUR", date: today, type: "expense" }] });
  return snapshot;
}
const prepared = options => { const value = local(options); return refreshLocalSnapshot({ snapshot: value, ...value.request }); };
const due = snapshot => { const plan = calculateSnapshot(snapshot).plan; return [...plan.pendingRows, ...plan.futureRows].find(row => row.source_one_off_id === "hotel"); };
let seeds = 0;
const confirm = (snapshot, extra = {}) => confirmLocalOccurrence({ snapshot, occurrenceKey: due(snapshot).occurrence_key, ...timing, idSeed: `fx-${++seeds}`, ...extra });

test("stale provider rates remain usable for local planning but cannot record actual payments", () => {
  const snapshot = prepared({ fx: { "eur/pln": { rate: 4.3, source: "nbp", effectiveDate: "2026-05-09" } } });
  const before = JSON.stringify(snapshot);
  assert.equal(due(snapshot).ledger_amount, 430);
  assert.throws(() => confirm(snapshot), error => error.status === 409 && error.details.code === "stale_fx_rate" && error.details.ageDays === 32);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(confirm(snapshot, { fxRate: 4.25 }).localHistory[0].ledger_amount, 425, "explicit actual rates do not use the stale cache");
});

test("foreign sources need an explicit valid rate; nothing is derived", () => {
  assert.throws(() => validateLocalPlanning(local({ fx: null }).request), /Add an exchange rate for EUR to PLN/);
  assert.throws(() => validateLocalPlanning(local({ fx: { "usd/pln": eurRate } }).request), /Add an exchange rate for EUR/);
  assert.doesNotThrow(() => validateLocalPlanning(local().request));
  for (const fx of [{ "eur/usd": eurRate }, { "pln/pln": eurRate }, { "EUR/PLN": eurRate }, { "eur/pln": { ...eurRate, rate: 0 } },
    { "eur/pln": { ...eurRate, rate: "4.3" } }, { "eur/pln": { ...eurRate, source: "guess" } }, { "eur/pln": { ...eurRate, effectiveDate: "2026-02-30" } },
    { "eur/pln": { ...eurRate, extra: 1 } }, []]) {
    assert.throws(() => validateLocalPlanning(local({ fx }).request), /exchange rates|valid YYYY-MM-DD/, JSON.stringify(fx));
  }
  for (const buffer of [-1, 101, "2"]) assert.throws(() => validateLocalPlanning(local({ buffer }).request), /projection settings/);
});

test("projections apply the buffer; payments record the actual unbuffered or entered rate", () => {
  const snapshot = prepared({ buffer: 2 });
  assert.equal(due(snapshot).ledger_amount, 438.6); // 100 × 4.30 × 1.02
  const stored = confirm(snapshot);
  const [row] = stored.localHistory;
  assert.deepEqual([row.currency, row.ledger_currency, row.amount, row.fx_rate, row.buffered_fx_rate, row.ledger_amount], ["EUR", "PLN", 100, 4.3, 4.3, 430]);
  assert.equal(stored.request.openingBalance, 570);
  const entered = confirm(snapshot, { fxRate: 4.25, amount: 40 });
  assert.equal(entered.localHistory[0].ledger_amount, 170);
  assert.equal(refreshLocalSnapshot({ snapshot: entered, ...entered.request }).request.openingBalance, 830);
  for (const fxRate of [0, -1, Infinity, 2000000]) assert.throws(() => confirm(snapshot, { fxRate }), /positive number/);
  const plain = prepared({ oneOffs: [{ id: "hotel", name: "Local hotel", amount: 100, currency: "PLN", date: today, type: "expense" }] });
  assert.throws(() => confirm(plain, { fxRate: 4 }), /Same-currency payments have no exchange rate/);
});

test("retained foreign payments must keep ledger amount and rate consistent", () => {
  const paid = confirm(prepared());
  for (const change of [{ ledger_amount: 431 }, { buffered_fx_rate: 4.4 }, { fx_rate: 1 }, { ledger_currency: "EUR" }]) {
    const tampered = structuredClone(paid);
    Object.assign(tampered.localAudit[0].row, change);
    assert.throws(() => refreshLocalSnapshot({ snapshot: tampered, ...tampered.request }), /audit|altered/i, JSON.stringify(change));
  }
});

test("corrections keep the recorded rate unless a new one is entered", () => {
  const paid = confirm(prepared());
  const id = paid.localHistory[0].id;
  const correct = (snapshot, replacement, idSeed) => correctLocalConfirmation({ snapshot, confirmationId: id, expectedCorrectionId: null,
    reason: "Receipt", replacement, ...timing, idSeed });
  const kept = correct(paid, { amount: 80, date: today }, "c1");
  assert.deepEqual([kept.localHistory[0].fx_rate, kept.localHistory[0].ledger_amount], [4.3, 344]);
  const reentered = correct(paid, { amount: 80, date: today, fx_rate: 4.4 }, "c2");
  assert.deepEqual([reentered.localHistory[0].fx_rate, reentered.localHistory[0].ledger_amount], [4.4, 352]);
  assert.equal(refreshLocalSnapshot({ snapshot: reentered, ...reentered.request }).request.openingBalance, 648);
  assert.throws(() => correct(paid, { amount: 80, date: today, fx_rate: 0 }, "c3"), /exchange rate/);
});

test("a rate still used by planned sources cannot be removed, but history survives a removed rate", () => {
  const paid = confirm(prepared());
  const removed = structuredClone(paid); removed.request.fxSnapshot = null;
  assert.throws(() => refreshLocalSnapshot({ snapshot: removed, ...removed.request }), /Add an exchange rate for EUR/);
  // Once no source uses EUR, the payment's own recorded rate keeps history valid.
  removed.request.tables.one_off_transactions = [];
  assert.equal(refreshLocalSnapshot({ snapshot: removed, ...removed.request }).localHistory[0].ledger_amount, 430);
});
