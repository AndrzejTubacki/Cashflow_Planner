import fs from "fs";

export const DEFAULT_LOCALE = "en";

function localeLabel(id) {
  const labels = {
    en: "English",
    pl: "Polski"
  };

  return labels[id] || id;
}

export function createCashflowLocaleService(localeDir) {
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

  return {
    listAvailableLocales,
    normalizeLocale
  };
}
