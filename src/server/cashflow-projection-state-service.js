import { occurrenceKeyFromRow } from "./cashflow-occurrence-utils.js";

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
    const repeatEveryMonths = Math.max(1, Math.min(12, Number(input.repeat_every_months) || 1));

    if (repeatEveryMonths > 1 && !input.start_month_year) {
      throw new Error("start_month_year is required when repeat_every_months is greater than 1");
    }

    return repeatEveryMonths;
  }

  function normalizeRecurringInput(existing, input) {
    const merged = {
      ...existing,
      ...input
    };

    merged.repeat_every_months = Math.max(1, Math.min(12, Number(merged.repeat_every_months) || 1));

    if (merged.repeat_every_months > 1 && !merged.start_month_year) {
      throw new Error("start_month_year is required when repeat_every_months is greater than 1");
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

  function confirmedOneOffSourceIds(userId) {
    return new Set(
      loadAllConfirmedTransactions(userId)
        .map(row => row.source_one_off_id)
        .filter(Boolean)
    );
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

    const previousLedgerAmount = Number(pending.ledger_amount || 0);
    const nextLedgerAmount = Number(converted.ledgerAmount || 0);

    db.prepare(`
      UPDATE pending_transactions
      SET
        name = ?,
        currency = ?,
        amount = ?,
        type = ?,
        date = ?,
        source_recurring_expense_id = ?,
        source_recurring_income_id = ?,
        source_one_off_id = ?,
        source_flex_id = ?,
        source_goal_id = ?,
        fx_rate = ?,
        buffered_fx_rate = ?,
        status = ?,
        funded_amount = ?,
        requested_amount = ?,
        ledger_amount = ?,
        note = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      tx.name,
      tx.currency,
      tx.fundedAmount,
      tx.type,
      tx.date,
      tx.sourceRecurringExpenseId || null,
      tx.sourceRecurringIncomeId || null,
      tx.sourceOneOffId || null,
      tx.sourceFlexId || null,
      tx.sourceGoalId || null,
      converted.fx,
      converted.buffered,
      normalizePendingStatus(tx.status),
      tx.fundedAmount,
      tx.requestedAmount,
      converted.ledgerAmount,
      tx.note || null,
      pending.id
    );

    return {
      ...pending,
      ledger_amount: nextLedgerAmount,
      ledger_amount_delta: nextLedgerAmount - previousLedgerAmount
    };
  }

  function recalculatePlanningRunningBalances(db, userId = null) {
    const rows = [
      ...db.prepare(`
        SELECT id, type, ledger_amount, date, created_at, 'pending' AS bucket
        FROM pending_transactions
      `).all(),
      ...db.prepare(`
        SELECT id, type, ledger_amount, date, created_at, 'future' AS bucket
        FROM future_transactions
      `).all()
    ].sort((a, b) => {
      const dateCompare = String(a.date).localeCompare(String(b.date));
      if (dateCompare !== 0) return dateCompare;

      const bucketOrder = a.bucket === b.bucket ? 0 : a.bucket === "pending" ? -1 : 1;
      if (bucketOrder !== 0) return bucketOrder;

      const createdCompare = String(a.created_at).localeCompare(String(b.created_at));
      if (createdCompare !== 0) return createdCompare;

      return String(a.id).localeCompare(String(b.id));
    });

    let balance = userId ? latestConfirmedBalance(userId) : 0;

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

    for (const row of rows) {
      const ledgerAmount = Number(row.ledger_amount || 0);

      if (row.type === "income") {
        balance += ledgerAmount;
      } else {
        balance -= ledgerAmount;
      }

      if (row.bucket === "pending") {
        updatePending.run(balance, row.id);
      } else {
        updateFuture.run(balance, row.id);
      }
    }
  }

  function pendingNetBalance(db) {
    return db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN type = 'income' THEN COALESCE(ledger_amount, 0)
          ELSE -COALESCE(ledger_amount, 0)
        END
      ), 0) AS value
      FROM pending_transactions
    `).get().value;
  }

  function planningOpeningBalance(db, userId) {
    return latestConfirmedBalance(userId) + Number(pendingNetBalance(db) || 0);
  }

  return {
    confirmedOccurrenceKeys,
    confirmedOneOffSourceIds,
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
