import { generateId } from "./cashflow-id-utils.js";
import { makeOccurrenceKey } from "./cashflow-occurrence-utils.js";
import {
  applyPlanningRunningBalancePlan,
  createPlanningRunningBalancePlan
} from "./cashflow-planning-balance-plan.js";
import { notFound } from "./cashflow-user-utils.js";

export function createCashflowPendingTransitionService({
  budgetStore = null,
  normalizePendingStatus,
  openPlanningDb,
  recalculatePlanningRunningBalances,
  withProjectionStatus
}) {
  async function recalculatePlanningRunningBalancesWithBudgetStore(writer, userId) {
    const settingsRows = await writer.listPlanningRows(userId, "settings");
    const pendingRows = await writer.listPlanningRows(userId, "pending_transactions");
    const futureRows = await writer.listPlanningRows(userId, "future_transactions");
    const confirmedRows = await writer.listConfirmedTransactions(userId);
    const plan = createPlanningRunningBalancePlan({
      confirmedRows,
      futureRows,
      pendingRows,
      settings: settingsRows?.[0] || {}
    });
    await applyPlanningRunningBalancePlan({
      budgetId: userId,
      budgetStore: writer,
      plan
    });
    return plan;
  }

  function occurrenceKeyForFutureRow(tx) {
    return tx.occurrence_key || makeOccurrenceKey({
      type: tx.type,
      date: tx.date,
      sourceRecurringExpenseId: tx.source_recurring_expense_id || null,
      sourceRecurringIncomeId: tx.source_recurring_income_id || null,
      sourceOneOffId: tx.source_one_off_id || null,
      sourceFlexId: tx.source_flex_id || null,
      sourceGoalId: tx.source_goal_id || null,
      rowId: tx.id
    });
  }

  function pendingRowFromFuture(tx, occurrenceKey, pendingOrigin) {
    const timestamp = new Date().toISOString();
    return {
      amount: tx.amount,
      buffered_fx_rate: tx.buffered_fx_rate ?? null,
      created_at: timestamp,
      currency: tx.currency,
      date: tx.date,
      funded_amount: tx.funded_amount ?? tx.amount,
      fx_rate: tx.fx_rate ?? null,
      id: generateId("pend"),
      ledger_amount: tx.ledger_amount ?? null,
      ledger_currency: tx.ledger_currency || "PLN",
      name: tx.name,
      note: tx.note || null,
      occurrence_key: occurrenceKey,
      pending_origin: pendingOrigin,
      requested_amount: tx.requested_amount ?? tx.amount,
      source_flex_id: tx.source_flex_id || null,
      source_goal_id: tx.source_goal_id || null,
      source_one_off_id: tx.source_one_off_id || null,
      source_recurring_expense_id: tx.source_recurring_expense_id || null,
      source_recurring_income_id: tx.source_recurring_income_id || null,
      status: normalizePendingStatus(tx.status),
      type: tx.type,
      updated_at: timestamp
    };
  }

  async function moveDueFutureTransactionsToPendingWithBudgetStore(userId, today) {
    return await budgetStore.transaction(async writer => {
      const futureTxns = (await writer.listPlanningRows(userId, "future_transactions"))
        .filter(row => String(row.date || "") <= today)
        .sort((a, b) => {
          const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
          if (dateCompare !== 0) return dateCompare;
          return String(a.id || "").localeCompare(String(b.id || ""));
        });
      if (!futureTxns.length) return 0;

      const existingPendingKeys = new Set(
        (await writer.listPlanningRows(userId, "pending_transactions"))
          .map(row => row.occurrence_key)
          .filter(Boolean)
      );
      const pendingRows = [];
      const futureIds = [];

      for (const tx of futureTxns) {
        const occurrenceKey = occurrenceKeyForFutureRow(tx);
        futureIds.push(tx.id);
        if (occurrenceKey && existingPendingKeys.has(occurrenceKey)) continue;
        if (occurrenceKey) existingPendingKeys.add(occurrenceKey);
        pendingRows.push(pendingRowFromFuture(tx, occurrenceKey, "scheduled"));
      }

      if (pendingRows.length) {
        await writer.insertPlanningRows(userId, "pending_transactions", pendingRows);
      }
      await writer.deletePlanningRowsById(userId, "future_transactions", futureIds);
      await recalculatePlanningRunningBalancesWithBudgetStore(writer, userId);

      return pendingRows.length;
    });
  }

  async function moveDueFutureTransactionsToPending(userId, today) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return await moveDueFutureTransactionsToPendingWithBudgetStore(userId, today);
    }

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
          fx_rate, buffered_fx_rate, ledger_currency,
          status, funded_amount, requested_amount, ledger_amount, pending_origin, note, occurrence_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);

      const deleteFuture = db.prepare("DELETE FROM future_transactions WHERE id = ?");

      let inserted = 0;

      db.transaction(() => {
        for (const tx of futureTxns) {
          const occurrenceKey = occurrenceKeyForFutureRow(tx);

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
            tx.ledger_currency || "PLN",
            normalizePendingStatus(tx.status),
            tx.funded_amount ?? tx.amount,
            tx.requested_amount ?? tx.amount,
            tx.ledger_amount || null,
            "scheduled",
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

  async function moveFutureTransactionToPendingWithBudgetStore(userId, futureTransactionId, options = {}) {
    const requestedOccurrenceKey = typeof options.occurrenceKey === "string"
      ? options.occurrenceKey.trim()
      : "";

    const result = await budgetStore.transaction(async writer => {
      const futureRows = await writer.listPlanningRows(userId, "future_transactions");
      let tx = futureRows.find(row => row.id === futureTransactionId) || null;

      if (!tx && requestedOccurrenceKey) {
        tx = futureRows
          .filter(row => row.occurrence_key === requestedOccurrenceKey)
          .sort((a, b) => {
            const dateCompare = String(a.date || "").localeCompare(String(b.date || ""));
            if (dateCompare !== 0) return dateCompare;
            const createdCompare = String(a.created_at || "").localeCompare(String(b.created_at || ""));
            if (createdCompare !== 0) return createdCompare;
            return String(a.id || "").localeCompare(String(b.id || ""));
          })[0] || null;
      }

      if (!tx) {
        if (requestedOccurrenceKey) {
          const pending = (await writer.listPlanningRows(userId, "pending_transactions"))
            .find(row => row.occurrence_key === requestedOccurrenceKey);

          if (pending) {
            return {
              ok: true,
              moved: false,
              alreadyPending: true,
              futureTransactionId,
              pendingTransactionId: pending.id,
              occurrenceKey: requestedOccurrenceKey
            };
          }
        }

        throw notFound("Future transaction not found");
      }

      const occurrenceKey = occurrenceKeyForFutureRow(tx);
      if (occurrenceKey) {
        const pending = (await writer.listPlanningRows(userId, "pending_transactions"))
          .find(row => row.occurrence_key === occurrenceKey);

        if (pending) {
          await writer.deletePlanningRowsById(userId, "future_transactions", [tx.id]);
          await recalculatePlanningRunningBalancesWithBudgetStore(writer, userId);

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

      const pending = pendingRowFromFuture(tx, occurrenceKey, "manual");
      const info = await writer.insertPlanningRows(userId, "pending_transactions", [pending]);
      await writer.deletePlanningRowsById(userId, "future_transactions", [tx.id]);
      await recalculatePlanningRunningBalancesWithBudgetStore(writer, userId);

      return {
        ok: true,
        moved: (info?.inserted || 0) > 0,
        futureTransactionId: tx.id,
        occurrenceKey
      };
    });

    return await withProjectionStatus(userId, result);
  }

  async function moveFutureTransactionToPending(userId, futureTransactionId, options = {}) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return await moveFutureTransactionToPendingWithBudgetStore(userId, futureTransactionId, options);
    }

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

        throw notFound("Future transaction not found");
      }

      const insertPending = db.prepare(`
        INSERT INTO pending_transactions (
          id, name, currency, amount, type, date,
          source_recurring_expense_id, source_recurring_income_id, source_one_off_id,
          source_flex_id, source_goal_id,
          fx_rate, buffered_fx_rate, ledger_currency,
          status, funded_amount, requested_amount, ledger_amount, pending_origin, note, occurrence_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);

      result = db.transaction(() => {
        const occurrenceKey = tx.occurrence_key || makeOccurrenceKey({
          type: tx.type,
          date: tx.date,
          sourceRecurringExpenseId: tx.source_recurring_expense_id || null,
          sourceRecurringIncomeId: tx.source_recurring_income_id || null,
          sourceOneOffId: tx.source_one_off_id || null,
          sourceFlexId: tx.source_flex_id || null,
          sourceGoalId: tx.source_goal_id || null,
          rowId: tx.id
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
          tx.ledger_currency || "PLN",
          normalizePendingStatus(tx.status),
          tx.funded_amount ?? tx.amount,
          tx.requested_amount ?? tx.amount,
          tx.ledger_amount ?? null,
          "manual",
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
