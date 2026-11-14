import { calculateSnapshot } from "./snapshot.js";
import { prepareSnapshot } from "./prepare-snapshot.js";
import { localFxRate, validateLocalPlanning } from "./local-validation.js";
import { addMoneyAmounts } from "./cashflow-money-utils.js";
import { isReserveTransferOccurrenceKey } from "./cashflow-occurrence-utils.js";
import { captureLocalSource, replayLocalAudit, appendLocalCorrection } from "./local-audit.js";

const copy = value => JSON.parse(JSON.stringify(value));
/** Compare financial JSON facts without treating object key order as evidence. */
function equivalent(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equivalent(a[key], b[key]));
}

/** Version 2 is local-only and keeps accepted facts in an append-only journal.
 * The old snapshot version cannot safely represent a correction's audit links. */
function stateFor(snapshot, today) {
  checkLocalProjection(snapshot);
  if (snapshot.snapshotVersion !== 2 || !snapshot.budgetId.startsWith("local-") || snapshot.writesSupported !== undefined
    || snapshot.localAuditVersion !== 1) throw new Error("Unsupported audited standalone snapshot");
  validateLocalPlanning(snapshot.request, { requireRates: !snapshot.localAudit.some(event => ["ledger-currency", "linked-origin"].includes(event.kind)) });
  // A budget period income is supported; validateLocalPlanning checks it names the one period-setting income.
  if (!snapshot.localAudit.some(event => event.kind === "linked-origin") && (snapshot.request.tables.pending_transactions.some(row => !String(row.occurrence_key || "").startsWith("ledger_currency_conversion:")) || snapshot.request.tables.future_transactions.length)) {
    throw new Error("Unsupported standalone workflow state");
  }
  const state = replayLocalAudit({ events: snapshot.localAudit, legacyCount: snapshot.localAuditLegacyCount,
    opening: snapshot.localOpeningBalance, settings: snapshot.request.settings, budgetId: snapshot.budgetId, today });
  if (!equivalent(snapshot.request.tables.pending_transactions, state.pendingConversions)
    || !equivalent(snapshot.request.tables.ledger_currency_events || [], state.currencyEvents)) {
    throw new Error("Local conversion mirrors differ from retained evidence");
  }
  return state;
}

/** Rebuild every derived aggregate from journal evidence. Internal writers use
 * this only after appending a checked event; imports/refresh verify mirrors first. */
function rebuilt(snapshot, timing, state) {
  const prepared = prepareSnapshot({ budgetId: snapshot.budgetId, revision: snapshot.revision,
    settings: snapshot.request.settings, tables: { ...snapshot.request.tables, pending_transactions: state.pendingConversions, ...(state.currencyEvents.length ? { ledger_currency_events: state.currencyEvents } : {}) }, confirmedRows: state.rows,
    fxSnapshot: snapshot.request.fxSnapshot, ...timing });
  if (snapshot.localRecoveryRows) prepared.localRecoveryRows = copy(snapshot.localRecoveryRows);
  const initialCurrency = state.openingCurrency;
  if (!state.rows.some(row => row.ledger_currency === snapshot.request.settings.ledger_currency)) {
    prepared.request.openingBalance = initialCurrency === snapshot.request.settings.ledger_currency ? snapshot.localOpeningBalance : 0;
  }
  Object.assign(prepared, { snapshotVersion: 2, name: snapshot.name || "Local budget", localOpeningBalance: snapshot.localOpeningBalance,
    localHistory: state.rows, localAuditVersion: 1, localAuditLegacyCount: snapshot.localAuditLegacyCount, localAudit: copy(snapshot.localAudit) });
  // Currency changes follow the browser even when other planning quotes are
  // unavailable. Surface missing quotes explicitly; the forecast remains blocked
  // until rates are supplied, while the conversion can still be confirmed.
  const ledgerCurrency = prepared.request.settings.ledger_currency;
  const missingRates = [...new Set(["one_off_transactions", "recurring_incomes", "recurring_expenses", "goals", "flex_transactions"]
    .flatMap(table => prepared.request.tables[table] || []).map(row => row.currency)
    .filter(currency => currency !== ledgerCurrency && !localFxRate(prepared.request.fxSnapshot, currency, ledgerCurrency)))].sort();
  if (missingRates.length) prepared.localMissingPlanningRates = missingRates;
  // Count original installment identities even after voids. A fresh payment
  // must never reuse an earlier installment's logical identity.
  const progress = new Map(prepared.request.oneOffProgress);
  for (const original of state.originals.values()) if (original.row.source_one_off_id) {
    const row = original.row;
    const key = `${row.source_one_off_id}:${row.type}:${row.currency}`;
    const current = progress.get(key) || { sourceId: row.source_one_off_id, type: row.type, currency: row.currency, confirmedAmount: 0 };
    current.confirmedCount = state.oneOffCounts.get(row.source_one_off_id);
    progress.set(key, current);
  }
  prepared.request.oneOffProgress = [...progress];
  const prior = snapshot.localLastConfirmationId;
  const latest = state.rows.some(row => row.id === prior) ? prior
    : [...state.originals.keys()].reverse().find(id => state.rows.some(row => row.id === id));
  if (latest) prepared.localLastConfirmationId = latest;
  checkLocalProjection(prepared);
  if (snapshot.localIntentions) prepared.localIntentions = copy(snapshot.localIntentions);
  return prepared;
}

/** Migration consumes an already validated v1 snapshot. Legacy sorted history
 * is a baseline, not invented acceptance order or invented historical sources. */
