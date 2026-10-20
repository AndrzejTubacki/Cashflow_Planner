-- Cashflow v1.1.5: optional end month for recurring expenses and incomes.
-- Additive and safe to run more than once.
BEGIN;
SELECT pg_advisory_xact_lock(73190115);

DO $cashflow_version_guard$
DECLARE
  current_version INTEGER;
BEGIN
  SELECT planning_version INTO current_version FROM cashflow_budget_schema_version WHERE id = 1;
  IF current_version IS NULL OR current_version NOT IN (20, 21) THEN
    RAISE EXCEPTION 'postgres-v1.1.5.sql expects planning schema version 20 or 21, found %', current_version;
  END IF;
END;
$cashflow_version_guard$;

ALTER TABLE recurring_expenses
  ADD COLUMN IF NOT EXISTS end_month_year TEXT CHECK (end_month_year IS NULL OR end_month_year ~ '^\d{4}-\d{2}$');
ALTER TABLE recurring_incomes
  ADD COLUMN IF NOT EXISTS end_month_year TEXT CHECK (end_month_year IS NULL OR end_month_year ~ '^\d{4}-\d{2}$');

DO $cashflow_end_month_year_validation$
DECLARE
  matching_columns INTEGER;
BEGIN
  SELECT count(*) INTO matching_columns
  FROM information_schema.columns AS c
  WHERE c.table_schema = current_schema()
    AND c.table_name IN ('recurring_expenses', 'recurring_incomes')
    AND c.column_name = 'end_month_year'
    AND c.data_type = 'text'
    AND c.is_nullable = 'YES';

  IF matching_columns <> 2 THEN
    RAISE EXCEPTION 'recurring end_month_year columns have an incompatible schema';
  END IF;
END;
$cashflow_end_month_year_validation$;

UPDATE cashflow_budget_schema_version
SET planning_version = 21,
    applied_at = now()
WHERE id = 1;

COMMIT;
