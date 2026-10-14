# External Database Runtime

SQLite remains the default supported backend for a single process. Postgres is
an optional runtime backend, shipped in v1.0.0. Its global and budget stores serve
live HTTP routes, sessions, planning, ledger, projection, import and restore.

## Configuration

```sh
CASHFLOW_DB_BACKEND=postgres
CASHFLOW_DATABASE_URL=postgres://user:password@host:5432/database
CASHFLOW_RUNTIME_LOCK_BACKEND=postgres
```

Provision and initialize the database before starting the app. The app does not
create databases or manage the Postgres server. For a fresh database, generate
the complete global and budget DDL
and apply it with `psql`:

```sh
npm run db:postgres:schema -- --output /tmp/cashflow-schema.sql
psql "$CASHFLOW_DATABASE_URL" -f /tmp/cashflow-schema.sql
```

`npm run db:postgres:schema` prints the same DDL when `--output` is omitted; it
does not connect to Postgres or apply anything itself. Treat database URLs as
secrets. SQLite files must never be shared between multiple app replicas, even
if Postgres runtime locks are enabled.

For an existing installation, startup checks both the global schema version and
the budget planning/ledger versions. It takes a fixed Postgres advisory lock,
checks again after acquiring it, and applies pending `postgres-v*.sql` files in
version order. Applied file names and SHA-256 checksums are recorded in
`cashflow_schema_migrations`. A database previously updated by hand is detected
from its schema and remains supported. Existing backup metadata remains valid.

Set `CASHFLOW_DB_AUTO_MIGRATE=false` to keep schema changes operator-controlled.
In that mode, or after an automatic migration fails, run this where Cashflow
runs with `CASHFLOW_DATABASE_URL` pointing to a role allowed to alter its tables:

```sh
npm run db:migrate
```

When at least one migration is pending, both startup migration and
`npm run db:migrate` default to creating a same-database safety copy first.
While holding the migration advisory lock, Cashflow discovers every base table
in the active application schema (`current_schema()`), including global,
budget, ledger, artifact, and schema-version tables, and copies their rows into
a schema named like
`cashflow_premigration_g5_p6_l6_20261014t080910123z`. The operation and its
`cashflow_schema_backups` registry record are transactional. The registry stores
the source and target versions, creation time, table count, and per-table row
counts. `npm run db:migrate` prints the created schema name.

The database role needs `CREATE` on the database in addition to its normal
rights on the application schema and tables. If the copy fails, no migration is
applied. Cashflow enters update-needed mode and tells the operator to make a
backup, then run:

```sh
CASHFLOW_DB_MIGRATION_BACKUP=false npm run db:migrate
```

Only use that override after making and verifying another backup.
`CASHFLOW_DB_MIGRATION_BACKUP=false` disables the safety copy;
`CASHFLOW_DB_MIGRATION_BACKUP_KEEP=3` controls how many recorded schemas remain
after a successful migration. Invalid values are logged and use their defaults.
Retention drops only schemas recorded in `cashflow_schema_backups`; set the keep
count to `0` if none should remain.

These schemas live in the same database as the source. They protect against a
bad schema migration, but not database loss, storage corruption, compromised
credentials, or an operator dropping the database. Continue taking verified,
off-site whole-database backups.

To inspect or recover one table, substitute the recorded schema name. A safe
first step is to copy it into a separately named recovery table, compare it with
the live table, and then merge the required rows with explicit column lists.
Replacing a live table is safest while the app is stopped and only when the
layouts are compatible; dependent tables may require a coordinated restore:

```sql
SELECT * FROM cashflow_premigration_g5_p6_l6_20261014t080910123z.accounts;

BEGIN;
CREATE TABLE public.accounts_recovery AS TABLE
  cashflow_premigration_g5_p6_l6_20261014t080910123z.accounts;
COMMIT;
```

To remove a retained copy manually, drop its schema and registry row together
(automatic retention normally does this):

```sql
BEGIN;
DROP SCHEMA cashflow_premigration_g5_p6_l6_20261014t080910123z CASCADE;
DELETE FROM public.cashflow_schema_backups
WHERE schema_name = 'cashflow_premigration_g5_p6_l6_20261014t080910123z';
COMMIT;
```

The update-needed page also prints per-file `psql` commands and generic
`docker exec`/`kubectl exec` alternatives. It contains no configured database
URL. Cashflow rechecks every 30 seconds and on the next browser page request,
then resumes normal service without a restart when the schema is current.

`CASHFLOW_DB_UPDATE_READINESS=ready` is the default. `/readyz` returns 200 with
`databaseUpdateRequired: true`, keeping the notice reachable behind Kubernetes.
During a rolling update, however, Kubernetes then replaces working old pods
even when every new pod lacks migration permission; the whole app shows the
notice until `npm run db:migrate` succeeds.

With `CASHFLOW_DB_UPDATE_READINESS=not_ready`, `/readyz` returns 503 while the
pod still serves the notice directly. A rolling update stops after the first new
pod, old pods continue serving, and Kubernetes marks the rollout failed after
its progress deadline. Once the schema is current, the new pod becomes ready
and the rollout resumes automatically. With no old pod (a fresh install or a
Recreate strategy), users normally see the proxy's generic unavailable page
instead of Cashflow's notice. Unknown setting values are logged and use `ready`.

For the first rolling upgrade, remember that the first new pod able to migrate
changes the shared database before old pods terminate. Migration files are
additive and must remain compatible with those old pods for the duration of the
rollout. Back up the whole database first and monitor both old and new replicas.

## Replica coordination and connections

