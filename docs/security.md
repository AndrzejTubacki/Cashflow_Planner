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
- no real admin/user separation; every selected profile can access admin options
- no app-native protection against cross-site request attacks
- intended to sit behind trusted network access or reverse-proxy auth

If you integrate with the API, do not treat the selected user/profile id as
proof of identity. Only trusted clients should be allowed to call the app.

## Recommended Deployment

- put it behind HTTPS
- use reverse-proxy auth, SSO, VPN, or private network access
- do not bind it directly to the public internet
- protect mounted volumes from public file serving
- keep `data/`, `logs/`, `backups/`, and `local/` out of public access
- back up SQLite files before upgrades
