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
4. Verify `GET /api` returns expected data.

SQLite note: copying live SQLite files while the app is writing can produce an
inconsistent backup, especially when WAL files are involved. The safest simple
backup is taken while the app is stopped. If you need live backups later, add a
SQLite-aware backup/checkpoint flow.

Restore procedure:

1. Stop the app.
2. Replace `data/` with the backup copy.
3. Start the app.
4. Verify `/healthz`, `/api/system`, and `/api`.

Cashflow also has app-level backup and restore endpoints:

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/backup` | Creates a SQLite backup for the selected user and records it in `backup_metadata` |
| `POST` | `/api/restore/:backupId` | Restores a recorded backup by id, with a safety backup and validation-oriented import flow |

These endpoints are intended for trusted/self-hosted operation. They are not a
replacement for external volume backups, especially before upgrades.

## Upgrade

Suggested safe upgrade flow:

1. Back up `data/`.
2. Pull or build the new version.
3. Restart the app.
4. Check `/api/system`.
5. Check `/api`.
6. Review logs for errors.

## Operational API

These are the basic operational endpoints, not a complete API reference:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness check |
| `GET` | `/api/system` | Process status and app version |
| `GET` | `/api` | Cashflow snapshot |
| `GET` | `/api/users` | List user namespaces known to the app |
| `POST` | `/api/users` | Create a user namespace and return an auth-ready session |
| `GET` | `/api/session` | Return the selected user session and admin defaults |
| `POST` | `/api/logout` | Stateless logout placeholder for the current frontend shell |
| `POST` | `/api/setup` | Complete first-run setup for the selected user |
| `GET` | `/api/admin/options` | Read global defaults for newly created users |
| `PUT` | `/api/admin/options` | Update global defaults for newly created users |
| `GET` | `/api/locales` | Available UI locales |
| `PUT` | `/api/settings` | Update user settings |
| `POST` | `/api/run-jobs` | Refresh FX and regenerate projections |
| `POST` | `/api/fx/refresh` | Refresh FX for the current user and regenerate projections |
| `POST` | `/api/validate` | Validate current Cashflow data |
| `POST` | `/api/backup` | Create a user-scoped backup |
| `POST` | `/api/restore/:backupId` | Restore a user-scoped backup |
| `GET` | `/api/export/full` | Download functional user data as JSON |
| `POST` | `/api/import/full` | Import full JSON data in replace or merge mode |
| `POST` | `/api/import/one-offs-csv` | Import one-off transactions from CSV |
| `GET` | `/api/export/confirmed-ledger.csv` | Download confirmed ledger rows as CSV |
| `GET` | `/api/export/sample` | Download the built-in sample dataset |
| `POST` | `/api/import/sample` | Load the built-in sample dataset into the current user |

The frontend stores the selected user id locally and sends it as
`x-cashflow-user-id`. API clients can set that header to select another storage
namespace. If the header is absent, the server falls back to `local`. This is not
authentication.

## Users, Setup, And Admin Defaults

Cashflow has a lightweight user-selection shell. Users are storage namespaces,
not authenticated identities. The session shape includes a permissions array so
native auth can be added later; for now every selected user receives `admin`.

New users start with `setup_required: true`. The first-run setup flow saves:

- ledger currency
- UI locale
- timezone
- projection horizon
- optional opening-balance pending row
- optional recurring income used as the budget-period income

Admin global options are stored separately from user ledgers and apply only to
new users created after the option change. They do not rewrite existing user
settings.

## Data Portability

The Settings tab includes Data portability controls for the current user
namespace.

Full JSON export includes functional planning data, FX cache rows, ledger
currency events, pending rows, and confirmed ledger rows grouped by year. It
excludes operational tables such as backup metadata, event logs, notifications,
projection snapshots, and generated future rows.

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

Verification commands matter for installs and upgrades: they give users a quick
way to confirm the app boots, migrations did not break runtime data, and core
utility behavior still passes before trusting projections.

Run unit tests:

```sh
npm test
```

`npm test` runs both Node integration/unit tests and Playwright browser smoke
checks.

Run only the Node test suite:

```sh
npm run test:node
```

Run only browser smoke checks:

```sh
npm run test:browser
```

Run a local smoke check:

```sh
npm run smoke
```

Check an already running deployment:

```sh
CASHFLOW_BASE_URL=https://cashflow.example.com npm run smoke
```

The smoke script checks:

- `GET /healthz`
- `GET /api/system`
- `GET /api`

The browser smoke script checks that the app loads in Chromium, `Validate`
renders a visible result, and every main tab renders its expected heading and
core controls.

## Local Development And Private Operations

Deployment-specific operational controls can be mounted in `local/`.

For example, a private deployment may add:

```text
local/dev.mjs
```

`server.mjs` tries to load this module if it exists. The directory is ignored by
Git and Docker build context, so private operational endpoints do not ship in
the public repo or public image.

This local module can register private routes such as restart or test-runner
endpoints. Public builds do not include that implementation.
