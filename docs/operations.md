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

Full export currently includes the full Settings row. Treat export files as
private data because settings may contain deployment-specific values such as
notification URLs, backup locations, and backup/notification toggles.

Full JSON import supports:

- `replace`: creates a safety backup, replaces current functional data,
  recalculates ledger balances, regenerates projections, and rolls back on
  failure
- `merge`: appends imported rows when there are no ID conflicts; current
  settings are preserved

One-off CSV import uses strict columns:

```text
name,type,amount,currency,date
```

`type` must be `income` or `expense`, `amount` must be non-negative, and `date`
must use `YYYY-MM-DD`.

Confirmed ledger CSV export downloads all confirmed rows across ledger years.

The sample dataset is fictitious demo data. Downloading it does not change user
data. Loading it replaces the current user data after a safety backup.

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
