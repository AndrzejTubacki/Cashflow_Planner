import { recurringOccurrencesInPeriod } from "./cashflow-date-utils.js";
import { compareEngineText } from "./cashflow-ordering.js";
import { addMoneyAmounts, getBufferedFxForCurrency, multiplyMoney, roundMoneyAmount, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import { buildNotificationQueueRow as buildNotificationIntent, notificationEnabled, notificationPriority } from "./cashflow-notification-intents.js";
import { makeOccurrenceKey, parseReserveTransferOccurrenceKey } from "./cashflow-occurrence-utils.js";
import { normalizePriority } from "./cashflow-priority.js";
import { predictedAmountForRecurringExpensePure, predictedAmountForRecurringIncomePure } from "./cashflow-prediction.js";

// Pure row-based calculations. Storage and runtime defaults belong to adapters.
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
        : compareEngineText(textValue(aValue), textValue(bValue));
      if (compare !== 0) return compare;
    }
    return 0;
  };
}

function newestSnapshot(snapshots = []) {
  return [...snapshots]
    .sort((a, b) => compareEngineText(textValue(b.snapshot_timestamp), textValue(a.snapshot_timestamp)))
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
  map.set(id, addMoneyAmounts(map.get(id) || 0, amount));
}

export function fundingMapsFromRows(rows = [], ledgerCurrency = "PLN", { futureRows = false } = {}) {
  const maps = emptyFundingMaps();

  for (const row of rows || []) {
    if (String(row?.ledger_currency || "PLN") !== ledgerCurrency) continue;
    if (!futureRows && row?.type === "income") continue;

    const amount = roundMoneyAmount(row?.ledger_amount || 0);
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
          (confirmedGoalFunding.get(goal.id) || 0),
          (pendingGoalFunding.get(goal.id) || 0),
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
export function findLockedReserveClaims(rows = [], ledgerCurrency = null) {
  const bySourceAndTarget = new Map();

  for (const row of rows || []) {
    if (ledgerCurrency && row?.ledger_currency && row.ledger_currency !== ledgerCurrency) continue;
    const parsed = parseReserveTransferOccurrenceKey(row?.occurrence_key);
    if (!parsed) continue;

    const { sourcePeriodKey, targetPeriodKey, side: lockedSide } = parsed;
    const amountLedger = roundMoneyAmount(row.ledger_amount ?? row.amount);
    if (!(amountLedger >= 0)) continue;

    // Zero is an accepted browser amount too: retain the pair so projection
    // cannot silently replace a reviewed zero with a new positive transfer.
    const pairKey = `${sourcePeriodKey}:${targetPeriodKey}`;
    // If both halves are already committed, either one's amount is
    // authoritative (the second was generated to match the first) — keep
    // whichever is found first, and mark lockedSide as "both" so
    // computeReserveClaims does not subtract from discovery's available/deficit
    // a second time when both halves are already materialized.
    const existing = bySourceAndTarget.get(pairKey);
    if (existing) {
      if (existing.lockedSide !== lockedSide) existing.lockedSide = "both";
      continue;
    }

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
    if (!(locked.amountLedger >= 0)) continue;

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
/**
 * One-off incomes come before one-off expenses (stable, so date/created_at
 * order is kept within each type). Recurring incomes already count for the
 * whole period before any one-off expense is checked; without this, a
 * one-off expense created before a same-period one-off income (e.g. a bill
 * and a salary both dated the 29th) was checked before the income landed
 * and wrongly marked unfundable.
 */
export function orderOneOffsIncomesFirst(oneOffs = []) {
  return [...oneOffs].sort((a, b) => Number(a?.type !== "income") - Number(b?.type !== "income"));
}

export function computeProjectionPlan({
  confirmedRowsAfterToday = [],
  convert,
  discoveryOnly = false,
  flexes = [],
  flexTargetLedger,
  fundingState,
  fxSnapshot = null,
  generateId: generateIdFn,
  generationTimestamp,
  notificationToday,
  goals = [],
  goalTargetLedger,
  handledOccurrenceKeys = new Set(),
  ledgerCurrency = "PLN",
  oneOffProgress = new Map(),
  oneOffs = [],
  openingBalance = 0,
  pendingRows = [],
  recoveryOccurrenceKeys = new Set(),
  currentPeriodStart = null,
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
  if (typeof generateIdFn !== "function") throw new Error("generateId is required");
  if (!generationTimestamp) throw new Error("generationTimestamp is required");
  // Bind intent construction to this request, never to an ambient clock.
  const buildNotificationQueueRow = options => buildNotificationIntent({ ...options, today: notificationToday ?? today });
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
  const oneOffsIncomesFirst = orderOneOffsIncomesFirst(oneOffs);
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
    if (!(claim.amountLedger >= 0)) continue;
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

  // Payment dates may be edited; reserve funding still belongs to its named
  // source/target period rather than the date chosen for the ledger entry.
  function periodForReserveRow(row) {
    const parsed = parseReserveTransferOccurrenceKey(row?.occurrence_key);
    if (!parsed) return null;
    const periodKey = parsed.side === "in" ? parsed.targetPeriodKey : parsed.sourcePeriodKey;
    return periods.find(p => p.key === periodKey) || null;
  }

  if (periods.length) {
    addPeriodAvailable(periods[0], openingBalance);

    // Reserve-transfer rows confirmed on or before today are already folded into
    // openingBalance (and therefore periods[0]). When a reserve transfer belongs
    // to a later period in the projection window (e.g., an ":in" row confirmed
    // early during its source period), move its ledger effect from periods[0] to
    // its designated reserve period so each period's available balance matches
    // the reserve transfer's source/target period semantics.
    for (const row of predictionRows) {
      if (String(row?.ledger_currency || ledgerCurrency) !== ledgerCurrency) continue;
      if (String(row?.date || "") > today) continue;
      const targetPeriod = periodForReserveRow(row);
      if (!targetPeriod || targetPeriod.key === periods[0].key) continue;

      const ledgerAmount = roundMoneyAmount(row.ledger_amount ?? row.amount);
      if (row.type === "income") {
        subtractPeriodAvailable(periods[0], ledgerAmount);
        addPeriodAvailable(targetPeriod, ledgerAmount);
      } else {
        addPeriodAvailable(periods[0], ledgerAmount);
        subtractPeriodAvailable(targetPeriod, ledgerAmount);
      }
    }

    for (const row of pendingByOccurrenceKey.values()) {
      if (String(row.ledger_currency || "PLN") !== ledgerCurrency) continue;
      const targetPeriod = periodForReserveRow(row) || periodForPendingDate(String(row.date || ""));
      if (!targetPeriod) continue;

      const ledgerAmount = roundMoneyAmount(row.ledger_amount);
      if (row.type === "income") addPeriodAvailable(targetPeriod, ledgerAmount);
      else subtractPeriodAvailable(targetPeriod, ledgerAmount);
    }

    for (const row of confirmedRowsAfterToday) {
      const targetPeriod = periodForReserveRow(row) || periodForDate(String(row.date || ""));
      if (!targetPeriod) continue;

      const ledgerAmount = roundMoneyAmount(row.ledger_amount);
      if (row.type === "income") addPeriodAvailable(targetPeriod, ledgerAmount);
      else subtractPeriodAvailable(targetPeriod, ledgerAmount);
    }
  }

  // Enumerate past recurring dates only for identities retained from an earlier
  // plan or explicitly regenerated; never create unrelated historical demand.
  function scheduledDates(item, period, type, sourceField) {
    return recurringOccurrencesInPeriod(item, period, recoveryOccurrenceKeys.size ? null : today)
      .filter(date => date >= today || recoveryOccurrenceKeys.has(makeOccurrenceKey({
        type, date, [sourceField]: item.id
      })));
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

    // Old periods exist solely to recover known occurrences. Recurring date
    // enumeration may include past dates, but only these identities may return.
    if (currentPeriodStart && periods.find(p => p.key === period)?.end < currentPeriodStart
      && !sourceOneOffId && !recoveryOccurrenceKeys.has(occurrenceKey)) {
      return { inserted: false, ledgerAmount: 0 };
    }
    if (date <= today && recoveryOccurrenceKeys.has(occurrenceKey)) toPending = true;

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

  function queueFundingShortfallIfNeeded(entityId, title, message, params) {
    if (!notificationEnabled(settings, "funding_shortfall")) return;

    notificationRows.push(buildNotificationQueueRow({
      dedupeKey: `funding_shortfall:${entityId}`,
      entityId,
      generateId: generateIdFn,
      message,
      params,
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
      params: { name: expense.name, amount: missingAmount.toFixed(2), currency: expense.currency },
      priority: notificationPriority(settings, "necessary_underfunded"),
      queuedAt: generationTimestamp,
      settings,
      title: "Necessary transaction underfunded",
      type: "necessary_underfunded"
    }));
  }

  function hasRemainingGoalDemandInPeriod(period) {
    return goals.some(goal => {
      const allocationDate = goal.due_date < period.end ? goal.due_date : period.end;
      const recovering = recoveryOccurrenceKeys.has(makeOccurrenceKey({
        type: "goal_allocation", date: allocationDate, sourceGoalId: goal.id
      }));
      if (!recovering && (goal.due_date < today || goal.due_date < period.start || goal.due_date > period.end)) {
        return false;
      }

      const targetLedger = roundMoneyAmount(goalTargetLedger.get(goal.id));
      const fundedLedger = addMoneyAmounts(
        (confirmedGoalFunding.get(goal.id) || 0),
        (pendingGoalFunding.get(goal.id) || 0)
      );

      return subtractMoneyAmounts(targetLedger, fundedLedger) > 0.0001;
    });
  }

  function hasRemainingFlexDemandInPeriod(period) {
    return flexes.some(flex => {
      const targetLedger = roundMoneyAmount(flexTargetLedger.get(flex.id));
      const fundedLedger = addMoneyAmounts(
        (confirmedFlexFunding.get(flex.id) || 0),
        (pendingFlexFunding.get(flex.id) || 0),
        (generatedFlexFunding.get(flex.id) || 0)
      );

      if (subtractMoneyAmounts(targetLedger, fundedLedger) <= 0.0001) return false;

      const occurrenceKey = makeOccurrenceKey({
        type: "expense",
        date: period.start,
        sourceFlexId: flex.id
      });

      return (!(currentPeriodStart && period.end < currentPeriodStart) || recoveryOccurrenceKeys.has(occurrenceKey))
        && !handledOccurrenceKeys.has(occurrenceKey) && !pendingByOccurrenceKey.has(occurrenceKey);
    });
  }

  function hasDiscretionaryRecurringDemandInPeriod(period) {
    return recurringExpenses
      .filter(expense => !expense.necessary)
      .some(expense => scheduledDates(expense, period, "expense", "sourceRecurringExpenseId").some(date => {
        const occurrenceKey = makeOccurrenceKey({
          type: "expense",
          date,
          sourceRecurringExpenseId: expense.id
        });

        return (!(currentPeriodStart && period.end < currentPeriodStart) || recoveryOccurrenceKeys.has(occurrenceKey))
        && !handledOccurrenceKeys.has(occurrenceKey) && !pendingByOccurrenceKey.has(occurrenceKey);
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
    if (Number(currentPeriod.available || 0) <= 0) return;

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
      for (const date of scheduledDates(income, period, "income", "sourceRecurringIncomeId")) {
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

    for (const oneOff of oneOffsIncomesFirst) {
      const progressKey = `${oneOff.id}:${oneOff.type}:${String(oneOff.currency || "").toUpperCase()}`;
      const progress = oneOffProgress.get(progressKey) || null;
      const confirmedAmount = roundMoneyAmount(progress?.confirmedAmount || 0);
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
        Math.max(0, roundMoneyAmount(existingPending?.ledger_amount || 0))
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
          `${oneOff.name} could not be fully funded in ${period.key}`,
          { kind: "one_off", name: oneOff.name, period: period.key }
        );

        // Record the one-off's own shortfall so an earlier period's surplus
        // can be reserved for it on the real pass. The period still goes on
        // to fund its necessary expenses (their shortfalls are recorded
        // separately below); period.blocked only keeps goals and
        // discretionary spending out of it.
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

    // An unfunded one-off used to `continue` here, skipping this period's
    // necessary expenses, its reserve-transfer "out" rows and its surplus
    // carry-over — which left a later "Reserved from" income with no
    // matching expense (money from nowhere). period.blocked now only keeps
    // goals and discretionary spending out of this period.

    for (const expense of recurringExpenses.filter(e => e.necessary)) {
      for (const date of scheduledDates(expense, period, "expense", "sourceRecurringExpenseId")) {
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
            `${expense.name} could not be funded in ${period.key}`,
            { kind: "unfunded", name: expense.name, period: period.key }
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
            `${expense.name} was only partially funded in ${period.key}`,
            { kind: "partial", name: expense.name, period: period.key }
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

    if (period.blocked || !hasLocalLowerPriorityDemand(period)) {
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
        (confirmedGoalFunding.get(goal.id) || 0),
        (pendingGoalFunding.get(goal.id) || 0)
      )
    );

    const eligiblePeriods = periods
      .filter(p => !p.blocked && p.start <= goal.due_date
        && (!(currentPeriodStart && p.end < currentPeriodStart) || recoveryOccurrenceKeys.has(makeOccurrenceKey({
          type: "goal_allocation", date: goal.due_date < p.end ? goal.due_date : p.end, sourceGoalId: goal.id
        }))))
      // Restore an already offered allocation before placing remaining demand
      // in later periods; otherwise a future allocation could consume its target.
      .sort((a, b) => {
        const recovering = p => recoveryOccurrenceKeys.has(makeOccurrenceKey({
          type: "goal_allocation", date: goal.due_date < p.end ? goal.due_date : p.end, sourceGoalId: goal.id
        }));
        return Number(recovering(b)) - Number(recovering(a)) || compareEngineText(b.start, a.start);
      });

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
          params: { name: goal.name, amount: remainingLedger.toFixed(2), currency: ledgerCurrency },
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
        `${goal.name} cannot be fully funded by ${goal.due_date}`,
        { kind: "goal", name: goal.name, date: goal.due_date }
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

    const createdCompare = compareEngineText(a.item.created_at || "", b.item.created_at || "");
    if (createdCompare !== 0) return createdCompare;

    return compareEngineText(a.item.id || "", b.item.id || "");
  });

  for (const [periodIndex, period] of periods.entries()) {
    if (period.blocked) continue;

    for (const entry of discretionaryOperatingItems) {
      if (spendableBalance(period) <= 0) break;

      if (entry.kind === "recurring_expense") {
        const expense = entry.item;

        for (const date of scheduledDates(expense, period, "expense", "sourceRecurringExpenseId")) {
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
        (confirmedFlexFunding.get(flex.id) || 0),
        (pendingFlexFunding.get(flex.id) || 0),
        (generatedFlexFunding.get(flex.id) || 0)
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
        addMoneyAmounts((generatedFlexFunding.get(flex.id) || 0) || 0, inserted.ledgerAmount)
      );

      subtractPeriodAvailable(period, inserted.ledgerAmount);
    }

    carrySurplusToNextPeriod(periodIndex);
  }

  for (const goal of goals) {
    const targetLedger = roundMoneyAmount(goalTargetLedger.get(goal.id));

    const alreadyFundedLedger = addMoneyAmounts(
      (confirmedGoalFunding.get(goal.id) || 0),
      (pendingGoalFunding.get(goal.id) || 0)
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
        params: { name: goal.name },
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
