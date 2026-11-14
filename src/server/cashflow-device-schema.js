// Portable additive DDL: never stores reusable device secrets.
export const DEVICE_TABLE_COLUMNS = {
  app_device_instance: ["id", "instance_id"],
  app_device_pairings: ["code_hash", "human_hash", "state_json", "expires_ms", "last_poll_ms", "status"],
  app_devices: ["id", "account_id", "state_json", "revoked_ms"],
  app_device_tokens: ["token_hash", "device_id", "kind", "expires_ms", "consumed_ms"]
};

export const DEVICE_SCHEMA_SQL = `
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
`;