import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setLocale } from "../frontend-beta/src/i18n.js";
import { describeFullImportPreview } from "../frontend-beta/src/importPreview.js";
import { transactionLedgerDisplay, transactionTypeLabel } from "../frontend-beta/src/moneyDisplay.js";
import { sortFundingEntries } from "../frontend-beta/src/parity.js";
import { loadUiPreferences, saveUiPreferences } from "../frontend-beta/src/uiPreferences.js";
import { normalizeUiPreferences as legacyPreferences } from "../public-legacy/app/cashflow/ui-preferences.js";

const source = name => readFile(new URL(`../frontend-beta/src/${name}`, import.meta.url), "utf8");

test("I03/L01 full import translates counts, defaults, conflicts, empty values and both destructive modes", () => {
  try {
    setLocale("pl");
    const preview = {
      mode: "merge",
      tables: { recurring_expenses: { exportRowCount: 4, currentRowCount: 2, defaultedColumns: ["anchor_income_id"] } },
      ledgerYears: { export: ["2025"], current: [] },
      settingsChanges: [{ field: "timezone", from: null, to: "UTC" }],
      conflicts: [
        { table: "goals", id: "g1", reason: "duplicate_in_import" },
        { table: "goals", id: "g2", reason: "already_exists" }
      ]
    };
    const text = describeFullImportPreview(preview);
    assert.match(text, /Tabela Wydatki cykliczne: 4 \/ 2/);
    assert.match(text, /Wartości domyślne zastosowane dla: anchor_income_id/);
    assert.match(text, /Lata księgi w pliku: 2025/);
    assert.match(text, /Lata księgi obecnie w budżecie: Brak/);
    assert.match(text, /Powtórzony identyfikator w importowanym pliku/);
    assert.match(text, /Identyfikator już istnieje w tym budżecie/);
    assert.match(text, /Import zostanie odrzucony/);
    assert.match(text, /Scalić te dane z budżetem/);
    assert.doesNotMatch(text, /Import preview|defaults used|already_exists|duplicate_in_import|Settings changes|Conflicts/);
    assert.match(describeFullImportPreview({ mode: "replace" }), /Zastąpić ten budżet importowanymi danymi/);
  } finally { setLocale("en"); }
});

test("T05/T02b historical ledger stacks retain independent currencies, zero and equivalents", async () => {
  const tx = { type: "goal_allocation", amount: 10, currency: "EUR", ledger_currency: "PLN",
    amount_ledger_amount: 44, ledger_amount: 12, ledger_amount_currency: "USD", ledger_amount_ledger_amount: 48 };
  assert.deepEqual(transactionLedgerDisplay(tx, "GBP"), { amount: 12, currency: "USD", equivalent: 48, ledgerCurrency: "PLN" });
  assert.deepEqual(transactionLedgerDisplay({ amount: 1, currency: "PLN", ledgerAmount: 0, ledgerCurrency: "USD" }),
    { amount: 0, currency: "USD", equivalent: null, ledgerCurrency: "USD" });
  assert.equal(transactionLedgerDisplay({ amount: 10, currency: "PLN", ledger_amount: 10, ledger_currency: "PLN" }), null);
  assert.equal(transactionLedgerDisplay({ amount: 10 }), null);
  try {
    setLocale("pl");
    assert.equal(transactionTypeLabel("income"), "Dochód");
    assert.equal(transactionTypeLabel("expense"), "Wydatek");
    assert.equal(transactionTypeLabel("goal_allocation"), "Alokacja celu");
  } finally { setLocale("en"); }
  const ledger = await source("LedgerView.jsx");
  assert.match(ledger, /transactionTypeLabel\(tx.type\)/);
  assert.match(ledger, /ledgerMoney.equivalent/);
});

test("G04 target tables show ledger target/remaining, priority, both split states and funding date; overview includes confirmed", async () => {
  const targets = await source("TargetsView.jsx");
  for (const key of ["target_ledger_amount", "remaining_ledger", "row.priority", "row.funded_by_date", 't("Full only")', 't("Splittable")']) {
    assert.ok(targets.includes(key), key);
  }
  assert.match(targets, /FundingOverview[^>]*showFullyConfirmed/);
  assert.match(await source("LedgerView.jsx"), /showFullyConfirmed \|\| !isFullyConfirmed/);
});

test("P03 dated shortfalls and FX gaps precede complete projections, then date/label/ID order", () => {
  const entries = [
    { label: "Complete", item: { id: "complete", funded_by_date: "2026-01-01", remaining_ledger: 0 } },
    { label: "Short", item: { id: "short", funded_by_date: "2026-05-01", remaining_ledger: 1 } },
    { label: "FX", item: { id: "fx", funded_by_date: "2026-04-01", fx_missing: true } },
    { label: "Undated", item: { id: "undated" } },
    { label: "Short", item: { id: "short2", funded_by_date: "2026-05-01", remaining_ledger: 1 } }
  ];
  assert.deepEqual(sortFundingEntries(entries).map(entry => entry.item.id), ["undated", "fx", "short", "short2", "complete"]);
  assert.equal(entries[0].item.id, "complete");
});

