import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderCashflowModalFields } from "../public/app/cashflow/modal-fields.js";
import { normalizeCashflowNumericInput } from "../public/app/cashflow/modal.js";
import { SUPPORTED_FX_CURRENCIES as FRONTEND_CURRENCIES } from "../public/app/cashflow/constants.js";
import { renderFundingOverview } from "../public/app/cashflow/funding.js";
import { renderLedgerTab } from "../public/app/cashflow/ledger-tab.js";
import { renderOneOffTab } from "../public/app/cashflow/one-off-tab.js";
import { renderCashflowPage } from "../public/app/cashflow/page.js";
import { renderAdminTab } from "../public/app/cashflow/admin-tab.js";
import { renderBudgetManagerTab } from "../public/app/cashflow/budget-manager-tab.js";
import {
  renderRecurringExpensesTab,
  renderRecurringIncomeTab
} from "../public/app/cashflow/recurring-tabs.js";
import { renderSettingsTab } from "../public/app/cashflow/settings-tab.js";
import { hasCapability, loadLocale, todayForCashflow } from "../public/app/cashflow/shared.js";
import {
  renderBudgetSelectionPage,
  renderSetupPage,
  renderUserSelectionPage
} from "../public/app/cashflow/session-pages.js";
import { renderGoalsTab } from "../public/app/cashflow/target-tabs.js";
import { renderTransactionTable } from "../public/app/cashflow/transactions.js";
import { SUPPORTED_FX_CURRENCIES as SERVER_CURRENCIES } from "../src/server/cashflow-fx-provider-utils.js";

function assertNoMojibake(html) {
  assert.equal(/[\u00c4\u0102\u0139\u00e2\u00c2]/u.test(html), false, html);
}

test("app background is rendered by a fixed root layer for expanded pages", async () => {
  const css = await readFile(new URL("../public/styles/base.css", import.meta.url), "utf8");

  assert.match(css, /--app-background:/);
  assert.match(css, /body\s*{[^}]*min-height:\s*100dvh/s);
  assert.match(css, /\.page-shell\s*{[^}]*min-height:\s*100dvh/s);
  assert.match(css, /\.page-shell::before\s*{[^}]*position:\s*fixed;[^}]*background:\s*var\(--app-background\);[^}]*background-size:\s*cover;/s);
  assert.doesNotMatch(css, /background-size:\s*100vw\s+100vh/);
});

test("session and setup pages render auth-ready controls", async () => {
  await loadLocale("en");

  const userHtml = renderUserSelectionPage({
    users: [
      { id: "local", display_name: "Local" }
    ]
  });

  assert.match(userHtml, /data-cashflow-user-selection/);
  assert.match(userHtml, /data-cashflow-select-user="local"/);
  assert.doesNotMatch(userHtml, /data-cashflow-select-account="local"/);
  assert.match(userHtml, /data-cashflow-create-user-form/);
  assert.match(userHtml, /name="userId"/);
  assert.match(userHtml, /Create and continue/);

  const accountHtml = renderUserSelectionPage({
    accounts: [
      { id: "account_owner", display_name: "Account Owner", status: "active" }
    ]
  });

  assert.match(accountHtml, /data-cashflow-select-account="account_owner"/);
  assert.doesNotMatch(accountHtml, /data-cashflow-select-user="account_owner"/);

  const internalLoginHtml = renderUserSelectionPage({
    auth: {
      activeMode: "internal",
      internal: {
        allowPasswordLogin: true,
        providers: [
          { id: "google", displayName: "Google", kind: "google", enabled: true }
        ]
      }
    }
  });
  assert.match(internalLoginHtml, /data-cashflow-internal-login-form/);
  assert.match(internalLoginHtml, /data-cashflow-provider-login="google"/);
  assert.match(internalLoginHtml, /Continue with Google/);
  assert.match(internalLoginHtml, /data-cashflow-password-token-form/);
  assert.match(internalLoginHtml, /data-cashflow-internal-register-form/);
  assert.match(internalLoginHtml, /name="invitationToken"/);
  assert.match(internalLoginHtml, /name="email" type="email"/);
  assert.match(internalLoginHtml, /name="password" type="password"/);
  assert.doesNotMatch(internalLoginHtml, /data-cashflow-create-account-form/);

  const externalLoginHtml = renderUserSelectionPage({
    auth: {
      activeMode: "external",
      external: {
        enabled: true
      }
    }
  });
  assert.match(externalLoginHtml, /data-cashflow-external-login/);
  assert.match(externalLoginHtml, /Continue with SSO/);
  assert.doesNotMatch(externalLoginHtml, /data-cashflow-create-account-form/);

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
  assert.equal(
    setupHtml.includes('inputmode="decimal" pattern="[0-9]+([.,][0-9]+)?" name="opening_balance" value="0"'),
    true
  );
  assert.match(setupHtml, /name="income_amount"/);
  assert.match(setupHtml, /Complete setup/);
  assertNoMojibake(userHtml);
  assertNoMojibake(internalLoginHtml);
  assertNoMojibake(externalLoginHtml);
  assertNoMojibake(setupHtml);
});

