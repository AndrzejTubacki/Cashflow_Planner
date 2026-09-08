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
  buildBudgetPeriods,
  buildPeriodSummariesFromDefinitions,
  confirmedFundingTotals = null,
  getCachedFxSnapshot,
  confirmedRowsForPrediction = null,
  listAvailableLocales = () => [{ id: "en", label: "English" }],
  loadAllConfirmedTransactions,
  openPlanningDb,
  predictedAmountForRecurringExpense = (_userId, expense) => Number(expense?.amount || 0),
  safeGetCurrentFxSnapshot,
  sumConfirmedFunding
}) {
  function latestFundingDate(db, sourceColumn, sourceId, ledgerCurrency = "PLN") {
    if (!["source_flex_id", "source_goal_id"].includes(sourceColumn)) {
      return null;
    }

    const row = db.prepare(`
      SELECT MAX(date) AS funded_by_date
      FROM (
        SELECT date
        FROM future_transactions
        WHERE ${sourceColumn} = ?
          AND COALESCE(ledger_amount, 0) > 0
          AND COALESCE(ledger_currency, 'PLN') = ?

        UNION ALL

        SELECT date
        FROM pending_transactions
        WHERE ${sourceColumn} = ?
          AND COALESCE(ledger_amount, 0) > 0
          AND COALESCE(ledger_currency, 'PLN') = ?
      )
    `).get(sourceId, ledgerCurrency, sourceId, ledgerCurrency);

    return row?.funded_by_date || null;
  }

  function latestFlexFundingDate(db, flexId, ledgerCurrency = "PLN") {
    return latestFundingDate(db, "source_flex_id", flexId, ledgerCurrency);
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

        const futureAllocatedLedger = db.prepare(`
          SELECT COALESCE(SUM(ledger_amount), 0) AS v
          FROM future_transactions
          WHERE source_goal_id = ?
            AND COALESCE(ledger_currency, 'PLN') = ?
        `).get(goal.id, ledgerCurrency).v;

        const pendingAllocatedLedger = db.prepare(`
          SELECT COALESCE(SUM(ledger_amount), 0) AS v
          FROM pending_transactions
          WHERE source_goal_id = ?
            AND COALESCE(ledger_currency, 'PLN') = ?
        `).get(goal.id, ledgerCurrency).v;

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
        const fundedByDate = latestFundingDate(db, "source_goal_id", goal.id, ledgerCurrency);

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

        const futureAllocatedLedger = db.prepare(`
          SELECT COALESCE(SUM(ledger_amount), 0) AS v
          FROM future_transactions
          WHERE source_flex_id = ?
            AND COALESCE(ledger_currency, 'PLN') = ?
        `).get(flex.id, ledgerCurrency).v;

        const pendingAllocatedLedger = db.prepare(`
          SELECT COALESCE(SUM(ledger_amount), 0) AS v
          FROM pending_transactions
          WHERE source_flex_id = ?
            AND COALESCE(ledger_currency, 'PLN') = ?
        `).get(flex.id, ledgerCurrency).v;

        const normalizedFutureAllocatedLedger = roundMoneyAmount(futureAllocatedLedger);
        const normalizedPendingAllocatedLedger = roundMoneyAmount(pendingAllocatedLedger);
        const totalPlannedLedger = addMoneyAmounts(
          alreadyFundedLedger,
          normalizedFutureAllocatedLedger,
          normalizedPendingAllocatedLedger
        );

        const targetLedger = target.ok ? target.value : null;
        const remainingLedger = target.ok ? Math.max(0, subtractMoneyAmounts(targetLedger, totalPlannedLedger)) : null;
        const fundedByDate = latestFlexFundingDate(db, flex.id, ledgerCurrency);

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
  return {
    getSnapshot
  };
}

