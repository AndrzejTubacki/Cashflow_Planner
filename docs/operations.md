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
the data volume with the archive, then start the app. This is destructive, so a
copy-based restore test is recommended before relying on it:

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

Cashflow first writes the database copies into a temporary folder, validates the
complete set, and atomically renames it to the final backup folder. Successful
metadata is recorded only after finalization. A failed attempt removes temporary
or partial folders and records failed metadata when the planning database is
still writable.

The response returns the created path and records a backup ID in the profile's
`backup_metadata`. There is currently no public backup-list endpoint, so the
restore API is intended for controlled administrative tooling that already has
the metadata ID.

`POST /api/restore/:backupId` validates the stored backup, creates another
safety backup, restores planning and ledger rows, recalculates ledger running
balances, and regenerates projections. If restore fails, Cashflow attempts to
roll back from the safety backup. Missing metadata or a missing backup folder
returns `404`. A corrupt backup returns `400` before a safety backup is created.
If rollback also fails, the `500` response includes the safety-backup path and
separate original and rollback error messages for operator recovery.

App-level backups protect one profile and support import/restore safety. They do
not replace an external backup of the full data volume.

### Automatic Retention

Retention cleanup is best-effort and does not fail an otherwise successful
backup, import, restore, projection, or notification operation. It runs after
completed backups and safety operations, after migration recovery completion,
and during the daily `03:30` per-profile maintenance tick.

| Data | Retained |
| --- | --- |
| App backup folders | `settings.backup_retention_count` newest |
| Projection snapshots | 100 newest |
| Event log rows | 2,000 newest |
| Sent notification rows | 1,000 newest; unsent rows are never removed |
| Failed backup metadata | 100 newest |
| Successful backup metadata | Existing retained backup folders only |
| Completed migration recoveries | 2 newest |
| Pending migration recoveries | Never removed automatically |
| Completed deleted-budget recoveries | `CASHFLOW_DELETED_BUDGET_RECOVERY_RETENTION_COUNT` newest; default 5 |
| Completed global migration recoveries | `CASHFLOW_GLOBAL_MIGRATION_RECOVERY_RETENTION_COUNT` newest; default 2 |
| Pending/incomplete global migration recoveries | Never removed automatically |
| Temporary backup/recovery folders | Removed after 24 hours |

## Production Compose

A retained image tag keeps upgrades and rollbacks traceable:

```sh
export CASHFLOW_IMAGE_TAG=2026-06-04
docker compose -f docker-compose.example.yml build --pull cashflow
docker compose -f docker-compose.example.yml up -d --no-deps cashflow
docker compose -f docker-compose.example.yml ps
docker compose -f docker-compose.example.yml logs --tail=100 cashflow
```

The Compose health check calls `/healthz`. An upgrade is complete only after
the container is healthy, `/api/system` reports the expected version and new
`startedAt`, smoke checks pass, and logs contain no new errors.

Cashflow writes file logs by default. Set `CASHFLOW_MIRROR_LOGS_TO_STDOUT=1`
when a process manager or container platform should also collect the same log
lines from stdout/stderr.

### Upgrade

1. Create and verify an external `cashflow-data` backup.
2. The currently running image tag is retained for rollback.
3. Build the new image under a new `CASHFLOW_IMAGE_TAG`.
4. Start only the Cashflow service.
5. Health, system, smoke, and representative profile checks pass.
6. Migration recovery snapshots remain available until the upgraded profiles are
   verified.

For account/budget/authentication rollouts, the none-mode rollout check should
pass before staging or activating another authentication mode:

```sh
CASHFLOW_BASE_URL=https://cashflow.example.com \
CASHFLOW_ROLLOUT_ACCOUNT_ID=account-id \
CASHFLOW_ROLLOUT_BUDGET_ID=budget-id \
npm run rollout:check
```

`CASHFLOW_ROLLOUT_ACCOUNT_ID` and `CASHFLOW_ROLLOUT_BUDGET_ID` are optional.
When omitted, the check uses the first active account and budget it can see in
`none` mode. The check verifies health, system metadata, active auth mode,
account selection, budget selection, the selected budget's `/api` snapshot, and
full export shape. It creates only a normal short-lived session cookie.

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

These checks cover install, restart, restore, and upgrade verification:

```sh
curl http://localhost:3000/healthz
curl http://localhost:3000/readyz
curl http://localhost:3000/api/system
npm run smoke
```

For a deployment, replace `localhost:3000` with the deployed URL.

