import { assertFxRateFresh } from "./cashflow-fx-freshness.js";
import { linkedOriginOpeningCurrency } from "./local-linked-origin.js";
import { calculateSnapshot } from "./snapshot.js";
import { prepareSnapshot } from "./prepare-snapshot.js";
import { confirmedRowsWithRunningBalances, latestBalanceFromConfirmedRows, sortConfirmedRowsForBalance } from "./cashflow-ledger-balance-utils.js";
import { addMoneyAmounts, multiplyMoney, roundMoneyAmount, subtractMoneyAmounts } from "./cashflow-money-utils.js";
import { requireIsoDate, recurringOccurrencesInPeriod } from "./cashflow-date-utils.js";
import { localFxRate, validateLocalPlanning } from "./local-validation.js";
import { isReserveTransferOccurrenceKey, occurrenceKeyFromRow, parseReserveTransferOccurrenceKey } from "./cashflow-occurrence-utils.js";
import { upgradeValidatedLocalSnapshot, refreshAuditedLocalSnapshot, appendAuditedPayment, correctAuditedLocalConfirmation } from "./local-audited-snapshot.js";

/** Upgrade validated legacy history once; older clients reject the explicit
 * version instead of dropping correction evidence they do not understand. */
export function refreshLocalSnapshot(command) {
  if (command.snapshot?.snapshotVersion === 2) return retainOfferedChoices(refreshAuditedLocalSnapshot(command));
  if (["localAudit", "localAuditVersion", "localAuditLegacyCount"].some(key => Object.hasOwn(command.snapshot || {}, key))) {
    throw new Error("Audit evidence requires snapshot version 2");
  }
  return retainOfferedChoices(upgradeValidatedLocalSnapshot(refreshLegacyLocalSnapshot(command), {
    today: command.today, generationTimestamp: command.generationTimestamp, idSeed: command.idSeed }));
}

/** Retain only recurring identities actually offered by this calculation. Values
 * are rebuilt from planning sources, and handled keys suppress accepted choices.
 * Keep these hints outside the journal-backed pending/conversion mirrors.
 * Only app hosts opting into recovery retain this derived cache; server transfer
 * readers keep their existing strict standalone wire format. */
function retainOfferedChoices(snapshot) {
  if (snapshot.localRecoveryRows === undefined || snapshot.localMissingPlanningRates?.length) return snapshot;
  const plan = calculateSnapshot(snapshot).plan;
  snapshot.localRecoveryRows = [...plan.pendingRows, ...plan.futureRows]
    .filter(row => row.source_recurring_expense_id || row.source_recurring_income_id)
    .map(row => ({ occurrence_key: row.occurrence_key, date: row.date, type: row.type,
      ...(row.source_recurring_expense_id ? { source_recurring_expense_id: row.source_recurring_expense_id }
        : { source_recurring_income_id: row.source_recurring_income_id }) }));
  return snapshot;
}

function requireSafeHistoryBalances(history) {
  for (const row of history) {
    const cents = row.running_balance_pln * 100;
    if (!Number.isFinite(cents) || !Number.isSafeInteger(Math.round(cents))
      || Math.abs(cents - Math.round(cents)) > 0.00001) {
      throw new Error("Standalone ledger balance exceeds safely representable cents");
    }
  }
}

