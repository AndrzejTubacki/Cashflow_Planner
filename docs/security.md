# Security

Cashflow is usable for self-hosted personal planning. Its `none`
authentication mode is not a secure multi-user login boundary; internal
email/password login can be enabled after an administrator creates a password
credential for at least one system administrator.

The global database now separates accounts, budgets, memberships, global roles,
and budget capabilities. Server routes authorize memberships before opening
budget storage, and a system administrator does not automatically gain access
to financial data. However, `none` mode lets visitors select a real
account without checking credentials. Public exposure in `none` mode is unsafe
without reverse-proxy authentication, VPN, private network access, SSO, or
another access-control layer. HTTPS alone is not access control.

## Current Security Stance

- `none` mode has no credential check and remains compatibility mode
- `internal` mode supports email/password login after admin setup
- opaque, revocable server-side sessions with session-bound CSRF protection
- `none`-mode sessions describe the selected account and budget but do not
  prove who the caller is because account selection requires no credential
- global `system_admin` and budget capabilities are separate
- budget membership is enforced before financial storage is opened
- cookie-session state changes require a session-bound CSRF token
- staged Admin authentication configuration exists; `internal` can activate
  after a usable admin password credential exists, and `external` can activate
  after a shared assertion secret and explicit admin identity link exist
- intended to sit behind trusted network access or reverse-proxy auth

The `x-cashflow-budget-id` request header selects a requested budget and is
authorized against the current actor. It is not proof of identity.
`x-cashflow-user-id` remains a deprecated `none`-mode budget alias for one
compatibility release. Neither header is suitable as a direct mapping from an
SSO username. Without a cookie in `none` mode, a budget selector selects the
compatibility account identified by that budget's storage key, subject to its
active status and membership. It never selects an arbitrary owner. A budget
whose account differs from its storage key requires explicit account selection
and a session. Service budget-context resolution always requires an account ID;
missing actors fail clearly, with no owner fallback.

