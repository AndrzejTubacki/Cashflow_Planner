import assert from "node:assert/strict";
import test from "node:test";

import { renderCashflowModalFields } from "../public/app/cashflow/modal-fields.js";
import { SUPPORTED_FX_CURRENCIES as FRONTEND_CURRENCIES } from "../public/app/cashflow/constants.js";
import { renderFundingOverview } from "../public/app/cashflow/funding.js";
import { renderLedgerTab } from "../public/app/cashflow/ledger-tab.js";
import { renderOneOffTab } from "../public/app/cashflow/one-off-tab.js";
import { renderCashflowPage } from "../public/app/cashflow/page.js";
import { renderAdminTab } from "../public/app/cashflow/admin-tab.js";
import { renderSettingsTab } from "../public/app/cashflow/settings-tab.js";
import { loadLocale, todayForCashflow } from "../public/app/cashflow/shared.js";
import {
  renderSetupPage,
  renderUserSelectionPage
} from "../public/app/cashflow/session-pages.js";
import { renderGoalsTab } from "../public/app/cashflow/target-tabs.js";
import { renderTransactionTable } from "../public/app/cashflow/transactions.js";
import { SUPPORTED_FX_CURRENCIES as SERVER_CURRENCIES } from "../src/server/cashflow-fx-provider-utils.js";

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

test("frontend currency selectors share the complete server-supported list", async () => {
  await loadLocale("en");
  assert.deepEqual(FRONTEND_CURRENCIES, SERVER_CURRENCIES);

  const setupHtml = renderSetupPage({ cashflow: { settings: {}, availableLocales: [] } });
  const settingsHtml = renderSettingsTab("en", {
    session: { permissions: ["admin"] },
    settings: {},
    recurringIncomes: []
  });
  const adminHtml = renderAdminTab("en", { admin: { options: {} }, availableLocales: [] });
  const modalHtml = renderCashflowModalFields("en", "one-off", {}, { today: "2026-06-03" });

  for (const currency of SERVER_CURRENCIES) {
    const option = new RegExp(`value="${currency}"`);
    assert.match(setupHtml, option);
    assert.match(settingsHtml, option);
    assert.match(adminHtml, option);
    assert.match(modalHtml, option);
  }
});

test("frontend date defaults and one-off classification use the profile date", async () => {
  await loadLocale("en");

  assert.equal(todayForCashflow({ today: "2030-01-02" }), "2030-01-02");
  assert.equal(
    todayForCashflow(
      { settings: { timezone: "America/New_York" } },
      new Date("2026-05-20T02:59:00Z")
    ),
    "2026-05-19"
  );

  const cashflow = {
    today: "2030-01-02",
    settings: { timezone: "UTC" },
    oneOffs: [
      { id: "past", name: "Past item", type: "expense", amount: 1, currency: "PLN", date: "2030-01-01" },
      { id: "today", name: "Today item", type: "expense", amount: 1, currency: "PLN", date: "2030-01-02" }
    ]
  };
  const oneOffModal = renderCashflowModalFields("en", "one-off", {}, cashflow);
  const goalModal = renderCashflowModalFields("en", "goal", {}, cashflow);
  const oneOffTab = renderOneOffTab("en", cashflow);

  assert.match(oneOffModal, /name="date" type="date" value="2030-01-02"/);
  assert.match(goalModal, /name="due_date" type="date" value="2030-01-02"/);
  assert.ok(oneOffTab.indexOf("Today item") < oneOffTab.indexOf("Past item"));
});

