> [!CAUTION]
> Cashflow's default `none` mode is not access control. Public exposure needs
> internal login or an external access-control layer such as a VPN, private
> network, SSO, or reverse-proxy authentication. HTTPS alone is not access
> control. See [Security](docs/security.md) before exposing it outside your
> own machine.

# Cashflow

Cashflow is a self-hosted personal finance planner. It projects income,
recurring expenses, one-off spending, savings goals, and flexible transactions
ahead of time, and shows what can safely be funded before money is spent.

Most budgeting tools explain what already happened. Cashflow is built to plan
ahead: model income and bills, reserve money for goals, prioritize flexible
spending, and confirm real transactions against the plan as they happen.

## Quick Start

Directly with Node.js. Stores runtime data in local `data/` and `logs/`
folders next to the app:

```sh
npm ci
npm start
```

Open `http://localhost:3000`.

With Docker Compose, the easier path if you want the app isolated from the
rest of the host:

```sh
docker compose -f docker-compose.example.yml up -d --build
docker compose -f docker-compose.example.yml ps
curl http://localhost:3000/healthz
```

Direct Docker, without Compose:

```sh
docker build -t cashflow .
docker run --rm \
  -p 3000:3000 \
  -v cashflow-data:/app/data \
  -v cashflow-logs:/app/logs \
  cashflow
```

Requirements for a direct Node install: Node.js 22 and npm. For containers:
Docker, with Docker Compose recommended.

Starter Kubernetes manifests are available under
[`deploy/kubernetes/`](deploy/kubernetes/README.md) if you want to run
Cashflow in a cluster. Review and adapt them before use; they're a starting
point, not a guarantee of production readiness.

## Configuring It

Copy `.env.example` to `.env` and adjust the values you need. Cashflow reads
`.env` at startup for direct Node/process-manager installs; Docker Compose
also reads it for variable substitution. Environment variables from your
process manager or container runtime always win over `.env`.

The settings that matter for most self-hosted installs:

