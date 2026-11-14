import { originalOneOffCountsFromEvidence } from "./ledger-audit-progress.js";
import { localLinkedOrigin, linkedOriginTimeline, linkedOriginOpeningCurrency } from "./local-linked-origin.js";
import { ledgerConversionBalances, ledgerConversionRecords } from "./ledger-currency-change.js";
import { requireSupportedCurrency } from "./cashflow-fx-provider-utils.js";
import { requireIsoDate, recurringOccurrencesInPeriod } from "./cashflow-date-utils.js";
import { confirmedRowsWithRunningBalances, sortConfirmedRowsForBalance } from "./cashflow-ledger-balance-utils.js";
import { addMoneyAmounts, multiplyMoney, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import { occurrenceKeyFromRow, parseReserveTransferOccurrenceKey } from "./cashflow-occurrence-utils.js";
import { validateLocalPlanning } from "./local-validation.js";

const SOURCE_FIELDS = [
  ["source_one_off_id", "one_off_transactions"], ["source_recurring_income_id", "recurring_incomes"],
  ["source_recurring_expense_id", "recurring_expenses"], ["source_goal_id", "goals"], ["source_flex_id", "flex_transactions"]
];
const TABLES = ["planned_transactions", "one_off_transactions", "recurring_incomes", "recurring_expenses", "goals", "flex_transactions"];
const copy = value => JSON.parse(JSON.stringify(value));

/** Structural equality is independent of JSON object key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Reject future/unknown event fields instead of discarding audit evidence. */
function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) throw new Error("Unsupported local audit fields");
}
/** Payments are positive precise cents; opening/running balances may be signed. */
/** Same-currency rows carry rate 1 and their own amount. A foreign row carries
 * one positive recorded rate (server confirmations store fx = buffered) and
 * ledger_amount = amount × rate in the ledger currency. */
function consistentLedgerAmount(row, ledgerCurrency) {
  if (row.currency === ledgerCurrency) {
    return row.fx_rate === 1 && row.buffered_fx_rate === 1 && (row.ledger_amount === undefined || row.ledger_amount === row.amount);
  }
  return Number.isFinite(row.fx_rate) && row.fx_rate > 0 && row.fx_rate <= 1000000 && row.buffered_fx_rate === row.fx_rate
    && row.ledger_amount === multiplyMoney(row.amount, row.fx_rate);
}

/** The corrected row keeps the original's identity; a foreign payment may
 * re-enter its rate, otherwise it keeps the rate recorded with the payment. */
function correctedRow(original, requested, today, createdAt) {
  const foreign = original.currency !== original.ledger_currency;
  if (!foreign && Object.hasOwn(requested, "fx_rate")) throw new Error("Same-currency corrections have no exchange rate");
  const rate = foreign ? (requested.fx_rate ?? original.fx_rate) : 1;
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1000000) throw new Error("Invalid local correction exchange rate");
  return { ...withoutBalance(original), amount: requested.amount, ledger_amount: foreign ? multiplyMoney(requested.amount, rate) : requested.amount,
    fx_rate: rate, buffered_fx_rate: rate, date: requested.date, ledger_year: Number(String(requested.date).slice(0, 4)),
    confirmed_date: today, updated_at: createdAt };
}

function money(value, positive = true) {
  return typeof value === "number" && Number.isFinite(value) && (!positive || value > 0)
    && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001;
}
/** Only explicit UTC instants are accepted; no ambient date/timezone is used. */
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error("Invalid local audit timestamp");
  requireIsoDate(value.slice(0, 10));
}
/** Running balances are derived, so reversal equality compares accepted facts. */
function withoutBalance(row) {
  if (row === null) return null;
  const value = copy(row);
  delete value.running_balance_pln;
  return value;
}

/** Capture the financial source used at acceptance. This evidence remains
 * independent of later planning edits/deletion; no server state is captured. */
export function captureLocalSource(row, tables) {
  const references = SOURCE_FIELDS.filter(([field]) => row[field]);
  if (references.length !== 1) throw new Error("Ambiguous local payment source");
  const [field, table] = references[0];
  const source = tables[table]?.find(value => value.id === row[field]);
  if (!source) throw new Error("Local payment source is missing");
  const plan = source.planned_transaction_id
    ? tables.planned_transactions.find(value => value.id === source.planned_transaction_id) : null;
  return copy({ table, row: source, plan });
}

/** Validate retained evidence using the same standalone planning subset. Every
 * explicit scope must match, including records no longer in current planning. */
