-- Cashflow 1.2.0: global schema 8 and planning schema 22.
BEGIN;
SELECT pg_advisory_xact_lock(73190200);
DO $cashflow_version_guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cashflow_global_schema_version WHERE id = 1 AND version IN (7, 8))
    OR NOT EXISTS (SELECT 1 FROM cashflow_budget_schema_version WHERE id = 1 AND planning_version IN (21, 22)) THEN
    RAISE EXCEPTION 'postgres-v1.2.0.sql requires global schema 7 or 8 and planning schema 21 or 22';
  END IF;
END;
$cashflow_version_guard$;

-- Additive device-token issuance policy. No credentials are issued here.
ALTER TABLE global_options
  ADD COLUMN IF NOT EXISTS backup_max_retention_count INTEGER NOT NULL DEFAULT 0 CHECK (backup_max_retention_count BETWEEN 0 AND 2147483647),
  ADD COLUMN IF NOT EXISTS backup_max_age_days INTEGER NOT NULL DEFAULT 0 CHECK (backup_max_age_days BETWEEN 0 AND 2147483647),
  ADD COLUMN IF NOT EXISTS device_access_minutes INTEGER NOT NULL DEFAULT 15 CHECK (device_access_minutes BETWEEN 1 AND 1440),
  ADD COLUMN IF NOT EXISTS device_renewal_idle_days INTEGER NOT NULL DEFAULT 90 CHECK (device_renewal_idle_days BETWEEN 1 AND 3650),
  ADD COLUMN IF NOT EXISTS device_absolute_days INTEGER NOT NULL DEFAULT 365 CHECK (device_absolute_days BETWEEN 1 AND 3650);

CREATE TABLE IF NOT EXISTS app_device_instance (
  id INTEGER PRIMARY KEY CHECK (id = 1), instance_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_device_pairings (
  code_hash TEXT PRIMARY KEY, human_hash TEXT NOT NULL UNIQUE,
  state_json TEXT NOT NULL, expires_ms BIGINT NOT NULL,
  last_poll_ms BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed'))
);
CREATE TABLE IF NOT EXISTS app_devices (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL, revoked_ms BIGINT
);
CREATE INDEX IF NOT EXISTS idx_app_devices_account ON app_devices(account_id);
CREATE TABLE IF NOT EXISTS app_device_tokens (
  token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES app_devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'renewal')),
  expires_ms BIGINT NOT NULL, consumed_ms BIGINT
);
CREATE INDEX IF NOT EXISTS idx_app_device_tokens_device ON app_device_tokens(device_id);

CREATE TABLE IF NOT EXISTS cashflow_sync_heads (
  budget_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 0));
CREATE TABLE IF NOT EXISTS cashflow_sync_operations (
  budget_id TEXT NOT NULL, epoch TEXT NOT NULL, operation_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0), fingerprint TEXT NOT NULL,
  operation_json TEXT NOT NULL, result_json TEXT NOT NULL,
  PRIMARY KEY (budget_id, epoch, operation_id),
  UNIQUE (budget_id, epoch, revision));

-- Journal retention: receipts and fingerprints are kept; only change-feed
-- payloads at or below retained_after are pruned, and such cursors expire.
ALTER TABLE cashflow_sync_heads ADD COLUMN IF NOT EXISTS retained_after BIGINT NOT NULL DEFAULT 0 CHECK (retained_after >= 0);
ALTER TABLE cashflow_sync_operations ADD COLUMN IF NOT EXISTS payload_pruned INTEGER NOT NULL DEFAULT 0 CHECK (payload_pruned IN (0, 1));

-- PostgreSQL already keeps confirmed_transactions beside the planning tables.

-- Several notification delivery channels at once, and
-- per-channel delivery progress for queued notifications.
-- Additive and safe to run more than once.
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS notification_channels TEXT
    CHECK (notification_channels IS NULL OR notification_channels ~ '^(ntfy|discord)?(,(ntfy|discord))?$');
ALTER TABLE notification_queue
  ADD COLUMN IF NOT EXISTS sent_channels TEXT NOT NULL DEFAULT '';

