import { recoveryWindow } from "../engine/recovery-window.js";
import { normalizeSqliteBindValue } from "./cashflow-sqlite-bind-utils.js";
import { recordSqliteFinancialChange } from "./cashflow-financial-journal.js";
import { DEFAULT_FUTURE_PERIODS, DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { todayInTimezone } from "./cashflow-date-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { roundMoneyAmount } from "./cashflow-money-utils.js";
import { periodAnchorOverridesForIncome } from "./cashflow-period-utils.js";

import {
  computeProjectionPlan as computeProjectionPlanCore,
  buildProjectionFundingState, buildProjectionInputRowsFromPlanningTables, buildFutureProjectionSummaryFromRows, makeProjectionConverter, computeGoalAndFlexTargetLedgerAmounts, findLockedReserveClaims, computeReserveClaims, fundingMapsFromRows, orderOneOffsIncomesFirst
} from "../engine/cashflow-projection.js";
export { buildProjectionFundingState, buildProjectionInputRowsFromPlanningTables, buildFutureProjectionSummaryFromRows, makeProjectionConverter, computeGoalAndFlexTargetLedgerAmounts, findLockedReserveClaims, computeReserveClaims, fundingMapsFromRows, orderOneOffsIncomesFirst };

// Preserve Node callers' defaults without leaking Node crypto or clocks into core.
export function computeProjectionPlan(options) {
  return computeProjectionPlanCore({
    ...options,
    generateId: options.generateId ?? generateId,
    generationTimestamp: options.generationTimestamp ?? new Date().toISOString(),
    notificationToday: options.notificationToday ?? todayInTimezone(options.settings?.timezone || DEFAULT_TIMEZONE)
  });
}

export async function loadProjectionFundingStateFromBudgetStore({
  budgetId,
  budgetStore,
  flexes = [],
  goals = [],
  ledgerCurrency = "PLN",
  goalTargetLedger = new Map(),
  flexTargetLedger = new Map()
} = {}) {
  if (!budgetStore || typeof budgetStore.listPlanningRows !== "function") {
    throw new Error("A budget store with listPlanningRows() is required");
  }
  if (typeof budgetStore.listConfirmedTransactions !== "function") {
    throw new Error("A budget store with listConfirmedTransactions() is required");
  }
  const normalizedBudgetId = String(budgetId || "").trim();
  if (!normalizedBudgetId) {
    throw new Error("budgetId is required");
  }

  const [pendingRows, futureRows] = await readProjectionParts(budgetStore, [
    () => budgetStore.listPlanningRows(normalizedBudgetId, "pending_transactions"),
    () => budgetStore.listPlanningRows(normalizedBudgetId, "future_transactions")
  ]);
  let confirmedRows = [];
  if (typeof budgetStore.listLedgerYears === "function") {
    for (const year of await budgetStore.listLedgerYears(normalizedBudgetId)) {
      confirmedRows.push(...(await budgetStore.listConfirmedTransactions(normalizedBudgetId, {
        ledgerYear: Number(year)
      })));
    }
  } else {
    confirmedRows = await budgetStore.listConfirmedTransactions(normalizedBudgetId);
  }

  return buildProjectionFundingState({
    confirmedFunding: fundingMapsFromRows(confirmedRows, ledgerCurrency),
    flexes,
    futureRows,
    goals,
    goalTargetLedger,
    ledgerCurrency,
    pendingRows,
    flexTargetLedger
  });
}

const PROJECTION_INPUT_TABLES = [
  "settings",
  "planned_transactions",
  "recurring_expenses",
  "recurring_incomes",
  "flex_transactions",
  "goals",
  "one_off_transactions",
  "pending_transactions",
  "future_transactions",
  "projection_snapshots"
];

/** Pool-backed reads may run concurrently; a borrowed PostgreSQL connection
 * must finish each query before starting the next (required by pg 9). */
async function readProjectionParts(store, readers) {
  if (!store.transactionBound) return Promise.all(readers.map(read => read()));
  const result = [];
  for (const read of readers) result.push(await read());
  return result;
}

export async function loadProjectionInputRowsFromBudgetStore({
  budgetId,
  budgetStore,
  settings = null
} = {}) {
  if (!budgetStore || typeof budgetStore.listPlanningRows !== "function") {
    throw new Error("A budget store with listPlanningRows() is required");
  }
  const normalizedBudgetId = String(budgetId || "").trim();
  if (!normalizedBudgetId) {
    throw new Error("budgetId is required");
  }

  const tables = {};
  await readProjectionParts(budgetStore, PROJECTION_INPUT_TABLES.map(tableName => async () => {
    tables[tableName] = await budgetStore.listPlanningRows(normalizedBudgetId, tableName);
  }));

  const resolvedSettings = settings || tables.settings?.[0] || {};
  return {
    settings: resolvedSettings,
    tables,
    ...buildProjectionInputRowsFromPlanningTables({
      settings: resolvedSettings,
      tables
    })
  };
}

const PROJECTION_WARNING_EVENT_ACTIONS = [
  "funding_shortfall",
  "goal_impossible",
  "necessary_underfunded"
];

function normalizePlanArray(plan, field) {
  const value = plan?.[field] || [];
  if (!Array.isArray(value)) {
    throw new Error(`Projection generation plan field must be an array: ${field}`);
  }
  return value;
}

function assertProjectionWriter(writer) {
  const required = [
    "deletePendingTransactionsByOccurrenceKeys",
    "deleteProjectionEventLogs",
    "insertPlanningRows",
    "replacePlanningRows",
    "upsertNotifications"
  ];
  for (const method of required) {
    if (typeof writer?.[method] !== "function") {
      throw new Error(`Budget-store writer must implement ${method}`);
    }
  }
}

export async function applyProjectionGenerationPlanToBudgetStore({
  budgetId,
  budgetStore,
  plan = {},
  afterWrite = null
} = {}) {
  const normalizedBudgetId = String(budgetId || "").trim();
  if (!normalizedBudgetId) {
    throw new Error("budgetId is required");
  }
  if (!budgetStore || typeof budgetStore !== "object") {
    throw new Error("A budget-store writer is required");
  }
  if (afterWrite !== null && typeof afterWrite !== "function") throw new Error("afterWrite must be a function");
  if (afterWrite && typeof budgetStore.transaction !== "function" && typeof budgetStore.planningTransaction !== "function") {
    throw new Error("Atomic afterWrite requires a transactional budget store");
  }

  const futureRows = normalizePlanArray(plan, "futureRows");
  const pendingRows = normalizePlanArray(plan, "pendingRows");
  const pendingOccurrenceKeys = normalizePlanArray(plan, "deletePendingOccurrenceKeys");
  const eventRows = normalizePlanArray(plan, "eventRows");
  const notificationRows = normalizePlanArray(plan, "notificationRows");
  const projectionSnapshotRows = normalizePlanArray(plan, "projectionSnapshotRows");
  const eventActionsToClear = normalizePlanArray({
    eventActionsToClear: plan.eventActionsToClear || PROJECTION_WARNING_EVENT_ACTIONS
  }, "eventActionsToClear");

  const write = async writer => {
    assertProjectionWriter(writer);
    const futureSummary = buildFutureProjectionSummaryFromRows(futureRows);
    const pendingDelete = await writer.deletePendingTransactionsByOccurrenceKeys(normalizedBudgetId, pendingOccurrenceKeys);
    const futureReplace = await writer.replacePlanningRows(normalizedBudgetId, "future_transactions", futureRows);
    const eventDelete = await writer.deleteProjectionEventLogs(normalizedBudgetId, eventActionsToClear);
    const pendingInsert = pendingRows.length
      ? await writer.insertPlanningRows(normalizedBudgetId, "pending_transactions", pendingRows)
      : { inserted: 0 };
    const eventInsert = eventRows.length
      ? await writer.insertPlanningRows(normalizedBudgetId, "event_log", eventRows)
      : { inserted: 0 };
    const notificationUpsert = notificationRows.length
      ? await writer.upsertNotifications(normalizedBudgetId, notificationRows)
      : { upserted: 0 };
    const snapshotInsert = projectionSnapshotRows.length
      ? await writer.insertPlanningRows(normalizedBudgetId, "projection_snapshots", projectionSnapshotRows)
      : { inserted: 0 };
    // The callback receives the transaction-bound writer, never a fresh pool.
    // A balance update failure must roll back projection rows and snapshot too.
    if (afterWrite) await afterWrite(writer);

    return {
      eventRowsInserted: Number(eventInsert?.inserted || 0),
      futureRowsInserted: Number(futureReplace?.inserted || 0),
      futureSummary,
      notificationsUpserted: Number(notificationUpsert?.upserted || 0),
      pendingOccurrencesDeleted: Number(pendingDelete?.deleted || 0),
      pendingRowsInserted: Number(pendingInsert?.inserted || 0),
      projectionEventsDeleted: Number(eventDelete?.deleted || 0),
      projectionSnapshotsInserted: Number(snapshotInsert?.inserted || 0)
    };
  };

  const summary = typeof budgetStore.planningTransaction === "function"
    ? await budgetStore.planningTransaction(normalizedBudgetId, write)
    : typeof budgetStore.transaction === "function"
      ? await budgetStore.transaction(write)
      : await write(budgetStore);

  return {
    ...summary,
    ok: true
  };
}

export function createCashflowProjectionEngineService({
  budgetStore = null,
  confirmedBalanceAsOf = null,
  confirmedBalanceAsOfAsync = null,
  confirmedFundingTotals = null,
  confirmedOccurrenceKeys,
  confirmedOccurrenceKeysAsync = null,
  confirmedRowsAfterDate = null,
  confirmedRowsAfterDateAsync = null,
  confirmedOneOffProgress,
  confirmedOneOffProgressAsync = null,
  confirmedRowsForPrediction = null,
  confirmedRowsForPredictionAsync = null,
  deletePendingOccurrence,
  getCachedFxSnapshot,
  getCachedFxSnapshotAsync = null,
  logServerEvent,
  notificationEnabled,
  notificationPriority,
  openPlanningDb,
  planningOpeningBalance,
  predictedAmountForRecurringExpense,
  predictedAmountForRecurringIncome,
  queueNotification,
  recalculatePlanningRunningBalances,
  recalculatePlanningRunningBalancesAsync = null,
  refreshPendingOccurrence,
  safeGetCurrentFxSnapshot,
  safeGetCurrentFxSnapshotAsync = null,
  sumConfirmedFunding,
  sumPendingFunding
}) {
  /**
   * Async/backend-neutral counterpart to regenerateProjections. Requires a
   * budget store plus its async companion helpers (all already exist and are
   * used elsewhere once a Postgres budget store is configured). Both storage
   * paths call the same computeProjectionPlan financial core.
   */
  // Explicit store injection joins both input reads and output writes to the
  // caller's transaction; default callers retain the existing store behavior.
  async function regenerateProjectionsAsync(budgetId, store = budgetStore, options = {}) {
    if (!store) throw new Error("A budget store is required for regenerateProjectionsAsync");
    // Independent refreshes must lock before reading inputs, not only while
    // applying their derived rows. Composed source mutations own their revision.
    if (store.backend === "postgres" && !store.transactionBound) {
      return store.transaction(async writer => {
        await writer.lockBudgetLedger(budgetId);
        const result = await regenerateProjectionsAsync(budgetId, writer, options);
        await writer.recordFinancialChange(budgetId, "projection");
        return result;
      });
    }
    for (const [name, fn] of Object.entries({
      confirmedBalanceAsOfAsync,
      confirmedOccurrenceKeysAsync,
      confirmedOneOffProgressAsync,
      confirmedRowsAfterDateAsync,
      confirmedRowsForPredictionAsync,
      getCachedFxSnapshotAsync,
      recalculatePlanningRunningBalancesAsync,
      safeGetCurrentFxSnapshotAsync
    })) {
      if (typeof fn !== "function") {
        throw new Error(`${name} is required for regenerateProjectionsAsync`);
      }
    }

    const {
      settings,
      tables,
      flexes,
      goals,
      oneOffs,
      pendingPeriodIncomeRows,
      previousSnapshot,
      recurringExpenses,
      recurringIncomes
    } = await loadProjectionInputRowsFromBudgetStore({ budgetId, budgetStore: store });

    const ledgerCurrency = settings?.ledger_currency || "PLN";
    const today = todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE);
    const futurePeriods = Number(settings?.future_periods) || DEFAULT_FUTURE_PERIODS;
    const reserveFloor = Number(settings?.minimum_reserve_enabled || 0) === 1
      ? Math.max(0, roundMoneyAmount(settings?.minimum_reserve_amount || 0))
      : 0;

    const fxSnapshot = (await safeGetCurrentFxSnapshotAsync(budgetId, store)) || (await getCachedFxSnapshotAsync(budgetId, null, store));
    const predictionRows = await confirmedRowsForPredictionAsync(budgetId, today, null, store);

    const periodAnchorOverrides = periodAnchorOverridesForIncome(
      settings?.budget_period_income_id,
      [...predictionRows, ...pendingPeriodIncomeRows]
    );
    const recovery = recoveryWindow({ settings, recurringIncomes, today, futurePeriods,
      anchorOverrides: periodAnchorOverrides,
      candidates: tables.future_transactions || [], regeneratedRows: options.recoverPendingRows || [] });
    const periods = recovery.periods;

    const convert = makeProjectionConverter({ settings, fxSnapshot, ledgerCurrency });
    const { goalTargetLedger, flexTargetLedger } = computeGoalAndFlexTargetLedgerAmounts({ goals, flexes, convert });

    const fundingState = await loadProjectionFundingStateFromBudgetStore({
      budgetId,
      budgetStore: store,
      flexes,
      goals,
      ledgerCurrency,
      goalTargetLedger,
      flexTargetLedger
    });

    const [handledOccurrenceKeys, oneOffProgress, confirmedRowsAfterToday, openingBalance] = await readProjectionParts(store, [
      () => confirmedOccurrenceKeysAsync(budgetId, store),
      () => confirmedOneOffProgressAsync(budgetId, store),
      () => confirmedRowsAfterDateAsync(budgetId, today, settings, store),
      () => confirmedBalanceAsOfAsync(budgetId, today, settings, store)
    ]);

    const sharedPlanInputs = {
      recoveryOccurrenceKeys: recovery.recoveryOccurrenceKeys,
      currentPeriodStart: recovery.currentPeriodStart,
      confirmedRowsAfterToday,
      convert,
      flexes,
      flexTargetLedger,
      fundingState,
      fxSnapshot,
      goals,
      goalTargetLedger,
      handledOccurrenceKeys,
      ledgerCurrency,
      oneOffProgress,
      oneOffs,
      openingBalance,
      pendingRows: tables.pending_transactions || [],
      predictionRows,
      previousSnapshot,
      recurringExpenses,
      recurringIncomes,
      reserveFloor,
      settings,
      today
    };

    // Two passes: the first (discoveryOnly) runs the real necessities-only
    // logic — unmodified, so it reflects the same local-demand retention
    // that would otherwise cause the bug — purely to find which periods end
    // up short and which earlier periods are holding surplus that could
    // cover it. That result feeds reserveClaims into the second, real pass.
    // Both passes need their own untouched `periods` array since .available
    // is mutated in place; everything else here is read-only within
    // computeProjectionPlan and safe to share across both calls.
    const discoveryPeriods = periods.map(period => ({ ...period }));
    const discovery = computeProjectionPlan({
      ...sharedPlanInputs,
      discoveryOnly: true,
      periods: discoveryPeriods
    });
    // Reserve transfers already pending/confirmed on one side (e.g. a user
    // manually moved or confirmed the expense or income half) must not be
    // re-derived from scratch — see computeReserveClaims and findLockedReserveClaims.
    const lockedReserveClaims = findLockedReserveClaims([
      ...predictionRows,
      ...confirmedRowsAfterToday,
      ...(tables.pending_transactions || [])
    ], ledgerCurrency);
    const reserveClaims = computeReserveClaims({
      periods: discoveryPeriods,
      periodsAvailable: discovery.periodsAvailable,
      deficitsByPeriod: discovery.deficitsByPeriod,
      lockedClaims: lockedReserveClaims
    });

    const plan = computeProjectionPlan({
      ...sharedPlanInputs,
      periods,
      reserveClaims
    });

    const applyResult = await applyProjectionGenerationPlanToBudgetStore({ budgetId, budgetStore: store, plan,
      afterWrite: store.backend === "sqlite"
        ? null : writer => recalculatePlanningRunningBalancesAsync(budgetId, writer) });
    // The SQLite async compatibility path cannot read yearly ledger files through
    // a planning-only writer. Production SQLite uses the synchronous atomic path.
    if (store.backend === "sqlite") await recalculatePlanningRunningBalancesAsync(budgetId, store);

    logServerEvent("cashflow_projections_regenerated", {
      userId: budgetId,
      periodCount: periods.length
    });

    return applyResult;
  }

  /** SQLite keeps its synchronous public API, but delegates all financial
   * decisions to the same row-based core used by PostgreSQL and the app bundle. */
  function regenerateProjections(userId, transactionDb = null, options = {}) {
    // Borrow an outer planning transaction without closing its connection.
    const db = transactionDb || openPlanningDb(userId);
    try {
      db.transaction(() => {
        const settings = db.prepare("SELECT * FROM settings WHERE id = 1").get() || {};
        const tables = Object.fromEntries(PROJECTION_INPUT_TABLES
          .map(name => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
        const rows = buildProjectionInputRowsFromPlanningTables({ settings, tables });
        const ledgerCurrency = settings.ledger_currency || "PLN";
        const today = todayInTimezone(settings.timezone || DEFAULT_TIMEZONE);
        const generationTimestamp = new Date().toISOString();
        const fxSnapshot = safeGetCurrentFxSnapshot(userId, db) || getCachedFxSnapshot(userId, null, db);
        const predictionRows = confirmedRowsForPrediction(userId, today);
        const anchorOverrides = periodAnchorOverridesForIncome(settings.budget_period_income_id,
          [...predictionRows, ...rows.pendingPeriodIncomeRows]);
        const futurePeriods = Number(settings.future_periods) || DEFAULT_FUTURE_PERIODS;
        const convert = makeProjectionConverter({ settings, fxSnapshot, ledgerCurrency });
        const targets = computeGoalAndFlexTargetLedgerAmounts({ ...rows, convert });
        const confirmedFunding = confirmedFundingTotals(userId, ledgerCurrency, settings);
        const confirmedRows = confirmedRowsAfterDate(db, userId, today);
        const recovery = recoveryWindow({ settings, recurringIncomes: rows.recurringIncomes, today, futurePeriods, anchorOverrides,
          candidates: tables.future_transactions, regeneratedRows: options.recoverPendingRows || [] });
        const shared = {
          recoveryOccurrenceKeys: recovery.recoveryOccurrenceKeys, currentPeriodStart: recovery.currentPeriodStart,
          ...rows, ...targets, convert, settings, today, generationTimestamp, fxSnapshot,
          ledgerCurrency, pendingRows: tables.pending_transactions, predictionRows,
          confirmedRowsAfterToday: confirmedRows,
          handledOccurrenceKeys: confirmedOccurrenceKeys(userId),
          oneOffProgress: confirmedOneOffProgress(userId),
          openingBalance: confirmedBalanceAsOf(db, userId, today),
          reserveFloor: Number(settings.minimum_reserve_enabled || 0) === 1
            ? Math.max(0, roundMoneyAmount(settings.minimum_reserve_amount || 0)) : 0
        };
        function inputs() {
          return { ...shared,
            periods: recovery.periods.map(period => ({ ...period })),
            fundingState: buildProjectionFundingState({ ...rows, ...targets, ledgerCurrency,
              confirmedFunding, pendingRows: tables.pending_transactions, futureRows: tables.future_transactions }) };
        }
        const discoveryInputs = inputs();
        const discovery = computeProjectionPlan({ ...discoveryInputs, discoveryOnly: true });
        const reserveClaims = computeReserveClaims({ periods: discoveryInputs.periods,
          periodsAvailable: discovery.periodsAvailable, deficitsByPeriod: discovery.deficitsByPeriod,
          lockedClaims: findLockedReserveClaims([...predictionRows, ...confirmedRows, ...tables.pending_transactions], ledgerCurrency) });
        const plan = computeProjectionPlan({ ...inputs(), reserveClaims });
        for (const key of plan.deletePendingOccurrenceKeys) {
          db.prepare("DELETE FROM pending_transactions WHERE occurrence_key = ?").run(key);
        }
        db.prepare("DELETE FROM future_transactions").run();
        for (const action of PROJECTION_WARNING_EVENT_ACTIONS) {
          db.prepare("DELETE FROM event_log WHERE action = ?").run(action);
        }
        // Restrict writes to real schema columns; runtime row defaults remain
        // database defaults, and JSON/boolean bindings use the existing adapter.
        function insert(table, values) {
          const allowed = new Set(db.pragma(`table_info(${table})`).map(column => column.name));
          for (const row of values) {
            const columns = Object.keys(row).filter(key => allowed.has(key));
            const quoted = columns.map(key => `"${key}"`).join(", ");
            db.prepare(`INSERT INTO "${table}" (${quoted}) VALUES (${columns.map(() => "?").join(", ")})`)
              .run(columns.map(key => normalizeSqliteBindValue(row[key])));
          }
        }
        insert("future_transactions", plan.futureRows);
        insert("pending_transactions", plan.pendingRows);
        insert("event_log", plan.eventRows);
        for (const row of plan.notificationRows) {
          db.prepare(`INSERT INTO notification_queue
            (id, notification_type, title, message, priority, entity_id, queued_at, dedupe_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dedupe_key) DO UPDATE SET title=excluded.title, message=excluded.message,
              priority=excluded.priority, queued_at=excluded.queued_at`)
            .run(row.id, row.notification_type, row.title, row.message, row.priority,
              row.entity_id, row.queued_at, row.dedupe_key);
        }
        recalculatePlanningRunningBalances(db, userId);
        insert("projection_snapshots", plan.projectionSnapshotRows);
        // A caller-owned planning transaction records its own source revision;
        // an independent regeneration must invalidate previously issued cursors.
        if (!transactionDb) recordSqliteFinancialChange(db, userId, "projection");
        logServerEvent("cashflow_projections_regenerated", { userId, periodCount: discoveryInputs.periods.length });
      }).immediate();
    } finally { if (!transactionDb) db.close(); }
  }

  return {
    regenerateProjections,
    regenerateProjectionsAsync
  };
}
