# Roadmap

Cashflow is already usable as a self-hosted personal finance planner. The next
work should improve account security, planning depth, and day-to-day usability.

## Access Control

- Built-in login and protected server-side sessions.
- Configurable admin and non-admin permissions.
- Identity-aware profile access for households and shared deployments.
- Profile rename, archive, export-before-delete, and deletion workflows.

## Self-Hosting And Recovery

- A backup browser with scheduling, restore history, and retention visibility.
- Optional off-host backup integrations and scheduled restore verification.
- Catch-up-safe scheduled jobs and configurable retry controls after downtime.
- Operational metrics and alerts for background jobs, backups, and external
  provider failures.

## Planning Accuracy

- More explicit debt, credit, and overdraft planning workflows.
- Controlled confirmed-ledger correction and reversal workflows.
- Clear partial-confirmation and remaining-balance workflows for one-off plans.
- Additional holiday-country calendars and regional scheduling rules.
- Continued improvements to ledger-currency changes and historical FX review.

## Imports, Exports, And Recovery

- Configurable bank-style CSV column mapping.
- Streaming imports for very large ledgers.
- Scheduled exports to trusted external storage.

## User Experience

- More guided planning examples after first-run setup.
- Search, filters, and scalable navigation for large confirmed ledgers.
- Better mobile workflows for confirming and reviewing transactions.
- More accessible keyboard and screen-reader interactions.
- Screenshots and examples once the interface stabilizes.


## ignore below::

generate release notes between version 0.2.0 and now


currently we have multiple budgets, not so much multiple users. make a plan to have user accounts that can have multiple budgets and invite other users to budgets they control. Allow changing the budget and user(for users only in admin) names, implement ui budget manager, add admin configureable auth with options for none (current model), external (document how to wire it up with sso, reverse proxy etc) and internal. If internal is selected, add options to configure external identity providers (google, github, fb, etc). Keep user credentials security and access control in mind. Make a plan for how to give admin perms to the 1st user on first setup and stop giving it to all users. Put it into todo.md as a coherent step-by-step plan on what to do in what order