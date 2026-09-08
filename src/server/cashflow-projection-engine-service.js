import { DEFAULT_FUTURE_PERIODS, DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { recurringOccurrencesInPeriod, todayInTimezone } from "./cashflow-date-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { addMoneyAmounts, getBufferedFxForCurrency, multiplyMoney, roundMoneyAmount, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import { makeOccurrenceKey } from "./cashflow-occurrence-utils.js";
import { normalizePriority } from "./cashflow-priority-utils.js";
import {
  buildBudgetPeriods,
  periodAnchorOverridesForIncome
} from "./cashflow-period-utils.js";

export function createCashflowProjectionEngineService({
  confirmedBalanceAsOf = null,
  confirmedFundingTotals = null,
  confirmedOccurrenceKeys,
  confirmedRowsAfterDate = null,
  confirmedOneOffProgress,
  confirmedRowsForPrediction = null,
  deletePendingOccurrence,
  getCachedFxSnapshot,
  logServerEvent,
  notificationEnabled,
  notificationPriority,
  openPlanningDb,
  planningOpeningBalance,
  predictedAmountForRecurringExpense,
  predictedAmountForRecurringIncome,
  queueNotification,
  recalculatePlanningRunningBalances,
  refreshPendingOccurrence,
  safeGetCurrentFxSnapshot,
  sumConfirmedFunding,
  sumPendingFunding
}) {
  function regenerateProjections(userId) {
    const db = openPlanningDb(userId);

    try {
      const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get();

      const ledgerCurrency = settings?.ledger_currency || "PLN";
      const fxSnapshot = safeGetCurrentFxSnapshot(userId) || getCachedFxSnapshot(userId);
      const generationTimestamp = new Date().toISOString();
      const today = todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE);

      const previousSnapshot = db.prepare(`
        SELECT *
        FROM projection_snapshots
        ORDER BY snapshot_timestamp DESC
        LIMIT 1
      `).get();

      const previousFxJson = previousSnapshot?.fx_rates_used || null;
      const currentFxJson = JSON.stringify(fxSnapshot || {});
      const fxRatesChanged = previousFxJson !== null && previousFxJson !== currentFxJson;

      const futurePeriods = Number(settings?.future_periods) || DEFAULT_FUTURE_PERIODS;
      const reserveFloor = Number(settings?.minimum_reserve_enabled || 0) === 1
        ? Math.max(0, roundMoneyAmount(settings?.minimum_reserve_amount || 0))
        : 0;
      const spendableBalance = (period) => Math.max(0, subtractMoneyAmounts(period.available, reserveFloor));
      const addPeriodAvailable = (period, amount) => {
        period.available = addMoneyAmounts(period.available, amount);
      };
      const subtractPeriodAvailable = (period, amount) => {
        period.available = subtractMoneyAmounts(period.available, amount);
      };

      const recurringExpenses = db.prepare(`
        SELECT r.*, pt.operating_priority AS priority
        FROM recurring_expenses r
        JOIN planned_transactions pt ON pt.id = r.planned_transaction_id
        WHERE r.active = 1
        ORDER BY pt.operating_priority ASC, r.created_at ASC, r.id ASC
      `).all();

      const recurringIncomes = db.prepare(`
        SELECT *
        FROM recurring_incomes
        WHERE active = 1
        ORDER BY anchor_day_of_month ASC, created_at ASC, id ASC
      `).all();

      const flexes = db.prepare(`
        SELECT f.*, pt.operating_priority AS priority
        FROM flex_transactions f
        JOIN planned_transactions pt ON pt.id = f.planned_transaction_id
        WHERE f.active = 1
        ORDER BY pt.operating_priority ASC, f.created_at ASC, f.id ASC
      `).all();

      const goals = db.prepare(`
        SELECT g.*, pt.goal_priority AS priority
        FROM goals g
        JOIN planned_transactions pt ON pt.id = g.planned_transaction_id
        WHERE g.active = 1
        ORDER BY pt.goal_priority ASC, g.created_at ASC, g.id ASC
      `).all();

      const oneOffs = db.prepare(`
        SELECT *
        FROM one_off_transactions
        ORDER BY date ASC, created_at ASC, id ASC
      `).all();

      let predictionRows = null;
      const predictionRowsForRun = () => {
        if (!predictionRows) {
          predictionRows = typeof confirmedRowsForPrediction === "function"
            ? confirmedRowsForPrediction(userId, today)
            : null;
        }
        return predictionRows;
      };
      const pendingPeriodIncomeRows = settings?.budget_period_income_id
        ? db.prepare(`
          SELECT source_recurring_income_id, type, date, occurrence_key
          FROM pending_transactions
          WHERE source_recurring_income_id = ?
            AND type = 'income'
        `).all(settings.budget_period_income_id)
        : [];
      const periodAnchorOverrides = periodAnchorOverridesForIncome(
        settings?.budget_period_income_id,
        [
          ...(typeof confirmedRowsForPrediction === "function" ? predictionRowsForRun() || [] : []),
          ...pendingPeriodIncomeRows
        ]
      );
      const periods = buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods, {
        anchorOverrides: periodAnchorOverrides
      });
      const handledOccurrenceKeys = confirmedOccurrenceKeys(userId);
      const oneOffProgress = confirmedOneOffProgress(userId);
      const confirmedFunding = typeof confirmedFundingTotals === "function"
        ? confirmedFundingTotals(userId, ledgerCurrency, settings)
        : null;
      const confirmedGoalFundingFor = goalId => roundMoneyAmount(confirmedFunding
        ? confirmedFunding.source_goal_id.get(goalId)
        : sumConfirmedFunding(userId, "source_goal_id", goalId, ledgerCurrency, settings));
      const confirmedFlexFundingFor = flexId => roundMoneyAmount(confirmedFunding
        ? confirmedFunding.source_flex_id.get(flexId)
        : sumConfirmedFunding(userId, "source_flex_id", flexId, ledgerCurrency, settings));

      const confirmedGoalFunding = new Map();
      const pendingGoalFunding = new Map();
      const confirmedFlexFunding = new Map();
      const pendingFlexFunding = new Map();
      const generatedFlexFunding = new Map();

      for (const goal of goals) {
        confirmedGoalFunding.set(
          goal.id,
          confirmedGoalFundingFor(goal.id)
        );

        pendingGoalFunding.set(
          goal.id,
          sumPendingFunding(userId, "source_goal_id", goal.id, ledgerCurrency, settings)
        );
      }

      for (const flex of flexes) {
        confirmedFlexFunding.set(
          flex.id,
          confirmedFlexFundingFor(flex.id)
        );

        pendingFlexFunding.set(
          flex.id,
          sumPendingFunding(userId, "source_flex_id", flex.id, ledgerCurrency, settings)
        );

        generatedFlexFunding.set(flex.id, 0);
      }

      function convert(amount, currency, type) {
        const rates = getBufferedFxForCurrency(
          currency,
          settings,
          fxSnapshot,
          type === "income" ? "income" : "expense"
        );

        return {
          fx: rates.fx,
          buffered: rates.buffered,
          ledgerCurrency,
          ledgerAmount: multiplyMoney(amount, rates.buffered)
        };
      }

      function toOriginalAmount(ledgerAmount, bufferedRate) {
        return roundMoneyAmount(Number(ledgerAmount || 0) / Number(bufferedRate || 1));
      }

      const goalTargetLedger = new Map();
      const flexTargetLedger = new Map();

      for (const goal of goals) {
        goalTargetLedger.set(goal.id, convert(goal.amount, goal.currency, "expense").ledgerAmount);
      }

      for (const flex of flexes) {
        flexTargetLedger.set(flex.id, convert(flex.amount, flex.currency, "expense").ledgerAmount);
      }

      const previouslyFullyFundedGoals = new Set(
        goals
          .filter(goal => {
            const futureAllocatedLedger = db.prepare(`
              SELECT COALESCE(SUM(ledger_amount), 0) AS v
              FROM future_transactions
              WHERE source_goal_id = ?
                AND COALESCE(ledger_currency, 'PLN') = ?
            `).get(goal.id, ledgerCurrency).v;

            const total = addMoneyAmounts(
              confirmedGoalFunding.get(goal.id),
              pendingGoalFunding.get(goal.id),
              futureAllocatedLedger
            );

            return total >= Number(goalTargetLedger.get(goal.id) || 0);
          })
          .map(goal => goal.id)
      );

      const insertFuture = db.prepare(`
        INSERT INTO future_transactions (
          id, name, currency, amount, type, date, period,
          source_recurring_expense_id, source_recurring_income_id, source_one_off_id,
          source_flex_id, source_goal_id,
          fx_rate, buffered_fx_rate, ledger_currency, requested_amount, funded_amount, ledger_amount,
          status, note, occurrence_key, generation_timestamp, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      const insertPending = db.prepare(`
        INSERT INTO pending_transactions (
          id, name, currency, amount, type, date,
          source_recurring_expense_id, source_recurring_income_id, source_one_off_id,
          source_flex_id, source_goal_id,
          fx_rate, buffered_fx_rate, ledger_currency, status,
          funded_amount, requested_amount, ledger_amount, pending_origin, note, occurrence_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);

      function insertTx({
        name,
        currency,
        requestedAmount,
        fundedAmount,
        type,
        date,
        period,
        sourceRecurringExpenseId = null,
        sourceRecurringIncomeId = null,
        sourceOneOffId = null,
        sourceFlexId = null,
        sourceGoalId = null,
        status = "funded",
        note = null,
        occurrenceKeyOverride = null,
        toPending = false
      }) {
        const normalizedRequestedAmount = roundMoneyAmount(requestedAmount);
        const normalizedFundedAmount = roundMoneyAmount(fundedAmount);
        const occurrenceKey = occurrenceKeyOverride || makeOccurrenceKey({
          type,
          date,
          sourceRecurringExpenseId,
          sourceRecurringIncomeId,
          sourceOneOffId,
          sourceFlexId,
          sourceGoalId
        });

        const conversionType = type === "income" ? "income" : "expense";
        const converted = convert(normalizedFundedAmount, currency, conversionType);

        if (handledOccurrenceKeys.has(occurrenceKey)) {
          return {
            inserted: false,
            ledgerAmount: 0,
            alreadyConfirmed: true
          };
        }

        const refreshedPending = refreshPendingOccurrence(
          db,
          {
            name,
            currency,
            requestedAmount: normalizedRequestedAmount,
            fundedAmount: normalizedFundedAmount,
            type,
            date,
            sourceRecurringExpenseId,
            sourceRecurringIncomeId,
            sourceOneOffId,
            sourceFlexId,
            sourceGoalId,
            status,
            note
          },
          converted,
          occurrenceKey
        );

        if (refreshedPending) {
          return {
            inserted: false,
            updatedPending: true,
            ledgerAmount: roundMoneyAmount(refreshedPending.ledger_amount_delta),
            fx: converted.fx,
            buffered: converted.buffered
          };
        }

        if (toPending) {
          insertPending.run(
            generateId("pend"),
            name,
            currency,
            normalizedFundedAmount,
            type,
            date,
            sourceRecurringExpenseId,
            sourceRecurringIncomeId,
            sourceOneOffId,
            sourceFlexId,
            sourceGoalId,
            converted.fx,
            converted.buffered,
            ledgerCurrency,
            status === "funded" ? "pending" : status,
            normalizedFundedAmount,
            normalizedRequestedAmount,
            converted.ledgerAmount,
            "projection",
            note,
            occurrenceKey
          );

          return {
            inserted: true,
            pending: true,
            ledgerAmount: converted.ledgerAmount,
            fx: converted.fx,
            buffered: converted.buffered
          };
        }

        insertFuture.run(
          generateId("fut"),
          name,
          currency,
          normalizedFundedAmount,
          type,
          date,
          period,
          sourceRecurringExpenseId,
          sourceRecurringIncomeId,
          sourceOneOffId,
          sourceFlexId,
          sourceGoalId,
          converted.fx,
          converted.buffered,
          ledgerCurrency,
          normalizedRequestedAmount,
          normalizedFundedAmount,
          converted.ledgerAmount,
          status,
          note,
          occurrenceKey,
          generationTimestamp
        );

        return {
          inserted: true,
          ledgerAmount: converted.ledgerAmount,
          fx: converted.fx,
          buffered: converted.buffered
        };
      }

      function periodForDate(date) {
        return periods.find(p => date >= p.start && date <= p.end);
      }

      function periodForPendingDate(date) {
        if (!periods.length) return null;
        if (date < periods[0].start) return periods[0];
        return periodForDate(date);
      }

      function applyPendingBalancesToPeriods() {
        const pendingRows = db.prepare(`
          SELECT type, date, ledger_amount
          FROM pending_transactions
          WHERE COALESCE(ledger_currency, 'PLN') = ?
          ORDER BY date ASC, created_at ASC, id ASC
        `).all(ledgerCurrency);

        for (const row of pendingRows) {
          const targetPeriod = periodForPendingDate(String(row.date || ""));
          if (!targetPeriod) continue;

          const ledgerAmount = roundMoneyAmount(row.ledger_amount);
          if (row.type === "income") {
            addPeriodAvailable(targetPeriod, ledgerAmount);
          } else {
            subtractPeriodAvailable(targetPeriod, ledgerAmount);
          }
        }
      }

      function applyFutureConfirmedBalancesToPeriods() {
        if (typeof confirmedRowsAfterDate !== "function") return;

        const confirmedRows = confirmedRowsAfterDate(db, userId, today);
        for (const row of confirmedRows) {
          const targetPeriod = periodForDate(String(row.date || ""));
          if (!targetPeriod) continue;

          const ledgerAmount = roundMoneyAmount(row.ledger_amount);
          if (row.type === "income") {
            addPeriodAvailable(targetPeriod, ledgerAmount);
          } else {
            subtractPeriodAvailable(targetPeriod, ledgerAmount);
          }
        }
      }

      function queueFundingShortfallIfNeeded(entityId, title, message) {
        if (!notificationEnabled(settings, "funding_shortfall")) return;

        queueNotification(
          db,
          "funding_shortfall",
          title,
          message,
          notificationPriority(settings, "funding_shortfall"),
          entityId,
          `funding_shortfall:${entityId}`,
          settings
        );
      }

      function queueUnderfundedIfNeeded(expense, missingAmount) {
        if (!notificationEnabled(settings, "necessary_underfunded")) return;

        queueNotification(
          db,
          "necessary_underfunded",
          "Necessary transaction underfunded",
          `${expense.name} is missing ${missingAmount.toFixed(2)} ${expense.currency}`,
          notificationPriority(settings, "necessary_underfunded"),
          expense.id,
          `necessary_underfunded:${expense.id}`,
          settings
        );
      }

      function hasRemainingGoalDemandInPeriod(period) {
        return goals.some(goal => {
          if (goal.due_date < today || goal.due_date < period.start || goal.due_date > period.end) {
            return false;
          }

          const targetLedger = roundMoneyAmount(goalTargetLedger.get(goal.id));
          const fundedLedger = addMoneyAmounts(
            confirmedGoalFunding.get(goal.id),
            pendingGoalFunding.get(goal.id)
          );

          return subtractMoneyAmounts(targetLedger, fundedLedger) > 0.0001;
        });
      }

      function hasPendingOccurrence(occurrenceKey) {
        return Boolean(db.prepare(`
          SELECT 1
          FROM pending_transactions
          WHERE occurrence_key = ?
          LIMIT 1
        `).get(occurrenceKey));
      }

      function hasRemainingFlexDemandInPeriod(period) {
        return flexes.some(flex => {
          const targetLedger = roundMoneyAmount(flexTargetLedger.get(flex.id));
          const fundedLedger = addMoneyAmounts(
            confirmedFlexFunding.get(flex.id),
            pendingFlexFunding.get(flex.id),
            generatedFlexFunding.get(flex.id)
          );

          if (subtractMoneyAmounts(targetLedger, fundedLedger) <= 0.0001) return false;

          const occurrenceKey = makeOccurrenceKey({
            type: "expense",
            date: period.start,
            sourceFlexId: flex.id
          });

          return !handledOccurrenceKeys.has(occurrenceKey) && !hasPendingOccurrence(occurrenceKey);
        });
      }

      function hasDiscretionaryRecurringDemandInPeriod(period) {
        return recurringExpenses
          .filter(expense => !expense.necessary)
          .some(expense => recurringOccurrencesInPeriod(expense, period, today).some(date => {
            const occurrenceKey = makeOccurrenceKey({
              type: "expense",
              date,
              sourceRecurringExpenseId: expense.id
            });

            return !handledOccurrenceKeys.has(occurrenceKey) && !hasPendingOccurrence(occurrenceKey);
          }));
      }

      function hasLocalLowerPriorityDemand(period) {
        return hasRemainingGoalDemandInPeriod(period) ||
          hasRemainingFlexDemandInPeriod(period) ||
          hasDiscretionaryRecurringDemandInPeriod(period);
      }

      function carrySurplusToNextPeriod(periodIndex) {
        const currentPeriod = periods[periodIndex];
        const nextPeriod = periods[periodIndex + 1];

        if (!currentPeriod || !nextPeriod) return;
        if (currentPeriod.blocked || Number(currentPeriod.available || 0) <= 0) return;

        addPeriodAvailable(nextPeriod, currentPeriod.available);
        currentPeriod.available = 0;
      }

      function carryDebtToNextPeriod(periodIndex) {
        const currentPeriod = periods[periodIndex];
        const nextPeriod = periods[periodIndex + 1];

        if (!currentPeriod || !nextPeriod) return;
        if (Number(currentPeriod.available || 0) >= 0) return;

        addPeriodAvailable(nextPeriod, currentPeriod.available);
        currentPeriod.available = 0;
      }

      db.transaction(() => {
        db.prepare("DELETE FROM future_transactions").run();

        for (const occurrenceKey of handledOccurrenceKeys) {
          deletePendingOccurrence(db, occurrenceKey);
        }

        if (periods.length) {
          addPeriodAvailable(periods[0], typeof confirmedBalanceAsOf === "function"
            ? confirmedBalanceAsOf(db, userId, today)
            : planningOpeningBalance(db, userId, { includePending: false }));
          applyPendingBalancesToPeriods();
          applyFutureConfirmedBalancesToPeriods();
        }

        db.prepare(`
          DELETE FROM event_log
          WHERE action IN (
            'goal_impossible',
            'necessary_underfunded',
            'funding_shortfall'
          )
        `).run();

        for (const [periodIndex, period] of periods.entries()) {
          period.blocked = false;

          for (const income of recurringIncomes) {
            for (const date of recurringOccurrencesInPeriod(income, period, today)) {
              const predictedIncomeAmount = predictedAmountForRecurringIncome(
                userId,
                income,
                today,
                date,
                income.prediction_strategy === "12month_min" ? predictionRowsForRun() : null
              );

              const inserted = insertTx({
                name: income.name,
                currency: income.currency,
                requestedAmount: predictedIncomeAmount,
                fundedAmount: predictedIncomeAmount,
                type: "income",
                date,
                period: period.key,
                sourceRecurringIncomeId: income.id
              });

              addPeriodAvailable(period, inserted.ledgerAmount);
            }
          }

          for (const oneOff of oneOffs) {
            const progressKey = `${oneOff.id}:${oneOff.type}:${String(oneOff.currency || "").toUpperCase()}`;
            const progress = oneOffProgress.get(progressKey) || null;
            const confirmedAmount = roundMoneyAmount(progress?.confirmedAmount);
            const remainingAmount = Math.max(0, subtractMoneyAmounts(oneOff.amount, confirmedAmount));
            const isConfirmedRemainder = Boolean(progress);
            const occurrenceKey = isConfirmedRemainder
              ? `one_off_remainder:${oneOff.id}:${Number(progress.confirmedCount || 0) + 1}`
              : makeOccurrenceKey({
                  type: oneOff.type,
                  date: oneOff.date,
                  sourceOneOffId: oneOff.id
                });
            const toPending = oneOff.date <= today;

            if (isConfirmedRemainder) {
              // Each confirmed installment advances the expected remainder key and invalidates older pending rows.
              if (remainingAmount <= 0.0001) {
                db.prepare("DELETE FROM pending_transactions WHERE source_one_off_id = ?").run(oneOff.id);
                continue;
              }

              if (toPending) {
                db.prepare(`
                  DELETE FROM pending_transactions
                  WHERE source_one_off_id = ?
                    AND occurrence_key != ?
                `).run(oneOff.id, occurrenceKey);
              } else {
                // Remove a stale due remainder after its target date moves into the future.
                // Keep a future remainder that the user explicitly moved to pending on that same date.
                db.prepare(`
                  DELETE FROM pending_transactions
                  WHERE source_one_off_id = ?
                    AND (
                      occurrence_key != ?
                      OR date != ?
                    )
                `).run(oneOff.id, occurrenceKey, oneOff.date);
              }
            }

            const targetPeriod = toPending ? periods[0] : periodForDate(oneOff.date);
            if (!targetPeriod || targetPeriod.key !== period.key) continue;

            const requestedConversion = convert(remainingAmount, oneOff.currency, oneOff.type);
            const requestedLedger = requestedConversion.ledgerAmount;
            const existingPending = db.prepare(`
              SELECT ledger_amount
              FROM pending_transactions
              WHERE occurrence_key = ?
              LIMIT 1
            `).get(occurrenceKey);
            const availableForExpense = addMoneyAmounts(
              spendableBalance(period),
              Math.max(0, roundMoneyAmount(existingPending?.ledger_amount))
            );

            if (oneOff.type === "income") {
              const inserted = insertTx({
                name: oneOff.name,
                currency: oneOff.currency,
                requestedAmount: remainingAmount,
                fundedAmount: remainingAmount,
                type: "income",
                date: oneOff.date,
                period: period.key,
                sourceOneOffId: oneOff.id,
                occurrenceKeyOverride: occurrenceKey,
                toPending
              });

              addPeriodAvailable(period, inserted.ledgerAmount);
              continue;
            }

            if (availableForExpense < requestedLedger) {
              const inserted = insertTx({
                name: oneOff.name,
                currency: oneOff.currency,
                requestedAmount: remainingAmount,
                fundedAmount: 0,
                type: "expense",
                date: oneOff.date,
                period: period.key,
                sourceOneOffId: oneOff.id,
                status: "underfunded",
                note: "One-off expense requires full funding and could not be funded",
                occurrenceKeyOverride: occurrenceKey,
                toPending
              });
              subtractPeriodAvailable(period, inserted.ledgerAmount);

              queueFundingShortfallIfNeeded(
                oneOff.id,
                "One-off expense underfunded",
                `${oneOff.name} could not be fully funded in ${period.key}`
              );

              period.blocked = true;
              continue;
            }

            const inserted = insertTx({
              name: oneOff.name,
              currency: oneOff.currency,
              requestedAmount: remainingAmount,
              fundedAmount: remainingAmount,
              type: "expense",
              date: oneOff.date,
              period: period.key,
              sourceOneOffId: oneOff.id,
              occurrenceKeyOverride: occurrenceKey,
              toPending
            });

            subtractPeriodAvailable(period, inserted.ledgerAmount);
          }

          if (period.blocked) {
            carryDebtToNextPeriod(periodIndex);
            continue;
          }

          for (const expense of recurringExpenses.filter(e => e.necessary)) {
            for (const date of recurringOccurrencesInPeriod(expense, period, today)) {
              const predictedExpenseAmount = predictedAmountForRecurringExpense(
                userId,
                expense,
                today,
                date,
                expense.prediction_strategy === "12month_max" ? predictionRowsForRun() : null
              );
              const converted = convert(predictedExpenseAmount, expense.currency, "expense");
              const requestedLedger = converted.ledgerAmount;

              if (spendableBalance(period) <= 0) {
                insertTx({
                  name: expense.name,
                  currency: expense.currency,
                  requestedAmount: predictedExpenseAmount,
                  fundedAmount: 0,
                  type: "expense",
                  date,
                  period: period.key,
                  sourceRecurringExpenseId: expense.id,
                  status: "underfunded",
                  note: "Necessary transaction could not be funded"
                });

                queueUnderfundedIfNeeded(expense, predictedExpenseAmount);

                queueFundingShortfallIfNeeded(
                  expense.id,
                  "Funding shortfall",
                  `${expense.name} could not be funded in ${period.key}`
                );

                continue;
              }

              const fundedLedger = Math.min(spendableBalance(period), requestedLedger);
              const fundedOriginal = toOriginalAmount(fundedLedger, converted.buffered);
              const status = fundedLedger < requestedLedger ? "partial" : "funded";
              const missingOriginal = Math.max(0, subtractMoneyAmounts(predictedExpenseAmount, fundedOriginal));

              const inserted = insertTx({
                name: expense.name,
                currency: expense.currency,
                requestedAmount: predictedExpenseAmount,
                fundedAmount: fundedOriginal,
                type: "expense",
                date,
                period: period.key,
                sourceRecurringExpenseId: expense.id,
                status,
                note: status === "partial" ? "Necessary transaction partially funded" : null
              });

              subtractPeriodAvailable(period, inserted.ledgerAmount);

              if (status === "partial") {
                queueUnderfundedIfNeeded(expense, missingOriginal);

                queueFundingShortfallIfNeeded(
                  expense.id,
                  "Funding shortfall",
                  `${expense.name} was only partially funded in ${period.key}`
                );
              }
            }
          }

          if (!hasLocalLowerPriorityDemand(period)) {
            carrySurplusToNextPeriod(periodIndex);
          }

          carryDebtToNextPeriod(periodIndex);
        }

        for (const goal of goals) {
          const targetLedger = roundMoneyAmount(goalTargetLedger.get(goal.id));

          let remainingLedger = Math.max(
            0,
            subtractMoneyAmounts(
              targetLedger,
              confirmedGoalFunding.get(goal.id),
              pendingGoalFunding.get(goal.id)
            )
          );

          const eligiblePeriods = periods
            .filter(p => !p.blocked && p.start <= goal.due_date)
            .sort((a, b) => b.start.localeCompare(a.start));

          for (const period of eligiblePeriods) {
            if (remainingLedger <= 0) break;
            if (spendableBalance(period) <= 0) continue;

            const converted = convert(1, goal.currency, "expense");
            const fundedLedger = Math.min(remainingLedger, spendableBalance(period));
            const fundedOriginal = toOriginalAmount(fundedLedger, converted.buffered);
            const requestedOriginal = toOriginalAmount(remainingLedger, converted.buffered);
            const allocationDate = goal.due_date < period.end ? goal.due_date : period.end;

            const inserted = insertTx({
              name: `Goal: ${goal.name}`,
              currency: goal.currency,
              requestedAmount: requestedOriginal,
              fundedAmount: fundedOriginal,
              type: "goal_allocation",
              date: allocationDate,
              period: period.key,
              sourceGoalId: goal.id,
              status: fundedLedger < remainingLedger ? "partial" : "funded",
              note: fundedLedger < remainingLedger ? "Partial goal allocation" : null
            });

            subtractPeriodAvailable(period, inserted.ledgerAmount);
            remainingLedger = Math.max(0, subtractMoneyAmounts(remainingLedger, inserted.ledgerAmount));
          }

          if (remainingLedger > 0.0001) {
            db.prepare(`
              INSERT INTO event_log (id, action, entity_type, entity_id, details, timestamp)
              VALUES (?, 'goal_impossible', 'goal', ?, ?, datetime('now'))
            `).run(
              generateId("event"),
              goal.id,
              JSON.stringify({
                goal: goal.name,
                missing_ledger: remainingLedger,
                ledger_currency: ledgerCurrency,
                due_date: goal.due_date
              })
            );

            if (notificationEnabled(settings, "goal_impossible")) {
              queueNotification(
                db,
                "goal_impossible",
                "Goal cannot be fully funded",
                `${goal.name} is missing ${remainingLedger.toFixed(2)} ${ledgerCurrency}`,
                notificationPriority(settings, "goal_impossible"),
                goal.id,
                `goal_impossible:${goal.id}`,
                settings
              );
            }

            queueFundingShortfallIfNeeded(
              goal.id,
              "Goal funding shortfall",
              `${goal.name} cannot be fully funded by ${goal.due_date}`
            );
          }
        }

        const discretionaryOperatingItems = [
          ...recurringExpenses
            .filter(expense => !expense.necessary)
            .map(expense => ({ kind: "recurring_expense", priority: expense.priority, item: expense })),
          ...flexes.map(flex => ({ kind: "flex", priority: flex.priority, item: flex }))
        ].sort((a, b) => {
          const priorityCompare = normalizePriority(a.priority) - normalizePriority(b.priority);
          if (priorityCompare !== 0) return priorityCompare;

          const createdCompare = String(a.item.created_at || "").localeCompare(String(b.item.created_at || ""));
          if (createdCompare !== 0) return createdCompare;

          return String(a.item.id || "").localeCompare(String(b.item.id || ""));
        });

        for (const [periodIndex, period] of periods.entries()) {
          if (period.blocked) continue;

          for (const entry of discretionaryOperatingItems) {
            if (spendableBalance(period) <= 0) break;

            if (entry.kind === "recurring_expense") {
              const expense = entry.item;

              for (const date of recurringOccurrencesInPeriod(expense, period, today)) {
                if (spendableBalance(period) <= 0) break;

                const predictedExpenseAmount = predictedAmountForRecurringExpense(
                  userId,
                  expense,
                  today,
                  date,
                  expense.prediction_strategy === "12month_max" ? predictionRowsForRun() : null
                );
                const converted = convert(predictedExpenseAmount, expense.currency, "expense");
                const requestedLedger = converted.ledgerAmount;
                const fundedLedger = Math.min(spendableBalance(period), requestedLedger);

                if (fundedLedger <= 0) continue;

                const fundedOriginal = toOriginalAmount(fundedLedger, converted.buffered);
                const status = fundedLedger < requestedLedger ? "partial" : "funded";

                const inserted = insertTx({
                  name: expense.name,
                  currency: expense.currency,
                  requestedAmount: predictedExpenseAmount,
                  fundedAmount: fundedOriginal,
                  type: "expense",
                  date,
                  period: period.key,
                  sourceRecurringExpenseId: expense.id,
                  status,
                  note: status === "partial" ? "Non-necessary transaction partially funded" : null
                });

                subtractPeriodAvailable(period, inserted.ledgerAmount);
              }

              continue;
            }

            const flex = entry.item;
            const targetLedger = roundMoneyAmount(flexTargetLedger.get(flex.id));
            if (targetLedger <= 0) continue;

            const alreadyFundedLedger = addMoneyAmounts(
              confirmedFlexFunding.get(flex.id),
              pendingFlexFunding.get(flex.id),
              generatedFlexFunding.get(flex.id)
            );

            const remainingLedger = Math.max(0, subtractMoneyAmounts(targetLedger, alreadyFundedLedger));

            if (remainingLedger <= 0.0001) continue;

            const converted = convert(1, flex.currency, "expense");

            let fundedLedger = 0;

            if (flex.allow_split) {
              const minLedger = multiplyMoney(flex.min_amount, converted.buffered);
              const maxLedger = flex.max_amount
                ? multiplyMoney(flex.max_amount, converted.buffered)
                : remainingLedger;

              fundedLedger = Math.min(spendableBalance(period), remainingLedger, maxLedger);

              if (fundedLedger < minLedger) {
                fundedLedger = 0;
              }
            } else {
              fundedLedger = spendableBalance(period) >= remainingLedger ? remainingLedger : 0;
            }

            if (fundedLedger <= 0) continue;

            const fundedOriginal = toOriginalAmount(fundedLedger, converted.buffered);
            const requestedOriginal = toOriginalAmount(remainingLedger, converted.buffered);

            const inserted = insertTx({
              name: flex.name,
              currency: flex.currency,
              requestedAmount: requestedOriginal,
              fundedAmount: fundedOriginal,
              type: "expense",
              date: period.start,
              period: period.key,
              sourceFlexId: flex.id,
              status: fundedLedger < remainingLedger ? "partial" : "funded",
              note: fundedLedger < remainingLedger ? "Flex transaction partially funded" : null
            });

            generatedFlexFunding.set(
              flex.id,
              addMoneyAmounts(generatedFlexFunding.get(flex.id), inserted.ledgerAmount)
            );

            subtractPeriodAvailable(period, inserted.ledgerAmount);
          }

          carrySurplusToNextPeriod(periodIndex);
        }

        for (const goal of goals) {
          const targetLedger = roundMoneyAmount(goalTargetLedger.get(goal.id));

          const alreadyFundedLedger = addMoneyAmounts(
            confirmedGoalFunding.get(goal.id),
            pendingGoalFunding.get(goal.id)
          );

          const futureAllocatedLedger = db.prepare(`
            SELECT COALESCE(SUM(ledger_amount), 0) AS v
            FROM future_transactions
            WHERE source_goal_id = ?
              AND COALESCE(ledger_currency, 'PLN') = ?
          `).get(goal.id, ledgerCurrency).v;

          const totalFundedLedger = addMoneyAmounts(alreadyFundedLedger, futureAllocatedLedger);

          if (
            totalFundedLedger >= targetLedger &&
            !previouslyFullyFundedGoals.has(goal.id) &&
            notificationEnabled(settings, "goal_funded")
          ) {
            queueNotification(
              db,
              "goal_funded",
              "Goal fully funded",
              `${goal.name} is now fully funded.`,
              notificationPriority(settings, "goal_funded"),
              goal.id,
              `goal_funded:${goal.id}`,
              settings
            );
          }
        }

        recalculatePlanningRunningBalances(db, userId);

        const totalProjectedIncome = roundMoneyAmount(db.prepare(`
          SELECT COALESCE(SUM(ledger_amount), 0) AS value
          FROM future_transactions
          WHERE type = 'income'
        `).get().value);

        const totalProjectedExpenses = roundMoneyAmount(db.prepare(`
          SELECT COALESCE(SUM(ledger_amount), 0) AS value
          FROM future_transactions
          WHERE type != 'income'
        `).get().value);

        const warningCount = db.prepare(`
          SELECT COUNT(*) AS value
          FROM future_transactions
          WHERE status IN ('partial', 'underfunded')
        `).get().value;

        const availableBalance = addMoneyAmounts(...periods.map(p => p.available));

        if (previousSnapshot && fxRatesChanged && notificationEnabled(settings, "fx_changed")) {
          const oldIncome = Number(previousSnapshot.total_projected_income || 0);
          const oldExpenses = Number(previousSnapshot.total_projected_expenses || 0);
          const oldBalance = Number(previousSnapshot.available_balance || 0);

          const materiallyChanged =
            Math.abs(oldIncome - totalProjectedIncome) >= 0.01 ||
            Math.abs(oldExpenses - totalProjectedExpenses) >= 0.01 ||
            Math.abs(oldBalance - availableBalance) >= 0.01 ||
            Number(previousSnapshot.warning_count || 0) !== Number(warningCount || 0);

          if (materiallyChanged) {
            queueNotification(
              db,
              "fx_changed",
              "FX change affected projections",
              "Projection totals, available balance, or warning count changed after recalculation.",
              notificationPriority(settings, "fx_changed"),
              "fx_changed",
              `fx_changed:${generationTimestamp.slice(0, 10)}`,
              settings
            );
          }
        }

        db.prepare(`
          INSERT INTO projection_snapshots (
            id,
            snapshot_timestamp,
            total_projected_income,
            total_projected_expenses,
            available_balance,
            fx_rates_used,
            ledger_currency,
            generation_succeeded,
            warning_count,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
        `).run(
          generateId("snapshot"),
          generationTimestamp,
          totalProjectedIncome,
          totalProjectedExpenses,
          availableBalance,
          currentFxJson,
          ledgerCurrency,
          warningCount
        );
      })();

      logServerEvent("cashflow_projections_regenerated", {
        userId,
        periodCount: periods.length
      });
    } finally {
      db.close();
    }
  }

  return {
    regenerateProjections
  };
}
