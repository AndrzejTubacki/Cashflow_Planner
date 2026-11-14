# Migrating Between SQLite And Postgres

These are operator-run commands, not something triggered from the app or an
API route. Both directions default to a dry run; nothing writes anywhere
until you add `--apply`. Back up first, either way.

## Upgrading to 1.2.0

Cashflow 1.2.0 uses planning schema **22** and global schema **8**.
Postgres upgrades from 1.1.6 use `scripts/migrations/postgres-v1.2.0.sql`, with
the normal migration runner's advisory lock, backups and checksum checks.

On SQLite, the confirmed ledger now lives in `ledger_transactions` inside each
budget's `planning.sqlite`. Older yearly `ledger_YYYY.sqlite` files are imported
automatically on first start. Back up the whole data directory before upgrading;
keep historical files and recovery artifacts until the upgraded budget has been
verified. Postgres already stores confirmed rows beside planning data.

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


## Ledger audit storage (planning schema 22)

Ledger audit state, immutable originals, correction events and standalone origins
are part of planning schema 22. PostgreSQL uses the additive
`postgres-v1.2.0.sql` migration; the migration runner preserves its existing
backup/checksum safeguards. Migration retains financial rows without inventing
historical source evidence. New confirmations capture the accepted payment and
its source evidence; authorized financial sync operations can apply corrections
while retaining originals and previous correction events.

Runtime budget-store snapshots write
version 2 with financially replayed audit DTOs; they still read v1 snapshots.
PostgreSQL backup/safety artifacts and raw SQLite planning-file backups retain
audit history. Full financial JSON uses version 2 when audit evidence exists;
replacement and independent-copy imports preserve it and audited merges are
refused. Audited SQLite migration exports wrap the existing row payload in a
validated budget-store v2 snapshot. Older row-only exports remain readable;
putting audit fields on a v1 payload is refused instead of silently discarding
them. Migration into an already audited destination requires a fresh target.

The SQLite-to-PostgreSQL command imports metadata, facts, originals and correction
events on the same transaction, so a late audit-write failure rolls all of them
back. The reverse command already uses the complete storage snapshot and retains
the audit in the restored planning file. Both verifiers compare complete retained
evidence against financially replayed destination facts, in addition to existing
row-count/schema checks. Verification summaries contain no audit contents.

Migration verification is read-only. PostgreSQL migration clients cast DATE values
to text before comparison to preserve calendar dates independently of the driver's
JavaScript date/timezone conversion. Correction application verifies retained
evidence and recalculates effective balances within the owning financial
transaction; audit history is preserved in backups and supported transfers.

## Accounts and budget ownership

Upgrading never creates, removes, renames or re-assigns accounts. Every existing
account, global role and budget membership is kept as it is, whatever its ID.
An account named `legacy-admin`, created by an earlier version, is an ordinary
account: it keeps its roles and the budgets it owns, and can be renamed,
disabled or have its budgets transferred like any other.

A compatibility per-user budget is owned by an existing active account whose ID
matches `storage_key`, including renamed budgets. Discovery creates no accounts.
An unclaimed SQLite folder can be adopted through explicit `POST /api/users`
with that folder's user ID, using the normal account-creation path. Adoption
preserves existing financial settings; failed adoption does not remove the
folder. The first explicitly created account still receives `system_admin`.

Before explicit creation, selecting that folder through `GET /api` returns 404
(`User not found`), and `/api/users` does not list it as an account. This also
applies to folders containing only confirmed ledger history. After explicit
creation, that history is adopted intact and counts as completed setup; the user
is not sent through first-run setup again.

Runtime `auth mode none` remains available. Requests use the selected real
account and must pass membership checks; low-level context resolution without
an account ID fails, regardless of the budget's owner.

## Standalone-budget transfer

A paired companion device can review and submit a standalone budget as a new
server budget. The server validates supported source formats, replays retained
financial evidence, and checks the device's current creation permission before
publishing. A stable transfer ID supports outcome lookup and recovery after a
lost response; review alone creates no budget. Transfer preserves supported
confirmed history, corrections and ledger-currency history rather than treating
an opening balance as an extra payment. This is separate from the operator-run
whole-install SQLite/Postgres migration commands above.

The companion Android app is not public yet. Its detailed sync protocol
documentation lives with that private client; the public server implements the
pairing, version negotiation, financial operations and transfer endpoints.
