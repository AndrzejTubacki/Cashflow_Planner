import { DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { todayInTimezone } from "./cashflow-date-utils.js";
import {
  normalizeFxProvider,
  normalizeManualFxPairs,
  normalizeSupportedCurrency
} from "./cashflow-fx-provider-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { multiplyMoney, roundMoneyAmount } from "./cashflow-money-utils.js";
import { validateAndNormalizeSettings } from "./cashflow-settings-validation.js";
import { badRequest, conflict } from "./cashflow-user-utils.js";

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
    const db = openPlanningDb(userId);

    try {
      const currentSettings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
      const safeUpdates = validateAndNormalizeSettings(updates, {
        allowedKeysOnly: true,
        currentSettings,
        normalizeLocale
      });

      if (safeUpdates.budget_period_income_id) {
        const income = db.prepare(`
          SELECT id, period_setting, active
          FROM recurring_incomes
          WHERE id = ?
        `).get(safeUpdates.budget_period_income_id);

        if (!income) {
          throw badRequest("Selected budget period income does not exist");
        }

        if (Number(income.active) !== 1) {
          throw badRequest("Selected budget period income must be active");
        }
      }

      const previousLedgerCurrency = normalizeSupportedCurrency(currentSettings?.ledger_currency || "PLN");
      const nextLedgerCurrency = safeUpdates.ledger_currency || previousLedgerCurrency;
      const ledgerCurrencyChanged = nextLedgerCurrency !== previousLedgerCurrency;
      let ledgerSwitch = null;

      if (ledgerCurrencyChanged) {
        const unresolvedConversion = db.prepare(`
          SELECT id, ledger_currency
          FROM pending_transactions
          WHERE occurrence_key LIKE 'ledger_currency_conversion:%'
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        `).get();

        if (unresolvedConversion) {
          throw conflict("Confirm or clear the pending ledger currency conversion before changing ledger currency again", [{
            field: "ledger_currency",
            reason: "pending_conversion",
            pendingConversionId: unresolvedConversion.id,
            ledgerCurrency: unresolvedConversion.ledger_currency
          }]);
        }

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
          oldBalance: roundMoneyAmount(oldBalance),
          convertedOpeningBalance: multiplyMoney(oldBalance, rate),
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
          const convertedAmount = roundMoneyAmount(Math.abs(ledgerSwitch.convertedOpeningBalance));
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
              pending_origin, occurrence_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, 'pending', ?, ?, ?, ?, 'system', ?, datetime('now'), datetime('now'))
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
