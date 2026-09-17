import {
  GLOBAL_SCHEMA_VERSION,
  GLOBAL_TABLE_NAMES
} from "./cashflow-global-schema.js";

export const POSTGRES_GLOBAL_SCHEMA_VERSION = GLOBAL_SCHEMA_VERSION;
export const POSTGRES_GLOBAL_TABLES = [...GLOBAL_TABLE_NAMES];
export const POSTGRES_COORDINATION_TABLES = [
  "cashflow_runtime_locks"
];
export const POSTGRES_GLOBAL_COLUMNS = {
  users: [
    "id",
    "display_name",
    "permissions",
    "created_at",
    "updated_at",
    "last_selected_at"
  ],
  global_options: [
    "id",
    "ledger_currency",
    "locale",
    "timezone",
    "holiday_country",
    "future_periods",
    "fx_provider",
    "fx_buffer_percent",
    "updated_at"
  ],
  accounts: [
    "id",
    "email",
    "display_name",
    "status",
    "created_at",
    "updated_at",
    "disabled_at",
    "deleted_at"
  ],
  account_global_roles: [
    "account_id",
    "role",
    "granted_by_account_id",
    "created_at"
  ],
  budgets: [
    "id",
    "storage_key",
    "display_name",
    "status",
    "created_by_account_id",
    "created_at",
    "updated_at",
    "archived_at",
    "deleted_at"
  ],
  budget_memberships: [
    "budget_id",
    "account_id",
    "role",
    "invited_by_account_id",
    "created_at",
    "updated_at"
  ],
  budget_invitations: [
    "id",
    "budget_id",
    "target_account_id",
    "target_email",
    "role",
    "token_hash",
    "status",
    "invited_by_account_id",
    "expires_at",
    "accepted_at",
    "revoked_at",
    "created_at",
    "updated_at"
  ],
  auth_identities: [
    "id",
    "account_id",
    "provider_id",
    "subject",
    "email",
    "email_verified",
    "profile_json",
    "created_at",
    "updated_at",
    "last_used_at"
  ],
  password_credentials: [
    "account_id",
    "password_hash",
    "password_changed_at",
    "failed_attempts",
    "locked_until",
    "created_at",
    "updated_at"
  ],
  password_reset_tokens: [
    "id",
    "account_id",
    "token_hash",
    "purpose",
    "status",
    "expires_at",
    "consumed_at",
    "created_by_account_id",
    "created_at",
    "updated_at"
  ],
  auth_sessions: [
    "id",
    "account_id",
    "token_hash",
    "csrf_token_hash",
    "selected_budget_id",
    "auth_method",
    "created_at",
    "last_seen_at",
    "idle_expires_at",
    "absolute_expires_at",
    "revoked_at"
  ],
  auth_providers: [
    "id",
    "kind",
    "display_name",
    "enabled",
    "issuer",
    "client_id",
    "secret_ref",
    "config_json",
    "created_at",
    "updated_at"
  ],
  auth_oauth_states: [
    "id",
    "state_hash",
    "provider_id",
    "account_id",
    "purpose",
    "code_verifier",
    "nonce",
    "redirect_uri",
    "status",
    "expires_at",
    "consumed_at",
    "created_at",
    "updated_at"
  ],
  auth_config: [
    "id",
    "active_mode",
    "draft_mode",
    "session_idle_minutes",
    "session_absolute_minutes",
    "external_config_json",
    "draft_config_json",
    "bootstrap_completed_at",
    "updated_at"
  ],
  security_audit_log: [
    "id",
    "actor_account_id",
    "action",
    "target_type",
    "target_id",
    "outcome",
    "details_json",
    "created_at"
  ]
};

