import { DEFAULT_FUTURE_PERIODS, DEFAULT_TIMEZONE } from "./cashflow-constants.js";
import { recurringOccurrencesInPeriod, todayInTimezone } from "./cashflow-date-utils.js";
import { generateId } from "./cashflow-id-utils.js";
import { addMoneyAmounts, getBufferedFxForCurrency, multiplyMoney, roundMoneyAmount, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import { buildNotificationQueueRow, notificationEnabled, notificationPriority } from "./cashflow-notification-service.js";
import { makeOccurrenceKey } from "./cashflow-occurrence-utils.js";
import { normalizePriority } from "./cashflow-priority-utils.js";
import {
  predictedAmountForRecurringExpensePure,
  predictedAmountForRecurringIncomePure
} from "./cashflow-prediction-service.js";
import {
  buildBudgetPeriods,
  periodAnchorOverridesForIncome
} from "./cashflow-period-utils.js";

function isActiveValue(value) {
  return value === true || Number(value || 0) === 1;
}

function textValue(value) {
  return String(value || "");
}

function numericPriority(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function compareByFields(fields) {
  return (a, b) => {
    for (const field of fields) {
      const aValue = typeof field.value === "function" ? field.value(a) : a[field.name];
      const bValue = typeof field.value === "function" ? field.value(b) : b[field.name];
      const compare = field.numeric
        ? numericPriority(aValue) - numericPriority(bValue)
        : textValue(aValue).localeCompare(textValue(bValue));
      if (compare !== 0) return compare;
    }
    return 0;
  };
}

function newestSnapshot(snapshots = []) {
  return [...snapshots]
    .sort((a, b) => textValue(b.snapshot_timestamp).localeCompare(textValue(a.snapshot_timestamp)))
    [0] || null;
}

function emptyFundingMaps() {
  return {
    source_flex_id: new Map(),
    source_goal_id: new Map()
  };
}

function fundingValue(map, id) {
  return roundMoneyAmount(map?.get(id) || 0);
}

function addFundingToMap(map, id, amount) {
  if (!id) return;
  map.set(id, addMoneyAmounts(map.get(id), amount));
}

function fundingMapsFromRows(rows = [], ledgerCurrency = "PLN", { futureRows = false } = {}) {
  const maps = emptyFundingMaps();

  for (const row of rows || []) {
    if (String(row?.ledger_currency || "PLN") !== ledgerCurrency) continue;
    if (!futureRows && row?.type === "income") continue;

    const amount = roundMoneyAmount(row?.ledger_amount);
    addFundingToMap(maps.source_flex_id, row?.source_flex_id, amount);
    addFundingToMap(maps.source_goal_id, row?.source_goal_id, amount);
  }

  return maps;
}

function cloneFundingMaps(maps = {}) {
  return {
    source_flex_id: new Map(maps.source_flex_id || []),
    source_goal_id: new Map(maps.source_goal_id || [])
  };
}

export function buildProjectionFundingState({
  flexes = [],
  futureRows = [],
  goals = [],
  ledgerCurrency = "PLN",
  confirmedFunding = null,
  pendingRows = [],
  goalTargetLedger = new Map(),
  flexTargetLedger = new Map()
} = {}) {
  const confirmedMaps = cloneFundingMaps(confirmedFunding || emptyFundingMaps());
  const pendingMaps = fundingMapsFromRows(pendingRows, ledgerCurrency);
  const futureMaps = fundingMapsFromRows(futureRows, ledgerCurrency, { futureRows: true });
  const confirmedGoalFunding = new Map();
  const pendingGoalFunding = new Map();
  const confirmedFlexFunding = new Map();
  const pendingFlexFunding = new Map();
  const generatedFlexFunding = new Map();

  for (const goal of goals) {
    confirmedGoalFunding.set(goal.id, fundingValue(confirmedMaps.source_goal_id, goal.id));
    pendingGoalFunding.set(goal.id, fundingValue(pendingMaps.source_goal_id, goal.id));
  }

  for (const flex of flexes) {
    confirmedFlexFunding.set(flex.id, fundingValue(confirmedMaps.source_flex_id, flex.id));
    pendingFlexFunding.set(flex.id, fundingValue(pendingMaps.source_flex_id, flex.id));
    generatedFlexFunding.set(flex.id, 0);
  }

  const previouslyFullyFundedGoals = new Set(
    goals
      .filter(goal => {
        const total = addMoneyAmounts(
          confirmedGoalFunding.get(goal.id),
          pendingGoalFunding.get(goal.id),
          fundingValue(futureMaps.source_goal_id, goal.id)
        );

        return total >= Number(goalTargetLedger.get(goal.id) || 0);
      })
      .map(goal => goal.id)
  );

  return {
    confirmedFlexFunding,
    confirmedGoalFunding,
    flexTargetLedger,
    generatedFlexFunding,
    goalTargetLedger,
    pendingFlexFunding,
    pendingGoalFunding,
    previouslyFullyFundedGoals
  };
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

  const [pendingRows, futureRows] = await Promise.all([
    budgetStore.listPlanningRows(normalizedBudgetId, "pending_transactions"),
    budgetStore.listPlanningRows(normalizedBudgetId, "future_transactions")
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

export function buildProjectionInputRowsFromPlanningTables({
  settings = {},
  tables = {}
} = {}) {
  const plannedById = new Map((tables.planned_transactions || [])
    .map(row => [row.id, row]));
  const withOperatingPriority = row => {
    const planned = plannedById.get(row.planned_transaction_id);
    return planned ? { ...row, priority: planned.operating_priority } : null;
  };
  const withGoalPriority = row => {
    const planned = plannedById.get(row.planned_transaction_id);
    return planned ? { ...row, priority: planned.goal_priority } : null;
  };

  const incomeByIdForAnchoring = new Map((tables.recurring_incomes || []).map(row => [row.id, row]));
  const recurringExpenses = (tables.recurring_expenses || [])
    .filter(row => isActiveValue(row.active))
    .map(row => row.anchor_income_id
      ? { ...row, anchor_income: incomeByIdForAnchoring.get(row.anchor_income_id) || null }
      : row)
    .map(withOperatingPriority)
    .filter(Boolean)
    .sort(compareByFields([
      { name: "priority", numeric: true },
      { name: "created_at" },
      { name: "id" }
    ]));

  const recurringIncomes = (tables.recurring_incomes || [])
    .filter(row => isActiveValue(row.active))
    .sort(compareByFields([
      { name: "anchor_day_of_month", numeric: true },
      { name: "created_at" },
      { name: "id" }
    ]));

  const flexes = (tables.flex_transactions || [])
    .filter(row => isActiveValue(row.active))
    .map(withOperatingPriority)
    .filter(Boolean)
    .sort(compareByFields([
      { name: "priority", numeric: true },
      { name: "created_at" },
      { name: "id" }
    ]));

  const goals = (tables.goals || [])
    .filter(row => isActiveValue(row.active))
    .map(withGoalPriority)
    .filter(Boolean)
    .sort(compareByFields([
      { name: "priority", numeric: true },
      { name: "created_at" },
      { name: "id" }
    ]));

  const oneOffs = (tables.one_off_transactions || [])
    .sort(compareByFields([
      { name: "date" },
      { name: "created_at" },
      { name: "id" }
    ]));

  const pendingPeriodIncomeRows = settings?.budget_period_income_id
    ? (tables.pending_transactions || [])
      .filter(row => row.source_recurring_income_id === settings.budget_period_income_id && row.type === "income")
      .map(row => ({
        source_recurring_income_id: row.source_recurring_income_id,
        type: row.type,
        date: row.date,
        occurrence_key: row.occurrence_key
      }))
    : [];

  return {
    flexes,
    goals,
    oneOffs,
    pendingPeriodIncomeRows,
    previousSnapshot: newestSnapshot(tables.projection_snapshots || []),
    recurringExpenses,
    recurringIncomes
  };
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
  "projection_snapshots"
];

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
  await Promise.all(PROJECTION_INPUT_TABLES.map(async tableName => {
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

export function buildFutureProjectionSummaryFromRows(rows = []) {
  return {
    totalProjectedExpenses: roundMoneyAmount((rows || []).reduce((total, row) => {
      if (row?.type === "income") return total;
      return addMoneyAmounts(total, row?.ledger_amount || 0);
    }, 0)),
    totalProjectedIncome: roundMoneyAmount((rows || []).reduce((total, row) => {
      if (row?.type !== "income") return total;
      return addMoneyAmounts(total, row?.ledger_amount || 0);
    }, 0)),
    warningCount: (rows || [])
      .filter(row => row?.status === "partial" || row?.status === "underfunded")
      .length
  };
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
  plan = {}
} = {}) {
  const normalizedBudgetId = String(budgetId || "").trim();
  if (!normalizedBudgetId) {
    throw new Error("budgetId is required");
  }
  if (!budgetStore || typeof budgetStore !== "object") {
    throw new Error("A budget-store writer is required");
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

  const summary = typeof budgetStore.transaction === "function"
    ? await budgetStore.transaction(write)
    : await write(budgetStore);

  return {
    ...summary,
    ok: true
  };
}

export function makeProjectionConverter({ settings = {}, fxSnapshot = null, ledgerCurrency = "PLN" } = {}) {
  return function convert(amount, currency, type) {
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
  };
}

export function computeGoalAndFlexTargetLedgerAmounts({ goals = [], flexes = [], convert }) {
  const goalTargetLedger = new Map();
  const flexTargetLedger = new Map();

  for (const goal of goals) {
    goalTargetLedger.set(goal.id, convert(goal.amount, goal.currency, "expense").ledgerAmount);
  }

  for (const flex of flexes) {
    flexTargetLedger.set(flex.id, convert(flex.amount, flex.currency, "expense").ledgerAmount);
  }

  return { goalTargetLedger, flexTargetLedger };
}

const RESERVE_TRANSFER_OCCURRENCE_KEY_PATTERN = /^reserve_transfer:(.+):(.+):(in|out)$/;

/**
 * Scans pending/confirmed rows for reserve-transfer occurrence keys
 * (`reserve_transfer:{source}:{target}:in`/`:out`) and returns one entry per
 * distinct source/target pair already committed on at least one side. Once
 * either the expense or the income half of a reserve transfer is pending or
 * confirmed, that half is a real transaction the engine can no longer
 * silently resize or delete — computeReserveClaims uses this to treat the
 * pair's amount as fixed instead of re-deriving it from scratch every
 * regeneration (which would shrink, grow, or duplicate it — see the
 * "locked" reserve-claim tests in projection-engine-service.test.js for the
 * failure this prevents).
 */
export function findLockedReserveClaims(rows = []) {
  const bySourceAndTarget = new Map();

  for (const row of rows || []) {
    const match = RESERVE_TRANSFER_OCCURRENCE_KEY_PATTERN.exec(String(row?.occurrence_key || ""));
    if (!match) continue;

    const [, sourcePeriodKey, targetPeriodKey, lockedSide] = match;
    const amountLedger = roundMoneyAmount(row.ledger_amount);
    if (!(amountLedger > 0)) continue;

    const pairKey = `${sourcePeriodKey}:${targetPeriodKey}`;
    // If both halves are already committed, either one's amount is
    // authoritative (the second was generated to match the first) — keep
    // whichever is found first.
    if (bySourceAndTarget.has(pairKey)) continue;

    bySourceAndTarget.set(pairKey, { sourcePeriodKey, targetPeriodKey, amountLedger, lockedSide });
  }

  return [...bySourceAndTarget.values()];
}

/**
 * Turns a discoveryOnly computeProjectionPlan() result into a set of
 * period-to-period reserve claims: how much of an earlier period's retained
 * surplus (available after its own necessities, but withheld from carrying
 * forward because hasLocalLowerPriorityDemand saw local goal/flex/
 * discretionary demand) should instead go toward a later period's necessity
 * shortfall.
 *
 * Deficits are resolved in chronological order, nearest-prior-period-first,
 * spilling to the next-nearest prior period if one period's surplus isn't
 * enough — never touching a period's surplus more than once across multiple
 * deficits (remainingByKey tracks what's left as claims are made). A deficit
 * that can't be fully covered even after exhausting every earlier period's
 * surplus is left partially or fully unclaimed — that's a genuine shortfall,
 * same as today, not something this function papers over.
 *
 * `lockedClaims` (from findLockedReserveClaims) are already-committed
 * source/target pairs: their amount is emitted as-is, never recomputed, and
 * they adjust the inputs to the free-claim search below so it doesn't
 * double-count money a locked claim already accounts for — a locked "out"
 * reduces the target's remaining deficit (the income side just hasn't
 * landed yet, but it will, this pass), and a locked "in" reduces the
 * source's remaining spendable surplus (the expense side hasn't left yet,
 * but it will). A source/target pair that already has a locked claim is
 * also excluded from the free-claim search for that same pair, since its
 * occurrence key — and therefore its amount — can't be changed once either
 * half exists as a real transaction; any additional shortfall has to come
 * from a different, earlier period instead.
 *
 * Deliberately shared between the SQLite and Postgres engines (see the
 * "differs from SQLite" comment on regenerateProjections for the one place
 * that isn't shared yet) so the claiming rule can't drift between backends.
 */
export function computeReserveClaims({
  periods = [],
  periodsAvailable = [],
  deficitsByPeriod = new Map(),
  lockedClaims = []
}) {
  const claims = [];
  const periodIndexByKey = new Map(periods.map((p, i) => [p.key, i]));
  const availableByKey = new Map(periodsAvailable.map(p => [p.key, p.available]));
  const adjustedDeficitByKey = new Map(deficitsByPeriod);
  const lockedPairKeys = new Set();

  for (const locked of lockedClaims) {
    if (!(locked.amountLedger > 0)) continue;

    lockedPairKeys.add(`${locked.sourcePeriodKey}:${locked.targetPeriodKey}`);
    claims.push({
      sourcePeriodKey: locked.sourcePeriodKey,
      targetPeriodKey: locked.targetPeriodKey,
      amountLedger: locked.amountLedger
    });

    if (locked.lockedSide === "out") {
      adjustedDeficitByKey.set(
        locked.targetPeriodKey,
        Math.max(0, subtractMoneyAmounts(adjustedDeficitByKey.get(locked.targetPeriodKey) || 0, locked.amountLedger))
      );
    } else if (locked.lockedSide === "in") {
      availableByKey.set(
        locked.sourcePeriodKey,
        Math.max(0, subtractMoneyAmounts(availableByKey.get(locked.sourcePeriodKey) || 0, locked.amountLedger))
      );
    }
  }

  if (!adjustedDeficitByKey.size) return claims;

  const remainingByKey = new Map(
    periods.map(p => [p.key, Math.max(0, roundMoneyAmount(availableByKey.get(p.key) || 0))])
  );

  const deficitEntries = [...adjustedDeficitByKey.entries()]
    .map(([key, amount]) => ({ key, amount: roundMoneyAmount(amount), index: periodIndexByKey.get(key) }))
    .filter(entry => entry.index !== undefined && entry.amount > 0.0001)
    .sort((a, b) => a.index - b.index);

  for (const deficit of deficitEntries) {
    let stillNeeded = deficit.amount;

    for (let sourceIndex = deficit.index - 1; sourceIndex >= 0 && stillNeeded > 0.0001; sourceIndex -= 1) {
      const sourceKey = periods[sourceIndex].key;
      if (lockedPairKeys.has(`${sourceKey}:${deficit.key}`)) continue;

      const remaining = remainingByKey.get(sourceKey) || 0;
      if (remaining <= 0.0001) continue;

      const claimed = roundMoneyAmount(Math.min(remaining, stillNeeded));
      remainingByKey.set(sourceKey, subtractMoneyAmounts(remaining, claimed));
      stillNeeded = subtractMoneyAmounts(stillNeeded, claimed);

      claims.push({
        sourcePeriodKey: sourceKey,
        targetPeriodKey: deficit.key,
        amountLedger: claimed
      });
    }
  }

  return claims;
}

function toOriginalAmount(ledgerAmount, bufferedRate) {
  return roundMoneyAmount(Number(ledgerAmount || 0) / Number(bufferedRate || 1));
}

/**
 * Pure, backend-neutral core of projection regeneration: the same allocation
 * algorithm as the SQLite `regenerateProjections`, but operating entirely on
 * already-resolved in-memory inputs (no DB access) and returning a write plan
 * shaped for applyProjectionGenerationPlanToBudgetStore instead of executing
 * SQL directly. This lets the SQLite and Postgres engines share one
 * implementation of the actual financial logic.
 *
 * `pendingRows` must be the full set of pending_transactions as loaded before
 * this run (prior to deleting rows for now-confirmed occurrences); this
 * function computes which of those to delete itself (returned as
 * `deletePendingOccurrenceKeys`) rather than expecting the caller to have
 * already removed them, since later checks within the same run depend on
 * that in-progress state.
 */
export function computeProjectionPlan({
  confirmedRowsAfterToday = [],
  convert,
  discoveryOnly = false,
  flexes = [],
  flexTargetLedger,
  fundingState,
  fxSnapshot = null,
  generateId: generateIdFn = generateId,
  generationTimestamp = new Date().toISOString(),
  goals = [],
  goalTargetLedger,
  handledOccurrenceKeys = new Set(),
  ledgerCurrency = "PLN",
  oneOffProgress = new Map(),
  oneOffs = [],
  openingBalance = 0,
  pendingRows = [],
  periods = [],
  predictionRows = [],
  previousSnapshot = null,
  reserveClaims = [],
  recurringExpenses = [],
  recurringIncomes = [],
  reserveFloor = 0,
  settings = {},
  today
}) {
  if (typeof convert !== "function") throw new Error("convert is required");
  if (!fundingState) throw new Error("fundingState is required");
  if (!today) throw new Error("today is required");

  const {
    confirmedFlexFunding,
    confirmedGoalFunding,
    generatedFlexFunding,
    pendingFlexFunding,
    pendingGoalFunding,
    previouslyFullyFundedGoals
  } = fundingState;

  const previousFxJson = previousSnapshot?.fx_rates_used || null;
  const currentFxJson = JSON.stringify(fxSnapshot || {});
  const fxRatesChanged = previousFxJson !== null && previousFxJson !== currentFxJson;

  const spendableBalance = period => Math.max(0, subtractMoneyAmounts(period.available, reserveFloor));
  const addPeriodAvailable = (period, amount) => { period.available = addMoneyAmounts(period.available, amount); };
  const subtractPeriodAvailable = (period, amount) => { period.available = subtractMoneyAmounts(period.available, amount); };

  const futureRows = [];
  const newPendingRows = [];
  const eventRows = [];
  const notificationRows = [];
  const deleteOccurrenceKeys = new Set();

  // Populated only when discoveryOnly is true: one entry per period where a
  // necessary recurring expense or one-off came up short, aggregated to a
  // single ledger-currency amount per period. See findReserveClaims() below
  // for how this feeds the second (real) generation pass.
  const discoveryDeficitsByPeriod = new Map();
  function recordDiscoveryDeficit(periodKey, missingLedgerAmount) {
    if (!discoveryOnly || missingLedgerAmount <= 0) return;
    discoveryDeficitsByPeriod.set(
      periodKey,
      addMoneyAmounts(discoveryDeficitsByPeriod.get(periodKey) || 0, missingLedgerAmount)
    );
  }

  // reserveClaims (populated by the caller from a prior discoveryOnly run)
  // move ledger-currency amounts from an earlier period's retained surplus
  // to a later period's necessities, materialized as an ordinary paired
  // income/expense so they show up like any other projected transaction
  // instead of as an invisible adjustment. Grouped by period key for O(1)
  // lookup as the per-period loop below runs.
  const reserveClaimsBySourcePeriod = new Map();
  const reserveClaimsByTargetPeriod = new Map();
  for (const claim of reserveClaims) {
    if (!(claim.amountLedger > 0)) continue;
    if (!reserveClaimsBySourcePeriod.has(claim.sourcePeriodKey)) reserveClaimsBySourcePeriod.set(claim.sourcePeriodKey, []);
    reserveClaimsBySourcePeriod.get(claim.sourcePeriodKey).push(claim);
    if (!reserveClaimsByTargetPeriod.has(claim.targetPeriodKey)) reserveClaimsByTargetPeriod.set(claim.targetPeriodKey, []);
    reserveClaimsByTargetPeriod.get(claim.targetPeriodKey).push(claim);
  }

  function periodForDate(date) {
    return periods.find(p => date >= p.start && date <= p.end);
  }

  function periodForPendingDate(date) {
    if (!periods.length) return null;
    if (date < periods[0].start) return periods[0];
    return periodForDate(date);
  }

  // Mutable in-memory mirror of pending_transactions, seeded from the
  // pre-run snapshot. Reads/writes below keep it in sync with what the
  // equivalent SQL DELETE/INSERT statements would have done, because later
  // checks in this same run (demand checks, stale-remainder cleanup) depend
  // on earlier mutations made during this same run, not just the starting
  // snapshot.
  const pendingByOccurrenceKey = new Map();
  for (const row of pendingRows) {
    if (row?.occurrence_key) pendingByOccurrenceKey.set(row.occurrence_key, row);
  }

  function deletePendingRow(row) {
    if (!row?.occurrence_key) return;
    deleteOccurrenceKeys.add(row.occurrence_key);
    pendingByOccurrenceKey.delete(row.occurrence_key);
  }

  for (const occurrenceKey of handledOccurrenceKeys) {
    const existing = pendingByOccurrenceKey.get(occurrenceKey);
    if (existing) deletePendingRow(existing);
  }

  if (periods.length) {
    addPeriodAvailable(periods[0], openingBalance);

    for (const row of pendingByOccurrenceKey.values()) {
      if (String(row.ledger_currency || "PLN") !== ledgerCurrency) continue;
      const targetPeriod = periodForPendingDate(String(row.date || ""));
      if (!targetPeriod) continue;

      const ledgerAmount = roundMoneyAmount(row.ledger_amount);
      if (row.type === "income") addPeriodAvailable(targetPeriod, ledgerAmount);
      else subtractPeriodAvailable(targetPeriod, ledgerAmount);
    }

    for (const row of confirmedRowsAfterToday) {
      const targetPeriod = periodForDate(String(row.date || ""));
      if (!targetPeriod) continue;

      const ledgerAmount = roundMoneyAmount(row.ledger_amount);
      if (row.type === "income") addPeriodAvailable(targetPeriod, ledgerAmount);
      else subtractPeriodAvailable(targetPeriod, ledgerAmount);
    }
  }

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
      return { inserted: false, ledgerAmount: 0, alreadyConfirmed: true };
    }

    if (pendingByOccurrenceKey.has(occurrenceKey)) {
      // Pending rows are actionable user decisions; ordinary projection
      // rebuilds must never overwrite them (mirrors refreshPendingOccurrence
      // in cashflow-projection-state-service.js, which is a no-op once a
      // pending row exists for the occurrence).
      return {
        inserted: false,
        updatedPending: true,
        ledgerAmount: 0,
        fx: converted.fx,
        buffered: converted.buffered
      };
    }

    if (toPending) {
      const row = {
        id: generateIdFn("pend"),
        name,
        currency,
        amount: normalizedFundedAmount,
        type,
        date,
        source_recurring_expense_id: sourceRecurringExpenseId,
        source_recurring_income_id: sourceRecurringIncomeId,
        source_one_off_id: sourceOneOffId,
        source_flex_id: sourceFlexId,
        source_goal_id: sourceGoalId,
        fx_rate: converted.fx,
        buffered_fx_rate: converted.buffered,
        ledger_currency: ledgerCurrency,
        status: status === "funded" ? "pending" : status,
        funded_amount: normalizedFundedAmount,
        requested_amount: normalizedRequestedAmount,
        ledger_amount: converted.ledgerAmount,
        pending_origin: "projection",
        note,
        occurrence_key: occurrenceKey,
        created_at: generationTimestamp,
        updated_at: generationTimestamp
      };

      newPendingRows.push(row);
      pendingByOccurrenceKey.set(occurrenceKey, row);

      return {
        inserted: true,
        pending: true,
        ledgerAmount: converted.ledgerAmount,
        fx: converted.fx,
        buffered: converted.buffered
      };
    }

    futureRows.push({
      id: generateIdFn("fut"),
      name,
      currency,
      amount: normalizedFundedAmount,
      type,
      date,
      period,
      source_recurring_expense_id: sourceRecurringExpenseId,
      source_recurring_income_id: sourceRecurringIncomeId,
      source_one_off_id: sourceOneOffId,
      source_flex_id: sourceFlexId,
      source_goal_id: sourceGoalId,
      fx_rate: converted.fx,
      buffered_fx_rate: converted.buffered,
      ledger_currency: ledgerCurrency,
      requested_amount: normalizedRequestedAmount,
      funded_amount: normalizedFundedAmount,
      ledger_amount: converted.ledgerAmount,
      status,
      note,
      occurrence_key: occurrenceKey,
      generation_timestamp: generationTimestamp,
      created_at: generationTimestamp
    });

    return {
      inserted: true,
      ledgerAmount: converted.ledgerAmount,
      fx: converted.fx,
      buffered: converted.buffered
    };
  }

  function queueFundingShortfallIfNeeded(entityId, title, message) {
    if (!notificationEnabled(settings, "funding_shortfall")) return;

    notificationRows.push(buildNotificationQueueRow({
      dedupeKey: `funding_shortfall:${entityId}`,
      entityId,
      generateId: generateIdFn,
      message,
      priority: notificationPriority(settings, "funding_shortfall"),
      queuedAt: generationTimestamp,
      settings,
      title,
      type: "funding_shortfall"
    }));
  }

  function queueUnderfundedIfNeeded(expense, missingAmount) {
    if (!notificationEnabled(settings, "necessary_underfunded")) return;

    notificationRows.push(buildNotificationQueueRow({
      dedupeKey: `necessary_underfunded:${expense.id}`,
      entityId: expense.id,
      generateId: generateIdFn,
      message: `${expense.name} is missing ${missingAmount.toFixed(2)} ${expense.currency}`,
      priority: notificationPriority(settings, "necessary_underfunded"),
      queuedAt: generationTimestamp,
      settings,
      title: "Necessary transaction underfunded",
      type: "necessary_underfunded"
    }));
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

      return !handledOccurrenceKeys.has(occurrenceKey) && !pendingByOccurrenceKey.has(occurrenceKey);
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

        return !handledOccurrenceKeys.has(occurrenceKey) && !pendingByOccurrenceKey.has(occurrenceKey);
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

  function predictedIncomeAmount(income, date) {
    return predictedAmountForRecurringIncomePure({
      income,
      today,
      occurrenceDate: date,
      confirmedRows: predictionRows
    });
  }

  function predictedExpenseAmount(expense, date) {
    return predictedAmountForRecurringExpensePure({
      expense,
      today,
      occurrenceDate: date,
      confirmedRows: predictionRows
    });
  }

  for (const [periodIndex, period] of periods.entries()) {
    period.blocked = false;

    for (const income of recurringIncomes) {
      for (const date of recurringOccurrencesInPeriod(income, period, today)) {
        const predicted = predictedIncomeAmount(income, date);

        const inserted = insertTx({
          name: income.name,
          currency: income.currency,
          requestedAmount: predicted,
          fundedAmount: predicted,
          type: "income",
          date,
          period: period.key,
          sourceRecurringIncomeId: income.id
        });

        addPeriodAvailable(period, inserted.ledgerAmount);
      }
    }

    // Reserve top-ups land before one-offs/necessities are funded, since the
    // amount being claimed was sized (during the discoveryOnly run) to cover
    // this period's *entire* necessities-tier shortfall, one-offs included.
    for (const claim of reserveClaimsByTargetPeriod.get(period.key) || []) {
      const inserted = insertTx({
        name: `Reserved from ${claim.sourcePeriodKey}`,
        currency: ledgerCurrency,
        requestedAmount: claim.amountLedger,
        fundedAmount: claim.amountLedger,
        type: "income",
        date: period.start,
        period: period.key,
        note: "Held back from an earlier period so this period's necessary expenses could be funded.",
        occurrenceKeyOverride: `reserve_transfer:${claim.sourcePeriodKey}:${claim.targetPeriodKey}:in`
      });

      addPeriodAvailable(period, inserted.ledgerAmount);
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
          for (const row of [...pendingByOccurrenceKey.values()]) {
            if (row.source_one_off_id === oneOff.id) deletePendingRow(row);
          }
          continue;
        }

        if (toPending) {
          for (const row of [...pendingByOccurrenceKey.values()]) {
            if (row.source_one_off_id === oneOff.id && row.occurrence_key !== occurrenceKey) {
              deletePendingRow(row);
            }
          }
        } else {
          // Remove a stale due remainder after its target date moves into the future.
          // Keep a future remainder that the user explicitly moved to pending on that same date.
          for (const row of [...pendingByOccurrenceKey.values()]) {
            if (
              row.source_one_off_id === oneOff.id &&
              (row.occurrence_key !== occurrenceKey || row.date !== oneOff.date)
            ) {
              deletePendingRow(row);
            }
          }
        }
      }

      const targetPeriod = toPending ? periods[0] : periodForDate(oneOff.date);
      if (!targetPeriod || targetPeriod.key !== period.key) continue;

      const requestedConversion = convert(remainingAmount, oneOff.currency, oneOff.type);
      const requestedLedger = requestedConversion.ledgerAmount;
      const existingPending = pendingByOccurrenceKey.get(occurrenceKey) || null;
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

        // A blocked period skips necessary-recurring-expense funding below
        // entirely (see the `if (period.blocked)` check after this loop), so
        // any necessity shortfall those would have hit is invisible to this
        // discovery run. Reserving just the one-off's shortfall unblocks the
        // period on the real pass; if that then reveals a *further* necessity
        // shortfall behind it, this run's discovery pass has no way to see
        // that — it self-corrects on the next regeneration (which runs on
        // almost every mutation already) rather than this same one.
        recordDiscoveryDeficit(period.key, subtractMoneyAmounts(requestedLedger, availableForExpense));

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
        const predicted = predictedExpenseAmount(expense, date);
        const converted = convert(predicted, expense.currency, "expense");
        const requestedLedger = converted.ledgerAmount;

        if (spendableBalance(period) <= 0) {
          insertTx({
            name: expense.name,
            currency: expense.currency,
            requestedAmount: predicted,
            fundedAmount: 0,
            type: "expense",
            date,
            period: period.key,
            sourceRecurringExpenseId: expense.id,
            status: "underfunded",
            note: "Necessary transaction could not be funded"
          });

          queueUnderfundedIfNeeded(expense, predicted);

          queueFundingShortfallIfNeeded(
            expense.id,
            "Funding shortfall",
            `${expense.name} could not be funded in ${period.key}`
          );

          recordDiscoveryDeficit(period.key, requestedLedger);
          continue;
        }

        const fundedLedger = Math.min(spendableBalance(period), requestedLedger);
        const fundedOriginal = toOriginalAmount(fundedLedger, converted.buffered);
        const status = fundedLedger < requestedLedger ? "partial" : "funded";
        const missingOriginal = Math.max(0, subtractMoneyAmounts(predicted, fundedOriginal));

        const inserted = insertTx({
          name: expense.name,
          currency: expense.currency,
          requestedAmount: predicted,
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

          recordDiscoveryDeficit(period.key, subtractMoneyAmounts(requestedLedger, fundedLedger));
        }
      }
    }

    // Donate this period's retained surplus toward any later period's
    // necessity shortfall *before* the local-demand check below decides
    // whether goals/flex get to spend it — this is the actual fix: without
    // this, hasLocalLowerPriorityDemand only ever asks "does *this* period
    // want the surplus," never "does a later period *need* it instead."
    for (const claim of reserveClaimsBySourcePeriod.get(period.key) || []) {
      const inserted = insertTx({
        name: `Reserved for ${claim.targetPeriodKey}`,
        currency: ledgerCurrency,
        requestedAmount: claim.amountLedger,
        fundedAmount: claim.amountLedger,
        type: "expense",
        date: period.end,
        period: period.key,
        note: "Held back for a later period's necessary expenses instead of funding goals/flex/discretionary spending here.",
        occurrenceKeyOverride: `reserve_transfer:${claim.sourcePeriodKey}:${claim.targetPeriodKey}:out`
      });

      subtractPeriodAvailable(period, inserted.ledgerAmount);
    }

    if (!hasLocalLowerPriorityDemand(period)) {
      carrySurplusToNextPeriod(periodIndex);
    }

    carryDebtToNextPeriod(periodIndex);
  }

  if (discoveryOnly) {
    return {
      // spendableBalance(), not raw .available: a period's *donatable*
      // surplus already excludes the user's configured minimum-reserve
      // floor, the same way necessity funding itself does. Reporting raw
      // .available here would let a reserve claim dip a source period
      // below its own floor.
      periodsAvailable: periods.map(p => ({ key: p.key, available: spendableBalance(p) })),
      deficitsByPeriod: discoveryDeficitsByPeriod
    };
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
      eventRows.push({
        id: generateIdFn("event"),
        action: "goal_impossible",
        entity_type: "goal",
        entity_id: goal.id,
        details: JSON.stringify({
          goal: goal.name,
          missing_ledger: remainingLedger,
          ledger_currency: ledgerCurrency,
          due_date: goal.due_date
        }),
        timestamp: generationTimestamp
      });

      if (notificationEnabled(settings, "goal_impossible")) {
        notificationRows.push(buildNotificationQueueRow({
          dedupeKey: `goal_impossible:${goal.id}`,
          entityId: goal.id,
          generateId: generateIdFn,
          message: `${goal.name} is missing ${remainingLedger.toFixed(2)} ${ledgerCurrency}`,
          priority: notificationPriority(settings, "goal_impossible"),
          queuedAt: generationTimestamp,
          settings,
          title: "Goal cannot be fully funded",
          type: "goal_impossible"
        }));
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

          const predicted = predictedExpenseAmount(expense, date);
          const converted = convert(predicted, expense.currency, "expense");
          const requestedLedger = converted.ledgerAmount;
          const fundedLedger = Math.min(spendableBalance(period), requestedLedger);

          if (fundedLedger <= 0) continue;

          const fundedOriginal = toOriginalAmount(fundedLedger, converted.buffered);
          const status = fundedLedger < requestedLedger ? "partial" : "funded";

          const inserted = insertTx({
            name: expense.name,
            currency: expense.currency,
            requestedAmount: predicted,
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

    const futureAllocatedLedger = futureRows
      .filter(row => row.source_goal_id === goal.id && String(row.ledger_currency || "PLN") === ledgerCurrency)
      .reduce((total, row) => addMoneyAmounts(total, row.ledger_amount), 0);

    const totalFundedLedger = addMoneyAmounts(alreadyFundedLedger, futureAllocatedLedger);

    if (
      totalFundedLedger >= targetLedger &&
      !previouslyFullyFundedGoals.has(goal.id) &&
      notificationEnabled(settings, "goal_funded")
    ) {
      notificationRows.push(buildNotificationQueueRow({
        dedupeKey: `goal_funded:${goal.id}`,
        entityId: goal.id,
        generateId: generateIdFn,
        message: `${goal.name} is now fully funded.`,
        priority: notificationPriority(settings, "goal_funded"),
        queuedAt: generationTimestamp,
        settings,
        title: "Goal fully funded",
        type: "goal_funded"
      }));
    }
  }

  const futureSummary = buildFutureProjectionSummaryFromRows(futureRows);
  const availableBalance = addMoneyAmounts(...periods.map(p => p.available));

  if (previousSnapshot && fxRatesChanged && notificationEnabled(settings, "fx_changed")) {
    const oldIncome = Number(previousSnapshot.total_projected_income || 0);
    const oldExpenses = Number(previousSnapshot.total_projected_expenses || 0);
    const oldBalance = Number(previousSnapshot.available_balance || 0);

    const materiallyChanged =
      Math.abs(oldIncome - futureSummary.totalProjectedIncome) >= 0.01 ||
      Math.abs(oldExpenses - futureSummary.totalProjectedExpenses) >= 0.01 ||
      Math.abs(oldBalance - availableBalance) >= 0.01 ||
      Number(previousSnapshot.warning_count || 0) !== Number(futureSummary.warningCount || 0);

    if (materiallyChanged) {
      notificationRows.push(buildNotificationQueueRow({
        dedupeKey: `fx_changed:${generationTimestamp.slice(0, 10)}`,
        entityId: "fx_changed",
        generateId: generateIdFn,
        message: "Projection totals, available balance, or warning count changed after recalculation.",
        priority: notificationPriority(settings, "fx_changed"),
        queuedAt: generationTimestamp,
        settings,
        title: "FX change affected projections",
        type: "fx_changed"
      }));
    }
  }

  const projectionSnapshotRows = [{
    id: generateIdFn("snapshot"),
    snapshot_timestamp: generationTimestamp,
    total_projected_income: futureSummary.totalProjectedIncome,
    total_projected_expenses: futureSummary.totalProjectedExpenses,
    available_balance: availableBalance,
    fx_rates_used: currentFxJson,
    ledger_currency: ledgerCurrency,
    generation_succeeded: 1,
    warning_count: futureSummary.warningCount,
    created_at: generationTimestamp
  }];

  return {
    deletePendingOccurrenceKeys: [...deleteOccurrenceKeys],
    eventRows,
    futureRows,
    notificationRows,
    pendingRows: newPendingRows,
    projectionSnapshotRows
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
   * used elsewhere once a Postgres budget store is configured). Shares the
   * same computeProjectionPlan core as the SQLite path is expected to move to
   * — see context.md §5.1 for the port design and remaining wiring steps
   * (this function is not yet called by the projection coordinator).
   */
  async function regenerateProjectionsAsync(budgetId) {
    if (!budgetStore) throw new Error("A budget store is required for regenerateProjectionsAsync");
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
    } = await loadProjectionInputRowsFromBudgetStore({ budgetId, budgetStore });

    const ledgerCurrency = settings?.ledger_currency || "PLN";
    const today = todayInTimezone(settings?.timezone || DEFAULT_TIMEZONE);
    const futurePeriods = Number(settings?.future_periods) || DEFAULT_FUTURE_PERIODS;
    const reserveFloor = Number(settings?.minimum_reserve_enabled || 0) === 1
      ? Math.max(0, roundMoneyAmount(settings?.minimum_reserve_amount || 0))
      : 0;

    const fxSnapshot = (await safeGetCurrentFxSnapshotAsync(budgetId)) || (await getCachedFxSnapshotAsync(budgetId));
    const predictionRows = await confirmedRowsForPredictionAsync(budgetId, today);

    const periodAnchorOverrides = periodAnchorOverridesForIncome(
      settings?.budget_period_income_id,
      [...predictionRows, ...pendingPeriodIncomeRows]
    );
    const periods = buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods, {
      anchorOverrides: periodAnchorOverrides
    });

    const convert = makeProjectionConverter({ settings, fxSnapshot, ledgerCurrency });
    const { goalTargetLedger, flexTargetLedger } = computeGoalAndFlexTargetLedgerAmounts({ goals, flexes, convert });

    const fundingState = await loadProjectionFundingStateFromBudgetStore({
      budgetId,
      budgetStore,
      flexes,
      goals,
      ledgerCurrency,
      goalTargetLedger,
      flexTargetLedger
    });

    const [handledOccurrenceKeys, oneOffProgress, confirmedRowsAfterToday, openingBalance] = await Promise.all([
      confirmedOccurrenceKeysAsync(budgetId),
      confirmedOneOffProgressAsync(budgetId),
      confirmedRowsAfterDateAsync(budgetId, today, settings),
      confirmedBalanceAsOfAsync(budgetId, today, settings)
    ]);

    const sharedPlanInputs = {
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
    const discoveryPeriods = buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods, {
      anchorOverrides: periodAnchorOverrides
    });
    const discovery = computeProjectionPlan({
      ...sharedPlanInputs,
      discoveryOnly: true,
      periods: discoveryPeriods
    });
    // Reserve transfers already pending/confirmed on one side (e.g. a user
    // manually moved the expense half to pending) must not be re-derived
    // from scratch — see computeReserveClaims and findLockedReserveClaims.
    const lockedReserveClaims = findLockedReserveClaims([
      ...(tables.pending_transactions || []),
      ...confirmedRowsAfterToday
    ]);
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

    const applyResult = await applyProjectionGenerationPlanToBudgetStore({ budgetId, budgetStore, plan });
    await recalculatePlanningRunningBalancesAsync(budgetId, budgetStore);

    logServerEvent("cashflow_projections_regenerated", {
      userId: budgetId,
      periodCount: periods.length
    });

    return applyResult;
  }

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

      // See computeProjectionPlan()'s identical-in-spirit (but separately
      // maintained — see the note above runGenerationTransactionBody) reserve
      // mechanism for the full explanation. discoveryOnly/reserveClaims are
      // reassigned by the two-pass orchestration below, after this function
      // is defined but before either db.transaction(runGenerationTransactionBody)()
      // call.
      let discoveryOnly = false;
      let reserveClaimsBySourcePeriod = new Map();
      let reserveClaimsByTargetPeriod = new Map();
      const discoveryDeficitsByPeriod = new Map();
      function recordDiscoveryDeficit(periodKey, missingLedgerAmount) {
        if (!discoveryOnly || !(missingLedgerAmount > 0)) return;
        discoveryDeficitsByPeriod.set(
          periodKey,
          addMoneyAmounts(discoveryDeficitsByPeriod.get(periodKey) || 0, missingLedgerAmount)
        );
      }
      class DiscoveryPassResult {
        constructor(payload) {
          this.payload = payload;
        }
      }

      const incomeByIdForAnchoring = new Map(
        db.prepare("SELECT * FROM recurring_incomes").all().map(row => [row.id, row])
      );
      const recurringExpenses = db.prepare(`
        SELECT r.*, pt.operating_priority AS priority
        FROM recurring_expenses r
        JOIN planned_transactions pt ON pt.id = r.planned_transaction_id
        WHERE r.active = 1
        ORDER BY pt.operating_priority ASC, r.created_at ASC, r.id ASC
      `).all().map(row => row.anchor_income_id
        ? { ...row, anchor_income: incomeByIdForAnchoring.get(row.anchor_income_id) || null }
        : row);

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
      // Reassigned between the discoveryOnly and real transaction attempts
      // below (buildBudgetPeriods() called again for a fresh, unmutated
      // array) — SQLite transaction rollback undoes DB writes, not in-memory
      // mutations to these period objects' .available/.blocked.
      let periods = buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods, {
        anchorOverrides: periodAnchorOverrides
      });
      const handledOccurrenceKeys = confirmedOccurrenceKeys(userId);
      const oneOffProgress = confirmedOneOffProgress(userId);
      const confirmedFunding = typeof confirmedFundingTotals === "function"
        ? confirmedFundingTotals(userId, ledgerCurrency, settings)
        : {
            source_flex_id: new Map(),
            source_goal_id: new Map()
          };

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

      if (typeof confirmedFundingTotals !== "function") {
        for (const goal of goals) {
          confirmedFunding.source_goal_id.set(
            goal.id,
            sumConfirmedFunding(userId, "source_goal_id", goal.id, ledgerCurrency, settings)
          );
        }

        for (const flex of flexes) {
          confirmedFunding.source_flex_id.set(
            flex.id,
            sumConfirmedFunding(userId, "source_flex_id", flex.id, ledgerCurrency, settings)
          );
        }
      }

      const fundingState = buildProjectionFundingState({
        confirmedFunding,
        flexes,
        futureRows: db.prepare("SELECT * FROM future_transactions").all(),
        goals,
        goalTargetLedger,
        ledgerCurrency,
        pendingRows: db.prepare("SELECT * FROM pending_transactions").all(),
        flexTargetLedger
      });
      const {
        confirmedFlexFunding,
        confirmedGoalFunding,
        generatedFlexFunding,
        pendingFlexFunding,
        pendingGoalFunding,
        previouslyFullyFundedGoals
      } = fundingState;

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

      // Named (not an inline arrow) so the two-pass orchestration after this
      // function's closing brace can invoke it twice via db.transaction():
      // once as a discoveryOnly dry run that always throws (so SQLite rolls
      // back every write it made), once for real.
      function runGenerationTransactionBody() {
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

          for (const claim of reserveClaimsByTargetPeriod.get(period.key) || []) {
            const inserted = insertTx({
              name: `Reserved from ${claim.sourcePeriodKey}`,
              currency: ledgerCurrency,
              requestedAmount: claim.amountLedger,
              fundedAmount: claim.amountLedger,
              type: "income",
              date: period.start,
              period: period.key,
              note: "Held back from an earlier period so this period's necessary expenses could be funded.",
              occurrenceKeyOverride: `reserve_transfer:${claim.sourcePeriodKey}:${claim.targetPeriodKey}:in`
            });

            addPeriodAvailable(period, inserted.ledgerAmount);
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

              // See the identical comment in computeProjectionPlan() for why
              // this only captures the one-off's own shortfall, not any
              // necessary-recurring-expense shortfall hiding behind the
              // block this period is about to take.
              recordDiscoveryDeficit(period.key, subtractMoneyAmounts(requestedLedger, availableForExpense));

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

                recordDiscoveryDeficit(period.key, requestedLedger);
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

                recordDiscoveryDeficit(period.key, subtractMoneyAmounts(requestedLedger, fundedLedger));
              }
            }
          }

          // Donate this period's retained surplus toward a later period's
          // necessity shortfall before the local-demand check below decides
          // whether goals/flex/discretionary spending gets to keep it — see
          // the identical comment in computeProjectionPlan() for the full
          // explanation of why this is the actual fix.
          for (const claim of reserveClaimsBySourcePeriod.get(period.key) || []) {
            const inserted = insertTx({
              name: `Reserved for ${claim.targetPeriodKey}`,
              currency: ledgerCurrency,
              requestedAmount: claim.amountLedger,
              fundedAmount: claim.amountLedger,
              type: "expense",
              date: period.end,
              period: period.key,
              note: "Held back for a later period's necessary expenses instead of funding goals/flex/discretionary spending here.",
              occurrenceKeyOverride: `reserve_transfer:${claim.sourcePeriodKey}:${claim.targetPeriodKey}:out`
            });

            subtractPeriodAvailable(period, inserted.ledgerAmount);
          }

          if (!hasLocalLowerPriorityDemand(period)) {
            carrySurplusToNextPeriod(periodIndex);
          }

          carryDebtToNextPeriod(periodIndex);
        }

        if (discoveryOnly) {
          // spendableBalance(), not raw .available — see the identical
          // comment in computeProjectionPlan().
          throw new DiscoveryPassResult({
            periodsAvailable: periods.map(p => ({ key: p.key, available: spendableBalance(p) })),
            deficitsByPeriod: discoveryDeficitsByPeriod
          });
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
      }

      // Two-pass generation: discover shortfalls under today's real
      // local-retention rule (unmodified — see runGenerationTransactionBody
      // above), turn them into reserve claims, then run for real. The
      // discoveryOnly transaction always throws DiscoveryPassResult at the
      // point noted inside runGenerationTransactionBody, so SQLite rolls
      // back every write the dry run made; only the real pass below commits.
      let discoveryResult = null;
      discoveryOnly = true;
      try {
        db.transaction(runGenerationTransactionBody)();
        throw new Error("discoveryOnly pass completed without throwing DiscoveryPassResult — the throw site may have been removed");
      } catch (err) {
        if (!(err instanceof DiscoveryPassResult)) throw err;
        discoveryResult = err.payload;
      }

      // See the identical comment in regenerateProjectionsAsync() for why
      // already pending/confirmed reserve-transfer rows must be locked
      // rather than re-derived on this regeneration.
      const pendingReserveRows = db.prepare(`
        SELECT occurrence_key, ledger_amount
        FROM pending_transactions
        WHERE occurrence_key LIKE 'reserve_transfer:%'
      `).all();
      const confirmedReserveRows = typeof confirmedRowsAfterDate === "function"
        ? confirmedRowsAfterDate(db, userId, today).filter(row =>
          String(row?.occurrence_key || "").startsWith("reserve_transfer:")
        )
        : [];
      const lockedReserveClaims = findLockedReserveClaims([...pendingReserveRows, ...confirmedReserveRows]);

      const reserveClaims = computeReserveClaims({
        periods,
        periodsAvailable: discoveryResult.periodsAvailable,
        deficitsByPeriod: discoveryResult.deficitsByPeriod,
        lockedClaims: lockedReserveClaims
      });
      reserveClaimsBySourcePeriod = new Map();
      reserveClaimsByTargetPeriod = new Map();
      for (const claim of reserveClaims) {
        if (!(claim.amountLedger > 0)) continue;
        if (!reserveClaimsBySourcePeriod.has(claim.sourcePeriodKey)) reserveClaimsBySourcePeriod.set(claim.sourcePeriodKey, []);
        reserveClaimsBySourcePeriod.get(claim.sourcePeriodKey).push(claim);
        if (!reserveClaimsByTargetPeriod.has(claim.targetPeriodKey)) reserveClaimsByTargetPeriod.set(claim.targetPeriodKey, []);
        reserveClaimsByTargetPeriod.get(claim.targetPeriodKey).push(claim);
      }

      periods = buildBudgetPeriods(settings, recurringIncomes, today, futurePeriods, {
        anchorOverrides: periodAnchorOverrides
      });
      discoveryOnly = false;

      db.transaction(runGenerationTransactionBody)();

      logServerEvent("cashflow_projections_regenerated", {
        userId,
        periodCount: periods.length
      });
    } finally {
      db.close();
    }
  }

  return {
    regenerateProjections,
    regenerateProjectionsAsync
  };
}
