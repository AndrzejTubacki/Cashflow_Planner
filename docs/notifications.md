# Notifications

Cashflow can publish planner notifications through either an
[ntfy](https://docs.ntfy.sh/) topic or a Discord webhook. Notifications are
configured per profile in Settings.

## Delivery Service

Choose the notification service in Settings:

- `ntfy` sends plain notification messages to the configured ntfy topic URL.
- `Discord` sends queued messages to the configured Discord webhook URL.

Only the selected service is used. If the selected service has no URL, queued
notifications remain unsent until the URL is added or the service is changed.

## ntfy URL

Enter the complete HTTP or HTTPS topic URL, including the topic name:

```text
https://ntfy.sh/my-private-cashflow-topic
https://ntfy.example.com/cashflow-household
```

Do not put an ntfy access token in this URL (for example
`https://:tk_xxx@ntfy.example.com/topic`). Node's `fetch` refuses to send a
request whose URL has embedded credentials, so a token embedded that way
never delivers. Use the separate **ntfy access token** field for a protected
topic instead; Cashflow sends it as an `Authorization: Bearer` header. A URL
saved before this field existed is migrated automatically: the token moves
into the new field and the URL is cleaned up the next time the profile's
database is opened.

## ntfy Access Token

Optional. Set this only when the ntfy topic requires authentication. Treat it
like a secret: anyone with it can publish to the topic. Leave it blank for a
public topic.

## Discord Webhook URL

Enter the complete Discord webhook URL. Discord webhook URLs are secrets because
anyone with the URL can post to that channel. Store them only in Settings or in
private deployment data, not in source control.


## Notification Types

Each type can be enabled independently. The priority fields are used by ntfy.
Discord webhooks receive the title and message text.

- goal impossible
- necessary transaction underfunded
- funding shortfall
- missing recurring income
- daily pending summary
- goal funded
- projection changed after an FX refresh

Available priorities are `min`, `low`, `default`, `high`, and `urgent`.

## Scheduling And Delivery

Projection work queues goal, funding, and FX-related notifications when those
conditions are detected.

The profile's configured Ledger check and notification time controls both
daily ledger roll-forward and queued notification delivery. At that time,
Cashflow moves due future rows into pending, queues the pending summary and
missing-income notifications, then sends queued notifications. Background jobs
check once per minute, so delivery can occur shortly after the configured
minute during startup or system load.

Notifications use deduplication keys so the same condition is not repeatedly
queued for the same date or repeat interval. Necessary-underfunded
notifications use the configured repeat-day interval.

## Failures And Retries

The default notification request timeout is five seconds. The timeout is
configured with `CASHFLOW_NOTIFICATION_FETCH_TIMEOUT_MS`.

Cashflow sends queued notifications in order. A timeout or non-success response
from the selected service stops that profile's delivery attempt. Failed rows
remain unsent and are attempted again at a later scheduled delivery time; there
is no separate rapid retry loop. A failure for one profile does not stop
background work for later profiles.

Review `logs/error.log` for `cashflow_background_user_failed` and related
delivery errors when notifications do not arrive.
