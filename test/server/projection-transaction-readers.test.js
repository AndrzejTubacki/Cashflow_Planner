import assert from "node:assert/strict";
import test from "node:test";
import { createCashflowProjectionStateService } from "../../src/server/cashflow-projection-state-service.js";
import { createCashflowPredictionService } from "../../src/server/cashflow-prediction-service.js";
import { createCashflowFxCacheService } from "../../src/server/cashflow-fx-cache-service.js";
import { createCashflowLedgerService } from "../../src/server/cashflow-ledger-service.js";

/** Fail immediately if a composed helper accidentally reopens default storage. */
function forbiddenStore() {
  return new Proxy({}, { get: () => () => { throw new Error("Unbound storage read"); } });
}

test("projection history helpers use the supplied reader for ledger years, occurrences and installments", async () => {
  const rows = [{ id: "payment", type: "income", amount: 30, currency: "PLN", date: "2026-06-02",
    ledger_currency: "PLN", ledger_amount: 30, running_balance_pln: 30,
    occurrence_key: "oneoff:bill", source_one_off_id: "bill" }];
  const calls = [];
  const reader = {
    async listLedgerYears(budget) { assert.equal(budget, "budget"); return [2026]; },
    async listConfirmedTransactions(budget, options) {
      calls.push({ budget, options }); return rows;
    }
  };
  const state = createCashflowProjectionStateService({ budgetStore: forbiddenStore() });
  assert.deepEqual([...await state.confirmedOccurrenceKeysAsync("budget", reader)], ["oneoff:bill"]);
  const progress = await state.confirmedOneOffProgressAsync("budget", reader);
  assert.equal(progress.get("bill:income:PLN").confirmedAmount, 30);
  assert.equal(progress.get("bill:income:PLN").confirmedCount, 1);
  assert.deepEqual(await state.confirmedRowsAfterDateAsync("budget", "2026-06-01", { ledger_currency: "PLN" }, reader), rows);
  assert.equal(await state.confirmedBalanceAsOfAsync("budget", "2026-06-02", { ledger_currency: "PLN" }, reader), 30);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(call => call.budget === "budget" && call.options.ledgerYear === 2026));
});

test("prediction reader injection preserves date filtering, ordering and explicit-row overrides", async () => {
  const reader = { async listConfirmedTransactions() { return [
    { id: "new", date: "2026-06-01" }, { id: "old", date: "2024-01-01" }, { id: "middle", date: "2026-01-01" }
  ]; } };
  const service = createCashflowPredictionService({ budgetStore: forbiddenStore() });
  assert.deepEqual((await service.confirmedRowsForPredictionAsync("budget", "2026-06-02", null, reader)).map(row => row.id), ["middle", "new"]);
  const explicit = [{ id: "explicit", date: "2024-01-01" }];
  assert.equal(await service.confirmedRowsForPredictionAsync("budget", "2026-06-02", explicit, forbiddenStore()), explicit);
});

test("transactional FX policy and cache cannot fall back to another store or host provider", async () => {
  const calls = [];
  const reader = { async listPlanningRows(budget, table) {
    calls.push({ budget, table });
    assert.equal(table, "settings");
    return [{ id: 1, ledger_currency: "PLN", timezone: "UTC", fx_provider: "disabled" }];
  } };
  const service = createCashflowFxCacheService({ budgetStore: forbiddenStore(),
    getCurrentFxSnapshot: () => { throw new Error("Disabled host provider was called"); } });
  assert.equal(await service.safeGetCurrentFxSnapshotAsync("budget", reader), null);
  const snapshot = await service.getCachedFxSnapshotAsync("budget", "2026-06-02", reader);
  assert.equal(snapshot.pln.rate, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.budget === "budget"));
});

test("locked negative-ledger checks use the injected writer rather than default history", async () => {
  const ledger = createCashflowLedgerService({ budgetStore: forbiddenStore() });
  const reader = { async listConfirmedTransactions(id) {
    assert.equal(id, "budget"); return [{ id: "income", amount: 10, type: "income", date: "2026-06-01",
      created_at: "2026-06-01T00:00:00Z", ledger_currency: "PLN", ledger_amount: 10 }];
  } };
  const candidate = { id: "expense", amount: 11, type: "expense", date: "2026-06-02",
    fx_rate: 1, buffered_fx_rate: 1, ledger_currency: "PLN" };
  assert.equal(await ledger.wouldLedgerGoNegativeAfterInsertAsync("budget", candidate, { ledgerCurrency: "PLN" }, reader), true);
  assert.equal(await ledger.wouldLedgerGoNegativeAfterInsertAsync("budget", { ...candidate, amount: 9 }, { ledgerCurrency: "PLN" }, reader), false);
});