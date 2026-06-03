# Operations

## Backup And Restore

At minimum, back up:

```text
data/
```

Recommended backup procedure:

1. Stop the app or pause writes.
2. Copy `data/` to your backup destination.
3. Start the app again.
4. Open the app and confirm your data appears as expected.

SQLite note: copying live SQLite files while the app is writing can produce an
inconsistent backup, especially when WAL files are involved. The safest simple
backup is taken while the app is stopped. If you need live backups later, add a
SQLite-aware backup/checkpoint flow.

Restore procedure:

1. Stop the app.
2. Replace `data/` with the backup copy.
3. Start the app.
4. Verify `/healthz`, `/api/system`, and `/api`.

Cashflow can also create safety backups before import and restore operations.
Treat those as a convenience layer. They are not a replacement for external
volume backups, especially before upgrades.

## Upgrade

Suggested safe upgrade flow:

1. Back up `data/`.
2. Pull or build the new version.
3. Restart the app.
4. Check `/healthz`.
5. Check `/api/system`.
6. Review logs for errors.

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
can currently select any profile, and every selected profile can access admin
defaults.

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

1. Create or download a backup before the test.
2. Make a small reversible change.
3. Restore the backup.
4. Verify `/healthz`, `/api/system`, `/api`, Settings, and a confirmed ledger
   row.

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
CASHFLOW_BASE_URL=https://cashflow.example.com npm run smoke
```

Treat deployed smoke checks as operational checks. They confirm that the app is
responding, but they do not replace a real backup/restore check.
