import { randomUUID } from 'node:crypto';
import { createStandaloneTransferJournal, normalizeStandaloneTransferRequest, standaloneTransferFingerprint } from './cashflow-standalone-transfer-journal.js';
import { standaloneTransferDestination } from './cashflow-standalone-transfer-record.js';
import { prepareStandaloneTransferWrite } from './cashflow-standalone-transfer-writer.js';
import { applyProjectionGenerationPlanToBudgetStore } from './cashflow-projection-engine-service.js';
import { todayInTimezone } from './cashflow-date-utils.js';
import { assertStandaloneTransferReadable } from './cashflow-standalone-transfer-readable.js';

const lookupInput = input => Object.fromEntries(['version', 'transferId', 'instanceId', 'accountId', 'deviceId'].map(key => [key, input[key]]));
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Internal authenticated publisher for one frozen, already reviewed source.
 * Provider refresh belongs before freezing that source, never inside a retry or
 * financial transaction. All live authorization uses the owning connection.
 * SQLite's injected file publisher must durably seal/verify private storage
 * before metadata becomes visible; PostgreSQL writes everything on one client.
 * No route is registered by this factory. */
export function createStandaloneTransferPublisher({ deviceStore, deviceService, budgetStore, readFxSnapshot,
  sqliteFiles = null, now = Date.now, logServerEvent = () => {}, logError = () => {}, hooks = {} }) {
  const backend = budgetStore?.backend;
  if (!['sqlite', 'postgres'].includes(backend) || typeof deviceStore?.transaction !== 'function'
    || typeof deviceService?.authorizeBudgetCreationInTransaction !== 'function'
    || typeof deviceService?.grantCreatedBudgetInTransaction !== 'function'
    || typeof deviceService?.authorizeTransferRecoveryInTransaction !== 'function' || typeof readFxSnapshot !== 'function'
    || (backend === 'sqlite' && (!sqliteFiles || typeof sqliteFiles.publish !== 'function' || typeof sqliteFiles.recoverReceipt !== 'function'
      || typeof sqliteFiles.discardCancelled !== 'function'))
    || Object.values(hooks).some(callback => typeof callback !== 'function')) throw new Error('Standalone transfer publication host required');

  const queryFor = client => async (sql, values = []) => {
    let position = 0;
    return (await client.query(sql.replace(/\?/g, () => `$${++position}`), values)).rows || [];
  };
  const authorize = (tx, token) => deviceService.authorizeBudgetCreationInTransaction(tx, token);
  const journalFor = (tx, token, options = {}) => createStandaloneTransferJournal({ ...tx, now,
    authorize: ({ action }) => ['cancel', 'lookup'].includes(action)
      ? deviceService.authorizeTransferRecoveryInTransaction(tx, token) : authorize(tx, token), prepare: async () => { throw new Error('Publication writer not supplied'); }, ...options });
  const durable = { durableWrites: true };

  /** Reserve only after complete financial preflight. Bound unfinished control
   * records independently of financial input size; accepted outcomes survive
   * capacity exhaustion and never allocate or regrant a deleted target. */
  async function reserve(token, input) {
    return deviceStore.transaction(async tx => {
      await authorize(tx, token);
      const journal = journalFor(tx, token);
      const existing = await journal.lookup(lookupInput(input));
      if (existing && existing.state !== 'reserved') {
        if (existing.inputHash !== standaloneTransferFingerprint(input)) throw fail('TRANSFER_ID_REUSED', 'Transfer ID was already used for different input');
        return existing;
      }
      if (!existing) {
        await deviceService.authorizeBudgetCreationInTransaction(tx, token, { requireCapacity: true });
        const count = await tx.query("SELECT COUNT(*) AS n FROM cashflow_standalone_transfers WHERE instance_id = ? AND account_id = ? AND device_id = ? AND state = 'reserved'",
          [input.instanceId, input.accountId, input.deviceId]);
        if (Number(count[0]?.n) >= 20) throw fail('TRANSFER_PENDING_LIMIT', 'Resolve an unfinished transfer before creating another');
      }
      return journal.reserve(input);
    }, durable);
  }

  /** Parent, membership and grant are verified on their owning transaction.
   * Existing budgets are never replaced, matched by name or silently regranted. */
  async function createMetadata(tx, input, receipt) {
    await tx.query(`INSERT INTO budgets (id, storage_key, display_name, status, created_by_account_id, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    [receipt.budgetId, receipt.budgetId, input.name, input.accountId, receipt.acceptedAt, receipt.acceptedAt]);
    await tx.query(`INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at)
      VALUES (?, ?, 'owner', ?, ?)`, [receipt.budgetId, input.accountId, receipt.acceptedAt, receipt.acceptedAt]);
    const stored = (await tx.query('SELECT storage_key, display_name, created_by_account_id FROM budgets WHERE id = ?', [receipt.budgetId]))[0];
    if (!stored || stored.storage_key !== receipt.budgetId || stored.display_name !== input.name
      || stored.created_by_account_id !== input.accountId) throw fail('TRANSFER_METADATA_NOT_RECORDED', 'Transfer destination was not recorded');
    await hooks.afterMetadata?.();
  }

  return {
    /** Historical outcome lookup never grants access or creates financial data. */
    async lookup(token, value) {
      const input = normalizeStandaloneTransferRequest(value, true);
      return deviceStore.transaction(tx => journalFor(tx, token).lookup(input), durable);
    },

    /** Review still requires creation permission before any provider IO; the
     * less powerful outcome reader cannot authorize a new transfer preview. */
    async reviewState(token, value) {
      const input = normalizeStandaloneTransferRequest(value, true);
      return deviceStore.transaction(tx => journalFor(tx, token, { authorize: () => authorize(tx, token) }).lookup(input), durable);
    },

    /** Cancel commits a tombstone before best-effort private-file cleanup. A
     * delayed publisher cannot recreate the job. A committed accepted budget is
     * returned intact, never deleted as a side effect of cancelling an upload. */
    async cancel(token, value) {
      const input = normalizeStandaloneTransferRequest(value);
      const receipt = await deviceStore.transaction(tx => journalFor(tx, token, { afterRecord: hooks.afterRecord ?? null }).cancel(input), durable)
        .catch(error => {
          logError('cashflow_standalone_transfer_cancel_failed', { code: /^[A-Z_]{1,64}$/.test(error.code ?? '') ? error.code : 'TRANSFER_CANCEL_FAILED', backend });
          throw error;
        });
      await hooks.afterCancellationCommit?.();
      if (receipt.state === 'cancelled' && backend === 'sqlite') {
        try {
          await deviceStore.transaction(async tx => {
            const current = await journalFor(tx, token).cancel(input);
            if (current.state !== 'cancelled' || (await tx.query('SELECT id FROM budgets WHERE id = ?', [receipt.budgetId])).length) return;
            await sqliteFiles.discardCancelled({ input });
          }, durable);
        } catch {
          // The cancellation is already durable. Unknown or altered retained
          // files stay available for operator recovery rather than being erased.
          logError('cashflow_standalone_transfer_cleanup_deferred', { code: 'TRANSFER_STORAGE_RETAINED', backend });
        }
      }
      if (receipt.state === 'cancelled') logServerEvent('cashflow_standalone_transfer_cancelled', { transferId: input.transferId, backend });
      return receipt;
    },

    /** The immutable receipt stays separate from current grant metadata. The
     * app can refresh its cached budget lists after creation without rotating
     * credentials or guessing which concurrently changed grants still exist. */
    async result(token, value) {
      const input = normalizeStandaloneTransferRequest(value, true);
      return deviceStore.transaction(async tx => {
        const receipt = await journalFor(tx, token).lookup(input);
        const row = (await tx.query('SELECT state_json FROM app_devices WHERE id = ?', [input.deviceId]))[0];
        const state = JSON.parse(row.state_json);
        return { receipt, grant: { instanceId: input.instanceId, accountId: input.accountId, deviceId: input.deviceId,
          scope: state.scope, budgetIds: state.budgetIds, writeBudgetIds: state.writeBudgetIds, mayCreateBudgets: state.mayCreateBudgets } };
      }, durable);
    },

    /** Lost acknowledgements reuse the same input/job and immutable receipt.
     * A new source/name needs a new explicitly reviewed job, not a retry edit. */
    async submit(token, value) {
      const input = normalizeStandaloneTransferRequest(value);
      try {
        // Check authorized existing outcomes before any present-day calculation:
        // old accepted jobs remain recoverable even if their FX is now stale.
        const existing = await deviceStore.transaction(async tx => {
          // Submit always requires creation permission, even when replaying a
          // terminal outcome. Recovery-only callers use result or cancel.
          await authorize(tx, token);
          const journal = journalFor(tx, token);
          const stored = await journal.lookup(lookupInput(input));
          if (stored && stored.inputHash !== standaloneTransferFingerprint(input)) throw fail('TRANSFER_ID_REUSED', 'Transfer ID was already used for different input');
          if (stored && stored.state !== 'reserved') return stored;
          return stored ? journal.reserve(input) : null;
        }, durable);
        if (existing && existing.state !== 'reserved') return existing;
        const budgetId = standaloneTransferDestination(input);
        const stamp = new Date(now());
        let timing, prepared;
        try {
          const settings = JSON.parse(input.sourceJson)?.request?.settings;
          timing = { today: todayInTimezone(settings?.timezone, stamp), generationTimestamp: stamp.toISOString(), idSeed: input.transferId };
          prepared = prepareStandaloneTransferWrite({ sourceJson: input.sourceJson, budgetId, readFxSnapshot, ...timing });
        } catch { throw fail('INVALID_TRANSFER_SOURCE', 'Review the financial source before uploading'); }
        // A never-accepted old job needs a new explicit rate review. Accepted
        // receipts were already handled above and remain recoverable unchanged.
        for (const rate of Object.values(JSON.parse(input.sourceJson).request.fxSnapshot || {})) {
          if (rate.source === 'manual') continue;
          const days = (Date.parse(`${timing.today}T00:00:00.000Z`) - Date.parse(`${rate.effectiveDate}T00:00:00.000Z`)) / 86400000;
          if (days < 0 || days > 14) throw fail('TRANSFER_RATE_REVIEW_REQUIRED', 'Refresh and review provider planning rates before starting an upload');
        }
        const reservation = await reserve(token, input);
        if (reservation.state !== 'reserved') return reservation;
        await hooks.afterReservation?.();
        const publish = async (tx, writer = null) => journalFor(tx, token, {
          recoverReceipt: backend === 'sqlite' ? context => sqliteFiles.recoverReceipt(context) : null,
          afterRecord: hooks.afterRecord ?? null,
          prepare: async ({ receipt }) => {
            await deviceService.authorizeBudgetCreationInTransaction(tx, token, { requireCapacity: true });
            if ((await tx.query('SELECT id FROM budgets WHERE id = ?', [budgetId])).length) {
              throw fail('TRANSFER_TARGET_EXISTS', 'Transfer destination already exists; retained data requires explicit recovery');
            }
            if (backend === 'sqlite') {
              await sqliteFiles.publish({ input, receipt, prepared, timing, hooks });
              await createMetadata(tx, input, receipt);
            } else {
              await createMetadata(tx, input, receipt);
              const result = await prepared.write(writer);
              await applyProjectionGenerationPlanToBudgetStore({ budgetId, budgetStore: writer, plan: result.calculation.plan });
              await assertStandaloneTransferReadable({ writer, budgetId, readFxSnapshot, ...timing });
              await hooks.afterFinancial?.();
            }
            await deviceService.grantCreatedBudgetInTransaction(tx, token, budgetId);
            await hooks.afterGrant?.();
            await tx.query(`INSERT INTO security_audit_log (id, actor_account_id, action, target_type, target_id, outcome, details_json, created_at)
              VALUES (?, ?, 'budget.standalone_transferred', 'budget', ?, 'success', '{}', ?)`,
            [`audit_${randomUUID()}`, input.accountId, budgetId, receipt.acceptedAt]);
          }
        }).publish(input);
        const receipt = backend === 'postgres'
          ? await budgetStore.transaction(async (writer, client) => {
            await client.query('SET LOCAL synchronous_commit = on');
            return publish({ backend, query: queryFor(client) }, writer);
          })
          : await deviceStore.transaction(publish, durable);
        // Cancellation may win after reservation but before publication.
        // Only an accepted receipt is evidence of a committed new budget.
        if (receipt.state === 'accepted') logServerEvent('cashflow_standalone_transfer_accepted', { transferId: input.transferId, budgetId, backend });
        await hooks.afterCommit?.();
        return receipt;
      } catch (error) {
        logError('cashflow_standalone_transfer_failed', {
          code: /^[A-Z_]{1,64}$/.test(error.code ?? '') ? error.code : 'TRANSFER_FAILED', backend });
        throw error;
      }
    }
  };
}