Fresh installations grant `system_admin` only to the first successfully
created account. Discovery of existing per-user storage never creates an
account. A compatibility folder belongs to an existing active account whose ID
matches its storage key; otherwise explicit `POST /api/users` with that user ID
creates the account and adopts the folder, preserving its financial settings.
No account ID has special meaning; upgrades keep existing accounts and roles
(see [migration rules](migration.md#accounts-and-budget-ownership)).
The global database prevents removal or disabling of the
last active system administrator. System administrators can disable accounts
and revoke active sessions, but in `none` mode those controls are operational
guardrails rather than proof of identity because account selection still has no
credential check.

Treat `data/cashflow-global.sqlite` as sensitive. It stores account records,
roles, membership metadata, invitation token hashes, session token/CSRF hashes,
security audit rows, password credential hashes, password setup/reset token
hashes, authentication provider configuration, OAuth callback state, and
identity-provider links. Restrictive filesystem permissions and encrypted
off-host backups are recommended for the full `data/` volume.

Internal passwords are hashed with Argon2id. Set
`CASHFLOW_PASSWORD_PEPPER` only if you can keep it stable and back it up through
your deployment secret-management process; losing the pepper makes existing
password hashes unverifiable. Password setup/reset tokens are single-use,
expire after 24 hours, and are stored only as hashes.

External SSO mode trusts headers only after a shared assertion-secret header
matches the configured environment variable. The reverse proxy must strip
client-supplied identity and assertion-secret headers before injecting its own
values, and direct backend access must be blocked or limited to trusted network
paths. External mode is unsafe when clients can reach the backend port directly.

## Recommended Deployment Shape

- HTTPS at the public edge
- reverse-proxy auth, SSO, VPN, or private network access
- private application port where possible
- protection for the browser app, `/api/system`, and every `/api/*` route
- unauthenticated `/healthz` only when an external health monitor requires
  it
- optional private control routes such as `/api/restart` and
  `/api/local/tests/*` blocked from ordinary users
- operator-owned `local/dev.mjs` code and any routes it registers, secured
  through trusted-network access, a reverse proxy, or controls implemented by
  that local module
- mounted volumes protected from public file serving
- `data/`, `logs/`, `backups/`, and `local/` kept out of public access
- SQLite backups before upgrades

## Notification destinations (v1.1.3)

Notification URLs must use HTTP(S). Cashflow checks private/non-public addresses
when settings are saved and again for every delivery. Delivery connects only to
the DNS addresses validated for that request, retaining the original hostname
for HTTPS certificate verification. IPv4-mapped IPv6 is checked against IPv4
restrictions too. Redirects are rejected: configure the final ntfy topic or
Discord webhook URL rather than a redirecting URL.

An administrator may explicitly approve an exact private ntfy hostname/IP under
Settings > Admin > Global options. This exception is checked again at delivery,
does not include subdomains, and never applies to Discord. Removed approvals
take effect on subsequent deliveries, including already queued notifications.
Blocked/failed delivery leaves the notification unsent for a later retry; failure
logs identify the channel without exposing the destination or message contents.

Private ntfy approval is a trust decision: the approved host may resolve to
private addresses. Use only trusted hosts and restrict container egress as an
additional boundary. Network-level controls remain important for unusual routing
and translation arrangements that an application cannot fully infer.

## Reverse-Proxy Basic Auth

This Caddy example protects the complete application. Generate the password
hash with Caddy rather than storing a plaintext password:

```caddyfile
cashflow.example.com {
  basic_auth {
    cashflow-user $2a$14$REPLACE_WITH_A_CADDY_PASSWORD_HASH
  }

  reverse_proxy 127.0.0.1:3000
}
```

To expose only liveness without authentication:

```caddyfile
cashflow.example.com {
  handle /healthz {
    reverse_proxy 127.0.0.1:3000
  }

  handle {
    basic_auth {
      cashflow-user $2a$14$REPLACE_WITH_A_CADDY_PASSWORD_HASH
    }
    reverse_proxy 127.0.0.1:3000
  }
}
```

## SSO Forward Auth

Forward-auth delegates the access decision to an identity-aware proxy. The
following shape is illustrative; use the URI and copied headers required by
your selected provider:

```caddyfile
cashflow.example.com {
  forward_auth auth-gateway:4180 {
    uri /oauth2/auth
    copy_headers X-Auth-Request-User X-Auth-Request-Email
  }

  reverse_proxy cashflow:3000
}
```

Cashflow external mode can consume authenticated-user headers when it is active.
The Admin authentication settings and proxy configuration need to agree on the
subject/email/name/group headers and the assertion-secret header. In `none`
mode, visitors can still select compatibility accounts after access is granted;
in `internal` mode, they must also log in through Cashflow.

For trusted-header identity, the reverse proxy removes any client-supplied
identity header and sets a dedicated trusted value from the authentication
provider. Budget-selection headers are not identity values.

## External SSO Wiring Notes

All proxy stacks follow the same requirements:

- authenticate the browser before it reaches Cashflow
- block direct access to the backend port
- strip incoming `X-Auth-Request-*` and `X-Cashflow-Auth-Secret` headers
- inject a stable subject header, optional email/name/group headers, and the
  configured assertion-secret header

Caddy with forward-auth can use `header_up` on the final `reverse_proxy` to set
Cashflow's assertion secret after `forward_auth` succeeds:

```caddyfile
reverse_proxy cashflow:3000 {
  header_up X-Cashflow-Auth-Secret {$CASHFLOW_EXTERNAL_AUTH_SECRET}
}
```

Nginx should use `auth_request`, clear client identity headers with empty
`proxy_set_header` values where appropriate, then set the trusted headers from
the auth subrequest variables before `proxy_pass`.

Traefik should place Cashflow behind a ForwardAuth middleware and use a headers
middleware or upstream service configuration to pass only trusted identity
headers plus `X-Cashflow-Auth-Secret`.

oauth2-proxy commonly emits `X-Auth-Request-User`, `X-Auth-Request-Email`, and
`X-Auth-Request-Groups`. Configure Cashflow's external draft to those header
names and use the reverse proxy to inject `X-Cashflow-Auth-Secret`.

Authelia and Authentik can both sit in the forward-auth position. Use their
stable subject/username header as Cashflow's subject header, pass verified email
and group headers if needed, and keep Cashflow's automatic provisioning at
`deny_unknown` until explicit account links or invitation flows are tested.


## Companion-device authentication

Device pairing is available for the companion Android app, which is not public
yet. Pairing requires explicit approval from an authenticated account session;
per-budget grants determine read and financial-write access. Device credentials
are scoped, expire, and can be revoked. They cannot be mixed with browser
cookies or compatibility account/budget selectors. Financial writes recheck the
current account, device grant and budget permission on the owning transaction.

Admin global options configure access-token lifetime (default 15 minutes),
renewal inactivity (90 days), and absolute device lifetime (365 days).
The global authorization database stores device and pairing state and token
hashes; keep it protected alongside browser authentication state.

## Paired-device CSV/JSON portability

The device budget allowlist admits only the four `POST /api/import/full` and
`POST /api/import/one-offs-csv` preview/application routes, `GET /api/backups`,
and `POST /api/restore/:backupId` in addition to the existing device routes.
Import previews and application require an explicit per-budget write grant and
the same `budget:import` role permission as browser imports. Backup listing
requires a read grant and `budget:restore`; restoration requires a write grant
and `budget:restore`. Selecting a backup ID never changes the selected budget.
Cookies and the deprecated user header cannot accompany device credentials.

Coordinated import preview/application recheck the device token, current grant,
account status and role using the owning financial connection. SQLite attaches
the configured global authorization database under its existing transaction;
PostgreSQL uses the existing device/membership locks and budget ledger advisory
lock. Expected epoch/revision and a process-local authenticated preview hash
bind file, mode, device, budget and financial state. Application repeats checks
after taking a durable replacement backup; all source writes, projections and
epoch invalidation share one financial commit. Concurrent state changes require
another download/review. Tokens confer no authority and fail closed on restart
or a different server instance.

Device full exports and imports exclude operational settings. Import replies
contain backup IDs and counts, never backup paths or browser snapshots. Backup
listing includes only successful budget-scoped recovery IDs/timestamps/sizes.
Unexpected portability errors are sanitized for device responses. Restore keeps
the existing backup validation/restore workflow and returns only success plus
a bootstrap requirement to devices. No generic snapshot upload, backup creation,
validation, sample import, account, auth, or admin route was added to the device
allowlist. File application requires a fresh authorized preview; a lost response
must be resolved against the current financial revision before another import.

## Budget renaming and optimistic concurrency

Renaming a budget (`PUT /api/budgets/:budgetId`) uses a stale-write check rather
than last-write-wins concurrency:
- Every budget record has an integer metadata `revision` (default 1) that increments
  atomically on every rename.
- Paired sync devices MUST send `expectedRevision` in the request body. Device
  requests without `expectedRevision` are rejected with HTTP 400.
- When `expectedRevision` is present and differs from the current revision, the
  rename is rejected with HTTP 409 conflict, returning error code
  `budget_rename_conflict` along with `currentName` and `currentRevision`, changing
  nothing.
- A lost-response retry with the same `expectedRevision` returns HTTP 409 with the
  current name, allowing a client to see that its own rename won.
- Existing browser sessions omitting `expectedRevision` preserve their existing
  behavior, updating the name and incrementing the revision counter.

## Currency-history transfer reader boundary

The standalone transfer `formats` probe uses the same bearer-only, cookie/header
refusal and current creation permission checks as review. It accepts only lookup
scope, allocates nothing and returns no financial data. A positive version-2
reader advertisement is required before a phone sends currency-history source
bytes. Exact engine negotiation guards linked origin readers. Source/origin
replay verifies pending mirrors and H5 recomputation evidence; neither a claimed
balance nor an opening/conversion mirror can become an additional payment.
Supported source versions are advertised by the authenticated formats probe;
review and submission validate the exact supported financial evidence.

## Device archive recovery

A device archive is an atomic owner-authorized metadata operation with a stable
removal idempotency key. Only the initiating device changes to a restricted,
receipt-only state; it receives no budget access during the acknowledgement
window. All normal authorization paths reject this state, including renewal,
financial owning-transaction checks and standalone transfer recovery. Other
devices' grants/revocations are preserved. Browser-initiated archival retains its
existing conservative revocation rules.

Receipt lookup and acknowledgement are exact bearer-only POST routes under
`/api/device/archive-receipts`, with no-store responses and no mixed browser or
budget-selector credentials. The capability binds device, instance, account,
approving session, exact archive access-token hash, budget and idempotency key.
It survives normal access expiry solely to recover that receipt. A same-key
archive retry returns the identical receipt without executing another archive;
a different key/budget is refused. No token hash or financial data is returned.

Acknowledgement or the 24-hour deadline ends recovery. The configurable deadline
(`CASHFLOW_DEVICE_ARCHIVE_RECEIPT_HOURS`, bounded to one minute through seven days)
is fixed at commit, never sliding, and capped by absolute device expiry. Refusal
at timeout is immediate; the next receipt request durably records revocation.
Independent account/session/device revocation always wins. Device state uses the
existing nonportable `state_json`, so no applied migration changes or new schema
are needed. Portable metadata exports still omit device state.

Android saves the complete copy before archival, then saves the archive receipt
before acknowledgement. HTTP 401 never proves an unknown archive outcome. It
can only finish an acknowledgement retry after that receipt is already durable.
Unrecoverable expiry before the local receipt checkpoint keeps both the link and
copy for review. Diagnostic materialization failures carry allowlisted static
check/reason/record-kind codes; values, names, IDs and arbitrary exception text
are excluded from the diagnostic envelope.
