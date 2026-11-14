import { initializePlanningSchema } from '../../src/server/cashflow-schema.js';
import { initializeGlobalSchema } from '../../src/server/cashflow-global-schema.js';

// Remove only the 1.2.0 additions to reproduce the released v1.1.6 schemas.
export function initializeMainPlanningSchema(db) {
  initializePlanningSchema(db);
  db.exec(`
    DROP TABLE cashflow_sync_operations;
    DROP TABLE cashflow_sync_heads;
    DROP TABLE cashflow_ledger_origins;
    DROP TABLE cashflow_ledger_corrections;
    DROP TABLE cashflow_ledger_originals;
    DROP TABLE cashflow_ledger_audit_state;
    DROP TABLE cashflow_ledger_summary_cache;
    DROP TABLE ledger_transactions;
    DROP TABLE ledger_merge_state;
    ALTER TABLE settings DROP COLUMN notification_channels;
    ALTER TABLE notification_queue DROP COLUMN sent_channels;
    PRAGMA user_version = 21;
  `);
}

export function initializeMainGlobalSchema(db) {
  initializeGlobalSchema(db);
  db.exec(`
    DROP TABLE app_device_tokens;
    DROP TABLE app_devices;
    DROP TABLE app_device_pairings;
    DROP TABLE app_device_instance;
    DROP TABLE cashflow_standalone_transfers;
    ALTER TABLE global_options DROP COLUMN device_access_minutes;
    ALTER TABLE global_options DROP COLUMN device_renewal_idle_days;
    ALTER TABLE global_options DROP COLUMN device_absolute_days;
    ALTER TABLE budgets DROP COLUMN revision;
    PRAGMA user_version = 7;
  `);
}