/** Rebuild local aggregates from source history on reopen/import/day changes. */
function refreshLegacyLocalSnapshot({ snapshot, today, generationTimestamp, idSeed }) {
  calculateSnapshot(snapshot);
  if (!snapshot.budgetId.startsWith("local-") || snapshot.writesSupported !== undefined) {
    throw new Error("Only standalone local budgets may be refreshed");
  }
  const rows = snapshot.localHistory ?? [];
  if (!Array.isArray(rows)) throw new Error("Complete local history required");
  if (snapshot.request.predictionRows.length && !snapshot.localHistory) throw new Error("Local history missing");
  const opening = snapshot.localOpeningBalance ?? (rows.length ? NaN : snapshot.request.openingBalance);
  if (!Number.isFinite(opening) || !Number.isSafeInteger(Math.round(opening * 100))
    || Math.abs(opening * 100 - Math.round(opening * 100)) > 0.00001) {
    throw new Error("Original local opening balance must be finite, cent-precise and safely representable");
  }
  const currency = snapshot.request.settings.ledger_currency;
  validateLocalPlanning(snapshot.request);
  if (snapshot.request.tables.pending_transactions.length || snapshot.request.tables.future_transactions.length) {
    throw new Error("Unsupported standalone workflow state");
  }
  const seen = new Set();
  const installments = new Map();
  const funding = new Map();
  for (const row of sortConfirmedRowsForBalance(rows)) {
    if (!row || !["income", "expense"].includes(row.type) || row.currency !== currency || row.ledger_currency !== currency
      || !Number.isFinite(row.amount) || row.amount < 0 || (row.amount === 0 && !isReserveTransferOccurrenceKey(row.occurrence_key)) || !Number.isSafeInteger(Math.round(row.amount * 100))
      || Math.abs(row.amount * 100 - Math.round(row.amount * 100)) > 0.00001 || row.fx_rate !== 1 || row.buffered_fx_rate !== 1
      || typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date > today
      || typeof row.id !== "string" || !row.id || typeof row.occurrence_key !== "string" || !row.occurrence_key
      || seen.has(row.occurrence_key) || seen.has(`id:${row.id}`)) {
      throw new Error("Invalid or duplicate standalone history");
    }
    // Recorded same-currency amounts must agree with their accepted ledger value.
    // Never reinterpret an edited full payment as an apparently valid installment.
    if (row.ledger_amount !== undefined && row.ledger_amount !== row.amount) {
      throw new Error("Standalone history amount differs from its recorded ledger amount");
    }
    requireIsoDate(row.date, "history.date");
    if (typeof row.created_at !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(row.created_at)
      || !Number.isFinite(Date.parse(row.created_at))
      || row.status !== "confirmed" || row.ledger_year !== Number(row.date.slice(0, 4))) {
      throw new Error("Invalid standalone history confirmation metadata");
    }
    requireIsoDate(row.created_at.slice(0, 10), "history.created_at");
    requireIsoDate(row.confirmed_date, "history.confirmed_date");
    if (row.confirmed_date < row.date || row.confirmed_date > today) {
      throw new Error("Invalid standalone history confirmation date");
    }
    const sources = [
      ["source_one_off_id", "one_off_transactions", null],
      ["source_recurring_income_id", "recurring_incomes", "income"],
      ["source_recurring_expense_id", "recurring_expenses", "expense"],
      ["source_goal_id", "goals", "expense"],
      ["source_flex_id", "flex_transactions", "expense"]
    ].filter(([field]) => row[field]);
    const reserveTransfer = parseReserveTransferOccurrenceKey(row.occurrence_key);
    if (reserveTransfer) {
      if (sources.length !== 0 || row.type !== reserveTransfer.type) {
        throw new Error("Invalid standalone history occurrence reference");
      }
    } else {
      if (sources.length !== 1) throw new Error("Invalid standalone history occurrence reference");
      const [sourceField, table, fixedType] = sources[0];
      const source = snapshot.request.tables[table].find(value => value.id === row[sourceField]);
      if (!source || (fixedType || source.type) !== row.type || source.currency !== row.currency
        || (table === "one_off_transactions" && source.date !== row.date)) {
        throw new Error("Standalone history source is missing or inconsistent");
      }
      if (table === "one_off_transactions") {
        // The engine advances the remainder identity once per accepted installment.
        // Rebuild that chain from accepted order rather than trusting imported progress.
        const prior = installments.get(source.id) ?? { keys: new Set(), amount: 0, largest: 0, target: source.amount, initial: occurrenceKeyFromRow(row) };
        prior.keys.add(row.occurrence_key); prior.amount = addMoneyAmounts(prior.amount, row.amount);
        prior.largest = Math.max(prior.largest, row.amount);
        installments.set(source.id, prior);
      } else if (table === "goals" || table === "flex_transactions") {
        // Server confirmations record allocation outflows as expenses but retain
        // the generated occurrence identity (goal_allocation for goal funding).
        const expectedKey = occurrenceKeyFromRow(table === "goals" ? { ...row, type: "goal_allocation" } : row);
        if (expectedKey !== row.occurrence_key || (table === "goals" && row.date > source.due_date)) throw new Error("Invalid standalone funding history");
        const prior = funding.get(source.id) ?? { amount: 0, largest: 0, target: source.amount };
        funding.set(source.id, { ...prior, amount: addMoneyAmounts(prior.amount, row.amount), largest: Math.max(prior.largest, row.amount) });
      } else if (occurrenceKeyFromRow(row) !== row.occurrence_key) throw new Error("Invalid standalone history occurrence reference");
      if (table.startsWith("recurring_")) {
        // The accepted date can lie outside its source month after an offset or
        // business-day adjustment. Use the projection engine's inverse source
        // window, including interval rules, rather than assuming its own month.
        if (!recurringOccurrencesInPeriod(source, { start: row.date, end: row.date }).includes(row.date)) {
          throw new Error("Standalone history date does not match recurring anchor");
        }
      }
    }
    seen.add(row.occurrence_key); seen.add(`id:${row.id}`);
  }
  // Equal timestamps may be tie-broken by opaque IDs; validate the complete key
  // chain independently of that display/balance ordering, including after restore.
  // A payment may exceed what was left (server parity) but completes its source.
  // History order is not acceptance order: some valid order exists only when
  // everything but the largest payment stayed below the target.
  for (const [kind, totals] of [["installment", installments], ["funding", funding]]) {
    for (const { amount, largest, target } of totals.values()) {
      if (subtractMoneyAmounts(amount, largest) >= target) throw new Error(`Invalid standalone ${kind} history`);
    }
  }
  for (const [id, { keys, initial }] of installments) {
    if (!keys.has(initial)) throw new Error("Invalid standalone installment history");
    for (let index = 2; index <= keys.size; index++) {
      if (!keys.has(`one_off_remainder:${id}:${index}`)) throw new Error("Invalid standalone installment history");
    }
  }
  if (snapshot.localLastConfirmationId && !rows.some(row => row.id === snapshot.localLastConfirmationId)) {
    throw new Error("Local undo marker references missing history");
  }
  const history = confirmedRowsWithRunningBalances(rows, { openingBalance: opening });
  requireSafeHistoryBalances(history);
  if (history.some(row => row.running_balance_pln < -0.005)) throw new Error("Standalone history contains an overdraft");
  const prepared = prepareSnapshot({ budgetId: snapshot.budgetId, revision: snapshot.revision,
    settings: snapshot.request.settings, tables: snapshot.request.tables, confirmedRows: history,
    fxSnapshot: snapshot.request.fxSnapshot, today, generationTimestamp, idSeed });
  if (!history.length) prepared.request.openingBalance = roundMoneyAmount(opening);
  if (snapshot.localRecoveryRows) prepared.localRecoveryRows = JSON.parse(JSON.stringify(snapshot.localRecoveryRows));
  prepared.localOpeningBalance = roundMoneyAmount(opening);
  prepared.localHistory = history;
  prepared.name = snapshot.name || "Local budget";
  if (snapshot.localLastConfirmationId) prepared.localLastConfirmationId = snapshot.localLastConfirmationId;
  calculateSnapshot(prepared);
  return prepared;
}