| Variable | Default | What it's for |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port the app listens on |
| `DATA_DIR` | `./data` | Where planning/ledger databases live (direct Node installs; Docker Compose uses a named volume instead) |
| `LOGS_DIR` | `./logs` | Where log files are written |
| `CASHFLOW_DB_BACKEND` | `sqlite` | `sqlite` (default, no other setup needed) or `postgres` (optional, see [Database Backend](#database-backend) below) |
| `CASHFLOW_JSON_LIMIT` | `10mb` | Max request body size, mainly for full JSON imports |
| `CASHFLOW_LOG_TIMEZONE` | `Europe/Warsaw` | Timezone for server log timestamps (the app's own planning timezone is a Settings field, not an env var) |
| `CASHFLOW_MIRROR_LOGS_TO_STDOUT` | `0` | Also mirror log lines to stdout/stderr, useful for container/process-manager log collection |
| `CASHFLOW_BACKUP_ALLOWED_ROOTS` | unset (`/app/backups` in Compose) | Absolute paths allowed as custom per-budget backup locations |
| `CASHFLOW_PASSWORD_PEPPER` | unset | Optional secret mixed into internal-login password hashing. Keep it stable and backed up once set, or existing password hashes become unverifiable |
| `CASHFLOW_EXTERNAL_AUTH_SECRET` | unset | Shared secret your reverse proxy sends when using trusted-header (external SSO) auth mode |

`.env.example` documents the full list, including FX/notification request
timeouts, recovery-artifact retention counts, and OAuth provider client
secrets. All of these are optional, with sane defaults.

Treat any variable ending in `_URL`, `_SECRET`, or `_PEPPER` as a deployment
secret: keep it out of source control and out of backups that shouldn't
contain credentials.

## Database Backend

SQLite is the default, and the right choice for almost everyone. A
single-user or household install, running as one process, needs no other
database, and no configuration beyond leaving `CASHFLOW_DB_BACKEND` unset.

Postgres is available as an optional backend if you want to run more than
one Cashflow replica (for example, behind a load balancer in Kubernetes), or
you'd rather Cashflow's data live in a database you already operate and back
up. To use it:

```sh
CASHFLOW_DB_BACKEND=postgres
CASHFLOW_DATABASE_URL=postgres://user:password@host:5432/dbname
CASHFLOW_RUNTIME_LOCK_BACKEND=postgres   # needed for multiple replicas
```

The database and its extensions/schema must already exist and be reachable.
Cashflow does not manage the Postgres server itself, only the tables it owns
inside the database you give it. `CASHFLOW_RUNTIME_LOCK_BACKEND=postgres`
coordinates background jobs and projection regeneration across replicas;
without it, multiple replicas still write safely but can duplicate some
scheduled work.

Moving data between the two backends is a set of dedicated commands, not
something to flip on a running install without a plan. See
[Migration](docs/migration.md) for the exact steps in both directions,
including verification. Back up first, either way.

## Runtime Data And Backups

Keep these outside published source archives and container images; they're
private, per-deployment state:

- `data/`: every budget's planning and ledger databases, plus global account
  metadata (`cashflow-global.sqlite`)
- `logs/`
- `backups/` (only used for custom app-level backup locations)
- `.env`

For Docker Compose, these map to the `cashflow-data`, `cashflow-logs`, and
`cashflow-backups` named volumes. Keep `cashflow-data` mounted persistently;
it's the only one that's required.

Back up `data/` (or the `cashflow-data` volume) before every upgrade. SQLite
runs in WAL mode; copying the `.sqlite` files without their WAL sidecar
files while the app is running can produce an inconsistent copy.
Either stop the app first, or use a backup method that reads through WAL
consistently. A stopped-app backup with Compose looks like:

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

Cashflow also has its own app-level backup feature (Settings → Backups, or
`POST /api/backup`) that runs while the app stays up; see
[Settings](docs/settings.md). It's a convenient second layer, not a
replacement for an external backup of the whole data volume.

## Exposing It Safely

Cashflow binds to `0.0.0.0` for container networking, and its default `none`
authentication mode performs no credential check: it's a single-operator
convenience mode, not a login system. Before putting Cashflow anywhere
reachable by anyone but you:

- put it behind a reverse proxy with HTTPS and real access control (Basic
  Auth, SSO forward-auth, a VPN, or a private network)
- protect the browser app and every `/api/*` route, not just the login page
- keep the app's own port private wherever possible

Cashflow also supports admin-configured internal email/password login and
trusted reverse-proxy SSO as an alternative to relying entirely on your proxy.
See [Security](docs/security.md) for the full threat model and working
reverse-proxy examples (Caddy Basic Auth, Caddy/Nginx/Traefik forward-auth,
oauth2-proxy, Authelia, Authentik).

## What It Does

- recurring income and recurring expenses, one-off transactions, savings
  goals, and flexible (priority-ordered) spending
- future → pending → confirmed transaction lifecycle, so you can see what's
  projected, what's ready to confirm, and what's already recorded
- per-period funding overview: what's funded, partially funded, or
  underfunded, and why
- multiple accounts and budgets (household, personal, demo data, ...) in one
  install
- configurable ledger currency with FX conversion (manual rates, or automatic
  via NBP or Frankfurter)
- ntfy and Discord notifications for funding shortfalls, missing income,
  goals, and daily summaries
- full JSON export/import, one-off CSV import, confirmed-ledger CSV export,
  and a loadable anonymized sample dataset
- first-run setup for currency, locale, timezone, opening balance, income,
  and how many periods ahead to project

See [Features](docs/features.md) for the full data model and transaction
lifecycle, and [Settings](docs/settings.md) for every configurable option
once it's running.

## Screenshots

![Ledger overview](docs/screenshots/ledger-overview.png)

![Budget manager](docs/screenshots/budget-manager.png)

![Settings and data portability](docs/screenshots/settings-portability.png)

## Checking A Deployment

```sh
npm run smoke
```

Before switching a deployment from `none` mode to `internal` or `external`
authentication, verify it's actually ready:

```sh
CASHFLOW_BASE_URL=https://cashflow.example.com npm run rollout:check
```

## Status

Cashflow is usable, but still early as a standalone public project. Kubernetes
manifests are initial examples, not a production guarantee. Test with copied
data first. Imports and restores create their own safety backups, but that
doesn't replace an external backup of the whole data volume before upgrades.

## License

This project is licensed under the PolyForm Noncommercial License 1.0.0. See
[LICENSE](LICENSE) for the full text.

Individuals may self-host this software for personal, private, educational,
research, charitable, or other non-commercial purposes. Commercial use
requires separate written permission from the author.

Contact for commercial licensing: andrzej@tubacki.pl

See [CONTRIBUTING.md](CONTRIBUTING.md) if you'd like to contribute changes.
