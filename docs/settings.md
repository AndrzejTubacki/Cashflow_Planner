# Settings

Settings belong to the selected budget/profile unless this page says otherwise.
Changing settings can regenerate projections, but confirmed ledger rows are kept
as history.

## General

| Setting | What it does |
| --- | --- |
| Language | Changes the app text shown in the browser. It lives in the user menu with the display preferences. |
| Timezone | Controls date-sensitive defaults, the app's idea of today, background ledger checks, and notification scheduling. |
| Ledger currency | The currency used for balances, summaries, and projections. Changing it creates a pending opening-balance conversion row instead of rewriting old history. |
| Holiday country | Default holiday calendar used when new recurring rows adjust dates around business days. Individual recurring rows can override it. |

## Display Preferences

Display preferences live in the user menu in the top-right header. They are
saved in the current browser for the selected account, not in budget exports.

| Preference | What it does |
| --- | --- |
| Theme | Uses the system theme, dark theme, or light theme. |
| Density | Switches between comfortable spacing and a more compact layout. |
| Default landing tab | Chooses the first tab Cashflow opens when there is no remembered active tab in the current browser session. |

## Currency And Exchange

| Setting | What it does |
| --- | --- |
| FX provider | Chooses where currency rates come from: disabled, manual, NBP, or Frankfurter. |
| Used currencies | Controls which manual-rate fields are shown and which currencies are refreshed by FX tools. |
| Manual rates | Pair rates such as `EUR/USD`. Same-currency transactions always use rate `1`. |
| FX buffer | Optional percentage added to foreign-currency expenses so projections leave room for rate movement. It is not applied when the transaction currency matches the ledger currency. |

## Budget Period

| Setting | What it does |
| --- | --- |
| Budget period income | Uses a recurring income as the start of each planning period, such as payday-to-payday. Empty means calendar months. |
| Periods to generate | How many future periods the projection engine creates. More periods show farther ahead but produce more generated rows. |
| Protect minimum reserve | Keeps a configured amount unavailable for future allocations. The factual ledger balance is not changed. |
| Minimum reserve | The amount protected when reserve protection is enabled. |
| Ledger history compaction | Number of months of detailed confirmed ledger history to keep. `0` keeps all details forever. When enabled, old confirmed rows are replaced by one source-less balance row per ledger currency after a safety backup. |

## Notifications

| Setting | What it does |
| --- | --- |
| Notification service | Chooses the delivery sink: ntfy or Discord. |
| Full ntfy URL | Complete ntfy topic URL. Used only when notification service is ntfy. Do not put an access token in this URL; use the ntfy access token field instead. |
| ntfy access token | Optional access token for a protected ntfy topic, sent as an `Authorization: Bearer` header. Treat it like a secret. Leave blank for a public topic. |
| Discord webhook URL | Complete Discord webhook URL. Used only when notification service is Discord. Treat it like a secret. |
| Ledger check and notification time | The local time when Cashflow moves due future rows to pending, queues daily notification summaries, and sends queued notifications. |
| Repeat necessary-underfunded every X days | Controls how often the same necessary-underfunded warning can be queued again. |
| Notification type toggles | Enable or disable individual warning categories. |
| ntfy priority | Priority sent to ntfy for each notification type. Discord ignores ntfy priorities. |

## Backups

| Setting | What it does |
| --- | --- |
| Automatic backups | Enables app-level per-budget backups. This is useful for bare metal, Docker, and Compose installs. |
| Backup interval | Minimum time between automatic backups. |
| Backup retention | Number of successful app-level backup folders retained for the budget. |
| Backup location | Optional custom absolute backup path. It must be under an allowed root configured by the operator. |

## Data Portability

| Control | What it does |
| --- | --- |
| Download full export | Downloads a JSON export of functional budget data. Operational settings are excluded unless explicitly included. |
| Import full export | Restores or merges a Cashflow JSON export after validation and a safety backup. |
| Import one-off CSV | Imports one-off transactions from strict columns: `name,type,amount,currency,date`. |
| Download confirmed ledger CSV | Downloads confirmed ledger rows for review or external analysis. |
| Sample dataset | Downloads or loads fictitious demo data. Loading the sample replaces the current budget after a safety backup. |
