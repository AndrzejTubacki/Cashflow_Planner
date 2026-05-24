import { generateId } from "./cashflow-id-utils.js";
import { makeOccurrenceKey } from "./cashflow-occurrence-utils.js";

export function createCashflowPendingTransitionService({
  normalizePendingStatus,
  openPlanningDb,
  recalculatePlanningRunningBalances,
  withProjectionStatus
}) {
  function moveDueFutureTransactionsToPending(userId, today) {
    const db = openPlanningDb(userId);

    try {
      const futureTxns = db.prepare(`
        SELECT *
        FROM future_transactions
        WHERE date <= ?
        ORDER BY date ASC
      `).all(today);

      const insertPending = db.prepare(`
        INSERT OR IGNORE INTO pending_transactions (
          id, name, currency, amount, type, date,
          source_recurring_expense_id, source_recurring_income_id, source_one_off_id,
          source_flex_id, source_goal_id,
          fx_rate, buffered_fx_rate,
          status, funded_amount, requested_amount, ledger_amount, note, occurrence_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);

      const deleteFuture = db.prepare("DELETE FROM future_transactions WHERE id = ?");

      let inserted = 0;

      db.transaction(() => {
        for (const tx of futureTxns) {
          const occurrenceKey = tx.occurrence_key || makeOccurrenceKey({
            type: tx.type,
            date: tx.date,
            sourceRecurringExpenseId: tx.source_recurring_expense_id || null,
            sourceRecurringIncomeId: tx.source_recurring_income_id || null,
            sourceOneOffId: tx.source_one_off_id || null,
            sourceFlexId: tx.source_flex_id || null,
            sourceGoalId: tx.source_goal_id || null
          });

          const info = insertPending.run(
            generateId("pend"),
            tx.name,
            tx.currency,
            tx.amount,
            tx.type,
            tx.date,
            tx.source_recurring_expense_id || null,
            tx.source_recurring_income_id || null,
            tx.source_one_off_id || null,
            tx.source_flex_id || null,
            tx.source_goal_id || null,
            tx.fx_rate || null,
            tx.buffered_fx_rate || null,
            normalizePendingStatus(tx.status),
            tx.funded_amount ?? tx.amount,
            tx.requested_amount ?? tx.amount,
            tx.ledger_amount || null,
            tx.note || null,
            occurrenceKey
          );

          inserted += info.changes;
          deleteFuture.run(tx.id);
        }

        recalculatePlanningRunningBalances(db, userId);
      })();

      return inserted;
    } finally {
      db.close();
    }
  }

  function moveFutureTransactionToPending(userId, futureTransactionId, options = {}) {
    let result;
    const db = openPlanningDb(userId);
    const requestedOccurrenceKey = typeof options.occurrenceKey === "string"
      ? options.occurrenceKey.trim()
      : "";

    try {
      let tx = db.prepare(`
        SELECT *
        FROM future_transactions
        WHERE id = ?
      `).get(futureTransactionId);

      if (!tx && requestedOccurrenceKey) {
        tx = db.prepare(`
          SELECT *
          FROM future_transactions
          WHERE occurrence_key = ?
          ORDER BY date ASC, created_at ASC, id ASC
          LIMIT 1
        `).get(requestedOccurrenceKey);
      }

      if (!tx) {
        if (requestedOccurrenceKey) {
          const pending = db.prepare(`
            SELECT id
            FROM pending_transactions
            WHERE occurrence_key = ?
            LIMIT 1
          `).get(requestedOccurrenceKey);

          if (pending) {
            result = {
              ok: true,
              moved: false,
              alreadyPending: true,
              futureTransactionId,
              pendingTransactionId: pending.id,
              occurrenceKey: requestedOccurrenceKey
            };

            return withProjectionStatus(userId, result);
          }
        }

        throw new Error("Future transaction not found");
      }

      const insertPending = db.prepare(`
        INSERT INTO pending_transactions (
          id, name, currency, amount, type, date,
          source_recurring_expense_id, source_recurring_income_id, source_one_off_id,
          source_flex_id, source_goal_id,
          fx_rate, buffered_fx_rate,
          status, funded_amount, requested_amount, ledger_amount, note, occurrence_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);

      result = db.transaction(() => {
        const occurrenceKey = tx.occurrence_key || makeOccurrenceKey({
          type: tx.type,
          date: tx.date,
          sourceRecurringExpenseId: tx.source_recurring_expense_id || null,
          sourceRecurringIncomeId: tx.source_recurring_income_id || null,
          sourceOneOffId: tx.source_one_off_id || null,
          sourceFlexId: tx.source_flex_id || null,
          sourceGoalId: tx.source_goal_id || null
        });

        if (occurrenceKey) {
          const pending = db.prepare(`
            SELECT id
            FROM pending_transactions
            WHERE occurrence_key = ?
            LIMIT 1
          `).get(occurrenceKey);

          if (pending) {
            db.prepare("DELETE FROM future_transactions WHERE id = ?").run(tx.id);
            recalculatePlanningRunningBalances(db, userId);

            return {
              ok: true,
              moved: false,
              alreadyPending: true,
              futureTransactionId: tx.id,
              pendingTransactionId: pending.id,
              occurrenceKey
            };
          }
        }

        const info = insertPending.run(
          generateId("pend"),
          tx.name,
          tx.currency,
          tx.amount,
          tx.type,
          tx.date,
          tx.source_recurring_expense_id || null,
          tx.source_recurring_income_id || null,
          tx.source_one_off_id || null,
          tx.source_flex_id || null,
          tx.source_goal_id || null,
          tx.fx_rate ?? null,
          tx.buffered_fx_rate ?? null,
          normalizePendingStatus(tx.status),
          tx.funded_amount ?? tx.amount,
          tx.requested_amount ?? tx.amount,
          tx.ledger_amount ?? null,
          tx.note || null,
          occurrenceKey
        );

        db.prepare("DELETE FROM future_transactions WHERE id = ?").run(tx.id);
        recalculatePlanningRunningBalances(db, userId);

        return {
          ok: true,
          moved: info.changes > 0,
          futureTransactionId: tx.id,
          occurrenceKey
        };
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  return {
    moveDueFutureTransactionsToPending,
    moveFutureTransactionToPending
  };
}
