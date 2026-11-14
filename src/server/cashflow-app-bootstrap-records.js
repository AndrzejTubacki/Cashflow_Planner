import { encodeLedgerAuditRecords } from '../engine/ledger-audit-transport.js';

/** This whitelist is shared by actual sync and fresh-transfer readback. Server
 * delivery credentials and infrastructure preferences never become app data. */
export const BOOTSTRAP_SETTINGS = ['ledger_currency', 'timezone', 'holiday_country', 'future_periods', 'minimum_reserve_enabled',
  'minimum_reserve_amount', 'budget_period_income_id', 'fx_buffer_percent', 'manual_fx_rates', 'necessary_underfunded_repeat_days'];
const PLANNING = ['planned_transactions', 'recurring_incomes', 'recurring_expenses', 'goals', 'flex_transactions',
  'one_off_transactions', 'pending_transactions'];
export const BOOTSTRAP_PARTS = ['settings', 'planning', 'ledger', 'currency-events', 'fx', 'ledger-audit', 'fx-snapshot'];

/** Drivers may return Dates/native JSON; preserve the existing deterministic
 * bootstrap ordering without depending on backend object insertion order. */
function canonical(value) {
  if (value && typeof value.toJSON === 'function') return canonical(value.toJSON());
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Caller owns the financial transaction and authorization. This reader opens
 * no pool, fetches no provider and cannot create a head, grant or receipt. */
export async function readFinancialBootstrapPart(context, part, { fxSnapshot = null, allowStandaloneOrigins = false } = {}) {
  if (!BOOTSTRAP_PARTS.includes(part) || context.writer?.transactionBound !== true) throw new Error('Owning bootstrap transaction required');
  const { writer, budgetId } = context;
  if (part === 'settings') {
    const row = (await writer.listPlanningRows(budgetId, 'settings'))[0] || {};
    return [Object.fromEntries(BOOTSTRAP_SETTINGS.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))];
  }
  if (part === 'planning') {
    const records = [];
    for (const table of PLANNING) for (const row of [...await writer.listPlanningRows(budgetId, table)]
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))) records.push({ table, row });
    return records;
  }
  if (part === 'ledger') return [...await writer.listConfirmedTransactions(budgetId)].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (part === 'fx-snapshot') return [{ snapshot: typeof fxSnapshot === 'function' ? await fxSnapshot(context) ?? null : null }];
  if (part === 'ledger-audit') {
    const audit = typeof writer.exportLedgerAuditSnapshot === 'function' ? await writer.exportLedgerAuditSnapshot(budgetId) : null;
    return encodeLedgerAuditRecords(audit, { allowStandaloneOrigins });
  }
  const table = part === 'currency-events' ? 'ledger_currency_events' : 'fx_rates_cache';
  let rows = await writer.listPlanningRows(budgetId, table);
  if (part === 'currency-events' && typeof writer.currencyOrderReceipts === 'function') {
    const needsResolution = row => !(typeof row.details === 'string' ? JSON.parse(row.details) : row.details)?.acceptanceOrder;
    if (rows.some(needsResolution)) {
      const receipts = await writer.currencyOrderReceipts(budgetId);
      if (receipts) rows = rows.map(row => needsResolution(row) ? { ...row, orderResolution: receipts } : row);
    }
  }
  return [...rows].sort((a, b) => JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))));
}
