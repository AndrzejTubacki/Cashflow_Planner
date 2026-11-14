import { createLedgerAuditStore } from './cashflow-ledger-audit-store.js';
import { normalizeLedgerAuditFact } from '../engine/ledger-audit-fact.js';
export { normalizeLedgerAuditFact } from '../engine/ledger-audit-fact.js';

/** Internal adapter only: the caller owns the authorized financial transaction,
 * budget lock, initialized audit schema, projection and operation journal. The
 * public sync host supplies those boundaries; source creation also uses the
 * scoped immutable-original reader. query and writer MUST share the same
 * connection; never pass a root pool/store or a client-supplied graph. Origin
 * support is a trusted host choice and inherits the store's verified offset. */
export function createLedgerCorrectionService({ budgetId, writer, query, allowStandaloneOrigins = false }) {
  const methods = ['listConfirmedTransactions', 'deleteConfirmedTransactionsById', 'insertConfirmedTransactions',
    'updateConfirmedLedgerBalances', 'listPlanningRows'];
  if (!writer || methods.some(key => typeof writer[key] !== 'function')) throw new Error('Transaction-bound ledger writer required');
  const audit = createLedgerAuditStore({ budgetId, query, allowStandaloneOrigins,
    loadEffectiveRows: async () => (await writer.listConfirmedTransactions(budgetId)).map(row => normalizeLedgerAuditFact(row, budgetId)) });

  /** Apply only newly accepted results. Moving to a different actual-payment
   * year deletes/reinserts the effective row with its original identity; retained
   * originals and prior corrections are never deleted or rewritten. */
  async function correct(input) {
    const result = await audit.appendCorrection(input);
    if (result.replayed || result.event.status !== 'accepted') {
      await audit.exportSnapshot();
      return result;
    }
    const { before, after, balances } = result.plan;
    const ledgerCurrency = (await audit.original(result.event.targetId)).row.ledger_currency;
    if (before) {
      await writer.deleteConfirmedTransactionsById(budgetId, before.ledger_year, [before.id]);
      if ((await writer.listConfirmedTransactions(budgetId, { ledgerYear: before.ledger_year })).some(row => row.id === before.id)) {
        throw new Error('Reviewed payment was not removed from its effective ledger year');
      }
    }
    if (after) {
      const balanced = balances.find(row => row.id === after.id);
      await writer.insertConfirmedTransactions(budgetId, [{ ...after, running_balance_pln: balanced.running_balance_pln }]);
    }
    await writer.updateConfirmedLedgerBalances(budgetId, balances.map(row => ({ id: row.id,
      ledgerYear: row.ledger_year, ledgerAmount: row.ledger_amount, runningBalance: row.running_balance_pln })));
    // SQLite's INSTEAD OF year-view triggers report zero direct changes even
    // when the underlying ledger changed. Verify actual facts and balances;
    // mutation counters are not evidence of a successful financial write.
    const actual = (await writer.listConfirmedTransactions(budgetId)).filter(row => row.ledger_currency === ledgerCurrency)
      .map(row => normalizeLedgerAuditFact(row, budgetId));
    const indexed = new Map(actual.map(row => [row.id, row]));
    if (actual.length !== balances.length || balances.some(row => {
      const stored = indexed.get(row.id);
      const expected = normalizeLedgerAuditFact(row, budgetId);
      return !stored || Object.keys(expected).some(key => stored[key] !== expected[key]);
    })) throw new Error('Corrected facts and balances differ from the complete reviewed history');
    // Refuse non-portable or financially inconsistent evidence before the
    // owning host can commit its projection and operation receipt.
    await audit.exportSnapshot();
    return result;
  }

  /** Capture the source actually read on this acceptance transaction, including
   * its linked plan. Legacy baseline capture never calls this current reader. */
  async function capturePayment({ paymentId, actorId, capturedAt }) {
    const payment = (await writer.listConfirmedTransactions(budgetId)).find(row => row.id === paymentId);
    if (!payment) throw new Error('Accepted payment is missing from its owning ledger');
    const sources = { source_one_off_id: 'one_off_transactions', source_recurring_income_id: 'recurring_incomes',
      source_recurring_expense_id: 'recurring_expenses', source_goal_id: 'goals', source_flex_id: 'flex_transactions' };
    const references = Object.entries(sources).filter(([key]) => payment[key] != null);
    if (references.length > 1) throw new Error('Accepted payment has ambiguous source evidence');
    let sourceAtAcceptance = null;
    if (references.length) {
      const [field, table] = references[0];
      const row = (await writer.listPlanningRows(budgetId, table)).find(row => row.id === payment[field]);
      if (!row) throw new Error('Accepted payment source is missing');
      const plan = row.planned_transaction_id == null ? null
        : (await writer.listPlanningRows(budgetId, 'planned_transactions')).find(plan => plan.id === row.planned_transaction_id);
      if (row.planned_transaction_id != null && !plan) throw new Error('Accepted payment source plan is missing');
      sourceAtAcceptance = { table, row, plan };
    }
    return audit.capturePayment({ paymentId, actorId, capturedAt, sourceAtAcceptance });
  }
  return { audit, correct, capturePayment };
}
