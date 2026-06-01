# Roadmap

## Near Term

- Add a first-run setup flow for currency, locale, opening balance, income, and
  projection horizon.
- Make empty-database onboarding understandable for new users.
- Add import/export for full JSON backups and ledger CSV exports.
- Add migration safety checks and pre-migration backups.
- Add minimum reserve / safety buffer logic.
- Improve README with screenshots once the public UI settles.

## Generalization

- Document notification integrations and deployment expectations.
- Separate product concepts from private deployment terminology.

## Deployment

- Add a production-ready compose example with named volumes and healthcheck.
- Add upgrade guide details for versioned releases.
- Expand the backup/restore guide with SQLite-safe operational examples.
- Document reverse-proxy auth patterns.
- Add optional app-native auth after the standalone app stabilizes.

## Testing

- Expand browser tests beyond smoke-level tab rendering into full workflows.

## Data Portability

- Full export/import.
- CSV import for one-off transactions.
- CSV export for confirmed ledger rows.
- An anonymized sample dataset for demos and screenshots.
