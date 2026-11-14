import { isDeepStrictEqual } from 'node:util';
import { prepareStandaloneTransferOrigin } from './cashflow-standalone-transfer-origin.js';
import { POSTGRES_BUDGET_PLANNING_TABLES } from './cashflow-postgres-budget-schema.js';
import { BOOTSTRAP_SETTINGS } from './cashflow-financial-operation-service.js';
import { createNodeLedgerAuditReplay } from './cashflow-ledger-audit-store.js';
import { prepareSnapshot } from '../engine/prepare-snapshot.js';
import { calculateSnapshot } from '../engine/snapshot.js';
import { oneOffProgressWithOriginals } from '../engine/ledger-audit-progress.js';
import { canonicalAuditValue } from '../engine/ledger-audit-json.js';

const TABLES = ['planned_transactions', 'recurring_incomes', 'recurring_expenses',
  'goals', 'flex_transactions', 'one_off_transactions'];
const codec = createNodeLedgerAuditReplay({ allowStandaloneOrigins: true });
const json = value => JSON.stringify(canonicalAuditValue(value));
const refused = () => new Error('Standalone transfer requires fresh unpublished financial storage');

/** Database creation metadata is new, not a substitute for historical payment
 * timestamps. Infer an omitted parent type only from its unique actual child. */
function materializeTables(tables, timestamp) {
  const types = new Map();
  for (const [table, type] of [['recurring_expenses', 'recurring_expense'], ['goals', 'goal'], ['flex_transactions', 'flex']]) {
    for (const row of tables[table]) {
      if (types.has(row.planned_transaction_id)) throw new Error('Ambiguous standalone planning parent');
      types.set(row.planned_transaction_id, type);
    }
  }
  return Object.fromEntries(TABLES.map(table => [table, tables[table].map(value => {
    const row = { ...value, created_at: value.created_at ?? timestamp, updated_at: value.updated_at ?? timestamp };
    if (table === 'planned_transactions') {
      row.type ??= types.get(row.id);
      if (!row.type || (types.has(row.id) && row.type !== types.get(row.id))) throw new Error('Invalid standalone planning parent');
    }
    if (table === 'recurring_incomes' || table === 'recurring_expenses') {
      row.prediction_strategy ??= 'fixed';
      row.repeat_every_months ??= 1;
    }
    return row;
  })]));
}

/** Inspect financial output rather than serialization-only source metadata.
 * Generated plan IDs and dates use the same explicit clock/seed on both sides. */
function allocation(plan) {
  return json({ futureRows: plan.futureRows, pendingRows: plan.pendingRows });
}

/** Drivers represent SQL booleans and timestamps differently. Only those
 * declared scalar representations may differ; money/IDs remain exact. */
function sameStoredScalar(actual, expected, key) {
  // PostgreSQL JSONB columns read back parsed; SQLite returns the stored JSON text.
  if (actual !== null && typeof actual === 'object' && !(actual instanceof Date) && typeof expected === 'string') {
    try { return isDeepStrictEqual(actual, JSON.parse(expected)); } catch { return false; }
  }
  if (actual instanceof Date) {
    if (!['created_at', 'updated_at', 'setup_completed_at'].includes(key) || !Number.isFinite(Date.parse(expected))) return false;
    return actual.toISOString() === new Date(expected).toISOString();
  }
  return actual === expected || (typeof actual === 'boolean' && Number(actual) === expected)
    || (typeof expected === 'boolean' && Number(expected) === actual);
}

/** Readback catches ignored SQL writes and silent scalar coercion even when
 * the affected setting/rate does not change today's allocation. */
function requireStoredFields(actual, expected, message) {
  if (!actual || Object.entries(expected).some(([key, value]) => !sameStoredScalar(actual[key], value, key))) throw new Error(message);
}

