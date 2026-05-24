import { escapeHtml } from "../utils.js";

const DEFAULT_LOCALE = "en";
const loadedLocales = new Map();
let activeLocale = {
  id: DEFAULT_LOCALE,
  label: "English",
  strings: {}
};

function normalizeLocaleId(locale) {
  const id = String(locale || DEFAULT_LOCALE).trim().toLowerCase();
  return /^[a-z][a-z0-9-]*$/i.test(id) ? id : DEFAULT_LOCALE;
}

async function loadLocale(locale) {
  const id = normalizeLocaleId(locale);

  if (loadedLocales.has(id)) {
    activeLocale = loadedLocales.get(id);
    return activeLocale;
  }

  try {
    const module = await import(`./locales/${id}.js`);
    const loaded = module.default || {};
    const normalized = {
      id,
      label: loaded.label || id,
      strings: loaded.strings || {}
    };

    loadedLocales.set(id, normalized);
    activeLocale = normalized;
  } catch {
    if (id !== DEFAULT_LOCALE) {
      return loadLocale(DEFAULT_LOCALE);
    }

    activeLocale = {
      id: DEFAULT_LOCALE,
      label: "English",
      strings: {}
    };
    loadedLocales.set(DEFAULT_LOCALE, activeLocale);
  }

  return activeLocale;
}

function t(locale, key, fallback = "") {
  const normalizedKey = String(fallback || key || "");
  const translated = activeLocale.strings?.[normalizedKey];
  return translated || normalizedKey;
}

function localeOf(cashflow = null) {
  return normalizeLocaleId(cashflow?.settings?.locale || DEFAULT_LOCALE);
}

function formatMoney(amount, currency, locale) {
  const num = Number(amount) || 0;
  const formatted = num.toLocaleString(locale === "en" ? "en-US" : "pl-PL", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return `${formatted} ${currency}`;
}

function renderStatCard(label, value, note = "") {
  return `
    <div class="metric-tile">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ""}
    </div>
  `;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatPercent(value, locale) {
  const num = asNumber(value, 0);
  return `${num.toLocaleString(locale === "en" ? "en-US" : "pl-PL", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1
  })}%`;
}

function statusLabel(locale, status) {
  const s = String(status || "funded");

  const labels = {
    confirmed: t(locale, "Confirmed", "Confirmed"),
    funded: t(locale, "Funded", "Funded"),
    pending: t(locale, "Pending", "Pending"),
    partial: t(locale, "Partial", "Partial"),
    underfunded: t(locale, "Underfunded", "Underfunded"),
    disabled: t(locale, "Disabled", "Disabled")
  };

  return labels[s] || s;
}

function transactionTypeLabel(locale, type) {
  const labels = {
    income: t(locale, "Income", "Income"),
    expense: t(locale, "Expense", "Expense"),
    goal_allocation: t(locale, "Goal allocation", "Goal allocation")
  };

  return labels[type] || type || "-";
}

function renderStatusBadge(locale, status) {
  const s = String(status || "funded");
  return `<span class="cashflow-status cashflow-status--${escapeHtml(s)}">${escapeHtml(statusLabel(locale, s))}</span>`;
}

function renderProjectionWarnings(locale, cashflow) {
  const missingFxRates = cashflow?.missingFxRates || [];
  const latestSnapshot = cashflow?.latestProjectionSnapshot || null;
  const projectionFailed = latestSnapshot && Number(latestSnapshot.generation_succeeded) === 0;

  const warnings = [];

  if (missingFxRates.length) {
    warnings.push(`
      <div class="detail-note cashflow-warning" data-cashflow-missing-fx>
        <strong>${escapeHtml(t(locale, "Missing FX rates", "Missing FX rates"))}</strong>
        <span>${escapeHtml(missingFxRates.join(", "))}</span>
        <button type="button" class="btn-small" data-cashflow-refresh-fx>
          ${escapeHtml(t(locale, "Fetch NBP rates", "Fetch NBP rates"))}
        </button>
      </div>
    `);
  }

  if (projectionFailed) {
    warnings.push(`
      <div class="detail-note cashflow-warning" data-cashflow-projection-failed>
        <strong>${escapeHtml(t(locale, "Last projection failed", "Last projection failed"))}</strong>
        <span>${escapeHtml(latestSnapshot.snapshot_timestamp || "")}</span>
        <button type="button" class="btn-small" data-cashflow-run-jobs>
          ${escapeHtml(t(locale, "Regenerate", "Regenerate"))}
        </button>
      </div>
    `);
  }

  if (cashflow?._projection && cashflow._projection.projection_ok === false) {
    warnings.push(`
      <div class="detail-note cashflow-warning" data-cashflow-mutation-projection-failed>
        <strong>${escapeHtml(t(locale, "Saved, but projection failed", "Saved, but projection failed"))}</strong>
        <span>${escapeHtml(cashflow._projection.projection_error || "")}</span>
      </div>
    `);
  }

  return warnings.join("");
}

function groupBy(items, keyFn) {
  const groups = new Map();

  for (const item of items || []) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  return groups;
}

function renderDetailsPanel(title, content, { open = false, extra = "" } = {}) {
  return `
    <details class="cashflow-details cashflow-details-panel" ${open ? "open" : ""}>
      <summary class="cashflow-details-panel__summary">
        <div class="cashflow-details-panel__title">
          <span class="cashflow-details-panel__chevron">&gt;</span>
          <strong>${escapeHtml(title)}</strong>
        </div>
        ${extra ? `<div class="cashflow-details-panel__extra">${extra}</div>` : ""}
      </summary>

      <div class="cashflow-details-panel__body">
        ${content}
      </div>
    </details>
  `;
}

export {
  asNumber,
  formatMoney,
  formatPercent,
  groupBy,
  localeOf,
  loadLocale,
  renderDetailsPanel,
  renderProjectionWarnings,
  renderStatCard,
  renderStatusBadge,
  t,
  transactionTypeLabel
};
