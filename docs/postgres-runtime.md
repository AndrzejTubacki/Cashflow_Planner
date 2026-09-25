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
create databases, manage the Postgres server, or migrate its application schema
at startup. Treat database URLs as secrets. SQLite files must never be shared
between multiple app replicas, even if Postgres runtime locks are enabled.

For v1.0.1, apply the additive, repeatable
[`postgres-v1.0.1.sql`](../scripts/migrations/postgres-v1.0.1.sql) migration before
rolling out the new code. It adds shared backup artifacts and auth rate-limit
windows without replacing financial or account rows. This is an operator action;
starting a replica does not apply it. Existing backup metadata remains valid.

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
throttling. SQLite retains its process-local limiter. Client IPs follow the
existing Express proxy trust configuration; do not blindly trust forwarded IPs.

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