`/healthz` is process-only liveness. `/readyz` is a cheap readiness check: it
verifies the app has initialized, `DATA_DIR` exists and is writable, the global
database can be opened, and global schema metadata can be read. It does not scan
all budgets, run SQLite `integrity_check`, or call external APIs. Set
`CASHFLOW_READYZ_CHECK_DEFAULT_BUDGET=1` only when you also want a cheap
`local` planning DB schema read if that DB already exists.

## Optional Local Control Routes

The ignored `local/dev.mjs` module may register deployment-local restart and
test routes. When the file exists, Cashflow loads it during startup:

```sh
curl -X POST https://cashflow.example.com/api/restart
```


## Users, Setup, And Admin Defaults

Cashflow now separates accounts from budgets. In the current `none` mode,
account selection still requires no credential, so the app must remain behind a
trusted network or reverse-proxy access control. Fresh installations grant
`system_admin` to the first successfully created account only. Existing profile
installations migrate to one automatic legacy administrator; later accounts do
not receive global admin automatically.

New budgets open a first-run setup flow that saves:

- ledger currency
- UI locale
- timezone
- projection horizon
- optional non-negative opening-balance pending row
- optional recurring income used as the budget-period income

Admin global options are stored separately from user ledgers and apply only to
new budgets created after the option change. They do not rewrite existing
budget settings.

Purging an archived budget first writes a planner-data recovery export under
`DATA_DIR/deleted-budget-recoveries`. It can be imported into another budget
with full JSON replace import. It does not restore account memberships,
invitations, sessions, credentials, global roles, or operational/private
settings.

The Admin tab also stores staged authentication configuration. `none`,
`external`, and `internal` can be saved as draft modes with session timeout and
reverse-proxy header settings. `internal` can be activated after at least one
active system administrator has an email/password credential or an explicit
identity link to an enabled internal-mode provider. `external` can be activated
after a shared assertion-secret environment variable is set and at least one
active system administrator has an external identity link. Provider secrets
belong outside the UI, in environment variables or secret-file references.

Internal login setup sequence:

1. In Admin Accounts, set an email on a system administrator account.
2. Generate a password setup token for that account.
3. Use the login screen's Set password form with that token and a long password.
4. Sign back in through `none` mode while it is still active.
5. Stage `internal`, test the draft, then activate it.
6. Log in with the configured email and password.

Internal provider login setup sequence:

1. In Admin, configure an OIDC/Google/GitHub/Facebook provider with an exact
   redirect URI, client ID, scopes, and an environment or secret-file reference
   for the client secret.
2. Link the provider subject explicitly to a system administrator account or let
   a signed-in account start the provider-link flow.
3. Test sign-in through the provider before disabling password login.

Activation revokes existing sessions so old `none` sessions cannot continue as
a bypass. Password setup/reset tokens expire after 24 hours, are single-use, and
are stored only as hashes. If you set `CASHFLOW_PASSWORD_PEPPER`, keep it stable
and backed up as a deployment secret; losing it makes existing password hashes
unusable.

After internal mode is active, new accounts are created through budget
invitations. Invite by email from Budget Manager, then the invited person uses
the login screen's Register with invitation form. Registration consumes the
invitation, creates the account with that normalized email, stores an Argon2id
password hash, and signs the new account into the invited budget.

External reverse-proxy/SSO setup sequence:

1. Put Cashflow behind the authenticating proxy and block direct backend access.
2. Configure the proxy to strip client-supplied identity and assertion headers.
3. Set `CASHFLOW_EXTERNAL_AUTH_SECRET` or the env var named in Admin auth.
4. Configure subject, email, display-name, group, assertion-secret header, and
   trusted issuer/source names in the external auth draft.
5. Link at least one active system administrator account to its stable external
   subject in Admin Accounts.
6. Test and activate the external draft.

External provisioning defaults to `deny_unknown`. `allow_invited` creates an
account only when the trusted email matches a pending email-targeted budget
invitation. `allow_any` creates an account for any trusted identity allowed by
the configured domain list, but it does not create a budget automatically.

Negative opening balances are rejected during setup. Debt and overdraft
starting positions require a dedicated planning workflow that is not currently
implemented.

## Background Jobs And Notifications

Cashflow checks background work once per minute using each profile's timezone.
Daily jobs are catch-up safe: if the process is down at the exact scheduled
minute, the job runs once after the app sees that the scheduled local time has
passed. Successful daily runs are recorded in the profile event log so a restart
does not repeat the same local-day job.

