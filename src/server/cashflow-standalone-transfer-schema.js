// Historical device IDs are not foreign keys: portable metadata intentionally
// omits live devices/tokens, while retaining transfer identity and outcomes.
export const STANDALONE_TRANSFER_FILE_MARKER = 'standalone-transfer.json';
export const STANDALONE_TRANSFER_TABLE_COLUMNS = {
  cashflow_standalone_transfers: ['instance_id', 'account_id', 'device_id', 'transfer_id',
    'budget_id', 'input_hash', 'state', 'receipt_json', 'created_ms']
};

export const STANDALONE_TRANSFER_JOURNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS cashflow_standalone_transfers (
  instance_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  budget_id TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted', 'cancelled')),
  receipt_json TEXT,
  created_ms BIGINT NOT NULL,
  PRIMARY KEY (instance_id, account_id, device_id, transfer_id),
  CHECK ((state = 'reserved' AND receipt_json IS NULL) OR (state IN ('accepted', 'cancelled') AND receipt_json IS NOT NULL))
);`;