function validateEvidence(evidence, settings, budgetId) {
  exactKeys(evidence, ["table", "row", "plan"]);
  if (evidence.table === "ledger_currency_events") {
    if (evidence.plan !== null) throw new Error("Invalid conversion source");
    requireSupportedCurrency(evidence.row.old_currency); requireSupportedCurrency(evidence.row.new_currency);
    return;
  }
  if (!SOURCE_FIELDS.some(([, table]) => table === evidence.table)) throw new Error("Invalid local audit source table");
  const tables = Object.fromEntries(TABLES.map(table => [table, []]));
  // Budget-period selection is a cross-table setting that may change after capture;
  // a single captured source is validated without it. Other period_setting values still fail.
  const row = { ...evidence.row };
  if (row.period_setting === 1 || row.period_setting === true) row.period_setting = 0;
  tables[evidence.table] = [row];
  if (evidence.plan !== null) tables.planned_transactions = [evidence.plan];
  validateLocalPlanning({ settings: { ...settings, budget_period_income_id: null }, tables }, { requireRates: false });
  for (const value of [evidence.row, evidence.plan]) {
    if (value && Object.hasOwn(value, "budget_id") && value.budget_id !== budgetId) throw new Error("Foreign local audit source scope");
  }
}

/** Original accepted facts are never overwritten by a correction. Validate
 * source/date/currency and recorded metadata before deriving effective rows. */
function validateOriginal(row, evidence, { settings, today, budgetId }) {
  const currency = settings.ledger_currency;
  const reserveTransfer = parseReserveTransferOccurrenceKey(row?.occurrence_key);
  // Reserve halves are system-generated facts without a mutable planning
  // source. Replay still checks side, currency, metadata and money dependencies.
  if (reserveTransfer) {
    if (evidence !== null || row.type !== reserveTransfer.type
      || row.currency !== currency || row.ledger_currency !== currency
      || !consistentLedgerAmount(row, currency) || !money(row.amount, false) || row.amount < 0
      || typeof row.id !== "string" || !row.id
      || typeof row.name !== "string" || !row.name.trim()
      || row.status !== "confirmed"
      || row.ledger_year !== Number(String(row.date).slice(0, 4))
      || SOURCE_FIELDS.some(([field]) => row[field] != null)) {
      throw new Error("Invalid reserve transfer confirmation");
    }
    if (Object.hasOwn(row, "budget_id") && row.budget_id !== budgetId) throw new Error("Foreign local audit payment scope");
    requireIsoDate(row.date); requireIsoDate(row.confirmed_date); timestamp(row.created_at);
    if (row.date > today || row.confirmed_date < row.date || row.confirmed_date > today) throw new Error("Invalid original local audit date");
    return;
  }
  validateEvidence(evidence, settings, budgetId);
  if (evidence.table === "ledger_currency_events") {
    const event = evidence.row;
    const expected = ledgerConversionRecords({ oldCurrency: event.old_currency, newCurrency: event.new_currency,
      ...ledgerConversionBalances(event.old_balance, event.fx_rate), rate: event.fx_rate,
      rateDate: event.rate_date, source: event.source },
      { eventId: event.id, pendingId: row.occurrence_key?.slice("ledger_currency_conversion:".length), timestamp: event.created_at }).pending;
    if (row.currency !== currency || row.ledger_currency !== currency || row.currency !== event.new_currency
      || row.note !== expected.note || row.type !== expected.type || (!money(row.amount) && row.amount !== 0)
      || typeof row.id !== "string" || !row.id || row.ledger_year !== Number(String(row.date).slice(0, 4))
      || (Object.hasOwn(row, "budget_id") && row.budget_id !== budgetId)
      || !consistentLedgerAmount(row, currency) || row.status !== "confirmed"
      || SOURCE_FIELDS.some(([field]) => row[field])) throw new Error("Invalid conversion confirmation");
    requireIsoDate(row.date); requireIsoDate(row.confirmed_date); timestamp(row.created_at);
    if (row.date < event.rate_date || row.date > today || row.confirmed_date > today || row.confirmed_date < row.date) throw new Error("Invalid conversion date");
    return;
  }
  const refs = SOURCE_FIELDS.filter(([field]) => row[field]);
  if (refs.length !== 1 || refs[0][1] !== evidence.table || row[refs[0][0]] !== evidence.row.id
    || !["income", "expense"].includes(row.type) || row.currency !== evidence.row.currency || row.ledger_currency !== currency
    || !consistentLedgerAmount(row, currency) || !money(row.amount)
    || typeof row.id !== "string" || !row.id || row.status !== "confirmed"
    || row.ledger_year !== Number(String(row.date).slice(0, 4))) throw new Error("Invalid original local audit payment");
  if (Object.hasOwn(row, "budget_id") && row.budget_id !== budgetId) throw new Error("Foreign local audit payment scope");
  requireIsoDate(row.date); requireIsoDate(row.confirmed_date); timestamp(row.created_at);
  if (row.date > today || row.confirmed_date < row.date || row.confirmed_date > today) throw new Error("Invalid original local audit date");
  const expectedType = evidence.table === "one_off_transactions" ? evidence.row.type
    : evidence.table === "recurring_incomes" ? "income" : "expense";
  if (expectedType !== row.type) throw new Error("Original payment differs from its source");
  // `date` is the actual payment date (server parity) and may differ from the
  // scheduled occurrence. Schedule, identity and deadline rules use the
  // occurrence date: the one-off's own date, otherwise the key's trailing date.
  const keyDate = /:(\d{4}-\d{2}-\d{2})$/.exec(String(row.occurrence_key || ""))?.[1];
  const occurrenceDate = evidence.table === "one_off_transactions" ? evidence.row.date : keyDate;
  if (!occurrenceDate) throw new Error("Invalid original local audit occurrence");
  // An occurrence may be recorded early (server move-to-pending); only the payment date is bounded by today.
  requireIsoDate(occurrenceDate);
  const initialKey = occurrenceKeyFromRow({ ...row, date: occurrenceDate, ...(evidence.table === "goals" ? { type: "goal_allocation" } : {}) });
  if (evidence.table === "one_off_transactions") {
    const prefix = `one_off_remainder:${evidence.row.id}:`;
    const suffix = typeof row.occurrence_key === "string" && row.occurrence_key.startsWith(prefix) ? row.occurrence_key.slice(prefix.length) : "";
    const remainder = /^[1-9][0-9]*$/.test(suffix) && Number.isSafeInteger(Number(suffix)) && Number(suffix) >= 2;
    if (row.occurrence_key !== initialKey && !remainder) {
      throw new Error("Invalid original installment occurrence");
    }
  } else if (row.occurrence_key !== initialKey) throw new Error("Invalid original local audit occurrence");
  if (evidence.table.startsWith("recurring_")
    && !recurringOccurrencesInPeriod(evidence.row, { start: occurrenceDate, end: occurrenceDate }).includes(occurrenceDate)) throw new Error("Invalid original recurring audit date");
  if (evidence.table === "goals" && occurrenceDate > evidence.row.due_date) throw new Error("Invalid original goal audit date");
}

