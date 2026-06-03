import path from "path";
import { DEFAULT_FUTURE_PERIODS, DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { todayInTimezone, normalizeTimezone } from "./cashflow-date-utils.js";
import {
  normalizeFxCurrencyList,
  normalizeFxProvider,
  normalizeManualFxPairs,
  normalizeManualFxRates,
  normalizeSupportedCurrency,
  requireSupportedCurrency
} from "./cashflow-fx-provider-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { badRequest } from "./cashflow-user-utils.js";

function configuredBackupAllowedRoots() {
  return String(process.env.CASHFLOW_BACKUP_ALLOWED_ROOTS || "")
    .split(",")
    .map(root => root.trim())
    .filter(Boolean)
    .map(root => path.resolve(root));
}

function isPathInside(candidate, root) {
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export function createCashflowSettingsService({
  fetchProviderRate = null,
  getCachedFxRate = null,
  latestConfirmedBalance = null,
  normalizeLocale = value => String(value || "en"),
  openPlanningDb,
  recalculatePlanningRunningBalances = null
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

  async function updateSettings(userId, updates) {
    const allowedKeys = new Set([
      "future_periods",
      "locale",
      "ledger_currency",
      "timezone",
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
          throw badRequest("backup_location must be an absolute path");
        }

        const allowedRoots = configuredBackupAllowedRoots();
        if (!allowedRoots.length || !allowedRoots.some(root => isPathInside(backupLocation, root))) {
          throw badRequest("backup_location must be under an allowed backup root");
        }

        safeUpdates.backup_location = path.resolve(backupLocation);
      }

      if (safeUpdates.ntfy_url !== undefined && safeUpdates.ntfy_url !== null && safeUpdates.ntfy_url !== "") {
        const ntfyUrl = String(safeUpdates.ntfy_url).trim();

        if (!/^https?:\/\//i.test(ntfyUrl)) {
          throw badRequest("ntfy_url must be a full http(s) URL, for example https://ntfy.example.com/topic");
        }

        safeUpdates.ntfy_url = ntfyUrl;
      }

      if (safeUpdates.future_periods !== undefined) {
        safeUpdates.future_periods = Math.max(1, Math.min(60, Number(safeUpdates.future_periods) || DEFAULT_FUTURE_PERIODS));
      }

      if (safeUpdates.locale !== undefined) {
        safeUpdates.locale = normalizeLocale(safeUpdates.locale);
      }

      if (safeUpdates.ledger_currency !== undefined) {
        safeUpdates.ledger_currency = requireSupportedCurrency(safeUpdates.ledger_currency, "ledger_currency");
      }

      if (safeUpdates.timezone !== undefined) {
        safeUpdates.timezone = normalizeTimezone(safeUpdates.timezone || DEFAULT_TIMEZONE);
      }

      if (safeUpdates.fx_buffer_percent !== undefined) {
        safeUpdates.fx_buffer_percent = Math.max(0, Math.min(100, Number(safeUpdates.fx_buffer_percent) || 0));
      }

      if (safeUpdates.fx_provider !== undefined) {
        safeUpdates.fx_provider = normalizeFxProvider(safeUpdates.fx_provider);
      }

      if (safeUpdates.fx_used_currencies !== undefined) {
        const ledgerCurrency = safeUpdates.ledger_currency || currentSettings?.ledger_currency || "PLN";
        safeUpdates.fx_used_currencies = JSON.stringify(normalizeFxCurrencyList(
          safeUpdates.fx_used_currencies,
          ledgerCurrency
        ));
      }

      if (safeUpdates.manual_fx_rates !== undefined) {
        const ledgerCurrency = safeUpdates.ledger_currency || currentSettings?.ledger_currency || "PLN";
        safeUpdates.manual_fx_rates = JSON.stringify({
          ...normalizeManualFxRates(safeUpdates.manual_fx_rates),
          ...normalizeManualFxPairs(safeUpdates.manual_fx_rates, ledgerCurrency)
        });
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
          throw badRequest("Selected budget period income does not exist");
        }
      }

      const previousLedgerCurrency = normalizeSupportedCurrency(currentSettings?.ledger_currency || "PLN");
      const nextLedgerCurrency = safeUpdates.ledger_currency || previousLedgerCurrency;
      const ledgerCurrencyChanged = nextLedgerCurrency !== previousLedgerCurrency;
      let ledgerSwitch = null;

      if (ledgerCurrencyChanged) {
        const rateDate = todayInTimezone(currentSettings?.timezone || DEFAULT_TIMEZONE);
        const pendingManualRates = safeUpdates.manual_fx_rates !== undefined
          ? safeUpdates.manual_fx_rates
          : currentSettings?.manual_fx_rates;
        const manualPairs = normalizeManualFxPairs(pendingManualRates, nextLedgerCurrency);
        const manualDirect = Number(manualPairs[`${previousLedgerCurrency}/${nextLedgerCurrency}`]);
        const manualInverse = Number(manualPairs[`${nextLedgerCurrency}/${previousLedgerCurrency}`]);
        let rate = Number.isFinite(manualDirect) && manualDirect > 0 ? manualDirect : null;
        let source = rate ? "manual" : "cache";

        if ((!Number.isFinite(rate) || rate <= 0) && Number.isFinite(manualInverse) && manualInverse > 0) {
          rate = 1 / manualInverse;
          source = "manual-inverse";
        }

        if ((!Number.isFinite(rate) || rate <= 0) && typeof getCachedFxRate === "function") {
          rate = Number(getCachedFxRate(userId, previousLedgerCurrency, rateDate, nextLedgerCurrency));
          source = "cache";
        }

        if ((!Number.isFinite(rate) || rate <= 0) && typeof getCachedFxRate === "function") {
          const inverse = typeof getCachedFxRate === "function"
            ? Number(getCachedFxRate(userId, nextLedgerCurrency, rateDate, previousLedgerCurrency))
            : null;

          if (Number.isFinite(inverse) && inverse > 0) {
            rate = 1 / inverse;
            source = "inverse-cache";
          }
        }

        const oldBalance = typeof latestConfirmedBalance === "function"
          ? Number(latestConfirmedBalance(userId) || 0)
          : 0;

        if ((!Number.isFinite(rate) || rate <= 0) && typeof fetchProviderRate === "function") {
          const provider = normalizeFxProvider(safeUpdates.fx_provider || currentSettings?.fx_provider);

          if (provider !== "disabled" && provider !== "manual") {
            const rateInfo = await fetchProviderRate(
              provider,
              previousLedgerCurrency,
              rateDate,
              nextLedgerCurrency,
              currentSettings?.timezone || DEFAULT_TIMEZONE
            );
            rate = Number(rateInfo?.rate);
            source = rateInfo?.source || provider;
          }
        }

        if (!Number.isFinite(rate) || rate <= 0) {
          if (Math.abs(oldBalance) < 0.0001) {
            rate = 1;
            source = "zero-balance";
          } else {
            throw badRequest(`Missing FX rate for ${previousLedgerCurrency}/${nextLedgerCurrency}. Refresh FX cache first.`);
          }
        }

        ledgerSwitch = {
          oldCurrency: previousLedgerCurrency,
          newCurrency: nextLedgerCurrency,
          oldBalance,
          convertedOpeningBalance: oldBalance * rate,
          rate,
          rateDate,
          source
        };
      }

      db.transaction(() => {
        if (Object.keys(safeUpdates).length) {
          const setClauses = Object.keys(safeUpdates)
            .map(key => `${key} = ?`)
            .join(", ");

          const values = Object.values(safeUpdates);

          db.prepare(`
            UPDATE settings
            SET ${setClauses}, updated_at = datetime('now')
            WHERE id = 1
          `).run(...values);
        }

        if (ledgerSwitch) {
          const conversionId = generateId("pending-ledger-currency");
          const convertedAmount = Math.abs(ledgerSwitch.convertedOpeningBalance);
          const conversionType = ledgerSwitch.convertedOpeningBalance >= 0 ? "income" : "expense";
          const note = JSON.stringify({
            kind: "ledger_currency_conversion",
            old_currency: ledgerSwitch.oldCurrency,
            new_currency: ledgerSwitch.newCurrency,
            old_balance: ledgerSwitch.oldBalance,
            converted_balance: ledgerSwitch.convertedOpeningBalance,
            fx_rate: ledgerSwitch.rate,
            rate_date: ledgerSwitch.rateDate,
            source: ledgerSwitch.source
          });

          db.prepare(`
            INSERT INTO ledger_currency_events (
              id, old_currency, new_currency, old_balance, converted_opening_balance,
              fx_rate, rate_date, source, details, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          `).run(
            generateId("ledger-currency"),
            ledgerSwitch.oldCurrency,
            ledgerSwitch.newCurrency,
            ledgerSwitch.oldBalance,
            ledgerSwitch.convertedOpeningBalance,
            ledgerSwitch.rate,
            ledgerSwitch.rateDate,
            ledgerSwitch.source,
            JSON.stringify({ reason: "settings-update" })
          );

          // The ledger-currency switch is intentionally represented as a visible pending row.
          // Users can inspect and confirm the converted opening balance instead of inheriting hidden state.
          db.prepare(`
            INSERT INTO pending_transactions (
              id, name, currency, amount, type, date,
              fx_rate, buffered_fx_rate, ledger_currency, status,
              funded_amount, requested_amount, ledger_amount, note,
              occurrence_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, 'pending', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          `).run(
            conversionId,
            `Opening balance conversion ${ledgerSwitch.oldCurrency} to ${ledgerSwitch.newCurrency}`,
            ledgerSwitch.newCurrency,
            convertedAmount,
            conversionType,
            ledgerSwitch.rateDate,
            ledgerSwitch.newCurrency,
            convertedAmount,
            convertedAmount,
            convertedAmount,
            note,
            `ledger_currency_conversion:${conversionId}`
          );
        }

        if (Object.prototype.hasOwnProperty.call(safeUpdates, "budget_period_income_id")) {
          db.prepare(`
            UPDATE recurring_incomes
            SET period_setting = CASE WHEN id = ? THEN 1 ELSE 0 END,
                updated_at = datetime('now')
          `).run(safeUpdates.budget_period_income_id || "__none__");
        }

        if (ledgerSwitch && typeof recalculatePlanningRunningBalances === "function") {
          recalculatePlanningRunningBalances(db, userId);
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
