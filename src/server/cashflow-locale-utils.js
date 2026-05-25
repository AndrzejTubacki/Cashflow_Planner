import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

export const DEFAULT_LOCALE = "en";

function localeLabel(id) {
  const labels = {
    en: "English",
    pl: "Polski"
  };

  return labels[id] || id;
}

export function createCashflowLocaleService(localeDir) {
  const loadedStrings = new Map();

  function listAvailableLocales() {
    const localeIds = new Set([DEFAULT_LOCALE]);

    try {
      for (const entry of fs.readdirSync(localeDir || "", { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".js")) continue;

        const id = entry.name.slice(0, -3);
        if (/^[a-z][a-z0-9-]*$/i.test(id)) {
          localeIds.add(id.toLowerCase());
        }
      }
    } catch {
      // Missing locale directory should not prevent the app from booting.
    }

    return [...localeIds].sort((a, b) => {
      if (a === DEFAULT_LOCALE) return -1;
      if (b === DEFAULT_LOCALE) return 1;
      return a.localeCompare(b);
    }).map(id => ({
      id,
      label: localeLabel(id)
    }));
  }

  function normalizeLocale(value) {
    const requested = String(value || DEFAULT_LOCALE).trim().toLowerCase();
    const ids = new Set(listAvailableLocales().map(locale => locale.id));

    return ids.has(requested) ? requested : DEFAULT_LOCALE;
  }

  async function loadLocaleStrings(locale) {
    const id = normalizeLocale(locale);

    if (loadedStrings.has(id)) {
      return loadedStrings.get(id);
    }

    const filePath = path.join(localeDir || "", `${id}.js`);

    try {
      const module = await import(pathToFileURL(filePath).href);
      const strings = module.default?.strings || {};
      loadedStrings.set(id, strings);
      return strings;
    } catch {
      if (id !== DEFAULT_LOCALE) {
        return loadLocaleStrings(DEFAULT_LOCALE);
      }

      loadedStrings.set(DEFAULT_LOCALE, {});
      return {};
    }
  }

  async function translateLocale(locale, key, params = {}) {
    const normalizedKey = String(key || "");
    const strings = await loadLocaleStrings(locale);
    const template = strings[normalizedKey] || normalizedKey;

    return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, name) => {
      const value = params?.[name];
      return value === undefined || value === null ? "" : String(value);
    });
  }

  return {
    listAvailableLocales,
    normalizeLocale,
    translateLocale
  };
}