/** Financial dependency checks use complete effective history. A blocked intent
 * leaves accepted money untouched and stores a stable, non-sensitive reason. */
/** One-offs, goals and flex complete once their target is paid; nothing may follow. */
function completedBefore(rows, evidence) {
  if (!evidence || !["one_off_transactions", "goals", "flex_transactions"].includes(evidence.table)) return false;
  const field = SOURCE_FIELDS.find(([, table]) => table === evidence.table)[0];
  return rows.filter(row => row[field] === evidence.row.id).reduce((sum, row) => addMoneyAmounts(sum, row.amount), 0) >= evidence.row.amount;
}

/** Payments may exceed their source amount (server parity: the extra comes out
 * of available money). `amountLimits` reproduces the earlier per-source cap only
 * to recognise intentions that were blocked by it and stored that way.
 * `deadlineLimits` reproduces the captured deadline rule of unmarked events;
 * actual payment dates are independent of allocation deadlines in policy 2. */
function failureFor(rows, opening, evidence, targetLimit = null, amountLimits = false, deadlineLimits = true) {
  const balances = localAuditBalances(rows, opening);
  if (balances.some(row => !money(row.running_balance_pln, false))) return "unsafe_balance";
  if (balances.some(row => row.running_balance_pln < -0.005 && !String(row.occurrence_key || "").startsWith("ledger_currency_conversion:"))) return "history_overdraft";
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.occurrence_key)) return "duplicate_occurrence";
    seen.add(row.occurrence_key);
  }
  if (evidence && evidence.table !== "ledger_currency_events") {
    const field = SOURCE_FIELDS.find(([, table]) => table === evidence.table)[0];
    const payments = rows.filter(row => row[field] === evidence.row.id);
    if (amountLimits && evidence.table.startsWith("recurring_") && payments.some(row => row.amount > evidence.row.amount)) return "source_limit";
    if (amountLimits && evidence.table === "flex_transactions" && evidence.row.allow_split && evidence.row.max_amount > 0
      && payments.some(row => row.amount > evidence.row.max_amount)) return "source_limit";
    if (deadlineLimits && evidence.table === "goals" && payments.some(row => row.date > evidence.row.due_date)) return "source_date";
  }
  if (evidence && amountLimits && ["one_off_transactions", "goals", "flex_transactions"].includes(evidence.table)) {
    const field = SOURCE_FIELDS.find(([, table]) => table === evidence.table)[0];
    const total = rows.filter(row => row[field] === evidence.row.id).reduce((sum, row) => addMoneyAmounts(sum, row.amount), 0);
    if (total > (targetLimit ?? evidence.row.amount)) return "source_limit";
  }
  return null;
}

