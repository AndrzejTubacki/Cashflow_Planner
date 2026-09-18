const STORAGE_PREFIX = "cashflow_ui_preferences";

export const UI_THEME_OPTIONS = [
  { id: "system", label: "System theme" },
  { id: "dark", label: "Dark theme" },
  { id: "light", label: "Light theme" }
];

export const UI_DENSITY_OPTIONS = [
  { id: "comfortable", label: "Comfortable density" },
  { id: "compact", label: "Compact density" }
];

export const DEFAULT_UI_PREFERENCES = Object.freeze({
  theme: "system",
  density: "comfortable"
});

function preferenceKey(scope = "") {
  const normalizedScope = String(scope || "default").trim() || "default";
  return `${STORAGE_PREFIX}:${normalizedScope}`;
}

function optionIds(options) {
  return new Set(options.map(option => option.id));
}

export function currentPreferenceScope() {
  try {
    return (
      localStorage.getItem("cashflow_account_id")
      || localStorage.getItem("cashflow_budget_id")
      || localStorage.getItem("cashflow_user_id")
      || "default"
    ).trim() || "default";
  } catch {
    return "default";
  }
}

export function normalizeUiPreferences(input = {}) {
  const themeIds = optionIds(UI_THEME_OPTIONS);
  const densityIds = optionIds(UI_DENSITY_OPTIONS);

  return {
    theme: themeIds.has(input.theme) ? input.theme : DEFAULT_UI_PREFERENCES.theme,
    density: densityIds.has(input.density) ? input.density : DEFAULT_UI_PREFERENCES.density
  };
}

export function loadUiPreferences(scope = currentPreferenceScope()) {
  try {
    const raw = localStorage.getItem(preferenceKey(scope));
    return normalizeUiPreferences(raw ? JSON.parse(raw) : DEFAULT_UI_PREFERENCES);
  } catch {
    return { ...DEFAULT_UI_PREFERENCES };
  }
}

export function saveUiPreferences(scope, preferences = {}) {
  const normalized = normalizeUiPreferences(preferences);
  try {
    localStorage.setItem(preferenceKey(scope), JSON.stringify(normalized));
  } catch {
    // Storage can be unavailable in private contexts; applying still works for this page view.
  }
  return normalized;
}

export function applyUiPreferences(preferences = {}, target = document.documentElement) {
  const normalized = normalizeUiPreferences(preferences);
  if (!target) return normalized;

  target.setAttribute("data-cashflow-theme", normalized.theme);
  target.setAttribute("data-cashflow-density", normalized.density);
  target.style.colorScheme = normalized.theme === "system" ? "light dark" : normalized.theme;
  return normalized;
}
