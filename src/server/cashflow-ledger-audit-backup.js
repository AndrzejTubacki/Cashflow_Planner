import { checkedRecord } from "./cashflow-financial-journal.js";
import { createLedgerCorrectionService } from './cashflow-ledger-correction-service.js';
import { createNodeLedgerAuditReplay } from './cashflow-ledger-audit-store.js';

/** Audit capture and backup adapter on the caller's owning financial transaction. It grants
 * no access and never opens or commits storage. Replacement must roll back with
 * the restored ledger if replay, projection or any later write fails. Origin
 * support is chosen by the owning host; old hosts refuse marked namespaces
 * even when the proposed replacement has no audit, before deleting evidence. */
export function createLedgerAuditBackupAdapter({ writer, query, allowStandaloneOrigins = false }) {
  if (writer?.transactionBound !== true || typeof query !== 'function') throw new Error('Audit backup requires an owning transaction');
  const { replayLedgerAuditSnapshot } = createNodeLedgerAuditReplay({ allowStandaloneOrigins });
  const state = async budgetId => (await query('SELECT * FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]))[0];
  return {
    /** Read the ordering watermark without exporting/verifying a full audit.
     * Legacy payments can lack originals; a settings change must not seed or
     * require them. The caller owns the transaction and ledger lock. */
    async ledgerAuditSequence(budgetId) {
      return Number((await state(budgetId))?.last_sequence ?? 0);
    },
    /** Exact retained identities include voided payments and uploaded origins. */
    async ledgerAuditPaymentIds(budgetId) {
      return (await query('SELECT payment_id FROM cashflow_ledger_originals WHERE budget_id = ?', [budgetId])).map(row => row.payment_id);
    },
    /** Retain accepted receipts for an explicit legacy ordering review. No
     * timestamp/amount heuristic or mutable source row participates. */
    async currencyOrderReceipts(budgetId) {
      const head = (await query('SELECT epoch, revision FROM cashflow_sync_heads WHERE budget_id = ?', [budgetId]))[0];
      if (!head) return null;
      const rows = await query('SELECT * FROM cashflow_sync_operations WHERE budget_id = ? AND epoch = ? ORDER BY revision', [budgetId, head.epoch]);
      return { version: 1, epoch: head.epoch, headRevision: Number(head.revision),
        records: rows.map(row => { const { operation, result } = checkedRecord(row); return { operation, result }; }) };
    },
    /** Origin proof is read on this owning connection, never via another pool
     * connection that cannot see the caller's uncommitted financial work. */
    async ledgerOpeningBalance(budgetId, ledgerCurrency) {
      return createLedgerCorrectionService({ budgetId, writer, query, allowStandaloneOrigins }).audit.openingBalance(ledgerCurrency);
    },
    /** Seed unknown legacy evidence before any new payment is inserted, then
     * verify existing replay. The owner must roll back this baseline on failure. */
    async prepareLedgerAuditCapture(budgetId, capturedAt) {
      const service = createLedgerCorrectionService({ budgetId, writer, query, allowStandaloneOrigins });
      await service.audit.ensureLegacyBaseline({ capturedAt });
      await service.audit.exportSnapshot();
    },
    /** Read source/linked-plan evidence on this same connection, before
     * projection can remove or alter it. Replay bounds apply before commit. */
    async captureLedgerAuditPayment(budgetId, input) {
      const service = createLedgerCorrectionService({ budgetId, writer, query, allowStandaloneOrigins });
      const result = await service.capturePayment(input);
      await service.audit.exportSnapshot();
      return result;
    },
    /** Never invent a legacy baseline merely because someone requests backup. */
    async exportLedgerAuditSnapshot(budgetId) {
      if (!await state(budgetId)) return null;
      return createLedgerCorrectionService({ budgetId, writer, query, allowStandaloneOrigins }).audit.exportSnapshot();
    },
    /** Whole-budget snapshot replacement is explicit. A version-1 backup has
     * no retained audit; clear the replaced namespace instead of attaching old
     * corrections to its unrelated restored facts. The safety backup retains it. */
    async replaceLedgerAuditSnapshot(budgetId, snapshot) {
      if (snapshot !== null) replayLedgerAuditSnapshot(snapshot, budgetId);
      const previous = await state(budgetId);
      if (Number(previous?.origin_version ?? 0) !== 0 && !allowStandaloneOrigins) throw new Error('Standalone ledger origins need an upgraded backup host');
      await query('DELETE FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]);
      if (snapshot !== null) await createLedgerCorrectionService({ budgetId, writer, query, allowStandaloneOrigins }).audit.restoreSnapshot(snapshot);
      return { changed: Boolean(previous) || snapshot !== null };
    }
  };
}
