# Migrating Between SQLite And Postgres

These are operator-run commands, not something triggered from the app or an
API route. Both directions default to a dry run; nothing writes anywhere
until you add `--apply`. Back up first, either way.

## SQLite → Postgres

1. Snapshot the live SQLite data. This is safe to run while the app is up;
   it reads through SQLite's WAL consistently and never modifies the
   source:

   ```sh
   npm run db:snapshot -- --data-dir data --output-dir ./external-migration-snapshots
   ```

2. Preview what would be migrated:

   ```sh
   npm run db:migrate:sqlite-to-postgres -- \
     --data-dir ./external-migration-snapshots/<snapshot-folder> \
     --output-dir ./external-database-exports \
     --pretty
   ```

3. Apply it. `--source-is-snapshot` is required here on purpose, so this
   command can't accidentally read from a live, still-changing SQLite file:

   ```sh
   npm run db:migrate:sqlite-to-postgres -- \
     --data-dir ./external-migration-snapshots/<snapshot-folder> \
     --output-dir ./external-database-exports \
     --apply --source-is-snapshot \
     --database-url "$CASHFLOW_DATABASE_URL"
   ```

4. Verify the destination matches:

   ```sh
   npm run db:postgres:verify -- \
     --global-export ./external-database-exports/cashflow_sqlite_global_export_....json \
     --budget-export ./external-database-exports/cashflow_sqlite_budget_export_....json \
     --database-url "$CASHFLOW_DATABASE_URL" \
     --pretty
   ```

## Postgres → SQLite

1. Preview what would be written:

   ```sh
   npm run db:migrate:postgres-to-sqlite -- \
     --data-dir ./restored-data \
     --database-url "$CASHFLOW_DATABASE_URL" \
     --pretty
   ```

   Add `--budget-ids household,personal` to migrate specific budgets;
   otherwise every budget in the database is included.

2. Apply it. `--data-dir` must be empty (no existing
   `cashflow-global.sqlite`) unless you also pass `--force`. This is a
   deliberate guard against overwriting an existing SQLite install by
   accident:

   ```sh
   npm run db:migrate:postgres-to-sqlite -- \
     --data-dir ./restored-data \
     --database-url "$CASHFLOW_DATABASE_URL" \
     --apply
   ```

3. Verify:

   ```sh
   npm run db:sqlite:verify -- \
     --input ./external-database-exports/cashflow_postgres_storage_export_....json \
     --data-dir ./restored-data \
     --pretty
   ```

## What this doesn't do

- Neither direction merges into an existing install; both write into a
  fresh target. Point `CASHFLOW_DB_BACKEND` at the result once you've
  verified it, rather than trying to migrate onto a running database.
- There's no zero-downtime option. Migrating a live SQLite install means
  taking the snapshot in step 1 first, which briefly pauses writes while it
  copies.
- The generated export files contain real account, budget, and transaction
  data. Treat them like a database backup: keep them out of source control
  and delete them once you've verified the migration.
