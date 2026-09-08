import { addMoneyAmounts, multiplyMoney, roundMoneyAmount, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import { badRequest } from "./cashflow-user-utils.js";

export function createCashflowLedgerService({
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

    return rows.sort((a, b) => {
      const dateCompare = String(a.date).localeCompare(String(b.date));
      if (dateCompare !== 0) return dateCompare;

      const createdCompare = String(a.created_at).localeCompare(String(b.created_at));
      if (createdCompare !== 0) return createdCompare;

      return String(a.id).localeCompare(String(b.id));
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

    rows.sort((a, b) => {
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
      total: rows.length,
      rows: rows.slice(filters.offset, filters.offset + filters.limit)
    };
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

  function recalculateLedgerRunningBalance(userId) {
    const { rows, openingBalance } = rowsForCurrentLedger(userId);
    let balance = openingBalance;

    const dbByYear = new Map();

    try {
      for (const row of rows) {
        const effectiveRate = Number(row.buffered_fx_rate || row.fx_rate || 1);
        const ledgerAmount = multiplyMoney(row.amount, effectiveRate);

        if (row.type === "income") {
          balance = addMoneyAmounts(balance, ledgerAmount);
        } else {
          balance = subtractMoneyAmounts(balance, ledgerAmount);
        }

        if (!dbByYear.has(row.ledger_year)) {
          dbByYear.set(row.ledger_year, openLedgerDb(userId, row.ledger_year));
        }

        dbByYear.get(row.ledger_year).prepare(`
          UPDATE confirmed_transactions
          SET running_balance_pln = ?, ledger_amount = ?
          WHERE id = ?
        `).run(roundMoneyAmount(balance), ledgerAmount, row.id);
      }
    } finally {
      for (const db of dbByYear.values()) {
        db.close();
      }
    }
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

    rows.sort((a, b) => {
      const dateCompare = String(a.date).localeCompare(String(b.date));
      if (dateCompare !== 0) return dateCompare;

      const createdCompare = String(a.created_at).localeCompare(String(b.created_at));
      if (createdCompare !== 0) return createdCompare;

      return String(a.id).localeCompare(String(b.id));
    });

    let balance = openingBalance;

    for (const row of rows) {
      const effectiveRate = Number(row.buffered_fx_rate || row.fx_rate || 1);
      const ledgerAmount = multiplyMoney(row.amount, effectiveRate);

      if (row.type === "income") {
        balance = addMoneyAmounts(balance, ledgerAmount);
      } else {
        balance = subtractMoneyAmounts(balance, ledgerAmount);
      }

      if (balance < -0.005) return true;
    }

    return false;
  }

  function latestConfirmedBalance(userId) {
    const { rows, openingBalance } = rowsForCurrentLedger(userId);

    if (!rows.length) return openingBalance;

    const last = rows[rows.length - 1];

    if (last.running_balance_pln !== null && last.running_balance_pln !== undefined) {
      return roundMoneyAmount(last.running_balance_pln);
    }

    let balance = openingBalance;

    for (const row of rows) {
      const effectiveRate = Number(row.buffered_fx_rate || row.fx_rate || 1);
      const ledgerAmount = multiplyMoney(row.amount, effectiveRate);

      if (row.type === "income") {
        balance = addMoneyAmounts(balance, ledgerAmount);
      } else {
        balance = subtractMoneyAmounts(balance, ledgerAmount);
      }
    }

    return roundMoneyAmount(balance);
  }
  return {
    hasAnyConfirmedTransactions,
    latestConfirmedBalance,
    listConfirmedTransactionsPage,
    loadAllConfirmedTransactions,
    newestConfirmedTransactionDate,
    recalculateLedgerRunningBalance,
    confirmedFundingTotals,
    sumConfirmedFunding,
    sumPendingFunding,
    wouldLedgerGoNegativeAfterInsert
  };
}