/** Independent running balances per ledger currency. The original opening
 * offset belongs only to its captured currency, even when switching back. */
export function localAuditBalances(rows, opening) {
  if (typeof opening === "number") return confirmedRowsWithRunningBalances(rows, { openingBalance: opening });
  const currencies = [...new Set(rows.map(row => row.ledger_currency))];
  const balanced = currencies.flatMap(currency => confirmedRowsWithRunningBalances(rows.filter(row => row.ledger_currency === currency),
    { openingBalance: currency === opening.currency ? opening.amount : 0 }));
  return sortConfirmedRowsForBalance(balanced);
}

/** Only the first captured currency owns the pre-audit opening balance. */
function scopedOpening(events, opening, settings) {
  return { amount: opening, currency: events[0]?.kind === "linked-origin"
    ? linkedOriginOpeningCurrency(events[0], settings.ledger_currency)
    : events.find(event => event.kind === "ledger-currency")?.event.old_currency || settings.ledger_currency };
}

/** Changing a payment already used as a conversion opening would invalidate
 * that later financial decision. Preserve a blocked intention for review. */
function currencyDependency(events, targetId, before, after) {
  if (events[0]?.kind === 'linked-origin') {
    const timeline = linkedOriginTimeline(events[0]);
    if (timeline) events = [...timeline, ...events.slice(1)];
  }
  const position = events.findIndex(event => event.kind === "payment" && event.id === targetId);
  if (position < 0 && events[0]?.kind === "linked-origin" && events[0].currencyEvents.some(event => event.old_currency === (before || after)?.ledger_currency) && ((before ? (before.type === "income" ? 1 : -1) * before.ledger_amount : 0) !== (after ? (after.type === "income" ? 1 : -1) * after.ledger_amount : 0))) return "currency_conversion_dependency";
  const currency = (before || after)?.ledger_currency;
  const signed = row => row ? (row.type === "income" ? 1 : -1) * (row.ledger_amount ?? row.amount) : 0;
  return signed(before) !== signed(after) && events.slice(position + 1).some(event =>
    event.kind === "ledger-currency" && event.event.old_currency === currency) ? "currency_conversion_dependency" : null;
}

/** Recompute conversions in acceptance order using only payments known at each
 * switch. Original events remain immutable. A confirmed conversion preserves
 * its signed deviation from the generated amount; a void stays void. The full
 * downstream history is then checked, so reduced funding cannot spend twice. */