test("page keeps transient errors visible and hides admin controls for non-admin users", async () => {
  await loadLocale("en");
  const cashflow = {
    today: "2026-06-03",
    session: { userId: "regular", permissions: [] },
    settings: { locale: "en", ledger_currency: "PLN" },
    pendingTransactions: [],
    confirmedTransactions: [],
    futureTransactions: [],
    periodSummaries: [],
    missingFxRates: ["EUR"],
    latestProjectionSnapshot: {
      generation_succeeded: 0,
      snapshot_timestamp: "2026-06-03T00:00:00.000Z"
    }
  };

  const html = renderCashflowPage({
    cashflow,
    activeTab: "admin",
    error: "Action failed"
  });

  assert.match(html, /data-cashflow-error-banner/);
  assert.match(html, /data-cashflow-dismiss-error/);
  assert.match(html, /data-cashflow-ledger-tab/);
  assert.doesNotMatch(html, /data-cashflow-tab="admin"/);
  assert.doesNotMatch(html, /data-cashflow-refresh-fx/);
  assert.doesNotMatch(html, /data-cashflow-validate/);
  assert.doesNotMatch(html, /data-cashflow-run-jobs/);
  assert.doesNotMatch(html, /data-cashflow-recalculate-pending/);

  const fatal = renderCashflowPage({ cashflow: null, error: "Load failed" });
  assert.match(fatal, /data-cashflow-logout/);
  assert.match(fatal, /Return to user selection/);

  const adminHtml = renderCashflowPage({
    cashflow: {
      ...cashflow,
      session: { userId: "admin", permissions: ["admin"] }
    },
    activeTab: "ledger"
  });
  assert.match(adminHtml, /data-cashflow-tab="admin"/);
  assert.match(adminHtml, /data-cashflow-refresh-fx/);
  assert.match(adminHtml, /data-cashflow-validate/);
  assert.match(adminHtml, /data-cashflow-run-jobs/);
  assert.match(adminHtml, /data-cashflow-recalculate-pending/);
});

test("admin tab renders global options controls", async () => {
  await loadLocale("en");

  const html = renderAdminTab("en", {
    admin: {
      options: {
        ledger_currency: "EUR",
        locale: "pl",
        timezone: "UTC",
        holiday_country: "DE",
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
  assert.match(html, /name="holiday_country"/);
  assert.match(html, /value="DE" selected/);
  assert.match(html, /Save global options/);
  assertNoMojibake(html);
});

test("settings render uses localized Polish labels and no mojibake", async () => {
  await loadLocale("pl");

  const html = renderSettingsTab("pl", {
    settings: {
      locale: "pl",
      ledger_currency: "PLN",
      holiday_country: "PL",
      minimum_reserve_enabled: 1,
      minimum_reserve_amount: 250,
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
  assert.match(html, /name="holiday_country"/);
  assert.match(html, /name="minimum_reserve_enabled"/);
  assert.match(html, /name="minimum_reserve_amount" value="250"/);
  assert.match(html, /data-cashflow-download-full-export/);
  assert.match(html, /data-cashflow-export-operational-settings/);
  assert.match(html, /data-cashflow-import-full/);
  assert.match(html, /data-cashflow-import-operational-settings/);
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
    session: {
      permissions: ["admin"]
    },
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

test("funding overview hides fully confirmed items and prioritizes missing projections before completion date", () => {
  const html = renderFundingOverview("en", {
    settings: {
      ledger_currency: "PLN"
    },
    goals: [
      {
        id: "confirmed-goal",
        name: "Fully confirmed",
        target_ledger_amount: 100,
        already_funded_ledger: 100,
        pending_allocated_ledger: 0,
        future_allocated_ledger: 0,
        remaining_ledger: 0,
        funded_by_date: null
      },
      {
        id: "later-goal",
        name: "Later projection",
        target_ledger_amount: 100,
        already_funded_ledger: 0,
        pending_allocated_ledger: 0,
        future_allocated_ledger: 100,
        remaining_ledger: 0,
        funded_by_date: "2026-09-01"
      },
      {
        id: "missing-goal",
        name: "Missing projection",
        target_ledger_amount: 100,
        already_funded_ledger: 20,
        pending_allocated_ledger: 0,
        future_allocated_ledger: 0,
        remaining_ledger: 80,
        funded_by_date: null
      }
    ],
    flexTransactions: [
      {
        id: "earlier-flex",
        name: "Earlier projection",
        target_ledger_amount: 100,
        already_funded_ledger: 0,
        pending_allocated_ledger: 100,
        future_allocated_ledger: 0,
        remaining_ledger: 0,
        funded_by_date: "2026-07-01"
      }
    ]
  });

  assert.doesNotMatch(html, /Fully confirmed/);
  assert.ok(html.indexOf("Missing projection") < html.indexOf("Earlier projection"));
  assert.ok(html.indexOf("Earlier projection") < html.indexOf("Later projection"));
  assert.match(html, /cashflow-funding-overview--collapsed/);
  assert.equal((html.match(/data-cashflow-funding-item/g) || []).length, 3);
  assert.match(html, /data-cashflow-toggle-funding/);
  assert.match(html, /Show all/);
  assert.match(html, /Show less/);
});
