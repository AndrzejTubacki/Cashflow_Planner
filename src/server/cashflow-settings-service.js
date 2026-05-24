import path from "path";
import { DEFAULT_FUTURE_PERIODS } from "./cashflow-constants.js";
import {
  normalizeFxCurrencyList,
  normalizeFxProvider,
  normalizeManualFxRates
} from "./cashflow-fx-provider-utils.js";

export function createCashflowSettingsService({
  normalizeLocale = value => String(value || "en"),
  openPlanningDb
}) {
  function getSettings(userId) {
    const db = openPlanningDb(userId);
    try {
      const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
      return settings || null;
    } finally {
      db.close();
    }
  }

  function updateSettings(userId, updates) {
    const allowedKeys = new Set([
      "future_periods",
      "locale",
      "budget_period_income_id",
      "fx_buffer_percent",
      "fx_provider",
      "fx_used_currencies",
      "manual_fx_rates",
      "auto_backup_enabled",
      "backup_interval_minutes",
      "backup_retention_count",
      "backup_location",
      "ntfy_url",
      "notification_delivery_time",
      "notify_goal_impossible",
      "notify_necessary_underfunded",
      "notify_funding_shortfall",
      "notify_income_missing",
      "notify_pending_summary",
      "notify_goal_funded",
      "notify_fx_changed",
      "ntfy_priority_goal_impossible",
      "ntfy_priority_necessary_underfunded",
      "ntfy_priority_funding_shortfall",
      "ntfy_priority_income_missing",
      "ntfy_priority_pending_summary",
      "ntfy_priority_goal_funded",
      "ntfy_priority_fx_changed",
      "necessary_underfunded_repeat_days"
    ]);

    const safeUpdates = Object.fromEntries(
      Object.entries(updates || {}).filter(([key]) => allowedKeys.has(key))
    );

    const db = openPlanningDb(userId);

    try {
      const currentSettings = db.prepare("SELECT * FROM settings WHERE id = 1").get();

      if (safeUpdates.backup_location !== undefined && safeUpdates.backup_location !== null && safeUpdates.backup_location !== "") {
        const backupLocation = String(safeUpdates.backup_location).trim();

        if (!path.isAbsolute(backupLocation)) {
          throw new Error("backup_location must be an absolute path");
        }

        safeUpdates.backup_location = backupLocation;
      }

      if (safeUpdates.ntfy_url !== undefined && safeUpdates.ntfy_url !== null && safeUpdates.ntfy_url !== "") {
        const ntfyUrl = String(safeUpdates.ntfy_url).trim();

        if (!/^https?:\/\//i.test(ntfyUrl)) {
          throw new Error("ntfy_url must be a full http(s) URL, for example https://ntfy.example.com/topic");
        }

        safeUpdates.ntfy_url = ntfyUrl;
      }

      if (safeUpdates.future_periods !== undefined) {
        safeUpdates.future_periods = Math.max(1, Math.min(60, Number(safeUpdates.future_periods) || DEFAULT_FUTURE_PERIODS));
      }

      if (safeUpdates.locale !== undefined) {
        safeUpdates.locale = normalizeLocale(safeUpdates.locale);
      }

      if (safeUpdates.fx_buffer_percent !== undefined) {
        safeUpdates.fx_buffer_percent = Math.max(0, Math.min(100, Number(safeUpdates.fx_buffer_percent) || 0));
      }

      if (safeUpdates.fx_provider !== undefined) {
        safeUpdates.fx_provider = normalizeFxProvider(safeUpdates.fx_provider);
      }

      if (safeUpdates.fx_used_currencies !== undefined) {
        safeUpdates.fx_used_currencies = JSON.stringify(normalizeFxCurrencyList(safeUpdates.fx_used_currencies));
      }

      if (safeUpdates.manual_fx_rates !== undefined) {
        safeUpdates.manual_fx_rates = JSON.stringify(normalizeManualFxRates(safeUpdates.manual_fx_rates));
      }

      if (safeUpdates.necessary_underfunded_repeat_days !== undefined) {
        safeUpdates.necessary_underfunded_repeat_days = Math.max(1, Number(safeUpdates.necessary_underfunded_repeat_days) || 1);
      }

      if (safeUpdates.budget_period_income_id === "") {
        safeUpdates.budget_period_income_id = null;
      }

      if (safeUpdates.budget_period_income_id) {
        const income = db.prepare(`
          SELECT id
          FROM recurring_incomes
          WHERE id = ?
        `).get(safeUpdates.budget_period_income_id);

        if (!income) {
          throw new Error("Selected budget period income does not exist");
        }
      }

      db.transaction(() => {
        db.prepare(`
          UPDATE settings
          SET ledger_currency = 'PLN', updated_at = datetime('now')
          WHERE id = 1
        `).run();

        if (Object.keys(safeUpdates).length) {
          const setClauses = Object.keys(safeUpdates)
            .map(key => `${key} = ?`)
            .join(", ");

          const values = Object.values(safeUpdates);

          db.prepare(`
            UPDATE settings
            SET ${setClauses}, ledger_currency = 'PLN', updated_at = datetime('now')
            WHERE id = 1
          `).run(...values);
        }

        if (Object.prototype.hasOwnProperty.call(safeUpdates, "budget_period_income_id")) {
          db.prepare(`
            UPDATE recurring_incomes
            SET period_setting = CASE WHEN id = ? THEN 1 ELSE 0 END,
                updated_at = datetime('now')
          `).run(safeUpdates.budget_period_income_id || "__none__");
        }
      })();

      return db.prepare("SELECT * FROM settings WHERE id = 1").get() || currentSettings || {};
    } finally {
      db.close();
    }
  }

  return {
    getSettings,
    updateSettings
  };
}