- midnight: move due future rows to pending and queue daily notifications
- `08:00`: refresh FX for the profile
- configured notification delivery time: send queued ntfy notifications
- `03:30`: run retention cleanup

Automatic backups are evaluated on each tick when enabled. The configured
`backup_interval_minutes` is compared with the most recent successful backup, so
sub-day intervals can produce sub-day backups.

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

Full replace import ignores imported operational settings by default and
preserves the target profile's current backup, notification, ntfy, and retention
settings exactly. Enable **Include operational settings** during import only
when restoring into the same trusted deployment or intentionally copying those
settings. Merge imports ignore all settings. Loading the sample dataset also
preserves the target profile's operational settings.

Before creating a safety backup, full import strictly validates every planning
and ledger row. It rejects unknown fields, missing required values, invalid IDs,
enums, numbers, rates, dates, timestamps, JSON, broken ownership/source
relationships, ledger-year mismatches, and duplicate occurrence keys. Validation
errors identify the table, row, ID, field, and reason without echoing imported
values.

If a failure occurs after mutation starts, Cashflow restores the safety backup.
When rollback succeeds, the original error status and details are preserved.
When rollback also fails, the response is `500` and includes
`phase: "rollback_failed"`, the safety-backup path, and separate original and
rollback error messages. Preserve that safety backup for manual recovery.

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
data. Loading it replaces the current functional data after a safety backup and
preserves the profile's operational settings.

Large full imports use the server JSON request limit. The default is `10mb`; set
`CASHFLOW_JSON_LIMIT` when your deployment needs a larger limit.

Import drill:

1. Download a full export from the source profile.
2. Download a second full export from the target profile as a manual safety copy.
3. Import with `replace` or `merge`.
4. Confirm the import response is successful.
5. Refresh the app and verify Settings, pending rows, confirmed ledger rows, and
   summary balances.
6. Run `/api/validate` from an admin session.

Sample-load drill:

1. Download a full export from the current profile.
2. Click **Load sample dataset**.
3. Confirm sample rows appear and first-run setup does not reappear.
4. The saved export restores with `replace` when the demo is finished.

Backup/restore drill:

1. Create an app-level backup and a separate external backup before the test.
2. Make a small reversible change.
3. The app-level backup restores through controlled administrative tooling.
4. Verify `/healthz`, `/api/system`, `/api`, Settings, and a confirmed ledger
   row.

Before upgrading an older planning or ledger database, Cashflow automatically
creates a full recovery snapshot in the profile's built-in `backups` folder.
The snapshot includes `planning.sqlite`, every yearly ledger database, and a
manifest describing the source and target schema versions. Migration stops
without changing the database if this recovery snapshot cannot be created.
These `migration_backup_*` folders should remain available until the upgraded
profile has been verified. Cashflow retains the newest two completed migration
recoveries and never automatically removes pending recovery folders.

Live verification is safest with an isolated profile rather than `local`. For
example:

```sh
curl https://cashflow.example.com/healthz
curl https://cashflow.example.com/api/system
curl -H 'x-cashflow-user-id: cashflow-smoke' https://cashflow.example.com/api/session
```

For deployments that use file synchronization and an operator-owned restart
hook, verification normally waits for the sync window, restarts the backend,
and checks only the isolated profile.

## Offline Administrator Recovery

Fresh installations grant `system_admin` to the first account only. The global
database prevents removing or disabling the last active administrator.

If administrative access still needs to be recovered, stop Cashflow and run
the offline operator command against an existing active account:

```sh
npm run operator:grant-admin -- \
  --data-dir /path/to/cashflow/data \
  --account-id existing-account-id
```

The command writes an audit event and does not create an HTTP recovery route.
A backup of `cashflow-global.sqlite` is recommended before offline recovery.

## Verification

A local smoke check covers the default local workflow after install or upgrade:

```sh
npm run smoke
```

An already running deployment can be checked with:

```sh
CASHFLOW_BASE_URL=https://cashflow.example.com \
CASHFLOW_SMOKE_USER_ID=cashflow-smoke \
npm run smoke
```

The none-mode rollout check is used before enabling `internal` or `external`
authentication:

```sh
CASHFLOW_BASE_URL=https://cashflow.example.com \
CASHFLOW_ROLLOUT_ACCOUNT_ID=account-id \
CASHFLOW_ROLLOUT_BUDGET_ID=budget-id \
npm run rollout:check
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