export function refreshLocalSnapshotJson(json) {
  try { return JSON.stringify({ ok: true, snapshot: refreshLocalSnapshot(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: "LOCAL_REFRESH_REJECTED", message: error.message } }); }
}

/** Restricted local-only command, NOT a server sync operation or ledger API. */
/** `actualDate` is the real payment date (server `confirmed_date` semantics),
 * defaulting to the occurrence date; it may not lie after today. `early`
 * explicitly selects a not-yet-due occurrence, like the server's move to
 * pending; its occurrence identity keeps the scheduled date. */
export function confirmLocalOccurrence({ snapshot, occurrenceKey, today, generationTimestamp, idSeed, amount, actualDate, early = false, fxRate }) {
  if (!snapshot?.budgetId?.startsWith("local-") || snapshot.writesSupported !== undefined) {
    throw new Error("Only standalone local budgets may be confirmed");
  }
  if (today !== snapshot.request?.today) throw new Error("Recalculate for today before confirming");
  // Rebuild before selecting the occurrence: cached/imported aggregates and
  // running balances must never authorize a confirmation.
  snapshot = refreshLocalSnapshot({ snapshot, today, generationTimestamp, idSeed });
  if (snapshot.request.confirmedRowsAfterToday.length) throw new Error("Future ledger history is not supported locally");
  const existing = snapshot.localHistory ?? [];
  if (!Array.isArray(existing)) throw new Error("Complete local history required");
  if (existing.some(row => row.occurrence_key === occurrenceKey)) throw new Error("Occurrence already confirmed");
  if (existing.some(row => row.id === `confirmed-${idSeed}`)) throw new Error("Confirmation identifier already used");
  // A settings conversion remains confirmable while foreign planning is
  // blocked by missing quotes, just as on the server. Its row was audit-checked.
  const storedConversion = snapshot.request.tables.pending_transactions.find(value => value.occurrence_key === occurrenceKey);
  const calculated = storedConversion ? { plan: { pendingRows: [], futureRows: [] } } : calculateSnapshot(snapshot);
  // Recurring due-today occurrences are projected in futureRows by the shared
  // engine. Date and source checks, not the collection label, establish eligibility.
  const row = [...snapshot.request.tables.pending_transactions, ...calculated.plan.pendingRows, ...calculated.plan.futureRows].find(value => value.occurrence_key === occurrenceKey);
  if (typeof early !== "boolean") throw new Error("Early confirmation must be explicit");
  if (!row || (row.date > today && !early) || (early && row.date <= today)
    || !["income", "expense", "goal_allocation"].includes(row.type)) {
    throw new Error(early ? "Only upcoming occurrences can be recorded early" : "Only due pending occurrences can be confirmed");
  }
  const isConversion = String(row.occurrence_key || "").startsWith("ledger_currency_conversion:");
  const isReserveTransfer = isReserveTransferOccurrenceKey(row.occurrence_key);
  // Generated reserve halves have no planning source; their occurrence identity
  // authorizes the normal per-row payment, never arbitrary manual ledger input.
  if (!isConversion && !isReserveTransfer && !row.source_one_off_id && !row.source_recurring_income_id
    && !row.source_recurring_expense_id && !row.source_goal_id && !row.source_flex_id) throw new Error("Manual confirmations are unsupported");
  const recorded = amount === undefined ? row.amount : amount;
  if (!Number.isFinite(recorded) || (recorded < 0 || (recorded === 0 && !isConversion && !isReserveTransfer)) || !Number.isSafeInteger(Math.round(recorded * 100))
    || Math.abs(recorded * 100 - Math.round(recorded * 100)) > 0.00001) {
    throw new Error("Confirmation amount must be nonnegative precise cents; only system rows may record zero");
  }
  // Server parity: the actual payment may exceed the allocation; the extra comes
  // out of available money and only an overdraft (checked below) is refused.
  // A recurring partial closes this dated occurrence, matching the existing
  // server workflow. Only one-offs generate an installment remainder.
  const initialCurrency = snapshot.localAudit[0]?.kind === "linked-origin" ? linkedOriginOpeningCurrency(snapshot.localAudit[0], snapshot.request.settings.ledger_currency) : snapshot.localAudit.find(event => event.kind === "ledger-currency")?.event.old_currency || snapshot.request.settings.ledger_currency;
  const opening = initialCurrency === snapshot.request.settings.ledger_currency ? snapshot.localOpeningBalance : 0;
  if (!Number.isFinite(opening)) throw new Error("Local opening balance required");
  // Server parity: a foreign payment records its actual rate (entered, else the
  // stored rate) as both fx and buffered rate; the planning buffer is not applied.
  const ledgerCurrency = snapshot.request.settings.ledger_currency;
  let rate = 1;
  if (row.currency === ledgerCurrency) {
    if (fxRate !== undefined) throw new Error("Same-currency payments have no exchange rate");
  } else {
    const stored = localFxRate(snapshot.request.fxSnapshot, row.currency, ledgerCurrency);
    if (!stored && fxRate === undefined) throw new Error(`Add an exchange rate for ${row.currency} to ${ledgerCurrency} before recording this payment`);
    if (fxRate === undefined) assertFxRateFresh(actualDate || (early ? today : row.date),
      stored.effectiveDate, row.currency, ledgerCurrency, stored.source);
    rate = fxRate === undefined ? stored.rate : fxRate;
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1000000) throw new Error("Exchange rate must be a positive number");
  }
  const paidOn = actualDate === undefined ? (early ? today : row.date) : requireIsoDate(actualDate, "actualDate");
  if (isConversion && paidOn < row.date) throw new Error("Conversion cannot precede the currency change");
  if (paidOn > today) throw new Error("Use an actual payment date no later than today");
  // Server rule: the income that starts budget periods cannot be dated before newer ledger history.
  if (row.source_recurring_income_id && row.source_recurring_income_id === snapshot.request.settings.budget_period_income_id
    && existing.some(value => value.date > paidOn)) {
    throw new Error("Period-setting income cannot be confirmed earlier than the newest confirmed ledger transaction");
  }
  const confirmed = { ...row, type: row.type === "income" ? "income" : "expense", amount: recorded,
    ledger_amount: rate === 1 && row.currency === ledgerCurrency ? recorded : multiplyMoney(recorded, rate),
    fx_rate: rate, buffered_fx_rate: rate, ledger_currency: ledgerCurrency,
    id: `confirmed-${idSeed}`, date: paidOn, confirmed_date: today,
    ledger_year: Number(paidOn.slice(0, 4)), created_at: generationTimestamp,
    updated_at: generationTimestamp, status: "confirmed" };
  const history = confirmedRowsWithRunningBalances([...existing.filter(value => value.ledger_currency === ledgerCurrency), confirmed], { openingBalance: opening });
  requireSafeHistoryBalances(history);
  if (!isConversion && latestBalanceFromConfirmedRows(history, { openingBalance: opening }) < -0.005) throw new Error("Confirmation would overdraw local balance");
  if (!isConversion && history.some(row => row.running_balance_pln < -0.005 && !String(row.occurrence_key || "").startsWith("ledger_currency_conversion:"))) throw new Error("Confirmation would create a historical local overdraft");
  return appendAuditedPayment(snapshot, confirmed, { today, generationTimestamp, idSeed });
}

