import assert from "node:assert/strict";
import test from "node:test";

import { renderCashflowModalFields } from "../public/app/cashflow/modal-fields.js";
import { renderLedgerTab } from "../public/app/cashflow/ledger-tab.js";
import { renderSettingsTab } from "../public/app/cashflow/settings-tab.js";
import { loadLocale } from "../public/app/cashflow/shared.js";
import { renderTransactionTable } from "../public/app/cashflow/transactions.js";

function assertNoMojibake(html) {
  assert.equal(/[\u00c4\u0102\u0139\u00e2\u00c2]/u.test(html), false, html);
}

test("settings render uses localized Polish labels and no mojibake", async () => {
  await loadLocale("pl");

  const html = renderSettingsTab("pl", {
    settings: {
      locale: "pl",
      ledger_currency: "PLN",
      future_periods: 11,
      fx_provider: "manual",
      fx_used_currencies: ["EUR"],
      manual_fx_rates: { EUR: 4.2 },
      notification_delivery_time: "08:00"
    },
    availableLocales: [
      { id: "en", label: "English" },
      { id: "pl", label: "Polski" }
    ],
    recurringIncomes: []
  });

  assert.match(html, />Ustawienia</);
  assert.match(html, new RegExp(">J\\u0119zyk<"));
  assert.match(html, />Waluta i kurs</);
  assert.match(html, new RegExp(">\\s*Kursy r\\u0119czne\\s*<"));
  assert.match(html, new RegExp(">U\\u017cywane waluty<"));
  assertNoMojibake(html);
});

test("modal select labels are localized while submitted enum values stay raw", async () => {
  await loadLocale("pl");

  const recurringHtml = renderCashflowModalFields("pl", "recurring-expense", {}, {
    recurringExpenses: [],
    flexTransactions: [],
    goals: []
  });
  const oneOffHtml = renderCashflowModalFields("pl", "one-off", {}, null);

  assert.match(recurringHtml, new RegExp('value="fixed"[^>]*>Sta\\u0142a<'));
  assert.match(recurringHtml, new RegExp('value="12month_max"[^>]*>Maksimum z 12 miesi\\u0119cy<'));
  assert.match(recurringHtml, /value="previous"[^>]*>Poprzedni</);
  assert.match(recurringHtml, new RegExp('value="next"[^>]*>Nast\\u0119pny<'));
  assert.match(recurringHtml, />\s*PL - Polska\s*</);
  assert.match(recurringHtml, />\s*DE - Niemcy\s*</);
  assert.match(oneOffHtml, /value="expense"[^>]*>Wydatek</);
  assert.match(oneOffHtml, new RegExp('value="income"[^>]*>Doch\\u00f3d<'));
  assertNoMojibake(recurringHtml);
  assertNoMojibake(oneOffHtml);
});

test("transaction table renders localized labels and ledger-currency equivalents", async () => {
  await loadLocale("en");

  const html = renderTransactionTable([
    {
      id: "tx-1",
      entityType: "future",
      date: "2026-06-01",
      name: "Foreign expense",
      type: "expense",
      status: "funded",
      amount: 10,
      currency: "EUR",
      amount_ledger_amount: 44,
      ledger_currency: "PLN",
      ledger_amount: 44,
      running_balance: 956
    }
  ], "en", {
    entityType: "future",
    canEdit: false
  });

  assert.match(html, /class="cashflow-table-wrap"/);
  assert.match(html, /Ledger amount/);
  assert.match(html, /Running balance/);
  assert.match(html, /10\.00 EUR/);
  assert.match(html, /\(44\.00 PLN\)/);
  assert.match(html, /956\.00 PLN/);
  assertNoMojibake(html);
});

test("ledger future rows can move to pending from every generated period", async () => {
  await loadLocale("en");

  const html = renderLedgerTab("en", {
    pendingTransactions: [],
    confirmedTransactions: [],
    periodSummaries: [
      { period: "2026-06", start_date: "2026-06-01", end_date: "2026-06-30", income: 1000, expenses: 100 },
      { period: "2026-07", start_date: "2026-07-01", end_date: "2026-07-31", income: 1000, expenses: 100 }
    ],
    futureTransactions: [
      {
        id: "future-current",
        period: "2026-06",
        date: "2026-06-10",
        name: "Current period bill",
        type: "expense",
        status: "funded",
        amount: 100,
        currency: "PLN"
      },
      {
        id: "future-later",
        period: "2026-07",
        date: "2026-07-10",
        name: "Later period bill",
        type: "expense",
        status: "funded",
        amount: 100,
        currency: "PLN"
      }
    ]
  });

  assert.match(html, /data-cashflow-move-future-to-pending="future-current"/);
  assert.match(html, /data-cashflow-move-future-to-pending="future-later"/);
  assertNoMojibake(html);
});
