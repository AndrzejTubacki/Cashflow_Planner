import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createSqliteGlobalStore } from '../../src/server/cashflow-sqlite-global-store.js';
import { createPostgresGlobalStore } from '../../src/server/cashflow-postgres-global-store.js';
import { createSqliteBudgetStore, createPostgresBudgetStore } from '../../src/server/cashflow-budget-store.js';
import { createCashflowDbService } from '../../src/server/cashflow-db-service.js';
import { createCashflowStoragePaths } from '../../src/server/cashflow-storage-utils.js';
import { createDeviceService } from '../../src/server/cashflow-device-service.js';
import { createDeviceStore } from '../../src/server/cashflow-device-store.js';
import { createCashflowFxCacheService } from '../../src/server/cashflow-fx-cache-service.js';
import { createStandaloneTransferPublisher } from '../../src/server/cashflow-standalone-transfer-publisher.js';
import { createStandaloneTransferFiles } from '../../src/server/cashflow-standalone-transfer-files.js';
import { standaloneOriginAuditFixture } from './standalone-origin-fixture.js';

/** Every file/account/device here is created from synthetic data. A PostgreSQL
 * URL is accepted only from the outer guarded disposable helper, never env. */
export async function withStandaloneTransferPublisherFixture(work, databaseUrl = null, reopen = null) {
  const dataDir = reopen?.dataDir ?? await mkdtemp(path.join(tmpdir(), 'cashflow-transfer-publisher-'));
  const paths = createCashflowStoragePaths(dataDir);
  const db = createCashflowDbService(paths);
  const global = databaseUrl ? await createPostgresGlobalStore({ databaseUrl })
    : createSqliteGlobalStore({ dataDir, listCashflowUserIds: paths.listCashflowUserIds });
  const budget = databaseUrl ? await createPostgresBudgetStore({ databaseUrl, allowStandaloneOrigins: true })
    : createSqliteBudgetStore({ ...db, allowStandaloneOrigins: true });
  let clock = Date.parse('2026-06-02T12:00:00.000Z');
  const now = () => clock;
  const store = createDeviceStore(global), device = createDeviceService({ store, now });
  const sql = (statement, args = []) => store.transaction(tx => tx.query(statement, args));
  const logs = [], errors = [];
  const fx = createCashflowFxCacheService({ normalizeCurrency: value => String(value).toUpperCase() });
  const readFxSnapshot = ({ writer, budgetId, today }) => fx.getCachedFxSnapshotAsync(budgetId, today, writer);
  const files = databaseUrl ? null : createStandaloneTransferFiles({ dataDir, readFxSnapshot });
  const publisher = (hooks = {}) => createStandaloneTransferPublisher({ deviceStore: store, deviceService: device,
    budgetStore: budget, sqliteFiles: files, readFxSnapshot, now, hooks,
    logServerEvent: (kind, detail) => logs.push({ kind, ...detail }), logError: (kind, detail) => errors.push({ kind, ...detail }) });
  try {
    await global.initialize(); await budget.initialize?.();
    if (!reopen?.tokens) {
      const stamp = new Date(clock).toISOString();
      await sql("INSERT INTO accounts (id, display_name, status, created_at, updated_at) VALUES ('transfer-owner', 'Synthetic owner', 'active', ?, ?)", [stamp, stamp]);
      await sql("INSERT INTO budgets (id, storage_key, display_name, status, created_by_account_id, created_at, updated_at) VALUES ('transfer-existing', 'transfer-existing', 'Existing budget', 'active', 'transfer-owner', ?, ?)", [stamp, stamp]);
      await sql("INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at) VALUES ('transfer-existing', 'transfer-owner', 'owner', ?, ?)", [stamp, stamp]);
      // SQLite creates its settings singleton on open. PostgreSQL schema setup
      // creates shared tables only; budget creation must insert the scoped row.
      if (databaseUrl) await budget.insertPlanningRows('transfer-existing', 'settings', [{ id: 1, updated_at: stamp }]);
      else db.openPlanningDb('transfer-existing').close();
      await sql("UPDATE auth_config SET active_mode = 'internal' WHERE id = 1");
      await sql("INSERT INTO auth_sessions (id, account_id, token_hash, csrf_token_hash, auth_method, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES ('transfer-session', 'transfer-owner', 'synthetic-no-browser-token', 'synthetic-no-csrf', 'internal', ?, ?, ?, ?)",
        [stamp, stamp, new Date(clock + 3600000).toISOString(), new Date(clock + 86400000).toISOString()]);
    }
    const enroll = async (mayCreateBudgets = true) => {
      const pairing = await device.createPairing('Synthetic transfer phone', 'app:financial:sync');
      await device.approve({ verificationCode: pairing.verificationCode, accountId: 'transfer-owner', sessionId: 'transfer-session',
        budgetIds: ['transfer-existing'], writeBudgetIds: ['transfer-existing'], mayCreateBudgets });
      return device.poll(pairing.deviceCode);
    };
    const tokens = reopen?.tokens ?? await enroll();
    const input = (snapshot = standaloneOriginAuditFixture().snapshot) => ({ version: 1, transferId: randomUUID(),
      instanceId: tokens.instanceId, accountId: tokens.accountId, deviceId: tokens.deviceId,
      name: 'Reviewed independent transfer', sourceJson: JSON.stringify(snapshot) });
    const lookup = value => Object.fromEntries(['version', 'transferId', 'instanceId', 'accountId', 'deviceId'].map(key => [key, value[key]]));
    return await work({ dataDir, paths, db, global, budget, store, device, sql, tokens, enroll,
      publisher, input, lookup, logs, errors, advance: ms => { clock += ms; } });
  } finally {
    await budget.close(); await global.close(); await rm(dataDir, { recursive: true, force: true });
  }
}
