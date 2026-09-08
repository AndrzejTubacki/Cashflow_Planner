import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";
import { requireIsoMonth, todayInTimezone } from "./cashflow-date-utils.js";
import { DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { requireNumber } from "./cashflow-input-validation.js";
import { addMoneyAmounts, multiplyMoney, roundMoneyAmount, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import { badRequest } from "./cashflow-user-utils.js";

export function createCashflowProjectionStateService({
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

  function confirmedOneOffProgress(userId) {
    // Track installments in original transaction units so projection can generate only the unconfirmed remainder.
    const progress = new Map();

    for (const row of loadAllConfirmedTransactions(userId)) {
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

  function confirmedRowsForCurrentLedger(db, userId) {
    if (!userId) return [];

    const ledgerCurrency = currentLedgerCurrency(db);
    return loadAllConfirmedTransactions(userId)
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

  function recalculatePlanningRunningBalances(db, userId = null) {
    const settings = db.prepare("SELECT ledger_currency, timezone FROM settings WHERE id = 1").get() || {};
    const ledgerCurrency = settings.ledger_currency || "PLN";
    const today = todayInTimezone(settings.timezone || DEFAULT_TIMEZONE);
    const rows = [
      ...confirmedRowsAfterDate(db, userId, today).map(row => ({
        id: row.id,
        type: row.type,
        ledger_amount: row.ledger_amount,
        date: row.date,
        created_at: row.created_at,
        bucket: "confirmed"
      })),
      ...db.prepare(`
        SELECT id, type, ledger_amount, date, created_at, 'pending' AS bucket
        FROM pending_transactions
        WHERE COALESCE(ledger_currency, 'PLN') = ?
      `).all(ledgerCurrency),
      ...db.prepare(`
        SELECT id, type, ledger_amount, date, created_at, 'future' AS bucket
        FROM future_transactions
        WHERE COALESCE(ledger_currency, 'PLN') = ?
      `).all(ledgerCurrency)
    ].sort((a, b) => {
      const dateCompare = String(a.date).localeCompare(String(b.date));
      if (dateCompare !== 0) return dateCompare;

      const bucketRanks = {
        confirmed: 0,
        pending: 1,
        future: 2
      };
      const bucketOrder = (bucketRanks[a.bucket] ?? 99) - (bucketRanks[b.bucket] ?? 99);
      if (bucketOrder !== 0) return bucketOrder;

      const createdCompare = String(a.created_at).localeCompare(String(b.created_at));
      if (createdCompare !== 0) return createdCompare;

      return String(a.id).localeCompare(String(b.id));
    });

    const staleRows = [
      ...db.prepare(`
        SELECT id, 'pending' AS bucket
        FROM pending_transactions
        WHERE COALESCE(ledger_currency, 'PLN') != ?
      `).all(ledgerCurrency),
      ...db.prepare(`
        SELECT id, 'future' AS bucket
        FROM future_transactions
        WHERE COALESCE(ledger_currency, 'PLN') != ?
      `).all(ledgerCurrency)
    ];

    let balance = userId ? confirmedBalanceAsOf(db, userId, today) : 0;

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

    for (const row of staleRows) {
      if (row.bucket === "pending") {
        updatePending.run(null, row.id);
      } else {
        updateFuture.run(null, row.id);
      }
    }

    for (const row of rows) {
      const ledgerAmount = roundMoneyAmount(row.ledger_amount);

      if (row.type === "income") {
        balance = addMoneyAmounts(balance, ledgerAmount);
      } else {
        balance = subtractMoneyAmounts(balance, ledgerAmount);
      }

      if (row.bucket === "confirmed") {
        continue;
      }

      if (row.bucket === "pending") {
        updatePending.run(roundMoneyAmount(balance), row.id);
      } else {
        updateFuture.run(roundMoneyAmount(balance), row.id);
      }
    }
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

  function planningOpeningBalance(db, userId, { includePending = true } = {}) {
    return addMoneyAmounts(latestConfirmedBalance(userId), includePending ? pendingNetBalance(db) : 0);
  }

  return {
    confirmedBalanceAsOf,
    confirmedOccurrenceKeys,
    confirmedRowsAfterDate,
    confirmedOneOffProgress,
    deletePendingOccurrence,
    findConfirmedOccurrence,
    normalizePendingStatus,
    normalizeRecurringInput,
    pendingOccurrenceExists,
    pendingOccurrenceRow,
    pendingNetBalance,
    planningOpeningBalance,
    recalculatePlanningRunningBalances,
    refreshPendingOccurrence,
    requireStartMonthYearIfNeeded
  };
}
