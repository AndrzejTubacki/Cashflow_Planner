import { addMonths, todayInTimezone } from "./cashflow-date-utils.js";
import {
  applyLedgerRunningBalancePlan,
  createLedgerRunningBalancePlan
} from "./cashflow-ledger-balance-plan.js";
import {
  confirmedRowsWithRunningBalances,
  latestBalanceFromConfirmedRows,
  sortConfirmedRowsForBalance,
  storedOrComputedConfirmedLedgerAmount,
  wouldConfirmedRowsGoNegative
} from "./cashflow-ledger-balance-utils.js";
import { addMoneyAmounts, multiplyMoney, roundMoneyAmount, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import { badRequest } from "./cashflow-user-utils.js";
import { budgetLedgerOpeningBalance, sqliteLedgerOpeningBalance } from "./cashflow-ledger-opening.js";
import { buildLedgerHistorySummary } from "./cashflow-ledger-history-summary.js";

/** Ledger readers and mutation plans retain the verified currency-scoped
 * standalone opening; ordinary budgets keep the historical zero opening. */
export function createCashflowLedgerService({
  budgetStore = null,
  allowStandaloneOrigins = false,
  generateId = prefix => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  listLedgerYears,
  openLedgerDb,
  openPlanningDb
}) {
  function requireFundingSourceColumn(sourceColumn) {
    if (!["source_flex_id", "source_goal_id"].includes(sourceColumn)) {
      throw new Error(`Unsupported funding source column: ${sourceColumn}`);
    }
    return sourceColumn;
  }

  function dateKey(value) {
    if (value instanceof Date) {
      const year = value.getFullYear();
      const month = String(value.getMonth() + 1).padStart(2, "0");
      const day = String(value.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }

    return String(value || "").slice(0, 10);
  }

  function currentLedgerSettings(userId) {
    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare("SELECT ledger_currency FROM settings WHERE id = 1").get() || {};
      const ledgerCurrency = settings.ledger_currency || "PLN";

      return {
        ledgerCurrency,
        openingBalance: sqliteLedgerOpeningBalance(db, userId, ledgerCurrency, { allowStandaloneOrigins })
      };
    } finally {
      db.close();
    }
  }

  async function currentLedgerSettingsAsync(userId) {
    if (budgetStore && typeof budgetStore.listPlanningRows === "function") {
      const settings = (await budgetStore.listPlanningRows(userId, "settings"))?.[0] || {};
      return {
        ledgerCurrency: settings.ledger_currency || "PLN"
      };
    }

    return currentLedgerSettings(userId);
  }

  function rowsForCurrentLedger(userId) {
    const { ledgerCurrency, openingBalance } = currentLedgerSettings(userId);
    const rows = loadAllConfirmedTransactions(userId)
      .filter(row => String(row.ledger_currency || "PLN") === ledgerCurrency);

    return {
      ledgerCurrency,
      openingBalance,
      rows
    };
  }

  function loadAllConfirmedTransactions(userId) {
    const rows = [];

    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        const yearRows = ledgerDb.prepare(`
          SELECT *, ? AS ledger_year
          FROM confirmed_transactions
        `).all(year);

        rows.push(...yearRows);
      } finally {
        ledgerDb.close();
      }
    }

    return sortConfirmedRowsForBalance(rows);
  }

  async function loadAllConfirmedTransactionsAsync(userId) {
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return loadAllConfirmedTransactions(userId);
    }

    if (typeof budgetStore.listLedgerYears !== "function") {
      return sortConfirmedRowsForBalance(await budgetStore.listConfirmedTransactions(userId));
    }

    const rows = [];
    for (const year of await budgetStore.listLedgerYears(userId)) {
      rows.push(...(await budgetStore.listConfirmedTransactions(userId, { ledgerYear: Number(year) })));
    }
    return sortConfirmedRowsForBalance(rows);
  }

  /** Summaries are derived metadata; accepted facts remain available indefinitely. */
  function historicalLedgerCompactionPlanFromRows(settings = {}, rows = [], options = {}, cachedJson = null) {
    const months = options.months !== undefined && options.months !== null && options.months !== ""
      ? Number(options.months) : Number(settings.ledger_history_compaction_months || 0);
    if (!Number.isInteger(months) || months < 0 || months > 600) {
      throw badRequest("ledger_history_compaction_months must be an integer between 0 and 600", [{
        field: "ledger_history_compaction_months", reason: "invalid_compaction_age"
      }]);
    }
    const today = options.today || options.plan?.today || todayInTimezone(settings.timezone);
    const cutoffDate = months ? addMonths(today, -months) : null;
    const eligible = months ? rows.filter(row => dateKey(row.confirmed_date || row.date) < cutoffDate) : [];
    const summary = buildLedgerHistorySummary(eligible, cachedJson);
    return { ok: true, enabled: months > 0, months, today, cutoffDate,
      eligibleRows: eligible.length, eligibleDetailRows: eligible.length,
      detailsRetained: true, retainedRows: rows.length,
      ledgerCurrencies: summary.summaries.map(row => row.ledgerCurrency),
      ...summary };
  }

  /** Merge legacy ledger files first, then inspect unified facts and derived cache. */
  function historicalLedgerCompactionPlan(userId, options = {}) {
    const rows = loadAllConfirmedTransactions(userId);
    const db = openPlanningDb(userId);
    try {
      return historicalLedgerCompactionPlanFromRows(
        db.prepare("SELECT * FROM settings WHERE id = 1").get() || {}, rows, options,
        db.prepare("SELECT cache_json FROM cashflow_ledger_summary_cache WHERE budget_id = ?").get(userId)?.cache_json);
    } finally { db.close(); }
  }

  async function historicalLedgerCompactionPlanAsync(userId, options = {}) {
    if (!budgetStore || typeof budgetStore.transaction !== "function") return historicalLedgerCompactionPlan(userId, options);
    return budgetStore.transaction(async (writer, client) => historicalLedgerCompactionPlanFromRows(
      (await writer.listPlanningRows(userId, "settings"))[0] || {},
      await writer.listConfirmedTransactions(userId), options,
      (await client.query("SELECT cache_json FROM cashflow_ledger_summary_cache WHERE budget_id = $1", [userId])).rows[0]?.cache_json));
  }

  /** Re-read under the write transaction: a stale preview cannot summarize deleted
   * or changed facts. No financial writes, synthetic payments or epoch rotation. */
  function compactHistoricalLedger(userId, options = {}) {
    loadAllConfirmedTransactions(userId);
    const db = openPlanningDb(userId);
    try {
      return db.transaction(() => {
        const plan = historicalLedgerCompactionPlanFromRows(
          db.prepare("SELECT * FROM settings WHERE id = 1").get() || {},
          db.prepare("SELECT * FROM ledger_transactions").all(), options,
          db.prepare("SELECT cache_json FROM cashflow_ledger_summary_cache WHERE budget_id = ?").get(userId)?.cache_json);
        if (plan.needsCompaction) db.prepare(`INSERT INTO cashflow_ledger_summary_cache (budget_id, cache_json, updated_at)
          VALUES (?, ?, ?) ON CONFLICT (budget_id) DO UPDATE SET cache_json = excluded.cache_json, updated_at = excluded.updated_at`)
          .run(userId, JSON.stringify(plan.cache), options.now || new Date().toISOString());
        return { ...plan, compactedRows: plan.needsCompaction ? plan.eligibleRows : 0,
          createdRows: plan.needsCompaction ? plan.summaries.length : 0 };
      })();
    } finally { db.close(); }
  }

  /** Serialize derived metadata with ledger writers across PostgreSQL replicas. */
  async function compactHistoricalLedgerAsync(userId, options = {}) {
    if (!budgetStore || typeof budgetStore.transaction !== "function") return compactHistoricalLedger(userId, options);
    return budgetStore.transaction(async (writer, client) => {
      await writer.lockBudgetLedger(userId);
      const plan = historicalLedgerCompactionPlanFromRows(
        (await writer.listPlanningRows(userId, "settings"))[0] || {},
        await writer.listConfirmedTransactions(userId), options,
        (await client.query("SELECT cache_json FROM cashflow_ledger_summary_cache WHERE budget_id = $1", [userId])).rows[0]?.cache_json);
      if (plan.needsCompaction) await client.query(`INSERT INTO cashflow_ledger_summary_cache (budget_id, cache_json, updated_at)
        VALUES ($1, $2, $3) ON CONFLICT (budget_id) DO UPDATE SET cache_json = excluded.cache_json, updated_at = excluded.updated_at`,
        [userId, JSON.stringify(plan.cache), options.now || new Date().toISOString()]);
      return { ...plan, compactedRows: plan.needsCompaction ? plan.eligibleRows : 0,
        createdRows: plan.needsCompaction ? plan.summaries.length : 0 };
    });
  }

  function normalizeConfirmedPageOptions(options = {}) {
    const limit = Math.min(500, Math.max(1, Math.trunc(Number(options.limit || 100))));
    const offset = Math.max(0, Math.trunc(Number(options.offset || 0)));
    if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
      throw badRequest("Invalid pagination parameters", [{ field: "limit", reason: "invalid_pagination" }]);
    }

    const year = options.year === undefined || options.year === null || options.year === ""
      ? null
      : String(options.year);
    if (year && !/^\d{4}$/.test(year)) {
      throw badRequest("year must be YYYY", [{ field: "year", reason: "invalid_year" }]);
    }

    const type = options.type ? String(options.type) : null;
    if (type && !["income", "expense"].includes(type)) {
      throw badRequest("type must be income or expense", [{ field: "type", reason: "unsupported_value" }]);
    }

    const sourceColumns = {
      recurring_expense: "source_recurring_expense_id",
      recurring_income: "source_recurring_income_id",
      one_off: "source_one_off_id",
      flex: "source_flex_id",
      goal: "source_goal_id"
    };
    const sourceType = options.sourceType ? String(options.sourceType) : null;
    if (sourceType && !sourceColumns[sourceType]) {
      throw badRequest("sourceType is not supported", [{ field: "sourceType", reason: "unsupported_value" }]);
    }

    return {
      currency: options.currency ? String(options.currency).trim().toUpperCase() : null,
      dateFrom: options.dateFrom ? String(options.dateFrom) : null,
      dateTo: options.dateTo ? String(options.dateTo) : null,
      ledgerCurrency: options.ledgerCurrency ? String(options.ledgerCurrency).trim().toUpperCase() : null,
      limit,
      offset,
      sourceColumn: sourceType ? sourceColumns[sourceType] : null,
      sourceId: options.sourceId ? String(options.sourceId) : null,
      sourceType,
      type,
      year
    };
  }

  function confirmedRowMatchesPageFilters(row, filters) {
    if (filters.type && row.type !== filters.type) return false;
    if (filters.currency && String(row.currency || "").toUpperCase() !== filters.currency) return false;
    if (filters.ledgerCurrency && String(row.ledger_currency || "PLN").toUpperCase() !== filters.ledgerCurrency) return false;
    if (filters.dateFrom && String(row.date || "") < filters.dateFrom) return false;
    if (filters.dateTo && String(row.date || "") > filters.dateTo) return false;
    if (filters.sourceColumn && filters.sourceId) {
      return String(row[filters.sourceColumn] || "") === filters.sourceId;
    }
    if (filters.sourceColumn) {
      return row[filters.sourceColumn] !== null
        && row[filters.sourceColumn] !== undefined
        && String(row[filters.sourceColumn] || "") !== "";
    }
    return true;
  }

  function confirmedTransactionsPageFromRows(rows, filters) {
    const filteredRows = rows.filter(row => confirmedRowMatchesPageFilters(row, filters));

    filteredRows.sort((a, b) => {
      const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
      if (dateCompare !== 0) return dateCompare;
      const createdCompare = String(b.created_at || "").localeCompare(String(a.created_at || ""));
      if (createdCompare !== 0) return createdCompare;
      return String(b.id || "").localeCompare(String(a.id || ""));
    });

    return {
      filters: {
        currency: filters.currency,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        ledgerCurrency: filters.ledgerCurrency,
        sourceId: filters.sourceId,
        sourceType: filters.sourceType,
        type: filters.type,
        year: filters.year
      },
      limit: filters.limit,
      offset: filters.offset,
      total: filteredRows.length,
      rows: filteredRows
        .slice(filters.offset, filters.offset + filters.limit)
        .map(row => row.ledger_year === undefined || row.ledger_year === null
          ? row
          : {
              ...row,
              ledger_year: String(row.ledger_year)
            })
    };
  }

  function listConfirmedTransactionsPage(userId, options = {}) {
    const filters = normalizeConfirmedPageOptions(options);
    const availableYears = listLedgerYears(userId);
    const years = filters.year
      ? availableYears.includes(filters.year) ? [filters.year] : []
      : availableYears;
    const rows = [];

    for (const year of years) {
      const ledgerDb = openLedgerDb(userId, year, { create: false });
      try {
        const where = [];
        const params = [];
        if (filters.type) {
          where.push("type = ?");
          params.push(filters.type);
        }
        if (filters.currency) {
          where.push("currency = ?");
          params.push(filters.currency);
        }
        if (filters.ledgerCurrency) {
          where.push("COALESCE(ledger_currency, 'PLN') = ?");
          params.push(filters.ledgerCurrency);
        }
        if (filters.dateFrom) {
          where.push("date >= ?");
          params.push(filters.dateFrom);
        }
        if (filters.dateTo) {
          where.push("date <= ?");
          params.push(filters.dateTo);
        }
        if (filters.sourceColumn && filters.sourceId) {
          where.push(`${filters.sourceColumn} = ?`);
          params.push(filters.sourceId);
        } else if (filters.sourceColumn) {
          where.push(`${filters.sourceColumn} IS NOT NULL`);
        }

        const result = ledgerDb.prepare(`
          SELECT *, ? AS ledger_year
          FROM confirmed_transactions
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        `).all(year, ...params);
        rows.push(...result);
      } finally {
        ledgerDb.close();
      }
    }

    return confirmedTransactionsPageFromRows(rows, filters);
  }

  async function listConfirmedTransactionsPageAsync(userId, options = {}) {
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return listConfirmedTransactionsPage(userId, options);
    }

    const filters = normalizeConfirmedPageOptions(options);
    if (filters.year && typeof budgetStore.listLedgerYears === "function") {
      const years = (await budgetStore.listLedgerYears(userId)).map(year => String(year));
      if (!years.includes(filters.year)) {
        return confirmedTransactionsPageFromRows([], filters);
      }
    }
    const rows = await budgetStore.listConfirmedTransactions(userId, {
      ledgerYear: filters.year ? Number(filters.year) : null
    });
    return confirmedTransactionsPageFromRows(rows, filters);
  }

  function sumConfirmedFunding(userId, sourceColumn, sourceId, targetCurrency = "PLN", settings = null) {
    const safeSourceColumn = requireFundingSourceColumn(sourceColumn);
    let totalLedger = 0;
    const ledgerCurrency = settings?.ledger_currency || currentLedgerSettings(userId).ledgerCurrency;

    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        const rows = ledgerDb.prepare(`
          SELECT amount, fx_rate, buffered_fx_rate, ledger_amount
          FROM confirmed_transactions
          WHERE ${safeSourceColumn} = ?
            AND type = 'expense'
            AND COALESCE(ledger_currency, 'PLN') = ?
        `).all(sourceId, ledgerCurrency);

        for (const row of rows) {
          if (row.ledger_amount !== null && row.ledger_amount !== undefined) {
            totalLedger = addMoneyAmounts(totalLedger, row.ledger_amount);
          } else {
            totalLedger = addMoneyAmounts(totalLedger, multiplyMoney(row.amount, row.buffered_fx_rate || row.fx_rate || 1));
          }
        }
      } finally {
        ledgerDb.close();
      }
    }

    return totalLedger;
  }

  function sumConfirmedFundingFromRows(rows, sourceColumn, sourceId, ledgerCurrency) {
    const safeSourceColumn = requireFundingSourceColumn(sourceColumn);
    let totalLedger = 0;
    for (const row of rows || []) {
      if (row?.[safeSourceColumn] !== sourceId) continue;
      if (row?.type === "income") continue;
      if (String(row?.ledger_currency || "PLN") !== ledgerCurrency) continue;
      totalLedger = addMoneyAmounts(totalLedger, storedOrComputedConfirmedLedgerAmount(row));
    }
    return totalLedger;
  }

  async function sumConfirmedFundingAsync(userId, sourceColumn, sourceId, targetCurrency = "PLN", settings = null) {
    const ledgerCurrency = settings?.ledger_currency || (await currentLedgerSettingsAsync(userId)).ledgerCurrency;
    const rows = await loadAllConfirmedTransactionsAsync(userId);
    return sumConfirmedFundingFromRows(rows, sourceColumn, sourceId, ledgerCurrency);
  }

  function confirmedFundingTotals(userId, targetCurrency = "PLN", settings = null) {
    const ledgerCurrency = settings?.ledger_currency || currentLedgerSettings(userId).ledgerCurrency;
    const totals = {
      source_flex_id: new Map(),
      source_goal_id: new Map()
    };

    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        const rows = ledgerDb.prepare(`
          SELECT source_flex_id, source_goal_id, amount, fx_rate, buffered_fx_rate, ledger_amount
          FROM confirmed_transactions
          WHERE COALESCE(ledger_currency, 'PLN') = ?
            AND type = 'expense'
            AND (source_flex_id IS NOT NULL OR source_goal_id IS NOT NULL)
        `).all(ledgerCurrency);

        for (const row of rows) {
          const amount = row.ledger_amount !== null && row.ledger_amount !== undefined
            ? roundMoneyAmount(row.ledger_amount)
            : multiplyMoney(row.amount, row.buffered_fx_rate || row.fx_rate || 1);

          if (row.source_flex_id) {
            totals.source_flex_id.set(
              row.source_flex_id,
              addMoneyAmounts(totals.source_flex_id.get(row.source_flex_id) || 0, amount)
            );
          }

          if (row.source_goal_id) {
            totals.source_goal_id.set(
              row.source_goal_id,
              addMoneyAmounts(totals.source_goal_id.get(row.source_goal_id) || 0, amount)
            );
          }
        }
      } finally {
        ledgerDb.close();
      }
    }

    return totals;
  }

  function confirmedFundingTotalsFromRows(rows, ledgerCurrency) {
    const totals = {
      source_flex_id: new Map(),
      source_goal_id: new Map()
    };

    for (const row of rows || []) {
      if (String(row?.ledger_currency || "PLN") !== ledgerCurrency) continue;
      if (row?.type === "income") continue;
      if (!row?.source_flex_id && !row?.source_goal_id) continue;

      const amount = storedOrComputedConfirmedLedgerAmount(row);

      if (row.source_flex_id) {
        totals.source_flex_id.set(
          row.source_flex_id,
          addMoneyAmounts(totals.source_flex_id.get(row.source_flex_id) || 0, amount)
        );
      }

      if (row.source_goal_id) {
        totals.source_goal_id.set(
          row.source_goal_id,
          addMoneyAmounts(totals.source_goal_id.get(row.source_goal_id) || 0, amount)
        );
      }
    }

    return totals;
  }

  async function confirmedFundingTotalsAsync(userId, targetCurrency = "PLN", settings = null) {
    const ledgerCurrency = settings?.ledger_currency || (await currentLedgerSettingsAsync(userId)).ledgerCurrency;
    return confirmedFundingTotalsFromRows(await loadAllConfirmedTransactionsAsync(userId), ledgerCurrency);
  }

  function sumPendingFunding(userId, sourceColumn, sourceId, targetCurrency = "PLN", settings = null) {
    const safeSourceColumn = requireFundingSourceColumn(sourceColumn);
    const db = openPlanningDb(userId);
    let totalLedger = 0;
    const ledgerCurrency = settings?.ledger_currency || currentLedgerSettings(userId).ledgerCurrency;

    try {
      const rows = db.prepare(`
        SELECT amount, funded_amount, fx_rate, buffered_fx_rate, ledger_amount
        FROM pending_transactions
        WHERE ${safeSourceColumn} = ?
          AND type != 'income'
          AND COALESCE(ledger_currency, 'PLN') = ?
      `).all(sourceId, ledgerCurrency);

      for (const row of rows) {
        if (row.ledger_amount !== null && row.ledger_amount !== undefined) {
          totalLedger = addMoneyAmounts(totalLedger, row.ledger_amount);
        } else {
          const amount = Number(row.funded_amount ?? row.amount ?? 0);
          totalLedger = addMoneyAmounts(totalLedger, multiplyMoney(amount, row.buffered_fx_rate || row.fx_rate || 1));
        }
      }

      return roundMoneyAmount(totalLedger);
    } finally {
      db.close();
    }
  }

  function sumPendingFundingFromRows(rows, sourceColumn, sourceId, ledgerCurrency) {
    const safeSourceColumn = requireFundingSourceColumn(sourceColumn);
    let totalLedger = 0;
    for (const row of rows || []) {
      if (row?.[safeSourceColumn] !== sourceId) continue;
      if (row?.type === "income") continue;
      if (String(row?.ledger_currency || "PLN") !== ledgerCurrency) continue;
      if (row.ledger_amount !== null && row.ledger_amount !== undefined) {
        totalLedger = addMoneyAmounts(totalLedger, row.ledger_amount);
      } else {
        const amount = Number(row.funded_amount ?? row.amount ?? 0);
        totalLedger = addMoneyAmounts(totalLedger, multiplyMoney(amount, row.buffered_fx_rate || row.fx_rate || 1));
      }
    }
    return roundMoneyAmount(totalLedger);
  }

  async function sumPendingFundingAsync(userId, sourceColumn, sourceId, targetCurrency = "PLN", settings = null) {
    if (!budgetStore || typeof budgetStore.listPlanningRows !== "function") {
      return sumPendingFunding(userId, sourceColumn, sourceId, targetCurrency, settings);
    }

    const ledgerCurrency = settings?.ledger_currency || (await currentLedgerSettingsAsync(userId)).ledgerCurrency;
    const rows = await budgetStore.listPlanningRows(userId, "pending_transactions");
    return sumPendingFundingFromRows(rows, sourceColumn, sourceId, ledgerCurrency);
  }

  function hasAnyConfirmedTransactions(userId) {
    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        const row = ledgerDb.prepare(`
          SELECT 1 AS exists_flag
          FROM confirmed_transactions
          LIMIT 1
        `).get();

        if (row) return true;
      } finally {
        ledgerDb.close();
      }
    }

    return false;
  }

  async function hasAnyConfirmedTransactionsAsync(userId) {
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return hasAnyConfirmedTransactions(userId);
    }

    if (typeof budgetStore.listLedgerYears === "function") {
      for (const year of await budgetStore.listLedgerYears(userId)) {
        const rows = await budgetStore.listConfirmedTransactions(userId, { ledgerYear: Number(year) });
        if (rows.length) return true;
      }
      return false;
    }

    return (await budgetStore.listConfirmedTransactions(userId)).length > 0;
  }

  function newestConfirmedTransactionDate(userId) {
    let newest = null;

    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);

      try {
        const row = ledgerDb.prepare(`
          SELECT MAX(date) AS newest
          FROM confirmed_transactions
        `).get();

        if (row?.newest && (!newest || row.newest > newest)) {
          newest = row.newest;
        }
      } finally {
        ledgerDb.close();
      }
    }

    return newest;
  }

  async function newestConfirmedTransactionDateAsync(userId) {
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return newestConfirmedTransactionDate(userId);
    }

    let newest = null;
    const rows = await loadAllConfirmedTransactionsAsync(userId);
    for (const row of rows) {
      if (row?.date && (!newest || row.date > newest)) {
        newest = row.date;
      }
    }
    return newest;
  }

  function recalculateLedgerRunningBalance(userId, { db = null } = {}) {
    // Synchronous restore owns this connection through projection and commit.
    // Reading or writing through another handle would escape its snapshot.
    if (db) {
      const currency = db.prepare('SELECT ledger_currency FROM settings WHERE id = 1').get()?.ledger_currency || 'PLN';
      const rows = db.prepare('SELECT * FROM ledger_transactions WHERE ledger_currency = ?').all(currency);
      const openingBalance = sqliteLedgerOpeningBalance(db, userId, currency, { allowStandaloneOrigins });
      const update = db.prepare('UPDATE ledger_transactions SET running_balance_pln = ?, ledger_amount = ? WHERE id = ?');
      for (const row of confirmedRowsWithRunningBalances(rows, { openingBalance })) update.run(row.running_balance_pln, row.ledger_amount, row.id);
      return;
    }
    const { rows, openingBalance } = rowsForCurrentLedger(userId);

    const dbByYear = new Map();

    try {
      for (const row of confirmedRowsWithRunningBalances(rows, { openingBalance })) {
        if (!dbByYear.has(row.ledger_year)) {
          dbByYear.set(row.ledger_year, openLedgerDb(userId, row.ledger_year));
        }

        dbByYear.get(row.ledger_year).prepare(`
          UPDATE confirmed_transactions
          SET running_balance_pln = ?, ledger_amount = ?
          WHERE id = ?
        `).run(row.running_balance_pln, row.ledger_amount, row.id);
      }
    } finally {
      for (const db of dbByYear.values()) {
        db.close();
      }
    }
  }

  async function recalculateLedgerRunningBalanceAsync(userId, options = {}) {
    if (!budgetStore || typeof budgetStore.updateConfirmedLedgerBalances !== "function") {
      recalculateLedgerRunningBalance(userId);
      return { ok: true, updated: null, fallback: "sqlite" };
    }

    // Composing hosts may pass their owning writer. Never reopen the root pool
    // while a confirmation/currency/import transaction is still uncommitted.
    const store = options.store || budgetStore;
    const ledgerCurrency = options.ledgerCurrency || options.settings?.ledger_currency
      || (await store.listPlanningRows(userId, "settings"))?.[0]?.ledger_currency || "PLN";
    const plan = await createLedgerRunningBalancePlan({
      budgetId: userId, budgetStore: store, ledgerCurrency,
      openingBalance: await budgetLedgerOpeningBalance(store, userId, ledgerCurrency)
    });

    return await applyLedgerRunningBalancePlan({
      budgetStore: store,
      plan
    });
  }

  function wouldLedgerGoNegativeAfterInsert(userId, candidate) {
    const { rows, openingBalance, ledgerCurrency } = rowsForCurrentLedger(userId);

    rows.push({
      id: candidate.id,
      amount: candidate.amount,
      type: candidate.type,
      date: candidate.date,
      created_at: candidate.created_at,
      fx_rate: candidate.fx_rate,
      buffered_fx_rate: candidate.buffered_fx_rate,
      ledger_currency: candidate.ledger_currency || ledgerCurrency
    });

    return wouldConfirmedRowsGoNegative(rows, { openingBalance });
  }

  // Locked confirmation checks must observe their writer's uncommitted ledger,
  // not acquire another pool connection or validate an earlier snapshot.
  async function wouldLedgerGoNegativeAfterInsertAsync(userId, candidate, options = {}, store = budgetStore) {
    if (!store || typeof store.listConfirmedTransactions !== "function") {
      return wouldLedgerGoNegativeAfterInsert(userId, candidate);
    }

    const ledgerCurrency = options.ledgerCurrency
      || options.settings?.ledger_currency
      || (await store.listPlanningRows(userId, "settings"))?.[0]?.ledger_currency || "PLN";
    const rows = (await store.listConfirmedTransactions(userId))
      .filter(row => String(row.ledger_currency || "PLN") === ledgerCurrency);
    rows.push({
      id: candidate.id,
      amount: candidate.amount,
      type: candidate.type,
      date: candidate.date,
      created_at: candidate.created_at,
      fx_rate: candidate.fx_rate,
      buffered_fx_rate: candidate.buffered_fx_rate,
      ledger_currency: candidate.ledger_currency || ledgerCurrency
    });

    return wouldConfirmedRowsGoNegative(rows, { openingBalance: await budgetLedgerOpeningBalance(store, userId, ledgerCurrency) });
  }

  function latestConfirmedBalance(userId) {
    const { rows, openingBalance } = rowsForCurrentLedger(userId);
    return latestBalanceFromConfirmedRows(rows, { openingBalance });
  }

  async function latestConfirmedBalanceAsync(userId, options = {}) {
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return latestConfirmedBalance(userId);
    }

    const ledgerCurrency = options.ledgerCurrency
      || options.settings?.ledger_currency
      || (await currentLedgerSettingsAsync(userId)).ledgerCurrency;
    const rows = (await loadAllConfirmedTransactionsAsync(userId))
      .filter(row => String(row.ledger_currency || "PLN") === ledgerCurrency);
    return latestBalanceFromConfirmedRows(rows, { openingBalance: await budgetLedgerOpeningBalance(budgetStore, userId, ledgerCurrency) });
  }
  return {
    hasAnyConfirmedTransactions,
    hasAnyConfirmedTransactionsAsync,
    compactHistoricalLedger,
    compactHistoricalLedgerAsync,
    historicalLedgerCompactionPlan,
    historicalLedgerCompactionPlanAsync,
    latestConfirmedBalance,
    latestConfirmedBalanceAsync,
    listConfirmedTransactionsPage,
    listConfirmedTransactionsPageAsync,
    loadAllConfirmedTransactions,
    loadAllConfirmedTransactionsAsync,
    newestConfirmedTransactionDate,
    newestConfirmedTransactionDateAsync,
    recalculateLedgerRunningBalance,
    recalculateLedgerRunningBalanceAsync,
    confirmedFundingTotals,
    confirmedFundingTotalsAsync,
    sumConfirmedFunding,
    sumConfirmedFundingAsync,
    sumPendingFunding,
    sumPendingFundingAsync,
    wouldLedgerGoNegativeAfterInsert,
    wouldLedgerGoNegativeAfterInsertAsync
  };
}