All Postgres replicas must use the same database and runtime lock database.
`CASHFLOW_RUNTIME_LOCK_DATABASE_URL` defaults to `CASHFLOW_DATABASE_URL`. When
the resolved URLs are equal, locks borrow the application's global-store pool.
Different URLs use one additional owned pool; configure identical URL strings
when they refer to the same database and should share a pool.

Each pool has an explicit maximum of 10 connections and a 10-second connection
checkout timeout. The normal Postgres deployment has two pools (global and
budget): at most **20 connections per replica**. A separate lock database adds
10, giving **30 per replica**, split across those databases. These are ceilings;
connections are opened lazily. Budget for rolling-update surge replicas too.

Lock operations release their pool clients after each query. A long callback
therefore does not consume a global connection while waiting on nested work.
Separate lock database initialization creates only the lock table/index and is
serialized with a transaction-scoped advisory lock. The application's global
schema is not implicitly initialized by the lock service.

Lock leases renew throughout callbacks at approximately one third of the TTL.
A rejected renewal reports lease loss and aborts the callback signal; the
scheduler checks that signal between budgets. These remain cooperative leases,
not database fencing: a process suspended beyond the TTL or prolonged database
outage can lose ownership, and callbacks cannot undo external side effects.
Monitor `cashflow_runtime_lock_renewal_failed` and `cashflow_runtime_lock_lost`.

Postgres with runtime locks disabled emits
`cashflow_postgres_runtime_locks_disabled`; single-process use is allowed, but
scaling that configuration is unsupported. Sessions, CSRF, setup, credentials,
and login-failure state are DB-backed. Internal-auth HTTP throttling now uses
atomic Postgres-time windows shared across replicas (20 attempts per IP per
15 minutes). Store failure returns 503; it never falls back to per-process
throttling. SQLite retains its process-local limiter. Client IPs (and
therefore this per-IP throttling) only reflect a forwarded address when the
operator opts in with `CASHFLOW_TRUST_PROXY`; by default the app trusts no
proxy and keys on the direct socket peer. See the configuration docs for the
accepted values.

SIGTERM stops accepting new requests and new background ticks, drains the
current tick and HTTP requests, then closes all owned pools. A 10-second hard
shutdown deadline remains. Work exceeding it is forcibly terminated and its
lease expires by TTL; it is not guaranteed to complete. Configure Kubernetes
termination grace longer than 10 seconds and account for any preStop delay.

## Backups and filesystem durability

Postgres app backups store JSON bytes in `cashflow_backup_artifacts`, scoped by
budget ID, and discovery metadata in `backup_metadata`. Both are committed in
one transaction. `POST /api/backup` returns a `postgres-backup:<id>` reference;
`POST /api/restore/:backupId` works on any replica without the creator's disk.
Snapshots omit backup history. Financial restores preserve backup metadata and
payloads, including the safety copy needed after a failed restore.

Legacy path-only backups still require the original file to be available on the
restoring replica; missing files return 404. They are not automatically uploaded.
There is still no public backup-list endpoint. Shared payload retention is not
automated; monitor database growth and preserve safety artifacts when managing
history. The financial JSON export/migration format does not include artifact
payloads. Back up the **whole Postgres database**, including artifact and auth
state, for disaster recovery. A backup kept in the same DB is not protection
against losing that DB.

Deleted-budget recovery JSON remains under
`DATA_DIR/deleted-budget-recoveries`; its path is recorded in the security audit
log for manual recovery. It is not a shared restore API. Recoverability after
pod/disk loss requires persistent storage and an external backup of each
replica's DATA_DIR (or a deliberately shared recovery directory). Ephemeral-only
DATA_DIR is unsupported if this recovery guarantee is required. SQLite migration
snapshots are filesystem-only and do not run for Postgres.

## Health, packaging, and release validation

`/healthz` is process liveness. `/readyz` checks storage readiness and DATA_DIR
writability. With `CASHFLOW_READYZ_CHECK_DEFAULT_BUDGET=1`, it checks the `local`
budget's settings row in Postgres rather than probing a SQLite filename; an
absent optional budget is reported as absent. It does not scan every budget.

The runtime image uses UID/GID 1000 (`node`) and starts Node directly. DATA_DIR
and LOGS_DIR must be writable. Native temporary files use DATA_DIR/tmp. SQLite
custom `settings.backup_location` directories require additional writable mounts.
Postgres app backups no longer use those directories, but deleted-budget recovery
and logs still need durable storage where required by operational policy.

`npm run test:container` builds the image and runs actual initialization,
health/readiness/API and shutdown checks under `--read-only`, with only data/log
volumes writable. Verified on Docker with UID/GID 1000 (including PID 1),
capabilities dropped, and no-new-privileges: first-run budget setup/projection,
health/readiness/API and graceful shutdown pass. The test requires root writes
to fail with EROFS and native temporary storage to remain writable. Runtime
image permissions also support source checkouts inaccessible to other users.
Deployment configuration has not been changed by this verification.

## Tests and migration tooling

Run SQLite and browser tests first, then all Postgres tests serially:

```sh
CASHFLOW_ENABLE_POSTGRES_TESTS=0 npm test
CASHFLOW_ENABLE_POSTGRES_TESTS=1 npm run test:postgres
npm run smoke
npm run test:container
```

The Postgres runner discovers all guarded test files and invokes
`node --test --test-concurrency=1`. It requires a disposable database: the helper
drops and recreates Cashflow tables around each test. Never use it on retained
data. It does not drop roles, databases, or extensions. Concurrent test-file
execution against that same disposable database is unsupported.

Existing migration commands, exports and verification are documented in
[Migration](migration.md). This hardening release
does not introduce a new data-transfer path. Full database backup and a tested
restore procedure remain the operator's responsibility.