const POSTGRES_GLOBAL_SCHEMA_BODY = `
CREATE TABLE IF NOT EXISTS cashflow_global_schema_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cashflow_runtime_locks (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > acquired_at)
);

CREATE INDEX IF NOT EXISTS idx_cashflow_runtime_locks_expires_at
  ON cashflow_runtime_locks(expires_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '["admin"]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_selected_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS global_options (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ledger_currency TEXT NOT NULL DEFAULT 'PLN',
  locale TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw',
  holiday_country TEXT NOT NULL DEFAULT 'PL',
  future_periods INTEGER NOT NULL DEFAULT 11,
  fx_provider TEXT NOT NULL DEFAULT 'nbp',
  fx_buffer_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  disabled_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email_lower
  ON accounts (LOWER(email))
  WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_global_roles (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system_admin')),
  granted_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (account_id, role)
);

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  created_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS budget_memberships (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'editor', 'viewer')),
  invited_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (budget_id, account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_memberships_single_owner
  ON budget_memberships(budget_id)
  WHERE role = 'owner';

CREATE TABLE IF NOT EXISTS budget_invitations (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  target_account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  target_email TEXT,
  role TEXT NOT NULL CHECK (role IN ('manager', 'editor', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_budget_invitations_email_lower
  ON budget_invitations (LOWER(target_email))
  WHERE target_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  profile_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  UNIQUE (provider_id, subject)
);

CREATE TABLE IF NOT EXISTS password_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_changed_at TIMESTAMPTZ NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL DEFAULT 'password_reset'
    CHECK (purpose IN ('password_setup', 'password_reset')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  selected_budget_id TEXT REFERENCES budgets(id) ON DELETE SET NULL,
  auth_method TEXT NOT NULL DEFAULT 'none',
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('oidc', 'google', 'github', 'facebook')),
  display_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  issuer TEXT,
  client_id TEXT,
  secret_ref TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_oauth_states (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL REFERENCES auth_providers(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'link')),
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (active_mode IN ('none', 'external', 'internal')),
  draft_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (draft_mode IN ('none', 'external', 'internal')),
  session_idle_minutes INTEGER NOT NULL DEFAULT 720,
  session_absolute_minutes INTEGER NOT NULL DEFAULT 10080,
  external_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  bootstrap_completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS security_audit_log (
  id TEXT PRIMARY KEY,
  actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_budget_memberships_account
  ON budget_memberships(account_id, budget_id);
CREATE INDEX IF NOT EXISTS idx_budget_invitations_budget_status
  ON budget_invitations(budget_id, status);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_account
  ON auth_sessions(account_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_auth_oauth_states_provider_status
  ON auth_oauth_states(provider_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_account
  ON password_reset_tokens(account_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_security_audit_created
  ON security_audit_log(created_at);

CREATE OR REPLACE FUNCTION cashflow_prevent_last_system_admin_delete()
RETURNS trigger AS $$
BEGIN
  IF OLD.role = 'system_admin'
    AND (
      SELECT COUNT(*)
      FROM account_global_roles agr
      JOIN accounts a ON a.id = agr.account_id
      WHERE agr.role = 'system_admin' AND a.status = 'active'
    ) <= 1
  THEN
    RAISE EXCEPTION 'last_system_admin';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cashflow_prevent_last_system_admin_disable()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'active'
    AND NEW.status != 'active'
    AND EXISTS (
      SELECT 1
      FROM account_global_roles
      WHERE account_id = OLD.id AND role = 'system_admin'
    )
    AND (
      SELECT COUNT(*)
      FROM account_global_roles agr
      JOIN accounts a ON a.id = agr.account_id
      WHERE agr.role = 'system_admin' AND a.status = 'active'
    ) <= 1
  THEN
    RAISE EXCEPTION 'last_system_admin';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cashflow_prevent_budget_owner_change()
RETURNS trigger AS $$
BEGIN
  IF OLD.role = 'owner'
    AND (TG_OP = 'DELETE' OR NEW.role != 'owner')
    AND EXISTS (
      SELECT 1
      FROM budgets
      WHERE id = OLD.budget_id AND status != 'deleted'
    )
  THEN
    RAISE EXCEPTION 'last_budget_owner';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prevent_last_system_admin_delete ON account_global_roles;
CREATE TRIGGER prevent_last_system_admin_delete
BEFORE DELETE ON account_global_roles
FOR EACH ROW
EXECUTE FUNCTION cashflow_prevent_last_system_admin_delete();

DROP TRIGGER IF EXISTS prevent_last_system_admin_disable ON accounts;
CREATE TRIGGER prevent_last_system_admin_disable
BEFORE UPDATE OF status ON accounts
FOR EACH ROW
EXECUTE FUNCTION cashflow_prevent_last_system_admin_disable();

DROP TRIGGER IF EXISTS prevent_budget_owner_delete ON budget_memberships;
CREATE TRIGGER prevent_budget_owner_delete
BEFORE DELETE ON budget_memberships
FOR EACH ROW
EXECUTE FUNCTION cashflow_prevent_budget_owner_change();

DROP TRIGGER IF EXISTS prevent_budget_owner_demotion ON budget_memberships;
CREATE TRIGGER prevent_budget_owner_demotion
BEFORE UPDATE OF role ON budget_memberships
FOR EACH ROW
EXECUTE FUNCTION cashflow_prevent_budget_owner_change();

INSERT INTO global_options (id, updated_at)
VALUES (1, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO auth_config (id, updated_at)
VALUES (1, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO cashflow_global_schema_version (id, version, applied_at)
VALUES (1, ${POSTGRES_GLOBAL_SCHEMA_VERSION}, now())
ON CONFLICT (id) DO UPDATE SET
  version = EXCLUDED.version,
  applied_at = EXCLUDED.applied_at;
`;

export function createPostgresGlobalSchemaSql({
  includeTransaction = true
} = {}) {
  const body = POSTGRES_GLOBAL_SCHEMA_BODY.trim();
  if (!includeTransaction) return `${body}\n`;
  return `BEGIN;\n\n${body}\n\nCOMMIT;\n`;
}
