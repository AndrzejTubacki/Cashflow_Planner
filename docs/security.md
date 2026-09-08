# Security

Cashflow is usable for self-hosted personal planning. Its `none`
authentication mode is not a secure multi-user login boundary; internal
email/password login can be enabled after an administrator creates a password
credential for at least one system administrator.

The global database now separates accounts, budgets, memberships, global roles,
and budget capabilities. Server routes authorize memberships before opening
budget storage, and a system administrator does not automatically gain access
to financial data. However, `none` mode assigns visitors the automatic legacy
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
SSO username.

Fresh installations grant `system_admin` only to the first successfully
created account. Existing profile installations migrate to one automatic
legacy administrator. The global database prevents removal or disabling of the
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
