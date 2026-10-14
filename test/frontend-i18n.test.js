import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import en from "../public/app/cashflow/locales/en.js";
import pl from "../public/app/cashflow/locales/pl.js";
import { createElement } from "../frontend-beta/node_modules/react/index.js";
import { formatParts, setLocale } from "../frontend-beta/src/i18n.js";

function betaTranslationKeys() {
  const sourceDir = path.resolve("frontend-beta/src");
  const files = fs.readdirSync(sourceDir).filter(name => /\.(?:js|jsx)$/.test(name) && !name.includes(".sync-conflict-"));
  const keys = new Set();
  const callPattern = /\b(?:t|formatMessage|formatParts)\(\s*(["'])(.*?)\1/g;
  for (const file of files) {
    const source = fs.readFileSync(path.join(sourceDir, file), "utf8");
    for (const match of source.matchAll(callPattern)) keys.add(match[2]);
  }
  return keys;
}

test("every literal beta translation key exists in both locale dictionaries", () => {
  const keys = betaTranslationKeys();
  for (const key of keys) {
    assert.ok(Object.hasOwn(en.strings, key), `English locale is missing beta key: ${key}`);
    assert.ok(Object.hasOwn(pl.strings, key), `Polish locale is missing beta key: ${key}`);
  }
});

test("beta translation keys are complete labels or sentences, not concatenated fragments", () => {
  const lowercaseStandaloneKeys = new Set(["or", "ntfy", "ntfy access token", "ntfy priority", "of {amount} requested"]);
  for (const key of betaTranslationKeys()) {
    if (lowercaseStandaloneKeys.has(key)) continue;
    assert.doesNotMatch(key, /^[\p{P}\p{S}a-z]/u, `Beta key starts like a fragment: ${key}`);
    assert.doesNotMatch(key, /[“‘( ]$/, `Beta key ends like a fragment: ${key}`);
  }
});

test("every beta translation has Polish copy unless it is a name or technical term", () => {
  const unchangedTerms = new Set(["Cashflow", "BETA", "Discord", "ntfy", "2026-05"]);
  for (const key of betaTranslationKeys()) {
    if (unchangedTerms.has(key)) continue;
    assert.notEqual(pl.strings[key], en.strings[key], `Polish translation is still English: ${key}`);
  }
});

test("formatParts places translated React elements at named placeholders", () => {
  setLocale("pl");
  const parts = formatParts("Valid until {date}. It can be used once.", {
    date: createElement("strong", null, "31.12.2026")
  });
  assert.equal(parts[0], "Ważny do ");
  assert.equal(parts[1].type, "strong");
  assert.equal(parts[1].key, "date-1");
  assert.equal(parts[2], ". Można go użyć jeden raz.");
  setLocale("en");
});

test("beta JSX does not bypass translation for visible text or string attributes", () => {
  const sourceDir = path.resolve("frontend-beta/src");
  const files = fs.readdirSync(sourceDir).filter(name => name.endsWith(".jsx") && !name.includes(".sync-conflict-"));
  const allowed = new Set([
    "Cashflow", "BETA", "ntfy", "Discord", "RBAC", "&times;", "i.isConfirmed || i.date",
    "example.com, example.org", "admins, ops", "external",
    "https://auth.example.com/application/o/cashflow/", "https://ntfy.example.com/topic",
    "tk_...", "https://discord.com/api/webhooks/..."
  ]);
  const violations = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(sourceDir, file), "utf8");
    for (const match of source.matchAll(/>([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g)) {
      const value = match[1].trim();
      if (value && !allowed.has(value)) violations.push(`${file}: text ${JSON.stringify(value)}`);
    }
    for (const match of source.matchAll(/\b(title|placeholder|aria-label|alt)=(['"])([^'"{}]*[A-Za-z][^'"{}]*)\2/g)) {
      if (!allowed.has(match[3])) violations.push(`${file}: ${match[1]} ${JSON.stringify(match[3])}`);
    }
  }
  assert.deepEqual(violations, [], violations.join("\n"));
});
