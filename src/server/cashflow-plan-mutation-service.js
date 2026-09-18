import { DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { calculateNextDate, requireHolidayCountry, requireIsoDate, todayInTimezone } from "./cashflow-date-utils.js";
import { requireSupportedCurrency } from "./cashflow-fx-provider-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { addMoneyAmounts, multiplyMoney, roundMoneyAmount } from "./cashflow-money-utils.js";
import { badRequest, conflict, notFound } from "./cashflow-user-utils.js";
import { makeOccurrenceKey } from "./cashflow-occurrence-utils.js";
import { validatePlanMutationInput } from "./cashflow-plan-input-validation.js";
import {
  applyPlanningRunningBalancePlan,
  createPlanningRunningBalancePlan
} from "./cashflow-planning-balance-plan.js";
import {
  normalizePriority,
  priorityColumnForDomain,
  priorityTypesForDomain,
  reorderPriorityDomain,
  updatePlannedPriority
} from "./cashflow-priority-utils.js";

export function createCashflowPlanMutationService({
  budgetStore = null,
  loadAllConfirmedTransactions,
  listLedgerYears,
  newestConfirmedTransactionDate,
  normalizeRecurringInput,
  openLedgerDb,
  openPlanningDb,
  recalculatePlanningRunningBalances,
  requireStartMonthYearIfNeeded,
  runRecoverableUserMutation,
  withProjectionStatus
}) {
  function todayForUser(db) {
    const settings = db.prepare("SELECT timezone FROM settings WHERE id = 1").get() || {};
    return todayInTimezone(settings.timezone || DEFAULT_TIMEZONE);
  }

  function requireDateOrDefault(value, fallback, fieldName = "date") {
    return requireIsoDate(value || fallback, fieldName);
  }

  function defaultHolidayCountry(db) {
    const settings = db.prepare("SELECT holiday_country FROM settings WHERE id = 1").get() || {};
    return requireHolidayCountry(settings.holiday_country || "PL", "holiday_country");
  }

  function normalizeAnchorHolidayCountry(db, value, existing = null) {
    return requireHolidayCountry(value || existing || defaultHolidayCountry(db), "anchor_holiday_country");
  }

  function normalizeAnchorHolidayCountryFromSettings(settings, value, existing = null) {
    return requireHolidayCountry(
      value || existing || settings?.holiday_country || "PL",
      "anchor_holiday_country"
    );
  }

  function requireExistingAnchorIncomeId(db, anchorIncomeId) {
    if (!anchorIncomeId) return null;

    const income = db.prepare("SELECT id FROM recurring_incomes WHERE id = ?").get(anchorIncomeId);
    if (!income) {
      throw badRequest("Anchor income not found", [{ field: "anchor_income_id", reason: "not_found" }]);
    }

    return anchorIncomeId;
  }

  async function requireExistingAnchorIncomeIdWithBudgetStore(writer, userId, anchorIncomeId) {
    if (!anchorIncomeId) return null;

    const incomes = await writer.listPlanningRows(userId, "recurring_incomes");
    if (!incomes.some(income => income.id === anchorIncomeId)) {
      throw badRequest("Anchor income not found", [{ field: "anchor_income_id", reason: "not_found" }]);
    }

    return anchorIncomeId;
  }

  function clearBudgetPeriodIncomeIfSelected(db, incomeId) {
    db.prepare(`
      UPDATE settings
      SET budget_period_income_id = NULL,
          updated_at = datetime('now')
      WHERE id = 1
        AND budget_period_income_id = ?
    `).run(incomeId);
  }

  async function clearBudgetPeriodIncomeIfSelectedWithBudgetStore(writer, userId, incomeId) {
    const settings = (await writer.listPlanningRows(userId, "settings"))?.[0] || {};
    if (settings.budget_period_income_id !== incomeId) return;

    await writer.updatePlanningRowsById(userId, "settings", [{
      budget_period_income_id: null,
      id: 1,
      updated_at: new Date().toISOString()
    }]);
  }

  function pgBoolean(value) {
    return value === true || value === 1;
  }

  function confirmedOneOffRows(userId, oneOffId) {
    return loadAllConfirmedTransactions(userId)
      .filter(tx => tx.source_one_off_id === oneOffId);
  }

  function confirmedOneOffOriginalAmountFromRows(rows, currency, type) {
    return rows
      .filter(tx =>
        String(tx.currency || "").toUpperCase() === String(currency || "").toUpperCase() &&
        String(tx.type || "") === String(type || "")
      )
      .reduce((sum, tx) => addMoneyAmounts(sum, tx.amount), 0);
  }

  function confirmedOneOffOriginalAmount(userId, oneOffId, currency, type) {
    return confirmedOneOffOriginalAmountFromRows(confirmedOneOffRows(userId, oneOffId), currency, type);
  }

  async function confirmedOneOffRowsAsync(userId, oneOffId, store = budgetStore) {
    if (!store || typeof store.listConfirmedTransactions !== "function") {
      return confirmedOneOffRows(userId, oneOffId);
    }

    return (await store.listConfirmedTransactions(userId))
      .filter(tx => tx.source_one_off_id === oneOffId);
  }

  function uncoupleConfirmedOneOffRows(userId, oneOffId) {
    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);
      try {
        ledgerDb.prepare(`
          UPDATE confirmed_transactions
          SET source_one_off_id = NULL,
              updated_at = datetime('now')
          WHERE source_one_off_id = ?
        `).run(oneOffId);
      } finally {
        ledgerDb.close();
      }
    }
  }

  function confirmedGoalRows(userId, goalId) {
    return loadAllConfirmedTransactions(userId)
      .filter(tx => tx.source_goal_id === goalId);
  }

  function confirmedGoalOriginalAmount(userId, goalId, currency) {
    return confirmedGoalRows(userId, goalId)
      .filter(tx =>
        String(tx.currency || "").toUpperCase() === String(currency || "").toUpperCase() &&
        String(tx.type || "") !== "income"
      )
      .reduce((sum, tx) => addMoneyAmounts(sum, tx.amount), 0);
  }

  async function confirmedGoalRowsAsync(userId, goalId, store = budgetStore) {
    if (!store || typeof store.listConfirmedTransactions !== "function") {
      return confirmedGoalRows(userId, goalId);
    }

    return (await store.listConfirmedTransactions(userId))
      .filter(tx => tx.source_goal_id === goalId);
  }

  function confirmedGoalOriginalAmountFromRows(rows, currency) {
    return rows
      .filter(tx =>
        String(tx.currency || "").toUpperCase() === String(currency || "").toUpperCase() &&
        String(tx.type || "") !== "income"
      )
      .reduce((sum, tx) => addMoneyAmounts(sum, tx.amount), 0);
  }

  function uncoupleConfirmedGoalRows(userId, goalId) {
    for (const year of listLedgerYears(userId)) {
      const ledgerDb = openLedgerDb(userId, year);
      try {
        ledgerDb.prepare(`
          UPDATE confirmed_transactions
          SET source_goal_id = NULL,
              updated_at = datetime('now')
          WHERE source_goal_id = ?
        `).run(goalId);
      } finally {
        ledgerDb.close();
      }
    }
  }

  function normalizePredictionSubstituteMissing(strategy, value) {
    if (strategy !== "12month_min" && strategy !== "12month_max") return "none";

    return [
      "none",
      "starting_value",
      "average_extreme_starting_value",
      "median_recorded",
      "last_confirmed",
      "previous_year_same_month",
      "require_min_recorded_months"
    ].includes(value) ? value : "none";
  }

  function normalizePredictionMinRecordedMonths(value) {
    const parsed = Math.trunc(Number(value));

    if (!Number.isFinite(parsed)) return 6;
    return Math.max(1, Math.min(12, parsed));
  }

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

  function sortPlannedRowsForPriority(rows, domain) {
    const column = priorityColumnForDomain(domain);
    return [...rows].sort((a, b) => {
      const aPriority = a[column] === null || a[column] === undefined ? 999999 : Number(a[column]);
      const bPriority = b[column] === null || b[column] === undefined ? 999999 : Number(b[column]);
      if (aPriority !== bPriority) return aPriority - bPriority;
      const aCreated = String(a.created_at || "");
      const bCreated = String(b.created_at || "");
      if (aCreated !== bCreated) return aCreated.localeCompare(bCreated);
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
  }

  async function reorderPriorityDomainWithBudgetStore(writer, userId, domain, plannedTransactionId, requestedPriority) {
    const priority = normalizePriority(requestedPriority);
    const column = priorityColumnForDomain(domain);
    const types = new Set(priorityTypesForDomain(domain));
    const rows = sortPlannedRowsForPriority(
      (await writer.listPlanningRows(userId, "planned_transactions"))
        .filter(row => types.has(row.type)),
      domain
    );

    const orderedIds = rows
      .map(row => row.id)
      .filter(rowId => rowId !== plannedTransactionId);

    const targetIndex = Math.max(0, Math.min(priority - 1, orderedIds.length));
    orderedIds.splice(targetIndex, 0, plannedTransactionId);

    await writer.updatePlanningRowsById(userId, "planned_transactions", orderedIds.map((rowId, index) => ({
      [column]: index + 1,
      id: rowId,
      updated_at: new Date().toISOString()
    })));
  }

  async function updatePlannedPriorityWithBudgetStore(writer, userId, plannedTransactionId, domain, requestedPriority) {
    const existing = (await writer.listPlanningRows(userId, "planned_transactions"))
      .find(row => row.id === plannedTransactionId);

    if (!existing) throw notFound("Planned transaction not found");

    await reorderPriorityDomainWithBudgetStore(writer, userId, domain, plannedTransactionId, requestedPriority);
  }

  async function insertPlannedTransactionWithBudgetStore(writer, userId, type, requestedPriority = 1) {
    const plannedTxId = generateId("planned");
    const domain = type === "goal" ? "goal" : "operating";
    const timestamp = new Date().toISOString();

    await writer.insertPlanningRows(userId, "planned_transactions", [{
      created_at: timestamp,
      goal_priority: null,
      id: plannedTxId,
      operating_priority: null,
      type,
      updated_at: timestamp
    }]);

    await reorderPriorityDomainWithBudgetStore(writer, userId, domain, plannedTxId, requestedPriority);
    return plannedTxId;
  }

  async function withPlanningPriority(writer, userId, row, domain) {
    if (!row) return row;
    const planned = (await writer.listPlanningRows(userId, "planned_transactions"))
      .find(candidate => candidate.id === row.planned_transaction_id) || {};
    return {
      ...row,
      priority: planned[priorityColumnForDomain(domain)] ?? null
    };
  }

  function createRecurringExpense(userId, input) {
    input = validatePlanMutationInput("recurring-expense", input, { create: true });
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return createRecurringExpenseWithBudgetStore(userId, input);
    }

    let result;

    const db = openPlanningDb(userId);
    try {
      result = db.transaction(() => {
        const id = generateId("rec-exp");
        const plannedTxId = insertPlannedTransaction(db, "recurring_expense", input.priority);
        const repeatEveryMonths = requireStartMonthYearIfNeeded(input);
        const anchorIncomeId = requireExistingAnchorIncomeId(db, input.anchor_income_id);

        db.prepare(`
          INSERT INTO recurring_expenses (
            id, name, currency, amount, prediction_strategy, prediction_substitute_missing,
            prediction_min_recorded_months, necessary, active,
            repeat_every_months, start_month_year, anchor_type, anchor_day_of_month,
            anchor_offset_days, anchor_business_day_adjustment, anchor_holiday_country,
            anchor_income_id, planned_transaction_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          input.name || "Unnamed",
          requireSupportedCurrency(input.currency || "PLN"),
          input.amount ?? 0,
          ["fixed", "12month_max"].includes(input.prediction_strategy) ? input.prediction_strategy : "fixed",
          normalizePredictionSubstituteMissing(input.prediction_strategy, input.prediction_substitute_missing),
          normalizePredictionMinRecordedMonths(input.prediction_min_recorded_months),
          input.necessary ?? 0,
          input.active ?? 1,
          repeatEveryMonths,
          input.start_month_year || null,
          ["day_of_month", "month_end"].includes(input.anchor_type) ? input.anchor_type : "month_end",
          input.anchor_day_of_month ?? null,
          input.anchor_offset_days ?? 0,
          input.anchor_business_day_adjustment || "none",
          normalizeAnchorHolidayCountry(db, input.anchor_holiday_country),
          anchorIncomeId,
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

  async function createRecurringExpenseWithBudgetStore(userId, input) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const settings = (await writer.listPlanningRows(userId, "settings"))?.[0] || {};
      const id = generateId("rec-exp");
      const plannedTxId = await insertPlannedTransactionWithBudgetStore(
        writer,
        userId,
        "recurring_expense",
        input.priority
      );
      const repeatEveryMonths = requireStartMonthYearIfNeeded(input);
      const timestamp = new Date().toISOString();
      const anchorIncomeId = await requireExistingAnchorIncomeIdWithBudgetStore(writer, userId, input.anchor_income_id);

      await writer.insertPlanningRows(userId, "recurring_expenses", [{
        active: pgBoolean(input.active ?? 1),
        amount: input.amount ?? 0,
        anchor_business_day_adjustment: input.anchor_business_day_adjustment || "none",
        anchor_day_of_month: input.anchor_day_of_month ?? null,
        anchor_holiday_country: normalizeAnchorHolidayCountryFromSettings(settings, input.anchor_holiday_country),
        anchor_income_id: anchorIncomeId,
        anchor_offset_days: input.anchor_offset_days ?? 0,
        anchor_type: ["day_of_month", "month_end"].includes(input.anchor_type) ? input.anchor_type : "month_end",
        created_at: timestamp,
        currency: requireSupportedCurrency(input.currency || "PLN"),
        id,
        name: input.name || "Unnamed",
        necessary: pgBoolean(input.necessary ?? 0),
        planned_transaction_id: plannedTxId,
        prediction_min_recorded_months: normalizePredictionMinRecordedMonths(input.prediction_min_recorded_months),
        prediction_strategy: ["fixed", "12month_max"].includes(input.prediction_strategy) ? input.prediction_strategy : "fixed",
        prediction_substitute_missing: normalizePredictionSubstituteMissing(input.prediction_strategy, input.prediction_substitute_missing),
        repeat_every_months: repeatEveryMonths,
        start_month_year: input.start_month_year || null,
        updated_at: timestamp
      }]);

      const row = (await writer.listPlanningRows(userId, "recurring_expenses"))
        .find(candidate => candidate.id === id);
      return await withPlanningPriority(writer, userId, row, "operating");
    });

    return withProjectionStatus(userId, result);
  }

  function updateRecurringExpense(userId, id, input) {
    input = validatePlanMutationInput("recurring-expense", input);
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return updateRecurringExpenseWithBudgetStore(userId, id, input);
    }

    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const existing = db.prepare(`
          SELECT *
          FROM recurring_expenses
          WHERE id = ?
        `).get(id);

        if (!existing) throw notFound("Recurring expense not found");

        const merged = normalizeRecurringInput(existing, input || {});
        const anchorIncomeId = requireExistingAnchorIncomeId(db, merged.anchor_income_id);

        if (input.priority !== undefined) {
          updatePlannedPriority(db, existing.planned_transaction_id, "operating", input.priority);
        }

        db.prepare(`
          UPDATE recurring_expenses SET
            name = ?,
            currency = ?,
            amount = ?,
            prediction_strategy = ?,
            prediction_substitute_missing = ?,
            prediction_min_recorded_months = ?,
            necessary = ?,
            active = ?,
            repeat_every_months = ?,
            start_month_year = ?,
            anchor_type = ?,
            anchor_day_of_month = ?,
            anchor_offset_days = ?,
            anchor_business_day_adjustment = ?,
            anchor_holiday_country = ?,
            anchor_income_id = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          merged.name || "Unnamed",
          requireSupportedCurrency(merged.currency || "PLN"),
          merged.amount,
          ["fixed", "12month_max"].includes(merged.prediction_strategy) ? merged.prediction_strategy : "fixed",
          normalizePredictionSubstituteMissing(merged.prediction_strategy, merged.prediction_substitute_missing),
          normalizePredictionMinRecordedMonths(merged.prediction_min_recorded_months),
          merged.necessary,
          merged.active,
          merged.repeat_every_months,
          merged.start_month_year || null,
          ["day_of_month", "month_end"].includes(merged.anchor_type) ? merged.anchor_type : "month_end",
          merged.anchor_day_of_month ?? null,
          merged.anchor_offset_days,
          merged.anchor_business_day_adjustment || "none",
          normalizeAnchorHolidayCountry(db, merged.anchor_holiday_country, existing.anchor_holiday_country),
          anchorIncomeId,
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

  async function updateRecurringExpenseWithBudgetStore(userId, id, input) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const existing = (await writer.listPlanningRows(userId, "recurring_expenses"))
        .find(row => row.id === id) || null;

      if (!existing) throw notFound("Recurring expense not found");

      const settings = (await writer.listPlanningRows(userId, "settings"))?.[0] || {};
      const merged = normalizeRecurringInput(existing, input || {});
      const anchorIncomeId = await requireExistingAnchorIncomeIdWithBudgetStore(writer, userId, merged.anchor_income_id);

      if (input.priority !== undefined) {
        await updatePlannedPriorityWithBudgetStore(
          writer,
          userId,
          existing.planned_transaction_id,
          "operating",
          input.priority
        );
      }

      await writer.updatePlanningRowsById(userId, "recurring_expenses", [{
        active: pgBoolean(merged.active),
        amount: merged.amount,
        anchor_business_day_adjustment: merged.anchor_business_day_adjustment || "none",
        anchor_day_of_month: merged.anchor_day_of_month ?? null,
        anchor_holiday_country: normalizeAnchorHolidayCountryFromSettings(
          settings,
          merged.anchor_holiday_country,
          existing.anchor_holiday_country
        ),
        anchor_income_id: anchorIncomeId,
        anchor_offset_days: merged.anchor_offset_days,
        anchor_type: ["day_of_month", "month_end"].includes(merged.anchor_type) ? merged.anchor_type : "month_end",
        currency: requireSupportedCurrency(merged.currency || "PLN"),
        id,
        name: merged.name || "Unnamed",
        necessary: pgBoolean(merged.necessary),
        prediction_min_recorded_months: normalizePredictionMinRecordedMonths(merged.prediction_min_recorded_months),
        prediction_strategy: ["fixed", "12month_max"].includes(merged.prediction_strategy) ? merged.prediction_strategy : "fixed",
        prediction_substitute_missing: normalizePredictionSubstituteMissing(merged.prediction_strategy, merged.prediction_substitute_missing),
        repeat_every_months: merged.repeat_every_months,
        start_month_year: merged.start_month_year || null,
        updated_at: new Date().toISOString()
      }]);

      const row = (await writer.listPlanningRows(userId, "recurring_expenses"))
        .find(candidate => candidate.id === id);
      return await withPlanningPriority(writer, userId, row, "operating");
    });

    return withProjectionStatus(userId, result);
  }

  function deleteRecurringExpense(userId, id) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return deleteRecurringExpenseWithBudgetStore(userId, id);
    }

    const db = openPlanningDb(userId);
    try {
      db.transaction(() => {
        const expense = db.prepare(`
          SELECT planned_transaction_id
          FROM recurring_expenses
          WHERE id = ?
        `).get(id);

        if (!expense) throw notFound("Recurring expense not found");

        // Generated rows retain foreign keys to the source, so remove them before deleting the plan.
        db.prepare("DELETE FROM pending_transactions WHERE source_recurring_expense_id = ?").run(id);
        db.prepare("DELETE FROM future_transactions WHERE source_recurring_expense_id = ?").run(id);
        db.prepare("DELETE FROM recurring_expenses WHERE id = ?").run(id);
        db.prepare("DELETE FROM planned_transactions WHERE id = ?").run(expense.planned_transaction_id);
        recalculatePlanningRunningBalances(db, userId);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, { ok: true });
  }

  function createRecurringIncome(userId, input) {
    input = validatePlanMutationInput("recurring-income", input, { create: true });
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return createRecurringIncomeWithBudgetStore(userId, input);
    }

    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const id = generateId("rec-inc");
        const repeatEveryMonths = requireStartMonthYearIfNeeded(input);
        const active = input.active ?? 1;
        const periodSetting = active === 1 && input.period_setting === 1 ? 1 : 0;

        db.prepare(`
          INSERT INTO recurring_incomes (
            id, name, currency, amount, prediction_strategy, prediction_substitute_missing,
            prediction_min_recorded_months, active,
            repeat_every_months, start_month_year, anchor_type, anchor_day_of_month,
            anchor_offset_days, anchor_business_day_adjustment, anchor_holiday_country,
            period_setting, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          input.name || "Unnamed",
          requireSupportedCurrency(input.currency || "PLN"),
          input.amount ?? 0,
          ["fixed", "12month_min"].includes(input.prediction_strategy) ? input.prediction_strategy : "fixed",
          normalizePredictionSubstituteMissing(input.prediction_strategy, input.prediction_substitute_missing),
          normalizePredictionMinRecordedMonths(input.prediction_min_recorded_months),
          active,
          repeatEveryMonths,
          input.start_month_year || null,
          ["day_of_month", "month_end"].includes(input.anchor_type) ? input.anchor_type : "month_end",
          input.anchor_day_of_month ?? null,
          input.anchor_offset_days ?? 0,
          input.anchor_business_day_adjustment || "none",
          normalizeAnchorHolidayCountry(db, input.anchor_holiday_country),
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

  async function setOnlyPeriodSettingIncomeWithBudgetStore(writer, userId, incomeId) {
    const timestamp = new Date().toISOString();
    const incomes = await writer.listPlanningRows(userId, "recurring_incomes");
    await writer.updatePlanningRowsById(userId, "recurring_incomes", incomes.map(row => ({
      id: row.id,
      period_setting: row.id === incomeId,
      updated_at: timestamp
    })));
  }

  async function createRecurringIncomeWithBudgetStore(userId, input) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const settings = (await writer.listPlanningRows(userId, "settings"))?.[0] || {};
      const id = generateId("rec-inc");
      const repeatEveryMonths = requireStartMonthYearIfNeeded(input);
      const active = pgBoolean(input.active ?? 1);
      const periodSetting = active && pgBoolean(input.period_setting ?? 0);
      const timestamp = new Date().toISOString();

      await writer.insertPlanningRows(userId, "recurring_incomes", [{
        active,
        amount: input.amount ?? 0,
        anchor_business_day_adjustment: input.anchor_business_day_adjustment || "none",
        anchor_day_of_month: input.anchor_day_of_month ?? null,
        anchor_holiday_country: normalizeAnchorHolidayCountryFromSettings(settings, input.anchor_holiday_country),
        anchor_offset_days: input.anchor_offset_days ?? 0,
        anchor_type: ["day_of_month", "month_end"].includes(input.anchor_type) ? input.anchor_type : "month_end",
        created_at: timestamp,
        currency: requireSupportedCurrency(input.currency || "PLN"),
        id,
        name: input.name || "Unnamed",
        period_setting: periodSetting,
        prediction_min_recorded_months: normalizePredictionMinRecordedMonths(input.prediction_min_recorded_months),
        prediction_strategy: ["fixed", "12month_min"].includes(input.prediction_strategy) ? input.prediction_strategy : "fixed",
        prediction_substitute_missing: normalizePredictionSubstituteMissing(input.prediction_strategy, input.prediction_substitute_missing),
        repeat_every_months: repeatEveryMonths,
        start_month_year: input.start_month_year || null,
        updated_at: timestamp
      }]);

      if (periodSetting) {
        await writer.updatePlanningRowsById(userId, "settings", [{
          budget_period_income_id: id,
          id: 1,
          updated_at: timestamp
        }]);
        await setOnlyPeriodSettingIncomeWithBudgetStore(writer, userId, id);
      }

      return (await writer.listPlanningRows(userId, "recurring_incomes"))
        .find(candidate => candidate.id === id);
    });

    return withProjectionStatus(userId, result);
  }

  function updateRecurringIncome(userId, id, input) {
    input = validatePlanMutationInput("recurring-income", input);
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return updateRecurringIncomeWithBudgetStore(userId, id, input);
    }

    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const existing = db.prepare(`
          SELECT *
          FROM recurring_incomes
          WHERE id = ?
        `).get(id);

        if (!existing) throw notFound("Recurring income not found");

        const merged = normalizeRecurringInput(existing, input || {});
        const nextActive = merged.active;
        const nextPeriodSetting = nextActive === 1 && merged.period_setting === 1 ? 1 : 0;

        db.prepare(`
          UPDATE recurring_incomes SET
            name = ?,
            currency = ?,
            amount = ?,
            prediction_strategy = ?,
            prediction_substitute_missing = ?,
            prediction_min_recorded_months = ?,
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
          requireSupportedCurrency(merged.currency || "PLN"),
          merged.amount,
          ["fixed", "12month_min"].includes(merged.prediction_strategy) ? merged.prediction_strategy : "fixed",
          normalizePredictionSubstituteMissing(merged.prediction_strategy, merged.prediction_substitute_missing),
          normalizePredictionMinRecordedMonths(merged.prediction_min_recorded_months),
          nextActive,
          merged.repeat_every_months,
          merged.start_month_year || null,
          ["day_of_month", "month_end"].includes(merged.anchor_type) ? merged.anchor_type : "month_end",
          merged.anchor_day_of_month ?? null,
          merged.anchor_offset_days,
          merged.anchor_business_day_adjustment || "none",
          normalizeAnchorHolidayCountry(db, merged.anchor_holiday_country, existing.anchor_holiday_country),
          nextPeriodSetting,
          id
        );

        if (nextPeriodSetting) {
          db.prepare(`
            UPDATE settings
            SET budget_period_income_id = ?, updated_at = datetime('now')
            WHERE id = 1
          `).run(id);

          db.prepare(`
            UPDATE recurring_incomes
            SET period_setting = CASE WHEN id = ? THEN 1 ELSE 0 END
          `).run(id);
        } else {
          clearBudgetPeriodIncomeIfSelected(db, id);
        }

        return db.prepare("SELECT * FROM recurring_incomes WHERE id = ?").get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  async function updateRecurringIncomeWithBudgetStore(userId, id, input) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const existing = (await writer.listPlanningRows(userId, "recurring_incomes"))
        .find(row => row.id === id) || null;

      if (!existing) throw notFound("Recurring income not found");

      const settings = (await writer.listPlanningRows(userId, "settings"))?.[0] || {};
      const merged = normalizeRecurringInput(existing, input || {});
      const nextActive = pgBoolean(merged.active);
      const nextPeriodSetting = nextActive && pgBoolean(merged.period_setting);

      await writer.updatePlanningRowsById(userId, "recurring_incomes", [{
        active: nextActive,
        amount: merged.amount,
        anchor_business_day_adjustment: merged.anchor_business_day_adjustment || "none",
        anchor_day_of_month: merged.anchor_day_of_month ?? null,
        anchor_holiday_country: normalizeAnchorHolidayCountryFromSettings(
          settings,
          merged.anchor_holiday_country,
          existing.anchor_holiday_country
        ),
        anchor_offset_days: merged.anchor_offset_days,
        anchor_type: ["day_of_month", "month_end"].includes(merged.anchor_type) ? merged.anchor_type : "month_end",
        currency: requireSupportedCurrency(merged.currency || "PLN"),
        id,
        name: merged.name || "Unnamed",
        period_setting: nextPeriodSetting,
        prediction_min_recorded_months: normalizePredictionMinRecordedMonths(merged.prediction_min_recorded_months),
        prediction_strategy: ["fixed", "12month_min"].includes(merged.prediction_strategy) ? merged.prediction_strategy : "fixed",
        prediction_substitute_missing: normalizePredictionSubstituteMissing(merged.prediction_strategy, merged.prediction_substitute_missing),
        repeat_every_months: merged.repeat_every_months,
        start_month_year: merged.start_month_year || null,
        updated_at: new Date().toISOString()
      }]);

      if (nextPeriodSetting) {
        await writer.updatePlanningRowsById(userId, "settings", [{
          budget_period_income_id: id,
          id: 1,
          updated_at: new Date().toISOString()
        }]);
        await setOnlyPeriodSettingIncomeWithBudgetStore(writer, userId, id);
      } else {
        await clearBudgetPeriodIncomeIfSelectedWithBudgetStore(writer, userId, id);
      }

      return (await writer.listPlanningRows(userId, "recurring_incomes"))
        .find(candidate => candidate.id === id);
    });

    return withProjectionStatus(userId, result);
  }

  function fallbackAnchorDayForDependent(dependent, referencedIncome, today) {
    // Preserve roughly where the expense currently lands: use the same
    // income-anchored calculation calculateNextDate() already does for
    // real generation, for this cycle (or next, if this cycle's has
    // already passed), as the new fixed day-of-month — so deleting the
    // income doesn't silently jump the expense's date around.
    const [todayYear, todayMonth] = today.split("-").map(Number);
    const anchored = { ...dependent, anchor_income: referencedIncome };
    let anchorDate = calculateNextDate(anchored, todayYear, todayMonth);
    if (!anchorDate || anchorDate < today) {
      const next = new Date(Date.UTC(todayYear, todayMonth, 1));
      anchorDate = calculateNextDate(anchored, next.getUTCFullYear(), next.getUTCMonth() + 1);
    }
    return anchorDate ? Number(anchorDate.slice(8, 10)) : 1;
  }

  function reanchorDependentExpenseToFixedDay(db, dependent, referencedIncome, today) {
    const fallbackDay = fallbackAnchorDayForDependent(dependent, referencedIncome, today);

    db.prepare(`
      UPDATE recurring_expenses
      SET anchor_income_id = NULL,
          anchor_type = 'day_of_month',
          anchor_day_of_month = ?,
          anchor_offset_days = 0,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(fallbackDay, dependent.id);
  }

  function deleteRecurringIncome(userId, id, options = {}) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return deleteRecurringIncomeWithBudgetStore(userId, id, options);
    }

    const db = openPlanningDb(userId);
    try {
      db.transaction(() => {
        const existing = db.prepare("SELECT * FROM recurring_incomes WHERE id = ?").get(id);
        if (!existing) throw notFound("Recurring income not found");

        const dependents = db.prepare("SELECT * FROM recurring_expenses WHERE anchor_income_id = ?").all(id);

        if (dependents.length) {
          const reassignToIncomeId = options.reassignAnchorsToIncomeId || null;
          const fallbackToFixedDay = Boolean(options.fallbackAnchorsToFixedDay);

          if (!reassignToIncomeId && !fallbackToFixedDay) {
            throw conflict(
              "This income anchors other recurring expenses; reassign or convert them before deleting",
              {
                anchorDependents: dependents.map(dep => ({ id: dep.id, name: dep.name }))
              }
            );
          }

          if (reassignToIncomeId) {
            if (reassignToIncomeId === id) {
              throw badRequest("Cannot reassign to the income being deleted", [{
                field: "reassignAnchorsToIncomeId",
                reason: "same_as_deleted"
              }]);
            }
            const replacement = db.prepare("SELECT id FROM recurring_incomes WHERE id = ?").get(reassignToIncomeId);
            if (!replacement) {
              throw badRequest("Reassignment income not found", [{
                field: "reassignAnchorsToIncomeId",
                reason: "not_found"
              }]);
            }

            db.prepare(`
              UPDATE recurring_expenses
              SET anchor_income_id = ?, updated_at = datetime('now')
              WHERE anchor_income_id = ?
            `).run(reassignToIncomeId, id);
          } else {
            const today = todayForUser(db);
            for (const dependent of dependents) {
              reanchorDependentExpenseToFixedDay(db, dependent, existing, today);
            }
          }
        }

        db.prepare("DELETE FROM pending_transactions WHERE source_recurring_income_id = ?").run(id);
        db.prepare("DELETE FROM future_transactions WHERE source_recurring_income_id = ?").run(id);
        db.prepare("DELETE FROM recurring_incomes WHERE id = ?").run(id);
        clearBudgetPeriodIncomeIfSelected(db, id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, { ok: true });
  }

  function updatePendingTransaction(userId, id, input = {}) {
    input = validatePlanMutationInput("pending", input);
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return updatePendingTransactionWithBudgetStore(userId, id, input);
    }

    const db = openPlanningDb(userId);

    try {
      const pending = db.prepare("SELECT * FROM pending_transactions WHERE id = ?").get(id);
      if (!pending) throw notFound("Pending transaction not found");

      const nextCurrency = requireSupportedCurrency(input.currency || pending.currency);

      if (nextCurrency !== String(pending.currency || "").toUpperCase()) {
        throw badRequest("Changing currency on a pending transaction is not supported; create a new transaction instead");
      }

      const nextDate = requireIsoDate(input.date || pending.date);
      const nextAmount = input.amount ?? pending.amount;
      const nextName = String(input.name || pending.name);

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
          throw badRequest(
            "Period-setting income cannot be moved earlier than the newest confirmed ledger transaction"
          );
        }
      }

      const fx = Number(pending.buffered_fx_rate || pending.fx_rate || 1);
      const ledgerAmount = multiplyMoney(nextAmount, fx);

      // Keep the source occurrence stable when users edit real-world pending details such as date or amount.
      const nextOccurrenceKey = pending.occurrence_key || makeOccurrenceKey({
        type: pending.type,
        date: pending.date,
        sourceRecurringExpenseId: pending.source_recurring_expense_id || null,
        sourceRecurringIncomeId: pending.source_recurring_income_id || null,
        sourceOneOffId: pending.source_one_off_id || null,
        sourceFlexId: pending.source_flex_id || null,
        sourceGoalId: pending.source_goal_id || null,
        rowId: pending.id
      });

      const existingOccurrence = db.prepare(`
        SELECT id
        FROM pending_transactions
        WHERE occurrence_key = ?
          AND id != ?
        LIMIT 1
      `).get(nextOccurrenceKey, id);

      if (existingOccurrence) {
        throw badRequest("Another pending transaction already exists for this occurrence");
      }

      db.transaction(() => {
        if (pending.source_one_off_id) {
          const oneOff = db.prepare(`
            SELECT *
            FROM one_off_transactions
            WHERE id = ?
          `).get(pending.source_one_off_id);
          if (oneOff) {
            const confirmedAmount = confirmedOneOffOriginalAmount(
              userId,
              oneOff.id,
              oneOff.currency,
              oneOff.type
            );
            db.prepare(`
              UPDATE one_off_transactions
              SET name = ?,
                  amount = ?,
                  date = ?,
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(nextName, addMoneyAmounts(confirmedAmount, nextAmount), nextDate, oneOff.id);
          }
        }

        db.prepare(`
          UPDATE pending_transactions
          SET
            date = ?,
            amount = ?,
            funded_amount = ?,
            requested_amount = ?,
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
          nextName,
          nextOccurrenceKey,
          id
        );

        recalculatePlanningRunningBalances(db, userId);
      })();

      return withProjectionStatus(
        userId,
        db.prepare("SELECT * FROM pending_transactions WHERE id = ?").get(id),
        { preservePending: true }
      );
    } finally {
      db.close();
    }
  }

  async function updatePendingTransactionWithBudgetStore(userId, id, input = {}) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const pendingRows = await writer.listPlanningRows(userId, "pending_transactions");
      const pending = pendingRows.find(row => row.id === id) || null;
      if (!pending) throw notFound("Pending transaction not found");

      const nextCurrency = requireSupportedCurrency(input.currency || pending.currency);

      if (nextCurrency !== String(pending.currency || "").toUpperCase()) {
        throw badRequest("Changing currency on a pending transaction is not supported; create a new transaction instead");
      }

      const nextDate = requireIsoDate(input.date || pending.date);
      const nextAmount = input.amount ?? pending.amount;
      const nextName = String(input.name || pending.name);

      if (pending.source_recurring_income_id) {
        const income = (await writer.listPlanningRows(userId, "recurring_incomes"))
          .find(row => row.id === pending.source_recurring_income_id) || null;
        const newestConfirmed = (await writer.listConfirmedTransactions(userId))
          .reduce((newest, row) =>
            row.date && (!newest || row.date > newest) ? row.date : newest,
          null);

        if (
          income?.period_setting
          && newestConfirmed
          && nextDate < newestConfirmed
        ) {
          throw badRequest(
            "Period-setting income cannot be moved earlier than the newest confirmed ledger transaction"
          );
        }
      }

      const fx = Number(pending.buffered_fx_rate || pending.fx_rate || 1);
      const ledgerAmount = multiplyMoney(nextAmount, fx);

      const nextOccurrenceKey = pending.occurrence_key || makeOccurrenceKey({
        type: pending.type,
        date: pending.date,
        sourceRecurringExpenseId: pending.source_recurring_expense_id || null,
        sourceRecurringIncomeId: pending.source_recurring_income_id || null,
        sourceOneOffId: pending.source_one_off_id || null,
        sourceFlexId: pending.source_flex_id || null,
        sourceGoalId: pending.source_goal_id || null,
        rowId: pending.id
      });

      const existingOccurrence = pendingRows.find(row =>
        row.occurrence_key === nextOccurrenceKey
        && row.id !== id
      );

      if (existingOccurrence) {
        throw badRequest("Another pending transaction already exists for this occurrence");
      }

      if (pending.source_one_off_id) {
        const oneOff = (await writer.listPlanningRows(userId, "one_off_transactions"))
          .find(row => row.id === pending.source_one_off_id) || null;
        if (oneOff) {
          const confirmedRows = await confirmedOneOffRowsAsync(userId, oneOff.id, writer);
          const confirmedAmount = confirmedOneOffOriginalAmountFromRows(
            confirmedRows,
            oneOff.currency,
            oneOff.type
          );
          await writer.updatePlanningRowsById(userId, "one_off_transactions", [{
            amount: addMoneyAmounts(confirmedAmount, nextAmount),
            date: nextDate,
            id: oneOff.id,
            name: nextName,
            updated_at: new Date().toISOString()
          }]);
        }
      }

      await writer.updatePlanningRowsById(userId, "pending_transactions", [{
        amount: nextAmount,
        currency: nextCurrency,
        date: nextDate,
        funded_amount: nextAmount,
        id,
        ledger_amount: ledgerAmount,
        name: nextName,
        occurrence_key: nextOccurrenceKey,
        requested_amount: nextAmount,
        updated_at: new Date().toISOString()
      }]);

      await recalculatePlanningRunningBalancesWithBudgetStore(writer, userId);
      return (await writer.listPlanningRows(userId, "pending_transactions"))
        .find(row => row.id === id);
    });

    return withProjectionStatus(userId, result, { preservePending: true });
  }

  function createGoal(userId, input) {
    input = validatePlanMutationInput("goal", input, { create: true });
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return createGoalWithBudgetStore(userId, input);
    }

    let result;

    const db = openPlanningDb(userId);
    try {
      result = db.transaction(() => {
        const id = generateId("goal");
        const plannedTxId = insertPlannedTransaction(db, "goal", input.priority);
        const amount = input.amount ?? 0.01;

        db.prepare(`
          INSERT INTO goals (
            id, name, currency, amount, active, due_date, planned_transaction_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          input.name || "Unnamed",
          requireSupportedCurrency(input.currency || "PLN"),
          amount,
          input.active ?? 1,
          requireDateOrDefault(input.due_date, todayForUser(db), "due_date"),
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

  async function createGoalWithBudgetStore(userId, input) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const settings = (await writer.listPlanningRows(userId, "settings"))?.[0] || {};
      const id = generateId("goal");
      const plannedTxId = await insertPlannedTransactionWithBudgetStore(writer, userId, "goal", input.priority);
      const amount = input.amount ?? 0.01;
      const timestamp = new Date().toISOString();

      await writer.insertPlanningRows(userId, "goals", [{
        active: input.active ?? 1,
        amount,
        created_at: timestamp,
        currency: requireSupportedCurrency(input.currency || "PLN"),
        due_date: requireDateOrDefault(
          input.due_date,
          todayInTimezone(settings.timezone || DEFAULT_TIMEZONE),
          "due_date"
        ),
        id,
        name: input.name || "Unnamed",
        planned_transaction_id: plannedTxId,
        updated_at: timestamp
      }]);

      const row = (await writer.listPlanningRows(userId, "goals"))
        .find(candidate => candidate.id === id);
      return await withPlanningPriority(writer, userId, row, "goal");
    });

    return withProjectionStatus(userId, result);
  }

  function updateGoal(userId, id, input) {
    input = validatePlanMutationInput("goal", input);
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return updateGoalWithBudgetStore(userId, id, input);
    }

    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const existing = db.prepare(`
          SELECT *
          FROM goals
          WHERE id = ?
        `).get(id);

        if (!existing) throw notFound("Goal not found");

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
          requireSupportedCurrency(merged.currency || "PLN"),
          merged.amount,
          merged.active,
          requireDateOrDefault(merged.due_date, todayForUser(db), "due_date"),
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

  async function updateGoalWithBudgetStore(userId, id, input) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const existing = (await writer.listPlanningRows(userId, "goals"))
        .find(row => row.id === id) || null;

      if (!existing) throw notFound("Goal not found");

      const settings = (await writer.listPlanningRows(userId, "settings"))?.[0] || {};
      const merged = {
        ...existing,
        ...(input || {})
      };

      if (input.priority !== undefined) {
        await updatePlannedPriorityWithBudgetStore(
          writer,
          userId,
          existing.planned_transaction_id,
          "goal",
          input.priority
        );
      }

      await writer.updatePlanningRowsById(userId, "goals", [{
        active: merged.active,
        amount: merged.amount,
        currency: requireSupportedCurrency(merged.currency || "PLN"),
        due_date: requireDateOrDefault(
          merged.due_date,
          todayInTimezone(settings.timezone || DEFAULT_TIMEZONE),
          "due_date"
        ),
        id,
        name: merged.name || "Unnamed",
        updated_at: new Date().toISOString()
      }]);

      const row = (await writer.listPlanningRows(userId, "goals"))
        .find(candidate => candidate.id === id);
      return await withPlanningPriority(writer, userId, row, "goal");
    });

    return withProjectionStatus(userId, result);
  }

  function deleteGoalPlanningSource(userId, id) {
    const db = openPlanningDb(userId);
    try {
      db.transaction(() => {
        const goal = db.prepare(`
          SELECT planned_transaction_id
          FROM goals
          WHERE id = ?
        `).get(id);

        if (!goal) throw notFound("Goal not found");

        db.prepare("DELETE FROM pending_transactions WHERE source_goal_id = ?").run(id);
        db.prepare("DELETE FROM future_transactions WHERE source_goal_id = ?").run(id);
        db.prepare("DELETE FROM goals WHERE id = ?").run(id);
        db.prepare("DELETE FROM planned_transactions WHERE id = ?").run(goal.planned_transaction_id);
        recalculatePlanningRunningBalances(db, userId);
      })();
    } finally {
      db.close();
    }
  }

  async function deleteGoalPlanningSourceWithBudgetStore(writer, userId, id) {
    const goal = (await writer.listPlanningRows(userId, "goals"))
      .find(row => row.id === id) || null;

    if (!goal) throw notFound("Goal not found");

    const pendingIds = (await writer.listPlanningRows(userId, "pending_transactions"))
      .filter(row => row.source_goal_id === id)
      .map(row => row.id);
    const futureIds = (await writer.listPlanningRows(userId, "future_transactions"))
      .filter(row => row.source_goal_id === id)
      .map(row => row.id);

    if (pendingIds.length) {
      await writer.deletePlanningRowsById(userId, "pending_transactions", pendingIds);
    }
    if (futureIds.length) {
      await writer.deletePlanningRowsById(userId, "future_transactions", futureIds);
    }
    await writer.deletePlanningRowsById(userId, "goals", [id]);
    await writer.deletePlanningRowsById(userId, "planned_transactions", [goal.planned_transaction_id]);
  }

  async function deleteGoal(userId, id) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return deleteGoalWithBudgetStore(userId, id);
    }

    const db = openPlanningDb(userId);
    let goal;
    let confirmedRows = [];
    let confirmedAmount = 0;

    try {
      goal = db.prepare(`
        SELECT *
        FROM goals
        WHERE id = ?
      `).get(id);

      if (!goal) throw notFound("Goal not found");
      confirmedRows = confirmedGoalRows(userId, id);
      confirmedAmount = confirmedGoalOriginalAmount(userId, id, goal.currency);
    } finally {
      db.close();
    }

    if (!confirmedRows.length) {
      deleteGoalPlanningSource(userId, id);
      return withProjectionStatus(userId, { ok: true });
    }

    if (confirmedAmount + 0.0001 < Number(goal.amount || 0)) {
      throw badRequest("Cannot delete confirmed goal transaction until it is fully funded");
    }

    return runRecoverableUserMutation(userId, "delete_funded_goal", async () => {
      uncoupleConfirmedGoalRows(userId, id);
      deleteGoalPlanningSource(userId, id);
      return withProjectionStatus(userId, { ok: true });
    });

  }

  async function deleteGoalWithBudgetStore(userId, id) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const goal = (await writer.listPlanningRows(userId, "goals"))
        .find(row => row.id === id) || null;
      if (!goal) throw notFound("Goal not found");

      const confirmedRows = await confirmedGoalRowsAsync(userId, id, writer);
      if (!confirmedRows.length) {
        await deleteGoalPlanningSourceWithBudgetStore(writer, userId, id);
        await recalculatePlanningRunningBalancesWithBudgetStore(writer, userId);
        return { ok: true };
      }

      const confirmedAmount = confirmedGoalOriginalAmountFromRows(confirmedRows, goal.currency);
      if (confirmedAmount + 0.0001 < Number(goal.amount || 0)) {
        throw badRequest("Cannot delete confirmed goal transaction until it is fully funded");
      }

      const byYear = new Map();
      const timestamp = new Date().toISOString();
      for (const row of confirmedRows) {
        const year = Number(row.ledger_year);
        const updates = byYear.get(year) || [];
        updates.push({
          id: row.id,
          source_goal_id: null,
          updated_at: timestamp
        });
        byYear.set(year, updates);
      }

      for (const [year, updates] of byYear.entries()) {
        await writer.updateConfirmedTransactionsById(userId, year, updates);
      }

      await deleteGoalPlanningSourceWithBudgetStore(writer, userId, id);
      await recalculatePlanningRunningBalancesWithBudgetStore(writer, userId);
      return { ok: true };
    });

    return withProjectionStatus(userId, result);
  }

  function createFlexTransaction(userId, input) {
    input = validatePlanMutationInput("flex", input, { create: true });
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return createFlexTransactionWithBudgetStore(userId, input);
    }

    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const id = generateId("flex");
        const plannedTxId = insertPlannedTransaction(db, "flex", input.priority);

        const allowSplit = input.allow_split ?? 0;
        const minAmount = allowSplit ? input.min_amount ?? null : null;
        const maxAmount = allowSplit ? input.max_amount ?? null : null;

        if (allowSplit && minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
          throw badRequest("Flex min amount cannot be greater than max amount");
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
          requireSupportedCurrency(input.currency || "PLN"),
          input.amount ?? 0,
          input.active ?? 1,
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

  async function createFlexTransactionWithBudgetStore(userId, input) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const id = generateId("flex");
      const plannedTxId = await insertPlannedTransactionWithBudgetStore(writer, userId, "flex", input.priority);
      const allowSplit = input.allow_split ?? 0;
      const minAmount = allowSplit ? input.min_amount ?? null : null;
      const maxAmount = allowSplit ? input.max_amount ?? null : null;

      if (allowSplit && minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
        throw badRequest("Flex min amount cannot be greater than max amount");
      }

      const timestamp = new Date().toISOString();
      await writer.insertPlanningRows(userId, "flex_transactions", [{
        active: input.active ?? 1,
        allow_split: allowSplit,
        amount: input.amount ?? 0,
        created_at: timestamp,
        currency: requireSupportedCurrency(input.currency || "PLN"),
        id,
        max_amount: maxAmount,
        min_amount: minAmount,
        name: input.name || "Unnamed",
        planned_transaction_id: plannedTxId,
        updated_at: timestamp
      }]);

      const row = (await writer.listPlanningRows(userId, "flex_transactions"))
        .find(candidate => candidate.id === id);
      return await withPlanningPriority(writer, userId, row, "operating");
    });

    return withProjectionStatus(userId, result);
  }

  function updateFlexTransaction(userId, id, input = {}) {
    input = validatePlanMutationInput("flex", input);
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return updateFlexTransactionWithBudgetStore(userId, id, input);
    }

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
          throw notFound("Flex transaction not found");
        }

        const merged = {
          ...existing,
          ...input
        };

        if (Object.prototype.hasOwnProperty.call(input, "priority")) {
          updatePlannedPriority(db, existing.planned_transaction_id, "operating", input.priority);
        }

        const allowSplit = merged.allow_split;

        // Important:
        // If allow_split is true, use the values supplied in the request, even if they are empty strings.
        // Empty string means "clear this value", not "keep the old value".
        const minSource = Object.prototype.hasOwnProperty.call(input, "min_amount")
          ? input.min_amount
          : existing.min_amount;

        const maxSource = Object.prototype.hasOwnProperty.call(input, "max_amount")
          ? input.max_amount
          : existing.max_amount;

        const minAmount = allowSplit ? minSource ?? null : null;
        const maxAmount = allowSplit ? maxSource ?? null : null;

        if (allowSplit && minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
          throw badRequest("Flex min amount cannot be greater than max amount");
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
          requireSupportedCurrency(merged.currency || "PLN"),
          merged.amount,
          merged.active,
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

  async function updateFlexTransactionWithBudgetStore(userId, id, input = {}) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const existing = (await writer.listPlanningRows(userId, "flex_transactions"))
        .find(row => row.id === id) || null;

      if (!existing) {
        throw notFound("Flex transaction not found");
      }

      const merged = {
        ...existing,
        ...input
      };

      if (Object.prototype.hasOwnProperty.call(input, "priority")) {
        await updatePlannedPriorityWithBudgetStore(
          writer,
          userId,
          existing.planned_transaction_id,
          "operating",
          input.priority
        );
      }

      const allowSplit = merged.allow_split;
      const minSource = Object.prototype.hasOwnProperty.call(input, "min_amount")
        ? input.min_amount
        : existing.min_amount;
      const maxSource = Object.prototype.hasOwnProperty.call(input, "max_amount")
        ? input.max_amount
        : existing.max_amount;
      const minAmount = allowSplit ? minSource ?? null : null;
      const maxAmount = allowSplit ? maxSource ?? null : null;

      if (allowSplit && minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
        throw badRequest("Flex min amount cannot be greater than max amount");
      }

      await writer.updatePlanningRowsById(userId, "flex_transactions", [{
        active: merged.active,
        allow_split: allowSplit,
        amount: merged.amount,
        currency: requireSupportedCurrency(merged.currency || "PLN"),
        id,
        max_amount: maxAmount,
        min_amount: minAmount,
        name: merged.name || "Unnamed",
        updated_at: new Date().toISOString()
      }]);

      const row = (await writer.listPlanningRows(userId, "flex_transactions"))
        .find(candidate => candidate.id === id);
      return await withPlanningPriority(writer, userId, row, "operating");
    });

    return withProjectionStatus(userId, result);
  }

  function deleteFlexTransaction(userId, id) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return deleteFlexTransactionWithBudgetStore(userId, id);
    }

    const isConfirmed = loadAllConfirmedTransactions(userId)
      .some(tx => tx.source_flex_id === id);

    if (isConfirmed) {
      throw badRequest("Cannot delete confirmed flex transaction");
    }

    const db = openPlanningDb(userId);
    try {
      db.transaction(() => {
        const flex = db.prepare(`
          SELECT planned_transaction_id
          FROM flex_transactions
          WHERE id = ?
        `).get(id);

        if (!flex) throw notFound("Flex transaction not found");

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

  async function deleteRecurringIncomeWithBudgetStore(userId, id, options = {}) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const existing = (await writer.listPlanningRows(userId, "recurring_incomes"))
        .find(row => row.id === id) || null;
      if (!existing) throw notFound("Recurring income not found");

      const dependents = (await writer.listPlanningRows(userId, "recurring_expenses"))
        .filter(row => row.anchor_income_id === id);

      if (dependents.length) {
        const reassignToIncomeId = options.reassignAnchorsToIncomeId || null;
        const fallbackToFixedDay = Boolean(options.fallbackAnchorsToFixedDay);

        if (!reassignToIncomeId && !fallbackToFixedDay) {
          throw conflict(
            "This income anchors other recurring expenses; reassign or convert them before deleting",
            {
              anchorDependents: dependents.map(dep => ({ id: dep.id, name: dep.name }))
            }
          );
        }

        if (reassignToIncomeId) {
          if (reassignToIncomeId === id) {
            throw badRequest("Cannot reassign to the income being deleted", [{
              field: "reassignAnchorsToIncomeId",
              reason: "same_as_deleted"
            }]);
          }
          const replacement = (await writer.listPlanningRows(userId, "recurring_incomes"))
            .find(row => row.id === reassignToIncomeId);
          if (!replacement) {
            throw badRequest("Reassignment income not found", [{
              field: "reassignAnchorsToIncomeId",
              reason: "not_found"
            }]);
          }

          await writer.updatePlanningRowsById(userId, "recurring_expenses", dependents.map(dep => ({
            id: dep.id,
            anchor_income_id: reassignToIncomeId,
            updated_at: new Date().toISOString()
          })));
        } else {
          const settings = (await writer.listPlanningRows(userId, "settings"))?.[0] || {};
          const today = todayInTimezone(settings.timezone || DEFAULT_TIMEZONE);

          const updates = dependents.map(dependent => ({
            id: dependent.id,
            anchor_income_id: null,
            anchor_type: "day_of_month",
            anchor_day_of_month: fallbackAnchorDayForDependent(dependent, existing, today),
            anchor_offset_days: 0,
            updated_at: new Date().toISOString()
          }));

          await writer.updatePlanningRowsById(userId, "recurring_expenses", updates);
        }
      }

      const pendingIds = (await writer.listPlanningRows(userId, "pending_transactions"))
        .filter(row => row.source_recurring_income_id === id)
        .map(row => row.id);
      const futureIds = (await writer.listPlanningRows(userId, "future_transactions"))
        .filter(row => row.source_recurring_income_id === id)
        .map(row => row.id);

      if (pendingIds.length) {
        await writer.deletePlanningRowsById(userId, "pending_transactions", pendingIds);
      }
      if (futureIds.length) {
        await writer.deletePlanningRowsById(userId, "future_transactions", futureIds);
      }
      await clearBudgetPeriodIncomeIfSelectedWithBudgetStore(writer, userId, id);
      await writer.deletePlanningRowsById(userId, "recurring_incomes", [id]);
      await recalculatePlanningRunningBalancesWithBudgetStore(writer, userId);

      return { ok: true };
    });

    return withProjectionStatus(userId, result);
  }

  async function deleteRecurringExpenseWithBudgetStore(userId, id) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const expense = (await writer.listPlanningRows(userId, "recurring_expenses"))
        .find(row => row.id === id) || null;

      if (!expense) throw notFound("Recurring expense not found");

      const pendingIds = (await writer.listPlanningRows(userId, "pending_transactions"))
        .filter(row => row.source_recurring_expense_id === id)
        .map(row => row.id);
      const futureIds = (await writer.listPlanningRows(userId, "future_transactions"))
        .filter(row => row.source_recurring_expense_id === id)
        .map(row => row.id);

      if (pendingIds.length) {
        await writer.deletePlanningRowsById(userId, "pending_transactions", pendingIds);
      }
      if (futureIds.length) {
        await writer.deletePlanningRowsById(userId, "future_transactions", futureIds);
      }
      await writer.deletePlanningRowsById(userId, "recurring_expenses", [id]);
      await writer.deletePlanningRowsById(userId, "planned_transactions", [expense.planned_transaction_id]);
      await recalculatePlanningRunningBalancesWithBudgetStore(writer, userId);

      return { ok: true };
    });

    return withProjectionStatus(userId, result);
  }

  async function deleteFlexTransactionWithBudgetStore(userId, id) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const isConfirmed = (await writer.listConfirmedTransactions(userId))
        .some(tx => tx.source_flex_id === id);

      if (isConfirmed) {
        throw badRequest("Cannot delete confirmed flex transaction");
      }

      const flex = (await writer.listPlanningRows(userId, "flex_transactions"))
        .find(row => row.id === id) || null;

      if (!flex) throw notFound("Flex transaction not found");

      const pendingIds = (await writer.listPlanningRows(userId, "pending_transactions"))
        .filter(row => row.source_flex_id === id)
        .map(row => row.id);
      const futureIds = (await writer.listPlanningRows(userId, "future_transactions"))
        .filter(row => row.source_flex_id === id)
        .map(row => row.id);

      if (pendingIds.length) {
        await writer.deletePlanningRowsById(userId, "pending_transactions", pendingIds);
      }
      if (futureIds.length) {
        await writer.deletePlanningRowsById(userId, "future_transactions", futureIds);
      }
      await writer.deletePlanningRowsById(userId, "flex_transactions", [id]);
      await writer.deletePlanningRowsById(userId, "planned_transactions", [flex.planned_transaction_id]);
      await recalculatePlanningRunningBalancesWithBudgetStore(writer, userId);

      return { ok: true };
    });

    return withProjectionStatus(userId, result);
  }

  function createOneOffTransaction(userId, input) {
    input = validatePlanMutationInput("one-off", input, { create: true });
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return createOneOffTransactionWithBudgetStore(userId, input);
    }

    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const id = generateId("oneoff");

        db.prepare(`
          INSERT INTO one_off_transactions (
            id, name, currency, amount, type, date, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          input.name || "Unnamed",
          requireSupportedCurrency(input.currency || "PLN"),
          input.amount ?? 0,
          input.type || "expense",
          requireDateOrDefault(input.date, todayForUser(db))
        );

        return db.prepare("SELECT * FROM one_off_transactions WHERE id = ?").get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  async function createOneOffTransactionWithBudgetStore(userId, input) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const settings = (await writer.listPlanningRows(userId, "settings"))?.[0] || {};
      const id = generateId("oneoff");
      const timestamp = new Date().toISOString();
      const row = {
        amount: input.amount ?? 0,
        created_at: timestamp,
        currency: requireSupportedCurrency(input.currency || "PLN"),
        date: requireDateOrDefault(
          input.date,
          todayInTimezone(settings.timezone || DEFAULT_TIMEZONE)
        ),
        id,
        name: input.name || "Unnamed",
        type: input.type || "expense",
        updated_at: timestamp
      };

      await writer.insertPlanningRows(userId, "one_off_transactions", [row]);
      return (await writer.listPlanningRows(userId, "one_off_transactions"))
        .find(candidate => candidate.id === id) || row;
    });

    return withProjectionStatus(userId, result);
  }

  function updateOneOffTransaction(userId, id, input) {
    input = validatePlanMutationInput("one-off", input);
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return updateOneOffTransactionWithBudgetStore(userId, id, input);
    }

    let result;

    const db = openPlanningDb(userId);

    try {
      result = db.transaction(() => {
        const existing = db.prepare("SELECT * FROM one_off_transactions WHERE id = ?").get(id);
        if (!existing) throw notFound("One-off transaction not found");

        const confirmedRows = confirmedOneOffRows(userId, id);
        const nextCurrency = requireSupportedCurrency(input.currency || existing.currency || "PLN");
        const nextType = input.type || existing.type;
        const nextAmount = input.amount ?? existing.amount;

        if (confirmedRows.length) {
          const existingCurrency = requireSupportedCurrency(existing.currency || "PLN");
          const existingType = ["income", "expense"].includes(existing.type) ? existing.type : "expense";

          if (nextCurrency !== existingCurrency) {
            throw badRequest("Cannot change currency for a one-off transaction with confirmed ledger history");
          }

          if (nextType !== existingType) {
            throw badRequest("Cannot change type for a one-off transaction with confirmed ledger history");
          }

          const confirmedAmount = confirmedOneOffOriginalAmount(userId, id, existingCurrency, existingType);
          if (nextAmount + 0.0001 < confirmedAmount) {
            throw badRequest("One-off transaction amount cannot be lower than the already confirmed amount");
          }
        }

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
          nextCurrency,
          nextAmount,
          nextType,
          requireDateOrDefault(input.date || existing.date, todayForUser(db)),
          id
        );

        return db.prepare("SELECT * FROM one_off_transactions WHERE id = ?").get(id);
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  function deleteOneOffPlanningSource(userId, id) {
    const db = openPlanningDb(userId);
    try {
      db.transaction(() => {
        db.prepare("DELETE FROM pending_transactions WHERE source_one_off_id = ?").run(id);
        db.prepare("DELETE FROM future_transactions WHERE source_one_off_id = ?").run(id);
        db.prepare("DELETE FROM one_off_transactions WHERE id = ?").run(id);
        recalculatePlanningRunningBalances(db, userId);
      })();
    } finally {
      db.close();
    }
  }

  async function deleteOneOffPlanningSourceWithBudgetStore(writer, userId, id) {
    const pendingIds = (await writer.listPlanningRows(userId, "pending_transactions"))
      .filter(row => row.source_one_off_id === id)
      .map(row => row.id);
    const futureIds = (await writer.listPlanningRows(userId, "future_transactions"))
      .filter(row => row.source_one_off_id === id)
      .map(row => row.id);

    if (pendingIds.length) {
      await writer.deletePlanningRowsById(userId, "pending_transactions", pendingIds);
    }
    if (futureIds.length) {
      await writer.deletePlanningRowsById(userId, "future_transactions", futureIds);
    }

    await writer.deletePlanningRowsById(userId, "one_off_transactions", [id]);
  }

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

  function dismissPendingOneOffRemainder(userId, id) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return dismissPendingOneOffRemainderWithBudgetStore(userId, id);
    }

    const db = openPlanningDb(userId);
    let result;

    try {
      const pending = db.prepare("SELECT * FROM pending_transactions WHERE id = ?").get(id);
      if (!pending) throw notFound("Pending transaction not found");

      const oneOffId = pending.source_one_off_id;
      const expectedPrefix = `one_off_remainder:${oneOffId}:`;
      if (!oneOffId || !String(pending.occurrence_key || "").startsWith(expectedPrefix)) {
        throw badRequest("Only a generated one-off remainder can be dismissed");
      }

      const oneOff = db.prepare("SELECT * FROM one_off_transactions WHERE id = ?").get(oneOffId);
      if (!oneOff) throw notFound("One-off transaction not found");

      const confirmedAmount = confirmedOneOffOriginalAmount(
        userId,
        oneOff.id,
        oneOff.currency,
        oneOff.type
      );
      if (confirmedAmount <= 0) {
        throw badRequest("One-off remainder cannot be dismissed without confirmed history");
      }

      result = db.transaction(() => {
        db.prepare(`
          UPDATE one_off_transactions
          SET amount = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(confirmedAmount, oneOff.id);
        db.prepare("DELETE FROM pending_transactions WHERE source_one_off_id = ?").run(oneOff.id);
        db.prepare("DELETE FROM future_transactions WHERE source_one_off_id = ?").run(oneOff.id);
        recalculatePlanningRunningBalances(db, userId);

        return {
          ok: true,
          dismissedPendingId: id,
          oneOff: db.prepare("SELECT * FROM one_off_transactions WHERE id = ?").get(oneOff.id)
        };
      })();
    } finally {
      db.close();
    }

    return withProjectionStatus(userId, result);
  }

  async function dismissPendingOneOffRemainderWithBudgetStore(userId, id) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const pending = (await writer.listPlanningRows(userId, "pending_transactions"))
        .find(row => row.id === id) || null;
      if (!pending) throw notFound("Pending transaction not found");

      const oneOffId = pending.source_one_off_id;
      const expectedPrefix = `one_off_remainder:${oneOffId}:`;
      if (!oneOffId || !String(pending.occurrence_key || "").startsWith(expectedPrefix)) {
        throw badRequest("Only a generated one-off remainder can be dismissed");
      }

      const oneOff = (await writer.listPlanningRows(userId, "one_off_transactions"))
        .find(row => row.id === oneOffId) || null;
      if (!oneOff) throw notFound("One-off transaction not found");

      const confirmedRows = await confirmedOneOffRowsAsync(userId, oneOff.id, writer);
      const confirmedAmount = confirmedOneOffOriginalAmountFromRows(
        confirmedRows,
        oneOff.currency,
        oneOff.type
      );
      if (confirmedAmount <= 0) {
        throw badRequest("One-off remainder cannot be dismissed without confirmed history");
      }

      const pendingIds = (await writer.listPlanningRows(userId, "pending_transactions"))
        .filter(row => row.source_one_off_id === oneOff.id)
        .map(row => row.id);
      const futureIds = (await writer.listPlanningRows(userId, "future_transactions"))
        .filter(row => row.source_one_off_id === oneOff.id)
        .map(row => row.id);

      await writer.updatePlanningRowsById(userId, "one_off_transactions", [{
        amount: confirmedAmount,
        id: oneOff.id,
        updated_at: new Date().toISOString()
      }]);

      if (pendingIds.length) {
        await writer.deletePlanningRowsById(userId, "pending_transactions", pendingIds);
      }
      if (futureIds.length) {
        await writer.deletePlanningRowsById(userId, "future_transactions", futureIds);
      }

      await recalculatePlanningRunningBalancesWithBudgetStore(writer, userId);
      const updatedOneOff = (await writer.listPlanningRows(userId, "one_off_transactions"))
        .find(row => row.id === oneOff.id) || {
          ...oneOff,
          amount: confirmedAmount
        };

      return {
        ok: true,
        dismissedPendingId: id,
        oneOff: updatedOneOff
      };
    });

    return withProjectionStatus(userId, result);
  }

  async function updateOneOffTransactionWithBudgetStore(userId, id, input) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const existing = (await writer.listPlanningRows(userId, "one_off_transactions"))
        .find(row => row.id === id) || null;
      if (!existing) throw notFound("One-off transaction not found");

      const settings = (await writer.listPlanningRows(userId, "settings"))?.[0] || {};
      const confirmedRows = await confirmedOneOffRowsAsync(userId, id, writer);
      const nextCurrency = requireSupportedCurrency(input.currency || existing.currency || "PLN");
      const nextType = input.type || existing.type;
      const nextAmount = input.amount ?? existing.amount;

      if (confirmedRows.length) {
        const existingCurrency = requireSupportedCurrency(existing.currency || "PLN");
        const existingType = ["income", "expense"].includes(existing.type) ? existing.type : "expense";

        if (nextCurrency !== existingCurrency) {
          throw badRequest("Cannot change currency for a one-off transaction with confirmed ledger history");
        }

        if (nextType !== existingType) {
          throw badRequest("Cannot change type for a one-off transaction with confirmed ledger history");
        }

        const confirmedAmount = confirmedOneOffOriginalAmountFromRows(confirmedRows, existingCurrency, existingType);
        if (nextAmount + 0.0001 < confirmedAmount) {
          throw badRequest("One-off transaction amount cannot be lower than the already confirmed amount");
        }
      }

      await writer.updatePlanningRowsById(userId, "one_off_transactions", [{
        amount: nextAmount,
        currency: nextCurrency,
        date: requireDateOrDefault(
          input.date || existing.date,
          todayInTimezone(settings.timezone || DEFAULT_TIMEZONE)
        ),
        id,
        name: input.name || existing.name || "Unnamed",
        type: nextType,
        updated_at: new Date().toISOString()
      }]);

      return (await writer.listPlanningRows(userId, "one_off_transactions"))
        .find(candidate => candidate.id === id);
    });

    return withProjectionStatus(userId, result);
  }

  async function deleteOneOffTransaction(userId, id) {
    if (budgetStore?.backend === "postgres" && typeof budgetStore.transaction === "function") {
      return deleteOneOffTransactionWithBudgetStore(userId, id);
    }

    const db = openPlanningDb(userId);
    let confirmedRows = [];
    try {
      const existing = db.prepare("SELECT * FROM one_off_transactions WHERE id = ?").get(id);
      if (!existing) throw notFound("One-off transaction not found");
      confirmedRows = confirmedOneOffRows(userId, id);
    } finally {
      db.close();
    }

    if (!confirmedRows.length) {
      deleteOneOffPlanningSource(userId, id);
      return withProjectionStatus(userId, { ok: true });
    }

    return runRecoverableUserMutation(userId, "delete_confirmed_one_off", async () => {
      uncoupleConfirmedOneOffRows(userId, id);
      deleteOneOffPlanningSource(userId, id);
      return withProjectionStatus(userId, { ok: true });
    });
  }

  async function deleteOneOffTransactionWithBudgetStore(userId, id) {
    const result = await budgetStore.transaction(async writer => {
      if (typeof writer.lockBudgetLedger === "function") {
        await writer.lockBudgetLedger(userId);
      }
      const existing = (await writer.listPlanningRows(userId, "one_off_transactions"))
        .find(row => row.id === id) || null;
      if (!existing) throw notFound("One-off transaction not found");

      const confirmedRows = await confirmedOneOffRowsAsync(userId, id, writer);
      if (confirmedRows.length) {
        const byYear = new Map();
        const timestamp = new Date().toISOString();
        for (const row of confirmedRows) {
          const year = Number(row.ledger_year);
          const updates = byYear.get(year) || [];
          updates.push({
            id: row.id,
            source_one_off_id: null,
            updated_at: timestamp
          });
          byYear.set(year, updates);
        }

        for (const [year, updates] of byYear.entries()) {
          await writer.updateConfirmedTransactionsById(userId, year, updates);
        }
      }

      await deleteOneOffPlanningSourceWithBudgetStore(writer, userId, id);
      await recalculatePlanningRunningBalancesWithBudgetStore(writer, userId);
      return { ok: true };
    });

    return withProjectionStatus(userId, result);
  }

  return {
    createFlexTransaction,
    createGoal,
    createOneOffTransaction,
    createRecurringExpense,
    createRecurringIncome,
    dismissPendingOneOffRemainder,
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
