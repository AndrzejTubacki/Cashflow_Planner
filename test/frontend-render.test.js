import assert from "node:assert/strict";
import test from "node:test";

import { renderCashflowModalFields } from "../public/app/cashflow/modal-fields.js";
import { renderLedgerTab } from "../public/app/cashflow/ledger-tab.js";
import { renderAdminTab } from "../public/app/cashflow/admin-tab.js";
import { renderSettingsTab } from "../public/app/cashflow/settings-tab.js";
import { loadLocale } from "../public/app/cashflow/shared.js";
import {
  renderSetupPage,
  renderUserSelectionPage
} from "../public/app/cashflow/session-pages.js";
import { renderGoalsTab } from "../public/app/cashflow/target-tabs.js";
import { renderTransactionTable } from "../public/app/cashflow/transactions.js";

function assertNoMojibake(html) {
  assert.equal(/[\u00c4\u0102\u0139\u00e2\u00c2]/u.test(html), false, html);
}

test("session and setup pages render auth-ready controls", async () => {
  await loadLocale("en");

  const userHtml = renderUserSelectionPage({
    users: [
      { id: "local", display_name: "Local" }
    ]
  });

  assert.match(userHtml, /data-cashflow-user-selection/);
  assert.match(userHtml, /data-cashflow-select-user="local"/);
  assert.match(userHtml, /data-cashflow-create-user-form/);
  assert.match(userHtml, /name="userId"/);
  assert.match(userHtml, /Create and continue/);

  const setupHtml = renderSetupPage({
    cashflow: {
      session: {
        userId: "setup-user",
        displayName: "Setup User"
      },
      settings: {
        ledger_currency: "USD",
        locale: "en",
        timezone: "UTC",
        future_periods: 6
      },
      availableLocales: [
        { id: "en", label: "English" },
        { id: "pl", label: "Polski" }
      ]
    }
  });

  assert.match(setupHtml, /data-cashflow-setup/);
  assert.match(setupHtml, /data-cashflow-setup-form/);
  assert.match(setupHtml, /data-cashflow-logout/);
  assert.match(setupHtml, /name="opening_balance"/);
  assert.match(setupHtml, /name="income_amount"/);
  assert.match(setupHtml, /Complete setup/);
  assertNoMojibake(userHtml);
  assertNoMojibake(setupHtml);
});

test("admin tab renders global options controls", async () => {
  await loadLocale("en");

  const html = renderAdminTab("en", {
    admin: {
      options: {
        ledger_currency: "EUR",
        locale: "pl",
        timezone: "UTC",
        future_periods: 9,
        fx_provider: "manual",
        fx_buffer_percent: 3
      }
    },
    availableLocales: [
      { id: "en", label: "English" },
      { id: "pl", label: "Polski" }
    ]
  });

  assert.match(html, /data-cashflow-admin-options-form/);
  assert.match(html, /name="ledger_currency"/);
  assert.match(html, /value="EUR" selected/);
  assert.match(html, /name="fx_provider"/);
  assert.match(html, /Save global options/);
  assertNoMojibake(html);
});

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
  assert.match(html, />Strefa czasowa</);
  assert.match(html, />Przenoszenie danych</);
  assert.match(html, /data-cashflow-download-full-export/);
  assert.match(html, /data-cashflow-import-full/);
  assert.match(html, /data-cashflow-import-oneoff-csv/);
  assert.match(html, /data-cashflow-download-ledger-csv/);
  assert.match(html, /data-cashflow-download-sample/);
  assert.match(html, /data-cashflow-load-sample/);
  assert.match(html, /Kolumny CSV: name,type,amount,currency,date/);
  assert.match(html, new RegExp(">\\s*Kursy r\\u0119czne\\s*<"));
  assert.match(html, new RegExp(">U\\u017cywane waluty<"));
  assertNoMojibake(html);
});

test("settings render supports non-PLN ledger manual pair rates", async () => {
  await loadLocale("en");

  const html = renderSettingsTab("en", {
    settings: {
      locale: "en",
      ledger_currency: "USD",
      future_periods: 11,
      fx_provider: "manual",
      fx_used_currencies: ["PLN", "EUR"],
      manual_fx_rates: {
        "PLN/USD": 0.25,
        "EUR/USD": 1.1
      },
      notification_delivery_time: "08:00"
    },
    availableLocales: [
      { id: "en", label: "English" }
    ],
    recurringIncomes: []
  });

  assert.match(html, /PLN \/ USD/);
  assert.match(html, /EUR \/ USD/);
  assert.match(html, /name="timezone"/);
  assert.match(html, /value="0\.25"/);
  assert.match(html, /value="1\.1"/);
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
  assert.match(recurringHtml, new RegExp(">Zast\\u0105p brakuj\\u0105ce przez<"));
  assert.match(recurringHtml, new RegExp('value="starting_value"[^>]*>Warto\\u015b\\u0107 pocz\\u0105tkowa<'));
  assert.match(recurringHtml, new RegExp('value="average_extreme_starting_value"[^>]*>\\u015arednia z warto\\u015bci skrajnej i pocz\\u0105tkowej<'));
  assert.match(recurringHtml, new RegExp('value="median_recorded"[^>]*>Mediana zapisanych warto\\u015bci<'));
  assert.match(recurringHtml, new RegExp('value="last_confirmed"[^>]*>Ostatnio potwierdzona<'));
  assert.match(recurringHtml, new RegExp('value="previous_year_same_month"[^>]*>Ten sam miesi\\u0105c poprzedniego roku<'));
  assert.match(recurringHtml, new RegExp('value="require_min_recorded_months"[^>]*>Wymagaj minimalnej liczby zapisanych miesi\\u0119cy<'));
  assert.match(recurringHtml, new RegExp(">Minimalna liczba zapisanych miesi\\u0119cy<"));
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
  assert.match(html, /data-cashflow-recalculate-pending/);
  assertNoMojibake(html);
});

test("ledger summaries and targets render the active ledger currency", async () => {
  await loadLocale("en");

  const ledgerHtml = renderLedgerTab("en", {
    settings: {
      ledger_currency: "USD"
    },
    pendingTransactions: [],
    confirmedTransactions: [],
    periodSummaries: [
      { period: "2026-06", start_date: "2026-06-01", end_date: "2026-06-30", income: 1000, expenses: 100 }
    ],
    futureTransactions: [
      {
        id: "future-usd",
        period: "2026-06",
        date: "2026-06-10",
        name: "USD bill",
        type: "expense",
        status: "funded",
        amount: 100,
        currency: "USD",
        ledger_currency: "USD"
      }
    ]
  });

  const goalsHtml = renderGoalsTab("en", {
    settings: {
      ledger_currency: "USD"
    },
    goals: [
      {
        id: "goal-usd",
        name: "Goal",
        amount: 100,
        currency: "EUR",
        priority: 1,
        due_date: "2026-06-30",
        target_ledger_amount: 120,
        remaining_ledger: 40,
        already_funded_ledger: 80,
        pending_allocated_ledger: 0,
        future_allocated_ledger: 0
      }
    ]
  });

  assert.match(ledgerHtml, /1,000\.00 USD/);
  assert.match(ledgerHtml, /100\.00 USD/);
  assert.match(goalsHtml, /Target in ledger currency/);
  assert.match(goalsHtml, /120\.00 USD/);
  assert.doesNotMatch(goalsHtml, /Target in PLN/);
  assertNoMojibake(ledgerHtml);
  assertNoMojibake(goalsHtml);
});
