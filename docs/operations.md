# Operations

## Backup And Restore

Cashflow uses SQLite WAL mode. At minimum, externally back up the complete
`data/` directory or `cashflow-data` Compose volume. This contains global
profile metadata, every profile planning database, yearly ledgers, built-in
profile backups, and migration recovery snapshots.

External backups must be stored outside the primary Cashflow data volume. Also
back up the `cashflow-backups` volume when profiles use custom backup locations.

### Stopped-App Volume Backup

The safest portable backup stops writes before archiving the named data volume:

```sh
mkdir -p external-backups
docker compose -f docker-compose.example.yml stop cashflow
docker compose -f docker-compose.example.yml run --rm --no-deps \
  --entrypoint sh \
  -v "$PWD/external-backups:/external-backups" \
  cashflow \
  -c 'tar -C /app/data -czf /external-backups/cashflow-data.tgz .'
docker compose -f docker-compose.example.yml start cashflow
```

Copying live `.sqlite` files without their WAL files can lose data or produce an
inconsistent backup. Stop the app before raw filesystem or volume copies.

To restore a full external volume backup, stop Cashflow, replace the contents of
the data volume with the archive, then start the app. This is destructive and
must be tested against a copy first:

```sh
docker compose -f docker-compose.example.yml stop cashflow
docker compose -f docker-compose.example.yml run --rm --no-deps \
  --entrypoint sh \
  -v "$PWD/external-backups:/external-backups:ro" \
  cashflow \
  -c 'find /app/data -mindepth 1 -delete && tar -C /app/data -xzf /external-backups/cashflow-data.tgz'
docker compose -f docker-compose.example.yml start cashflow
```

Verify `/healthz`, `/api/system`, the selected profile `/api` snapshot, Settings,
and representative confirmed ledger rows after restore.

### App-Level Backups

`POST /api/backup` is an admin, user-scoped operation. It creates one profile
backup folder containing `planning.sqlite` and every existing yearly ledger
database. Each database copy uses SQLite `VACUUM INTO`, so individual copied
files are WAL-safe while the app remains online. The set of files is not one
cross-database point-in-time transaction.

```sh
curl -X POST \
  -H 'x-cashflow-user-id: household' \
  https://cashflow.example.com/api/backup
```

The response returns the created path and records a backup ID in the profile's
`backup_metadata`. There is currently no public backup-list endpoint, so the
restore API is intended for controlled administrative tooling that already has
the metadata ID.

`POST /api/restore/:backupId` validates the stored backup, creates another
safety backup, restores planning and ledger rows, recalculates ledger running
balances, and regenerates projections. If restore fails, Cashflow attempts to
roll back from the safety backup.

App-level backups protect one profile and support import/restore safety. They do
not replace an external backup of the full data volume.

## Production Compose

Use a retained image tag for every deployment:

```sh
export CASHFLOW_IMAGE_TAG=2026-06-04
docker compose -f docker-compose.example.yml build --pull cashflow
docker compose -f docker-compose.example.yml up -d --no-deps cashflow
docker compose -f docker-compose.example.yml ps
docker compose -f docker-compose.example.yml logs --tail=100 cashflow
```

The Compose health check calls `/healthz`. Do not consider an upgrade complete
until the container is healthy, `/api/system` reports the expected version and
new `startedAt`, smoke checks pass, and logs contain no new errors.

### Upgrade

1. Create and verify an external `cashflow-data` backup.
2. Retain the currently running image tag.
3. Build the new image under a new `CASHFLOW_IMAGE_TAG`.
4. Start only the Cashflow service.
5. Run health, system, smoke, and representative profile checks.
6. Keep migration recovery snapshots until the upgraded profiles are verified.

### Rollback

Select the retained previous image tag and start the service:

```sh
export CASHFLOW_IMAGE_TAG=previous-known-good
docker compose -f docker-compose.example.yml up -d --no-deps cashflow
```

An older application image may not understand databases migrated by a newer
version. When an upgrade changed schema versions, stop the app and restore the
matching pre-upgrade data backup before starting the old image.

## Health Checks

Use these checks after install, restart, restore, or upgrade:

```sh
curl http://localhost:3000/healthz
curl http://localhost:3000/api/system
npm run smoke
```

For a deployment, replace `localhost:3000` with the deployed URL.

## Users, Setup, And Admin Defaults

Cashflow has a lightweight user-selection screen. Treat users as separate
planner profiles, not as protected login accounts. Anyone who can reach the app
can currently select any profile. New profiles receive admin permission by
default.

New profiles open a first-run setup flow that saves:

- ledger currency
- UI locale
- timezone
- projection horizon
- optional opening-balance pending row
- optional recurring income used as the budget-period income

Admin global options are stored separately from user ledgers and apply only to
new profiles created after the option change. They do not rewrite existing
profile settings.

## Background Jobs And Notifications

Cashflow checks background work once per minute using each profile's timezone:

- midnight: move due future rows to pending and queue daily notifications
- `08:00`: refresh FX for the profile
- configured notification delivery time: send queued ntfy notifications
- `03:30`: evaluate automatic backup settings

A still-running tick causes the next tick to be skipped. A failure for one
profile is logged and does not stop later profiles. See
[Notifications](notifications.md) for ntfy configuration, timeout, and retry
behavior.

## Data Portability

The Settings tab includes Data portability controls for the selected profile.

Full JSON export includes the planner data needed to recreate a profile:
settings, FX rates, planned transactions, pending rows, and confirmed ledger
rows. Generated future projections are not exported because Cashflow rebuilds
them after import.

By default, full JSON export includes functional planner settings only.
Deployment-specific settings such as backup locations, auto-backup options,
notification URLs, notification toggles, notification priorities, and notification
repeat timing are omitted. Use **Include operational settings** only when you
intend to move those private deployment settings too.

Full JSON import supports:

- `replace`: creates a safety backup, replaces current functional data,
  recalculates ledger balances, regenerates projections, and rolls back on
  failure
- `merge`: creates a safety backup, appends imported rows when there are no ID
  conflicts, recalculates ledger balances, regenerates projections, and rolls
  back on failure

Full import ignores operational settings by default, even when the export file
contains them. Enable **Include operational settings** during import only when
restoring into the same trusted deployment or intentionally copying those
settings.

Full import also accepts older export files that do not contain newer setup,
holiday-country, or reserve fields. Cashflow fills current defaults and marks
the profile setup complete when the import contains planner or ledger data.

One-off CSV import uses strict columns:

```text
name,type,amount,currency,date
```

`type` must be `income` or `expense`, `amount` must be non-negative, and `date`
must use a real `YYYY-MM-DD` date. Missing columns, unexpected columns, malformed
quotes, blank amounts, unsupported currencies, negative amounts, invalid types,
wrong column counts, and impossible dates are rejected.

Confirmed ledger CSV export downloads all confirmed rows across ledger years.

The sample dataset is fictitious demo data. Downloading it does not change user
data. Loading it replaces the current user data after a safety backup.

Large full imports use the server JSON request limit. The default is `10mb`; set
`CASHFLOW_JSON_LIMIT` when your deployment needs a larger limit.

Recommended import drill:

1. Download a full export from the source profile.
2. Download a second full export from the target profile as a manual safety copy.
3. Import with `replace` or `merge`.
4. Confirm the import response is successful.
5. Refresh the app and verify Settings, pending rows, confirmed ledger rows, and
   summary balances.
6. Run `/api/validate` from an admin session.

Recommended sample-load drill:

1. Download a full export from the current profile.
2. Click **Load sample dataset**.
3. Confirm sample rows appear and first-run setup does not reappear.
4. Restore your saved export with `replace` when finished.

Recommended backup/restore drill:

1. Create an app-level backup and a separate external backup before the test.
2. Make a small reversible change.
3. Restore the app-level backup through controlled administrative tooling.
4. Verify `/healthz`, `/api/system`, `/api`, Settings, and a confirmed ledger
   row.

Before upgrading an older planning or ledger database, Cashflow automatically
creates a full recovery snapshot in the profile's built-in `backups` folder.
The snapshot includes `planning.sqlite`, every yearly ledger database, and a
manifest describing the source and target schema versions. Migration stops
without changing the database if this recovery snapshot cannot be created.
Keep these `migration_backup_*` folders until the upgraded profile has been
verified.

Live verification should use an isolated profile, not `local`. For example:

```sh
curl https://cashflow.example.com/healthz
curl https://cashflow.example.com/api/system
curl -H 'x-cashflow-user-id: codex-portability-smoke' https://cashflow.example.com/api/session
```

When files are synced to a live host, wait for the sync window, restart the
backend through the deployment restart endpoint, and verify only with the
isolated profile.

## Verification

Run a local smoke check after install or upgrade:

```sh
npm run smoke
```

Check an already running deployment:

```sh
CASHFLOW_BASE_URL=https://cashflow.example.com \
CASHFLOW_SMOKE_USER_ID=cashflow-smoke \
npm run smoke
```

The deployed API and browser smoke checks require a configured, non-`local`
profile. They are read-only by default:

```sh
CASHFLOW_BASE_URL=https://cashflow.example.com \
CASHFLOW_SMOKE_USER_ID=cashflow-smoke \
npm run test:browser
```

To run the full mutating browser workflow against that isolated profile, opt in
explicitly:

```sh
CASHFLOW_BASE_URL=https://cashflow.example.com \
CASHFLOW_SMOKE_USER_ID=cashflow-smoke \
CASHFLOW_ALLOW_MUTATING_SMOKE=1 \
npm run test:browser
```

Mutating browser smoke exports the isolated profile first and restores it when
the workflow finishes. It still creates safety backups, so use only a dedicated
smoke profile. Deployed smoke checks do not replace a real backup/restore
check.