function conversionEffects(events, rows, conversions, opening, resolveOrdering = false) {
  let orderingResolution;
  if (events[0]?.kind === 'linked-origin') {
    const timeline = linkedOriginTimeline(events[0], resolveOrdering);
    if (timeline) {
      if (resolveOrdering && !linkedOriginTimeline(events[0])) orderingResolution = {
        version: 1, basis: timeline.some(value => value.order?.resolution) ? 'accepted-journal-receipts' : 'accepted-currency-boundaries',
        switches: timeline.filter(value => value.kind === 'ledger-currency').map(value => value.order || {
          version: 1, eventId: value.id, conversionId: value.pending.id, basis: 'captured-standalone-origin'
        })
      };
      if (resolveOrdering && events[0].version === 1) {
        // A fresh reviewed v1 rebase can supply previously unknown conversion
        // identities without changing the immutable origin or old outcomes.
        const captured = localLinkedOrigin({ ...events[0], version: 2 }, events[0].audit.budgetId).conversions;
        conversions = new Map([...captured, ...conversions]);
      }
      events = [...timeline, ...events.slice(1)];
    }
  }
  const effective = new Map(rows.map(row => [row.id, withoutBalance(row)]));
  const positions = new Map(events.flatMap((event, position) => event.kind === "payment" ? [[event.id, position]] : []));
  const changes = [], nextConversions = new Map(conversions);
  for (const [position, event] of events.entries()) {
    if (event.kind !== "ledger-currency") continue;
    const prior = nextConversions.get(event.pending.occurrence_key);
    const change = event.event;
    const prefix = [...effective.values()].filter(row => positions.get(row.id) < position && row.ledger_currency === change.old_currency);
    const balances = localAuditBalances(prefix, opening);
    // Setup openings consumed by this server switch remain accepted signed
    // facts. They are independent of the payment being corrected.
    const details = typeof change.details === 'string' ? JSON.parse(change.details) : change.details;
    const stagedOpening = (details?.firstRunOpeningRows || []).reduce((sum, row) =>
      addMoneyAmounts(sum, (row.type === 'expense' ? -1 : 1) * (row.ledger_amount ?? row.amount)), 0);
    const oldBalance = addMoneyAmounts(balances.at(-1)?.running_balance_pln ?? (change.old_currency === opening.currency ? opening.amount : 0), stagedOpening);
    const recomputed = ledgerConversionRecords({ oldCurrency: change.old_currency, newCurrency: change.new_currency,
      ...ledgerConversionBalances(oldBalance, change.fx_rate), rate: change.fx_rate, rateDate: change.rate_date, source: change.source },
      { eventId: event.id, pendingId: event.pending.id, timestamp: change.created_at });
    if (canonical(prior.event) === canonical(recomputed.event)) continue;
    const payment = events.find(value => value.kind === "payment" && value.row.occurrence_key === event.pending.occurrence_key);
    const before = payment ? effective.get(payment.id) || null : null;
    let after = before;
    if (before) {
      const signed = (before.type === "income" ? 1 : -1) * before.amount;
      const amount = addMoneyAmounts(signed, subtractMoneyAmounts(recomputed.event.converted_opening_balance, prior.event.converted_opening_balance));
      after = { ...before, amount: Math.abs(amount), ledger_amount: Math.abs(amount),
        type: amount >= 0 ? "income" : "expense", note: recomputed.pending.note };
      effective.set(payment.id, after);
    }
    changes.push({ eventId: event.id, before: prior, after: recomputed, paymentId: payment?.id || null,
      paymentBefore: before, paymentAfter: after, outcome: !payment ? "pending" : before ? "confirmed" : "voided" });
    nextConversions.set(event.pending.occurrence_key, { ...event, ...recomputed });
  }
  const balances = localAuditBalances([...effective.values()], opening);
  return { changes, balances, conversions: nextConversions, ...(orderingResolution ? { orderingResolution } : {}) };
}

/** Missing policyVersion denotes the original deadline rule. New records carry
 * exactly version 2; older readers reject that field rather than reinterpret money. */
function policyFields(event) {
  if (!Object.hasOwn(event, "policyVersion")) return [];
  if (event.policyVersion !== 2) throw new Error("Unsupported local audit policy version");
  return ["policyVersion"];
}

/** Replay append-only evidence. Reversal/replacement links, prior heads and
 * before/after facts are checked; changing a blocked status cannot accept money. */
