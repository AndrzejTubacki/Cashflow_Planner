# Security

Cashflow is usable, but still early as a standalone public app.

It does not include built-in authentication, registration, sessions, CSRF
protection, or role-based access control. Do not expose it directly to the
public internet without reverse-proxy authentication, VPN/private network
access, SSO, or another access-control layer. HTTPS alone is not auth.

## Current Security Stance

- no built-in authentication
- no user registration
- no sessions
- no role-based access control
- no app-native CSRF protection
- intended to sit behind trusted network access or reverse-proxy auth

## Recommended Deployment

- put it behind HTTPS
- use reverse-proxy auth, SSO, VPN, or private network access
- do not bind it directly to the public internet
- protect mounted volumes from public file serving
- keep `data/`, `logs/`, `backups/`, and `local/` out of public access
- back up SQLite files before upgrades
