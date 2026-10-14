-- Operator-run additive migration. Apply before starting v1.1.0 replicas.
-- Safe to run more than once; existing account data is preserved.
BEGIN;
SELECT pg_advisory_xact_lock(73190110);

DO $cashflow_version_guard$
DECLARE
  current_version INTEGER;
BEGIN
  SELECT version INTO current_version FROM cashflow_global_schema_version WHERE id = 1;
  IF current_version IS NULL OR current_version NOT IN (5, 6) THEN
    RAISE EXCEPTION 'postgres-v1.1.0.sql expects global schema version 5 (v1.0.x with postgres-v1.0.1.sql applied) or 6, found %', current_version;
  END IF;
END;
$cashflow_version_guard$;

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avatar TEXT;

DO $cashflow_avatar_validation$
DECLARE
  avatar_type TEXT;
  avatar_nullable TEXT;
  avatar_default TEXT;
BEGIN
  SELECT c.data_type, c.is_nullable, c.column_default
  INTO avatar_type, avatar_nullable, avatar_default
  FROM information_schema.columns AS c
  WHERE c.table_schema = current_schema()
    AND c.table_name = 'accounts'
    AND c.column_name = 'avatar';

  IF avatar_type IS DISTINCT FROM 'text'
    OR avatar_nullable IS DISTINCT FROM 'YES'
    OR avatar_default IS NOT NULL
  THEN
    RAISE EXCEPTION 'accounts.avatar has an incompatible schema';
  END IF;
END;
$cashflow_avatar_validation$;

INSERT INTO cashflow_global_schema_version (id, version, applied_at)
VALUES (1, 6, now())
ON CONFLICT (id) DO UPDATE SET
  version = EXCLUDED.version,
  applied_at = EXCLUDED.applied_at;

COMMIT;
