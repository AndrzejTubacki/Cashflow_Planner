import { normalizeManualFxPairs } from "./cashflow-fx-provider-utils.js";
import { ENGINE_AUDIT_HOST_OPTIONS } from './engine-host-capabilities.js';
import { confirmedRowsWithRunningBalances, latestBalanceFromConfirmedRows, sortConfirmedRowsForBalance } from "./cashflow-ledger-balance-utils.js";
import { multiplyMoney, roundMoneyAmount } from "./cashflow-money-utils.js";
import { normalizePriority } from "./cashflow-priority.js";
import { calculateSnapshot } from "./snapshot.js";
import { prepareSnapshot } from "./prepare-snapshot.js";
import { verifyLinkedLedgerAudit } from './linked-ledger-audit.js';
import { oneOffProgressWithOriginals } from './ledger-audit-progress.js';

/** State v2 retains audit evidence; protocol and financial operation shape stay v1. */
export const LINKED_PARTS = ["settings", "planning", "ledger", "currency-events", "fx", "ledger-audit", "fx-snapshot"];
const PLANNING_TABLES = ["planned_transactions", "recurring_incomes", "recurring_expenses", "goals", "flex_transactions",
  "one_off_transactions", "pending_transactions"];
const ENTITY_TABLES = { "one-off": "one_off_transactions", "recurring-income": "recurring_incomes",
  "recurring-expense": "recurring_expenses", goal: "goals", flex: "flex_transactions" };
const SOURCE_COLUMNS = { "one-off": "source_one_off_id", "recurring-income": "source_recurring_income_id",
  "recurring-expense": "source_recurring_expense_id", goal: "source_goal_id", flex: "source_flex_id" };

