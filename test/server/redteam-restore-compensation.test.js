import test from 'node:test';
import assert from 'node:assert/strict';
import { createCashflowBackupService } from '../../src/server/cashflow-backup-service.js';

// Transactional in-memory repository exercises the PostgreSQL service branch,
// including a successful independent write after rollback of the owning transaction.
test('CFSEC-03 failed restore never compensates over a concurrently accepted write', async () => {
  let tables = { settings: [{ budget_id: 'fixture', id: 1, timezone: 'UTC' }] };
  const artifacts = new Map();
  let serial = 0, fail = false, failed = false, accepted = false;
  const store = {
    backend: 'postgres',
    listPlanningRows: async (_id, table) => structuredClone(tables[table] || []),
    listConfirmedTransactions: async () => [], listLedgerYears: async () => [],
    insertPlanningRows: async (_id, table, rows) => { (tables[table] ||= []).push(...structuredClone(rows)); },
    saveBackupArtifact: async (_id, row, payload) => { artifacts.set(row.id, payload); (tables.backup_metadata ||= []).push(row); },
    readBackupArtifact: async (_id, id) => artifacts.get(id),
    replacePlanningRows: async (_id, table, rows) => { tables[table] = structuredClone(rows); },
    replaceConfirmedTransactionsForYear: async () => {},
    lockBudgetLedger: async () => {},
    transaction: async callback => {
      const before = structuredClone(tables);
      try { return await callback(store); }
      catch (error) {
        tables = before;
        // Independent operation commits after the failed transaction releases locks.
        if (failed) { tables.one_off_transactions = [{ budget_id: 'fixture', id: 'accepted', name: 'Accepted' }]; accepted = true; }
        throw error;
      }
    }
  };
  const service = createCashflowBackupService({ budgetStore: store,
    generateId: () => `backup-${++serial}`, getSettingsAsync: async () => tables.settings[0],
    recalculateLedgerRunningBalanceAsync: async () => { if (fail) { fail = false; failed = true; throw new Error('fixture recalculation failed'); } },
    regenerateProjectionsAfterMutationAsync: async () => ({ projection_ok: true }),
    backupHook: ({ phase }) => {
      if (phase === 'before_restore_rollback') {
        tables.one_off_transactions = [{ budget_id: 'fixture', id: 'accepted', name: 'Accepted' }]; accepted = true;
      }
    }
  });
  const ref = await service.createBackupAsync('fixture');
  tables.settings[0].timezone = 'Europe/Warsaw';
  fail = true;
  await assert.rejects(service.restoreBackupAsync('fixture', ref.slice('postgres-backup:'.length)), /fixture recalculation failed/);
  assert.equal(accepted, true, 'independent writer must execute at the recovery boundary');
  assert.equal(tables.settings[0].timezone, 'Europe/Warsaw');
  assert.equal(tables.one_off_transactions?.[0]?.id, 'accepted', 'blind compensation erased the accepted write');
});
