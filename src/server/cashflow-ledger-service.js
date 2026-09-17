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

export function createCashflowLedgerService({
  budgetStore = null,
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

      return {
        ledgerCurrency: settings.ledger_currency || "PLN"
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
    const { ledgerCurrency } = currentLedgerSettings(userId);
    const rows = loadAllConfirmedTransactions(userId)
      .filter(row => String(row.ledger_currency || "PLN") === ledgerCurrency);

    return {
      ledgerCurrency,
      openingBalance: 0,
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

  function isLedgerHistoryCompactionRow(row) {
    return String(row.occurrence_key || "").startsWith("ledger_history_compaction:");
  }

  function historicalLedgerCompactionPlanFromRows(settings = {}, rows = [], options = {}) {
    const hasMonthsOverride = options.months !== undefined && options.months !== null && options.months !== "";
    const months = hasMonthsOverride
      ? Number(options.months)
      : Number(settings.ledger_history_compaction_months || 0);

    if (!Number.isInteger(months) || months < 0 || months > 600) {
      throw badRequest("ledger_history_compaction_months must be an integer between 0 and 600", [{
        field: "ledger_history_compaction_months",
        reason: "invalid_compaction_age"
      }]);
    }

    if (months === 0) {
      return {
        ok: true,
        enabled: false,
        months,
        cutoffDate: null,
        eligibleRows: 0,
        ledgerCurrencies: []
      };
    }

    const today = options.today || todayInTimezone(settings.timezone);
    const cutoffDate = addMonths(today, -months);
    const eligibleRows = rows
      .filter(row => dateKey(row.confirmed_date || row.date) < cutoffDate);
    const detailRows = eligibleRows.filter(row => !isLedgerHistoryCompactionRow(row));
    const ledgerCurrencies = [...new Set(eligibleRows.map(row => String(row.ledger_currency || "PLN").toUpperCase()))].sort();

    return {
      ok: true,
      enabled: true,
      months,
      today,
      cutoffDate,
      eligibleRows: eligibleRows.length,
      eligibleDetailRows: detailRows.length,
      needsCompaction: detailRows.length > 0,
      ledgerCurrencies
    };
  }

  function historicalLedgerCompactionPlan(userId, options = {}) {
    const db = openPlanningDb(userId);
    let settings = {};

    try {
      settings = db.prepare(`
        SELECT timezone, ledger_history_compaction_months
        FROM settings
        WHERE id = 1
      `).get() || {};
    } finally {
      db.close();
    }

    return historicalLedgerCompactionPlanFromRows(
      settings,
      loadAllConfirmedTransactions(userId),
      options
    );
  }

  async function historicalLedgerCompactionPlanAsync(userId, options = {}) {
    if (!budgetStore || typeof budgetStore.listPlanningRows !== "function") {
      return historicalLedgerCompactionPlan(userId, options);
    }

    const settings = (await budgetStore.listPlanningRows(userId, "settings"))?.[0] || {};
    return historicalLedgerCompactionPlanFromRows(
      settings,
      await loadAllConfirmedTransactionsAsync(userId),
      options
    );
  }

  function compactHistoricalLedger(userId, options = {}) {
    const plan = options.plan || historicalLedgerCompactionPlan(userId, options);
    if (!plan.enabled || !plan.cutoffDate || !plan.eligibleRows || !plan.needsCompaction) {
      return {
        ...plan,
        compactedRows: 0,
        createdRows: 0
      };
    }

    const cutoffDate = plan.cutoffDate;
    const rows = loadAllConfirmedTransactions(userId)
      .filter(row => dateKey(row.confirmed_date || row.date) < cutoffDate);
    if (!rows.length || rows.every(isLedgerHistoryCompactionRow)) {
      return {
        ...plan,
        eligibleRows: 0,
        eligibleDetailRows: 0,
        needsCompaction: false,
        ledgerCurrencies: [],
        compactedRows: 0,
        createdRows: 0
      };
    }

    const totalsByLedgerCurrency = new Map();
    for (const row of rows) {
      const ledgerCurrency = String(row.ledger_currency || "PLN").toUpperCase();
      const amount = storedOrComputedConfirmedLedgerAmount(row);
      const current = totalsByLedgerCurrency.get(ledgerCurrency) || 0;
      totalsByLedgerCurrency.set(
        ledgerCurrency,
        row.type === "income"
          ? addMoneyAmounts(current, amount)
          : subtractMoneyAmounts(current, amount)
      );
    }

    const yearsToDelete = [...new Set(rows.map(row => String(row.ledger_year)))];
    for (const year of yearsToDelete) {
      const ledgerDb = openLedgerDb(userId, year);
      try {
        ledgerDb.transaction(() => {
          ledgerDb.prepare(`
            DELETE FROM confirmed_transactions
            WHERE confirmed_date < ?
          `).run(cutoffDate);
        })();
      } finally {
        ledgerDb.close();
      }
    }

    const now = options.now || new Date().toISOString();
    const targetYear = cutoffDate.slice(0, 4);
    const targetDb = openLedgerDb(userId, targetYear);
    let createdRows = 0;

    try {
      targetDb.transaction(() => {
        for (const [ledgerCurrency, netAmount] of [...totalsByLedgerCurrency.entries()].sort()) {
          const amount = roundMoneyAmount(Math.abs(netAmount));
          targetDb.prepare(`
            INSERT INTO confirmed_transactions (
              id, name, currency, amount, type, date, confirmed_date,
              fx_rate, buffered_fx_rate, ledger_currency, running_balance_pln,
              ledger_amount, occurrence_key, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 0, ?, ?, ?, ?)
          `).run(
            generateId("ledger-compact"),
            `Historical ledger balance before ${cutoffDate} (${ledgerCurrency})`,
            ledgerCurrency,
            amount,
            netAmount >= 0 ? "income" : "expense",
            cutoffDate,
            cutoffDate,
            ledgerCurrency,
            amount,
            `ledger_history_compaction:${ledgerCurrency}:${cutoffDate}`,
            now,
            now
          );
          createdRows += 1;
        }
      })();
    } finally {
      targetDb.close();
    }

    recalculateLedgerRunningBalance(userId);

    return {
      ...plan,
      eligibleRows: rows.length,
      ledgerCurrencies: [...totalsByLedgerCurrency.keys()].sort(),
      compactedRows: rows.length,
      createdRows
    };
  }

  async function compactHistoricalLedgerAsync(userId, options = {}) {
    if (
      !budgetStore
      || typeof budgetStore.transaction !== "function"
      || typeof budgetStore.listPlanningRows !== "function"
    ) {
      return compactHistoricalLedger(userId, options);
    }

    const plan = options.plan || await historicalLedgerCompactionPlanAsync(userId, options);
    if (!plan.enabled || !plan.cutoffDate || !plan.eligibleRows || !plan.needsCompaction) {
      return {
        ...plan,
        compactedRows: 0,
        createdRows: 0
      };
    }

    return await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }

      const cutoffDate = plan.cutoffDate;
      const rows = (await writer.listConfirmedTransactions(userId))
        .filter(row => dateKey(row.confirmed_date || row.date) < cutoffDate);
      if (!rows.length || rows.every(isLedgerHistoryCompactionRow)) {
        return {
          ...plan,
          eligibleRows: 0,
          eligibleDetailRows: 0,
          needsCompaction: false,
          ledgerCurrencies: [],
          compactedRows: 0,
          createdRows: 0
        };
      }

      const totalsByLedgerCurrency = new Map();
      for (const row of rows) {
        const ledgerCurrency = String(row.ledger_currency || "PLN").toUpperCase();
        const amount = storedOrComputedConfirmedLedgerAmount(row);
        const current = totalsByLedgerCurrency.get(ledgerCurrency) || 0;
        totalsByLedgerCurrency.set(
          ledgerCurrency,
          row.type === "income"
            ? addMoneyAmounts(current, amount)
            : subtractMoneyAmounts(current, amount)
        );
      }

      const rowsByYear = new Map();
      for (const row of rows) {
        const ledgerYear = Number(row.ledger_year);
        const ids = rowsByYear.get(ledgerYear) || [];
        ids.push(row.id);
        rowsByYear.set(ledgerYear, ids);
      }

      for (const [ledgerYear, ids] of rowsByYear.entries()) {
        await writer.deleteConfirmedTransactionsById(userId, ledgerYear, ids);
      }

      const now = options.now || new Date().toISOString();
      const targetYear = Number(cutoffDate.slice(0, 4));
      const compactRows = [...totalsByLedgerCurrency.entries()].sort()
        .map(([ledgerCurrency, netAmount]) => {
          const amount = roundMoneyAmount(Math.abs(netAmount));
          return {
            amount,
            buffered_fx_rate: 1,
            confirmed_date: cutoffDate,
            created_at: now,
            currency: ledgerCurrency,
            date: cutoffDate,
            fx_rate: 1,
            id: generateId("ledger-compact"),
            ledger_amount: amount,
            ledger_currency: ledgerCurrency,
            ledger_year: targetYear,
            name: `Historical ledger balance before ${cutoffDate} (${ledgerCurrency})`,
            occurrence_key: `ledger_history_compaction:${ledgerCurrency}:${cutoffDate}`,
            running_balance_pln: 0,
            type: netAmount >= 0 ? "income" : "expense",
            updated_at: now
          };
        });

      if (compactRows.length) {
        await writer.insertConfirmedTransactions(userId, compactRows);
      }

      const balancePlan = await createLedgerRunningBalancePlan({
        budgetId: userId,
        budgetStore: writer,
        openingBalance: 0
      });
      await applyLedgerRunningBalancePlan({
        budgetStore: writer,
        plan: balancePlan
      });

      return {
        ...plan,
        eligibleRows: rows.length,
        ledgerCurrencies: [...totalsByLedgerCurrency.keys()].sort(),
        compactedRows: rows.length,
        createdRows: compactRows.length
      };
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
              addMoneyAmounts(totals.source_flex_id.get(row.source_flex_id), amount)
            );
          }

          if (row.source_goal_id) {
            totals.source_goal_id.set(
              row.source_goal_id,
              addMoneyAmounts(totals.source_goal_id.get(row.source_goal_id), amount)
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
          addMoneyAmounts(totals.source_flex_id.get(row.source_flex_id), amount)
        );
      }

      if (row.source_goal_id) {
        totals.source_goal_id.set(
          row.source_goal_id,
          addMoneyAmounts(totals.source_goal_id.get(row.source_goal_id), amount)
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

  function recalculateLedgerRunningBalance(userId) {
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

    const plan = await createLedgerRunningBalancePlan({
      budgetId: userId,
      budgetStore,
      ledgerCurrency: options.ledgerCurrency || options.settings?.ledger_currency || null,
      openingBalance: 0
    });

    return await applyLedgerRunningBalancePlan({
      budgetStore,
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

  async function wouldLedgerGoNegativeAfterInsertAsync(userId, candidate, options = {}) {
    if (!budgetStore || typeof budgetStore.listConfirmedTransactions !== "function") {
      return wouldLedgerGoNegativeAfterInsert(userId, candidate);
    }

    const ledgerCurrency = options.ledgerCurrency
      || options.settings?.ledger_currency
      || (await currentLedgerSettingsAsync(userId)).ledgerCurrency;
    const rows = (await loadAllConfirmedTransactionsAsync(userId))
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

    return wouldConfirmedRowsGoNegative(rows, { openingBalance: 0 });
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
    return latestBalanceFromConfirmedRows(rows, { openingBalance: 0 });
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

