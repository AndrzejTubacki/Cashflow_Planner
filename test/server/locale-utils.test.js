import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCashflowLocaleService } from "../../src/server/cashflow-locale-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localeDir = path.resolve(__dirname, "../../public/app/cashflow/locales");

test("locale service lists and translates available locale files", async () => {
  const service = createCashflowLocaleService(localeDir);

  assert.deepEqual(
    service.listAvailableLocales().map(locale => locale.id),
    ["en", "pl"]
  );

  assert.equal(await service.translateLocale("en", "Save"), "Save");
  assert.equal(await service.translateLocale("pl", "Save"), "Zapisz");
  assert.equal(await service.translateLocale("pl", "Germany"), "Niemcy");
  assert.equal(
    await service.translateLocale("pl", "Validation found {count} warnings", { count: 3 }),
    "Walidacja znalazła 3 ostrzeżeń"
  );
});

test("locale service falls back to English keys for missing strings", async () => {
  const service = createCashflowLocaleService(localeDir);

  assert.equal(await service.translateLocale("missing", "Unknown key"), "Unknown key");
});
