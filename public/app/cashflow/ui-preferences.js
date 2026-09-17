const STORAGE_PREFIX = "cashflow_ui_preferences";

export const UI_THEME_OPTIONS = [
  { id: "system", labelKey: "System theme" },
  { id: "dark", labelKey: "Dark theme" },
  { id: "light", labelKey: "Light theme" }
];

export const UI_DENSITY_OPTIONS = [
  { id: "comfortable", labelKey: "Comfortable density" },
  { id: "compact", labelKey: "Compact density" }
];

export const UI_DEFAULT_TAB_OPTIONS = [
  { id: "ledger", labelKey: "Ledger" },
  { id: "recurring", labelKey: "Recurring expenses" },
  { id: "income", labelKey: "Recurring income" },
  { id: "oneoff", labelKey: "One-off" },
  { id: "goals", labelKey: "Goals" },
  { id: "flex", labelKey: "Flex" },
  { id: "priority", labelKey: "Priorities" },
  { id: "budgets", labelKey: "Budgets" },
  { id: "settings", labelKey: "Settings" }
];

export const DEFAULT_UI_PREFERENCES = Object.freeze({
  theme: "system",
  density: "comfortable",
  defaultTab: "ledger"
});

function preferenceKey(scope = "") {
  const normalizedScope = String(scope || "default").trim() || "default";
  return `${STORAGE_PREFIX}:${normalizedScope}`;
}

function optionIds(options) {
  return new Set(options.map(option => option.id));
}

export function normalizeUiPreferences(input = {}) {
  const themeIds = optionIds(UI_THEME_OPTIONS);
  const densityIds = optionIds(UI_DENSITY_OPTIONS);
  const tabIds = optionIds(UI_DEFAULT_TAB_OPTIONS);

  return {
    theme: themeIds.has(input.theme) ? input.theme : DEFAULT_UI_PREFERENCES.theme,
    density: densityIds.has(input.density) ? input.density : DEFAULT_UI_PREFERENCES.density,
    defaultTab: tabIds.has(input.defaultTab) ? input.defaultTab : DEFAULT_UI_PREFERENCES.defaultTab
  };
}

export function loadUiPreferences(scope = "") {
  try {
    const raw = globalThis.localStorage?.getItem(preferenceKey(scope));
    return normalizeUiPreferences(raw ? JSON.parse(raw) : DEFAULT_UI_PREFERENCES);
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }
}

export function saveUiPreferences(scope = "", preferences = {}) {
  const normalized = normalizeUiPreferences(preferences);

  try {
    globalThis.localStorage?.setItem(preferenceKey(scope), JSON.stringify(normalized));
  } catch {
    // Browser storage can be unavailable in private contexts; applying preferences still works for this page load.
  }

  return normalized;
}

export function applyUiPreferences(preferences = {}, target = globalThis.document?.documentElement) {
  const normalized = normalizeUiPreferences(preferences);
  if (!target) return normalized;

  target.setAttribute("data-cashflow-theme", normalized.theme);
  target.setAttribute("data-cashflow-density", normalized.density);
  target.style.colorScheme = normalized.theme === "system" ? "light dark" : normalized.theme;
  return normalized;
}
