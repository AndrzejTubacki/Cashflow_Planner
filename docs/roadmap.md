# Roadmap

Cashflow is already usable as a self-hosted personal finance planner. The next
work should make it safer to run, easier to trust, and clearer for new users.

## Safer Self-Hosting

- Clearer backup, restore, upgrade, and rollback instructions.
- Better production Docker Compose guidance, including persistent volumes,
  health checks, and reverse-proxy examples.
- More explicit guidance for notifications, scheduled jobs, and deployed smoke
  checks.
- Safer handling of backup locations and private deployment settings.

## Access Control

- Real login support.
- Real admin and non-admin permissions.
- Better protection for profile selection when Cashflow is used by more than one
  person.
- Clear documentation for reverse-proxy auth, VPN, and SSO deployments.

## Planning Accuracy

- Minimum reserve or safety-buffer planning.
- Clearer handling for negative balances and debt-like situations.
- Continued improvements to ledger-currency changes and FX workflows.
- Better timezone and holiday-country defaults for international users.
- Clear rules for editing or adjusting items after they have confirmed ledger
  history.

## Imports, Exports, And Recovery

- Clearer import errors and conflict reporting.
- Better compatibility for older export files.
- Safer merge imports for larger ledgers.
- Cleaner separation between planner data and private deployment settings in
  full exports.
- More documented recovery drills for import, restore, and sample-data workflows.

## User Experience

- More guided onboarding for first-time users.
- Clearer in-app error messages instead of browser alerts.
- Better browser behavior for dates in the configured app timezone.
- Screenshots and examples once the interface stabilizes.
