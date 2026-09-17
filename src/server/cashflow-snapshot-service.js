import { DEFAULT_FUTURE_PERIODS, DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { recurringOccurrencesInPeriod, todayInTimezone } from "./cashflow-date-utils.js";
import {
  addMoneyAmounts,
  getBufferedFxForCurrency,
  multiplyMoney,
  normalizeCurrency,
  roundMoneyAmount,
  subtractMoneyAmounts
} from "./cashflow-money-utils.js";
import {
  normalizeFxCurrencyList,
  normalizeFxProvider,
  normalizeManualFxPairs,
  normalizeManualFxRates
} from "./cashflow-fx-provider-utils.js";
import { periodAnchorOverridesForIncome } from "./cashflow-period-utils.js";

export function createCashflowSnapshotService({
  budgetStore = null,
  buildBudgetPeriods,
  buildPeriodSummariesFromDefinitions,
  confirmedFundingTotals = null,
  confirmedFundingTotalsAsync = null,
  getCachedFxSnapshot,
  getCachedFxSnapshotAsync = null,
  confirmedRowsForPrediction = null,
  listAvailableLocales = () => [{ id: "en", label: "English" }],
  loadAllConfirmedTransactions,
  loadAllConfirmedTransactionsAsync = null,
  openPlanningDb,
  predictedAmountForRecurringExpense = (_userId, expense) => Number(expense?.amount || 0),
  predictedAmountForRecurringExpenseAsync = null,
  safeGetCurrentFxSnapshot,
  safeGetCurrentFxSnapshotAsync = null,
  sumConfirmedFunding
}) {
  function validFundingSourceColumn(sourceColumn) {
    if (!["source_flex_id", "source_goal_id"].includes(sourceColumn)) {
      return null;
    }
    return sourceColumn;
  }

  function generatedFundingRows(rows = [], sourceColumn, sourceId, ledgerCurrency = "PLN") {
    const safeSourceColumn = validFundingSourceColumn(sourceColumn);
    if (!safeSourceColumn) return [];

    return (rows || []).filter(row =>
      row?.[safeSourceColumn] === sourceId
        && Number(row?.ledger_amount || 0) > 0
        && String(row?.ledger_currency || "PLN") === ledgerCurrency
    );
  }

  function latestFundingDateFromRows(rows = [], sourceColumn, sourceId, ledgerCurrency = "PLN") {
    return generatedFundingRows(rows, sourceColumn, sourceId, ledgerCurrency)
      .map(row => row.date)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
  }

  function sumGeneratedFundingFromRows(rows = [], sourceColumn, sourceId, ledgerCurrency = "PLN") {
    return generatedFundingRows(rows, sourceColumn, sourceId, ledgerCurrency)
      .reduce((total, row) => addMoneyAmounts(total, row.ledger_amount || 0), 0);
  }

  function summarizeRecurringExpenseOccurrences(db, expense, periods, today) {
    const expectedDates = [];

    for (const period of periods || []) {
      for (const date of recurringOccurrencesInPeriod(expense, period, today)) {
        expectedDates.push(date);
      }
    }

    const uniqueExpectedDates = [...new Set(expectedDates)].sort();

    let funded = 0;
    let partial = 0;
    let underfunded = 0;
    let skipped = 0;

    const generatedByDate = new Map();

    const generatedRows = db.prepare(`
      SELECT date, status
      FROM future_transactions
      WHERE source_recurring_expense_id = ?

      UNION ALL

      SELECT date, status
      FROM pending_transactions
      WHERE source_recurring_expense_id = ?
    `).all(expense.id, expense.id);

    for (const row of generatedRows) {
      if (!generatedByDate.has(row.date)) {
        generatedByDate.set(row.date, []);
      }

      generatedByDate.get(row.date).push(row.status || "funded");
    }

    for (const date of uniqueExpectedDates) {
      const statuses = generatedByDate.get(date) || [];

      if (!statuses.length) {
        skipped += 1;
        continue;
      }

      if (statuses.includes("underfunded")) {
        underfunded += 1;
      } else if (statuses.includes("partial")) {
        partial += 1;
      } else {
        funded += 1;
      }
    }

    return {
      occurrence_total: uniqueExpectedDates.length,
      occurrence_funded_count: funded,
      occurrence_partial_count: partial,
      occurrence_underfunded_count: underfunded,
      occurrence_skipped_count: skipped,
      occurrence_summary: `${funded}/${uniqueExpectedDates.length}`
    };
  }

  function summarizeRecurringExpenseOccurrencesFromRows(expense, periods, today, generatedRows = []) {
    const expectedDates = [];

    for (const period of periods || []) {
      for (const date of recurringOccurrencesInPeriod(expense, period, today)) {
        expectedDates.push(date);
      }
    }

    const uniqueExpectedDates = [...new Set(expectedDates)].sort();
    let funded = 0;
    let partial = 0;
    let underfunded = 0;
    let skipped = 0;
    const generatedByDate = new Map();

    for (const row of generatedRows || []) {
      if (row?.source_recurring_expense_id !== expense.id) continue;
      if (!generatedByDate.has(row.date)) {
        generatedByDate.set(row.date, []);
      }
      generatedByDate.get(row.date).push(row.status || "funded");
    }

    for (const date of uniqueExpectedDates) {
      const statuses = generatedByDate.get(date) || [];

      if (!statuses.length) {
        skipped += 1;
        continue;
      }

      if (statuses.includes("underfunded")) {
        underfunded += 1;
      } else if (statuses.includes("partial")) {
        partial += 1;
      } else {
        funded += 1;
      }
    }

    return {
      occurrence_total: uniqueExpectedDates.length,
      occurrence_funded_count: funded,
      occurrence_partial_count: partial,
      occurrence_underfunded_count: underfunded,
      occurrence_skipped_count: skipped,
      occurrence_summary: `${funded}/${uniqueExpectedDates.length}`
    };
  }

  function asc(...fields) {
    return (a, b) => {
      for (const field of fields) {
        const compare = String(a?.[field] ?? "").localeCompare(String(b?.[field] ?? ""));
        if (compare !== 0) return compare;
      }
      return 0;
    };
  }

  function desc(...fields) {
    return (a, b) => {
      for (const field of fields) {
        const compare = String(b?.[field] ?? "").localeCompare(String(a?.[field] ?? ""));
        if (compare !== 0) return compare;
      }
      return 0;
    };
  }

  function attachPlanningPriority(rows = [], plannedTransactions = [], priorityColumn = "operating_priority") {
    const plannedById = new Map((plannedTransactions || []).map(row => [row.id, row]));
    return (rows || []).map(row => ({
      ...row,
      priority: plannedById.get(row.planned_transaction_id)?.[priorityColumn]
    }));
  }

  function latestImpossibleEventFromRows(eventRows = [], entityId) {
    return [...(eventRows || [])]
      .filter(row => row.action === "goal_impossible" && row.entity_id === entityId)
      .sort(desc("timestamp"))
      .at(0) || null;
  }

  function getSnapshot(userId) {
    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();
      const ledgerCurrency = settings?.ledger_currency || "PLN";
      const fxSnapshot = safeGetCurrentFxSnapshot(userId) || getCachedFxSnapshot(userId);
      const missingFxRates = new Set();

      const today = todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE);
      let predictionRows = null;
      const predictionRowsForRun = () => {
        if (!predictionRows) {
          predictionRows = typeof confirmedRowsForPrediction === "function"
            ? confirmedRowsForPrediction(userId, today)
            : null;
        }
        return predictionRows;
      };

      const safeConvertToLedger = (amount, currency, type = "expense") => {
        try {
          const rates = getBufferedFxForCurrency(currency, settings, fxSnapshot, type);

          return {
            ok: true,
            value: multiplyMoney(amount, rates.buffered),
            fx: rates.fx,
            buffered: rates.buffered,
            error: null
          };
        } catch (error) {
          const normalized = normalizeCurrency(currency);

          if (normalized !== ledgerCurrency) {
            missingFxRates.add(normalized);
          }

          return {
            ok: false,
            value: null,
            fx: null,
            buffered: null,
            error: error.message
          };
        }
      };

      const recurringIncomesRaw = db.prepare(`
        SELECT *
        FROM recurring_incomes
        ORDER BY anchor_day_of_month ASC
      `).all();

      const recurringIncomes = recurringIncomesRaw.map(income => {
        const amountLedger = safeConvertToLedger(income.amount, income.currency, "income");

        return {
          ...income,
          amount_ledger_amount: amountLedger.ok ? amountLedger.value : null,
          amount_fx_missing: !amountLedger.ok,
          amount_warning: amountLedger.ok ? null : amountLedger.error,
          ledger_currency: ledgerCurrency
        };
      });

      const pendingTransactions = db.prepare(`
        SELECT *
        FROM pending_transactions
        ORDER BY date ASC, created_at ASC, id ASC
      `).all();

      const rawConfirmedTransactions = loadAllConfirmedTransactions(userId);
      const periodAnchorOverrides = periodAnchorOverridesForIncome(
        settings?.budget_period_income_id,
        [
          ...rawConfirmedTransactions,
          ...pendingTransactions
        ]
      );

      const periods = buildBudgetPeriods(
        settings || {},
        recurringIncomes || [],
        today,
        Number(settings?.future_periods || DEFAULT_FUTURE_PERIODS),
        { anchorOverrides: periodAnchorOverrides }
      );

      const recurringExpensesRaw = db.prepare(`
        SELECT r.*, pt.operating_priority AS priority
        FROM recurring_expenses r
        JOIN planned_transactions pt ON pt.id = r.planned_transaction_id
        ORDER BY pt.operating_priority ASC
      `).all();

      const recurringExpenses = recurringExpensesRaw.map(expense => {
        const currentPrediction = roundMoneyAmount(predictedAmountForRecurringExpense(
          userId,
          expense,
          today,
          today,
          expense.prediction_strategy === "12month_max" ? predictionRowsForRun() : null
        ));
        const currentPredictionLedger = safeConvertToLedger(
          currentPrediction,
          expense.currency,
          "expense"
        );

        return {
          ...expense,
          active_status: Number(expense.active) === 1 ? "active" : "disabled",
          current_prediction_amount: currentPrediction,
          current_prediction_ledger_amount: currentPredictionLedger.ok
            ? currentPredictionLedger.value
            : null,
          current_prediction_fx_missing: !currentPredictionLedger.ok,
          current_prediction_warning: currentPredictionLedger.ok ? null : currentPredictionLedger.error,
          ...summarizeRecurringExpenseOccurrences(db, expense, periods, today)
        };
      });

      const futureTransactions = db.prepare(`
        SELECT *
        FROM future_transactions
        ORDER BY date ASC, period ASC, type DESC, created_at ASC, id ASC
      `).all();

      const generatedTransactions = [
        ...futureTransactions,
        ...pendingTransactions
      ];

      const oneOffsRaw = db.prepare(`
        SELECT *
        FROM one_off_transactions
        ORDER BY date DESC, created_at DESC, id DESC
      `).all();

      const oneOffs = oneOffsRaw.map(oneOff => {
        const amountLedger = safeConvertToLedger(
          oneOff.amount,
          oneOff.currency,
          oneOff.type === "income" ? "income" : "expense"
        );

        return {
          ...oneOff,
          amount_ledger_amount: amountLedger.ok ? amountLedger.value : null,
          amount_fx_missing: !amountLedger.ok,
          amount_warning: amountLedger.ok ? null : amountLedger.error,
          ledger_currency: ledgerCurrency
        };
      });

      const goals = db.prepare(`
        SELECT g.*, pt.goal_priority AS priority
        FROM goals g
        JOIN planned_transactions pt ON pt.id = g.planned_transaction_id
        ORDER BY pt.goal_priority ASC
      `).all();

      const flexTransactions = db.prepare(`
        SELECT f.*, pt.operating_priority AS priority
        FROM flex_transactions f
        JOIN planned_transactions pt ON pt.id = f.planned_transaction_id
        ORDER BY pt.operating_priority ASC
      `).all();

      const confirmedFunding = typeof confirmedFundingTotals === "function"
        ? confirmedFundingTotals(userId, ledgerCurrency, settings)
        : null;
      const confirmedGoalFundingFor = goalId => roundMoneyAmount(confirmedFunding
        ? confirmedFunding.source_goal_id.get(goalId)
        : sumConfirmedFunding(userId, "source_goal_id", goalId, ledgerCurrency, settings));
      const confirmedFlexFundingFor = flexId => roundMoneyAmount(confirmedFunding
        ? confirmedFunding.source_flex_id.get(flexId)
        : sumConfirmedFunding(userId, "source_flex_id", flexId, ledgerCurrency, settings));

      const confirmedTransactions = rawConfirmedTransactions
        .map(tx => ({
          ...tx,
          ledger_year: tx.ledger_year || String(tx.date || "").slice(0, 4),
          ledger_currency: tx.ledger_currency || ledgerCurrency,
          requested_amount: tx.requested_amount ?? tx.amount,
          funded_amount: tx.funded_amount ?? tx.amount,
          ledger_amount:
            tx.ledger_amount !== null && tx.ledger_amount !== undefined
              ? roundMoneyAmount(tx.ledger_amount)
              : multiplyMoney(tx.amount, tx.buffered_fx_rate || tx.fx_rate || 1),
          running_balance:
            tx.running_balance !== null && tx.running_balance !== undefined
              ? roundMoneyAmount(tx.running_balance)
              : roundMoneyAmount(tx.running_balance_pln)
        }))
        .sort((a, b) => {
          const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
          if (dateCompare !== 0) return dateCompare;

          const createdCompare = String(b.created_at || "").localeCompare(String(a.created_at || ""));
          if (createdCompare !== 0) return createdCompare;

          return String(b.id || "").localeCompare(String(a.id || ""));
        });

      const goalSummaries = goals.map(goal => {
        const target = safeConvertToLedger(goal.amount, goal.currency, "expense");
        const alreadyFundedLedger = confirmedGoalFundingFor(goal.id);

        const futureAllocatedLedger = sumGeneratedFundingFromRows(
          futureTransactions,
          "source_goal_id",
          goal.id,
          ledgerCurrency
        );

        const pendingAllocatedLedger = sumGeneratedFundingFromRows(
          pendingTransactions,
          "source_goal_id",
          goal.id,
          ledgerCurrency
        );

        const impossible = db.prepare(`
          SELECT details
          FROM event_log
          WHERE action = 'goal_impossible' AND entity_id = ?
          ORDER BY timestamp DESC
          LIMIT 1
        `).get(goal.id);

        const normalizedFutureAllocatedLedger = roundMoneyAmount(futureAllocatedLedger);
        const normalizedPendingAllocatedLedger = roundMoneyAmount(pendingAllocatedLedger);
        const totalPlannedLedger = addMoneyAmounts(
          alreadyFundedLedger,
          normalizedFutureAllocatedLedger,
          normalizedPendingAllocatedLedger
        );

        const targetLedger = target.ok ? target.value : null;
        const remainingLedger = target.ok ? Math.max(0, subtractMoneyAmounts(targetLedger, totalPlannedLedger)) : null;
        const fundedByDate = latestFundingDateFromRows(
          generatedTransactions,
          "source_goal_id",
          goal.id,
          ledgerCurrency
        );

        return {
          ...goal,
          target_ledger_amount: targetLedger,
          ledger_currency: ledgerCurrency,
          already_funded: alreadyFundedLedger,
          already_funded_ledger: alreadyFundedLedger,
          pending_allocated: normalizedPendingAllocatedLedger,
          pending_allocated_ledger: normalizedPendingAllocatedLedger,
          future_allocated: normalizedFutureAllocatedLedger,
          future_allocated_ledger: normalizedFutureAllocatedLedger,
          remaining: remainingLedger,
          remaining_ledger: remainingLedger,
          impossible: Boolean(impossible),
          funded_by_date: fundedByDate,
          warning: target.ok
            ? (impossible ? impossible.details : null)
            : target.error,
          fx_missing: !target.ok
        };
      });

      const flexSummaries = flexTransactions.map(flex => {
        const target = safeConvertToLedger(flex.amount, flex.currency, "expense");
        const alreadyFundedLedger = confirmedFlexFundingFor(flex.id);

        const futureAllocatedLedger = sumGeneratedFundingFromRows(
          futureTransactions,
          "source_flex_id",
          flex.id,
          ledgerCurrency
        );

        const pendingAllocatedLedger = sumGeneratedFundingFromRows(
          pendingTransactions,
          "source_flex_id",
          flex.id,
          ledgerCurrency
        );

        const normalizedFutureAllocatedLedger = roundMoneyAmount(futureAllocatedLedger);
        const normalizedPendingAllocatedLedger = roundMoneyAmount(pendingAllocatedLedger);
        const totalPlannedLedger = addMoneyAmounts(
          alreadyFundedLedger,
          normalizedFutureAllocatedLedger,
          normalizedPendingAllocatedLedger
        );

        const targetLedger = target.ok ? target.value : null;
        const remainingLedger = target.ok ? Math.max(0, subtractMoneyAmounts(targetLedger, totalPlannedLedger)) : null;
        const fundedByDate = latestFundingDateFromRows(
          generatedTransactions,
          "source_flex_id",
          flex.id,
          ledgerCurrency
        );

        return {
          ...flex,
          target_ledger_amount: targetLedger,
          ledger_currency: ledgerCurrency,
          already_funded: alreadyFundedLedger,
          already_funded_ledger: alreadyFundedLedger,
          pending_allocated: normalizedPendingAllocatedLedger,
          pending_allocated_ledger: normalizedPendingAllocatedLedger,
          future_allocated: normalizedFutureAllocatedLedger,
          future_allocated_ledger: normalizedFutureAllocatedLedger,
          remaining: remainingLedger,
          remaining_ledger: remainingLedger,
          funded_by_date: fundedByDate,
          fx_missing: !target.ok,
          warning: target.ok ? null : target.error
        };
      });

      const periodSummaries = buildPeriodSummariesFromDefinitions(
        settings || {},
        recurringIncomes || [],
        futureTransactions || [],
        {
          anchorOverrides: periodAnchorOverrides,
          confirmedTransactions: rawConfirmedTransactions,
          pendingTransactions,
          today
        }
      );

      const ledger = db.prepare(`
        SELECT *
        FROM event_log
        ORDER BY timestamp DESC
        LIMIT 100
      `).all();

      const latestSnapshot = db.prepare(`
        SELECT *
        FROM projection_snapshots
        ORDER BY snapshot_timestamp DESC
        LIMIT 1
      `).get();

      return {
        today,
        settings: {
          ...(settings || {}),
          ledger_currency: ledgerCurrency,
          locale: settings?.locale || "en",
          fx_provider: normalizeFxProvider(settings?.fx_provider),
          fx_used_currencies: normalizeFxCurrencyList(settings?.fx_used_currencies, ledgerCurrency),
          manual_fx_rates: {
            ...normalizeManualFxRates(settings?.manual_fx_rates),
            ...normalizeManualFxPairs(settings?.manual_fx_rates, ledgerCurrency)
          }
        },
        recurringExpenses: recurringExpenses || [],
        recurringIncomes: recurringIncomes || [],
        budgetPeriodIncomeOptions: recurringIncomes.map(income => ({
          id: income.id,
          name: income.name,
          active: Boolean(income.active),
          currency: income.currency,
          anchor_type: income.anchor_type,
          repeat_every_months: income.repeat_every_months
        })),
        confirmedTransactions,
        pendingTransactions: pendingTransactions || [],
        futureTransactions: futureTransactions || [],
        oneOffs: oneOffs || [],
        goals: goalSummaries || [],
        flexTransactions: flexSummaries || [],
        periodSummaries,
        latestProjectionSnapshot: latestSnapshot || null,
        ledger: ledger || [],
        missingFxRates: [...missingFxRates],
        availableLocales: listAvailableLocales(),
        generatedAt: new Date().toISOString()
      };
    } finally {
      db.close();
    }
  }

  async function getSnapshotAsync(userId) {
    if (!budgetStore || typeof budgetStore.listPlanningRows !== "function") {
      return getSnapshot(userId);
    }

    const [
      settingsRows,
      recurringIncomeRows,
      pendingRows,
      recurringExpenseRows,
      plannedTransactionRows,
      futureRows,
      oneOffRows,
      goalRows,
      flexRows,
      eventRows,
      projectionSnapshotRows
    ] = await Promise.all([
      budgetStore.listPlanningRows(userId, "settings"),
      budgetStore.listPlanningRows(userId, "recurring_incomes"),
      budgetStore.listPlanningRows(userId, "pending_transactions"),
      budgetStore.listPlanningRows(userId, "recurring_expenses"),
      budgetStore.listPlanningRows(userId, "planned_transactions"),
      budgetStore.listPlanningRows(userId, "future_transactions"),
      budgetStore.listPlanningRows(userId, "one_off_transactions"),
      budgetStore.listPlanningRows(userId, "goals"),
      budgetStore.listPlanningRows(userId, "flex_transactions"),
      budgetStore.listPlanningRows(userId, "event_log"),
      budgetStore.listPlanningRows(userId, "projection_snapshots")
    ]);

    const settings = settingsRows?.[0] || {};
    const ledgerCurrency = settings?.ledger_currency || "PLN";
    const fxSnapshot = (
      typeof safeGetCurrentFxSnapshotAsync === "function"
        ? await safeGetCurrentFxSnapshotAsync(userId)
        : safeGetCurrentFxSnapshot(userId)
    )
      || (typeof getCachedFxSnapshotAsync === "function"
        ? await getCachedFxSnapshotAsync(userId)
        : getCachedFxSnapshot(userId));
    const missingFxRates = new Set();
    const today = todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE);
    const rawConfirmedTransactions = typeof loadAllConfirmedTransactionsAsync === "function"
      ? await loadAllConfirmedTransactionsAsync(userId)
      : loadAllConfirmedTransactions(userId);
    const predictionRowsForRun = () => rawConfirmedTransactions;

    const safeConvertToLedger = (amount, currency, type = "expense") => {
      try {
        const rates = getBufferedFxForCurrency(currency, settings, fxSnapshot, type);

        return {
          ok: true,
          value: multiplyMoney(amount, rates.buffered),
          fx: rates.fx,
          buffered: rates.buffered,
          error: null
        };
      } catch (error) {
        const normalized = normalizeCurrency(currency);

        if (normalized !== ledgerCurrency) {
          missingFxRates.add(normalized);
        }

        return {
          ok: false,
          value: null,
          fx: null,
          buffered: null,
          error: error.message
        };
      }
    };

    const recurringIncomesRaw = [...(recurringIncomeRows || [])]
      .sort((a, b) => Number(a.anchor_day_of_month || 0) - Number(b.anchor_day_of_month || 0));
    const recurringIncomes = recurringIncomesRaw.map(income => {
      const amountLedger = safeConvertToLedger(income.amount, income.currency, "income");

      return {
        ...income,
        amount_ledger_amount: amountLedger.ok ? amountLedger.value : null,
        amount_fx_missing: !amountLedger.ok,
        amount_warning: amountLedger.ok ? null : amountLedger.error,
        ledger_currency: ledgerCurrency
      };
    });

    const pendingTransactions = [...(pendingRows || [])].sort(asc("date", "created_at", "id"));
    const periodAnchorOverrides = periodAnchorOverridesForIncome(
      settings?.budget_period_income_id,
      [
        ...rawConfirmedTransactions,
        ...pendingTransactions
      ]
    );
    const periods = buildBudgetPeriods(
      settings || {},
      recurringIncomes || [],
      today,
      Number(settings?.future_periods || DEFAULT_FUTURE_PERIODS),
      { anchorOverrides: periodAnchorOverrides }
    );

    const futureTransactions = [...(futureRows || [])]
      .sort((a, b) =>
        asc("date", "period")(a, b)
          || String(b?.type || "").localeCompare(String(a?.type || ""))
          || asc("created_at", "id")(a, b)
      );
    const generatedTransactions = [
      ...futureTransactions,
      ...pendingTransactions
    ];
    const plannedTransactions = plannedTransactionRows || [];
    const sortByPriority = (a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0);

    const recurringExpensesRaw = attachPlanningPriority(
      recurringExpenseRows || [],
      plannedTransactions,
      "operating_priority"
    ).sort(sortByPriority);
    const recurringExpenses = await Promise.all(recurringExpensesRaw.map(async expense => {
      const confirmedRowsForExpense = expense.prediction_strategy === "12month_max"
        ? predictionRowsForRun()
        : null;
      const predictedAmount = typeof predictedAmountForRecurringExpenseAsync === "function"
        ? await predictedAmountForRecurringExpenseAsync(
            userId,
            expense,
            today,
            today,
            confirmedRowsForExpense
          )
        : predictedAmountForRecurringExpense(
            userId,
            expense,
            today,
            today,
            confirmedRowsForExpense
          );
      const currentPrediction = roundMoneyAmount(predictedAmount);
      const currentPredictionLedger = safeConvertToLedger(
        currentPrediction,
        expense.currency,
        "expense"
      );

      return {
        ...expense,
        active_status: Number(expense.active) === 1 ? "active" : "disabled",
        current_prediction_amount: currentPrediction,
        current_prediction_ledger_amount: currentPredictionLedger.ok
          ? currentPredictionLedger.value
          : null,
        current_prediction_fx_missing: !currentPredictionLedger.ok,
        current_prediction_warning: currentPredictionLedger.ok ? null : currentPredictionLedger.error,
        ...summarizeRecurringExpenseOccurrencesFromRows(expense, periods, today, generatedTransactions)
      };
    }));

    const oneOffsRaw = [...(oneOffRows || [])].sort(desc("date", "created_at", "id"));
    const oneOffs = oneOffsRaw.map(oneOff => {
      const amountLedger = safeConvertToLedger(
        oneOff.amount,
        oneOff.currency,
        oneOff.type === "income" ? "income" : "expense"
      );

      return {
        ...oneOff,
        amount_ledger_amount: amountLedger.ok ? amountLedger.value : null,
        amount_fx_missing: !amountLedger.ok,
        amount_warning: amountLedger.ok ? null : amountLedger.error,
        ledger_currency: ledgerCurrency
      };
    });

    const goals = attachPlanningPriority(goalRows || [], plannedTransactions, "goal_priority")
      .sort(sortByPriority);
    const flexTransactions = attachPlanningPriority(flexRows || [], plannedTransactions, "operating_priority")
      .sort(sortByPriority);

    const confirmedFunding = typeof confirmedFundingTotalsAsync === "function"
      ? await confirmedFundingTotalsAsync(userId, ledgerCurrency, settings)
      : (typeof confirmedFundingTotals === "function"
        ? confirmedFundingTotals(userId, ledgerCurrency, settings)
        : null);
    const confirmedGoalFundingFor = goalId => roundMoneyAmount(confirmedFunding
      ? confirmedFunding.source_goal_id.get(goalId)
      : sumConfirmedFunding(userId, "source_goal_id", goalId, ledgerCurrency, settings));
    const confirmedFlexFundingFor = flexId => roundMoneyAmount(confirmedFunding
      ? confirmedFunding.source_flex_id.get(flexId)
      : sumConfirmedFunding(userId, "source_flex_id", flexId, ledgerCurrency, settings));

    const confirmedTransactions = rawConfirmedTransactions
      .map(tx => ({
        ...tx,
        ledger_year: tx.ledger_year || String(tx.date || "").slice(0, 4),
        ledger_currency: tx.ledger_currency || ledgerCurrency,
        requested_amount: tx.requested_amount ?? tx.amount,
        funded_amount: tx.funded_amount ?? tx.amount,
        ledger_amount:
          tx.ledger_amount !== null && tx.ledger_amount !== undefined
            ? roundMoneyAmount(tx.ledger_amount)
            : multiplyMoney(tx.amount, tx.buffered_fx_rate || tx.fx_rate || 1),
        running_balance:
          tx.running_balance !== null && tx.running_balance !== undefined
            ? roundMoneyAmount(tx.running_balance)
            : roundMoneyAmount(tx.running_balance_pln)
      }))
      .sort((a, b) => {
        const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
        if (dateCompare !== 0) return dateCompare;

        const createdCompare = String(b.created_at || "").localeCompare(String(a.created_at || ""));
        if (createdCompare !== 0) return createdCompare;

        return String(b.id || "").localeCompare(String(a.id || ""));
      });

    const goalSummaries = goals.map(goal => {
      const target = safeConvertToLedger(goal.amount, goal.currency, "expense");
      const alreadyFundedLedger = confirmedGoalFundingFor(goal.id);
      const normalizedFutureAllocatedLedger = roundMoneyAmount(sumGeneratedFundingFromRows(
        futureTransactions,
        "source_goal_id",
        goal.id,
        ledgerCurrency
      ));
      const normalizedPendingAllocatedLedger = roundMoneyAmount(sumGeneratedFundingFromRows(
        pendingTransactions,
        "source_goal_id",
        goal.id,
        ledgerCurrency
      ));
      const totalPlannedLedger = addMoneyAmounts(
        alreadyFundedLedger,
        normalizedFutureAllocatedLedger,
        normalizedPendingAllocatedLedger
      );
      const targetLedger = target.ok ? target.value : null;
      const remainingLedger = target.ok ? Math.max(0, subtractMoneyAmounts(targetLedger, totalPlannedLedger)) : null;
      const impossible = latestImpossibleEventFromRows(eventRows, goal.id);
      const fundedByDate = latestFundingDateFromRows(
        generatedTransactions,
        "source_goal_id",
        goal.id,
        ledgerCurrency
      );

      return {
        ...goal,
        target_ledger_amount: targetLedger,
        ledger_currency: ledgerCurrency,
        already_funded: alreadyFundedLedger,
        already_funded_ledger: alreadyFundedLedger,
        pending_allocated: normalizedPendingAllocatedLedger,
        pending_allocated_ledger: normalizedPendingAllocatedLedger,
        future_allocated: normalizedFutureAllocatedLedger,
        future_allocated_ledger: normalizedFutureAllocatedLedger,
        remaining: remainingLedger,
        remaining_ledger: remainingLedger,
        impossible: Boolean(impossible),
        funded_by_date: fundedByDate,
        warning: target.ok
          ? (impossible ? impossible.details : null)
          : target.error,
        fx_missing: !target.ok
      };
    });

    const flexSummaries = flexTransactions.map(flex => {
      const target = safeConvertToLedger(flex.amount, flex.currency, "expense");
      const alreadyFundedLedger = confirmedFlexFundingFor(flex.id);
      const normalizedFutureAllocatedLedger = roundMoneyAmount(sumGeneratedFundingFromRows(
        futureTransactions,
        "source_flex_id",
        flex.id,
        ledgerCurrency
      ));
      const normalizedPendingAllocatedLedger = roundMoneyAmount(sumGeneratedFundingFromRows(
        pendingTransactions,
        "source_flex_id",
        flex.id,
        ledgerCurrency
      ));
      const totalPlannedLedger = addMoneyAmounts(
        alreadyFundedLedger,
        normalizedFutureAllocatedLedger,
        normalizedPendingAllocatedLedger
      );
      const targetLedger = target.ok ? target.value : null;
      const remainingLedger = target.ok ? Math.max(0, subtractMoneyAmounts(targetLedger, totalPlannedLedger)) : null;
      const fundedByDate = latestFundingDateFromRows(
        generatedTransactions,
        "source_flex_id",
        flex.id,
        ledgerCurrency
      );

      return {
        ...flex,
        target_ledger_amount: targetLedger,
        ledger_currency: ledgerCurrency,
        already_funded: alreadyFundedLedger,
        already_funded_ledger: alreadyFundedLedger,
        pending_allocated: normalizedPendingAllocatedLedger,
        pending_allocated_ledger: normalizedPendingAllocatedLedger,
        future_allocated: normalizedFutureAllocatedLedger,
        future_allocated_ledger: normalizedFutureAllocatedLedger,
        remaining: remainingLedger,
        remaining_ledger: remainingLedger,
        funded_by_date: fundedByDate,
        fx_missing: !target.ok,
        warning: target.ok ? null : target.error
      };
    });

    const periodSummaries = buildPeriodSummariesFromDefinitions(
      settings || {},
      recurringIncomes || [],
      futureTransactions || [],
      {
        anchorOverrides: periodAnchorOverrides,
        confirmedTransactions: rawConfirmedTransactions,
        pendingTransactions,
        today
      }
    );

    const ledger = [...(eventRows || [])].sort(desc("timestamp")).slice(0, 100);
    const latestSnapshot = [...(projectionSnapshotRows || [])]
      .sort(desc("snapshot_timestamp"))
      .at(0) || null;

    return {
      today,
      settings: {
        ...(settings || {}),
        ledger_currency: ledgerCurrency,
        locale: settings?.locale || "en",
        fx_provider: normalizeFxProvider(settings?.fx_provider),
        fx_used_currencies: normalizeFxCurrencyList(settings?.fx_used_currencies, ledgerCurrency),
        manual_fx_rates: {
          ...normalizeManualFxRates(settings?.manual_fx_rates),
          ...normalizeManualFxPairs(settings?.manual_fx_rates, ledgerCurrency)
        }
      },
      recurringExpenses: recurringExpenses || [],
      recurringIncomes: recurringIncomes || [],
      budgetPeriodIncomeOptions: recurringIncomes.map(income => ({
        id: income.id,
        name: income.name,
        active: Boolean(income.active),
        currency: income.currency,
        anchor_type: income.anchor_type,
        repeat_every_months: income.repeat_every_months
      })),
      confirmedTransactions,
      pendingTransactions: pendingTransactions || [],
      futureTransactions: futureTransactions || [],
      oneOffs: oneOffs || [],
      goals: goalSummaries || [],
      flexTransactions: flexSummaries || [],
      periodSummaries,
      latestProjectionSnapshot: latestSnapshot || null,
      ledger: ledger || [],
      missingFxRates: [...missingFxRates],
      availableLocales: listAvailableLocales(),
      generatedAt: new Date().toISOString()
    };
  }
  return {
    getSnapshot,
    getSnapshotAsync
  };
}

