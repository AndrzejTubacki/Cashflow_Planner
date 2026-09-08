> [!CAUTION]
> Cashflow's default `none` mode is not access control. Public exposure needs
> internal login or an external access-control layer such as a VPN, private
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
- [Kubernetes examples](deploy/kubernetes/README.md)
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
- accounts and budgets for different household or demo datasets
- user-selection shell with sessions, budget permissions, and optional internal
  login or trusted reverse-proxy SSO
- first-run setup for currency, locale, timezone, non-negative opening balance,
  income, and projection horizon
- admin defaults for newly created budgets
- data portability tools for full JSON export/import, one-off CSV import,
  confirmed-ledger CSV export, and sample data
- Docker and Docker Compose support
- initial Kubernetes example manifests
- backup and restore support for self-hosted installs

See [Features](docs/features.md) for the full workflow and data model.

## Screenshots

![Ledger overview](docs/screenshots/ledger-overview.png)

![Budget manager](docs/screenshots/budget-manager.png)

![Settings and data portability](docs/screenshots/settings-portability.png)

## Status

Cashflow is usable, but still early as a standalone public app.

Current release constraints:

- `none` mode access control must come from your deployment, such as a VPN or
  reverse proxy.
- Internal email/password login is available after an administrator configures
  at least one system-admin credential.
- Trusted reverse-proxy SSO and internal-mode provider login are available after
  admin setup and explicit identity linking.
- Imports and restores create safety backups, but external volume backups remain
  necessary before upgrades.

## Release Notes

- Kubernetes manifests are provided as initial examples.
- They are not a guarantee of production readiness.
- Users should test with copied data first.

## Check An Install

```sh
npm run smoke
```

The rollout check verifies a deployment before changing it from `none` mode to
`internal` or `external` authentication:

```sh
CASHFLOW_BASE_URL=https://cashflow.example.com npm run rollout:check
```

See [Operations](docs/operations.md) for backup, upgrade, and health-check
details.

## License

This project is licensed under the PolyForm Noncommercial License 1.0.0.

Individuals may self-host this software for personal, private, educational,
research, charitable, or other non-commercial purposes.

Commercial use requires separate written permission from the author.

Contact for commercial licensing: andrzej@tubacki.pl
