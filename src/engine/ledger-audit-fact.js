import { multiplyMoney } from './cashflow-money-utils.js';
import { requireIsoDate } from './cashflow-date-utils.js';

// Complete normalized financial row fields, including nullable source metadata.
export const LEDGER_AUDIT_FACT_FIELDS = [
    "budget_id",
    "ledger_year",
    "id",
    "name",
    "currency",
    "amount",
    "type",
    "date",
    "confirmed_date",
    "fx_rate",
    "buffered_fx_rate",
    "ledger_currency",
    "running_balance_pln",
    "ledger_amount",
    "source_recurring_expense_id",
    "source_recurring_income_id",
    "source_one_off_id",
    "source_flex_id",
    "source_goal_id",
    "occurrence_key",
    "created_at",
    "updated_at"
  ];

/** SQLite ledger views expose year as text and UTC timestamps without a zone;
 * PostgreSQL readers expose numbers and ISO instants. Normalize these database
 * representations before immutable evidence is compared or moved across stores.
 * No payment identity, date, amount, source or recorded exchange rate is inferred. */
export function normalizeLedgerAuditFact(row, budgetId) {
  if (!row || (row.budget_id != null && row.budget_id !== budgetId)) throw new Error('Ledger audit scope differs from its owning writer');
  const result = Object.fromEntries(LEDGER_AUDIT_FACT_FIELDS.map(key => [key, row[key] ?? null]));
  result.budget_id = budgetId;
  result.ledger_year = Number(row.ledger_year);
  // Legacy rows can omit their derived ledger amount. Use the recorded rate,
  // never a current FX quote; the audit validator still rejects missing FX.
  result.ledger_amount ??= multiplyMoney(row.amount, row.buffered_fx_rate ?? row.fx_rate ?? 1);
  for (const key of ['created_at', 'updated_at']) {
    const raw = result[key];
    const text = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
      ? `${raw.replace(' ', 'T')}Z` : raw;
    if (!(text instanceof Date)) {
      const match = typeof text === 'string' && /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(text);
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3]) > 59) {
        throw new Error('Ledger audit requires an explicit database UTC instant');
      }
      requireIsoDate(text.slice(0, 10));
    }
    const instant = new Date(text);
    if (!Number.isFinite(instant.getTime())) throw new Error('Invalid ledger audit database timestamp');
    result[key] = instant.toISOString();
  }
  return result;
}

