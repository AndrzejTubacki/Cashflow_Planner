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
`.env` first only when you want to override the default host/container ports:

```sh
docker compose -f docker-compose.example.yml up -d --build
```

For production installs:

- keep `/app/data` mounted persistently
- keep `/app/logs` mounted persistently if you want file logs
- prefer `restart: unless-stopped`
- put the app behind a reverse proxy with auth
- do not bake runtime data into the image

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `CASHFLOW_HTTP_PORT` | `3000` | Host port used by the Compose example |
| `DATA_DIR` | `./data` | SQLite/runtime data directory for non-container process managers |
| `LOGS_DIR` | `./logs` | Log directory for non-container process managers |
| `CASHFLOW_LOG_TIMEZONE` | `Europe/Warsaw` | Timezone used for server log timestamps |

Use `.env.example` as a deployment reference.

For direct Node/process-manager installs, the app optionally loads `.env` from
the app root at startup. Existing process environment variables still win, so
systemd, Docker, TrueNAS, and other process managers can override file defaults.

Docker Compose also reads a local `.env` file for variable substitution, such
as `PORT` and `CASHFLOW_HTTP_PORT`. The Compose example only passes explicitly
listed variables into the container.

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