export function replayLocalAudit({ events, opening, settings, today, budgetId, legacyCount = 0 }) {
  if (!Array.isArray(events) || !money(opening, false)) throw new Error("Complete local audit and opening balance required");
  if (!Number.isSafeInteger(legacyCount) || legacyCount < 0 || legacyCount > events.length) throw new Error("Invalid legacy audit boundary");
  requireIsoDate(today);
  opening = scopedOpening(events, opening, settings);
  const finalCurrency = settings.ledger_currency;
  settings = { ...settings, ledger_currency: opening.currency };
  const currencyEvents = [];
  let retainedPending = [];
  let conversions = new Map();
  const active = new Map(), originals = new Map(), heads = new Map(), entries = new Map(), oneOffCounts = new Map();
  const legacySources = new Map(), legacyKeys = new Map(), legacyTotals = new Map(), sourceKinds = new Map();
  for (const [position, event] of events.entries()) {
    if (typeof event?.id !== "string" || !event.id || entries.has(event.id)) throw new Error("Duplicate or missing local audit identifier");
    if (event.kind === "linked-origin") {
      if (position !== 0 || legacyCount !== 0) throw new Error("Linked origin must start a new journal");
      const seed = localLinkedOrigin(event, budgetId);
      if (opening.amount !== seed.opening.amount) throw new Error("Linked opening differs from retained proof");
      opening.currency = seed.opening.ledgerCurrency || settings.ledger_currency;
      for (const [id, original] of seed.originals) { originals.set(id, original); sourceKinds.set(original.source?.row.id, original.source?.table); }
      for (const row of seed.rows) active.set(row.id, withoutBalance(row));
      for (const [id, head] of seed.replay.heads) heads.set(id, head);
      for (const [id, correction] of seed.replay.corrections) entries.set(id, { ...correction, kind: 'correction' });
      for (const [id, count] of originalOneOffCountsFromEvidence(seed.originals.values())) oneOffCounts.set(id, count);
      currencyEvents.push(...seed.currencyEvents);
      conversions = seed.conversions;
      retainedPending = seed.pending.filter(row => !seed.conversions.has(row.occurrence_key));
      settings.ledger_currency = event.ledgerCurrency;
    } else if (event.kind === "ledger-currency") {
      if (position < legacyCount) throw new Error("Legacy boundary crosses a currency change");
      exactKeys(event, ["kind", "id", "event", "pending"]);
      const change = event.event;
      requireSupportedCurrency(change.old_currency); requireSupportedCurrency(change.new_currency);
      requireIsoDate(change.rate_date); timestamp(change.created_at);
      if (change.rate_date > today || change.old_currency !== settings.ledger_currency || change.new_currency === change.old_currency
        || event.id !== change.id || [...conversions.keys()].some(key => ![...originals.values()].some(value => value.row.occurrence_key === key))) {
        throw new Error("Invalid or pending local ledger currency conversion");
      }
      const rows = localAuditBalances([...active.values()], opening).filter(row => row.ledger_currency === change.old_currency);
      const oldBalance = rows.at(-1)?.running_balance_pln ?? (change.old_currency === opening.currency ? opening.amount : 0);
      const expected = ledgerConversionRecords({ oldCurrency: change.old_currency, newCurrency: change.new_currency,
        ...ledgerConversionBalances(oldBalance, change.fx_rate), rate: change.fx_rate, rateDate: change.rate_date, source: change.source },
        { eventId: event.id, pendingId: event.pending.id, timestamp: change.created_at });
      if (canonical(expected.event) !== canonical(change) || canonical(expected.pending) !== canonical(event.pending)) throw new Error("Altered local currency conversion evidence");
      conversions.set(event.pending.occurrence_key, event);
      currencyEvents.push(change);
      settings.ledger_currency = change.new_currency;
    } else if (event.kind === "payment") {
      exactKeys(event, ["kind", "id", "row", "source", ...policyFields(event)]);
      const conversion = conversions.get(event.row.occurrence_key);
      // A newly accepted conversion may use a previously reviewed recomputation.
      const validationSource = event.source?.table === "ledger_currency_events" && conversion
        ? { ...event.source, row: conversion.event } : event.source;
      validateOriginal(event.row, validationSource, { settings, today, budgetId });
      if (event.id !== event.row.id || originals.has(event.id)) throw new Error("Invalid local audit payment identity");
      if (event.source !== null) {
        if (event.source.table === "ledger_currency_events") {
          const retained = events.find(value => value.kind === "ledger-currency" && value.id === conversion?.id) || (events[0]?.kind === "linked-origin" ? conversion : null);
          if (!conversion || conversion.id !== event.source.row.id
            || canonical(retained?.event) !== canonical(event.source.row)) throw new Error("Conversion payment lacks retained event");
        }
        const sourceId = event.source.row.id;
        if (sourceKinds.has(sourceId) && sourceKinds.get(sourceId) !== event.source.table) throw new Error("Local source identity changed entity kind");
        sourceKinds.set(sourceId, event.source.table);
        if (position < legacyCount) {
          const prior = legacySources.get(sourceId);
          if (prior && canonical(prior) !== canonical(event.source)) throw new Error("Legacy source evidence is inconsistent");
          legacySources.set(sourceId, event.source);
          if (["one_off_transactions", "goals", "flex_transactions"].includes(event.source.table)) {
            const prior = legacyTotals.get(sourceId) || { total: 0, largest: 0 };
            legacyTotals.set(sourceId, { total: addMoneyAmounts(prior.total, event.row.amount), largest: Math.max(prior.largest, event.row.amount) });
          }
        }
        if (event.source.table === "one_off_transactions") {
          const count = (oneOffCounts.get(event.source.row.id) || 0) + 1;
          // The first installment's key uses the one-off's scheduled date, not the payment date.
          const expected = count === 1 ? occurrenceKeyFromRow({ ...event.row, date: event.source.row.date })
            : `one_off_remainder:${event.source.row.id}:${count}`;
          if (position >= legacyCount && event.row.occurrence_key !== expected) throw new Error("Incomplete local audit installment chain");
          oneOffCounts.set(event.source.row.id, count);
          if (position < legacyCount) {
            const keys = legacyKeys.get(sourceId) || { values: new Set(), initial: occurrenceKeyFromRow(event.row) };
            keys.values.add(event.row.occurrence_key); legacyKeys.set(sourceId, keys);
          }
        }
      }
      const row = withoutBalance(event.row);
      if (position >= legacyCount && completedBefore([...active.values()], event.source)) throw new Error("Local audit payment follows a completed source");
      if (position >= legacyCount && failureFor([...active.values(), row], opening, event.source, null, false, event.policyVersion !== 2)) throw new Error("Invalid accepted local audit payment dependencies");
      originals.set(event.id, event); active.set(event.id, row); heads.set(event.id, null);
    } else if (event.kind === "correction") {
      if (position < legacyCount) throw new Error("Legacy audit boundary crosses a correction");
      exactKeys(event, ["kind", "id", "targetId", "expectedCorrectionId", "reason", "requested", "createdAt", "today",
        "status", "failureCode", "before", "after", "retryOf", "source", "targetLimit", ...(Object.hasOwn(event, "conversionReview") ? ["conversionReview"] : []), ...policyFields(event)]);
      const original = originals.get(event.targetId);
      if (!original || heads.get(event.targetId) !== event.expectedCorrectionId) throw new Error("Stale local audit correction");
      if (typeof event.reason !== "string" || !event.reason.trim() || event.reason.length > 500) throw new Error("Correction reason required (up to 500 characters)");
      timestamp(event.createdAt); requireIsoDate(event.today);
      if (event.today > today) throw new Error("Future local correction evidence");
      if (event.retryOf !== null) {
        const prior = entries.get(event.retryOf);
        if (prior?.kind !== "correction" || prior.status !== "blocked" || prior.targetId !== event.targetId) throw new Error("Invalid local correction retry");
      }
      if (original.source === null) {
        if (event.source !== null) throw new Error("Correction changed source identity");
        if (event.targetLimit !== null) throw new Error("Invalid local correction target limit");
      } else {
        validateEvidence(event.source, settings, budgetId);
        if (event.targetLimit !== null && (!money(event.targetLimit)
          || !["one_off_transactions", "goals", "flex_transactions"].includes(event.source.table))) throw new Error("Invalid local correction target limit");
        if (event.source.table !== original.source.table || event.source.row.id !== original.source.row.id) throw new Error("Correction changed source identity");
      }
      const before = active.get(event.targetId) || null;
      if (canonical(before) !== canonical(event.before)) throw new Error("Correction reversal differs from accepted evidence");
      let after = null;
      if (event.requested !== null) {
        exactKeys(event.requested, Object.hasOwn(event.requested, "fx_rate") ? ["amount", "date", "fx_rate"] : ["amount", "date"]);
        requireIsoDate(event.requested.date);
        if ((!money(event.requested.amount) && !(original.source?.table === "ledger_currency_events" && event.requested.amount === 0)) || event.requested.date > event.today) throw new Error("Invalid local correction amount or date");
        after = correctedRow(original.row, event.requested, event.today, event.createdAt);
      }
      const candidate = [...active.entries()].filter(([id]) => id !== event.targetId).map(([, row]) => row);
      if (after) candidate.push(after);
      const reviewed = Object.hasOwn(event, "conversionReview");
      if (reviewed && event.policyVersion !== 2) throw new Error("Conversion review requires current correction policy");
      const effects = reviewed ? conversionEffects(events.slice(0, position), candidate, conversions, opening, Boolean(event.conversionReview?.orderingResolution)) : null;
      const review = effects ? { changes: effects.changes, downstream: effects.balances.filter(row => row.id !== event.targetId), ...(effects.orderingResolution ? { orderingResolution: effects.orderingResolution } : {}) } : null;
      if (reviewed && canonical(event.conversionReview) !== canonical(review)) throw new Error("Altered conversion correction review");
      let failure = failureFor(effects ? effects.balances : candidate, opening, event.source, event.targetLimit, false, event.policyVersion !== 2)
        || (((events[0]?.kind === "linked-origin" && !linkedOriginTimeline(events[0], Boolean(event.conversionReview?.orderingResolution))) || !reviewed) ? currencyDependency(events.slice(0, position), event.targetId, before, after) : null);
      // Blocked under the earlier amount cap: kept as recorded, and may be retried.
      if (!failure && event.policyVersion === undefined && event.failureCode === "source_limit"
        && failureFor(candidate, opening, event.source, event.targetLimit, true) === "source_limit") failure = "source_limit";
      if (event.status !== (failure ? "blocked" : "accepted") || event.failureCode !== failure
        || canonical(event.after) !== canonical(failure ? null : after)) throw new Error("Correction result differs from financial dependencies");
      if (!failure) {
        if (after) active.set(event.targetId, after); else active.delete(event.targetId);
        if (effects) {
          active.clear();
          for (const row of effects.balances) active.set(row.id, withoutBalance(row));
          conversions = effects.conversions;
        }
        heads.set(event.targetId, event.id);
      }
    } else throw new Error("Unsupported local audit event kind");
    entries.set(event.id, event);
    if (position + 1 === legacyCount) {
      // Old exports retained sorted history, not acceptance order. Validate
      // that complete baseline once; all subsequent events validate in order.
      if (failureFor([...active.values()], opening, null)) throw new Error("Invalid legacy local audit balance");
      for (const [sourceId, count] of oneOffCounts) {
        const { values: keys, initial } = legacyKeys.get(sourceId);
        if (!keys.has(initial)) throw new Error("Incomplete legacy audit installment chain");
        for (let index = 2; index <= count; index++) if (!keys.has(`one_off_remainder:${sourceId}:${index}`)) throw new Error("Incomplete legacy audit installment chain");
      }
      // A payment may exceed what was left but completes its source. Acceptance
      // order is unknown here: some valid order exists only when everything but
      // the largest payment stayed below the target.
      for (const [sourceId, { total, largest }] of legacyTotals) {
        if (subtractMoneyAmounts(total, largest) >= legacySources.get(sourceId).row.amount) throw new Error("Invalid legacy local audit funding");
      }
    }
  }
  if (settings.ledger_currency !== finalCurrency) throw new Error("Local ledger currency differs from retained events");
  return { openingCurrency: opening.currency, rows: localAuditBalances([...active.values()], opening), originals, heads, entries, oneOffCounts, currencyEvents,
    conversions, pendingConversions: [...retainedPending.filter(row => ![...originals.values()].some(value => value.row.occurrence_key === row.occurrence_key)), ...[...conversions].filter(([key]) => ![...originals.values()].some(value => value.row.occurrence_key === key)).map(([, value]) => value.pending)] };
}