export function upgradeValidatedLocalSnapshot(snapshot, timing) {
  const audit = snapshot.localHistory.map(row => ({ kind: "payment", id: row.id, row: copy(row),
    source: isReserveTransferOccurrenceKey(row.occurrence_key) ? null : captureLocalSource(row, snapshot.request.tables) }));
  const next = { ...copy(snapshot), snapshotVersion: 2, localAuditVersion: 1,
    localAuditLegacyCount: audit.length, localAudit: audit };
  return rebuildLocalAuditMutation(next, timing);
}

/** Refuse altered effective history instead of silently replacing it from a
 * valid-looking journal. Source edits remain independent from captured facts. */
export function refreshAuditedLocalSnapshot({ snapshot, today, generationTimestamp, idSeed }) {
  const state = stateFor(snapshot, today);
  const facts = rows => rows?.map(row => {
    const result = { ...row }; delete result.running_balance_pln; return result;
  });
  if (!equivalent(facts(snapshot.localHistory), facts(state.rows)) || !equivalent(facts(snapshot.request.predictionRows), facts(state.rows))) {
    throw new Error("Audited local history contains altered or duplicate facts differing from retained payment/correction evidence");
  }
  if (snapshot.localLastConfirmationId && !state.rows.some(row => row.id === snapshot.localLastConfirmationId)) throw new Error("Local undo marker references missing history");
  return rebuilt(snapshot, { today, generationTimestamp, idSeed }, state);
}

/** Confirmation appends one immutable source/payment record before rebuilding;
 * callers must select and fund the due occurrence through the shared engine. */
export function appendAuditedPayment(snapshot, row, timing) {
  const next = { ...copy(snapshot), revision: snapshot.revision + 1, localLastConfirmationId: row.id,
    localAudit: [...copy(snapshot.localAudit), { kind: "payment", policyVersion: 2, id: row.id, row: copy(row),
      source: isReserveTransferOccurrenceKey(row.occurrence_key) ? null : (conversionSource(snapshot, row) || captureLocalSource(row, snapshot.request.tables)) }] };
  return rebuildLocalAuditMutation(next, timing);
}

/** Accepted and blocked corrections both advance the durable revision. The
 * original row remains intact and each retry references its retained intention.
 * Only the explicit review/apply bridge enables conversion recomputation. */
export function correctAuditedLocalConfirmation({ snapshot, confirmationId, expectedCorrectionId, reason, replacement,
  retryOf = null, today, generationTimestamp, idSeed, reviewConversions = false }) {
  const state = stateFor(snapshot, today);
  const original = state.originals.get(confirmationId);
  if (!original) throw new Error("Recorded payment no longer exists");
  // Prospective source policies do not redefine an accepted occurrence. Keep
  // its captured calendar/allocation rules, and capture today's cumulative
  // target separately so a blocked intention remains recoverable after edits.
  const source = original.source;
  const current = source ? snapshot.request.tables[source.table]?.find(row => row.id === source.row.id) : null;
  const targetLimit = source && ["one_off_transactions", "goals", "flex_transactions"].includes(source.table)
    ? (current || source.row).amount : null;
  const events = appendLocalCorrection({ events: snapshot.localAudit, legacyCount: snapshot.localAuditLegacyCount,
    opening: snapshot.localOpeningBalance, settings: snapshot.request.settings, budgetId: snapshot.budgetId,
    today, createdAt: generationTimestamp, id: `correction-${idSeed}`, targetId: confirmationId,
    expectedCorrectionId, reason, requested: replacement, retryOf, source, targetLimit, reviewConversions });
  const next = { ...copy(snapshot), revision: snapshot.revision + 1, localAudit: events };
  return rebuildLocalAuditMutation(next, { today, generationTimestamp, idSeed });
}

/** Internal mutation boundary derives conversion mirrors only from the journal;
 * public refresh still checks imported mirrors before trusting them. */
export function rebuildLocalAuditMutation(snapshot, timing) {
  validateLocalPlanning(snapshot.request, { requireRates: !snapshot.localAudit.some(event => ["ledger-currency", "linked-origin"].includes(event.kind)) });
  const state = replayLocalAudit({ events: snapshot.localAudit, legacyCount: snapshot.localAuditLegacyCount,
    opening: snapshot.localOpeningBalance, settings: snapshot.request.settings, budgetId: snapshot.budgetId, today: timing.today });
  return rebuilt(snapshot, timing, state);
}

/** Source-less system conversions reference the exact retained settings event. */
function conversionSource(snapshot, row) {
  const seed = snapshot.localAudit[0];
  if (seed?.kind === 'linked-origin') {
    const state = replayLocalAudit({ events: snapshot.localAudit, opening: snapshot.localOpeningBalance,
      settings: snapshot.request.settings, budgetId: snapshot.budgetId, today: snapshot.request.today });
    const conversion = state.conversions.get(row.occurrence_key);
    if (conversion) return { table: 'ledger_currency_events', row: copy(conversion.event), plan: null };
  }
  const change = snapshot.localAudit.find(event => ["ledger-currency", "linked-origin"].includes(event.kind) && event.pending.occurrence_key === row.occurrence_key);
  return change ? { table: "ledger_currency_events", row: copy(change.event), plan: null } : null;
}

/** Browser settings can commit while projection is blocked by missing FX.
 * Retain that financial state locally too; never fabricate a planning rate. */
function checkLocalProjection(snapshot) {
  try { calculateSnapshot(snapshot); }
  catch (error) {
    if (!snapshot.localAudit?.some(event => ["ledger-currency", "linked-origin"].includes(event.kind))
      || !error.message.startsWith("Missing FX rate for ")) throw error;
  }
}
