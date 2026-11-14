import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createCashflowTestHarness } from '../helpers/cashflow-test-harness.js';
import { createSqliteBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createCashflowDataPortabilityService } from '../../src/server/cashflow-data-portability-service.js';
import { createDevicePortability } from '../../src/server/cashflow-device-portability.js';

/** Real SQLite commit/rollback with controlled backup and projection barriers. */
async function fixture(work) {
  const harness = await createCashflowTestHarness();
  try {
    const budgetId = harness.userId;
    const db = harness.openPlanningDb();
    const epoch = randomUUID();
    db.prepare('INSERT INTO cashflow_sync_heads(budget_id, epoch, revision) VALUES (?, ?, 0)').run(budgetId, epoch);
    db.close();
    const store = createSqliteBudgetStore({ openPlanningDb: () => harness.openPlanningDb(),
      openLedgerDb: (_id, year) => harness.openLedgerDb(year), listLedgerYears: () => [] });
    let afterBackup = () => {};
    let project = () => {};
    const service = createDevicePortability({ budgetStore: store,
      deviceService: { authorizeFinancialWrite: async () => ({ deviceId: 'test-device' }) },
      makePortability: (writer, generateId) => createCashflowDataPortabilityService({ budgetStore: writer, generateId }),
      recalculate: async () => {}, project: () => project(),
      createBackup: async () => {
        const db = harness.openPlanningDb();
        db.prepare("INSERT INTO backup_metadata(id, backup_timestamp, backup_path, success, created_at) VALUES ('safety', datetime('now'), 'test-path', 1, datetime('now'))").run();
        db.close();
        await afterBackup();
        return 'test-path';
      }
    });
    await work({ harness, service, budgetId, epoch, setAfterBackup: callback => { afterBackup = callback; }, setProject: callback => { project = callback; } });
  } finally { await harness.cleanup(); }
}
const csv = 'name,type,amount,currency,date\nImport,income,10,PLN,2026-05-21';

test('device replacement repeats revision CAS after the durable backup', () => fixture(async ({ harness, service, budgetId, epoch, setAfterBackup }) => {
  const body = { expectedEpoch: epoch, expectedRevision: 0, csv, mode: 'replace' };
  const preview = await service.preview('token', budgetId, body, 'csv');
  setAfterBackup(() => {
    const db = harness.openPlanningDb();
    db.prepare('UPDATE cashflow_sync_heads SET revision = 1').run();
    db.close();
  });
  await assert.rejects(service.apply('token', budgetId, { ...body, previewToken: preview.previewToken }, 'csv'), { code: 'IMPORT_REVISION_CONFLICT' });
  const db = harness.openPlanningDb();
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM one_off_transactions').get().n, 0); }
  finally { db.close(); }
}));

test('device imports roll back sources and the epoch on projection failure, retaining the safety backup', () => fixture(async ({ harness, service, budgetId, epoch, setProject }) => {
  const body = { expectedEpoch: epoch, expectedRevision: 0, csv, mode: 'replace' };
  const preview = await service.preview('token', budgetId, body, 'csv');
  setProject(() => { throw new Error('injected projection failure'); });
  await assert.rejects(service.apply('token', budgetId, { ...body, previewToken: preview.previewToken }, 'csv'), /injected projection failure/);
  const db = harness.openPlanningDb();
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM one_off_transactions').get().n, 0);
    assert.equal(db.prepare('SELECT epoch FROM cashflow_sync_heads').get().epoch, epoch);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backup_metadata WHERE success = 1').get().n, 1);
  } finally { db.close(); }
}));

test('device CSV append accepts the same file again at a new epoch with new source identities', () => fixture(async ({ service, budgetId, epoch }) => {
  const body = { expectedEpoch: epoch, expectedRevision: 0, csv, mode: 'append' };
  const preview = await service.preview('token', budgetId, body, 'csv');
  const result = await service.apply('token', budgetId, { ...body, previewToken: preview.previewToken }, 'csv');
  const next = { ...body, expectedEpoch: result.epoch, expectedRevision: result.revision };
  const second = await service.preview('token', budgetId, next, 'csv');
  assert.notEqual(second.rows[0].id, preview.rows[0].id);
  assert.equal((await service.apply('token', budgetId, { ...next, previewToken: second.previewToken }, 'csv')).ok, true);
}));

test('preview binding detects changed financial state even if a writer omitted a journal revision', () => fixture(async ({ harness, service, budgetId, epoch }) => {
  const body = { expectedEpoch: epoch, expectedRevision: 0, csv, mode: 'append' };
  const preview = await service.preview('token', budgetId, body, 'csv');
  const db = harness.openPlanningDb();
  try { db.prepare('UPDATE settings SET future_periods = future_periods + 1').run(); }
  finally { db.close(); }
  await assert.rejects(service.apply('token', budgetId, { ...body, previewToken: preview.previewToken }, 'csv'), { code: 'IMPORT_PREVIEW_MISMATCH' });
}));
