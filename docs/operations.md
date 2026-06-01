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
| `GET` | `/api/locales` | Available UI locales |
| `PUT` | `/api/settings` | Update user settings |
| `POST` | `/api/run-jobs` | Refresh FX and regenerate projections |
| `POST` | `/api/fx/refresh` | Refresh FX for the current user and regenerate projections |
| `POST` | `/api/validate` | Validate current Cashflow data |
| `POST` | `/api/backup` | Create a user-scoped backup |
| `POST` | `/api/restore/:backupId` | Restore a user-scoped backup |

The frontend sends `x-cashflow-user-id: local` by default. API clients can set
that header to select another storage namespace, but this is not authentication.

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