/** Prepare outside the publication lock. The returned closure owns its private
 * checked plan; callers cannot mutate a preview into authoritative rows.
 *
 * This is only the financial portion of publication: the host must establish a
 * fresh reserved target, authorize it, own the transaction/file lifecycle and
 * atomically publish membership, device grants and the durable receipt. Never
 * use this helper to replace an existing budget. No HTTP route invokes it yet.
 * readFxSnapshot must use the supplied writer and must never fetch the network. */
export function prepareStandaloneTransferWrite({ sourceJson, budgetId, readFxSnapshot, ...timing }) {
  if (typeof readFxSnapshot !== 'function') throw new Error('Transaction-bound cached exchange-rate reader required');
  const prepared = prepareStandaloneTransferOrigin({ sourceJson, budgetId, ...timing });
  const tables = materializeTables(prepared.snapshot.request.tables, prepared.materializedAt);
  const settingsRow = { ...prepared.snapshot.request.settings, id: 1,
    setup_completed: 1, setup_completed_at: prepared.materializedAt, updated_at: prepared.materializedAt };
  // Preserve visible pending identity and immutable transition mirrors alongside
  // the origin; neither is an extra opening/payment.
  const workflow = Object.fromEntries(['ledger_currency_events', 'pending_transactions'].map(table => [table, prepared.snapshot.request.tables[table] || []]));
  const audit = { version: 2, budgetId, baselineComplete: true,
    lastSequence: prepared.ledgerOrigin.events.length, origin: prepared.ledgerOrigin, originals: [], corrections: [] };
  codec.replayLedgerAuditSnapshot(audit, budgetId);
  // Source/cache materialization is supplied separately below; retain captured
  // dates and rates, rather than stamping old observations as a fresh fetch.
  const fxRows = new Map();
  for (const [key, entry] of Object.entries(prepared.snapshot.request.fxSnapshot || {})) {
    const [base, quote = 'PLN'] = key.toUpperCase().split('/');
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote) || !entry || typeof entry !== 'object'
      || !Number.isFinite(entry.rate) || entry.rate <= 0) throw new Error('Invalid standalone exchange-rate observation');
    if (base === quote) continue;
    const rateDate = entry.effectiveDate ?? timing.today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rateDate) || new Date(`${rateDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== rateDate) {
      throw new Error('Invalid standalone exchange-rate date');
    }
    const row = { base_currency: base, quote_currency: quote, currency: base, rate_date: rateDate,
      rate: entry.rate, effective_date: rateDate, source: entry.source ?? 'cache', raw_json: null, updated_at: prepared.materializedAt };
    const previous = fxRows.get(`${base}/${quote}`);
    if (previous && json(previous) !== json(row)) throw new Error('Conflicting standalone exchange-rate aliases');
    fxRows.set(`${base}/${quote}`, row);
  }

  return {
    /** A detached financial preview grants no authority and includes no tokens. */
    preview() { return structuredClone({ budgetId, sourceBudgetId: prepared.sourceSnapshot.budgetId,
      sourceRevision: prepared.sourceSnapshot.revision, balance: prepared.snapshot.request.openingBalance,
      paymentCount: prepared.confirmedRows.length, originalCount: prepared.originals.length }); },

    /** All writes and independent readback use the owning writer. Any refusal
     * must abort that outer transaction, including failures after this returns. */
    async write(writer) {
      if (writer?.transactionBound !== true || writer.supportsStandaloneOrigins !== true) throw refused();
      if (typeof writer.lockBudgetLedger === 'function') await writer.lockBudgetLedger(budgetId);
      if (await writer.exportLedgerAuditSnapshot(budgetId) !== null) throw refused();
      if ((await writer.listConfirmedTransactions(budgetId)).length) throw refused();
      for (const table of POSTGRES_BUDGET_PLANNING_TABLES) {
        const rows = await writer.listPlanningRows(budgetId, table);
        if (table === 'settings') {
          if (rows.length > 1 || rows.some(row => Number(row.id) !== 1 || Number(row.setup_completed) !== 0)) throw refused();
        } else if (rows.length) throw refused();
      }
      await writer.replacePlanningRows(budgetId, 'settings', [settingsRow]);
      for (const table of TABLES) if (tables[table].length) await writer.insertPlanningRows(budgetId, table, tables[table]);
      for (const [table, rows] of Object.entries(workflow)) if (rows.length) await writer.insertPlanningRows(budgetId, table, rows);
      if (fxRows.size) await writer.upsertFxRates(budgetId, [...fxRows.values()]);
      if (prepared.confirmedRows.length) await writer.insertConfirmedTransactions(budgetId, prepared.confirmedRows);
      await writer.replaceLedgerAuditSnapshot(budgetId, audit);
      const restoredAudit = await writer.exportLedgerAuditSnapshot(budgetId);
      if (json(restoredAudit) !== json(audit)) throw new Error('Standalone transfer evidence was not retained');
      const replay = codec.replayLedgerAuditSnapshot(restoredAudit, budgetId);
      // One owning PostgreSQL connection cannot execute concurrent queries.
      const storedTables = {};
      for (const table of TABLES) storedTables[table] = await writer.listPlanningRows(budgetId, table);
      for (const table of TABLES) {
        const rows = new Map(storedTables[table].map(row => [row.id, row]));
        if (rows.size !== tables[table].length) throw new Error('Standalone transfer sources were not retained');
        for (const expected of tables[table]) requireStoredFields(rows.get(expected.id), expected, 'Standalone transfer source changed in storage');
      }
      const storedWorkflow = {};
      for (const [table, expected] of Object.entries(workflow)) {
        const rows = await writer.listPlanningRows(budgetId, table);
        if (rows.length !== expected.length) throw new Error('Standalone conversion evidence was not retained');
        for (const row of expected) requireStoredFields(rows.find(value => value.id === row.id), row, 'Standalone conversion evidence changed in storage');
        storedWorkflow[table] = rows;
      }
      const settings = (await writer.listPlanningRows(budgetId, 'settings'))[0];
      requireStoredFields(settings, settingsRow, 'Standalone transfer settings were not retained');
      const cached = new Map((await writer.listPlanningRows(budgetId, 'fx_rates_cache'))
        .map(row => [`${row.base_currency}/${row.quote_currency}`, row]));
      if (cached.size !== fxRows.size) throw new Error('Standalone transfer exchange rates were not retained');
      for (const [key, row] of fxRows) requireStoredFields(cached.get(key), row, 'Standalone transfer exchange rates changed in storage');
      const safeSettings = Object.fromEntries(BOOTSTRAP_SETTINGS.filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]));
      const confirmedRows = await writer.listConfirmedTransactions(budgetId);
      const fxSnapshot = await readFxSnapshot({ writer, budgetId, today: timing.today });
      const snapshot = prepareSnapshot({ budgetId, revision: 0, settings: safeSettings,
        tables: { ...storedTables, ...storedWorkflow, future_transactions: [], projection_snapshots: [] },
        confirmedRows, fxSnapshot, ...timing, ledgerOpeningBalance: replay.opening.ledgerCurrency === settings.ledger_currency ? replay.opening.amount : 0 });
      snapshot.request.oneOffProgress = [...oneOffProgressWithOriginals(confirmedRows, [...replay.originals.values()])];
      const calculation = calculateSnapshot(snapshot);
      if (snapshot.request.openingBalance !== prepared.snapshot.request.openingBalance
        || json(snapshot.request.oneOffProgress) !== json(prepared.snapshot.request.oneOffProgress)
        || json(snapshot.request.confirmedFunding) !== json(prepared.snapshot.request.confirmedFunding)
        || allocation(calculation.plan) !== allocation(prepared.calculation.plan)) {
        throw new Error('Standalone transfer financial result changed in storage');
      }
      return { snapshot, calculation, ledgerAudit: restoredAudit };
    }
  };
}
