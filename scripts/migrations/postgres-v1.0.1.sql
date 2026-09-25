-- Operator-run additive migration. Apply before starting v1.0.1 replicas.
-- No budget, ledger, account, session, or existing backup row is replaced.
BEGIN;
SELECT pg_advisory_xact_lock(73190101);
CREATE TABLE IF NOT EXISTS cashflow_backup_artifacts (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (budget_id, id)
);
CREATE TABLE IF NOT EXISTS cashflow_auth_rate_limits (
  key TEXT PRIMARY KEY,
  total_hits BIGINT NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cashflow_auth_rate_limits_reset_at
  ON cashflow_auth_rate_limits(reset_at);
COMMIT;
