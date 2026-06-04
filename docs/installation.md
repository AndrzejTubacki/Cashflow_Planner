# Installation

## Requirements

For a local Node install:

- Node.js 22 recommended
- npm

For container deployment:

- Docker
- Docker Compose, optional but recommended

## Quick Start

```sh
npm ci
npm start
```

Open `http://localhost:3000`.

The app listens on configured `PORT` or by default on `3000`.

## Docker

Build and run directly:

```sh
docker build -t cashflow .
docker run --rm \
  -p 3000:3000 \
  -v cashflow-data:/app/data \
  -v cashflow-logs:/app/logs \
  cashflow
```

For the standard app service, start Compose directly. Copy `.env.example` to
`.env` when you want to retain deployment-specific values:

```sh
docker compose -f docker-compose.example.yml up -d --build
docker compose -f docker-compose.example.yml ps
curl http://localhost:3000/healthz
```

For production installs:

- keep `/app/data` mounted persistently
- keep `/app/logs` mounted persistently if you want file logs
- keep `/app/backups` on a separate persistent volume when using custom backup
  locations
- prefer `restart: unless-stopped`
- put the app behind a reverse proxy with auth
- do not bake runtime data into the image
- tag each built image so the previous application version remains available
  for rollback

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `CASHFLOW_HTTP_PORT` | `3000` | Host port used by the Compose example |
| `CASHFLOW_IMAGE_TAG` | `local` | Image tag produced and selected by the Compose example |
| `DATA_DIR` | `./data` | SQLite/runtime data directory for non-container process managers |
| `LOGS_DIR` | `./logs` | Log directory for non-container process managers |
| `CASHFLOW_JSON_LIMIT` | `10mb` | Maximum JSON request body size, primarily used by full JSON imports |
| `CASHFLOW_LOG_TIMEZONE` | `Europe/Warsaw` | Timezone used for server log timestamps |
| `CASHFLOW_BACKUP_ALLOWED_ROOTS` | unset for direct Node; `/app/backups` in Compose | Comma-separated absolute roots allowed for custom profile backup locations |
| `CASHFLOW_FX_FETCH_TIMEOUT_MS` | `10000` | External FX request timeout in milliseconds |
| `CASHFLOW_NOTIFICATION_FETCH_TIMEOUT_MS` | `5000` | ntfy request timeout in milliseconds |

Use `.env.example` as a deployment reference.

For direct Node/process-manager installs, the app optionally loads `.env` from
the app root at startup. Existing process environment variables still win, so
systemd, Docker, TrueNAS, and other process managers can override file defaults.

Docker Compose also reads a local `.env` file for variable substitution, such
as `PORT`, `CASHFLOW_HTTP_PORT`, and `CASHFLOW_IMAGE_TAG`. The Compose example
passes the documented runtime variables into the container.

Custom backup locations are validated inside the application process. For
Compose, use a path under `/app/backups`; that path is mounted to the
`cashflow-backups` named volume. For direct Node installs, configure an absolute
host path outside the application source and primary data directory.

App settings include a timezone field. Cashflow uses that timezone for
date-sensitive planning defaults, projection generation, confirmation defaults,
FX rate dates, and scheduled background jobs. Existing installs default to
`Europe/Warsaw` until changed in Settings.

## Runtime Data

Runtime data and private deployment files should stay outside published source
archives and container images:

- `data/`
- `logs/`
- `backups/`
- `.env`

The app creates profile data under:

```text
data/<user-id>/
```

For the default standalone UI, the user id is `local`.

Important database files look like:

```text
data/<user-id>/planning.sqlite
data/<user-id>/ledger_YYYY.sqlite
```

The Compose example stores these paths in named volumes:

| Volume | Container path | Purpose |
| --- | --- | --- |
| `cashflow-data` | `/app/data` | Required planner profiles, ledgers, and global metadata |
| `cashflow-logs` | `/app/logs` | Operational logs |
| `cashflow-backups` | `/app/backups` | Optional custom app-level backups |

Back up `cashflow-data` externally before every upgrade. See
[Operations](operations.md) for upgrade, rollback, and restore procedures.

## Reverse Proxy

Cashflow binds to `0.0.0.0` for container networking. Keep the published port
private where possible and expose the app through a reverse proxy with HTTPS
and access control.

The reverse proxy must protect the browser app and every `/api/*` route.
`/healthz` may be exempted only when an external health monitor requires it.
See [Security](security.md) for Basic Auth and SSO forward-auth examples.
