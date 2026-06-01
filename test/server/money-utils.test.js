import test from "node:test";
import assert from "node:assert/strict";

import {
  applyFxBuffer,
  getBufferedFxForCurrency,
  getFxRateForPair,
  getFxRateForCurrency,
  normalizeCurrency,
  nullablePositiveAmount,
  toLedgerAmount
} from "../../src/server/cashflow-money-utils.js";

test("normalizeCurrency defaults to PLN and uppercases values", () => {
  assert.equal(normalizeCurrency(" eur "), "EUR");
  assert.equal(normalizeCurrency(""), "PLN");
  assert.equal(normalizeCurrency(null), "PLN");
});

test("getFxRateForCurrency returns 1 for PLN", () => {
  assert.equal(getFxRateForCurrency("PLN", { ledger_currency: "PLN" }, null), 1);
});

test("getFxRateForCurrency supports non-PLN ledger currencies", () => {
  assert.equal(
    getFxRateForCurrency("PLN", { ledger_currency: "EUR" }, {
      "pln/eur": { rate: 0.25 }
    }),
    0.25
  );
});

test("getFxRateForPair derives rates through PLN legs", () => {
  assert.equal(
    getFxRateForPair("EUR", "USD", {
      eur: { rate: 4 },
      usd: { rate: 5 }
    }),
    0.8
  );
});

test("getFxRateForCurrency requires a valid non-PLN rate", () => {
  assert.throws(
    () => getFxRateForCurrency("EUR", { ledger_currency: "PLN" }, {}),
    /Missing FX rate/
  );
});

test("FX buffer is conservative for income and expenses", () => {
  const settings = { fx_buffer_percent: 10 };

  assert.equal(applyFxBuffer(4, settings, "income"), 3.6);
  assert.equal(applyFxBuffer(4, settings, "expense"), 4.4);
});

test("getBufferedFxForCurrency does not buffer PLN", () => {
  assert.deepEqual(
    getBufferedFxForCurrency("PLN", { fx_buffer_percent: 25 }, null, "expense"),
    {
      fx: 1,
      buffered: 1
    }
  );
});

test("toLedgerAmount does not buffer ledger-currency transactions", () => {
  assert.deepEqual(
    toLedgerAmount(
      100,
      "PLN",
      { ledger_currency: "PLN", fx_buffer_percent: 50 },
      { pln: { rate: 1 } },
      "expense"
    ),
    {
      rawRate: 1,
      effectiveRate: 1,
      ledgerAmount: 100
    }
  );
});

test("toLedgerAmount uses buffered rate", () => {
  assert.deepEqual(
    toLedgerAmount(
      100,
      "EUR",
      { ledger_currency: "PLN", fx_buffer_percent: 5 },
      { eur: { rate: 4 } },
      "expense"
    ),
    {
      rawRate: 4,
      effectiveRate: 4.2,
      ledgerAmount: 420
    }
  );
});

test("nullablePositiveAmount accepts zero and positive numbers only", () => {
  assert.equal(nullablePositiveAmount(""), null);
  assert.equal(nullablePositiveAmount("-1"), null);
  assert.equal(nullablePositiveAmount("0"), 0);
  assert.equal(nullablePositiveAmount("12.34"), 12.34);
});