function plainRow(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

/** Device working view of a linked budget: the accepted server replica plus the
 * device's unsent or unretired intents, applied provisionally in queue order.
 *
 * This is a display model, never authority: the server decides each intent
 * under its own lock, and the next verified download replaces all of it.
 * Intents that cannot be previewed (for example a missing source, or an
 * upcoming occurrence the replica has no row for) are reported in `unapplied`
 * and are left out of the view rather than guessed. */
export function prepareLinkedSnapshot({ budgetId, epoch, revision, parts, pending = [], today, generationTimestamp, idSeed, auditHashes = null }, hostOptions = {}) {
  for (const kind of LINKED_PARTS) if (!Array.isArray(parts?.[kind])) throw new Error(`Linked replica is missing ${kind}`);
  const retained = verifyLinkedLedgerAudit({ budgetId, parts, auditHashes }, hostOptions);
  if (parts.settings.length !== 1) throw new Error("Linked replica must have exactly one settings record");
  const settings = { ...plainRow(parts.settings[0], "settings") };
  const tables = Object.fromEntries(PLANNING_TABLES.map(table => [table, []]));
  for (const record of parts.planning) {
    if (!PLANNING_TABLES.includes(record?.table)) throw new Error("Invalid linked planning record");
    tables[record.table].push({ ...plainRow(record.row, "planning row") });
  }
  // Derived rows are recalculated by the engine, never downloaded.
  tables.future_transactions = [];
  tables.projection_snapshots = [];
  if (parts["currency-events"].length) tables.ledger_currency_events = parts["currency-events"].map(row => ({ ...row }));
  let ledger = parts.ledger.map(row => ({ ...plainRow(row, "ledger row") }));
  let fxSnapshot = parts["fx-snapshot"].length === 1 ? (parts["fx-snapshot"][0]?.snapshot ?? null) : null;
  // These identities remain owned by accepted history even after a source is
  // deleted or its effective payment is voided. Preview the same reservations
  // the server enforces, including reuse across different planning kinds.
  const retainedRows = retained?.replay.originals.map(original => original.row) || [];
  const sourceFields = Object.values(SOURCE_COLUMNS);
  const reservedSourceIds = new Set([...ledger, ...retainedRows].flatMap(row => sourceFields.map(field => row[field]).filter(Boolean)));
  const reservedPaymentIds = new Set(retainedRows.map(row => row.id));

  const applied = [];
  const unapplied = [];
  for (const operation of pending) {
    const reason = applyProvisional(operation, { settings, tables, ledger, generationTimestamp,
      reservedSourceIds, reservedPaymentIds, originOpening: retained?.replay.opening ?? null, setLedger: rows => { ledger = rows; } });
    if (reason) unapplied.push({ operationId: operation.operationId, reason });
    else applied.push(operation.operationId);
  }

  // The server materializes manual-provider rates from settings, rather than
  // its provider cache. Preview that policy only when a settings intent applied;
  // accepted cached dates and provider rates otherwise remain untouched.
  if (settings.fx_provider === "manual" && pending.some(op => op.kind === "settings.update" && applied.includes(op.operationId))) {
    fxSnapshot = Object.fromEntries(Object.entries(fxSnapshot || {}).filter(([, entry]) => entry.source !== "manual"));
    for (const [pair, rate] of Object.entries(normalizeManualFxPairs(settings.manual_fx_rates, settings.ledger_currency))) {
      const [base, quote] = pair.split("/");
      fxSnapshot[pair.toLowerCase()] = { currency: base, baseCurrency: base, quoteCurrency: quote,
        rate, effectiveDate: today, source: "manual" };
    }
  }

  // Origins have an explicit signed offset, including an entirely voided
  // ledger. Recompute provisional totals from that proof, never from a first
  // row that may not exist or from a client-supplied setting.
  const ledgerCurrency = settings.ledger_currency || "PLN";
  const opening = retained?.replay.opening;
  const originOpening = opening?.ledgerCurrency === ledgerCurrency ? opening.amount : 0;
  if (opening) {
    const current = ledger.filter(row => (row.ledger_currency || "PLN") === ledgerCurrency);
    ledger = [...ledger.filter(row => (row.ledger_currency || "PLN") !== ledgerCurrency),
      ...confirmedRowsWithRunningBalances(current, { openingBalance: originOpening })];
  }
  const snapshot = prepareSnapshot({ budgetId, revision, settings, tables, confirmedRows: ledger, fxSnapshot,
    today, generationTimestamp, idSeed });
  if (opening) snapshot.request.openingBalance = latestBalanceFromConfirmedRows(
    ledger.filter(row => (row.ledger_currency || "PLN") === ledgerCurrency && String(row.date) <= today),
    { openingBalance: originOpening });
  if (retained) snapshot.request.oneOffProgress = [...oneOffProgressWithOriginals(ledger, retained.replay.originals)];
  const result = { ...snapshot, linked: { epoch, revision, provisionalOperationIds: applied, unapplied,
    ...(retained ? { acceptedAudit: retained.audit, correctionHeads: retained.replay.heads,
      ...(opening ? { acceptedEvidence: { originals: retained.replay.originals, corrections: retained.replay.corrections } } : {}) } : {}) } };
  calculateSnapshot(result);
  return result;
}

/** Returns null when applied, or a short reason code when it cannot be previewed. */
function applyProvisional(operation, state) {
  const { kind, payload } = operation || {};
  if (!payload || typeof payload !== "object") return "INVALID_OPERATION";
  const { settings, tables, generationTimestamp } = state;
  if (kind === "settings.update") {
    if (Object.hasOwn(payload, "budget_period_income_id")) {
      const selected = payload.budget_period_income_id;
      if (selected && !tables.recurring_incomes.some(row => row.id === selected)) return "SOURCE_NOT_FOUND";
      // Exactly the selected income defines periods, as in the settings service.
      for (const row of tables.recurring_incomes) row.period_setting = row.id === selected ? 1 : 0;
    }
    Object.assign(settings, payload);
    return null;
  }
  // A correction's financial outcome belongs to the server's retained audit.
  // Keep queued work visible without showing a predicted result as accepted.
  if (kind === 'ledger.correct') return 'CORRECTION_AWAITING_SERVER';
  if (kind === "occurrence.confirm") return confirmProvisional(payload, state);
  if (kind === "one-off.dismiss-remainder") {
    const pending = tables.pending_transactions.find(row => row.occurrence_key === payload.occurrenceKey);
    if (!pending?.source_one_off_id) return "OCCURRENCE_NOT_FOUND";
    tables.pending_transactions = tables.pending_transactions.filter(row => row !== pending);
    return null;
  }
  const match = /^(one-off|recurring-income|recurring-expense|goal|flex)\.(create|update|delete)$/.exec(String(kind));
  if (!match) return "UNSUPPORTED_OPERATION";
  const [, entity, action] = match;
  const table = ENTITY_TABLES[entity];
  const { id, reassignAnchorsToIncomeId: _reassign, fallbackAnchorsToFixedDay: _fallback, ...fields } = payload;
  const index = tables[table].findIndex(row => row.id === id);
  const { priority, ...values } = fields;
  if (action === "create") {
    if (state.reservedSourceIds.has(id) || Object.values(ENTITY_TABLES).some(name => tables[name].some(row => row.id === id))) return "SOURCE_EXISTS";
    const row = createdRow(entity, values, settings, generationTimestamp);
    if (PRIORITY_DOMAINS[entity]) row.planned_transaction_id = insertPlanned(tables, entity, id, priority, generationTimestamp);
    tables[table].push({ ...row, id });
    if (entity === "recurring-income" && row.period_setting) settings.budget_period_income_id = id;
    return null;
  }
  if (index < 0) return "SOURCE_NOT_FOUND";
  if (action === "update") {
    const current = tables[table][index];
    tables[table][index] = { ...current, ...booleans(values), updated_at: generationTimestamp };
    if (priority !== undefined && current.planned_transaction_id) {
      reorderPriority(tables, PRIORITY_DOMAINS[entity], current.planned_transaction_id, priority, generationTimestamp);
    }
    return null;
  }
  tables[table].splice(index, 1);
  // A deleted source's own pending occurrences go with it.
  const column = SOURCE_COLUMNS[entity];
  tables.pending_transactions = tables.pending_transactions.filter(row => row[column] !== id);
  return null;
}

/** Planning-priority domains (server `priorityTypesForDomain`). */
const PRIORITY_DOMAINS = { "recurring-expense": "operating", flex: "operating", goal: "goal" };
const PLANNED_TYPES = { "recurring-expense": "recurring_expense", flex: "flex", goal: "goal" };
const BOOLEAN_FIELDS = ["active", "necessary", "allow_split", "period_setting"];

function booleans(values) {
  const result = { ...values };
  for (const key of BOOLEAN_FIELDS) if (typeof result[key] === "boolean") result[key] = result[key] ? 1 : 0;
  return result;
}

/** The server's create defaults (plan-mutation `create*WithBudgetStore`). */
function createdRow(entity, input, settings, timestamp) {
  const base = { ...booleans(input), currency: input.currency || "PLN", name: input.name || "Unnamed", amount: input.amount ?? 0,
    created_at: timestamp, updated_at: timestamp };
  if (entity === "one-off") return base;
  if (entity === "goal" || entity === "flex") {
    return { ...base, active: base.active ?? 1, ...(entity === "flex" ? { allow_split: base.allow_split ?? 0,
      min_amount: input.min_amount ?? null, max_amount: input.max_amount ?? null } : {}) };
  }
  const strategies = entity === "recurring-income" ? ["fixed", "12month_min"] : ["fixed", "12month_max"];
  const strategy = strategies.includes(input.prediction_strategy) ? input.prediction_strategy : "fixed";
  const minMonths = Math.trunc(Number(input.prediction_min_recorded_months));
  const row = { ...base, active: base.active ?? 1,
    anchor_business_day_adjustment: input.anchor_business_day_adjustment || "none",
    anchor_day_of_month: input.anchor_day_of_month ?? null,
    anchor_holiday_country: input.anchor_holiday_country || settings.holiday_country || "PL",
    anchor_offset_days: input.anchor_offset_days ?? 0,
    anchor_type: ["day_of_month", "month_end"].includes(input.anchor_type) ? input.anchor_type : "month_end",
    prediction_min_recorded_months: Number.isFinite(minMonths) ? Math.max(1, Math.min(12, minMonths)) : 6,
    prediction_strategy: strategy,
    prediction_substitute_missing: strategy === "fixed" ? "none" : (input.prediction_substitute_missing || "none"),
    repeat_every_months: input.repeat_every_months ?? 1,
    start_month_year: input.start_month_year || null,
    end_month_year: input.end_month_year || null };
  if (entity === "recurring-income") return { ...row, period_setting: base.period_setting ?? 0 };
  return { ...row, necessary: base.necessary ?? 0, anchor_income_id: input.anchor_income_id ?? null };
}

function insertPlanned(tables, entity, sourceId, priority, timestamp) {
  const plannedId = `planned-provisional-${sourceId}`;
  tables.planned_transactions.push({ id: plannedId, type: PLANNED_TYPES[entity], operating_priority: null, goal_priority: null,
    created_at: timestamp, updated_at: timestamp });
  reorderPriority(tables, PRIORITY_DOMAINS[entity], plannedId, priority, timestamp);
  return plannedId;
}

/** Server `reorderPriorityDomain`: insert at the requested position, renumber 1..n. */
function reorderPriority(tables, domain, plannedId, requested, timestamp) {
  const column = domain === "goal" ? "goal_priority" : "operating_priority";
  const types = domain === "goal" ? ["goal"] : ["recurring_expense", "flex"];
  const rank = row => row[column] === null || row[column] === undefined ? 999999 : Number(row[column]);
  const ordered = tables.planned_transactions.filter(row => types.includes(row.type)).sort((a, b) =>
    rank(a) - rank(b) || String(a.created_at || "").localeCompare(String(b.created_at || "")) || String(a.id).localeCompare(String(b.id)))
    .map(row => row.id).filter(id => id !== plannedId);
  ordered.splice(Math.max(0, Math.min(normalizePriority(requested) - 1, ordered.length)), 0, plannedId);
  ordered.forEach((id, index) => {
    const row = tables.planned_transactions.find(value => value.id === id);
    row[column] = index + 1;
    row.updated_at = timestamp;
  });
}

/** Mirrors the server's confirmation of a pending row: the ledger row takes the
 * pending row's ID, the actual date and amount, the stated rate, and running
 * balances are recomputed over the whole ledger. */
function confirmProvisional(payload, state) {
  const { settings, tables, ledger, generationTimestamp } = state;
  const pending = tables.pending_transactions.find(row => row.occurrence_key === payload.occurrenceKey);
  if (!pending) return "OCCURRENCE_NOT_PREVIEWED";
  if (state.reservedPaymentIds.has(pending.id) || ledger.some(row => row.id === pending.id || row.occurrence_key === payload.occurrenceKey)) return "ALREADY_CONFIRMED";
  const ledgerCurrency = settings.ledger_currency || "PLN";
  const rate = pending.currency === ledgerCurrency ? 1 : payload.fxRate;
  if (!Number.isFinite(rate) || rate <= 0) return "FX_RATE_REQUIRED";
  const amount = roundMoneyAmount(payload.amount);
  const row = {
    id: pending.id, name: pending.name, currency: pending.currency, amount, type: pending.type === "income" ? "income" : "expense",
    date: payload.confirmedDate, confirmed_date: payload.confirmedDate, fx_rate: rate, buffered_fx_rate: rate,
    ledger_amount: multiplyMoney(amount, rate), ledger_currency: ledgerCurrency, ledger_year: Number(String(payload.confirmedDate).slice(0, 4)),
    occurrence_key: payload.occurrenceKey, running_balance_pln: 0,
    source_flex_id: pending.source_flex_id || null, source_goal_id: pending.source_goal_id || null,
    source_one_off_id: pending.source_one_off_id || null, source_recurring_expense_id: pending.source_recurring_expense_id || null,
    source_recurring_income_id: pending.source_recurring_income_id || null,
    created_at: generationTimestamp, updated_at: generationTimestamp
  };
  tables.pending_transactions = tables.pending_transactions.filter(value => value !== pending);
  // Running balances of the current ledger currency are recomputed in order;
  // the opening balance is what the first accepted row implies.
  const current = sortConfirmedRowsForBalance(ledger.filter(value => (value.ledger_currency || "PLN") === ledgerCurrency));
  const first = current[0];
  const opening = state.originOpening
    ? (state.originOpening.ledgerCurrency === ledgerCurrency ? state.originOpening.amount : 0)
    : first && first.running_balance_pln !== null && first.running_balance_pln !== undefined
    ? roundMoneyAmount(Number(first.running_balance_pln) + (first.type === "income" ? -1 : 1) * Number(first.ledger_amount ?? first.amount))
    : 0;
  const recomputed = confirmedRowsWithRunningBalances([...current, row], { openingBalance: opening });
  state.setLedger([...ledger.filter(value => (value.ledger_currency || "PLN") !== ledgerCurrency), ...recomputed]);
  // Later queued edits must respect this newly previewed payment too; deleting
  // its source cannot make the accepted-intent identity available again.
  state.reservedPaymentIds.add(row.id);
  for (const field of Object.values(SOURCE_COLUMNS)) if (row[field]) state.reservedSourceIds.add(row[field]);
  return null;
}

export function prepareLinkedSnapshotJson(json) {
  try { return JSON.stringify({ ok: true, snapshot: prepareLinkedSnapshot(JSON.parse(json), ENGINE_AUDIT_HOST_OPTIONS) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: "LINKED_SNAPSHOT_REJECTED", message: error.message } }); }
}
