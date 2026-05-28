import { todayWarsaw } from "./cashflow-date-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { normalizeCurrency, nullablePositiveAmount } from "./cashflow-money-utils.js";
import { makeOccurrenceKey } from "./cashflow-occurrence-utils.js";
import { reorderPriorityDomain, updatePlannedPriority } from "./cashflow-priority-utils.js";

export function createCashflowPlanMutationService({
  loadAllConfirmedTransactions,
  newestConfirmedTransactionDate,
  normalizeRecurringInput,
  openPlanningDb,
  recalculatePlanningRunningBalances,
  requireStartMonthYearIfNeeded,
  withProjectionStatus
}) {
  function insertPlannedTransaction(db, type, requestedPriority = 1) {
    const plannedTxId = generateId("planned");
    const domain = type === "goal" ? "goal" : "operating";

    db.prepare(`
      INSERT INTO planned_transactions (
        id, type, operating_priority, goal_priority, created_at, updated_at
      ) VALUES (?, ?, NULL, NULL, datetime('now'), datetime('now'))
    `).run(plannedTxId, type);

    reorderPriorityDomain(db, domain, plannedTxId, requestedPriority);

    return plannedTxId;
  }

  function createRecurringExpense(userId, input) {
    let result;

    const db = openPlanningDb(userId);
    try {
      result = db.transaction(() => {
        const id = input.id || generateId("rec-exp");
        const plannedTxId = insertPlannedTransaction(db, "recurring_expense", input.priority);
        const repeatEveryMonths = requireStartMonthYearIfNeeded(input);

        db.prepare(`
          INSERT INTO recurring_expenses (
            id, name, currency, amount, prediction_strategy, necessary, active,
            repeat_every_months, start_month_year, anchor_type, anchor_day_of_month,
            anchor_offset_days, anchor_business_day_adjustment, anchor_holiday_country,
            planned_transaction_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          input.name || "Unnamed",
          input.currency || "PLN",
          Math.max(0, Number(input.amount) || 0),
          ["fixed", "12month_max"].includes(input.prediction_strategy) ? input.prediction_strategy : "fixed",
          input.necessary ? 1 : 0,
          input.active !== false ? 1 : 0,
          repeatEveryMonths,
          input.start_month_year || null,
          ["day_of_month", "month_end"].includes(input.anchor_type) ? input.anchor_type : "month_end",
          input.anchor_day_of_month || null,
          Number(input.anchor_offset_days) || 0,
          input.anchor_business_day_adjustment || "none",
          (input.anchor_holiday_country || "PL").toUpperCase(),
          plannedTxId
        );

        return db.prepare(`
          SELECT r.*, pt.operating_priority AS priority
          FROM recurring_expenses r
          JOIN planned_transactions pt ON pt.id = r.planned_transaction_id
          WHERE r.id = ?
        `).get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  function updateRecurringExpense(userId, id, input) {
    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const existing = db.prepare(`
          SELECT *
          FROM recurring_expenses
          WHERE id = ?
        `).get(id);

        if (!existing) throw new Error("Recurring expense not found");

        const merged = normalizeRecurringInput(existing, input || {});

        if (input.priority !== undefined) {
          updatePlannedPriority(db, existing.planned_transaction_id, "operating", input.priority);
        }

        db.prepare(`
          UPDATE recurring_expenses SET
            name = ?,
            currency = ?,
            amount = ?,
            prediction_strategy = ?,
            necessary = ?,
            active = ?,
            repeat_every_months = ?,
            start_month_year = ?,
            anchor_type = ?,
            anchor_day_of_month = ?,
            anchor_offset_days = ?,
            anchor_business_day_adjustment = ?,
            anchor_holiday_country = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          merged.name || "Unnamed",
          String(merged.currency || "PLN").toUpperCase(),
          Math.max(0, Number(merged.amount) || 0),
          ["fixed", "12month_max"].includes(merged.prediction_strategy) ? merged.prediction_strategy : "fixed",
          merged.necessary ? 1 : 0,
          merged.active === false || Number(merged.active) === 0 ? 0 : 1,
          merged.repeat_every_months,
          merged.start_month_year || null,
          ["day_of_month", "month_end"].includes(merged.anchor_type) ? merged.anchor_type : "month_end",
          merged.anchor_day_of_month || null,
          Number(merged.anchor_offset_days) || 0,
          merged.anchor_business_day_adjustment || "none",
          String(merged.anchor_holiday_country || "PL").toUpperCase(),
          id
        );

        return db.prepare(`
          SELECT r.*, pt.operating_priority AS priority
          FROM recurring_expenses r
          JOIN planned_transactions pt ON pt.id = r.planned_transaction_id
          WHERE r.id = ?
        `).get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  function deleteRecurringExpense(userId, id) {
    const db = openPlanningDb(userId);
    try {
      db.transaction(() => {
        const expense = db.prepare(`
          SELECT planned_transaction_id
          FROM recurring_expenses
          WHERE id = ?
        `).get(id);

        if (!expense) throw new Error("Recurring expense not found");

        db.prepare("DELETE FROM recurring_expenses WHERE id = ?").run(id);
        db.prepare("DELETE FROM planned_transactions WHERE id = ?").run(expense.planned_transaction_id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, { ok: true });
  }

  function createRecurringIncome(userId, input) {
    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const id = input.id || generateId("rec-inc");
        const repeatEveryMonths = requireStartMonthYearIfNeeded(input);
        const periodSetting = input.period_setting ? 1 : 0;

        db.prepare(`
          INSERT INTO recurring_incomes (
            id, name, currency, amount, prediction_strategy, active,
            repeat_every_months, start_month_year, anchor_type, anchor_day_of_month,
            anchor_offset_days, anchor_business_day_adjustment, anchor_holiday_country,
            period_setting, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          input.name || "Unnamed",
          String(input.currency || "PLN").toUpperCase(),
          Math.max(0, Number(input.amount) || 0),
          ["fixed", "12month_min"].includes(input.prediction_strategy) ? input.prediction_strategy : "fixed",
          input.active !== false ? 1 : 0,
          repeatEveryMonths,
          input.start_month_year || null,
          ["day_of_month", "month_end"].includes(input.anchor_type) ? input.anchor_type : "month_end",
          input.anchor_day_of_month || null,
          Number(input.anchor_offset_days) || 0,
          input.anchor_business_day_adjustment || "none",
          String(input.anchor_holiday_country || "PL").toUpperCase(),
          periodSetting
        );

        if (periodSetting) {
          db.prepare(`
            UPDATE settings
            SET budget_period_income_id = ?, updated_at = datetime('now')
            WHERE id = 1
          `).run(id);

          db.prepare(`
            UPDATE recurring_incomes
            SET period_setting = CASE WHEN id = ? THEN 1 ELSE 0 END,
                updated_at = datetime('now')
          `).run(id);
        }

        return db.prepare("SELECT * FROM recurring_incomes WHERE id = ?").get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  function updateRecurringIncome(userId, id, input) {
    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const existing = db.prepare(`
          SELECT *
          FROM recurring_incomes
          WHERE id = ?
        `).get(id);

        if (!existing) throw new Error("Recurring income not found");

        const merged = normalizeRecurringInput(existing, input || {});

        db.prepare(`
          UPDATE recurring_incomes SET
            name = ?,
            currency = ?,
            amount = ?,
            prediction_strategy = ?,
            active = ?,
            repeat_every_months = ?,
            start_month_year = ?,
            anchor_type = ?,
            anchor_day_of_month = ?,
            anchor_offset_days = ?,
            anchor_business_day_adjustment = ?,
            anchor_holiday_country = ?,
            period_setting = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          merged.name || "Unnamed",
          String(merged.currency || "PLN").toUpperCase(),
          Math.max(0, Number(merged.amount) || 0),
          ["fixed", "12month_min"].includes(merged.prediction_strategy) ? merged.prediction_strategy : "fixed",
          merged.active === false || Number(merged.active) === 0 ? 0 : 1,
          merged.repeat_every_months,
          merged.start_month_year || null,
          ["day_of_month", "month_end"].includes(merged.anchor_type) ? merged.anchor_type : "month_end",
          merged.anchor_day_of_month || null,
          Number(merged.anchor_offset_days) || 0,
          merged.anchor_business_day_adjustment || "none",
          String(merged.anchor_holiday_country || "PL").toUpperCase(),
          merged.period_setting ? 1 : 0,
          id
        );

        if (merged.period_setting) {
          db.prepare(`
            UPDATE settings
            SET budget_period_income_id = ?, updated_at = datetime('now')
            WHERE id = 1
          `).run(id);

          db.prepare(`
            UPDATE recurring_incomes
            SET period_setting = CASE WHEN id = ? THEN 1 ELSE 0 END
          `).run(id);
        }

        return db.prepare("SELECT * FROM recurring_incomes WHERE id = ?").get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  function deleteRecurringIncome(userId, id) {
    const db = openPlanningDb(userId);
    try {
      db.transaction(() => {
        const existing = db.prepare("SELECT * FROM recurring_incomes WHERE id = ?").get(id);
        if (!existing) throw new Error("Recurring income not found");

        db.prepare("DELETE FROM recurring_incomes WHERE id = ?").run(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, { ok: true });
  }

  function updatePendingTransaction(userId, id, input = {}) {
    const db = openPlanningDb(userId);

    try {
      const pending = db.prepare("SELECT * FROM pending_transactions WHERE id = ?").get(id);
      if (!pending) throw new Error("Pending transaction not found");

      const nextCurrency = String(input.currency || pending.currency).toUpperCase();

      if (nextCurrency !== String(pending.currency || "").toUpperCase()) {
        throw new Error("Changing currency on a pending transaction is not supported; create a new transaction instead");
      }

      const nextDate = String(input.date || pending.date);
      const nextAmount = Math.abs(Number(input.amount ?? pending.amount) || 0);

      if (!Number.isFinite(nextAmount) || nextAmount < 0) {
        throw new Error("Pending transaction amount must be a non-negative number");
      }

      if (pending.source_recurring_income_id) {
        const income = db.prepare(`
          SELECT *
          FROM recurring_incomes
          WHERE id = ?
        `).get(pending.source_recurring_income_id);

        const newestConfirmed = newestConfirmedTransactionDate(userId);

        if (
          income?.period_setting &&
          newestConfirmed &&
          nextDate < newestConfirmed
        ) {
          throw new Error(
            "Period-setting income cannot be moved earlier than the newest confirmed ledger transaction"
          );
        }
      }

      const fx = Number(pending.buffered_fx_rate || pending.fx_rate || 1);
      const ledgerAmount = nextAmount * fx;

      // Keep the source occurrence stable when users edit real-world pending details such as date or amount.
      const nextOccurrenceKey = pending.occurrence_key || makeOccurrenceKey({
        type: pending.type,
        date: pending.date,
        sourceRecurringExpenseId: pending.source_recurring_expense_id || null,
        sourceRecurringIncomeId: pending.source_recurring_income_id || null,
        sourceOneOffId: pending.source_one_off_id || null,
        sourceFlexId: pending.source_flex_id || null,
        sourceGoalId: pending.source_goal_id || null
      });

      const existingOccurrence = db.prepare(`
        SELECT id
        FROM pending_transactions
        WHERE occurrence_key = ?
          AND id != ?
        LIMIT 1
      `).get(nextOccurrenceKey, id);

      if (existingOccurrence) {
        throw new Error("Another pending transaction already exists for this occurrence");
      }

      db.transaction(() => {
        db.prepare(`
          UPDATE pending_transactions
          SET
            date = ?,
            amount = ?,
            funded_amount = ?,
            requested_amount = COALESCE(requested_amount, ?),
            ledger_amount = ?,
            currency = ?,
            name = ?,
            occurrence_key = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          nextDate,
          nextAmount,
          nextAmount,
          nextAmount,
          ledgerAmount,
          nextCurrency,
          String(input.name || pending.name),
          nextOccurrenceKey,
          id
        );

        recalculatePlanningRunningBalances(db, userId);
      })();

      return db.prepare("SELECT * FROM pending_transactions WHERE id = ?").get(id);
    } finally {
      db.close();
    }
  }

  function createGoal(userId, input) {
    let result;

    const db = openPlanningDb(userId);
    try {
      result = db.transaction(() => {
        const id = input.id || generateId("goal");
        const plannedTxId = insertPlannedTransaction(db, "goal", input.priority);
        const amount = Math.max(0.01, Number(input.amount) || 0);

        db.prepare(`
          INSERT INTO goals (
            id, name, currency, amount, active, due_date, planned_transaction_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          input.name || "Unnamed",
          input.currency || "PLN",
          amount,
          input.active !== false ? 1 : 0,
          String(input.due_date || todayWarsaw()),
          plannedTxId
        );

        return db.prepare(`
          SELECT g.*, pt.goal_priority AS priority
          FROM goals g
          JOIN planned_transactions pt ON pt.id = g.planned_transaction_id
          WHERE g.id = ?
        `).get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  function updateGoal(userId, id, input) {
    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const existing = db.prepare(`
          SELECT *
          FROM goals
          WHERE id = ?
        `).get(id);

        if (!existing) throw new Error("Goal not found");

        const merged = {
          ...existing,
          ...(input || {})
        };

        if (input.priority !== undefined) {
          updatePlannedPriority(db, existing.planned_transaction_id, "goal", input.priority);
        }

        db.prepare(`
          UPDATE goals SET
            name = ?,
            currency = ?,
            amount = ?,
            active = ?,
            due_date = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          merged.name || "Unnamed",
          String(merged.currency || "PLN").toUpperCase(),
          Math.max(0.01, Number(merged.amount) || 0),
          merged.active === false || Number(merged.active) === 0 ? 0 : 1,
          String(merged.due_date || todayWarsaw()),
          id
        );

        return db.prepare(`
          SELECT g.*, pt.goal_priority AS priority
          FROM goals g
          JOIN planned_transactions pt ON pt.id = g.planned_transaction_id
          WHERE g.id = ?
        `).get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  function deleteGoal(userId, id) {
    const isConfirmed = loadAllConfirmedTransactions(userId)
      .some(tx => tx.source_goal_id === id);

    if (isConfirmed) {
      throw new Error("Cannot delete confirmed goal transaction");
    }

    const db = openPlanningDb(userId);
    try {
      db.transaction(() => {
        const goal = db.prepare(`
          SELECT planned_transaction_id
          FROM goals
          WHERE id = ?
        `).get(id);

        if (!goal) throw new Error("Goal not found");

        db.prepare("DELETE FROM pending_transactions WHERE source_goal_id = ?").run(id);
        db.prepare("DELETE FROM future_transactions WHERE source_goal_id = ?").run(id);
        db.prepare("DELETE FROM goals WHERE id = ?").run(id);
        db.prepare("DELETE FROM planned_transactions WHERE id = ?").run(goal.planned_transaction_id);
        recalculatePlanningRunningBalances(db, userId);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, { ok: true });
  }

  function createFlexTransaction(userId, input) {
    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const id = input.id || generateId("flex");
        const plannedTxId = insertPlannedTransaction(db, "flex", input.priority);

        const allowSplit = Number(input.allow_split) === 1 || input.allow_split === true ? 1 : 0;
        const minAmount = allowSplit ? nullablePositiveAmount(input.min_amount) : null;
        const maxAmount = allowSplit ? nullablePositiveAmount(input.max_amount) : null;

        if (allowSplit && minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
          throw new Error("Flex min amount cannot be greater than max amount");
        }

        db.prepare(`
          INSERT INTO flex_transactions (
            id,
            name,
            currency,
            amount,
            active,
            allow_split,
            min_amount,
            max_amount,
            planned_transaction_id,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          input.name || "Unnamed",
          normalizeCurrency(input.currency || "PLN"),
          Math.max(0, Number(input.amount) || 0),
          input.active === false || Number(input.active) === 0 ? 0 : 1,
          allowSplit,
          minAmount,
          maxAmount,
          plannedTxId
        );

        return db.prepare(`
          SELECT f.*, pt.operating_priority AS priority
          FROM flex_transactions f
          JOIN planned_transactions pt ON pt.id = f.planned_transaction_id
          WHERE f.id = ?
        `).get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  function updateFlexTransaction(userId, id, input = {}) {
    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const existing = db.prepare(`
          SELECT *
          FROM flex_transactions
          WHERE id = ?
        `).get(id);

        if (!existing) {
          throw new Error("Flex transaction not found");
        }

        const merged = {
          ...existing,
          ...input
        };

        if (Object.prototype.hasOwnProperty.call(input, "priority")) {
          updatePlannedPriority(db, existing.planned_transaction_id, "operating", input.priority);
        }

        const allowSplit = Number(merged.allow_split) === 1 || merged.allow_split === true ? 1 : 0;

        // Important:
        // If allow_split is true, use the values supplied in the request, even if they are empty strings.
        // Empty string means "clear this value", not "keep the old value".
        const minSource = Object.prototype.hasOwnProperty.call(input, "min_amount")
          ? input.min_amount
          : existing.min_amount;

        const maxSource = Object.prototype.hasOwnProperty.call(input, "max_amount")
          ? input.max_amount
          : existing.max_amount;

        const minAmount = allowSplit ? nullablePositiveAmount(minSource) : null;
        const maxAmount = allowSplit ? nullablePositiveAmount(maxSource) : null;

        if (allowSplit && minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
          throw new Error("Flex min amount cannot be greater than max amount");
        }

        db.prepare(`
          UPDATE flex_transactions SET
            name = ?,
            currency = ?,
            amount = ?,
            active = ?,
            allow_split = ?,
            min_amount = ?,
            max_amount = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          merged.name || "Unnamed",
          normalizeCurrency(merged.currency || "PLN"),
          Math.max(0, Number(merged.amount) || 0),
          merged.active === false || Number(merged.active) === 0 ? 0 : 1,
          allowSplit,
          minAmount,
          maxAmount,
          id
        );

        return db.prepare(`
          SELECT f.*, pt.operating_priority AS priority
          FROM flex_transactions f
          JOIN planned_transactions pt ON pt.id = f.planned_transaction_id
          WHERE f.id = ?
        `).get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  function deleteFlexTransaction(userId, id) {
    const isConfirmed = loadAllConfirmedTransactions(userId)
      .some(tx => tx.source_flex_id === id);

    if (isConfirmed) {
      throw new Error("Cannot delete confirmed flex transaction");
    }

    const db = openPlanningDb(userId);
    try {
      db.transaction(() => {
        const flex = db.prepare(`
          SELECT planned_transaction_id
          FROM flex_transactions
          WHERE id = ?
        `).get(id);

        if (!flex) throw new Error("Flex transaction not found");

        db.prepare("DELETE FROM pending_transactions WHERE source_flex_id = ?").run(id);
        db.prepare("DELETE FROM future_transactions WHERE source_flex_id = ?").run(id);
        db.prepare("DELETE FROM flex_transactions WHERE id = ?").run(id);
        db.prepare("DELETE FROM planned_transactions WHERE id = ?").run(flex.planned_transaction_id);
        recalculatePlanningRunningBalances(db, userId);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, { ok: true });
  }

  function createOneOffTransaction(userId, input) {
    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const id = input.id || generateId("oneoff");

        db.prepare(`
          INSERT INTO one_off_transactions (
            id, name, currency, amount, type, date, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          input.name || "Unnamed",
          input.currency || "PLN",
          Math.abs(Number(input.amount) || 0),
          ["income", "expense"].includes(input.type) ? input.type : "expense",
          String(input.date || todayWarsaw())
        );

        return db.prepare("SELECT * FROM one_off_transactions WHERE id = ?").get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  function updateOneOffTransaction(userId, id, input) {
    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const existing = db.prepare("SELECT * FROM one_off_transactions WHERE id = ?").get(id);
        if (!existing) throw new Error("One-off transaction not found");

        db.prepare(`
          UPDATE one_off_transactions SET
            name = ?,
            currency = ?,
            amount = ?,
            type = ?,
            date = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          input.name || existing.name || "Unnamed",
          input.currency || existing.currency || "PLN",
          Math.abs(Number(input.amount ?? existing.amount) || 0),
          ["income", "expense"].includes(input.type) ? input.type : existing.type,
          String(input.date || existing.date || todayWarsaw()),
          id
        );

        return db.prepare("SELECT * FROM one_off_transactions WHERE id = ?").get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  function deleteOneOffTransaction(userId, id) {
    const isConfirmed = loadAllConfirmedTransactions(userId)
      .some(tx => tx.source_one_off_id === id);

    if (isConfirmed) {
      throw new Error("Cannot delete confirmed one-off transaction");
    }

    const db = openPlanningDb(userId);
    try {
      db.transaction(() => {
        const existing = db.prepare("SELECT * FROM one_off_transactions WHERE id = ?").get(id);
        if (!existing) throw new Error("One-off transaction not found");

        db.prepare("DELETE FROM pending_transactions WHERE source_one_off_id = ?").run(id);
        db.prepare("DELETE FROM future_transactions WHERE source_one_off_id = ?").run(id);
        db.prepare("DELETE FROM one_off_transactions WHERE id = ?").run(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, { ok: true });
  }

  return {
    createFlexTransaction,
    createGoal,
    createOneOffTransaction,
    createRecurringExpense,
    createRecurringIncome,
    deleteFlexTransaction,
    deleteGoal,
    deleteOneOffTransaction,
    deleteRecurringExpense,
    deleteRecurringIncome,
    updateFlexTransaction,
    updateGoal,
    updateOneOffTransaction,
    updatePendingTransaction,
    updateRecurringExpense,
    updateRecurringIncome
  };
}