test("E05 token redemption has its own reachable form outside password-login gating", async () => {
  const entry = await source("EntryViews.jsx");
  const login = entry.slice(entry.indexOf("function InternalLogin"), entry.indexOf("function RegisterView"));
  assert.ok(login.indexOf('onPasswordSetup({})') > login.indexOf('{passwordLogin && providers.length'));
  assert.match(entry, /token: initialToken/);
  assert.match(entry, /id="beta-password-token"[^>]*required/);
  assert.match(entry, /if \(password !== confirm\)/);
  assert.match(entry, /apiFetch\("\/api\/auth\/internal\/password", \{ method: "POST", body: \{ token, password \}, scoped: false \}\)/);
  assert.match(entry, /if \(email\) \{[\s\S]*\/api\/auth\/internal\/login/);
  assert.match(entry, /setToken\(""\); setPassword\(""\); setConfirm\(""\); setSaved\(true\)/);
});

test("A12/A13 provider kind editing, disabled create default and explicit override clearing", async () => {
  const auth = await source("AuthSetup.jsx");
  assert.match(auth, /const \[kind, setKind\] = useState\(initialKind\)/);
  assert.match(auth, /select value=\{kind\} onChange=\{e => setKind/);
  assert.match(auth, /useState\(isExisting \? Boolean\(provider.enabled\) : false\)/);
  assert.ok(auth.includes('if (guide.needsIssuer || isExisting) body.issuer = issuer.trim();'));
  assert.ok(auth.includes('required={kind === "oidc" || kind === "google"}'));
  for (const key of ["authorizationEndpoint", "tokenEndpoint", "userInfoEndpoint"]) {
    assert.ok(auth.includes(`if (isExisting || ${key}.trim()) body.${key} = ${key}.trim();`), key);
  }
});

test("M01/D10 validation remains global with caution; every version state is visible to members", async () => {
  const [app, settings, shell] = await Promise.all([source("App.jsx"), source("SettingsView.jsx"), source("Shell.jsx")]);
  assert.ok(app.indexOf('className={`beta-validation-panel') < app.indexOf('{section === "budget"'));
  assert.doesNotMatch(settings, /validationResult \? <div/);
  assert.match(settings, /Review the warnings below before trusting the projection/);
  assert.doesNotMatch(app, /!installed \|\| !isAdmin|canAdmin && versionCheck/);
  for (const key of ["Up to date", "Checking for updates", "Version check unavailable"]) assert.ok(shell.includes(`t("${key}")`));
  assert.match(app, /setVersionCheck\(\{ status: "checking" \}\)/);
});

test("E08/L01 provider names, verbs, token title and entry status use translation", async () => {
  const [button, token, entry] = await Promise.all([source("ProviderButton.jsx"), source("PasswordTokenModal.jsx"), source("EntryViews.jsx")]);
  assert.match(button, /const label = provider.displayName \|\| provider.id/);
  assert.match(button, /formatMessage\("Sign in with \{provider\}"/);
  assert.match(button, /formatMessage\("Continue with \{provider\}"/);
  assert.match(token, /purpose === "password_setup" \? t\("Create password setup token"\) : t\("Create password reset token"\)/);
  assert.match(entry, /t\(account.status\)/);
  assert.match(entry, /t\(budget.role \|\| "viewer"\)/);
});

test("D08 legacy default pages round-trip and theme saves preserve income/flex selection", () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  try {
    const mapping = { ledger: "ledger", recurring: "recurring", income: "recurring", goals: "targets", flex: "targets",
      priority: "priorities", budgets: "budget", oneoff: "oneoff", settings: "settings" };
    for (const [legacy, react] of Object.entries(mapping)) {
      values.set("cashflow_ui_preferences:account", JSON.stringify({ defaultTab: legacy }));
      assert.equal(loadUiPreferences("account").defaultTab, react);
      saveUiPreferences("account", { ...loadUiPreferences("account"), theme: "dark" });
      assert.equal(legacyPreferences(JSON.parse(values.get("cashflow_ui_preferences:account"))).defaultTab, legacy);
    }
    values.set("cashflow_ui_preferences:account", "invalid JSON");
    saveUiPreferences("account", { defaultTab: "targets" });
    assert.equal(loadUiPreferences("account").defaultTab, "targets");
    for (const [react, legacy] of Object.entries({ targets: "goals", priorities: "priority", budget: "budgets" })) {
      values.clear();
      saveUiPreferences("account", { defaultTab: react });
      assert.equal(legacyPreferences(JSON.parse(values.get("cashflow_ui_preferences:account"))).defaultTab, legacy);
    }
  } finally { globalThis.localStorage = previousStorage; }
});
