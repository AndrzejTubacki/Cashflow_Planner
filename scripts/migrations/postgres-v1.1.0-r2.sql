-- Second additive schema revision for v1.1.0. Safe to run more than once.
BEGIN;
SELECT pg_advisory_xact_lock(73190110);

DO $cashflow_version_guard$
DECLARE
  current_version INTEGER;
BEGIN
  SELECT version INTO current_version FROM cashflow_global_schema_version WHERE id = 1;
  IF current_version IS NULL OR current_version NOT IN (6, 7) THEN
    RAISE EXCEPTION 'postgres-v1.1.0-r2.sql expects global schema version 6 or 7, found %', current_version;
  END IF;
END;
$cashflow_version_guard$;

ALTER TABLE global_options
  ADD COLUMN IF NOT EXISTS ntfy_allowed_private_hosts JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $cashflow_ntfy_hosts_validation$
DECLARE
  hosts_type TEXT;
  hosts_nullable TEXT;
  hosts_default TEXT;
BEGIN
  SELECT c.data_type, c.is_nullable, c.column_default
  INTO hosts_type, hosts_nullable, hosts_default
  FROM information_schema.columns AS c
  WHERE c.table_schema = current_schema()
    AND c.table_name = 'global_options'
    AND c.column_name = 'ntfy_allowed_private_hosts';

  IF hosts_type IS DISTINCT FROM 'jsonb'
    OR hosts_nullable IS DISTINCT FROM 'NO'
    OR hosts_default IS DISTINCT FROM '''[]''::jsonb'
  THEN
    RAISE EXCEPTION 'global_options.ntfy_allowed_private_hosts has an incompatible schema';
  END IF;
END;
$cashflow_ntfy_hosts_validation$;

INSERT INTO cashflow_global_schema_version (id, version, applied_at)
VALUES (1, 7, now())
ON CONFLICT (id) DO UPDATE SET
  version = EXCLUDED.version,
  applied_at = EXCLUDED.applied_at;

COMMIT;
