import assert from "node:assert/strict";
import test from "node:test";
import { assertFxRateFresh, assertSnapshotFxRateFresh } from "../../src/engine/cashflow-fx-freshness.js";
import { createCashflowConfirmedFxService } from "../../src/server/cashflow-confirmed-fx-service.js";

const date = "2026-11-14";
const stale = { rate: 4.2, rateDate: "2026-10-13", effectiveDate: "2026-10-12", source: "nbp" };
const fresh = { rate: 4, effectiveDate: date, source: "nbp" };

test("14-day boundary, same-currency and manual exceptions keep the existing policy", () => {
  assert.doesNotThrow(() => assertFxRateFresh(date, "2026-10-31", "EUR", "PLN", "nbp"));
  assert.throws(() => assertFxRateFresh(date, "2026-10-30", "EUR", "PLN", "nbp"), error => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { code: "stale_fx_rate", pair: "EUR/PLN", rateDate: "2026-10-30", ageDays: 15 });
    assert.match(error.message, /Refresh exchange rates/);
    return true;
  });
  assert.doesNotThrow(() => assertFxRateFresh(date, "2020-01-01", "EUR", "PLN", "manual"));
  assert.doesNotThrow(() => assertFxRateFresh(date, "2020-01-01", "PLN", "PLN", "nbp"));
});

test("snapshot money checks validate the selected direct pair and both derived legs, ignoring unrelated stale pairs", () => {
  assert.doesNotThrow(() => assertSnapshotFxRateFresh({ "eur/pln": fresh, "usd/pln": stale }, date, "EUR", "PLN"));
  assert.throws(() => assertSnapshotFxRateFresh({ "eur/pln": stale }, date, "EUR", "PLN"), error => error.details.ageDays === 32);
  for (const snapshot of [
    { "eur/pln": stale, "usd/pln": fresh },
    { "eur/pln": fresh, "usd/pln": stale }
  ]) assert.throws(() => assertSnapshotFxRateFresh(snapshot, date, "EUR", "USD"), error => error.details.code === "stale_fx_rate");
  assert.doesNotThrow(() => assertSnapshotFxRateFresh({ "eur/pln": stale, "usd/pln": stale, "eur/usd": fresh }, date, "EUR", "USD"));
  assert.doesNotThrow(() => assertSnapshotFxRateFresh({ "eur/pln": { ...stale, source: "manual" } }, date, "EUR", "PLN"));
});

test("confirmation host hooks cannot turn stale planning observations into actual ledger rates", async () => {
  const service = createCashflowConfirmedFxService({ getFxSnapshotForDate: async () => ({ "eur/pln": stale }) });
  await assert.rejects(service.getConfirmedFxForDate("EUR", date, { ledger_currency: "PLN", fx_provider: "nbp" }),
    error => error.status === 409 && error.details.code === "stale_fx_rate");
  assert.deepEqual(await service.getConfirmedFxForDate("PLN", date, { ledger_currency: "PLN" }), { fxRate: 1, bufferedFxRate: 1 });
  assert.deepEqual(await service.getConfirmedFxForDate("EUR", date, { ledger_currency: "PLN" }, { fx_rate: 4.1 }), { fxRate: 4.1, bufferedFxRate: 4.1 });
  assert.deepEqual(await service.getConfirmedFxForDate("EUR", date, { ledger_currency: "PLN", fx_provider: "manual" }), { fxRate: 4.2, bufferedFxRate: 4.2 });
});