test("budget selection and manager render account-owned budget controls", async () => {
  await loadLocale("en");

  const selectionHtml = renderBudgetSelectionPage({
    account: {
      accountId: "owner",
      accountDisplayName: "Owner"
    },
    budgets: [
      { id: "budget-home", display_name: "Home", role: "owner", status: "active" }
    ]
  });
  assert.match(selectionHtml, /data-cashflow-budget-selection/);
  assert.match(selectionHtml, /data-cashflow-select-budget="budget-home"/);
  assert.match(selectionHtml, /data-cashflow-create-budget-form/);
  assert.match(selectionHtml, /data-cashflow-accept-invitation-form/);

  const managerHtml = renderBudgetManagerTab("en", {
    session: {
      accountId: "owner",
      budgetId: "budget-home",
      budgetRole: "owner"
    }
  }, {
    accounts: [
      { id: "member", display_name: "Member" }
    ],
    budgets: [
      { id: "budget-home", display_name: "Home", role: "owner", status: "active" },
      { id: "budget-side", display_name: "Side", role: "editor", status: "active" }
    ],
    members: [
      { account_id: "owner", display_name: "Owner", role: "owner", status: "active" },
      { account_id: "member", display_name: "Member", role: "editor", status: "active" }
    ],
    invitations: [
      { id: "invite-1", target_account_id: "member", role: "viewer", status: "pending", expires_at: "2026-06-10" }
    ],
    lastInvitation: {
      token: "copyable-token"
    }
  });

  assert.match(managerHtml, /data-cashflow-budget-manager/);
  assert.match(managerHtml, /data-cashflow-budget-select="budget-side"/);
  assert.match(managerHtml, /data-cashflow-budget-rename="budget-home"/);
  assert.match(managerHtml, /data-cashflow-member-transfer="member"/);
  assert.match(managerHtml, /data-cashflow-budget-invite-form/);
  assert.match(managerHtml, /copyable-token/);
  assert.match(managerHtml, /aria-label="New budget name"/);
  assert.match(managerHtml, /aria-label="Budget name"/);
  assert.match(managerHtml, /aria-label="Role: Member"/);
  assert.match(managerHtml, /aria-label="Invitation token"/);
  assertNoMojibake(selectionHtml);
  assertNoMojibake(managerHtml);
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

test("transaction amount fields accept comma decimals", async () => {
  await loadLocale("en");

  assert.equal(normalizeCashflowNumericInput("482,97"), "482.97");
  assert.equal(normalizeCashflowNumericInput("480.00"), "480.00");
  assert.equal(normalizeCashflowNumericInput("1,234.56"), "1,234.56");

  const oneOffHtml = renderCashflowModalFields("en", "one-off", {}, { today: "2026-06-03" });
  const pendingHtml = renderCashflowModalFields("en", "pending", {
    amount: 482.97,
    date: "2026-06-03"
  }, { today: "2026-06-03" });

  assert.match(oneOffHtml, /name="amount" type="text" inputmode="decimal"/);
  assert.match(pendingHtml, /name="amount" type="text" inputmode="decimal"/);
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

test("recurring tabs expose delete actions for recurring sources", async () => {
  await loadLocale("en");

  const cashflow = {
    settings: { ledger_currency: "PLN" },
    recurringExpenses: [
      {
        id: "rec-exp-rent",
        name: "Rent",
        amount: 2000,
        currency: "PLN",
        active: 1,
        necessary: 1,
        anchor: "15th",
        occurrence_total: 1,
        occurrence_funded_count: 1
      }
    ],
    recurringIncomes: [
      {
        id: "rec-inc-salary",
        name: "Salary",
        amount: 8000,
        currency: "PLN",
        active: 1,
        anchor: "26th"
      }
    ]
  };

  const expensesHtml = renderRecurringExpensesTab("en", cashflow);
  const incomeHtml = renderRecurringIncomeTab("en", cashflow);

  assert.match(expensesHtml, /data-cashflow-delete-tx="rec-exp-rent"/);
  assert.match(expensesHtml, /data-cashflow-delete-entity="recurring-expense"/);
  assert.match(incomeHtml, /data-cashflow-delete-tx="rec-inc-salary"/);
  assert.match(incomeHtml, /data-cashflow-delete-entity="recurring-income"/);
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
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab"/);
  assert.match(html, /aria-selected="true"/);
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

test("budget capabilities expose maintenance controls without exposing global administration", async () => {
  await loadLocale("en");
  const cashflow = {
    today: "2026-06-03",
    session: {
      userId: "budget-owner",
      permissions: [],
      capabilities: ["budget:maintain", "budget:validate"]
    },
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

  assert.equal(hasCapability(cashflow, "budget:maintain"), true);
  assert.equal(hasCapability(cashflow, "budget:backup"), false);

  const html = renderCashflowPage({ cashflow, activeTab: "ledger" });
  assert.doesNotMatch(html, /data-cashflow-tab="admin"/);
  assert.match(html, /data-cashflow-refresh-fx/);
  assert.match(html, /data-cashflow-validate/);
  assert.match(html, /data-cashflow-run-jobs/);
  assert.match(html, /data-cashflow-recalculate-pending/);
});

test("admin tab renders global options controls", async () => {
  await loadLocale("en");

  const html = renderAdminTab("en", {
    admin: {
      accounts: [
        {
          id: "admin-account",
          email: "admin@example.com",
          display_name: "Admin Account",
          status: "active",
          globalRoles: ["system_admin"],
          hasPasswordCredential: true,
          identities: [
            {
              provider_id: "external_test",
              subject: "proxy-subject-admin"
            }
          ],
          ownedBudgetCount: 1,
          membershipCount: 2,
          sessions: [
            {
              id: "session-one",
              auth_method: "none",
              last_seen_at: "2026-06-05T01:00:00.000Z"
            }
          ]
        },
        {
          id: "regular-account",
          email: "regular@example.com",
          display_name: "Regular Account",
          status: "disabled",
          globalRoles: [],
          hasPasswordCredential: false,
          ownedBudgetCount: 0,
          membershipCount: 0,
          sessions: []
        }
      ],
      authConfig: {
        activeMode: "none",
        draftMode: "external",
        sessionIdleMinutes: 60,
        sessionAbsoluteMinutes: 480,
        draftConfig: {
          external: {
            subjectHeader: "x-auth-request-user",
            emailHeader: "x-auth-request-email",
            displayNameHeader: "x-auth-request-name",
            groupsHeader: "x-auth-request-groups",
            trustedIssuer: "oauth2-proxy",
            provisioningMode: "deny_unknown",
            allowedDomains: ["example.com"],
            adminGroups: ["cashflow-admins"]
          },
          internal: {
            allowPasswordLogin: true
          }
        }
      },
      providers: [
        {
          id: "google",
          kind: "google",
          displayName: "Google",
          enabled: true,
          issuer: "https://accounts.google.com/",
          clientId: "google-client",
          secretConfigured: true,
          config: {
            redirectUri: "https://cashflow.example/api/auth/providers/google/callback",
            scope: "openid email profile"
          }
        }
      ],
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
  assert.match(html, /data-cashflow-admin-accounts/);
  assert.match(html, /data-cashflow-admin-account-name="admin-account"/);
  assert.match(html, /data-cashflow-admin-account-email="admin-account"/);
  assert.match(html, /data-cashflow-admin-external-subject="admin-account"/);
  assert.match(html, /proxy-subject-admin/);
  assert.match(html, /data-cashflow-admin-external-link="admin-account"/);
  assert.match(html, /value="admin@example.com"/);
  assert.match(html, /aria-label="Display name: Admin Account"/);
  assert.match(html, /data-cashflow-admin-account-rename="admin-account"/);
  assert.match(html, /data-cashflow-admin-password-token="admin-account" data-purpose="password_reset"/);
  assert.match(html, /data-cashflow-admin-password-token="regular-account" data-purpose="password_setup"/);
  assert.match(html, /data-cashflow-admin-password-token-output="admin-account"/);
  assert.match(html, /data-cashflow-admin-account-status="admin-account" data-next-status="disabled"/);
  assert.match(html, /data-cashflow-admin-account-status="regular-account" data-next-status="active"/);
  assert.match(html, /data-cashflow-admin-account-admin="admin-account" data-enabled="0"/);
  assert.match(html, /data-cashflow-admin-account-admin="regular-account" data-enabled="1"/);
  assert.match(html, /data-cashflow-admin-session-revoke="admin-account"/);
  assert.match(html, /data-session-id="session-one"/);
  assert.match(html, /No active sessions/);
  assert.match(html, /data-cashflow-admin-auth/);
  assert.match(html, /data-cashflow-admin-auth-form/);
  assert.match(html, /data-cashflow-admin-auth-providers/);
  assert.match(html, /data-cashflow-admin-provider-form/);
  assert.match(html, /data-cashflow-admin-provider-delete="google"/);
  assert.match(html, /name="providerId" value="google" required maxlength="80" readonly/);
  assert.match(html, /name="clientId" value="google-client"/);
  assert.match(html, /name="redirectUri" value="https:\/\/cashflow\.example\/api\/auth\/providers\/google\/callback"/);
  assert.match(html, /Secret configured/);
  assert.match(html, /name="draftMode"/);
  assert.match(html, /value="external" selected/);
  assert.match(html, /name="sessionIdleMinutes" type="number" min="5" max="10080" value="60"/);
  assert.match(html, /name="external.subjectHeader" value="x-auth-request-user"/);
  assert.match(html, /name="external.assertionSecretHeader" value="x-cashflow-auth-secret"/);
  assert.match(html, /name="external.assertionSecretEnv" value="CASHFLOW_EXTERNAL_AUTH_SECRET"/);
  assert.match(html, /name="external.allowedDomains" value="example\.com"/);
  assert.match(html, /data-cashflow-admin-auth-test/);
  assert.match(html, /data-cashflow-admin-auth-activate/);
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

test("ledger pending one-off remainders render an explicit dismiss action", async () => {
  await loadLocale("en");

  const html = renderLedgerTab("en", {
    session: {
      capabilities: ["budget:maintain"]
    },
    settings: { ledger_currency: "PLN" },
    periodSummaries: [],
    confirmedTransactions: [],
    futureTransactions: [],
    pendingTransactions: [
      {
        id: "pending-fotel-remainder",
        source_one_off_id: "oneoff-fotel",
        occurrence_key: "one_off_remainder:oneoff-fotel:2",
        date: "2026-06-01",
        name: "Fotel",
        type: "expense",
        status: "pending",
        amount: 2.97,
        currency: "PLN"
      },
      {
        id: "pending-regular",
        source_recurring_expense_id: "rec-disney",
        occurrence_key: "recurring_expense:rec-disney:2026-06-01",
        date: "2026-06-01",
        name: "Disney",
        type: "expense",
        status: "pending",
        amount: 60,
        currency: "PLN"
      }
    ]
  });

  assert.match(html, /data-cashflow-delete-tx="pending-fotel-remainder"/);
  assert.match(html, /data-cashflow-delete-entity="pending"/);
  assert.match(html, /Dismiss remainder/);
  assert.doesNotMatch(html, /data-cashflow-delete-tx="pending-regular"/);
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
