# API

Cashflow exposes a JSON HTTP API under `/api/`. The machine-readable published
contract is [OpenAPI 3.1](openapi.yaml).

## Trust Model

Cashflow supports multiple authentication modes. In the active `none` mode,
requests run through compatibility account selection without a credential. In
active `internal` mode, callers must log in with an account email and password
before selecting a budget. The account can access only budgets where it has a
membership; its separate `system_admin` role does not grant access to financial
data.

Budget-scoped requests normally select a budget with:

```http
x-cashflow-budget-id: household
```

Budget IDs use 1-64 letters, numbers, underscores, or hyphens and cannot start
with an underscore. A budget ID resolves to an immutable storage key; changing
the budget display name never changes its ID or storage directory. Omitting the
header targets the built-in `local` compatibility budget. Unknown budgets
return `404` and are not created by reads.

For one compatibility release, `x-cashflow-user-id` is accepted as a deprecated
budget selector in `none` mode. It is never treated as account identity.
Responses to requests using it include deprecation headers. When authentication
mode is `internal`, budget-scoped routes require a valid session cookie and CSRF
token for mutations; legacy headers alone are rejected.

Routes authorize the resolved request context before opening budget storage.
The context includes the actor account, authentication mode, selected budget,
membership role, global roles, and capabilities. Because `none` mode has no
credential check, it is an authorization/organization model but not secure
multi-user authentication.

## Route Classes

Every OpenAPI operation includes:

- `x-cashflow-scope`: `global-unscoped`, `user-scoped`,
  `admin-user-scoped`, or `admin-global`
- `x-cashflow-mutating`: whether the request changes application state
- `x-cashflow-download-only`: whether a successful response is a downloaded
  file rather than an ordinary API response

Global compatibility-selection routes include `/api/users`,
`/api/session/select`, and `/api/logout`. They are public only in `none` mode.
Budget-scoped routes operate only on the selected authorized budget.
Admin-global routes require the separate `system_admin` capability.

`/healthz` is process-only liveness. `/readyz` is a generic readiness endpoint:
it verifies app initialization, writable data storage, and readable global
metadata without scanning budgets or calling external services.

Admin account-management routes live under `/api/admin/accounts`. They let a
system administrator list accounts, rename display names, enable or disable an
account, grant or revoke `system_admin`, revoke active sessions, and mark an
account deleted after budget ownership and memberships have been cleared. They
never expose session token hashes, CSRF hashes, password hashes, or provider
secrets.

Authentication configuration routes live under `/api/admin/auth`. They expose
the active mode, staged draft mode, session timeout settings, and provider
metadata that is safe to store in the global database. `internal` mode can be
activated after at least one active system administrator has an email/password
credential or an explicit identity link to an enabled internal-mode provider.
`external` mode can be activated after a shared assertion secret environment
variable is configured and at least one active system administrator has an
explicit external identity link. Inline secrets are rejected.

Internal password routes are:

- `GET /api/auth/config`: public, safe auth-mode summary for the login shell.
- `POST /api/admin/accounts/:accountId/password-reset-token`: system-admin
  route that returns a one-time setup/reset token. Only the hash is stored.
- `POST /api/auth/internal/password`: consumes a setup/reset token and stores
  an Argon2id password hash.
- `POST /api/auth/internal/login`: validates email/password, creates an opaque
  server-side session, returns a CSRF token, and then budget selection proceeds
  through `/api/budgets`.
- `POST /api/auth/internal/register`: consumes an email-targeted budget
  invitation, creates the account, stores an Argon2id password hash, accepts the
  invitation, and starts a session in that budget.
- `PUT /api/admin/accounts/:accountId/provider-identities/:providerId`:
  system-admin route that explicitly links a provider subject to an account.
- `POST /api/auth/providers/:providerId/login/start`: starts an internal-mode
  provider login and returns the authorization URL.
- `POST /api/auth/providers/:providerId/link/start`: starts an explicit
  provider-link flow for the signed-in account.
- `GET /api/auth/providers/:providerId/callback`: consumes provider callback
  state, completes the Authorization Code flow, and issues a normal session
  when the provider subject is linked to an active account.
- `POST /api/admin/accounts/:accountId/external-identity`: system-admin route
  that links a stable external subject to an account for the staged external
  provider.
- `POST /api/auth/external/login`: validates the configured shared assertion
  secret header and stable subject header from a trusted reverse proxy, then
  creates a server-side session. Unknown identities are denied by default;
  configured `allow_invited` mode can create an account from a matching
  email-targeted budget invitation, while `allow_any` can create an account
  without a starting budget.

## Common Status Codes

| Status | Meaning |
| --- | --- |
| `200` | Request completed |
| `400` | Invalid user ID, currency, date, import, or request data |
| `403` | Actor lacks the required global or budget capability |
| `404` | Budget, planning row, pending row, or usable backup was not found |
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

Cashflow stores money amounts rounded to two decimal places. Normal mutation
routes accept JSON numbers or decimal strings using either `.` or `,` as the
decimal separator. Imports and database migrations also normalize stored money
columns to cents; FX rates keep their original precision.

Normal planning create routes generate entity IDs on the server. Supplying an
`id` to recurring expense/income, goal, flex, or one-off create routes returns
`400`. Full import, restore, and migration flows preserve stored IDs.

Deleting a recurring income or expense removes its planning source and generated
pending/future rows while preserving confirmed ledger history and its historical
source ID. Confirmed one-off deletion uncouples its ledger rows and uses a full
profile safety backup so a failure cannot leave planning and ledger databases
out of sync. Confirming a pending row uses the same rollback protection. A
generated one-off remainder can be dismissed explicitly; that lowers the source
one-off target to the already confirmed total so projection regeneration does not
recreate the remainder.

Purging an archived budget first writes a deleted-budget recovery export under
`DATA_DIR/deleted-budget-recoveries`. That file is a normal full JSON export for
the budget's planner data and can be imported into another budget with replace
mode. Operational/private settings are omitted, and account memberships,
sessions, invitations, credentials, and global roles are not part of the export.

Changing ledger currency creates a pending opening-balance conversion. A second
currency change returns `409` until that conversion is confirmed or deliberately
cleared.

Pair-rate routes follow the selected profile's FX provider. Manual mode resolves
direct, inverse, legacy PLN, and PLN-derived rates. Disabled mode returns `400`
for differing currencies. Same-currency requests always return rate `1`.

`GET /api/ledger/confirmed` is the pagination/filter contract for confirmed
ledger history. It returns `{ rows, total, limit, offset, filters }` and supports
year, type, currency, ledger currency, date range, and source filters. The
legacy `/api` snapshot still includes confirmed rows for compatibility in this
release.

## Data Portability

`GET /api/export/full` excludes operational settings by default.
`?includeOperationalSettings=1` is available for trusted moves that also need
deployment settings.

`POST /api/import/full` accepts `replace` or `merge`. Both modes create a
safety backup and roll back later failures. A default replace import changes
functional planner settings but preserves the target profile's current backup
and notification settings. `includeOperationalSettings` intentionally replaces
those deployment settings. Sample loading uses the same preserve-current
behavior.

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
published application does not include those routes. Common local hooks are:

- `POST /api/restart`
- `POST /api/local/tests/run`
- `GET /api/local/tests/latest`

These routes are intentionally excluded from `openapi.yaml` because they are
not part of published builds. When `local/dev.mjs` exists, the server loads it.
The deployment operator owns security for every route registered by that local
module, typically through trusted-network access, a reverse proxy, or controls
inside the module. These routes can restart the process or execute tests, and
they are not portable API guarantees for other Cashflow installations.
