# Roadmap

Cashflow is already usable as a self-hosted personal finance planner. The next
areas are ordered by expected release value: security and recovery first,
planning accuracy next, then import depth and interface polish.

## 1. Access Control

- MFA with recovery codes and administrator-assisted recovery.
- Revocable scoped API credentials for integrations.
- A follow-up compatibility-removal release for deprecated profile headers and
  old selector aliases.
- More explicit emergency budget-access workflow for system administrators,
  including time limits and audit review.

## 2. Self-Hosting And Recovery

- A backup browser with scheduling, restore history, and retention visibility.
- Optional off-host backup integrations and scheduled restore verification.
- Catch-up-safe scheduled jobs and configurable retry controls after downtime.
- Operational metrics and alerts for background jobs, backups, and external
  provider failures.

## 3. Planning Accuracy

- More explicit debt, credit, and overdraft planning workflows.
- Controlled confirmed-ledger correction and reversal workflows.
- Clear partial-confirmation and remaining-balance workflows for one-off plans.
- Additional holiday-country calendars and regional scheduling rules.
- Continued improvements to ledger-currency changes and historical FX review.

## 4. Imports, Exports, And Recovery

- Configurable bank-style CSV column mapping.
- Streaming imports for very large ledgers.
- Scheduled exports to trusted external storage.

## 5. User Experience

- More guided planning examples after first-run setup.
- Search, filters, and scalable navigation for large confirmed ledgers.
- Better mobile workflows for confirming and reviewing transactions.
- More accessible keyboard and screen-reader interactions.
- Screenshots and examples once the interface stabilizes.
