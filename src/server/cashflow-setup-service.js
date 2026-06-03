import { DEFAULT_FUTURE_PERIODS, DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { todayInTimezone, normalizeTimezone } from "./cashflow-date-utils.js";
import { requireSupportedCurrency } from "./cashflow-fx-provider-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { badRequest } from "./cashflow-user-utils.js";

function asNonNegativeNumber(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, number);
}

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
    const ledgerCurrency = requireSupportedCurrency(input.ledger_currency || input.currency || "PLN", "ledger_currency");
    const locale = normalizeLocale(input.locale || "en");
    const timezone = normalizeTimezone(input.timezone || DEFAULT_TIMEZONE);
    const futurePeriods = Math.max(1, Math.min(60, Number(input.future_periods) || DEFAULT_FUTURE_PERIODS));
    const today = todayInTimezone(timezone);
    const openingBalanceRaw = Number(input.opening_balance || 0);
    const openingBalance = Number.isFinite(openingBalanceRaw) ? openingBalanceRaw : 0;
    const incomeEnabled = input.income_enabled === true || input.income_enabled === 1 || input.income_enabled === "1";
    const incomeAmount = asNonNegativeNumber(input.income_amount, 0);
    const incomeName = String(input.income_name || "Income").trim() || "Income";
    const incomeAnchorDay = Math.max(1, Math.min(31, Number(input.income_anchor_day) || 1));

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
              future_periods = ?,
              setup_completed = 1,
              setup_completed_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = 1
        `).run(ledgerCurrency, locale, timezone, futurePeriods);

        if (Math.abs(openingBalance) > 0.0001) {
          const id = generateId("pending-opening-balance");
          const amount = Math.abs(openingBalance);
          const type = openingBalance >= 0 ? "income" : "expense";

          db.prepare(`
            INSERT INTO pending_transactions (
              id, name, currency, amount, type, date,
              fx_rate, buffered_fx_rate, ledger_currency, status,
              funded_amount, requested_amount, ledger_amount, note,
              occurrence_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, 'pending', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
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
            ) VALUES (?, ?, ?, ?, 'fixed', 1, 1, ?, 'day_of_month', ?, 0, 'none', 'PL', 1, datetime('now'), datetime('now'))
          `).run(id, incomeName, ledgerCurrency, incomeAmount, monthKey(today), incomeAnchorDay);

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
