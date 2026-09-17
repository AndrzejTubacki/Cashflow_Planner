import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";
import { requireIsoMonth } from "./cashflow-date-utils.js";
import { requireNumber } from "./cashflow-input-validation.js";
import {
  latestBalanceFromConfirmedRows,
  sortConfirmedRowsForBalance,
  storedOrComputedConfirmedLedgerAmount
} from "./cashflow-ledger-balance-utils.js";
import { addMoneyAmounts, multiplyMoney, roundMoneyAmount, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import {
  applyPlanningRunningBalancePlan,
  createPlanningRunningBalancePlan
} from "./cashflow-planning-balance-plan.js";
import { badRequest } from "./cashflow-user-utils.js";

export function createCashflowProjectionStateService({
  budgetStore = null,
  latestConfirmedBalance,
  listLedgerYears,
  loadAllConfirmedTransactions,
  openLedgerDb
}) {
  function normalizePendingStatus(status) {
    return status === "partial" || status === "underfunded" ? status : "pending";
  }

  function requireStartMonthYearIfNeeded(input) {
    const repeatEveryMonths = input.repeat_every_months === undefined
      ? 1
      : requireNumber(input.repeat_every_months, "repeat_every_months", { min: 1, max: 12, integer: true });

    if (repeatEveryMonths > 1 && !input.start_month_year) {
      throw badRequest("start_month_year is required when repeat_every_months is greater than 1");
    }

    if (input.start_month_year) {
      input.start_month_year = requireIsoMonth(input.start_month_year);
    }

    return repeatEveryMonths;
  }

  function normalizeRecurringInput(existing, input) {
    const merged = {
      ...existing,
      ...input
    };

    merged.repeat_every_months = requireNumber(merged.repeat_every_months, "repeat_every_months", {
      min: 1,
      max: 12,
      integer: true
    });

    if (merged.repeat_every_months > 1 && !merged.start_month_year) {
      throw badRequest("start_month_year is required when repeat_every_months is greater than 1");
    }

    if (merged.start_month_year) {
      merged.start_month_year = requireIsoMonth(merged.start_month_year);
    }

    return merged;
  }

  function pendingOccurrenceRow(db, occurrenceKey) {
    if (!occurrenceKey) return null;

    return db.prepare(`
      SELECT *
      FROM pending_transactions
      WHERE occurrence_key = ?
      LIMIT 1
    `).get(occurrenceKey) || null;
  }

  function pendingOccurrenceExists(db, occurrenceKey) {
    return Boolean(pendingOccurrenceRow(db, occurrenceKey));
  }

  function confirmedOccurrenceKeys(userId) {
    return new Set(
      loadAllConfirmedTransactions(userId)
        .map(row => row.occurrence_key || occurrenceKeyFromRow(row))
        .filter(Boolean)
    );
  }

  async function confirmedOccurrenceKeysAsync(userId) {
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return confirmedOccurrenceKeys(userId);
    }

    return new Set(
      (await confirmedRowsForBudgetStore(userId))
        .map(row => row.occurrence_key || occurrenceKeyFromRow(row))
        .filter(Boolean)
    );
  }

  function confirmedOneOffProgressFromRows(rows = []) {
    // Track installments in original transaction units so projection can generate only the unconfirmed remainder.
    const progress = new Map();

    for (const row of rows) {
      const sourceId = row.source_one_off_id;
      if (!sourceId) continue;

      const currency = String(row.currency || "").toUpperCase();
      const type = String(row.type || "");
      const key = `${sourceId}:${type}:${currency}`;
      const current = progress.get(key) || {
        sourceId,
        type,
        currency,
        confirmedAmount: 0,
        confirmedCount: 0
      };

      current.confirmedAmount = addMoneyAmounts(current.confirmedAmount, row.amount);
      current.confirmedCount += 1;
      progress.set(key, current);
    }

    return progress;
  }

  function confirmedOneOffProgress(userId) {
    return confirmedOneOffProgressFromRows(loadAllConfirmedTransactions(userId));
  }

  async function confirmedOneOffProgressAsync(userId) {
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return confirmedOneOffProgress(userId);
    }

    return confirmedOneOffProgressFromRows(await confirmedRowsForBudgetStore(userId));
  }

  function findConfirmedOccurrence(userId, occurrenceKey) {
    if (!occurrenceKey) return null;

    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        const byKey = ledgerDb.prepare(`
          SELECT *, ? AS ledger_year
          FROM confirmed_transactions
          WHERE occurrence_key = ?
          LIMIT 1
        `).get(year, occurrenceKey);

        if (byKey) return byKey;

        const rows = ledgerDb.prepare(`
          SELECT *, ? AS ledger_year
          FROM confirmed_transactions
          WHERE occurrence_key IS NULL
        `).all(year);

        const fallback = rows.find(row => occurrenceKeyFromRow(row) === occurrenceKey);
        if (fallback) return fallback;
      } finally {
        ledgerDb.close();
      }
    }

    return null;
  }

  async function findConfirmedOccurrenceAsync(userId, occurrenceKey) {
    if (!occurrenceKey) return null;
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return findConfirmedOccurrence(userId, occurrenceKey);
    }

    const rows = await confirmedRowsForBudgetStore(userId);
    const byKey = rows.find(row => row.occurrence_key === occurrenceKey);
    if (byKey) return byKey;

    return rows.find(row => !row.occurrence_key && occurrenceKeyFromRow(row) === occurrenceKey) || null;
  }

  function deletePendingOccurrence(db, occurrenceKey) {
    if (!occurrenceKey) return 0;

    return db.prepare(`
      DELETE FROM pending_transactions
      WHERE occurrence_key = ?
    `).run(occurrenceKey).changes;
  }

  function refreshPendingOccurrence(db, tx, converted, occurrenceKey) {
    const pending = pendingOccurrenceRow(db, occurrenceKey);
    if (!pending) return null;

    // Pending rows are actionable user decisions. Ordinary projection rebuilds must
    // not overwrite edits; the explicit pending-recalculation action replaces them.
    return {
      ...pending,
      ledger_amount_delta: 0
    };
  }

  function currentLedgerCurrency(db) {
    const settings = db.prepare("SELECT ledger_currency FROM settings WHERE id = 1").get() || {};
    return settings.ledger_currency || "PLN";
  }

  function confirmedLedgerAmount(row) {
    if (row.ledger_amount !== null && row.ledger_amount !== undefined) {
      return roundMoneyAmount(row.ledger_amount);
    }

    return multiplyMoney(row.amount, row.buffered_fx_rate || row.fx_rate || 1);
  }

  async function settingsForBudgetStore(userId, store = budgetStore) {
    if (!store || typeof store.listPlanningRows !== "function") {
      return {};
    }

    const rows = await store.listPlanningRows(userId, "settings");
    return rows?.[0] || {};
  }

  async function confirmedRowsForBudgetStore(userId, store = budgetStore) {
    if (!store || typeof store.listConfirmedTransactions !== "function") {
      return sortConfirmedRowsForBalance(loadAllConfirmedTransactions(userId));
    }

    if (typeof store.listLedgerYears !== "function") {
      return sortConfirmedRowsForBalance(await store.listConfirmedTransactions(userId));
    }

    const rows = [];
    for (const year of await store.listLedgerYears(userId)) {
      rows.push(...(await store.listConfirmedTransactions(userId, { ledgerYear: Number(year) })));
    }
    return sortConfirmedRowsForBalance(rows);
  }

  function confirmedRowsForCurrentLedger(db, userId) {
    if (!userId) return [];

    const ledgerCurrency = currentLedgerCurrency(db);
    return loadAllConfirmedTransactions(userId)
      .filter(row => String(row.ledger_currency || "PLN") === ledgerCurrency);
  }

  async function confirmedRowsForCurrentLedgerAsync(userId, settings = null, store = budgetStore) {
    if (!userId) return [];

    const effectiveSettings = settings || await settingsForBudgetStore(userId, store);
    const ledgerCurrency = effectiveSettings?.ledger_currency || "PLN";
    return (await confirmedRowsForBudgetStore(userId, store))
      .filter(row => String(row.ledger_currency || "PLN") === ledgerCurrency);
  }

  function confirmedBalanceAsOf(db, userId, cutoffDate = null) {
    const rows = confirmedRowsForCurrentLedger(db, userId)
      .filter(row => !cutoffDate || String(row.date || "") <= cutoffDate);

    if (!rows.length) return 0;

    const latest = rows.at(-1);
    if (latest.running_balance_pln !== null && latest.running_balance_pln !== undefined) {
      return roundMoneyAmount(latest.running_balance_pln);
    }

    return roundMoneyAmount(rows.reduce((balance, row) => {
      const amount = confirmedLedgerAmount(row);
      return row.type === "income"
        ? addMoneyAmounts(balance, amount)
        : subtractMoneyAmounts(balance, amount);
    }, 0));
  }

  function confirmedRowsAfterDate(db, userId, date) {
    return confirmedRowsForCurrentLedger(db, userId)
      .filter(row => String(row.date || "") > date)
      .map(row => ({
        ...row,
        ledger_amount: confirmedLedgerAmount(row)
      }));
  }

  async function confirmedBalanceAsOfAsync(userId, cutoffDate = null, settings = null, store = budgetStore) {
    if (!store || typeof store.listConfirmedTransactions !== "function") {
      const rows = loadAllConfirmedTransactions(userId)
        .filter(row => String(row.ledger_currency || "PLN") === (settings?.ledger_currency || "PLN"))
        .filter(row => !cutoffDate || String(row.date || "") <= cutoffDate);
      return latestBalanceFromConfirmedRows(rows, { openingBalance: 0 });
    }

    const rows = (await confirmedRowsForCurrentLedgerAsync(userId, settings, store))
      .filter(row => !cutoffDate || String(row.date || "") <= cutoffDate);
    return latestBalanceFromConfirmedRows(rows, { openingBalance: 0 });
  }

  async function confirmedRowsAfterDateAsync(userId, date, settings = null) {
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return loadAllConfirmedTransactions(userId)
        .filter(row => String(row.ledger_currency || "PLN") === (settings?.ledger_currency || "PLN"))
        .filter(row => String(row.date || "") > date)
        .map(row => ({
          ...row,
          ledger_amount: confirmedLedgerAmount(row)
        }));
    }

    return (await confirmedRowsForCurrentLedgerAsync(userId, settings))
      .filter(row => String(row.date || "") > date)
      .map(row => ({
        ...row,
        ledger_amount: storedOrComputedConfirmedLedgerAmount(row)
      }));
  }

  function recalculatePlanningRunningBalances(db, userId = null) {
    const settings = db.prepare("SELECT ledger_currency, timezone FROM settings WHERE id = 1").get() || {};
    const plan = createPlanningRunningBalancePlan({
      confirmedRows: userId ? loadAllConfirmedTransactions(userId) : [],
      futureRows: db.prepare("SELECT * FROM future_transactions").all(),
      pendingRows: db.prepare("SELECT * FROM pending_transactions").all(),
      settings
    });

    const updatePending = db.prepare(`
      UPDATE pending_transactions
      SET running_balance = ?
      WHERE id = ?
    `);

    const updateFuture = db.prepare(`
      UPDATE future_transactions
      SET running_balance = ?
      WHERE id = ?
    `);

    for (const row of plan.updates) {
      if (row.bucket === "pending") {
        updatePending.run(row.running_balance, row.id);
      } else {
        updateFuture.run(row.running_balance, row.id);
      }
    }
  }

  async function recalculatePlanningRunningBalancesAsync(userId, store = budgetStore) {
    if (!store || typeof store.listPlanningRows !== "function" || typeof store.updatePlanningRowsById !== "function") {
      throw new Error("A budget store with planning read/write support is required");
    }

    const settingsRows = await store.listPlanningRows(userId, "settings");
    const pendingRows = await store.listPlanningRows(userId, "pending_transactions");
    const futureRows = await store.listPlanningRows(userId, "future_transactions");
    const confirmedRows = await confirmedRowsForBudgetStore(userId, store);
    const plan = createPlanningRunningBalancePlan({
      confirmedRows,
      futureRows,
      pendingRows,
      settings: settingsRows?.[0] || {}
    });
    const result = await applyPlanningRunningBalancePlan({
      budgetId: userId,
      budgetStore: store,
      plan
    });
    return {
      ...result,
      plan
    };
  }

  function pendingNetBalance(db) {
    const settings = db.prepare("SELECT ledger_currency FROM settings WHERE id = 1").get() || {};
    const ledgerCurrency = settings.ledger_currency || "PLN";

    return roundMoneyAmount(db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN type = 'income' THEN COALESCE(ledger_amount, 0)
          ELSE -COALESCE(ledger_amount, 0)
        END
      ), 0) AS value
      FROM pending_transactions
      WHERE COALESCE(ledger_currency, 'PLN') = ?
    `).get(ledgerCurrency).value);
  }

  async function pendingNetBalanceAsync(userId, settings = null, store = budgetStore) {
    if (!store || typeof store.listPlanningRows !== "function") {
      throw new Error("A budget store with planning read support is required");
    }

    const effectiveSettings = settings || await settingsForBudgetStore(userId, store);
    const ledgerCurrency = effectiveSettings?.ledger_currency || "PLN";
    const rows = await store.listPlanningRows(userId, "pending_transactions");
    return roundMoneyAmount(rows.reduce((total, row) => {
      if (String(row.ledger_currency || "PLN") !== ledgerCurrency) return total;
      const amount = roundMoneyAmount(row.ledger_amount);
      return row.type === "income"
        ? addMoneyAmounts(total, amount)
        : subtractMoneyAmounts(total, amount);
    }, 0));
  }

  function planningOpeningBalance(db, userId, { includePending = true } = {}) {
    return addMoneyAmounts(latestConfirmedBalance(userId), includePending ? pendingNetBalance(db) : 0);
  }

  async function planningOpeningBalanceAsync(userId, {
    includePending = true,
    settings = null,
    store = budgetStore
  } = {}) {
    const effectiveSettings = settings || await settingsForBudgetStore(userId, store);
    return addMoneyAmounts(
      await confirmedBalanceAsOfAsync(userId, null, effectiveSettings, store),
      includePending ? await pendingNetBalanceAsync(userId, effectiveSettings, store) : 0
    );
  }

  return {
    confirmedBalanceAsOf,
    confirmedBalanceAsOfAsync,
    confirmedOccurrenceKeys,
    confirmedOccurrenceKeysAsync,
    confirmedRowsAfterDate,
    confirmedRowsAfterDateAsync,
    confirmedOneOffProgress,
    confirmedOneOffProgressAsync,
    deletePendingOccurrence,
    findConfirmedOccurrence,
    findConfirmedOccurrenceAsync,
    normalizePendingStatus,
    normalizeRecurringInput,
    pendingOccurrenceExists,
    pendingOccurrenceRow,
    pendingNetBalance,
    pendingNetBalanceAsync,
    planningOpeningBalance,
    planningOpeningBalanceAsync,
    recalculatePlanningRunningBalances,
    recalculatePlanningRunningBalancesAsync,
    refreshPendingOccurrence,
    requireStartMonthYearIfNeeded
  };
}
