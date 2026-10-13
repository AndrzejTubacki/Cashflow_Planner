-- Operator-run additive migration. Apply before starting v1.0.1 replicas.
-- Existing objects are validated before commit; incompatible hand-created
-- variants fail loudly instead of being accepted by IF NOT EXISTS.
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

-- Income-anchored recurring expenses were added after the original Postgres
-- support shipped but before this operator migration existed. Early adopters
-- therefore never received the column, and startup does not apply schema DDL.
ALTER TABLE recurring_expenses ADD COLUMN IF NOT EXISTS anchor_income_id TEXT;

DO $cashflow_schema_validation$
DECLARE
  actual_columns JSONB;
  actual_constraints JSONB;
  created_at_default TEXT;
BEGIN
  -- Compare physical column shape, not just names, so an old hand-built table cannot pass silently.
  SELECT jsonb_agg(
    jsonb_build_array(attname, format_type(atttypid, atttypmod), attnotnull, atthasdef)
    ORDER BY attnum
  )
  INTO actual_columns
  FROM pg_attribute
  WHERE attrelid = 'cashflow_backup_artifacts'::regclass
    AND attnum > 0
    AND NOT attisdropped;

  IF actual_columns IS DISTINCT FROM
    '[["budget_id", "text", true, false], ["id", "text", true, false], ["payload", "text", true, false], ["created_at", "timestamp with time zone", true, true]]'::jsonb
  THEN
    RAISE EXCEPTION 'cashflow_backup_artifacts has an incompatible schema';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_array(contype, pg_get_constraintdef(oid))
    ORDER BY contype, pg_get_constraintdef(oid)
  )
  INTO actual_constraints
  FROM pg_constraint
  WHERE conrelid = 'cashflow_backup_artifacts'::regclass
    AND contype != 'n';

  -- Postgres 18 (only - tried in 16, reverted, re-added in 18) catalogs a
  -- NOT NULL column as its own pg_constraint row (contype 'n'), on top of
  -- pg_attribute.attnotnull, which every supported version has always set.
  -- Excluding contype 'n' here keeps this check identical on 18 and on
  -- every earlier version; NOT NULL itself is already verified by the
  -- attnotnull column check above.
  IF actual_constraints IS DISTINCT FROM
    '[["f", "FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE"], ["p", "PRIMARY KEY (budget_id, id)"]]'::jsonb
  THEN
    RAISE EXCEPTION 'cashflow_backup_artifacts has an incompatible schema';
  END IF;

  SELECT pg_get_expr(default_value.adbin, default_value.adrelid)
  INTO created_at_default
  FROM pg_attribute column_info
  JOIN pg_attrdef default_value
    ON default_value.adrelid = column_info.attrelid
   AND default_value.adnum = column_info.attnum
  WHERE column_info.attrelid = 'cashflow_backup_artifacts'::regclass
    AND column_info.attname = 'created_at';

  IF created_at_default IS DISTINCT FROM 'now()' THEN
    RAISE EXCEPTION 'cashflow_backup_artifacts has an incompatible schema';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_array(attname, format_type(atttypid, atttypmod), attnotnull, atthasdef)
    ORDER BY attnum
  )
  INTO actual_columns
  FROM pg_attribute
  WHERE attrelid = 'cashflow_auth_rate_limits'::regclass
    AND attnum > 0
    AND NOT attisdropped;

  IF actual_columns IS DISTINCT FROM
    '[["key", "text", true, false], ["total_hits", "bigint", true, false], ["reset_at", "timestamp with time zone", true, false]]'::jsonb
  THEN
    RAISE EXCEPTION 'cashflow_auth_rate_limits has an incompatible schema';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_array(contype, pg_get_constraintdef(oid))
    ORDER BY contype, pg_get_constraintdef(oid)
  )
  INTO actual_constraints
  FROM pg_constraint
  WHERE conrelid = 'cashflow_auth_rate_limits'::regclass
    AND contype != 'n';

  -- Same Postgres-18-only contype 'n' exclusion as above.
  IF actual_constraints IS DISTINCT FROM
    '[["p", "PRIMARY KEY (key)"]]'::jsonb
  THEN
    RAISE EXCEPTION 'cashflow_auth_rate_limits has an incompatible schema';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_index index_info
    JOIN pg_class index_relation ON index_relation.oid = index_info.indexrelid
    JOIN pg_class table_relation ON table_relation.oid = index_info.indrelid
    JOIN pg_am access_method ON access_method.oid = index_relation.relam
    JOIN pg_attribute indexed_column
      ON indexed_column.attrelid = table_relation.oid
     AND indexed_column.attnum = ANY(index_info.indkey)
    WHERE index_relation.relname = 'idx_cashflow_auth_rate_limits_reset_at'
      AND table_relation.oid = 'cashflow_auth_rate_limits'::regclass
      AND access_method.amname = 'btree'
      AND indexed_column.attname = 'reset_at'
      AND index_info.indnkeyatts = 1
      AND index_info.indnatts = 1
      AND index_info.indisvalid
      AND index_info.indisready
      AND NOT index_info.indisunique
      AND index_info.indpred IS NULL
      AND index_info.indexprs IS NULL
  ) THEN
    RAISE EXCEPTION 'idx_cashflow_auth_rate_limits_reset_at has an incompatible definition';
  END IF;
