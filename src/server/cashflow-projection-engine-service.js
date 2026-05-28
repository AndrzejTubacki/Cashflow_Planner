import { DEFAULT_FUTURE_PERIODS } from "./cashflow-constants.js";
import { recurringOccurrencesInPeriod, todayWarsaw } from "./cashflow-date-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { getBufferedFxForCurrency } from "./cashflow-money-utils.js";
import { makeOccurrenceKey } from "./cashflow-occurrence-utils.js";
import { normalizePriority } from "./cashflow-priority-utils.js";
import { buildBudgetPeriods } from "./cashflow-period-utils.js";

export function createCashflowProjectionEngineService({
  confirmedOccurrenceKeys,
  confirmedOneOffSourceIds,
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

      if (settings?.ledger_currency && settings.ledger_currency !== "PLN") {
        throw new Error("Only PLN ledger currency is supported");
      }

      const fxSnapshot = safeGetCurrentFxSnapshot(userId) || getCachedFxSnapshot(userId);
      const generationTimestamp = new Date().toISOString();
      const today = todayWarsaw();

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

      const periods = buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods);
      const handledOccurrenceKeys = confirmedOccurrenceKeys(userId);
      const handledOneOffIds = confirmedOneOffSourceIds(userId);

      const confirmedGoalFunding = new Map();
      const pendingGoalFunding = new Map();
      const confirmedFlexFunding = new Map();
      const pendingFlexFunding = new Map();
      const generatedFlexFunding = new Map();

      for (const goal of goals) {
        confirmedGoalFunding.set(
          goal.id,
          sumConfirmedFunding(userId, "source_goal_id", goal.id, "PLN", settings)
        );

        pendingGoalFunding.set(
          goal.id,
          sumPendingFunding(userId, "source_goal_id", goal.id, "PLN", settings)
        );
      }

      for (const flex of flexes) {
        confirmedFlexFunding.set(
          flex.id,
          sumConfirmedFunding(userId, "source_flex_id", flex.id, "PLN", settings)
        );

        pendingFlexFunding.set(
          flex.id,
          sumPendingFunding(userId, "source_flex_id", flex.id, "PLN", settings)
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
          ledgerAmount: Number(amount || 0) * rates.buffered
        };
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
            `).get(goal.id).v;

            const total =
              Number(confirmedGoalFunding.get(goal.id) || 0) +
              Number(pendingGoalFunding.get(goal.id) || 0) +
              Number(futureAllocatedLedger || 0);

            return total >= Number(goalTargetLedger.get(goal.id) || 0);
          })
          .map(goal => goal.id)
      );

      const insertFuture = db.prepare(`
        INSERT INTO future_transactions (
          id, name, currency, amount, type, date, period,
          source_recurring_expense_id, source_recurring_income_id, source_one_off_id,
          source_flex_id, source_goal_id,
          fx_rate, buffered_fx_rate, requested_amount, funded_amount, ledger_amount,
          status, note, occurrence_key, generation_timestamp, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
        note = null
      }) {
        const occurrenceKey = makeOccurrenceKey({
          type,
          date,
          sourceRecurringExpenseId,
          sourceRecurringIncomeId,
          sourceOneOffId,
          sourceFlexId,
          sourceGoalId
        });

        const conversionType = type === "income" ? "income" : "expense";
        const converted = convert(fundedAmount, currency, conversionType);

        if (sourceOneOffId && handledOneOffIds.has(sourceOneOffId)) {
          return {
            inserted: false,
            ledgerAmount: 0,
            alreadyConfirmed: true
          };
        }

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
            requestedAmount,
            fundedAmount,
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
            ledgerAmount: Number(refreshedPending.ledger_amount_delta || 0),
            fx: converted.fx,
            buffered: converted.buffered
          };
        }

        insertFuture.run(
          generateId("fut"),
          name,
          currency,
          fundedAmount,
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
          requestedAmount,
          fundedAmount,
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

      function carryCurrentSurplusToNextPeriod() {
        const currentPeriod = periods[0];
        const nextPeriod = periods[1];

        if (!currentPeriod || !nextPeriod) return;
        if (currentPeriod.blocked || Number(currentPeriod.available || 0) <= 0) return;

        const hasGoalDueThisPeriod = goals.some(goal =>
          goal.due_date >= today &&
          goal.due_date <= currentPeriod.end
        );

        if (hasGoalDueThisPeriod) return;

        nextPeriod.available += Number(currentPeriod.available || 0);
        currentPeriod.available = 0;
      }

      db.transaction(() => {
        db.prepare("DELETE FROM future_transactions").run();

        for (const occurrenceKey of handledOccurrenceKeys) {
          deletePendingOccurrence(db, occurrenceKey);
        }

        for (const oneOffId of handledOneOffIds) {
          db.prepare("DELETE FROM pending_transactions WHERE source_one_off_id = ?").run(oneOffId);
        }

        if (periods.length) {
          periods[0].available += Math.max(0, planningOpeningBalance(db, userId));
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
              const predictedIncomeAmount = predictedAmountForRecurringIncome(userId, income, today);

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

              period.available += inserted.ledgerAmount;
            }
          }

          for (const oneOff of oneOffs) {
            if (handledOneOffIds.has(oneOff.id)) continue;
            if (oneOff.date < today) continue;

            const targetPeriod = periodForDate(oneOff.date);
            if (!targetPeriod || targetPeriod.key !== period.key) continue;

            const requestedConversion = convert(oneOff.amount, oneOff.currency, oneOff.type);
            const requestedLedger = requestedConversion.ledgerAmount;

            if (oneOff.type === "income") {
              const inserted = insertTx({
                name: oneOff.name,
                currency: oneOff.currency,
                requestedAmount: oneOff.amount,
                fundedAmount: oneOff.amount,
                type: "income",
                date: oneOff.date,
                period: period.key,
                sourceOneOffId: oneOff.id
              });

              period.available += inserted.ledgerAmount;
              continue;
            }

            if (period.available < requestedLedger) {
              insertTx({
                name: oneOff.name,
                currency: oneOff.currency,
                requestedAmount: oneOff.amount,
                fundedAmount: 0,
                type: "expense",
                date: oneOff.date,
                period: period.key,
                sourceOneOffId: oneOff.id,
                status: "underfunded",
                note: "One-off expense requires full funding and could not be funded"
              });

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
              requestedAmount: oneOff.amount,
              fundedAmount: oneOff.amount,
              type: "expense",
              date: oneOff.date,
              period: period.key,
              sourceOneOffId: oneOff.id
            });

            period.available -= inserted.ledgerAmount;
          }

          if (period.blocked) continue;

          for (const expense of recurringExpenses.filter(e => e.necessary)) {
            for (const date of recurringOccurrencesInPeriod(expense, period, today)) {
              const predictedExpenseAmount = predictedAmountForRecurringExpense(userId, expense, today);
              const converted = convert(predictedExpenseAmount, expense.currency, "expense");
              const requestedLedger = converted.ledgerAmount;

              if (period.available <= 0) {
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

              const fundedLedger = Math.min(period.available, requestedLedger);
              const fundedOriginal = fundedLedger / converted.buffered;
              const status = fundedLedger < requestedLedger ? "partial" : "funded";
              const missingOriginal = Math.max(0, predictedExpenseAmount - fundedOriginal);

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

              period.available -= inserted.ledgerAmount;

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

          if (periodIndex === 0) {
            carryCurrentSurplusToNextPeriod();
          }
        }

        for (const goal of goals) {
          const targetLedger = Number(goalTargetLedger.get(goal.id) || 0);

          let remainingLedger = Math.max(
            0,
            targetLedger -
            Number(confirmedGoalFunding.get(goal.id) || 0) -
            Number(pendingGoalFunding.get(goal.id) || 0)
          );

          const eligiblePeriods = periods
            .filter(p => !p.blocked && p.start <= goal.due_date)
            .sort((a, b) => b.start.localeCompare(a.start));

          for (const period of eligiblePeriods) {
            if (remainingLedger <= 0) break;
            if (period.available <= 0) continue;

            const converted = convert(1, goal.currency, "expense");
            const fundedLedger = Math.min(remainingLedger, period.available);
            const fundedOriginal = fundedLedger / converted.buffered;
            const requestedOriginal = remainingLedger / converted.buffered;
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

            period.available -= inserted.ledgerAmount;
            remainingLedger -= inserted.ledgerAmount;
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
                ledger_currency: "PLN",
                due_date: goal.due_date
              })
            );

            if (notificationEnabled(settings, "goal_impossible")) {
              queueNotification(
                db,
                "goal_impossible",
                "Goal cannot be fully funded",
                `${goal.name} is missing ${remainingLedger.toFixed(2)} PLN`,
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

        for (const period of periods) {
          if (period.blocked) continue;

          for (const entry of discretionaryOperatingItems) {
            if (period.available <= 0) break;

            if (entry.kind === "recurring_expense") {
              const expense = entry.item;

              for (const date of recurringOccurrencesInPeriod(expense, period, today)) {
                if (period.available <= 0) break;

                const predictedExpenseAmount = predictedAmountForRecurringExpense(userId, expense, today);
                const converted = convert(predictedExpenseAmount, expense.currency, "expense");
                const requestedLedger = converted.ledgerAmount;
                const fundedLedger = Math.min(period.available, requestedLedger);

                if (fundedLedger <= 0) continue;

                const fundedOriginal = fundedLedger / converted.buffered;
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

                period.available -= inserted.ledgerAmount;
              }

              continue;
            }

            const flex = entry.item;
            const targetLedger = Number(flexTargetLedger.get(flex.id) || 0);
            if (targetLedger <= 0) continue;

            const alreadyFundedLedger =
              Number(confirmedFlexFunding.get(flex.id) || 0) +
              Number(pendingFlexFunding.get(flex.id) || 0) +
              Number(generatedFlexFunding.get(flex.id) || 0);

            const remainingLedger = Math.max(0, targetLedger - alreadyFundedLedger);

            if (remainingLedger <= 0.0001) continue;

            const converted = convert(1, flex.currency, "expense");

            let fundedLedger = 0;

            if (flex.allow_split) {
              const minLedger = Number(flex.min_amount || 0) * converted.buffered;
              const maxLedger = flex.max_amount
                ? Number(flex.max_amount || 0) * converted.buffered
                : remainingLedger;

              fundedLedger = Math.min(period.available, remainingLedger, maxLedger);

              if (fundedLedger < minLedger) {
                fundedLedger = 0;
              }
            } else {
              fundedLedger = period.available >= remainingLedger ? remainingLedger : 0;
            }

            if (fundedLedger <= 0) continue;

            const fundedOriginal = fundedLedger / converted.buffered;
            const requestedOriginal = remainingLedger / converted.buffered;

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
              Number(generatedFlexFunding.get(flex.id) || 0) + inserted.ledgerAmount
            );

            period.available -= inserted.ledgerAmount;
          }
        }

        for (const goal of goals) {
          const targetLedger = Number(goalTargetLedger.get(goal.id) || 0);

          const alreadyFundedLedger =
            Number(confirmedGoalFunding.get(goal.id) || 0) +
            Number(pendingGoalFunding.get(goal.id) || 0);

          const futureAllocatedLedger = db.prepare(`
            SELECT COALESCE(SUM(ledger_amount), 0) AS v
            FROM future_transactions
            WHERE source_goal_id = ?
          `).get(goal.id).v;

          const totalFundedLedger = alreadyFundedLedger + Number(futureAllocatedLedger || 0);

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

        const totalProjectedIncome = db.prepare(`
          SELECT COALESCE(SUM(ledger_amount), 0) AS value
          FROM future_transactions
          WHERE type = 'income'
        `).get().value;

        const totalProjectedExpenses = db.prepare(`
          SELECT COALESCE(SUM(ledger_amount), 0) AS value
          FROM future_transactions
          WHERE type != 'income'
        `).get().value;

        const warningCount = db.prepare(`
          SELECT COUNT(*) AS value
          FROM future_transactions
          WHERE status IN ('partial', 'underfunded')
        `).get().value;

        const availableBalance = periods.reduce((sum, p) => sum + Number(p.available || 0), 0);

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
            generation_succeeded,
            warning_count,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
        `).run(
          generateId("snapshot"),
          generationTimestamp,
          totalProjectedIncome,
          totalProjectedExpenses,
          availableBalance,
          currentFxJson,
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