-- Derived summaries retain every original accepted payment.
CREATE TABLE IF NOT EXISTS cashflow_ledger_summary_cache (
  budget_id TEXT PRIMARY KEY REFERENCES budgets(id) ON DELETE CASCADE,
  cache_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Immutable originals and correction evidence storage.
CREATE TABLE IF NOT EXISTS cashflow_ledger_audit_state (
  budget_id TEXT PRIMARY KEY REFERENCES budgets(id) ON DELETE CASCADE,
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence BETWEEN 0 AND 9007199254740991),
  baseline_complete INTEGER NOT NULL DEFAULT 0 CHECK (baseline_complete IN (0, 1))
);
CREATE TABLE IF NOT EXISTS cashflow_ledger_originals (
  budget_id TEXT NOT NULL, payment_id TEXT NOT NULL, sequence_number BIGINT NOT NULL,
  data_json TEXT NOT NULL, record_hash TEXT NOT NULL,
  PRIMARY KEY (budget_id, payment_id), UNIQUE (budget_id, sequence_number),
  FOREIGN KEY (budget_id) REFERENCES cashflow_ledger_audit_state(budget_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS cashflow_ledger_corrections (
  budget_id TEXT NOT NULL, id TEXT NOT NULL, payment_id TEXT NOT NULL,
  sequence_number BIGINT NOT NULL, status TEXT NOT NULL CHECK (status IN ('accepted', 'blocked')),
  data_json TEXT NOT NULL, record_hash TEXT NOT NULL,
  PRIMARY KEY (budget_id, id), UNIQUE (budget_id, sequence_number),
  FOREIGN KEY (budget_id, payment_id) REFERENCES cashflow_ledger_originals(budget_id, payment_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ledger_corrections_payment
  ON cashflow_ledger_corrections(budget_id, payment_id, sequence_number);

-- Durable transfer identities, without restoring device grants.
CREATE TABLE IF NOT EXISTS cashflow_standalone_transfers (
  instance_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  budget_id TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted')),
  receipt_json TEXT,
  created_ms BIGINT NOT NULL,
  PRIMARY KEY (instance_id, account_id, device_id, transfer_id),
  CHECK ((state = 'reserved' AND receipt_json IS NULL) OR (state = 'accepted' AND receipt_json IS NOT NULL))
);

-- Immutable standalone origins, without enabling a writer.
ALTER TABLE cashflow_ledger_audit_state ADD COLUMN IF NOT EXISTS origin_version INTEGER NOT NULL DEFAULT 0
  CHECK (origin_version IN (0, 1));
CREATE TABLE IF NOT EXISTS cashflow_ledger_origins (
  budget_id TEXT PRIMARY KEY REFERENCES cashflow_ledger_audit_state(budget_id) ON DELETE CASCADE,
  data_json TEXT NOT NULL, record_hash TEXT NOT NULL
);

-- Immutable cancellation fences for standalone transfer jobs.
ALTER TABLE cashflow_standalone_transfers DROP CONSTRAINT IF EXISTS cashflow_standalone_transfers_state_check;
ALTER TABLE cashflow_standalone_transfers DROP CONSTRAINT IF EXISTS cashflow_standalone_transfers_check;
ALTER TABLE cashflow_standalone_transfers ADD CONSTRAINT cashflow_standalone_transfers_state_check
  CHECK (state IN ('reserved', 'accepted', 'cancelled'));
ALTER TABLE cashflow_standalone_transfers ADD CONSTRAINT cashflow_standalone_transfers_check
  CHECK ((state = 'reserved' AND receipt_json IS NULL) OR (state IN ('accepted', 'cancelled') AND receipt_json IS NOT NULL));

-- Budget metadata revision for optimistic stale-write detection.
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

UPDATE cashflow_global_schema_version SET version = 8, applied_at = now() WHERE id = 1;
UPDATE cashflow_budget_schema_version SET planning_version = 22, applied_at = now() WHERE id = 1;
COMMIT;
