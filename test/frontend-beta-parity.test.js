import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { describeFullImportPreview } from "../frontend-beta/src/importPreview.js";
import {
  recurringExpensePredictionDisplay,
  transactionMoneyDisplay
} from "../frontend-beta/src/moneyDisplay.js";
import {
  lowestUnusedPriority, manualRateForCurrency, normalizeDecimalInput,
  observedFxCurrencies, parseProjectionFxRates, selectedManualRates, sortFundingEntries
} from "../frontend-beta/src/parity.js";
import { AVATAR_IDS, defaultAvatarId, resolvedAvatarId } from "../frontend-beta/src/avatar.js";
import { ACCOUNT_AVATAR_IDS } from "../src/server/cashflow-global-service.js";

const source = file => readFile(new URL(`../frontend-beta/src/${file}`, import.meta.url), "utf8");

test("beta full-import confirmation uses the real preview response fields", async () => {
  const description = describeFullImportPreview({
    mode: "replace",
    tables: {
      recurring_expenses: { exportRowCount: 4, currentRowCount: 2, defaultedColumns: ["anchor_income_id"] },
      goals: { exportRowCount: 1, currentRowCount: 3, defaultedColumns: [] }
    },
    ledgerYears: { export: ["2025", "2026"], current: ["2026"] },
    settingsChanges: [{ field: "holiday_country", from: "PL", to: "DE" }],
    conflicts: [{ table: "goals", id: "goal-1", reason: "duplicate id" }]
  });

  assert.match(description, /Mode: replace/);
  assert.match(description, /replace this budget's planning data, settings, and ledger years/i);
  assert.match(description, /recurring expenses: 4 \/ 2; defaults used for: anchor_income_id/);
  assert.match(description, /Ledger years in file: 2025, 2026/);
  assert.match(description, /holiday_country: PL → DE/);
  assert.match(description, /goals \/ goal-1: duplicate id/);

  const settingsView = await source("SettingsView.jsx");
  assert.match(settingsView, /describeFullImportPreview\(preview\)/);
  assert.doesNotMatch(settingsView, /rowCounts|mergeConflicts/);
});

test("beta transaction display preserves row ledger currency and partial funding", async () => {
  assert.deepEqual(transactionMoneyDisplay({
    amount: 40,
    funded_amount: 40,
    requested_amount: 100,
    currency: "EUR",
    ledger_amount: 176,
    ledger_currency: "PLN"
  }, "USD"), {
    currency: "EUR",
    displayAmount: 40,
    isPartiallyFunded: true,
    ledgerAmount: 176,
    ledgerCurrency: "PLN",
    requested: 100,
    runningBalanceCurrency: "PLN"
  });

  const ledgerView = await source("LedgerView.jsx");
  assert.match(ledgerView, /const status = tx\.status \|\| sectionStatus/);
  assert.match(ledgerView, /formatMessage\("of \{amount\} requested", \{ amount: formatMoney\(/);
  assert.match(ledgerView, /tx\.note/);
  assert.match(ledgerView, /tx\.warning/);
  assert.match(ledgerView, /money\.runningBalanceCurrency/);
});

test("beta parity helpers cover budget dates, decimal input, priorities, FX, and funding order", () => {
  assert.equal(normalizeDecimalInput("12,345"), 12.35);
  assert.equal(normalizeDecimalInput("not money"), null);
  assert.equal(lowestUnusedPriority([{ priority: 1 }, { priority: 3 }]), 2);
  assert.deepEqual(observedFxCurrencies({ oneOffs: [{ currency: "EUR" }], recurringExpenses: [{ currency: "USD" }] }, "PLN"), ["EUR", "USD"]);
  assert.equal(manualRateForCurrency({ "EUR/PLN": "4.25" }, "EUR", "PLN"), "4.25");
  assert.deepEqual(selectedManualRates({ "EUR/PLN": "4,25", USD: "4" }, ["EUR"], "PLN"), { EUR: 4.25 });
  assert.deepEqual(parseProjectionFxRates({ latestProjectionSnapshot: { fx_rates_used: '{"eur/pln":{"rate":4.2}}' } }, "PLN"), [{ pair: "EUR/PLN", rate: 4.2 }]);
  // Regression: a rate stored under both "EUR" and "EUR/PLN" is shown once.
  assert.deepEqual(
    parseProjectionFxRates({ latestProjectionSnapshot: { fx_rates_used: { EUR: 4.3889, "EUR/PLN": 4.3889, GBP: 5.1906, "GBP/PLN": 5.1906 } } }, "PLN"),
    [{ pair: "EUR/PLN", rate: 4.3889 }, { pair: "GBP/PLN", rate: 5.1906 }]
  );
  const sorted = sortFundingEntries([
    { name: "Later", item: { id: "2", funded_by_date: "2027-01-01" } },
    { name: "Missing", item: { id: "1", funded_by_date: null } }
  ]);
  assert.equal(sorted[0].name, "Missing");
});

test("remaining beta parity controls are explicit and persistent", async () => {
  const [budget, auth, app, menu, modal, priorities, settings, css] = await Promise.all([
    source("BudgetView.jsx"), source("AuthSetup.jsx"), source("App.jsx"), source("UserMenu.jsx"),
    source("EditModal.jsx"), source("PrioritiesView.jsx"), source("SettingsView.jsx"), source("styles.css")
  ]);
  assert.match(budget, /Save role/);
  assert.doesNotMatch(budget, /setTimeout\(\(\) => setLastToken/);
  assert.match(budget, /Revoke this invitation/);
  assert.match(budget, /required\s+maxLength=\{120\}/);
  assert.match(auth, /authorizationEndpoint/);
  assert.match(auth, /tokenEndpoint/);
  assert.match(auth, /userInfoEndpoint/);
  assert.match(settings, /beta-validation-panel/);
  assert.match(app, /api\.github\.com\/repos\/AndrzejTubacki\/Cashflow_Planner\/releases\/latest/);
  assert.doesNotMatch(menu, /Default landing tab|Switch budget|Validate data|Regenerate projections|Theme|Density/);
  assert.match(modal, /inputMode="decimal"/);
  assert.match(priorities, /Edit details/);
  assert.match(settings, /Rates used by the latest projection/);
  assert.match(css, /data-cashflow-density="compact"/);
});

test("beta settings use deep-linked tabs, a focused account menu, and admin-only update copy", async () => {
  const [app, menu, page, settings, shell] = await Promise.all([
    source("App.jsx"), source("UserMenu.jsx"), source("SettingsPage.jsx"), source("SettingsView.jsx"), source("Shell.jsx")
  ]);
  assert.match(app, /raw === "account"[\s\S]*"settings\/account"/);
  assert.match(app, /raw === "admin"[\s\S]*"settings\/admin"/);
  assert.match(app, /onSelectSettings=\{\(\) => selectSection\("settings\/account"\)\}/);
  assert.match(page, /"account"[\s\S]*"budget"[\s\S]*canAdmin[\s\S]*"admin"/);
  assert.doesNotMatch(menu, /Switch budget|Validate data|Regenerate projections|Theme|Density/);
  assert.match(menu, /Settings[\s\S]*Switch to legacy UI[\s\S]*Sign out/);
  assert.match(app, /canAdmin && versionCheck\.status === "available"/);
  assert.match(shell, /Update available: \{version\}/);
  assert.match(settings, /from !== to/);
});

test("account icons have a deterministic unsaved default and persist through the account API", async () => {
  assert.deepEqual(AVATAR_IDS, ACCOUNT_AVATAR_IDS);
  assert.equal(defaultAvatarId("same-account"), defaultAvatarId("same-account"));
  assert.ok(AVATAR_IDS.includes(defaultAvatarId("same-account")));
  assert.equal(resolvedAvatarId({ id: "same-account", avatar: "owl" }), "owl");
  const [account, menu] = await Promise.all([source("AccountView.jsx"), source("UserMenu.jsx")]);
  assert.match(account, /method: "PUT", body: \{ avatar \}/);
  assert.match(account, /role="radiogroup"/);
  assert.match(menu, /<AvatarIcon account=\{account/);
});

test("beta admin global options expose the private ntfy host allow-list", async () => {
  const admin = await source("AdminView.jsx");
  assert.match(admin, /Private ntfy hosts/);
  assert.match(admin, /ntfy_allowed_private_hosts: ntfyAllowedPrivateHosts/);
  assert.match(admin, /Only the exact hosts listed here are allowed, one per line/);
});

test("beta recurring expenses show current predictions and their ledger equivalents", async () => {
  assert.deepEqual(recurringExpensePredictionDisplay({
    amount: 50,
    currency: "EUR",
    current_prediction_amount: 65,
    current_prediction_ledger_amount: 286,
    ledger_currency: "PLN"
  }), {
    amount: 65,
    currency: "EUR",
    ledgerAmount: 286,
    ledgerCurrency: "PLN"
  });

  const recurringView = await source("RecurringView.jsx");
  const moneyDisplay = await source("moneyDisplay.js");
  assert.match(recurringView, /Current prediction:/);
  assert.match(recurringView, /recurringExpensePredictionDisplay/);
  assert.match(moneyDisplay, /current_prediction_ledger_amount/);
});

test("beta recurring expense defaults and conditional fields match the legacy rules", async () => {
  const modal = await source("EditModal.jsx");
  const recurring = await source("RecurringView.jsx");

  assert.match(modal, /necessary: source\.necessary \?\? false/);
  assert.match(modal, /settings\.holiday_country \?\? "PL"/);
  assert.match(modal, /usesPredictionHistory/);
  assert.match(modal, /usesMinimumHistory/);
  assert.match(modal, /usesHolidayCalendar/);
  // Start month is always editable (bounds every schedule) and only
  // required for multi-month repeats; end month is optional and clearable.
  assert.match(modal, /onChange=\{e => set\("start_month_year", e\.target\.value\)\}\s*required=\{repeatNeedsStart\}/);
  assert.match(modal, /body\.start_month_year = form\.start_month_year \|\| null/);
  assert.match(modal, /body\.end_month_year = form\.end_month_year \|\| null/);
  assert.match(modal, /set\("end_month_year", e\.target\.value\)/);
  assert.match(modal, /start_month_year: source\.start_month_year \?\? \(isCreate \? String\(today \?\? todayIso\(\)\)\.slice\(0, 7\) : ""\)/);
  assert.doesNotMatch(modal, /"2026-05"/);
  assert.match(recurring, /formatMessage\("Until \{month\}"/);
  assert.match(recurring, /settings=\{snapshot\?\.settings \|\| \{\}\}/);
});

test("beta renders global projection warnings with contextual recovery actions", async () => {
  const app = await source("App.jsx");
  const warnings = await source("ProjectionWarnings.jsx");

  assert.match(app, /<ProjectionWarnings snapshot=\{snapshot\} onRefresh=\{load\} \/>/);
  assert.match(warnings, /snapshot\?\.missingFxRates/);
  assert.match(warnings, /latestProjection\.generation_succeeded/);
  assert.match(warnings, /latestProjection\.snapshot_timestamp/);
  assert.match(warnings, /"\/api\/fx\/refresh"/);
  assert.match(warnings, /"\/api\/run-jobs"/);
});

test("archiving or purging the selected budget returns beta to its picker", async () => {
  const app = await source("App.jsx");
  const budget = await source("BudgetView.jsx");

  assert.match(app, /function clearStoredSelection/);
  assert.match(app, /onCurrentBudgetRemoved=\{returnToBudgetPicker\}/);
  assert.match(budget, /budgetId === currentBudgetId[\s\S]*onCurrentBudgetRemoved\(\);[\s\S]*return;/);
  assert.equal((budget.match(/onCurrentBudgetRemoved\(\);/g) || []).length, 2);
});
