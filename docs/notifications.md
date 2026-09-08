# Notifications

Cashflow can publish planner notifications to an
[ntfy](https://docs.ntfy.sh/) topic. Notifications are configured per profile
in Settings.

## ntfy URL

Enter the complete HTTP or HTTPS topic URL, including the topic name:

```text
https://ntfy.sh/my-private-cashflow-topic
https://ntfy.example.com/cashflow-household
```


## Notification Types

Each type can be enabled independently and assigned an ntfy priority:

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
conditions are detected. At profile midnight, Cashflow queues the pending
summary and missing-income notifications.

Queued notifications are sent at the profile's configured Delivery time using
that profile's timezone. Background jobs check once per minute, so delivery can
occur shortly after the configured minute during startup or system load.

Notifications use deduplication keys so the same condition is not repeatedly
queued for the same date or repeat interval. Necessary-underfunded
notifications use the configured repeat-day interval.

## Failures And Retries

The default ntfy request timeout is five seconds. The timeout is configured with
`CASHFLOW_NOTIFICATION_FETCH_TIMEOUT_MS`.

Cashflow sends queued notifications in order. A timeout or non-success ntfy
response stops that profile's delivery attempt. Failed rows remain unsent and
are attempted again at a later scheduled delivery time; there is no separate
rapid retry loop. A failure for one profile does not stop background work for
later profiles.

Review `logs/error.log` for `cashflow_background_user_failed` and related
delivery errors when notifications do not arrive.
