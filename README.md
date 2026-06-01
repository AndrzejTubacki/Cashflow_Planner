> [!CAUTION]
> Cashflow does not include built-in authentication, registration, sessions,
> CSRF protection, or role-based access control. Do not expose it directly to
> the public internet without reverse-proxy authentication, VPN/private network
> access, SSO, or another access-control layer. HTTPS alone is not auth.

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

- SQLite-backed personal finance planning
- recurring income and recurring expenses
- one-off transactions, goals, and flexible spending plans
- future, pending, and confirmed transaction states
- projection snapshots and per-period funding overview
- configurable ledger currency with FX conversion
- configurable app timezone for date-sensitive planning and scheduled jobs
- Docker and Docker Compose support
- backup and restore APIs for SQLite runtime data

See [Features](docs/features.md) for the full workflow and data model.

## Status

Cashflow is usable, but still early as a standalone public app.

Install-decision constraints:

- FX behavior is still coupled to the existing cache/provider flow.
- Auth is deployment-level, not app-native.
- First-run onboarding is minimal.
- Multi-user storage exists through `x-cashflow-user-id`, but there is no
  authentication, authorization, or user-management UI.

## Verification

```sh
npm test
npm run smoke
```

See [Operations](docs/operations.md) for backup, upgrade, API, and verification
details.

## License

This project is licensed under the PolyForm Noncommercial License 1.0.0.

Individuals may self-host this software for personal, private, educational,
research, charitable, or other non-commercial purposes.

Commercial use requires separate written permission from the author.

Contact for commercial licensing: andrzej@tubacki.pl
