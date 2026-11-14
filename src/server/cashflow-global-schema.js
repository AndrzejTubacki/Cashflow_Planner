import { DEVICE_SCHEMA_SQL, DEVICE_TABLE_COLUMNS } from "./cashflow-device-schema.js";
import { STANDALONE_TRANSFER_JOURNAL_SCHEMA, STANDALONE_TRANSFER_TABLE_COLUMNS } from './cashflow-standalone-transfer-schema.js';

export const GLOBAL_SCHEMA_VERSION = 8;
export const GLOBAL_TABLE_NAMES = [
  "users",
  "global_options",
  "accounts",
  "account_global_roles",
  "budgets",
  "budget_memberships",
  "budget_invitations",
  "auth_identities",
  "password_credentials",
  "password_reset_tokens",
  "auth_sessions",
  "auth_providers",
  "auth_oauth_states",
  "auth_config",
  "security_audit_log",
  ...Object.keys(DEVICE_TABLE_COLUMNS),
  ...Object.keys(STANDALONE_TRANSFER_TABLE_COLUMNS)
];

export const GLOBAL_RUNTIME_GUARD_TRIGGER_NAMES = [
  "prevent_last_system_admin_delete",
  "prevent_last_system_admin_disable",
  "prevent_budget_owner_delete",
  "prevent_budget_owner_demotion"
];

const GLOBAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    permissions TEXT NOT NULL DEFAULT '["admin"]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_selected_at TEXT
  );

  CREATE TABLE IF NOT EXISTS global_options (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ledger_currency TEXT NOT NULL DEFAULT 'PLN',
    locale TEXT NOT NULL DEFAULT 'en',
    timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw',
    holiday_country TEXT NOT NULL DEFAULT 'PL',
    future_periods INTEGER NOT NULL DEFAULT 11,
    fx_provider TEXT NOT NULL DEFAULT 'nbp',
    fx_buffer_percent REAL NOT NULL DEFAULT 0,
    ntfy_allowed_private_hosts TEXT NOT NULL DEFAULT '[]',
    backup_max_retention_count INTEGER NOT NULL DEFAULT 0 CHECK (backup_max_retention_count BETWEEN 0 AND 2147483647),
    backup_max_age_days INTEGER NOT NULL DEFAULT 0 CHECK (backup_max_age_days BETWEEN 0 AND 2147483647),
    device_access_minutes INTEGER NOT NULL DEFAULT 15 CHECK (device_access_minutes BETWEEN 1 AND 1440),
    device_renewal_idle_days INTEGER NOT NULL DEFAULT 90 CHECK (device_renewal_idle_days BETWEEN 1 AND 3650),
    device_absolute_days INTEGER NOT NULL DEFAULT 365 CHECK (device_absolute_days BETWEEN 1 AND 3650),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    avatar TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'disabled', 'deleted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    disabled_at TEXT,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS account_global_roles (
    account_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('system_admin')),
    granted_by_account_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, role),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (granted_by_account_id) REFERENCES accounts(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id TEXT PRIMARY KEY,
    storage_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'archived', 'deleted')),
    created_by_account_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (created_by_account_id) REFERENCES accounts(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS budget_memberships (
    budget_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'editor', 'viewer')),
    invited_by_account_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (budget_id, account_id),
    FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by_account_id) REFERENCES accounts(id) ON DELETE SET NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_memberships_single_owner
    ON budget_memberships(budget_id)
    WHERE role = 'owner';

  CREATE TABLE IF NOT EXISTS budget_invitations (
    id TEXT PRIMARY KEY,
    budget_id TEXT NOT NULL,
    target_account_id TEXT,
    target_email TEXT COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('manager', 'editor', 'viewer')),
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    invited_by_account_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE,
    FOREIGN KEY (target_account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by_account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS auth_identities (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    email TEXT COLLATE NOCASE,
    email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
    profile_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    UNIQUE (provider_id, subject),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS password_credentials (
    account_id TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    password_changed_at TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    purpose TEXT NOT NULL DEFAULT 'password_reset'
      CHECK (purpose IN ('password_setup', 'password_reset')),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_by_account_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_account_id) REFERENCES accounts(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token_hash TEXT NOT NULL,
    selected_budget_id TEXT,
    auth_method TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    idle_expires_at TEXT NOT NULL,
    absolute_expires_at TEXT NOT NULL,
    revoked_at TEXT,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (selected_budget_id) REFERENCES budgets(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS auth_providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('oidc', 'google', 'github', 'facebook')),
    display_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    issuer TEXT,
    client_id TEXT,
    secret_ref TEXT,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_oauth_states (
    id TEXT PRIMARY KEY,
    state_hash TEXT NOT NULL UNIQUE,
    provider_id TEXT NOT NULL,
    account_id TEXT,
    purpose TEXT NOT NULL CHECK (purpose IN ('login', 'link')),
    code_verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'consumed', 'expired')),
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (provider_id) REFERENCES auth_providers(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS auth_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    active_mode TEXT NOT NULL DEFAULT 'none'
      CHECK (active_mode IN ('none', 'external', 'internal')),
    draft_mode TEXT NOT NULL DEFAULT 'none'
      CHECK (draft_mode IN ('none', 'external', 'internal')),
    session_idle_minutes INTEGER NOT NULL DEFAULT 720,
    session_absolute_minutes INTEGER NOT NULL DEFAULT 10080,
    external_config_json TEXT NOT NULL DEFAULT '{}',
    draft_config_json TEXT NOT NULL DEFAULT '{}',
    bootstrap_completed_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS security_audit_log (
    id TEXT PRIMARY KEY,
    actor_account_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (actor_account_id) REFERENCES accounts(id) ON DELETE SET NULL
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

  CREATE TRIGGER IF NOT EXISTS prevent_last_system_admin_delete
  BEFORE DELETE ON account_global_roles
  WHEN OLD.role = 'system_admin'
    AND (
      SELECT COUNT(*)
      FROM account_global_roles agr
      JOIN accounts a ON a.id = agr.account_id
      WHERE agr.role = 'system_admin' AND a.status = 'active'
    ) <= 1
  BEGIN
    SELECT RAISE(ABORT, 'last_system_admin');
  END;

  CREATE TRIGGER IF NOT EXISTS prevent_last_system_admin_disable
  BEFORE UPDATE OF status ON accounts
  WHEN OLD.status = 'active'
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
  BEGIN
    SELECT RAISE(ABORT, 'last_system_admin');
  END;

  CREATE TRIGGER IF NOT EXISTS prevent_budget_owner_delete
  BEFORE DELETE ON budget_memberships
  WHEN OLD.role = 'owner'
    AND EXISTS (
      SELECT 1
      FROM budgets
      WHERE id = OLD.budget_id AND status != 'deleted'
    )
  BEGIN
    SELECT RAISE(ABORT, 'last_budget_owner');
  END;

  CREATE TRIGGER IF NOT EXISTS prevent_budget_owner_demotion
  BEFORE UPDATE OF role ON budget_memberships
  WHEN OLD.role = 'owner'
    AND NEW.role != 'owner'
    AND EXISTS (
      SELECT 1
      FROM budgets
      WHERE id = OLD.budget_id AND status != 'deleted'
    )
  BEGIN
    SELECT RAISE(ABORT, 'last_budget_owner');
  END;

  INSERT OR IGNORE INTO global_options (id, updated_at)
  VALUES (1, datetime('now'));

  INSERT OR IGNORE INTO auth_config (id, updated_at)
  VALUES (1, datetime('now'));

  ${STANDALONE_TRANSFER_JOURNAL_SCHEMA}
`;

export function dropGlobalRuntimeGuardTriggers(db) {
  for (const triggerName of GLOBAL_RUNTIME_GUARD_TRIGGER_NAMES) {
    db.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
  }
}

export function ensureGlobalRuntimeSchemaObjects(db) {
  db.exec(GLOBAL_SCHEMA_SQL);
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map(row => row.name);
}

function addGlobalOptionsCompatibilityColumns(db) {
  const columns = tableColumns(db, "global_options");
  if (!columns.includes("holiday_country")) {
    db.exec("ALTER TABLE global_options ADD COLUMN holiday_country TEXT NOT NULL DEFAULT 'PL'");
  }
}

function addAccountAvatarCompatibilityColumn(db) {
  const columns = tableColumns(db, "accounts");
  if (!columns.includes("avatar")) {
    db.exec("ALTER TABLE accounts ADD COLUMN avatar TEXT");
  }
}

function addNtfyAllowedPrivateHostsCompatibilityColumn(db) {
  const columns = tableColumns(db, "global_options");
  if (!columns.includes("ntfy_allowed_private_hosts")) {
    db.exec("ALTER TABLE global_options ADD COLUMN ntfy_allowed_private_hosts TEXT NOT NULL DEFAULT '[]'");
  }
}

export function ensureLegacyBudget(db, {
  budgetId,
  displayName = "",
  storageKey = budgetId
}) {
  // Discovery never creates identities. Only an explicitly created matching
  // account may adopt a per-user storage folder.
  const owner = db.prepare("SELECT id FROM accounts WHERE id = ? AND status = 'active'").get(storageKey);
  if (!owner) return;
  if (db.prepare("SELECT 1 FROM budgets WHERE id = ?").get(budgetId)) return;
  const name = String(displayName || budgetId).trim() || budgetId;

  db.prepare(`
    INSERT OR IGNORE INTO budgets (
      id, storage_key, display_name, status, created_by_account_id, created_at, updated_at
    )
    VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'))
  `).run(budgetId, storageKey, name, owner.id);

  db.prepare(`
    INSERT OR IGNORE INTO budget_memberships (
      budget_id, account_id, role, invited_by_account_id, created_at, updated_at
    )
    VALUES (?, ?, 'owner', NULL, datetime('now'), datetime('now'))
  `).run(budgetId, owner.id);
}

function migrateLegacyProfiles(db, storageProfileIds = []) {
  const metadata = new Map(
    db.prepare("SELECT id, display_name FROM users").all()
      .map(row => [row.id, row.display_name])
  );

  for (const profileId of [...new Set(storageProfileIds)].sort()) {
    ensureLegacyBudget(db, {
      budgetId: profileId,
      displayName: metadata.get(profileId) || profileId,
      storageKey: profileId
    });
  }
}

export function initializeGlobalSchema(db, {
  storageProfileIds = []
} = {}) {
  db.transaction(() => {
    db.exec(GLOBAL_SCHEMA_SQL);
    db.exec(DEVICE_SCHEMA_SQL);
    migrateLegacyProfiles(db, storageProfileIds);
    db.pragma(`user_version = ${GLOBAL_SCHEMA_VERSION}`);
  })();
}

export function applyGlobalMigrations(db, {
  beforeStep = () => {},
  storageProfileIds = []
} = {}) {
  const currentVersion = db.pragma("user_version", { simple: true });

  db.transaction(() => {
    if (currentVersion < 2) {
      beforeStep(2, db);
      addGlobalOptionsCompatibilityColumns(db);
      db.exec(GLOBAL_SCHEMA_SQL);
      migrateLegacyProfiles(db, storageProfileIds);
      db.pragma("user_version = 2");
    }
    if (currentVersion < 3) {
      beforeStep(3, db);
      db.exec(GLOBAL_SCHEMA_SQL);
      db.pragma("user_version = 3");
    }
    if (currentVersion < 4) {
      beforeStep(4, db);
      db.exec(GLOBAL_SCHEMA_SQL);
      db.pragma("user_version = 4");
    }
    if (currentVersion < 5) {
      beforeStep(5, db);
      db.exec(GLOBAL_SCHEMA_SQL);
      db.pragma("user_version = 5");
    }
    if (currentVersion < 6) {
      beforeStep(6, db);
      addAccountAvatarCompatibilityColumn(db);
      db.exec(GLOBAL_SCHEMA_SQL);
      db.pragma("user_version = 6");
    }
    if (currentVersion < 7) {
      beforeStep(7, db);
      addNtfyAllowedPrivateHostsCompatibilityColumn(db);
      db.exec(GLOBAL_SCHEMA_SQL);
      db.pragma("user_version = 7");
    }
    if (currentVersion < 8) {
      beforeStep(8, db);
      const columns = tableColumns(db, "global_options");
      for (const [name, value, max] of [["device_access_minutes", 15, 1440],
        ["device_renewal_idle_days", 90, 3650], ["device_absolute_days", 365, 3650]]) {
        if (!columns.includes(name)) db.exec(`ALTER TABLE global_options ADD COLUMN ${name}
          INTEGER NOT NULL DEFAULT ${value} CHECK (${name} BETWEEN 1 AND ${max})`);
      }
      // Unreleased 1.2.0 options belong to global step 8, alongside device policy.
      for (const name of ["backup_max_retention_count", "backup_max_age_days"]) {
        if (!columns.includes(name)) db.exec(`ALTER TABLE global_options ADD COLUMN ${name}
          INTEGER NOT NULL DEFAULT 0 CHECK (${name} BETWEEN 0 AND 2147483647)`);
      }
      db.exec(DEVICE_SCHEMA_SQL);
      // Reserve transfer identities additively; no financial writer is exposed.
      db.exec(STANDALONE_TRANSFER_JOURNAL_SCHEMA);
      // Cancellation is a durable negative outcome, not deletion of a job.
      // Rebuild the old CHECK constraints inside this owning migration so an
      // interrupted/failed upgrade retains every existing binding and receipt.
      db.exec('ALTER TABLE cashflow_standalone_transfers RENAME TO cashflow_standalone_transfers_old');
      db.exec(STANDALONE_TRANSFER_JOURNAL_SCHEMA);
      db.exec(`INSERT INTO cashflow_standalone_transfers SELECT * FROM cashflow_standalone_transfers_old;
        DROP TABLE cashflow_standalone_transfers_old`);
      const budgetColumns = tableColumns(db, "budgets");
      if (!budgetColumns.includes("revision")) {
        db.exec("ALTER TABLE budgets ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
      }
      db.pragma("user_version = 8");
    }
  })();
}