export function confirmLocalOccurrenceJson(json) {
  try { return JSON.stringify({ ok: true, snapshot: confirmLocalOccurrence(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: "LOCAL_CONFIRMATION_REJECTED", message: error.message } }); }
}

/** Latest-payment shortcut records a reversal rather than deleting evidence. */
export function undoLocalConfirmation({ snapshot, confirmationId, today, generationTimestamp, idSeed }) {
  snapshot = refreshLocalSnapshot({ snapshot, today, generationTimestamp, idSeed });
  if (!confirmationId || snapshot.localLastConfirmationId !== confirmationId) {
    throw new Error("Only the last locally recorded confirmation may be undone");
  }
  const row = snapshot.localHistory.find(value => value.id === confirmationId);
  if (!row) throw new Error("Last local confirmation no longer exists");
  const prior = [...snapshot.localAudit].reverse().find(event => event.kind === "correction"
    && event.status === "accepted" && event.targetId === confirmationId)?.id || null;
  return correctAuditedLocalConfirmation({ snapshot, confirmationId, expectedCorrectionId: prior,
    reason: "Undo latest confirmation", replacement: null, today, generationTimestamp, idSeed });
}

/** Explicit corrections work for any recorded payment. Failed financial
 * dependencies retain an auditable intention rather than deleting user work. */
export function correctLocalConfirmation(command) {
  const snapshot = refreshLocalSnapshot(command);
  return correctAuditedLocalConfirmation({ ...command, snapshot, reviewConversions: false });
}
export function correctLocalConfirmationJson(json) {
  try { return JSON.stringify({ ok: true, snapshot: correctLocalConfirmation(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: "LOCAL_CORRECTION_REJECTED", message: error.message } }); }
}

export function undoLocalConfirmationJson(json) {
  try { return JSON.stringify({ ok: true, snapshot: undoLocalConfirmation(JSON.parse(json)) }); }
  catch (error) { return JSON.stringify({ ok: false, error: { code: "LOCAL_UNDO_REJECTED", message: error.message } }); }
}
