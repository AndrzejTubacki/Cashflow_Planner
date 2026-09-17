import { DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { todayInTimezone } from "./cashflow-date-utils.js";
import {
  normalizeFxProvider,
  normalizeManualFxPairs,
  normalizeSupportedCurrency
} from "./cashflow-fx-provider-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { latestBalanceFromConfirmedRows } from "./cashflow-ledger-balance-utils.js";
import { multiplyMoney, roundMoneyAmount } from "./cashflow-money-utils.js";
import { validateAndNormalizeSettings } from "./cashflow-settings-validation.js";
import { badRequest, conflict } from "./cashflow-user-utils.js";

const POSTGRES_BOOLEAN_SETTINGS = new Set([
  "minimum_reserve_enabled",
  "auto_backup_enabled",
  "notify_goal_impossible",
  "notify_necessary_underfunded",
  "notify_funding_shortfall",
  "notify_income_missing",
  "notify_pending_summary",
  "notify_goal_funded",
  "notify_fx_changed",
  "setup_completed"
]);

export function createCashflowSettingsService({
  budgetStore = null,
  fetchProviderRate = null,
  getCachedFxRate = null,
  getCachedFxRateAsync = null,
  latestConfirmedBalance = null,
  latestConfirmedBalanceAsync = null,
  normalizeLocale = value => String(value || "en"),
  openPlanningDb,
  recalculatePlanningRunningBalances = null,
  recalculatePlanningRunningBalancesAsync = null
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

  async function getSettingsAsync(userId) {
    if (budgetStore && typeof budgetStore.listPlanningRows === "function") {
      const rows = await budgetStore.listPlanningRows(userId, "settings");
      return rows.find(row => Number(row.id) === 1) || rows[0] || null;
    }

    return getSettings(userId);
  }

  async function updateSettings(userId, updates) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return updateSettingsWithBudgetStore(userId, updates);
    }

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

  async function cachedFxRateForSettings(userId, baseCurrency, rateDate, quoteCurrency) {
    if (typeof getCachedFxRateAsync === "function") {
      return Number(await getCachedFxRateAsync(userId, baseCurrency, rateDate, quoteCurrency));
    }
    if (typeof getCachedFxRate === "function") {
      return Number(getCachedFxRate(userId, baseCurrency, rateDate, quoteCurrency));
    }
    return null;
  }

  async function confirmedBalanceForSettings(userId, settings) {
    const ledgerCurrency = normalizeSupportedCurrency(settings?.ledger_currency || "PLN");
    if (typeof latestConfirmedBalanceAsync === "function") {
      return Number(await latestConfirmedBalanceAsync(userId, {
        ledgerCurrency,
        settings
      }) || 0);
    }
    if (budgetStore && typeof budgetStore.listConfirmedTransactions === "function") {
      const rows = (await budgetStore.listConfirmedTransactions(userId))
        .filter(row => String(row.ledger_currency || "PLN") === ledgerCurrency);
      return latestBalanceFromConfirmedRows(rows, { openingBalance: 0 });
    }
    if (typeof latestConfirmedBalance === "function") {
      return Number(latestConfirmedBalance(userId) || 0);
    }
    return 0;
  }

  function postgresSettingsUpdate(values) {
    const row = {
      ...values,
      id: 1,
      updated_at: new Date().toISOString()
    };
    for (const field of POSTGRES_BOOLEAN_SETTINGS) {
      if (Object.prototype.hasOwnProperty.call(row, field)) {
        row[field] = row[field] === true || row[field] === 1;
      }
    }
    return row;
  }

  function activeIncomeValue(value) {
    return value === true || Number(value) === 1;
  }

  async function buildLedgerSwitch(userId, currentSettings, safeUpdates) {
    const previousLedgerCurrency = normalizeSupportedCurrency(currentSettings?.ledger_currency || "PLN");
    const nextLedgerCurrency = safeUpdates.ledger_currency || previousLedgerCurrency;
    const ledgerCurrencyChanged = nextLedgerCurrency !== previousLedgerCurrency;
    if (!ledgerCurrencyChanged) return null;

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

    if (!Number.isFinite(rate) || rate <= 0) {
      rate = await cachedFxRateForSettings(userId, previousLedgerCurrency, rateDate, nextLedgerCurrency);
      source = "cache";
    }

    if (!Number.isFinite(rate) || rate <= 0) {
      const inverse = await cachedFxRateForSettings(userId, nextLedgerCurrency, rateDate, previousLedgerCurrency);

      if (Number.isFinite(inverse) && inverse > 0) {
        rate = 1 / inverse;
        source = "inverse-cache";
      }
    }

    const oldBalance = await confirmedBalanceForSettings(userId, currentSettings);

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

    return {
      oldCurrency: previousLedgerCurrency,
      newCurrency: nextLedgerCurrency,
      oldBalance: roundMoneyAmount(oldBalance),
      convertedOpeningBalance: multiplyMoney(oldBalance, rate),
      rate,
      rateDate,
      source
    };
  }

  async function updateSettingsWithBudgetStore(userId, updates) {
    const currentSettings = await getSettingsAsync(userId);
    const safeUpdates = validateAndNormalizeSettings(updates, {
      allowedKeysOnly: true,
      currentSettings,
      normalizeLocale
    });
    const ledgerSwitch = await buildLedgerSwitch(userId, currentSettings, safeUpdates);

    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      if (safeUpdates.budget_period_income_id) {
        const income = (await writer.listPlanningRows(userId, "recurring_incomes"))
          .find(row => row.id === safeUpdates.budget_period_income_id) || null;

        if (!income) {
          throw badRequest("Selected budget period income does not exist");
        }

        if (!activeIncomeValue(income.active)) {
          throw badRequest("Selected budget period income must be active");
        }
      }

      if (ledgerSwitch) {
        const unresolvedConversion = (await writer.listPlanningRows(userId, "pending_transactions"))
          .filter(row => String(row.occurrence_key || "").startsWith("ledger_currency_conversion:"))
          .sort((a, b) => {
            const created = String(a.created_at || "").localeCompare(String(b.created_at || ""));
            if (created !== 0) return created;
            return String(a.id || "").localeCompare(String(b.id || ""));
          })[0] || null;

        if (unresolvedConversion) {
          throw conflict("Confirm or clear the pending ledger currency conversion before changing ledger currency again", [{
            field: "ledger_currency",
            reason: "pending_conversion",
            pendingConversionId: unresolvedConversion.id,
            ledgerCurrency: unresolvedConversion.ledger_currency
          }]);
        }
      }

      if (Object.keys(safeUpdates).length) {
        await writer.updatePlanningRowsById(userId, "settings", [postgresSettingsUpdate(safeUpdates)]);
      }

      if (ledgerSwitch) {
        const conversionId = generateId("pending-ledger-currency");
        const convertedAmount = roundMoneyAmount(Math.abs(ledgerSwitch.convertedOpeningBalance));
        const conversionType = ledgerSwitch.convertedOpeningBalance >= 0 ? "income" : "expense";
        const timestamp = new Date().toISOString();
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

        await writer.insertPlanningRows(userId, "ledger_currency_events", [{
          converted_opening_balance: ledgerSwitch.convertedOpeningBalance,
          created_at: timestamp,
          details: JSON.stringify({ reason: "settings-update" }),
          fx_rate: ledgerSwitch.rate,
          id: generateId("ledger-currency"),
          new_currency: ledgerSwitch.newCurrency,
          old_balance: ledgerSwitch.oldBalance,
          old_currency: ledgerSwitch.oldCurrency,
          rate_date: ledgerSwitch.rateDate,
          source: ledgerSwitch.source
        }]);

        await writer.insertPlanningRows(userId, "pending_transactions", [{
          amount: convertedAmount,
          buffered_fx_rate: 1,
          created_at: timestamp,
          currency: ledgerSwitch.newCurrency,
          date: ledgerSwitch.rateDate,
          funded_amount: convertedAmount,
          fx_rate: 1,
          id: conversionId,
          ledger_amount: convertedAmount,
          ledger_currency: ledgerSwitch.newCurrency,
          name: `Opening balance conversion ${ledgerSwitch.oldCurrency} to ${ledgerSwitch.newCurrency}`,
          note,
          occurrence_key: `ledger_currency_conversion:${conversionId}`,
          pending_origin: "system",
          requested_amount: convertedAmount,
          status: "pending",
          type: conversionType,
          updated_at: timestamp
        }]);
      }

      if (Object.prototype.hasOwnProperty.call(safeUpdates, "budget_period_income_id")) {
        const incomeId = safeUpdates.budget_period_income_id || "__none__";
        const incomes = await writer.listPlanningRows(userId, "recurring_incomes");
        await writer.updatePlanningRowsById(userId, "recurring_incomes", incomes.map(row => ({
          id: row.id,
          period_setting: row.id === incomeId,
          updated_at: new Date().toISOString()
        })));
      }

      if (ledgerSwitch && typeof recalculatePlanningRunningBalancesAsync === "function") {
        await recalculatePlanningRunningBalancesAsync(userId, writer);
      }

      return (await writer.listPlanningRows(userId, "settings"))
        .find(row => Number(row.id) === 1) || currentSettings || {};
    });

    return result;
  }

  return {
    getSettings,
    getSettingsAsync,
    updateSettings
  };
}
