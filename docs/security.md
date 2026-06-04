# Security

Cashflow is usable for self-hosted personal planning, but it is not a secure
multi-user web app yet.

It does not include built-in login, passwords, protected sessions, or real
permissions. The user-selection screen separates planner profiles, but it does
not stop one visitor from opening another profile. Do not expose Cashflow
directly to the public internet without reverse-proxy authentication, VPN,
private network access, SSO, or another access-control layer. HTTPS alone is not
access control.

## Current Security Stance

- no built-in authentication
- no password-protected profiles
- no protected server-side sessions
- session responses describe the selected profile but are not authenticated
  server-side sessions
- admin permission gates exist, but every newly created profile receives admin
  permission by default
- no app-native protection against cross-site request attacks
- intended to sit behind trusted network access or reverse-proxy auth

The `x-cashflow-user-id` request header is a profile selector used by the
browser and API. It is not proof of identity. Do not map it directly from an SSO
username or treat it as authorization.

## Recommended Deployment

- put it behind HTTPS
- use reverse-proxy auth, SSO, VPN, or private network access
- keep the application port private where possible
- protect the browser app, `/api/system`, and every `/api/*` route
- allow unauthenticated `/healthz` only when an external health monitor requires
  it
- block optional private control routes such as `/api/restart` and
  `/api/local/tests/*` from ordinary users
- treat `local/dev.mjs` code and every route it registers as
  operator-owned; secure them through trusted-network access, the reverse
  proxy, or controls implemented by that local module
- protect mounted volumes from public file serving
- keep `data/`, `logs/`, `backups/`, and `local/` out of public access
- back up SQLite files before upgrades

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

Cashflow currently ignores authenticated-user headers. Forward-auth protects
access to the shared app, while visitors can still select any Cashflow profile
after access is granted.

For a future trusted-header identity integration, the reverse proxy must remove
any client-supplied identity header and set a dedicated trusted value from the
authentication provider. Do not repurpose `x-cashflow-user-id` for that future
identity value without changing Cashflow's session model.
