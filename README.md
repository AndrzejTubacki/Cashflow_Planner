> [!CAUTION]
> Cashflow does not include built-in login or real access control yet. Do not
> expose it directly to the public internet. Put it behind a VPN, private
> network, SSO, or reverse-proxy authentication. HTTPS alone is not access
> control.

# Cashflow

Cashflow is a standalone personal finance planner for projecting income,
recurring expenses, one-off spending, savings goals, flexible transactions, and
ledger confirmations.

Most budgeting tools explain what happened after the fact. Cashflow is built to
plan ahead: project income, reserve money for obligations, prioritize goals and
flexible spending, and show what can safely be funded before money is spent.

## Documentation

- [Features](docs/features.md)
- [Installation](docs/installation.md)
- [Operations](docs/operations.md)
- [Security](docs/security.md)
- [API](docs/api.md)
- [Notifications](docs/notifications.md)
- [Roadmap](docs/roadmap.md)

## Quick Start

```sh
npm ci
npm start
```

Open `http://localhost:3000`.

## Docker

```sh
docker compose -f docker-compose.example.yml up -d --build
```

For direct Docker usage:

```sh
docker build -t cashflow .
docker run --rm \
  -p 3000:3000 \
  -v cashflow-data:/app/data \
  -v cashflow-logs:/app/logs \
  cashflow
```

See [Installation](docs/installation.md) for configuration, runtime data, and
deployment notes.

## Features At A Glance

- local personal finance planning
- recurring income and recurring expenses
- one-off transactions, goals, and flexible spending plans
- future, pending, and confirmed transaction states
- period funding overview
- configurable ledger currency with FX conversion
- configurable app timezone for date-sensitive planning and scheduled jobs
- separate user profiles for different household or demo datasets
- user-selection shell with auth-ready session and permission boundaries
- first-run setup for currency, locale, timezone, opening balance, income, and
  projection horizon
- admin defaults for newly created profiles
- data portability tools for full JSON export/import, one-off CSV import,
  confirmed-ledger CSV export, and sample data
- Docker and Docker Compose support
- backup and restore support for self-hosted installs

See [Features](docs/features.md) for the full workflow and data model.

## Status

Cashflow is usable, but still early as a standalone public app.

Install-decision constraints:

- Access control must come from your deployment, such as a VPN or reverse proxy.
- The user-selection screen separates planner datasets, not secure accounts.
- Session and permission responses are auth-ready UI boundaries, not
  authenticated server-side sessions.
- Every newly created profile currently receives admin permission by default.
- Imports and restores create safety backups, but external volume backups remain
  necessary before upgrades.

## Check An Install

```sh
npm run smoke
```

See [Operations](docs/operations.md) for backup, upgrade, and health-check
details.

## License

This project is licensed under the PolyForm Noncommercial License 1.0.0.

Individuals may self-host this software for personal, private, educational,
research, charitable, or other non-commercial purposes.

Commercial use requires separate written permission from the author.

Contact for commercial licensing: andrzej@tubacki.pl
