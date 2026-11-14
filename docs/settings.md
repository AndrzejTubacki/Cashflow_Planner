# Settings

Open Settings from the account menu in the top-right header. It has three
pages: **Account** (your profile, appearance, password, linked sign-ins and
companion devices), **Budget** (the selected budget's settings below) and, for
system administrators, **Admin**.

Budget settings belong to the selected budget unless this page says otherwise.
Changing settings can regenerate projections, but confirmed ledger rows are kept
as history.

## General

| Setting | What it does |
| --- | --- |
| Language | Changes the app text and number/date formatting for this budget. |
| Timezone | Controls date-sensitive defaults, the app's idea of today, background ledger checks, and notification scheduling. |
| Ledger currency | The currency used for balances, summaries, and projections. Changing it creates a pending opening-balance conversion row instead of rewriting old history. |
| Holiday country | Default holiday calendar used when new recurring rows adjust dates around business days. Individual recurring rows can override it. |

## Display Preferences

Display preferences live under Settings → Account → Appearance. They are
saved in the current browser for the selected account, not in budget exports.

| Preference | What it does |
| --- | --- |
| Theme | Uses the system theme, dark theme, or light theme. |
| Density | Switches between comfortable spacing and a more compact layout. |
| Default landing page | Chooses the first page Cashflow opens when there is no remembered active page in the current browser session. |

## Currency And Exchange

| Setting | What it does |
| --- | --- |
| FX provider | Chooses where currency rates come from: disabled, manual, NBP, or Frankfurter. |
| Used currencies | Controls which manual-rate fields are shown and which currencies are refreshed by FX tools. |
| Manual rates | Pair rates such as `EUR/USD`. Same-currency transactions always use rate `1`. |
| FX buffer | Optional percentage added to foreign-currency expenses so projections leave room for rate movement. It is not applied when the transaction currency matches the ledger currency. |

Provider cache rates become stale when they are more than 14 days older than
the requested date. Budgets and projections remain available using the last
known rate. A warning on the Ledger page names stale pairs and their age.
Use **Refresh FX rates** in that warning to fetch current rates and reload the
budget (requires the existing `budget:maintain` capability). Cached-rate foreign
confirmations and ledger-currency conversions return `409 stale_fx_rate` until
the rate they need is refreshed. Refresh failures leave the warning visible;
manual-provider rates never expire and same-currency payments use rate `1`.

## Budget Period

| Setting | What it does |
| --- | --- |
| Budget period income | Uses a recurring income as the start of each planning period, such as payday-to-payday. Empty means calendar months. |
| Periods to generate | How many future periods the projection engine creates. More periods show farther ahead but produce more generated rows. |
| Protect minimum reserve | Keeps a configured amount unavailable for future allocations. The factual ledger balance is not changed. |
| Minimum reserve | The amount protected when reserve protection is enabled. |
| Historical payment summaries | Age in months before payments are included in derived summaries. `0` disables summaries. A safety backup is created first; individual accepted payments, source links, progress, forecasts and correction identities are always retained. This does not shrink or delete financial history. |

## Notifications

| Setting | What it does |
| --- | --- |
| Notification channels | Enables ntfy, Discord, or both. Older single-service settings remain supported. |
| Full ntfy URL | Complete ntfy topic URL. Used when ntfy is enabled. Do not put an access token in this URL; use the ntfy access token field instead. |
| ntfy access token | Optional access token for a protected ntfy topic, sent as an `Authorization: Bearer` header. Treat it like a secret. Leave blank for a public topic. |
| Discord webhook URL | Complete Discord webhook URL. Used when Discord is enabled. Treat it like a secret. |
| Ledger check and notification time | The local time when Cashflow moves due future rows to pending, queues daily notification summaries, and sends queued notifications. |
| Repeat necessary-underfunded every X days | Controls how often the same necessary-underfunded warning can be queued again. |
| Notification type toggles | Enable or disable individual warning categories. |
| ntfy priority | Priority sent to ntfy for each notification type. Discord ignores ntfy priorities. |

## Backups

Budget owners manage app-level backups in the React UI at **Settings → Budget →
Backups**. The legacy UI has no backup controls. Settings use the budget settings
**Save** button; validation errors appear above the settings form. Managers,
editors, viewers, and system administrators without owner membership do not gain
backup access. Controls follow the session's `budget:settings`, `budget:backup`,
and `budget:restore` capabilities independently.

| Setting | What it does |
| --- | --- |
| Automatic backups | Enables the background scheduler's per-budget backups on either backend. |
| Backup interval | Minimum time between successful backups, entered in minutes, hours, or days and stored as whole minutes (minimum 1). Scheduler checks determine the actual execution time. |
| Backup retention | Positive count of successful backups retained on SQLite and PostgreSQL, subject to the administrator’s instance count cap and age limit. |
| Backup location | SQLite only: optional absolute server path under `CASHFLOW_BACKUP_ALLOWED_ROOTS`. Blank uses the default per-budget backup directory. Hidden and omitted from saves for PostgreSQL, whose snapshots are stored in the database. |

Pruning runs after every successful manual, automatic, and safety backup and in
background retention maintenance. The newest successful backup is always kept,
even past the age limit. Backups used by a running restore/import remain protected;
this can temporarily exceed the count limit. Only recognized Cashflow artifacts
are eligible. PostgreSQL deletes snapshot bytes and their metadata transactionally.
SQLite leaves unrelated folders, symlinks, and unregistered files untouched. Owner
settings show when an administrator's cap or age limit reduces retention.

**Back up now** calls `POST /api/backup`. **Refresh backups** reloads
`GET /api/backups`, listing successful backup metadata newest first with local
budget date/time, ID, and byte size. The list does not verify artifact existence;
an externally removed SQLite folder can still have a metadata entry and will
fail restore. Routine SQLite cleanup removes metadata for missing folders.

**Restore backup** requires explicit confirmation. Both backends validate the
selected backup, take a safety backup of the current budget, and replace that
budget's settings, planning data, and ledger in a transaction, then rebuild
balances and projections. The UI refreshes its snapshot and settings afterward.
Accounts, budget memberships, and instance-wide authentication are not replaced.
A failed restore is reported in the app; the owning transaction rolls back.

SQLite creates validated `planning.sqlite` copies in server folders; PostgreSQL
stores validated logical snapshots as database artifacts (`postgres-backup:`
references internally). Neither is an independent off-site backup: keep external
backups of the data volume or PostgreSQL database as appropriate.

## Data Portability

| Control | What it does |
| --- | --- |
| Download full export | Downloads a JSON export of functional budget data. Operational settings are excluded unless explicitly included. |
| Import full export | Shows a preview of row counts, settings changes, and merge conflicts, then restores or merges a Cashflow JSON export after validation and a safety backup. |
| Import one-off CSV | Imports one-off transactions from strict columns: `name,type,amount,currency,date`. |
| Download confirmed ledger CSV | Downloads confirmed ledger rows for review or external analysis. |
| Sample dataset | Downloads or loads fictitious demo data. Loading the sample replaces the current budget after a safety backup. |

## Companion Devices

Manage paired devices and their per-budget read/write grants under Settings →
Account. Pairing requires explicit approval. Revoke a device when it should no
longer access the server. The companion Android app is not public yet.

Settings → Admin → Global options control token lifetimes: access credentials default to
15 minutes, renewal inactivity to 90 days, and absolute device lifetime to
365 days. These settings are independent of browser session lifetimes and are
not included in financial budget exports.


## Administrator global backup limits

System administrators set these instance-wide policies under **Settings → Admin →
Global options**. They apply to existing and new budgets on both database backends,
and are separate from new-budget planner defaults.

| Option | Meaning |
| --- | --- |
| `backup_max_retention_count` | Optional per-budget cap. Empty or `0` means no cap. Effective retention is the smaller of the owner's positive `backup_retention_count` and this cap. |
| `backup_max_age_days` | Optional maximum age in whole days. Empty or `0` means no age limit. Older successful backups are pruned, with the newest and backups in use always preserved. |

Both accept non-negative integers up to 2147483647. Changes take effect at the next
successful backup or background retention run. Global metadata export/import and
SQLite↔PostgreSQL migration preserve these options; financial budget exports do not
include instance policy. These limits do not control operator database migration
recovery schemas or external disaster-recovery backups.
