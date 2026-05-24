import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeFxCurrencyList,
  normalizeFxProvider,
  normalizeManualFxRates
} from "../../src/server/cashflow-fx-provider-utils.js";

test("normalizeFxProvider defaults unknown providers to nbp", () => {
  assert.equal(normalizeFxProvider("manual"), "manual");
  assert.equal(normalizeFxProvider("frankfurter"), "frankfurter");
  assert.equal(normalizeFxProvider("unknown"), "nbp");
  assert.equal(normalizeFxProvider(""), "nbp");
});

test("normalizeFxCurrencyList accepts arrays and JSON strings", () => {
  assert.deepEqual(normalizeFxCurrencyList(["eur", "USD", "PLN", "EUR"]), ["EUR", "USD"]);
  assert.deepEqual(normalizeFxCurrencyList('["gbp","czk"]'), ["CZK", "GBP"]);
});

test("normalizeManualFxRates keeps only positive supported foreign rates", () => {
  assert.deepEqual(
    normalizeManualFxRates({
      eur: "4.25",
      usd: 0,
      pln: 1,
      nope: 7
    }),
    {
      EUR: 4.25
    }
  );
});