END;
$cashflow_schema_validation$;

-- The period-income FK includes settings.budget_id to enforce same-budget
-- references. SET NULL therefore tried to null that NOT NULL tenant key when
-- restore/import temporarily replaced recurring incomes; deferred NO ACTION
-- allows the matching income to be reinserted before commit instead.
DO $cashflow_fix_period_income_fk$
DECLARE
  constraint_type "char";
  delete_action "char";
  is_deferrable BOOLEAN;
  is_initially_deferred BOOLEAN;
  local_columns TEXT[];
  referenced_columns TEXT[];
  referenced_table REGCLASS;
BEGIN
  SELECT
    constraint_info.contype,
    constraint_info.confdeltype,
    constraint_info.condeferrable,
    constraint_info.condeferred,
    ARRAY(
      SELECT column_info.attname
      FROM unnest(constraint_info.conkey) WITH ORDINALITY AS key_column(attnum, position)
      JOIN pg_attribute column_info
        ON column_info.attrelid = constraint_info.conrelid
       AND column_info.attnum = key_column.attnum
      ORDER BY key_column.position
    ),
    ARRAY(
      SELECT column_info.attname
      FROM unnest(constraint_info.confkey) WITH ORDINALITY AS key_column(attnum, position)
      JOIN pg_attribute column_info
        ON column_info.attrelid = constraint_info.confrelid
       AND column_info.attnum = key_column.attnum
      ORDER BY key_column.position
    ),
    constraint_info.confrelid::regclass
  INTO
    constraint_type,
    delete_action,
    is_deferrable,
    is_initially_deferred,
    local_columns,
    referenced_columns,
    referenced_table
  FROM pg_constraint constraint_info
  WHERE constraint_info.conrelid = 'settings'::regclass
    AND constraint_info.conname = 'settings_budget_period_income_fk';

  IF NOT FOUND
    OR constraint_type != 'f'
    OR local_columns IS DISTINCT FROM ARRAY['budget_id', 'budget_period_income_id']::TEXT[]
    OR referenced_table IS DISTINCT FROM 'recurring_incomes'::regclass
    OR referenced_columns IS DISTINCT FROM ARRAY['budget_id', 'id']::TEXT[]
    OR NOT is_deferrable
    OR NOT is_initially_deferred
  THEN
    RAISE EXCEPTION 'settings_budget_period_income_fk has an incompatible definition';
  END IF;

  IF delete_action = 'n' THEN
    ALTER TABLE settings DROP CONSTRAINT settings_budget_period_income_fk;
    ALTER TABLE settings
      ADD CONSTRAINT settings_budget_period_income_fk
      FOREIGN KEY (budget_id, budget_period_income_id)
      REFERENCES recurring_incomes(budget_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  ELSIF delete_action != 'a' THEN
    RAISE EXCEPTION 'settings_budget_period_income_fk has an incompatible delete action';
  END IF;
END;
$cashflow_fix_period_income_fk$;

-- v1.0.1's global schema adds DEFERRABLE INITIALLY IMMEDIATE to every FK on
-- these tables (replaceRows relies on SET CONSTRAINTS ALL DEFERRED), but
-- CREATE TABLE IF NOT EXISTS above leaves a pre-1.0.1 database's existing,
-- non-deferrable FKs untouched - on those, SET CONSTRAINTS is a silent
-- no-op and FK insertion order matters again during restore/import. This
-- looks up each constraint's real name from the catalog (never a
-- hand-guessed generated name like account_global_roles_account_id_fkey,
-- which an operator's own renamed/recreated constraint would not match) and
-- only alters FOREIGN KEY constraints, so it never touches the budget
-- schema's own FKs, which are already DEFERRABLE INITIALLY DEFERRED and
-- unrelated to this. Re-running this is a no-op once a constraint is
-- already deferrable, so it is safe on both an upgraded and a fresh
-- (already-deferrable) database.
DO $cashflow_defer_existing_fks$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT conname, conrelid::regclass::text AS table_name
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid::regclass::text = ANY(ARRAY[
        'account_global_roles', 'budgets', 'budget_memberships',
        'budget_invitations', 'auth_identities', 'password_credentials',
        'password_reset_tokens', 'auth_sessions', 'auth_oauth_states',
        'security_audit_log'
      ])
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
      fk.table_name, fk.conname
    );
  END LOOP;
END;
$cashflow_defer_existing_fks$;

COMMIT;