/** Prepare a reviewed correction. Dependency rejection is itself durable audit
 * evidence, so users can resolve dependent payments and explicitly retry. */
export function appendLocalCorrection({ events, opening, settings, today, budgetId, id, targetId, expectedCorrectionId,
  reason, requested, createdAt, retryOf = null, source = null, legacyCount = 0, targetLimit = null, reviewConversions = false }) {
  const state = replayLocalAudit({ events, opening, settings, today, budgetId, legacyCount });
  const original = state.originals.get(targetId);
  if (!original || state.heads.get(targetId) !== expectedCorrectionId) throw new Error("Stale local audit correction");
  if (state.entries.has(id)) throw new Error("Correction identifier already used");
  const before = withoutBalance(state.rows.find(row => row.id === targetId) || null);
  let after = requested === null ? null : correctedRow(original.row, requested, today, createdAt);
  const evidence = source || original.source;
  const candidate = state.rows.filter(row => row.id !== targetId).map(withoutBalance);
  if (after) candidate.push(after);
  const scoped = scopedOpening(events, opening, settings);
  const effects = reviewConversions ? conversionEffects(events, candidate, state.conversions, scoped, true) : null;
  const failureCode = failureFor(effects ? effects.balances : candidate, scoped, evidence, targetLimit, false, false)
    || (((events[0]?.kind === "linked-origin" && !linkedOriginTimeline(events[0], reviewConversions)) || !reviewConversions) ? currencyDependency(events, targetId, before, after) : null);
  const event = { kind: "correction", policyVersion: 2, id, targetId, expectedCorrectionId, reason, requested: copy(requested), createdAt, today,
    status: failureCode ? "blocked" : "accepted", failureCode, before, after: failureCode ? null : after, retryOf, source: copy(evidence), targetLimit };
  if (effects && state.currencyEvents.length) event.conversionReview = { changes: effects.changes, downstream: effects.balances.filter(row => row.id !== targetId), ...(effects.orderingResolution ? { orderingResolution: effects.orderingResolution } : {}) };
  const next = [...copy(events), event];
  replayLocalAudit({ events: next, opening, settings, today, budgetId, legacyCount });
  return next;
}
