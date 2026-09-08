# Accounts, Budgets, And Authentication Architecture

Cashflow currently exposes planner storage namespaces as selectable "users".
The account and budget migration separates those concepts without moving
existing planning or ledger files.

This document records the account, budget, and authentication architecture.
The security limitations in [Security](security.md) still apply, especially for
installations that still run in `none` mode.

## Identity And Storage

- An **account** represents a person. Account IDs are immutable; account display
  names are mutable only by a system administrator.
- A **budget** represents a planner and its storage namespace. Budget IDs and
  storage keys are immutable; budget display names are mutable.
- A budget storage key maps to the existing directory under `DATA_DIR`. Renaming
  a budget never renames or moves that directory.
- Authentication identifies the account. Selecting a budget never establishes
  identity and always requires a valid membership.

## Roles

Global and budget roles are separate.

| Role | Capabilities |
| --- | --- |
| `system_admin` | Manage accounts, authentication, global defaults, and budget metadata. It does not grant access to financial data. |
| `owner` | Full control of one budget, including settings, members, restore, archive, and purge. |
| `manager` | Planner access plus budget rename, member/invitation management below owner, validation, and exports. |
| `editor` | Read and change planner data and confirm ledger transactions. |
| `viewer` | Read budget data only. |

Every budget has exactly one owner. Ownership transfer is explicit and atomic.
The last system administrator and last budget owner cannot be removed.

## Admin Account Management

System administrators can use the Admin tab to inspect accounts, rename account
display names, enable or disable accounts, grant or revoke `system_admin`, and
revoke active sessions. Account IDs remain immutable.

Disabling an account revokes its active sessions. Deleting an account marks it
deleted and preserves audit history; it is allowed only after the account no
longer owns active budgets and no longer has active budget memberships. The
database still prevents removing the final active system administrator.

## Compatibility Migration

The global database is versioned independently from planning and ledger
databases. Before an outdated global database is migrated, Cashflow creates and
verifies a recovery copy under:

```text
DATA_DIR/global-migration-backups/
```

Existing profile directories become budgets without moving files. One
automatically created legacy administrator owns all migrated budgets and is the
only account granted `system_admin`.

When `cashflow-global.sqlite` does not exist yet but profile storage already
exists, initial global database creation performs the same legacy-budget import
before first-account bootstrap. A newly created account therefore does not
become system administrator just because the global metadata file was missing.
Completed global recovery snapshots are retained by
`CASHFLOW_GLOBAL_MIGRATION_RECOVERY_RETENTION_COUNT` and pending/incomplete
snapshots are left untouched.

For one compatibility release, the old profile routes and
`x-cashflow-user-id` remain available only in unauthenticated `none` mode. They
become deprecated budget selectors and never establish account identity.

## Authentication Modes

- `none`: compatibility mode. Account selection requires no credential and is
  not access control. Selection still creates an opaque, revocable server-side
  session and state-changing browser requests require its CSRF token.
- `external`: a trusted reverse proxy or SSO gateway supplies a stable subject.
- `internal`: Cashflow uses email/password login and may also use configured
  external identity providers.

All modes use the same server-side account, session, budget-membership, and
authorization model. Authentication modes remain inactive until an
administrator validates and explicitly activates them.

The Admin tab stores a staged authentication draft separately from the active
mode. Operators can stage and validate `none`, `external`, and `internal`
settings. `internal` activation is allowed only after at least one active
system administrator has an email/password credential or an explicit identity
link to an enabled internal-mode provider. `external` activation is allowed only
after a shared assertion-secret environment variable is configured and at least
one active system administrator has an explicit external identity link. Inline
secrets are rejected; provider secrets must use environment variables or
allowed secret-file references.

Internal login uses normalized unique email addresses as login identifiers.
Display names remain separate and admin-managed. Administrators issue
single-use password setup/reset tokens from the Admin Accounts section; only
the token hash is stored, and the plaintext token is shown only in the response
that created it. Passwords are hashed with Argon2id via `argon2`, can include
long passphrases, and may be mixed with an optional deployment pepper
(`CASHFLOW_PASSWORD_PEPPER`) before hashing. Failed login attempts use generic
errors and credential-level backoff; `/api/auth/internal/*` is also rate
limited by `express-rate-limit`.

Internal-mode providers are configured in Admin as OIDC/Google/GitHub/Facebook
adapters. Cashflow starts Authorization Code flows with state, PKCE, and OIDC
nonce where applicable through `openid-client`. Provider subjects are stored as
`(provider, subject)` links and are never inferred from email alone; a signed-in
account or system administrator must explicitly link the identity.

Once `internal` mode is active, public account creation is closed. New accounts
are created by accepting email-targeted budget invitations through the internal
registration form. Registration consumes the invitation, creates the account,
sets its password, and joins the invited budget in one transaction.

External mode trusts a reverse proxy or SSO gateway to authenticate the user and
inject stable identity headers. The proxy must strip client-supplied identity
headers, inject the configured subject header, and include the configured shared
assertion-secret header. Cashflow compares that secret against the configured
environment variable before accepting any external identity headers. External
subjects are linked explicitly by system administrators; automatic provisioning
defaults to deny and must be enabled deliberately.

The implementation uses maintained libraries for authentication work: Argon2id
via `argon2`, OIDC/OAuth protocol handling via `openid-client`, request
throttling via `express-rate-limit`, and standard HTTP security headers via
`helmet`. Password hashing and OAuth/OIDC protocol handling stay delegated to
those libraries rather than custom application code.

Fresh installations use first-visitor bootstrap: the first successfully
committed account becomes system administrator and owns its initial budget.
An empty installation needs to remain private until setup is complete because
the first completed account receives the initial administrator role.

Existing installations use a separate legacy bootstrap: the automatic legacy
administrator owns migrated budgets. New accounts created afterward own their
own first budget and receive no global role.

## Security Boundaries

- Authorization is enforced before any budget database, ledger, backup, import,
  or export path is opened.
- System administrators do not implicitly gain access to budget financial data.
- Budget exports never include accounts, credentials, sessions, invitation
  tokens, or provider secrets.
- Security-sensitive IDs and tokens use cryptographically secure randomness and
  are stored as hashes where later verification is required.
- The database prevents removing or disabling the last active system
  administrator and prevents deleting or demoting a budget's owner.
- MFA and published API tokens are deferred, but the authentication schema and
  session model must leave room for them.
