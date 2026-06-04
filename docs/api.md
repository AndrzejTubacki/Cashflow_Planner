# API

Cashflow exposes a JSON HTTP API under `/api/`. The machine-readable published
contract is [OpenAPI 3.1](openapi.yaml).

## Trust Model

Cashflow does not currently authenticate API callers. The
`x-cashflow-user-id` header selects a planner profile; it is not a credential
and does not prove that the caller owns that profile.

User-scoped requests normally select a profile with:

```http
x-cashflow-user-id: household
```

Profile IDs use 1-64 letters, numbers, underscores, or hyphens and cannot start
with an underscore. Omitting the header targets the built-in `local` profile;
`local` must first be initialized through `POST /api/session/select`. Unknown
profiles return `404` and are not created by reads.

Admin-gated routes check whether the selected profile session contains the
`admin` permission. Every profile receives that permission by default today,
so this is an auth-ready boundary rather than real access control.

## Route Classes

Every OpenAPI operation includes:

- `x-cashflow-scope`: `global-unscoped`, `user-scoped`,
  `admin-user-scoped`, or `admin-global`
- `x-cashflow-mutating`: whether the request changes application state
- `x-cashflow-download-only`: whether a successful response is a downloaded
  file rather than an ordinary API response

Global profile-selection routes include `/api/users`, `/api/session/select`,
and `/api/logout`. User-scoped routes operate only on the selected profile.
Admin-global routes use the selected profile's permission to manage global
defaults or all-user maintenance.

## Common Status Codes

| Status | Meaning |
| --- | --- |
| `200` | Request completed |
| `400` | Invalid user ID, currency, date, import, or request data |
| `403` | Selected profile lacks admin permission |
| `404` | Profile, planning row, pending row, or usable backup was not found |
| `409` | User already exists or merge import has ID conflicts |
| `504` | External FX or notification request timed out |
| `500` | Unexpected server failure, including a failed recovery rollback |

API errors use:

```json
{
  "error": "Human-readable message",
  "details": [],
  "conflicts": []
}
```

`details` and `conflicts` appear only when relevant. Error messages may be
localized using the selected profile's saved locale.

`PUT /api/settings` and replace-mode full imports strictly validate supplied
settings. Invalid values return `400` with field-level `details` before any
settings write or import safety backup is created. Merge imports do not import
profile settings.

## Planning And Ledger Integrity

Normal planning create routes generate entity IDs on the server. Supplying an
`id` to recurring expense/income, goal, flex, or one-off create routes returns
`400`. Full import, restore, and migration flows preserve stored IDs.

Deleting a recurring income or expense removes its planning source and generated
pending/future rows while preserving confirmed ledger history and its historical
source ID. Confirmed one-off deletion uncouples its ledger rows and uses a full
profile safety backup so a failure cannot leave planning and ledger databases
out of sync. Confirming a pending row uses the same rollback protection.

Changing ledger currency creates a pending opening-balance conversion. A second
currency change returns `409` until that conversion is confirmed or deliberately
cleared.

Pair-rate routes follow the selected profile's FX provider. Manual mode resolves
direct, inverse, legacy PLN, and PLN-derived rates. Disabled mode returns `400`
for differing currencies. Same-currency requests always return rate `1`.

## Data Portability

`GET /api/export/full` excludes operational settings by default. Add
`?includeOperationalSettings=1` only when moving trusted deployment settings.

`POST /api/import/full` accepts `replace` or `merge`. Both modes create a
safety backup and roll back later failures. A default replace import changes
functional planner settings but preserves the target profile's current backup
and notification settings. Set `includeOperationalSettings` only to
intentionally replace those deployment settings. Sample loading uses the same
preserve-current behavior.

Full imports validate every planning and confirmed-ledger row before creating a
safety backup. Unknown fields, invalid IDs and values, broken source
relationships, ledger-year mismatches, and duplicate occurrence keys return
`400`. Row validation details identify the table, row number, ID, field, and
reason without echoing imported values:

```json
{
  "error": "Full import contains invalid rows",
  "details": [
    {
      "table": "one_off_transactions",
      "row": 1,
      "id": "example-id",
      "field": "date",
      "reason": "invalid_date"
    }
  ]
}
```

Merge conflicts with existing IDs, FX keys, or occurrence keys return `409`.
If an import or restore fails and its safety-backup rollback also fails, the
response is `500` with structured recovery details:

```json
{
  "error": "Import failed and rollback also failed",
  "details": {
    "phase": "rollback_failed",
    "safetyBackup": "/path/to/backup",
    "originalError": "original failure",
    "originalStatus": 500,
    "rollbackError": "rollback failure"
  }
}
```

`POST /api/restore/:backupId` returns `404` when its metadata or folder is
missing. An existing but corrupt backup returns `400` before a restore safety
backup is created.

`POST /api/import/one-offs-csv` accepts strict CSV text with exactly:

```text
name,type,amount,currency,date
```

## Optional Private Routes

Deployments may provide ignored local control code at `local/dev.mjs`. The
current private deployment uses:

- `POST /api/restart`
- `POST /api/local/tests/run`
- `GET /api/local/tests/latest`

These routes are intentionally excluded from `openapi.yaml` because they are
not part of published builds. When `local/dev.mjs` exists, the server loads it
and the deployment operator is responsible for securing every route it
registers through trusted-network access, a reverse proxy, or controls inside
the local module. These routes can restart the process or execute tests. Do not
assume they exist on another Cashflow installation.
