import { DEFAULT_FUTURE_PERIODS, DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { todayInTimezone } from "./cashflow-date-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { hasOwn, requireBoolean, requireMoneyAmount, requireNumber } from "./cashflow-input-validation.js";
import { validateAndNormalizeSettings } from "./cashflow-settings-validation.js";
import { badRequest } from "./cashflow-user-utils.js";

function monthKey(dateString) {
  return String(dateString || "").slice(0, 7);
}

export function createCashflowSetupService({
  hasAnyConfirmedTransactions = null,
  normalizeLocale = value => String(value || "en"),
  openPlanningDb,
  regenerateProjectionsAfterMutation
}) {
  function setupRequired(userId) {
    const db = openPlanningDb(userId);
    try {
      const settings = db.prepare("SELECT setup_completed FROM settings WHERE id = 1").get();
      if (Number(settings?.setup_completed || 0) === 1) {
        return false;
      }

      if (typeof hasAnyConfirmedTransactions === "function" && hasAnyConfirmedTransactions(userId)) {
        db.prepare(`
          UPDATE settings
          SET setup_completed = 1,
              setup_completed_at = COALESCE(setup_completed_at, datetime('now')),
              updated_at = datetime('now')
          WHERE id = 1
        `).run();
        return false;
      }

      return true;
    } finally {
      db.close();
    }
  }

  function completeSetup(userId, input = {}) {
    const setupSettings = validateAndNormalizeSettings({
      ledger_currency: input.ledger_currency ?? input.currency ?? "PLN",
      locale: input.locale ?? "en",
      timezone: input.timezone ?? DEFAULT_TIMEZONE,
      holiday_country: input.holiday_country ?? "PL",
      future_periods: input.future_periods ?? DEFAULT_FUTURE_PERIODS
    }, { normalizeLocale });
    const ledgerCurrency = setupSettings.ledger_currency;
    const locale = setupSettings.locale;
    const timezone = setupSettings.timezone;
    const holidayCountry = setupSettings.holiday_country;
    const futurePeriods = setupSettings.future_periods;
    const today = todayInTimezone(timezone);
    const openingBalance = hasOwn(input, "opening_balance")
      ? requireMoneyAmount(input.opening_balance, "opening_balance")
      : 0;
    if (openingBalance < 0) {
      throw badRequest("Opening balance must be a non-negative number", [{
        field: "opening_balance",
        reason: "must_be_non_negative"
      }]);
    }
    const incomeEnabled = hasOwn(input, "income_enabled")
      ? requireBoolean(input.income_enabled, "income_enabled") === 1
      : false;
    const incomeAmount = hasOwn(input, "income_amount")
      ? requireMoneyAmount(input.income_amount, "income_amount", { min: 0 })
      : 0;
    const incomeName = String(input.income_name || "Income").trim() || "Income";
    const incomeAnchorDay = hasOwn(input, "income_anchor_day")
      ? requireNumber(input.income_anchor_day, "income_anchor_day", { min: 1, max: 31, integer: true })
      : 1;

    const db = openPlanningDb(userId);
    const created = {
      openingBalanceId: null,
      incomeId: null
    };

    let result = null;

    try {
      result = db.transaction(() => {
        const settings = db.prepare("SELECT setup_completed FROM settings WHERE id = 1").get();
        if (Number(settings?.setup_completed || 0) === 1) {
          throw badRequest("First-run setup is already completed");
        }

        db.prepare(`
          UPDATE settings
          SET ledger_currency = ?,
              locale = ?,
              timezone = ?,
              holiday_country = ?,
              future_periods = ?,
              setup_completed = 1,
              setup_completed_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = 1
        `).run(ledgerCurrency, locale, timezone, holidayCountry, futurePeriods);

        if (Math.abs(openingBalance) > 0.0001) {
          const id = generateId("pending-opening-balance");
          const amount = Math.abs(openingBalance);
          const type = openingBalance >= 0 ? "income" : "expense";

          db.prepare(`
            INSERT INTO pending_transactions (
              id, name, currency, amount, type, date,
              fx_rate, buffered_fx_rate, ledger_currency, status,
              funded_amount, requested_amount, ledger_amount, note,
              pending_origin, occurrence_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, 'pending', ?, ?, ?, ?, 'system', ?, datetime('now'), datetime('now'))
          `).run(
            id,
            "Opening balance",
            ledgerCurrency,
            amount,
            type,
            today,
            ledgerCurrency,
            amount,
            amount,
            amount,
            JSON.stringify({ kind: "first_run_opening_balance", balance: openingBalance }),
            `first_run_opening_balance:${id}`
          );
          created.openingBalanceId = id;
        }

        if (incomeEnabled && incomeAmount > 0) {
          const id = generateId("recurring-income");
          db.prepare(`
            INSERT INTO recurring_incomes (
              id, name, currency, amount, prediction_strategy, active,
              repeat_every_months, start_month_year, anchor_type, anchor_day_of_month,
              anchor_offset_days, anchor_business_day_adjustment, anchor_holiday_country,
              period_setting, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'fixed', 1, 1, ?, 'day_of_month', ?, 0, 'none', ?, 1, datetime('now'), datetime('now'))
          `).run(id, incomeName, ledgerCurrency, incomeAmount, monthKey(today), incomeAnchorDay, holidayCountry);

          db.prepare(`
            UPDATE settings
            SET budget_period_income_id = ?,
                updated_at = datetime('now')
            WHERE id = 1
          `).run(id);

          created.incomeId = id;
        }

        return db.prepare("SELECT * FROM settings WHERE id = 1").get();
      })();
    } finally {
      db.close();
    }

    const projection = regenerateProjectionsAfterMutation(userId);
    return {
      ok: true,
      settings: result,
      created,
      _projection: projection
    };
  }

  return {
    completeSetup,
    setupRequired
  };
}
