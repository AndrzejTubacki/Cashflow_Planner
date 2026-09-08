import Database from "better-sqlite3";
import argon2 from "argon2";
import crypto from "crypto";
import fs from "fs";
import * as oidcClient from "openid-client";
import path from "path";
import { capabilitiesFor, CAPABILITIES } from "./cashflow-authorization.js";
import { createCashflowGlobalMigrationService } from "./cashflow-global-migration-recovery.js";
import {
  ensureLegacyBudget,
  LEGACY_ADMIN_ACCOUNT_ID
} from "./cashflow-global-schema.js";
import {
  DEFAULT_FUTURE_PERIODS,
  DEFAULT_FX_BUFFER_PERCENT,
  DEFAULT_TIMEZONE
} from "./cashflow-constants.js";
import { normalizeHolidayCountry, normalizeTimezone } from "./cashflow-date-utils.js";
import {
  normalizeFxProvider,
  normalizeSupportedCurrency
} from "./cashflow-fx-provider-utils.js";
import { validateAndNormalizeSettings } from "./cashflow-settings-validation.js";
import {
  badRequest,
  conflict,
  forbidden,
  normalizeUserId,
  notFound,
  unauthorized,
  userNotFoundError
} from "./cashflow-user-utils.js";

const GLOBAL_OPTIONS_KEYS = new Set([
  "ledger_currency",
  "locale",
  "timezone",
  "holiday_country",
  "future_periods",
  "fx_provider",
  "fx_buffer_percent"
]);

const AUTH_MODES = new Set(["none", "external", "internal"]);
const AUTH_PROVISIONING_MODES = new Set(["deny_unknown", "allow_invited", "allow_any"]);
const AUTH_PROVIDER_KINDS = new Set(["oidc", "google", "github", "facebook"]);
const SECRET_FIELD_PATTERN = /(secret|token|password|clientsecret|client_secret|privatekey|private_key)/i;
const PASSWORD_TOKEN_BYTES = 32;
const PASSWORD_TOKEN_TTL_HOURS = 24;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 1024;
const PASSWORD_LOCK_THRESHOLD = 5;
const PASSWORD_LOCK_MINUTES = 15;
const DEFAULT_EXTERNAL_SECRET_HEADER = "x-cashflow-auth-secret";
const DEFAULT_EXTERNAL_SECRET_ENV = "CASHFLOW_EXTERNAL_AUTH_SECRET";
const OAUTH_STATE_TTL_MINUTES = 10;

const PROVIDER_PRESETS = {
  facebook: {
    authorizationEndpoint: "https://www.facebook.com/v20.0/dialog/oauth",
    displayName: "Facebook",
    emailField: "email",
    emailVerifiedField: "",
    issuer: "https://www.facebook.com",
    scope: "email public_profile",
    subjectField: "id",
    tokenEndpoint: "https://graph.facebook.com/v20.0/oauth/access_token",
    userInfoEndpoint: "https://graph.facebook.com/me?fields=id,name,email"
  },
  github: {
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    displayName: "GitHub",
    emailField: "email",
    emailVerifiedField: "",
    issuer: "https://github.com",
    scope: "read:user user:email",
    subjectField: "id",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    userInfoEndpoint: "https://api.github.com/user"
  },
  google: {
    displayName: "Google",
    emailField: "email",
    emailVerifiedField: "email_verified",
    issuer: "https://accounts.google.com",
    scope: "openid email profile",
    subjectField: "sub"
  },
  oidc: {
    displayName: "OpenID Connect",
    emailField: "email",
    emailVerifiedField: "email_verified",
    scope: "openid email profile",
    subjectField: "sub"
  }
};

function initPragmas(db) {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
}

function normalizePermissions(value) {
  const parsed = (() => {
    if (Array.isArray(value)) return value;
    try {
      return JSON.parse(String(value || "[]"));
    } catch {
      return [];
    }
  })();
  const permissions = [...new Set(parsed.map(item => String(item || "").trim()).filter(Boolean))];
  return permissions.length ? permissions : ["admin"];
}

function normalizeAccountDisplayName(value, field = "displayName") {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 120) {
    throw badRequest(`${field} must use 1-120 characters`, [{
      field,
      reason: "invalid_length"
    }]);
  }
  return normalized;
}

function normalizeAccountEmail(value, field = "email") {
  const normalized = String(value || "").trim().toLowerCase();
  if (
    !normalized
    || normalized.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw badRequest(`${field} must be a valid email address`, [{
      field,
      reason: "invalid_email"
    }]);
  }
  return normalized;
}

function normalizePassword(value, field = "password") {
  if (typeof value !== "string") {
    throw badRequest(`${field} must be a string`, [{
      field,
      reason: "invalid_type"
    }]);
  }
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw badRequest(`${field} must use ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`, [{
      field,
      reason: "invalid_length"
    }]);
  }
  return value;
}

function normalizeAdminBoolean(value, field) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw badRequest(`${field} must be a boolean`, [{
    field,
    reason: "invalid_boolean"
  }]);
}

function normalizeAuthMode(value, field = "mode") {
  const mode = String(value || "").trim().toLowerCase();
  if (!AUTH_MODES.has(mode)) {
    throw badRequest(`${field} must be none, external, or internal`, [{
      field,
      reason: "unsupported_value"
    }]);
  }
  return mode;
}

function normalizeAuthInteger(value, field, { min, max }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw badRequest(`${field} must be an integer from ${min} to ${max}`, [{
      field,
      reason: "out_of_range"
    }]);
  }
  return number;
}

function safeJsonParseObject(value, field) {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not_object");
    }
    return parsed;
  } catch {
    throw badRequest(`${field} must be an object`, [{
      field,
      reason: "invalid_object"
    }]);
  }
}

function assertNoInlineSecrets(value, pathPrefix = "draftConfig") {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const pathName = `${pathPrefix}.${key}`;
    if (
      key === "allowPasswordLogin"
      || key === "allow_password_login"
      || key === "assertionSecretEnv"
      || key === "assertion_secret_env"
      || key === "assertionSecretHeader"
      || key === "assertion_secret_header"
      || key === "clearSecret"
      || key === "clear_secret"
      || key === "secretEnv"
      || key === "secret_env"
      || key === "secretFile"
      || key === "secret_file"
      || key === "secretRef"
      || key === "secret_ref"
      || key === "tokenEndpoint"
      || key === "token_endpoint"
    ) {
      continue;
    }
    if (SECRET_FIELD_PATTERN.test(key)) {
      throw badRequest(`${pathName} must use an environment or secret-file reference`, [{
        field: pathName,
        reason: "inline_secret_not_allowed"
      }]);
    }
    if (nested && typeof nested === "object") {
      assertNoInlineSecrets(nested, pathName);
    }
  }
}

function normalizeOptionalHeader(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  if (!/^[A-Za-z0-9-]{1,80}$/.test(normalized)) {
    throw badRequest(`${field} must be an HTTP header name`, [{
      field,
      reason: "invalid_header_name"
    }]);
  }
  return normalized.toLowerCase();
}

function normalizeStringList(value, field) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const list = raw.map(item => String(item || "").trim()).filter(Boolean);
  if (list.some(item => item.length > 120)) {
    throw badRequest(`${field} contains an invalid value`, [{
      field,
      reason: "invalid_value"
    }]);
  }
  return [...new Set(list)];
}

function normalizeEnvName(value, field) {
  const normalized = String(value || "").trim();
  if (!/^[A-Z_][A-Z0-9_]{0,120}$/.test(normalized)) {
    throw badRequest(`${field} must be an environment variable name`, [{
      field,
      reason: "invalid_env_name"
    }]);
  }
  return normalized;
}

function normalizeExternalSubject(value, field = "subject") {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 512 || /[\r\n\u0000]/u.test(normalized)) {
    throw badRequest(`${field} must be a stable external subject`, [{
      field,
      reason: "invalid_subject"
    }]);
  }
  return normalized;
}

function normalizeAuthProviderId(value, field = "providerId") {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(normalized)) {
    throw badRequest(`${field} must use 1-80 lowercase letters, numbers, _ or -`, [{
      field,
      reason: "invalid_id"
    }]);
  }
  return normalized;
}

function normalizeAuthProviderKind(value, field = "kind") {
  const kind = String(value || "").trim().toLowerCase();
  if (!AUTH_PROVIDER_KINDS.has(kind)) {
    throw badRequest(`${field} must be oidc, google, github, or facebook`, [{
      field,
      reason: "unsupported_value"
    }]);
  }
  return kind;
}

function normalizeOptionalUrl(value, field, { required = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) {
    if (required) {
      throw badRequest(`${field} is required`, [{ field, reason: "required" }]);
    }
    return "";
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw badRequest(`${field} must be an absolute HTTP(S) URL`, [{
      field,
      reason: "invalid_url"
    }]);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw badRequest(`${field} must be an HTTP(S) URL`, [{
      field,
      reason: "invalid_protocol"
    }]);
  }
  return parsed.href;
}

function normalizeOptionalAuthString(value, field, { max = 512, required = false } = {}) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    if (required) throw badRequest(`${field} is required`, [{ field, reason: "required" }]);
    return "";
  }
  if (normalized.length > max || /[\r\n\u0000]/u.test(normalized)) {
    throw badRequest(`${field} is invalid`, [{
      field,
      reason: "invalid_value"
    }]);
  }
  return normalized;
}

function normalizeSecretReference(input = {}, existing = "") {
  if (input.clearSecret === true || input.clear_secret === true) return "";
  const secretEnv = String(input.secretEnv || input.secret_env || "").trim();
  const secretFile = String(input.secretFile || input.secret_file || "").trim();
  const secretRef = String(input.secretRef || input.secret_ref || "").trim();
  if (secretEnv) return `env:${normalizeEnvName(secretEnv, "secretEnv")}`;
  if (secretFile) {
    if (!path.isAbsolute(secretFile) || secretFile.length > 512 || /[\u0000]/u.test(secretFile)) {
      throw badRequest("secretFile must be an absolute path", [{
        field: "secretFile",
        reason: "invalid_path"
      }]);
    }
    return `file:${secretFile}`;
  }
  if (secretRef) {
    if (secretRef.startsWith("env:")) {
      return `env:${normalizeEnvName(secretRef.slice(4), "secretRef")}`;
    }
    if (secretRef.startsWith("file:")) {
      const filePath = secretRef.slice(5);
      if (!path.isAbsolute(filePath) || filePath.length > 512 || /[\u0000]/u.test(filePath)) {
        throw badRequest("secretRef file path is invalid", [{
          field: "secretRef",
          reason: "invalid_path"
        }]);
      }
      return `file:${filePath}`;
    }
    throw badRequest("secretRef must use env: or file:", [{
      field: "secretRef",
      reason: "unsupported_secret_ref"
    }]);
  }
  return existing || "";
}

function secretValueFromRef(secretRef = "") {
  const ref = String(secretRef || "").trim();
  if (!ref) return "";
  if (ref.startsWith("env:")) {
    return String(process.env[ref.slice(4)] || "");
  }
  if (ref.startsWith("file:")) {
    try {
      return fs.readFileSync(ref.slice(5), "utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

function randomAuthToken() {
  return crypto.randomBytes(PASSWORD_TOKEN_BYTES).toString("base64url");
}

function authTokenHash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function addHoursIso(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function addMinutesIso(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function passwordMaterial(password) {
  const pepper = String(process.env.CASHFLOW_PASSWORD_PEPPER || "");
  return pepper ? `${pepper}\0${password}` : password;
}

function externalProviderId(externalConfig = {}) {
  const issuer = String(externalConfig.trustedIssuer || "external").trim() || "external";
  return `external_${authTokenHash(issuer).slice(0, 24)}`;
}

function safeSecretMatches(provided, expected) {
  const left = Buffer.from(String(provided || ""), "utf8");
  const right = Buffer.from(String(expected || ""), "utf8");
  return left.length === right.length
    && left.length > 0
    && crypto.timingSafeEqual(left, right);
}

function normalizeDraftAuthConfig(input = {}) {
  const external = safeJsonParseObject(input.external || {}, "external");
  const internal = safeJsonParseObject(input.internal || {}, "internal");
  assertNoInlineSecrets({ external, internal });
  const provisioningMode = String(external.provisioningMode || external.provisioning_mode || "deny_unknown").trim();
  if (!AUTH_PROVISIONING_MODES.has(provisioningMode)) {
    throw badRequest("external.provisioningMode is invalid", [{
      field: "external.provisioningMode",
      reason: "unsupported_value"
    }]);
  }

  const normalized = {
    external: {
      adminGroups: normalizeStringList(external.adminGroups || external.admin_groups || [], "external.adminGroups"),
      allowedDomains: normalizeStringList(external.allowedDomains || external.allowed_domains || [], "external.allowedDomains"),
      assertionSecretEnv: normalizeEnvName(external.assertionSecretEnv || external.assertion_secret_env || DEFAULT_EXTERNAL_SECRET_ENV, "external.assertionSecretEnv"),
      assertionSecretHeader: normalizeOptionalHeader(external.assertionSecretHeader || external.assertion_secret_header || DEFAULT_EXTERNAL_SECRET_HEADER, "external.assertionSecretHeader"),
      displayNameHeader: normalizeOptionalHeader(external.displayNameHeader || external.display_name_header, "external.displayNameHeader"),
      emailHeader: normalizeOptionalHeader(external.emailHeader || external.email_header, "external.emailHeader"),
      groupsHeader: normalizeOptionalHeader(external.groupsHeader || external.groups_header, "external.groupsHeader"),
      provisioningMode,
      subjectHeader: normalizeOptionalHeader(external.subjectHeader || external.subject_header || "x-auth-request-user", "external.subjectHeader"),
      trustedIssuer: String(external.trustedIssuer || external.trusted_issuer || "").trim().slice(0, 200)
    },
    internal: {
      allowPasswordLogin: normalizeAdminBoolean(
        Object.prototype.hasOwnProperty.call(internal, "allowPasswordLogin") ? internal.allowPasswordLogin :
          Object.prototype.hasOwnProperty.call(internal, "allow_password_login") ? internal.allow_password_login :
            true,
        "internal.allowPasswordLogin"
      ),
      registrationMode: "invite_only"
    }
  };

  assertNoInlineSecrets(normalized);
  return normalized;
}

function mapGlobalConstraintError(error) {
  const message = String(error?.message || "");
  if (message.includes("last_system_admin")) {
    throw conflict("At least one active system administrator is required");
  }
  throw error;
}

export function createCashflowGlobalService({
  authProviderHook = null,
  beforeGlobalMigrationStep = () => {},
  cashflowUserStorageExists,
  dataDir,
  deleteCashflowUserStorage = null,
  listCashflowUserIds,
  logError = () => {},
  logServerEvent = () => {},
  normalizeLocale = value => String(value || "en"),
  openPlanningDb
}) {
  const globalDbPath = path.join(dataDir, "cashflow-global.sqlite");
  const globalMigration = createCashflowGlobalMigrationService({
    dataDir,
    logError,
    logServerEvent
  });

  function openGlobalDb() {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(globalDbPath);
    initPragmas(db);
    try {
      globalMigration.initializeOrMigrate(db, {
        beforeStep: beforeGlobalMigrationStep,
        storageProfileIds: listCashflowUserIds()
      });
      db.prepare(`
        UPDATE global_options
        SET holiday_country = CASE
              WHEN UPPER(COALESCE(holiday_country, 'PL')) IN ('PL', 'DE') THEN UPPER(COALESCE(holiday_country, 'PL'))
              ELSE 'PL'
            END
        WHERE id = 1
      `).run();
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  function auditGlobalSecurity(db, {
    action,
    actorAccountId = null,
    details = {},
    outcome = "success",
    targetId = null,
    targetType = null
  }) {
    db.prepare(`
      INSERT INTO security_audit_log (
        id, actor_account_id, action, target_type, target_id, outcome,
        details_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      `audit_${crypto.randomUUID()}`,
      actorAccountId || null,
      action,
      targetType,
      targetId,
      outcome,
      JSON.stringify(details || {})
    );
  }

  function getGlobalOptions() {
    const db = openGlobalDb();
    try {
      return db.prepare("SELECT * FROM global_options WHERE id = 1").get();
    } finally {
      db.close();
    }
  }

  function ensureUserMetadata(db, userId, displayName = "") {
    const normalizedId = normalizeUserId(userId);
    const name = String(displayName || normalizedId).trim() || normalizedId;
    db.prepare(`
      INSERT INTO users (id, display_name, permissions, created_at, updated_at)
      VALUES (?, ?, '["admin"]', datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        display_name = CASE
          WHEN excluded.display_name != excluded.id THEN excluded.display_name
          ELSE users.display_name
        END,
        permissions = COALESCE(NULLIF(users.permissions, ''), '["admin"]'),
        updated_at = datetime('now')
    `).run(normalizedId, name);
    return normalizedId;
  }

  function ensureCompatibilityBudget(db, userId, displayName = "") {
    const normalizedId = normalizeUserId(userId);
    if (budgetMetadata(db, normalizedId)) {
      return normalizedId;
    }
    if (
      typeof cashflowUserStorageExists !== "function"
      || !cashflowUserStorageExists(normalizedId)
    ) {
      return normalizedId;
    }

    ensureLegacyBudget(db, {
      budgetId: normalizedId,
      displayName: String(displayName || normalizedId).trim() || normalizedId,
      storageKey: normalizedId
    });
    return normalizedId;
  }

  function metadataUser(db, userId) {
    const normalizedId = normalizeUserId(userId);
    return db.prepare(`
      SELECT id, display_name, permissions
      FROM users
      WHERE id = ?
    `).get(normalizedId);
  }

  function budgetMetadata(db, budgetId) {
    const normalizedId = normalizeUserId(budgetId);
    return db.prepare(`
      SELECT id, storage_key, display_name, status
      FROM budgets
      WHERE id = ?
    `).get(normalizedId);
  }

  function syncExistingStorageBudgets(db, {
    excludeIds = []
  } = {}) {
    const excluded = new Set([...excludeIds].map(id => normalizeUserId(id)));
    for (const userId of listCashflowUserIds()) {
      if (excluded.has(normalizeUserId(userId))) continue;
      const metadata = metadataUser(db, userId);
      ensureCompatibilityBudget(db, userId, metadata?.display_name || userId);
    }
  }

  function userExists(userId) {
    const normalizedId = normalizeUserId(userId);
    if (normalizedId === "local") return true;
    if (typeof cashflowUserStorageExists === "function" && cashflowUserStorageExists(normalizedId)) return true;

    const db = openGlobalDb();
    try {
      return Boolean(metadataUser(db, normalizedId));
    } finally {
      db.close();
    }
  }

  function applyDefaultsToUser(userId, options = null) {
    const defaults = options || getGlobalOptions();
    const db = openPlanningDb(userId);
    try {
      db.prepare(`
        UPDATE settings
        SET ledger_currency = ?,
            locale = ?,
            timezone = ?,
            holiday_country = ?,
            future_periods = ?,
            fx_provider = ?,
            fx_buffer_percent = ?,
            updated_at = datetime('now')
        WHERE id = 1
          AND setup_completed = 0
      `).run(
        normalizeSupportedCurrency(defaults?.ledger_currency || "PLN"),
        normalizeLocale(defaults?.locale || "en"),
        normalizeTimezone(defaults?.timezone || DEFAULT_TIMEZONE),
        normalizeHolidayCountry(defaults?.holiday_country || "PL"),
        Math.max(1, Math.min(60, Number(defaults?.future_periods) || DEFAULT_FUTURE_PERIODS)),
        normalizeFxProvider(defaults?.fx_provider || "nbp"),
        Math.max(0, Math.min(100, Number(defaults?.fx_buffer_percent) || DEFAULT_FX_BUFFER_PERCENT))
      );
    } finally {
      db.close();
    }
  }

  function initializeBudgetStorage(budgetId) {
    const normalizedId = normalizeUserId(budgetId);
    openPlanningDb(normalizedId).close();
    applyDefaultsToUser(normalizedId);
    return normalizedId;
  }

  function listUsers() {
    const db = openGlobalDb();
    try {
      const ids = new Set(["local", ...listCashflowUserIds()]);
      db.transaction(() => {
        for (const userId of ids) {
          ensureUserMetadata(db, userId);
          ensureCompatibilityBudget(db, userId, metadataUser(db, userId)?.display_name);
        }
      })();

      return db.prepare(`
        SELECT id, display_name, permissions, created_at, updated_at, last_selected_at
        FROM users
        ORDER BY COALESCE(last_selected_at, created_at) DESC, id ASC
      `).all().map(row => ({
        ...row,
        permissions: normalizePermissions(row.permissions)
      }));
    } finally {
      db.close();
    }
  }

  function accountExistsRow(db, accountId) {
    const normalizedId = normalizeUserId(accountId);
    const account = db.prepare(`
      SELECT id, email, display_name, status, created_at, updated_at, disabled_at, deleted_at
      FROM accounts
      WHERE id = ?
    `).get(normalizedId);
    if (!account) throw notFound("Account not found");
    return account;
  }

  function activeSessionsForAccount(db, accountId) {
    const nowMs = Date.now();
    return db.prepare(`
      SELECT id, auth_method, selected_budget_id, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at
      FROM auth_sessions
      WHERE account_id = ?
        AND revoked_at IS NULL
      ORDER BY last_seen_at DESC, created_at DESC
    `).all(accountId).filter(session =>
      Date.parse(session.idle_expires_at) > nowMs &&
      Date.parse(session.absolute_expires_at) > nowMs
    );
  }

  function accountSummary(db, accountId) {
    const account = accountExistsRow(db, accountId);
    const globalRoles = db.prepare(`
      SELECT role
      FROM account_global_roles
      WHERE account_id = ?
      ORDER BY role
    `).all(account.id).map(row => row.role);
    const membershipCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM budget_memberships bm
      JOIN budgets b ON b.id = bm.budget_id
      WHERE bm.account_id = ?
        AND b.status != 'deleted'
    `).get(account.id).count;
    const ownedBudgetCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM budget_memberships bm
      JOIN budgets b ON b.id = bm.budget_id
      WHERE bm.account_id = ?
        AND bm.role = 'owner'
        AND b.status != 'deleted'
    `).get(account.id).count;
    const identityCount = db.prepare(`
      SELECT COUNT(*) AS count
      FROM auth_identities
      WHERE account_id = ?
    `).get(account.id).count;
    const identities = db.prepare(`
      SELECT id, provider_id, subject, email, email_verified, created_at, updated_at, last_used_at
      FROM auth_identities
      WHERE account_id = ?
      ORDER BY provider_id, subject
    `).all(account.id);
    const hasPasswordCredential = Boolean(db.prepare(`
      SELECT 1
      FROM password_credentials
      WHERE account_id = ?
      LIMIT 1
    `).get(account.id));
    const sessions = activeSessionsForAccount(db, account.id);

    return {
      ...account,
      globalRoles,
      hasPasswordCredential,
      identities,
      identityCount,
      membershipCount,
      ownedBudgetCount,
      sessions,
      activeSessionCount: sessions.length
    };
  }

  function listAdminAccounts() {
    const db = openGlobalDb();
    try {
      return db.prepare(`
        SELECT id
        FROM accounts
        ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'disabled' THEN 1 ELSE 2 END,
          LOWER(display_name), id
      `).all().map(row => accountSummary(db, row.id));
    } finally {
      db.close();
    }
  }

  function updateAdminAccount(actorAccountId, accountId, input = {}) {
    const normalizedId = normalizeUserId(accountId);
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(input, "displayName") || Object.prototype.hasOwnProperty.call(input, "display_name")) {
      updates.displayName = normalizeAccountDisplayName(input.displayName ?? input.display_name, "displayName");
    }
    if (Object.prototype.hasOwnProperty.call(input, "email")) {
      updates.email = normalizeAccountEmail(input.email, "email");
    }
    if (Object.prototype.hasOwnProperty.call(input, "status")) {
      const status = String(input.status || "").trim();
      if (!["active", "disabled"].includes(status)) {
        throw badRequest("status must be active or disabled", [{
          field: "status",
          reason: "unsupported_value"
        }]);
      }
      updates.status = status;
    }

    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const account = accountExistsRow(db, normalizedId);
        if (account.status === "deleted") throw conflict("Deleted accounts cannot be changed");

        if (updates.displayName) {
          db.prepare(`
            UPDATE accounts
            SET display_name = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(updates.displayName, normalizedId);
          db.prepare(`
            UPDATE users
            SET display_name = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(updates.displayName, normalizedId);
        }

        if (updates.email && updates.email !== account.email) {
          try {
            db.prepare(`
              UPDATE accounts
              SET email = ?,
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(updates.email, normalizedId);
          } catch (error) {
            if (String(error?.message || "").includes("UNIQUE")) {
              throw conflict("Email is already assigned to another account", [{
                field: "email",
                reason: "not_unique"
              }]);
            }
            throw error;
          }
        }

        if (updates.status && updates.status !== account.status) {
          try {
            db.prepare(`
              UPDATE accounts
              SET status = ?,
                  disabled_at = CASE WHEN ? = 'disabled' THEN datetime('now') ELSE NULL END,
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(updates.status, updates.status, normalizedId);
          } catch (error) {
            mapGlobalConstraintError(error);
          }

          if (updates.status !== "active") {
            db.prepare(`
              UPDATE auth_sessions
              SET revoked_at = COALESCE(revoked_at, datetime('now'))
              WHERE account_id = ?
                AND revoked_at IS NULL
            `).run(normalizedId);
          }
        }

        auditGlobalSecurity(db, {
          action: "admin_account_update",
          actorAccountId,
          details: {
            changedDisplayName: Boolean(updates.displayName),
            changedEmail: Boolean(updates.email),
            status: updates.status || null
          },
          targetId: normalizedId,
          targetType: "account"
        });
        result = accountSummary(db, normalizedId);
      })();
      return result;
    } finally {
      db.close();
    }
  }

  function setAccountSystemAdmin(actorAccountId, accountId, enabledValue) {
    const normalizedId = normalizeUserId(accountId);
    const enabled = normalizeAdminBoolean(enabledValue, "enabled");
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const account = accountExistsRow(db, normalizedId);
        if (account.status !== "active") throw conflict("Only active accounts can hold system administrator role");

        try {
          if (enabled) {
            db.prepare(`
              INSERT OR IGNORE INTO account_global_roles (
                account_id, role, granted_by_account_id, created_at
              )
              VALUES (?, 'system_admin', ?, datetime('now'))
            `).run(normalizedId, actorAccountId || null);
            db.prepare(`
              UPDATE users
              SET permissions = '["admin"]',
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(normalizedId);
          } else {
            db.prepare(`
              DELETE FROM account_global_roles
              WHERE account_id = ?
                AND role = 'system_admin'
            `).run(normalizedId);
            db.prepare(`
              UPDATE users
              SET permissions = '[]',
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(normalizedId);
          }
        } catch (error) {
          mapGlobalConstraintError(error);
        }

        auditGlobalSecurity(db, {
          action: enabled ? "admin_account_grant_system_admin" : "admin_account_revoke_system_admin",
          actorAccountId,
          targetId: normalizedId,
          targetType: "account"
        });
        result = accountSummary(db, normalizedId);
      })();
      return result;
    } finally {
      db.close();
    }
  }

  function revokeAdminAccountSession(actorAccountId, accountId, sessionId) {
    const normalizedId = normalizeUserId(accountId);
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) throw badRequest("sessionId is required", [{ field: "sessionId", reason: "required" }]);

    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        accountExistsRow(db, normalizedId);
        const changes = db.prepare(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE id = ?
            AND account_id = ?
            AND revoked_at IS NULL
        `).run(normalizedSessionId, normalizedId).changes;
        if (changes !== 1) throw notFound("Session not found");
        auditGlobalSecurity(db, {
          action: "admin_account_session_revoke",
          actorAccountId,
          targetId: normalizedSessionId,
          targetType: "auth_session"
        });
        result = accountSummary(db, normalizedId);
      })();
      return result;
    } finally {
      db.close();
    }
  }

  function deleteAdminAccount(actorAccountId, accountId) {
    const normalizedId = normalizeUserId(accountId);
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const account = accountExistsRow(db, normalizedId);
        if (account.status === "deleted") {
          result = accountSummary(db, normalizedId);
          return;
        }

        const ownedBudgetCount = db.prepare(`
          SELECT COUNT(*) AS count
          FROM budget_memberships bm
          JOIN budgets b ON b.id = bm.budget_id
          WHERE bm.account_id = ?
            AND bm.role = 'owner'
            AND b.status != 'deleted'
        `).get(normalizedId).count;
        if (ownedBudgetCount > 0) throw conflict("Transfer or delete owned budgets before deleting this account");

        const membershipCount = db.prepare(`
          SELECT COUNT(*) AS count
          FROM budget_memberships bm
          JOIN budgets b ON b.id = bm.budget_id
          WHERE bm.account_id = ?
            AND b.status != 'deleted'
        `).get(normalizedId).count;
        if (membershipCount > 0) throw conflict("Remove this account from budgets before deleting it");

        try {
          db.prepare(`
            DELETE FROM account_global_roles
            WHERE account_id = ?
          `).run(normalizedId);
        } catch (error) {
          mapGlobalConstraintError(error);
        }

        db.prepare(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE account_id = ?
            AND revoked_at IS NULL
        `).run(normalizedId);
        db.prepare("DELETE FROM auth_identities WHERE account_id = ?").run(normalizedId);
        db.prepare("DELETE FROM password_credentials WHERE account_id = ?").run(normalizedId);
        db.prepare("DELETE FROM password_reset_tokens WHERE account_id = ?").run(normalizedId);
        db.prepare(`
          UPDATE budget_invitations
          SET status = 'revoked',
              revoked_at = COALESCE(revoked_at, datetime('now')),
              updated_at = datetime('now')
          WHERE target_account_id = ?
            AND status = 'pending'
        `).run(normalizedId);
        db.prepare(`
          UPDATE accounts
          SET status = 'deleted',
              deleted_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizedId);
        db.prepare(`
          UPDATE users
          SET permissions = '[]',
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizedId);
        auditGlobalSecurity(db, {
          action: "admin_account_delete",
          actorAccountId,
          targetId: normalizedId,
          targetType: "account"
        });
        result = accountSummary(db, normalizedId);
      })();
      return result;
    } finally {
      db.close();
    }
  }

  function listActiveBudgetIds() {
    const db = openGlobalDb();
    try {
      syncExistingStorageBudgets(db);
      return db.prepare(`
        SELECT id, storage_key
        FROM budgets
        WHERE status = 'active'
        ORDER BY id
      `).all()
        .filter(row =>
          typeof cashflowUserStorageExists !== "function"
          || cashflowUserStorageExists(row.storage_key)
        )
        .map(row => row.id);
    } finally {
      db.close();
    }
  }

  function resolveBudgetStorageKey(budgetId = "") {
    const normalizedId = normalizeUserId(budgetId);
    const db = openGlobalDb();
    try {
      return budgetMetadata(db, normalizedId)?.storage_key || normalizedId;
    } finally {
      db.close();
    }
  }

  function createUser(input = {}) {
    const userId = normalizeUserId(input.userId || input.id);
    const displayName = String(input.displayName || input.display_name || userId).trim() || userId;
    const email = Object.prototype.hasOwnProperty.call(input, "email")
      ? normalizeAccountEmail(input.email, "email")
      : null;
    const options = getGlobalOptions();
    const db = openGlobalDb();
    try {
      db.transaction(() => {
        syncExistingStorageBudgets(db);
        const existing = db.prepare(`
          SELECT id FROM users WHERE id = ?
          UNION ALL
          SELECT id FROM accounts WHERE id = ?
          UNION ALL
          SELECT id FROM budgets WHERE id = ?
          LIMIT 1
        `).get(userId, userId, userId);
        if (
          existing
          || (typeof cashflowUserStorageExists === "function" && cashflowUserStorageExists(userId))
        ) {
          throw conflict("User already exists");
        }
        if (email && db.prepare("SELECT 1 FROM accounts WHERE email = ?").get(email)) {
          throw conflict("Email is already assigned to another account", [{
            field: "email",
            reason: "not_unique"
          }]);
        }

        db.prepare(`
          INSERT INTO users (id, display_name, permissions, created_at, updated_at, last_selected_at)
          VALUES (?, ?, '[]', datetime('now'), datetime('now'), datetime('now'))
        `).run(userId, displayName);
      })();
    } finally {
      db.close();
    }

    try {
      openPlanningDb(userId).close();
      applyDefaultsToUser(userId, options);
      const metadataDb = openGlobalDb();
      try {
        metadataDb.transaction(() => {
          syncExistingStorageBudgets(metadataDb, { excludeIds: [userId] });
          const bootstrapRequired = Number(metadataDb.prepare(`
            SELECT COUNT(*) AS count
            FROM accounts
          `).get()?.count || 0) === 0;

          metadataDb.prepare(`
            INSERT INTO accounts (
              id, email, display_name, status, created_at, updated_at
            )
            VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))
          `).run(userId, email, displayName);
          metadataDb.prepare(`
            INSERT INTO budgets (
              id, storage_key, display_name, status, created_by_account_id,
              created_at, updated_at
            )
            VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'))
          `).run(userId, userId, displayName, userId);
          metadataDb.prepare(`
            INSERT INTO budget_memberships (
              budget_id, account_id, role, invited_by_account_id, created_at, updated_at
            )
            VALUES (?, ?, 'owner', NULL, datetime('now'), datetime('now'))
          `).run(userId, userId);

          if (bootstrapRequired) {
            metadataDb.prepare(`
              INSERT INTO account_global_roles (
                account_id, role, granted_by_account_id, created_at
              )
              VALUES (?, 'system_admin', NULL, datetime('now'))
            `).run(userId);
            metadataDb.prepare(`
              UPDATE auth_config
              SET bootstrap_completed_at = COALESCE(bootstrap_completed_at, datetime('now')),
                  updated_at = datetime('now')
              WHERE id = 1
            `).run();
            metadataDb.prepare(`
              UPDATE users
              SET permissions = '["admin"]',
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(userId);
          }
        })();
      } finally {
        metadataDb.close();
      }
    } catch (error) {
      const cleanupDb = openGlobalDb();
      try {
        cleanupDb.prepare(`
          UPDATE budgets
          SET status = 'deleted',
              deleted_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(userId);
        cleanupDb.prepare("DELETE FROM budgets WHERE id = ?").run(userId);
        cleanupDb.prepare("DELETE FROM accounts WHERE id = ?").run(userId);
        cleanupDb.prepare("DELETE FROM users WHERE id = ?").run(userId);
      } finally {
        cleanupDb.close();
      }
      if (typeof deleteCashflowUserStorage === "function") {
        try {
          deleteCashflowUserStorage(userId);
        } catch (cleanupError) {
          logError("cashflow_user_storage_cleanup_failed", {
            userId,
            error: cleanupError.message
          });
        }
      }
      throw error;
    }

    return resolveBudgetContext(userId, {
      accountId: userId,
      skipStorageExistenceCheck: true
    }).session;
  }

  function selectUser(userId = "") {
    const normalizedId = normalizeUserId(userId);
    if (normalizedId !== "local" && !userExists(normalizedId)) {
      throw userNotFoundError(normalizedId);
    }

    const db = openGlobalDb();
    try {
      ensureUserMetadata(db, normalizedId);
      db.prepare(`
        UPDATE users
        SET last_selected_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(normalizedId);
      openPlanningDb(normalizedId).close();
      ensureCompatibilityBudget(db, normalizedId, metadataUser(db, normalizedId)?.display_name);
      const ownerAccountId = db.prepare(`
        SELECT account_id
        FROM budget_memberships
        WHERE budget_id = ? AND role = 'owner'
      `).get(normalizedId)?.account_id;
      return resolveBudgetContext(normalizedId, {
        accountId: ownerAccountId || LEGACY_ADMIN_ACCOUNT_ID
      }).session;
    } finally {
      db.close();
    }
  }

  function resolveSession(userId = "") {
    if (!String(userId || "").trim()) {
      return {
        authenticated: false,
        userId: "",
        displayName: "",
        permissions: []
      };
    }

    return resolveBudgetContext(userId).session;
  }

  function resolveAccountContext(accountId = "") {
    const normalizedId = normalizeUserId(accountId);
    const db = openGlobalDb();
    try {
      const account = db.prepare(`
        SELECT id, display_name, status
        FROM accounts
        WHERE id = ?
      `).get(normalizedId);
      if (!account || account.status !== "active") {
        throw userNotFoundError(normalizedId);
      }
      const globalRoles = db.prepare(`
        SELECT role
        FROM account_global_roles
        WHERE account_id = ?
        ORDER BY role
      `).all(normalizedId).map(row => row.role);
      const capabilities = capabilitiesFor({ globalRoles });
      const permissions = capabilities.includes(CAPABILITIES.SYSTEM_ADMIN) ? ["admin"] : [];

      return {
        account: {
          id: account.id,
          displayName: account.display_name,
          status: account.status
        },
        authenticated: true,
        authMode: "none",
        budget: null,
        capabilities,
        globalRoles,
        session: {
          authenticated: true,
          accountId: account.id,
          accountDisplayName: account.display_name,
          authMode: "none",
          budgetId: "",
          budgetDisplayName: "",
          budgetRole: "",
          capabilities,
          displayName: account.display_name,
          globalRoles,
          permissions,
          userId: ""
        },
        storageKey: null
      };
    } finally {
      db.close();
    }
  }

  function resolveBudgetContext(budgetId = "", {
    accountId = LEGACY_ADMIN_ACCOUNT_ID,
    skipStorageExistenceCheck = false
  } = {}) {
    const normalizedId = normalizeUserId(budgetId);
    const db = openGlobalDb();
    try {
      let budget = budgetMetadata(db, normalizedId);
      if (!budget) {
        const storageExists = normalizedId === "local"
          || (typeof cashflowUserStorageExists === "function" && cashflowUserStorageExists(normalizedId));
        if (!storageExists) {
          throw userNotFoundError(normalizedId);
        }

        let metadata = metadataUser(db, normalizedId);
        if (!metadata) {
          ensureUserMetadata(db, normalizedId);
          metadata = metadataUser(db, normalizedId);
        }
        ensureCompatibilityBudget(db, normalizedId, metadata?.display_name);
        budget = budgetMetadata(db, normalizedId);
      }

      if (
        !budget
        || budget.status !== "active"
        || (
          typeof cashflowUserStorageExists === "function"
          && !skipStorageExistenceCheck
          && !cashflowUserStorageExists(budget.storage_key)
        )
      ) {
        throw userNotFoundError(normalizedId);
      }

      const account = db.prepare(`
        SELECT id, display_name, status
        FROM accounts
        WHERE id = ?
      `).get(accountId);
      const globalRoles = db.prepare(`
        SELECT role
        FROM account_global_roles
        WHERE account_id = ?
        ORDER BY role
      `).all(accountId).map(row => row.role);
      const membership = db.prepare(`
        SELECT role
        FROM budget_memberships
        WHERE budget_id = ? AND account_id = ?
      `).get(budget.id, accountId);
      if (!account || account.status !== "active" || !membership) {
        throw forbidden("Budget access denied");
      }
      const capabilities = capabilitiesFor({
        budgetRole: membership?.role || "",
        globalRoles
      });
      const permissions = capabilities.includes(CAPABILITIES.SYSTEM_ADMIN) ? ["admin"] : [];

      return {
        account: account ? {
          id: account.id,
          displayName: account.display_name,
          status: account.status
        } : null,
        authenticated: Boolean(account && membership),
        authMode: "none",
        budget: {
          id: budget.id,
          displayName: budget.display_name,
          role: membership?.role || "",
          status: budget.status,
          storageKey: budget.storage_key
        },
        capabilities,
        globalRoles,
        session: {
          authenticated: Boolean(account && membership),
          accountId: account?.id || "",
          accountDisplayName: account?.display_name || "",
          authMode: "none",
          budgetId: budget.id,
          budgetDisplayName: budget.display_name,
          budgetRole: membership?.role || "",
          capabilities,
          displayName: budget.display_name,
          globalRoles,
          permissions,
          userId: budget.id
        },
        storageKey: budget.storage_key
      };
    } finally {
      db.close();
    }
  }

  function updateGlobalOptions(updates = {}) {
    const current = getGlobalOptions();
    const normalized = validateAndNormalizeSettings(updates, {
      allowedKeys: GLOBAL_OPTIONS_KEYS,
      allowedKeysOnly: true,
      currentSettings: current,
      normalizeLocale
    });
    const safe = {
      ...current,
      ...normalized
    };

    const db = openGlobalDb();
    try {
      db.prepare(`
        UPDATE global_options
        SET ledger_currency = ?,
            locale = ?,
            timezone = ?,
            holiday_country = ?,
            future_periods = ?,
            fx_provider = ?,
            fx_buffer_percent = ?,
            updated_at = datetime('now')
        WHERE id = 1
      `).run(
        safe.ledger_currency,
        safe.locale,
        safe.timezone,
        safe.holiday_country,
        safe.future_periods,
        safe.fx_provider,
        safe.fx_buffer_percent
      );
    } finally {
      db.close();
    }

    return getGlobalOptions();
  }

  function authConfigFromRow(row = {}) {
    const activeMode = normalizeAuthMode(row.active_mode || "none", "activeMode");
    const draftMode = normalizeAuthMode(row.draft_mode || activeMode, "draftMode");
    return {
      activeConfig: safeJsonParseObject(row.external_config_json || "{}", "activeConfig"),
      activeMode,
      activationAvailable: draftMode === "none",
      bootstrapCompletedAt: row.bootstrap_completed_at || null,
      draftConfig: normalizeDraftAuthConfig(safeJsonParseObject(row.draft_config_json || "{}", "draftConfig")),
      draftMode,
      sessionAbsoluteMinutes: Number(row.session_absolute_minutes) || 10080,
      sessionIdleMinutes: Number(row.session_idle_minutes) || 720,
      updatedAt: row.updated_at || null
    };
  }

  function getAdminAuthConfig() {
    const db = openGlobalDb();
    try {
      const row = db.prepare("SELECT * FROM auth_config WHERE id = 1").get();
      return authConfigFromRow(row || {});
    } finally {
      db.close();
    }
  }

  function countActiveSystemAdmins(db) {
    return Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM account_global_roles agr
      JOIN accounts a ON a.id = agr.account_id
      WHERE agr.role = 'system_admin'
        AND a.status = 'active'
    `).get()?.count || 0);
  }

  function countActiveInternalSystemAdmins(db) {
    return Number(db.prepare(`
      SELECT COUNT(DISTINCT a.id) AS count
      FROM account_global_roles agr
      JOIN accounts a ON a.id = agr.account_id
      WHERE agr.role = 'system_admin'
        AND a.status = 'active'
        AND (
          (
            COALESCE(a.email, '') != ''
            AND EXISTS (
              SELECT 1
              FROM password_credentials pc
              WHERE pc.account_id = a.id
            )
          )
          OR EXISTS (
            SELECT 1
            FROM auth_identities ai
            JOIN auth_providers ap ON ap.id = ai.provider_id
            WHERE ai.account_id = a.id
              AND ap.enabled = 1
          )
        )
    `).get()?.count || 0);
  }

  function countActiveExternalSystemAdmins(db, externalConfig = {}) {
    const providerId = externalProviderId(externalConfig);
    return Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM account_global_roles agr
      JOIN accounts a ON a.id = agr.account_id
      JOIN auth_identities ai ON ai.account_id = a.id
      WHERE agr.role = 'system_admin'
        AND a.status = 'active'
        AND ai.provider_id = ?
    `).get(providerId)?.count || 0);
  }

  function genericLoginError() {
    return unauthorized("Invalid email or password");
  }

  function requestHeader(headers = {}, name = "") {
    return String(headers[String(name || "").toLowerCase()] || "").trim();
  }

  function externalSecretForConfig(externalConfig = {}) {
    const envName = normalizeEnvName(externalConfig.assertionSecretEnv || DEFAULT_EXTERNAL_SECRET_ENV, "external.assertionSecretEnv");
    return String(process.env[envName] || "");
  }

  function externalEmailAllowed(email, allowedDomains = []) {
    if (!allowedDomains.length) return true;
    const domain = String(email || "").split("@").pop()?.toLowerCase() || "";
    return allowedDomains.map(item => String(item || "").toLowerCase()).includes(domain);
  }

  function externalDisplayName(subject, displayName = "", email = "") {
    return normalizeAccountDisplayName(displayName || email || subject, "displayName");
  }

  function externalGroups(value) {
    return String(value || "")
      .split(/[,\n;]/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  function providerConfigFromRow(row) {
    if (!row) return null;
    const config = safeJsonParseObject(row.config_json || "{}", "provider.config");
    return {
      id: row.id,
      kind: row.kind,
      displayName: row.display_name,
      enabled: Number(row.enabled || 0) === 1,
      issuer: row.issuer || "",
      clientId: row.client_id || "",
      secretConfigured: Boolean(secretValueFromRef(row.secret_ref || "")),
      config: {
        authorizationEndpoint: config.authorizationEndpoint || "",
        displayNameField: config.displayNameField || "name",
        emailField: config.emailField || "email",
        emailVerifiedField: config.emailVerifiedField || "email_verified",
        redirectUri: config.redirectUri || "",
        scope: config.scope || PROVIDER_PRESETS[row.kind]?.scope || "openid email profile",
        subjectField: config.subjectField || "sub",
        tokenEndpoint: config.tokenEndpoint || "",
        userInfoEndpoint: config.userInfoEndpoint || ""
      },
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null
    };
  }

  function normalizeProviderPayload(providerId, input = {}, existing = null) {
    assertNoInlineSecrets(input, "provider");
    const existingConfig = existing ? safeJsonParseObject(existing.config_json || "{}", "provider.config") : {};
    const kind = Object.prototype.hasOwnProperty.call(input, "kind")
      ? normalizeAuthProviderKind(input.kind, "kind")
      : existing?.kind || "oidc";
    const preset = PROVIDER_PRESETS[kind] || PROVIDER_PRESETS.oidc;
    const displayName = Object.prototype.hasOwnProperty.call(input, "displayName")
      || Object.prototype.hasOwnProperty.call(input, "display_name")
        ? normalizeOptionalAuthString(input.displayName ?? input.display_name, "displayName", { max: 120, required: true })
        : existing?.display_name || preset.displayName || providerId;
    const enabled = Object.prototype.hasOwnProperty.call(input, "enabled")
      ? normalizeAdminBoolean(input.enabled, "enabled")
      : Number(existing?.enabled || 0) === 1;
    const issuer = Object.prototype.hasOwnProperty.call(input, "issuer")
      ? normalizeOptionalUrl(input.issuer, "issuer", { required: kind === "oidc" || kind === "google" })
      : existing?.issuer || preset.issuer || "";
    const clientId = Object.prototype.hasOwnProperty.call(input, "clientId")
      || Object.prototype.hasOwnProperty.call(input, "client_id")
        ? normalizeOptionalAuthString(input.clientId ?? input.client_id, "clientId", { max: 300, required: enabled })
        : existing?.client_id || "";
    const secretRef = normalizeSecretReference(input, existing?.secret_ref || "");
    const nextConfig = {
      authorizationEndpoint: Object.prototype.hasOwnProperty.call(input, "authorizationEndpoint")
        || Object.prototype.hasOwnProperty.call(input, "authorization_endpoint")
          ? normalizeOptionalUrl(input.authorizationEndpoint ?? input.authorization_endpoint, "authorizationEndpoint")
          : existingConfig.authorizationEndpoint || preset.authorizationEndpoint || "",
      displayNameField: Object.prototype.hasOwnProperty.call(input, "displayNameField")
        || Object.prototype.hasOwnProperty.call(input, "display_name_field")
          ? normalizeOptionalAuthString(input.displayNameField ?? input.display_name_field, "displayNameField", { max: 80 }) || "name"
          : existingConfig.displayNameField || "name",
      emailField: Object.prototype.hasOwnProperty.call(input, "emailField")
        || Object.prototype.hasOwnProperty.call(input, "email_field")
          ? normalizeOptionalAuthString(input.emailField ?? input.email_field, "emailField", { max: 80 }) || "email"
          : existingConfig.emailField || preset.emailField || "email",
      emailVerifiedField: Object.prototype.hasOwnProperty.call(input, "emailVerifiedField")
        || Object.prototype.hasOwnProperty.call(input, "email_verified_field")
          ? normalizeOptionalAuthString(input.emailVerifiedField ?? input.email_verified_field, "emailVerifiedField", { max: 80 })
          : existingConfig.emailVerifiedField ?? preset.emailVerifiedField ?? "email_verified",
      redirectUri: Object.prototype.hasOwnProperty.call(input, "redirectUri")
        || Object.prototype.hasOwnProperty.call(input, "redirect_uri")
          ? normalizeOptionalUrl(input.redirectUri ?? input.redirect_uri, "redirectUri", { required: enabled })
          : existingConfig.redirectUri || "",
      scope: Object.prototype.hasOwnProperty.call(input, "scope")
        ? normalizeOptionalAuthString(input.scope, "scope", { max: 500 }) || preset.scope || "openid email profile"
        : existingConfig.scope || preset.scope || "openid email profile",
      subjectField: Object.prototype.hasOwnProperty.call(input, "subjectField")
        || Object.prototype.hasOwnProperty.call(input, "subject_field")
          ? normalizeOptionalAuthString(input.subjectField ?? input.subject_field, "subjectField", { max: 80 }) || "sub"
          : existingConfig.subjectField || preset.subjectField || "sub",
      tokenEndpoint: Object.prototype.hasOwnProperty.call(input, "tokenEndpoint")
        || Object.prototype.hasOwnProperty.call(input, "token_endpoint")
          ? normalizeOptionalUrl(input.tokenEndpoint ?? input.token_endpoint, "tokenEndpoint")
          : existingConfig.tokenEndpoint || preset.tokenEndpoint || "",
      userInfoEndpoint: Object.prototype.hasOwnProperty.call(input, "userInfoEndpoint")
        || Object.prototype.hasOwnProperty.call(input, "user_info_endpoint")
          ? normalizeOptionalUrl(input.userInfoEndpoint ?? input.user_info_endpoint, "userInfoEndpoint")
          : existingConfig.userInfoEndpoint || preset.userInfoEndpoint || ""
    };

    if (enabled) {
      if (!clientId) throw badRequest("clientId is required before enabling a provider", [{ field: "clientId", reason: "required" }]);
      if (!nextConfig.redirectUri) throw badRequest("redirectUri is required before enabling a provider", [{ field: "redirectUri", reason: "required" }]);
      if ((kind === "oidc" || kind === "google") && !issuer) {
        throw badRequest("issuer is required before enabling an OIDC provider", [{ field: "issuer", reason: "required" }]);
      }
      if ((kind === "github" || kind === "facebook") && (!nextConfig.authorizationEndpoint || !nextConfig.tokenEndpoint || !nextConfig.userInfoEndpoint)) {
        throw badRequest("OAuth providers require authorization, token, and userinfo endpoints", [{
          field: "authorizationEndpoint",
          reason: "required"
        }]);
      }
    }

    return {
      clientId,
      config: nextConfig,
      displayName,
      enabled,
      issuer,
      kind,
      secretRef
    };
  }

  function listAuthProviders({ publicOnly = false } = {}) {
    const db = openGlobalDb();
    try {
      const rows = db.prepare(`
        SELECT *
        FROM auth_providers
        ${publicOnly ? "WHERE enabled = 1" : ""}
        ORDER BY display_name COLLATE NOCASE, id
      `).all();
      return rows.map(providerConfigFromRow).filter(Boolean);
    } finally {
      db.close();
    }
  }

  function authProviderRow(db, providerId) {
    const id = normalizeAuthProviderId(providerId);
    const row = db.prepare("SELECT * FROM auth_providers WHERE id = ?").get(id);
    if (!row) throw notFound("Authentication provider not found");
    return row;
  }

  function upsertAdminAuthProvider(actorAccountId, providerId, input = {}) {
    const id = normalizeAuthProviderId(providerId);
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const existing = db.prepare("SELECT * FROM auth_providers WHERE id = ?").get(id);
        const next = normalizeProviderPayload(id, input, existing || null);
        db.prepare(`
          INSERT INTO auth_providers (
            id, kind, display_name, enabled, issuer, client_id, secret_ref,
            config_json, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            display_name = excluded.display_name,
            enabled = excluded.enabled,
            issuer = excluded.issuer,
            client_id = excluded.client_id,
            secret_ref = excluded.secret_ref,
            config_json = excluded.config_json,
            updated_at = datetime('now')
        `).run(
          id,
          next.kind,
          next.displayName,
          next.enabled ? 1 : 0,
          next.issuer,
          next.clientId,
          next.secretRef,
          JSON.stringify(next.config)
        );
        auditGlobalSecurity(db, {
          action: "admin_auth_provider_upsert",
          actorAccountId,
          details: {
            enabled: next.enabled,
            kind: next.kind,
            providerId: id
          },
          targetId: id,
          targetType: "auth_provider"
        });
        result = providerConfigFromRow(db.prepare("SELECT * FROM auth_providers WHERE id = ?").get(id));
      })();
      return result;
    } finally {
      db.close();
    }
  }

  function deleteAdminAuthProvider(actorAccountId, providerId) {
    const id = normalizeAuthProviderId(providerId);
    const db = openGlobalDb();
    try {
      db.transaction(() => {
        const row = authProviderRow(db, id);
        db.prepare("DELETE FROM auth_providers WHERE id = ?").run(row.id);
        auditGlobalSecurity(db, {
          action: "admin_auth_provider_delete",
          actorAccountId,
          targetId: id,
          targetType: "auth_provider"
        });
      })();
      return { deleted: true, providerId: id };
    } finally {
      db.close();
    }
  }

  function providerSubjectFromProfile(provider, profile = {}) {
    const field = provider.config.subjectField || "sub";
    return normalizeExternalSubject(profile[field], "subject");
  }

  function providerEmailFromProfile(provider, profile = {}) {
    const field = provider.config.emailField || "email";
    const value = field ? profile[field] : "";
    return value ? normalizeAccountEmail(value, "email") : null;
  }

  function providerEmailVerifiedFromProfile(provider, profile = {}) {
    const field = provider.config.emailVerifiedField || "email_verified";
    if (!field) return false;
    const value = profile[field];
    return value === true || value === 1 || value === "true" || value === "1";
  }

  function providerDisplayNameFromProfile(provider, profile = {}, fallback = "") {
    const field = provider.config.displayNameField || "name";
    return normalizeAccountDisplayName(profile[field] || fallback || profile.email || profile.sub || "Account", "displayName");
  }

  function providerSecret(providerId) {
    const db = openGlobalDb();
    try {
      return secretValueFromRef(authProviderRow(db, providerId).secret_ref || "");
    } finally {
      db.close();
    }
  }

  function providerClientMetadata(provider, secret = "") {
    return {
      ...(secret ? { client_secret: secret } : {}),
      redirect_uris: [provider.config.redirectUri]
    };
  }

  async function oidcConfigurationForProvider(provider) {
    const secret = providerSecret(provider.id);
    const metadata = providerClientMetadata(provider, secret);
    if (provider.kind === "oidc" || provider.kind === "google") {
      return oidcClient.discovery(new URL(provider.issuer), provider.clientId, metadata, undefined, {
        timeout: 10
      });
    }
    return new oidcClient.Configuration({
      authorization_endpoint: provider.config.authorizationEndpoint,
      issuer: provider.issuer || provider.id,
      token_endpoint: provider.config.tokenEndpoint,
      userinfo_endpoint: provider.config.userInfoEndpoint
    }, provider.clientId, metadata);
  }

  async function authorizationUrlForProvider(provider, { nonce, state, codeVerifier }) {
    const codeChallenge = await oidcClient.calculatePKCECodeChallenge(codeVerifier);
    if (typeof authProviderHook === "function") {
      const hooked = await authProviderHook({
        action: "authorization_url",
        codeChallenge,
        nonce,
        provider,
        state
      });
      if (hooked?.authorizationUrl) return hooked.authorizationUrl;
    }
    const config = await oidcConfigurationForProvider(provider);
    const url = oidcClient.buildAuthorizationUrl(config, {
      client_id: provider.clientId,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      nonce,
      redirect_uri: provider.config.redirectUri,
      response_type: "code",
      scope: provider.config.scope,
      state
    });
    return url.href;
  }

  async function providerProfileFromCallback(provider, callbackUrl, stateRow) {
    if (typeof authProviderHook === "function") {
      const hooked = await authProviderHook({
        action: "callback",
        callbackUrl,
        provider,
        state: stateRow
      });
      if (hooked?.profile) return hooked.profile;
    }
    const config = await oidcConfigurationForProvider(provider);
    const tokens = await oidcClient.authorizationCodeGrant(
      config,
      new URL(callbackUrl),
      {
        expectedNonce: stateRow.nonce,
        expectedState: String(new URL(callbackUrl).searchParams.get("state") || ""),
        pkceCodeVerifier: stateRow.code_verifier
      }
    );
    const claims = typeof tokens.claims === "function" ? tokens.claims() || {} : {};
    if (claims.sub) return claims;
    if (tokens.access_token) {
      const info = await oidcClient.fetchUserInfo(config, tokens.access_token, oidcClient.skipSubjectCheck);
      return info || {};
    }
    throw unauthorized("Authentication provider did not return an identity");
  }

  function authProviderForUse(db, providerId) {
    const provider = providerConfigFromRow(authProviderRow(db, providerId));
    if (!provider.enabled) throw forbidden("Authentication provider is disabled");
    if (!provider.clientId || !provider.config.redirectUri) {
      throw conflict("Authentication provider is incomplete");
    }
    return provider;
  }

  async function startAuthProviderLogin(providerId) {
    const db = openGlobalDb();
    try {
      let stateRow;
      let provider;
      db.transaction(() => {
        const config = db.prepare("SELECT active_mode FROM auth_config WHERE id = 1").get() || {};
        if ((config.active_mode || "none") !== "internal") {
          throw forbidden("Provider login is available only in internal authentication mode");
        }
        provider = authProviderForUse(db, providerId);
        const state = oidcClient.randomState();
        const codeVerifier = oidcClient.randomPKCECodeVerifier();
        const nonce = oidcClient.randomNonce();
        const expiresAt = addMinutesIso(OAUTH_STATE_TTL_MINUTES);
        stateRow = {
          code_verifier: codeVerifier,
          nonce,
          provider_id: provider.id,
          redirect_uri: provider.config.redirectUri,
          state,
          state_hash: authTokenHash(state)
        };
        db.prepare(`
          INSERT INTO auth_oauth_states (
            id, state_hash, provider_id, account_id, purpose, code_verifier,
            nonce, redirect_uri, status, expires_at, consumed_at, created_at, updated_at
          )
          VALUES (?, ?, ?, NULL, 'login', ?, ?, ?, 'pending', ?, NULL, datetime('now'), datetime('now'))
        `).run(
          `oauth_state_${crypto.randomUUID()}`,
          stateRow.state_hash,
          provider.id,
          codeVerifier,
          nonce,
          provider.config.redirectUri,
          expiresAt
        );
      })();
      return {
        authorizationUrl: await authorizationUrlForProvider(provider, {
          codeVerifier: stateRow.code_verifier,
          nonce: stateRow.nonce,
          state: stateRow.state
        }),
        provider
      };
    } finally {
      db.close();
    }
  }

  async function startAuthProviderLink(actorAccountId, providerId) {
    const accountId = normalizeUserId(actorAccountId);
    const db = openGlobalDb();
    try {
      let stateRow;
      let provider;
      db.transaction(() => {
        const config = db.prepare("SELECT active_mode FROM auth_config WHERE id = 1").get() || {};
        if ((config.active_mode || "none") !== "internal") {
          throw forbidden("Provider linking is available only in internal authentication mode");
        }
        const account = accountExistsRow(db, accountId);
        if (account.status !== "active") throw conflict("Only active accounts can link authentication providers");
        provider = authProviderForUse(db, providerId);
        const state = oidcClient.randomState();
        const codeVerifier = oidcClient.randomPKCECodeVerifier();
        const nonce = oidcClient.randomNonce();
        const expiresAt = addMinutesIso(OAUTH_STATE_TTL_MINUTES);
        stateRow = {
          code_verifier: codeVerifier,
          nonce,
          provider_id: provider.id,
          redirect_uri: provider.config.redirectUri,
          state,
          state_hash: authTokenHash(state)
        };
        db.prepare(`
          INSERT INTO auth_oauth_states (
            id, state_hash, provider_id, account_id, purpose, code_verifier,
            nonce, redirect_uri, status, expires_at, consumed_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'link', ?, ?, ?, 'pending', ?, NULL, datetime('now'), datetime('now'))
        `).run(
          `oauth_state_${crypto.randomUUID()}`,
          stateRow.state_hash,
          provider.id,
          accountId,
          codeVerifier,
          nonce,
          provider.config.redirectUri,
          expiresAt
        );
      })();
      return {
        authorizationUrl: await authorizationUrlForProvider(provider, {
          codeVerifier: stateRow.code_verifier,
          nonce: stateRow.nonce,
          state: stateRow.state
        }),
        provider
      };
    } finally {
      db.close();
    }
  }

  async function completeAuthProviderCallback(providerId, callbackUrl) {
    const id = normalizeAuthProviderId(providerId);
    const currentUrl = new URL(callbackUrl);
    const state = String(currentUrl.searchParams.get("state") || "");
    if (!state) throw badRequest("OAuth state is required", [{ field: "state", reason: "required" }]);
    const db = openGlobalDb();
    try {
      let stateRow;
      let provider;
      db.transaction(() => {
        provider = authProviderForUse(db, id);
        stateRow = db.prepare(`
          SELECT *
          FROM auth_oauth_states
          WHERE state_hash = ? AND provider_id = ?
        `).get(authTokenHash(state), provider.id);
        if (!stateRow || stateRow.status !== "pending" || Date.parse(stateRow.expires_at) <= Date.now()) {
          if (stateRow?.status === "pending") {
            db.prepare(`
              UPDATE auth_oauth_states
              SET status = 'expired',
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(stateRow.id);
          }
          throw unauthorized("Authentication state is invalid or expired");
        }
      })();

      const profile = await providerProfileFromCallback(provider, currentUrl.href, stateRow);
      const subject = providerSubjectFromProfile(provider, profile);
      const email = providerEmailFromProfile(provider, profile);
      const emailVerified = providerEmailVerifiedFromProfile(provider, profile);
      const displayName = providerDisplayNameFromProfile(provider, profile, email || subject);
      let result;

      db.transaction(() => {
        const freshState = db.prepare("SELECT * FROM auth_oauth_states WHERE id = ?").get(stateRow.id);
        if (!freshState || freshState.status !== "pending") {
          throw unauthorized("Authentication state is invalid or expired");
        }
        const existing = db.prepare(`
          SELECT ai.account_id, a.status
          FROM auth_identities ai
          JOIN accounts a ON a.id = ai.account_id
          WHERE ai.provider_id = ? AND ai.subject = ?
        `).get(provider.id, subject);

        if (freshState.purpose === "link") {
          if (!freshState.account_id) throw unauthorized("Authentication state is invalid or expired");
          if (!email || !emailVerified) {
            throw forbidden("A verified provider email is required before linking an identity");
          }
          if (existing && existing.account_id !== freshState.account_id) {
            throw conflict("Provider identity is already linked to another account", [{
              field: "subject",
              reason: "not_unique"
            }]);
          }
          accountExistsRow(db, freshState.account_id);
          db.prepare(`
            INSERT INTO auth_identities (
              id, account_id, provider_id, subject, email, email_verified,
              profile_json, created_at, updated_at, last_used_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
            ON CONFLICT(provider_id, subject) DO UPDATE SET
              account_id = excluded.account_id,
              email = excluded.email,
              email_verified = excluded.email_verified,
              profile_json = excluded.profile_json,
              last_used_at = datetime('now'),
              updated_at = datetime('now')
          `).run(
            `identity_${crypto.randomUUID()}`,
            freshState.account_id,
            provider.id,
            subject,
            email,
            emailVerified ? 1 : 0,
            JSON.stringify({
              displayName,
              providerKind: provider.kind
            })
          );
          result = {
            accountId: freshState.account_id,
            linked: true
          };
          auditGlobalSecurity(db, {
            action: "internal_provider_identity_link",
            actorAccountId: freshState.account_id,
            details: {
              providerId: provider.id
            },
            targetId: freshState.account_id,
            targetType: "account"
          });
        } else {
          if (!existing || existing.status !== "active") {
            throw unauthorized("Provider login is not linked to an active account");
          }
          db.prepare(`
            UPDATE auth_identities
            SET email = COALESCE(?, email),
                email_verified = ?,
                profile_json = ?,
                last_used_at = datetime('now'),
                updated_at = datetime('now')
            WHERE provider_id = ? AND subject = ?
          `).run(
            email,
            emailVerified ? 1 : 0,
            JSON.stringify({
              displayName,
              providerKind: provider.kind
            }),
            provider.id,
            subject
          );
          result = {
            accountId: existing.account_id,
            linked: false
          };
          auditGlobalSecurity(db, {
            action: "internal_provider_login",
            actorAccountId: existing.account_id,
            details: {
              providerId: provider.id
            },
            targetId: existing.account_id,
            targetType: "account"
          });
        }

        db.prepare(`
          UPDATE auth_oauth_states
          SET status = 'consumed',
              consumed_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(freshState.id);
      })();
      return result;
    } finally {
      db.close();
    }
  }

  function setAdminProviderIdentity(actorAccountId, accountId, providerId, input = {}) {
    const normalizedAccountId = normalizeUserId(accountId);
    const normalizedProviderId = normalizeAuthProviderId(providerId);
    const subject = normalizeExternalSubject(input.subject, "subject");
    const email = Object.prototype.hasOwnProperty.call(input, "email") && String(input.email || "").trim()
      ? normalizeAccountEmail(input.email, "email")
      : null;
    const emailVerified = normalizeAdminBoolean(
      Object.prototype.hasOwnProperty.call(input, "emailVerified") ? input.emailVerified :
        Object.prototype.hasOwnProperty.call(input, "email_verified") ? input.email_verified :
          true,
      "emailVerified"
    );

    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const account = accountExistsRow(db, normalizedAccountId);
        if (account.status !== "active") throw conflict("Only active accounts can receive provider identities");
        authProviderRow(db, normalizedProviderId);
        const existing = db.prepare(`
          SELECT account_id
          FROM auth_identities
          WHERE provider_id = ? AND subject = ?
        `).get(normalizedProviderId, subject);
        if (existing && existing.account_id !== normalizedAccountId) {
          throw conflict("Provider identity is already linked to another account", [{
            field: "subject",
            reason: "not_unique"
          }]);
        }
        db.prepare(`
          INSERT INTO auth_identities (
            id, account_id, provider_id, subject, email, email_verified,
            profile_json, created_at, updated_at, last_used_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL)
          ON CONFLICT(provider_id, subject) DO UPDATE SET
            account_id = excluded.account_id,
            email = excluded.email,
            email_verified = excluded.email_verified,
            profile_json = excluded.profile_json,
            updated_at = datetime('now')
        `).run(
          `identity_${crypto.randomUUID()}`,
          normalizedAccountId,
          normalizedProviderId,
          subject,
          email,
          emailVerified ? 1 : 0,
          JSON.stringify({
            linkedBy: "admin"
          })
        );
        auditGlobalSecurity(db, {
          action: "admin_provider_identity_link",
          actorAccountId,
          details: {
            providerId: normalizedProviderId
          },
          targetId: normalizedAccountId,
          targetType: "account"
        });
        result = accountSummary(db, normalizedAccountId);
      })();
      return result;
    } finally {
      db.close();
    }
  }

  function setAdminExternalIdentity(actorAccountId, accountId, input = {}) {
    const normalizedId = normalizeUserId(accountId);
    const subject = normalizeExternalSubject(input.subject, "subject");
    const email = Object.prototype.hasOwnProperty.call(input, "email") && String(input.email || "").trim()
      ? normalizeAccountEmail(input.email, "email")
      : null;
    const emailVerified = normalizeAdminBoolean(
      Object.prototype.hasOwnProperty.call(input, "emailVerified") ? input.emailVerified :
        Object.prototype.hasOwnProperty.call(input, "email_verified") ? input.email_verified :
          true,
      "emailVerified"
    );

    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const account = accountExistsRow(db, normalizedId);
        if (account.status !== "active") throw conflict("Only active accounts can receive external identities");
        const config = authConfigFromRow(db.prepare("SELECT * FROM auth_config WHERE id = 1").get() || {});
        const providerId = externalProviderId(config.draftConfig.external);
        const existing = db.prepare(`
          SELECT account_id
          FROM auth_identities
          WHERE provider_id = ? AND subject = ?
        `).get(providerId, subject);
        if (existing && existing.account_id !== normalizedId) {
          throw conflict("External identity is already linked to another account", [{
            field: "subject",
            reason: "not_unique"
          }]);
        }

        db.prepare(`
          INSERT INTO auth_identities (
            id, account_id, provider_id, subject, email, email_verified,
            profile_json, created_at, updated_at, last_used_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL)
          ON CONFLICT(provider_id, subject) DO UPDATE SET
            account_id = excluded.account_id,
            email = excluded.email,
            email_verified = excluded.email_verified,
            profile_json = excluded.profile_json,
            updated_at = datetime('now')
        `).run(
          `identity_${crypto.randomUUID()}`,
          normalizedId,
          providerId,
          subject,
          email,
          emailVerified ? 1 : 0,
          JSON.stringify({
            trustedIssuer: config.draftConfig.external.trustedIssuer || ""
          })
        );
        auditGlobalSecurity(db, {
          action: "admin_external_identity_link",
          actorAccountId,
          details: {
            providerId
          },
          targetId: normalizedId,
          targetType: "account"
        });
        result = accountSummary(db, normalizedId);
      })();
      return result;
    } finally {
      db.close();
    }
  }

  async function createAdminPasswordResetToken(actorAccountId, accountId, input = {}) {
    const normalizedId = normalizeUserId(accountId);
    const purpose = String(input.purpose || "password_reset").trim() === "password_setup"
      ? "password_setup"
      : "password_reset";
    const email = Object.prototype.hasOwnProperty.call(input, "email")
      ? normalizeAccountEmail(input.email, "email")
      : null;
    const token = randomAuthToken();
    const tokenHash = authTokenHash(token);
    const expiresAt = addHoursIso(PASSWORD_TOKEN_TTL_HOURS);

    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const account = accountExistsRow(db, normalizedId);
        if (account.status !== "active") throw conflict("Only active accounts can receive password setup links");

        if (email && email !== account.email) {
          if (db.prepare("SELECT 1 FROM accounts WHERE email = ? AND id != ?").get(email, normalizedId)) {
            throw conflict("Email is already assigned to another account", [{
              field: "email",
              reason: "not_unique"
            }]);
          }
          db.prepare(`
            UPDATE accounts
            SET email = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).run(email, normalizedId);
        }

        const effectiveEmail = email || account.email;
        if (!effectiveEmail) {
          throw badRequest("Account email is required before issuing an internal login setup link", [{
            field: "email",
            reason: "required"
          }]);
        }

        db.prepare(`
          UPDATE password_reset_tokens
          SET status = 'revoked',
              updated_at = datetime('now')
          WHERE account_id = ?
            AND status = 'pending'
        `).run(normalizedId);
        db.prepare(`
          INSERT INTO password_reset_tokens (
            id, account_id, token_hash, purpose, status, expires_at,
            consumed_at, created_by_account_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, datetime('now'), datetime('now'))
        `).run(
          `password_token_${crypto.randomUUID()}`,
          normalizedId,
          tokenHash,
          purpose,
          expiresAt,
          actorAccountId || null
        );
        auditGlobalSecurity(db, {
          action: purpose === "password_setup" ? "admin_password_setup_token_create" : "admin_password_reset_token_create",
          actorAccountId,
          details: {
            expiresAt,
            purpose
          },
          targetId: normalizedId,
          targetType: "account"
        });
        result = {
          account: accountSummary(db, normalizedId),
          expiresAt,
          purpose,
          token
        };
      })();
      return result;
    } finally {
      db.close();
    }
  }

  async function completeInternalPasswordSetup(input = {}) {
    const rawToken = String(input.token || "").trim();
    if (!rawToken) {
      throw badRequest("Password setup token is invalid or expired", [{
        field: "token",
        reason: "invalid_or_expired"
      }]);
    }
    const password = normalizePassword(input.password, "password");
    const passwordHash = await argon2.hash(passwordMaterial(password), {
      type: argon2.argon2id
    });
    const tokenHash = authTokenHash(rawToken);
    const nowMs = Date.now();

    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const tokenRow = db.prepare(`
          SELECT prt.*, a.email, a.display_name, a.status AS account_status
          FROM password_reset_tokens prt
          JOIN accounts a ON a.id = prt.account_id
          WHERE prt.token_hash = ?
            AND prt.status = 'pending'
        `).get(tokenHash);
        if (!tokenRow || Date.parse(tokenRow.expires_at) <= nowMs || tokenRow.account_status !== "active") {
          if (tokenRow && Date.parse(tokenRow.expires_at) <= nowMs) {
            db.prepare(`
              UPDATE password_reset_tokens
              SET status = 'expired',
                  updated_at = datetime('now')
              WHERE id = ?
            `).run(tokenRow.id);
          }
          throw badRequest("Password setup token is invalid or expired", [{
            field: "token",
            reason: "invalid_or_expired"
          }]);
        }
        if (!tokenRow.email) {
          throw conflict("Account email is required before setting an internal login password");
        }

        db.prepare(`
          INSERT INTO password_credentials (
            account_id, password_hash, password_changed_at, failed_attempts,
            locked_until, created_at, updated_at
          )
          VALUES (?, ?, datetime('now'), 0, NULL, datetime('now'), datetime('now'))
          ON CONFLICT(account_id) DO UPDATE SET
            password_hash = excluded.password_hash,
            password_changed_at = excluded.password_changed_at,
            failed_attempts = 0,
            locked_until = NULL,
            updated_at = datetime('now')
        `).run(tokenRow.account_id, passwordHash);
        db.prepare(`
          UPDATE password_reset_tokens
          SET status = 'consumed',
              consumed_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(tokenRow.id);
        db.prepare(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE account_id = ?
            AND revoked_at IS NULL
        `).run(tokenRow.account_id);
        auditGlobalSecurity(db, {
          action: tokenRow.purpose === "password_setup" ? "password_setup_complete" : "password_reset_complete",
          actorAccountId: tokenRow.account_id,
          targetId: tokenRow.account_id,
          targetType: "account"
        });
        result = {
          account: accountSummary(db, tokenRow.account_id),
          ok: true
        };
      })();
      return result;
    } finally {
      db.close();
    }
  }

  async function authenticateInternalLogin(input = {}) {
    let email;
    try {
      email = normalizeAccountEmail(input.email, "email");
      normalizePassword(input.password, "password");
    } catch {
      throw genericLoginError();
    }

    const db = openGlobalDb();
    let row;
    try {
      const config = db.prepare("SELECT active_mode, draft_config_json FROM auth_config WHERE id = 1").get() || {};
      if ((config.active_mode || "none") !== "internal") {
        throw forbidden("Internal login is disabled");
      }
      const draftConfig = normalizeDraftAuthConfig(safeJsonParseObject(config.draft_config_json || "{}", "draftConfig"));
      if (draftConfig.internal.allowPasswordLogin === false) {
        throw forbidden("Password login is disabled");
      }
      row = db.prepare(`
        SELECT a.id AS account_id, a.status, pc.password_hash, pc.failed_attempts, pc.locked_until
        FROM accounts a
        JOIN password_credentials pc ON pc.account_id = a.id
        WHERE a.email = ?
      `).get(email);
      if (
        !row
        || row.status !== "active"
        || (row.locked_until && Date.parse(row.locked_until) > Date.now())
      ) {
        throw genericLoginError();
      }
    } finally {
      db.close();
    }

    const verified = await argon2.verify(row.password_hash, passwordMaterial(input.password));
    const updateDb = openGlobalDb();
    try {
      if (!verified) {
        const attempts = Number(row.failed_attempts || 0) + 1;
        updateDb.prepare(`
          UPDATE password_credentials
          SET failed_attempts = ?,
              locked_until = CASE WHEN ? >= ? THEN ? ELSE locked_until END,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(
          attempts,
          attempts,
          PASSWORD_LOCK_THRESHOLD,
          addMinutesIso(PASSWORD_LOCK_MINUTES),
          row.account_id
        );
        auditGlobalSecurity(updateDb, {
          action: "internal_login",
          actorAccountId: row.account_id,
          outcome: "failure",
          targetId: row.account_id,
          targetType: "account"
        });
        throw genericLoginError();
      }

      const activeAccount = updateDb.prepare(`
        SELECT status
        FROM accounts
        WHERE id = ?
      `).get(row.account_id);
      if (!activeAccount || activeAccount.status !== "active") throw genericLoginError();

      updateDb.prepare(`
        UPDATE password_credentials
        SET failed_attempts = 0,
            locked_until = NULL,
            updated_at = datetime('now')
        WHERE account_id = ?
      `).run(row.account_id);
      auditGlobalSecurity(updateDb, {
        action: "internal_login",
        actorAccountId: row.account_id,
        targetId: row.account_id,
        targetType: "account"
      });
      return {
        accountId: row.account_id
      };
    } finally {
      updateDb.close();
    }
  }

  async function registerInternalAccountWithInvitation(input = {}) {
    const rawToken = String(input.invitationToken || input.invitation_token || input.token || "").trim();
    if (!rawToken) {
      throw badRequest("Invitation token is required", [{
        field: "token",
        reason: "required"
      }]);
    }
    const email = normalizeAccountEmail(input.email, "email");
    const name = normalizeAccountDisplayName(input.displayName || input.display_name || email, "displayName");
    const password = normalizePassword(input.password, "password");
    const passwordHash = await argon2.hash(passwordMaterial(password), {
      type: argon2.argon2id
    });
    const invitationHash = authTokenHash(rawToken);
    const accountId = `account_${crypto.randomUUID()}`;

    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const config = db.prepare("SELECT active_mode FROM auth_config WHERE id = 1").get() || {};
        if ((config.active_mode || "none") !== "internal") {
          throw forbidden("Internal registration is disabled");
        }
        const invitation = db.prepare(`
          SELECT *
          FROM budget_invitations
          WHERE token_hash = ?
        `).get(invitationHash);
        if (!invitation) throw notFound("Invitation not found");
        if (invitation.status !== "pending") throw conflict("Invitation is no longer available");
        if (Date.parse(`${invitation.expires_at}Z`) <= Date.now()) throw conflict("Invitation has expired");
        if (invitation.target_account_id) {
          throw conflict("Invitation is assigned to an existing account");
        }
        if (!invitation.target_email) {
          throw conflict("Invitation requires an email target before account registration");
        }
        if (String(invitation.target_email || "").toLowerCase() !== email) {
          throw forbidden("Invitation target does not match the requested email");
        }
        if (db.prepare("SELECT 1 FROM accounts WHERE email = ?").get(email)) {
          throw conflict("Email is already assigned to another account", [{
            field: "email",
            reason: "not_unique"
          }]);
        }

        db.prepare(`
          INSERT INTO accounts (
            id, email, display_name, status, created_at, updated_at
          )
          VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))
        `).run(accountId, email, name);
        db.prepare(`
          INSERT INTO password_credentials (
            account_id, password_hash, password_changed_at, failed_attempts,
            locked_until, created_at, updated_at
          )
          VALUES (?, ?, datetime('now'), 0, NULL, datetime('now'), datetime('now'))
        `).run(accountId, passwordHash);
        db.prepare(`
          UPDATE budget_invitations
          SET target_account_id = ?,
              status = 'accepted',
              accepted_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'
        `).run(accountId, invitation.id);
        db.prepare(`
          INSERT INTO budget_memberships (
            budget_id, account_id, role, invited_by_account_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          invitation.budget_id,
          accountId,
          invitation.role,
          invitation.invited_by_account_id
        );
        auditGlobalSecurity(db, {
          action: "internal_invitation_register",
          actorAccountId: accountId,
          details: {
            invitationId: invitation.id,
            role: invitation.role
          },
          targetId: accountId,
          targetType: "account"
        });
        auditGlobalSecurity(db, {
          action: "budget_invitation_accept",
          actorAccountId: accountId,
          targetId: invitation.id,
          targetType: "budget_invitation"
        });
        result = {
          account: accountSummary(db, accountId),
          budgetId: invitation.budget_id,
          membership: db.prepare(`
            SELECT budget_id, account_id, role, invited_by_account_id, created_at, updated_at
            FROM budget_memberships
            WHERE budget_id = ? AND account_id = ?
          `).get(invitation.budget_id, accountId)
        };
      })();
      return result;
    } finally {
      db.close();
    }
  }

  function authenticateExternalLogin(headers = {}) {
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const config = authConfigFromRow(db.prepare("SELECT * FROM auth_config WHERE id = 1").get() || {});
        if (config.activeMode !== "external") {
          throw forbidden("External authentication is disabled");
        }
        const external = config.activeConfig.external || {};
        const expectedSecret = externalSecretForConfig(external);
        if (!expectedSecret) {
          throw forbidden("External authentication secret is not configured");
        }
        const secretHeader = external.assertionSecretHeader || DEFAULT_EXTERNAL_SECRET_HEADER;
        if (!safeSecretMatches(requestHeader(headers, secretHeader), expectedSecret)) {
          throw unauthorized("External authentication required");
        }

        const subjectHeader = external.subjectHeader || "x-auth-request-user";
        const subject = normalizeExternalSubject(requestHeader(headers, subjectHeader), "subject");
        const emailHeader = external.emailHeader || "";
        const displayNameHeader = external.displayNameHeader || "";
        const groupsHeader = external.groupsHeader || "";
        const email = emailHeader && requestHeader(headers, emailHeader)
          ? normalizeAccountEmail(requestHeader(headers, emailHeader), "email")
          : null;
        const name = externalDisplayName(
          subject,
          displayNameHeader ? requestHeader(headers, displayNameHeader) : "",
          email || ""
        );
        const groups = externalGroups(groupsHeader ? requestHeader(headers, groupsHeader) : "");
        const providerId = externalProviderId(external);

        let identity = db.prepare(`
          SELECT ai.account_id, a.status
          FROM auth_identities ai
          JOIN accounts a ON a.id = ai.account_id
          WHERE ai.provider_id = ? AND ai.subject = ?
        `).get(providerId, subject);

        if (!identity) {
          const provisioningMode = external.provisioningMode || "deny_unknown";
          if (provisioningMode === "deny_unknown") {
            throw unauthorized("External authentication required");
          }
          if (!email) {
            throw forbidden("External email is required for provisioning");
          }
          if (!externalEmailAllowed(email, external.allowedDomains || [])) {
            throw forbidden("External email domain is not allowed");
          }
          if (db.prepare("SELECT 1 FROM accounts WHERE email = ?").get(email)) {
            throw conflict("Email is already assigned to another account", [{
              field: "email",
              reason: "not_unique"
            }]);
          }

          const accountId = `account_${crypto.randomUUID()}`;
          const pendingInvitation = provisioningMode === "allow_invited"
            ? db.prepare(`
                SELECT *
                FROM budget_invitations
                WHERE target_email = ?
                  AND status = 'pending'
                  AND target_account_id IS NULL
                ORDER BY expires_at ASC, created_at ASC
                LIMIT 1
              `).get(email)
            : null;
          if (provisioningMode === "allow_invited" && (
            !pendingInvitation
            || Date.parse(`${pendingInvitation.expires_at}Z`) <= Date.now()
          )) {
            throw unauthorized("External authentication required");
          }

          db.prepare(`
            INSERT INTO accounts (
              id, email, display_name, status, created_at, updated_at
            )
            VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))
          `).run(accountId, email, name);
          if (pendingInvitation) {
            db.prepare(`
              UPDATE budget_invitations
              SET target_account_id = ?,
                  status = 'accepted',
                  accepted_at = datetime('now'),
                  updated_at = datetime('now')
              WHERE id = ? AND status = 'pending'
            `).run(accountId, pendingInvitation.id);
            db.prepare(`
              INSERT INTO budget_memberships (
                budget_id, account_id, role, invited_by_account_id, created_at, updated_at
              )
              VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
            `).run(
              pendingInvitation.budget_id,
              accountId,
              pendingInvitation.role,
              pendingInvitation.invited_by_account_id
            );
          }
          db.prepare(`
            INSERT INTO auth_identities (
              id, account_id, provider_id, subject, email, email_verified,
              profile_json, created_at, updated_at, last_used_at
            )
            VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now'), datetime('now'))
          `).run(
            `identity_${crypto.randomUUID()}`,
            accountId,
            providerId,
            subject,
            email,
            JSON.stringify({
              groups,
              trustedIssuer: external.trustedIssuer || ""
            })
          );
          auditGlobalSecurity(db, {
            action: "external_account_provision",
            actorAccountId: accountId,
            details: {
              provisioningMode,
              withInvitation: Boolean(pendingInvitation)
            },
            targetId: accountId,
            targetType: "account"
          });
          identity = {
            account_id: accountId,
            status: "active"
          };
        }

        if (identity.status !== "active") throw unauthorized("External authentication required");

        db.prepare(`
          UPDATE auth_identities
          SET email = COALESCE(?, email),
              profile_json = ?,
              last_used_at = datetime('now'),
              updated_at = datetime('now')
          WHERE provider_id = ? AND subject = ?
        `).run(
          email,
          JSON.stringify({
            groups,
            trustedIssuer: external.trustedIssuer || ""
          }),
          providerId,
          subject
        );

        const adminGroups = external.adminGroups || [];
        if (adminGroups.length && groups.some(group => adminGroups.includes(group))) {
          db.prepare(`
            INSERT OR IGNORE INTO account_global_roles (
              account_id, role, granted_by_account_id, created_at
            )
            VALUES (?, 'system_admin', NULL, datetime('now'))
          `).run(identity.account_id);
        }
        auditGlobalSecurity(db, {
          action: "external_login",
          actorAccountId: identity.account_id,
          details: {
            providerId
          },
          targetId: identity.account_id,
          targetType: "account"
        });
        result = {
          accountId: identity.account_id
        };
      })();
      return result;
    } finally {
      db.close();
    }
  }

  function updateAdminAuthDraft(actorAccountId, input = {}) {
    const current = getAdminAuthConfig();
    const draftMode = Object.prototype.hasOwnProperty.call(input, "draftMode")
      || Object.prototype.hasOwnProperty.call(input, "draft_mode")
        ? normalizeAuthMode(input.draftMode ?? input.draft_mode, "draftMode")
        : current.draftMode;
    const sessionIdleMinutes = Object.prototype.hasOwnProperty.call(input, "sessionIdleMinutes")
      || Object.prototype.hasOwnProperty.call(input, "session_idle_minutes")
        ? normalizeAuthInteger(input.sessionIdleMinutes ?? input.session_idle_minutes, "sessionIdleMinutes", { min: 5, max: 10080 })
        : current.sessionIdleMinutes;
    const sessionAbsoluteMinutes = Object.prototype.hasOwnProperty.call(input, "sessionAbsoluteMinutes")
      || Object.prototype.hasOwnProperty.call(input, "session_absolute_minutes")
        ? normalizeAuthInteger(input.sessionAbsoluteMinutes ?? input.session_absolute_minutes, "sessionAbsoluteMinutes", { min: 5, max: 43200 })
        : current.sessionAbsoluteMinutes;
    if (sessionAbsoluteMinutes < sessionIdleMinutes) {
      throw badRequest("sessionAbsoluteMinutes must be greater than or equal to sessionIdleMinutes", [{
        field: "sessionAbsoluteMinutes",
        reason: "must_be_greater_or_equal"
      }]);
    }
    const draftConfig = Object.prototype.hasOwnProperty.call(input, "draftConfig")
      || Object.prototype.hasOwnProperty.call(input, "draft_config")
        ? normalizeDraftAuthConfig(safeJsonParseObject(input.draftConfig ?? input.draft_config, "draftConfig"))
        : current.draftConfig;

    const db = openGlobalDb();
    try {
      db.transaction(() => {
        db.prepare(`
          UPDATE auth_config
          SET draft_mode = ?,
              session_idle_minutes = ?,
              session_absolute_minutes = ?,
              draft_config_json = ?,
              updated_at = datetime('now')
          WHERE id = 1
        `).run(
          draftMode,
          sessionIdleMinutes,
          sessionAbsoluteMinutes,
          JSON.stringify(draftConfig)
        );
        auditGlobalSecurity(db, {
          action: "admin_auth_draft_update",
          actorAccountId,
          details: {
            draftMode,
            sessionAbsoluteMinutes,
            sessionIdleMinutes
          },
          targetType: "auth_config",
          targetId: "1"
        });
      })();
    } finally {
      db.close();
    }

    return getAdminAuthConfig();
  }

  function testAdminAuthDraft(actorAccountId) {
    const db = openGlobalDb();
    try {
      const config = authConfigFromRow(db.prepare("SELECT * FROM auth_config WHERE id = 1").get() || {});
      const activeAdminCount = countActiveSystemAdmins(db);
      const checks = [
        {
          ok: activeAdminCount > 0,
          code: "active_system_admin",
          message: "At least one active system administrator exists"
        }
      ];
      if (config.draftMode === "external") {
        const externalSecretConfigured = Boolean(externalSecretForConfig(config.draftConfig.external));
        const externalAdminCount = countActiveExternalSystemAdmins(db, config.draftConfig.external);
        checks.push({
          ok: Boolean(config.draftConfig.external.subjectHeader),
          code: "external_subject_header",
          message: "External mode has a subject header configured"
        });
        checks.push({
          ok: externalSecretConfigured,
          code: "external_assertion_secret",
          message: "External assertion secret environment variable is configured"
        });
        checks.push({
          ok: externalAdminCount > 0,
          code: "external_admin_identity",
          message: "At least one active system administrator has an external identity link"
        });
      }
      if (config.draftMode === "internal") {
        const internalAdminCount = countActiveInternalSystemAdmins(db);
        checks.push({
          ok: internalAdminCount > 0,
          code: "internal_admin_credential",
          message: "At least one active system administrator has an email and internal password credential"
        });
      }
      const ok = checks.every(check => check.ok);
      const activatable = ok;

      auditGlobalSecurity(db, {
        action: "admin_auth_draft_test",
        actorAccountId,
        details: {
          activatable,
          draftMode: config.draftMode,
          ok
        },
        outcome: ok ? "success" : "failure",
        targetType: "auth_config",
        targetId: "1"
      });

      return {
        activatable,
        checks,
        config,
        ok
      };
    } finally {
      db.close();
    }
  }

  function activateAdminAuthDraft(actorAccountId) {
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const config = authConfigFromRow(db.prepare("SELECT * FROM auth_config WHERE id = 1").get() || {});
        const activeAdminCount = countActiveSystemAdmins(db);
        if (activeAdminCount < 1) {
          throw conflict("At least one active system administrator is required");
        }
        if (config.draftMode === "external") {
          if (!externalSecretForConfig(config.draftConfig.external)) {
            throw conflict("External authentication secret is not configured");
          }
          if (countActiveExternalSystemAdmins(db, config.draftConfig.external) < 1) {
            throw conflict("At least one active system administrator with an external identity is required");
          }
        }
        if (config.draftMode === "internal" && countActiveInternalSystemAdmins(db) < 1) {
          throw conflict("At least one active system administrator with an internal password is required");
        }

        db.prepare(`
          UPDATE auth_config
          SET active_mode = draft_mode,
              external_config_json = draft_config_json,
              updated_at = datetime('now')
          WHERE id = 1
        `).run();
        if (config.activeMode !== config.draftMode) {
          db.prepare(`
            UPDATE auth_sessions
            SET revoked_at = COALESCE(revoked_at, datetime('now'))
            WHERE revoked_at IS NULL
          `).run();
        }
        auditGlobalSecurity(db, {
          action: "admin_auth_activate",
          actorAccountId,
          details: {
            activeMode: config.draftMode
          },
          targetType: "auth_config",
          targetId: "1"
        });
        result = authConfigFromRow(db.prepare("SELECT * FROM auth_config WHERE id = 1").get() || {});
      })();
      return result;
    } finally {
      db.close();
    }
  }

  return {
    activateAdminAuthDraft,
    authenticateInternalLogin,
    authenticateExternalLogin,
    completeAuthProviderCallback,
    completeInternalPasswordSetup,
    createAdminPasswordResetToken,
    createUser,
    deleteAdminAccount,
    deleteAdminAuthProvider,
    getAdminAuthConfig,
    getGlobalOptions,
    initializeBudgetStorage,
    listAdminAccounts,
    listActiveBudgetIds,
    listAuthProviders,
    listUsers,
    openGlobalDb,
    registerInternalAccountWithInvitation,
    resolveAccountContext,
    resolveBudgetContext,
    resolveBudgetStorageKey,
    resolveSession,
    setAdminProviderIdentity,
    setAdminExternalIdentity,
    revokeAdminAccountSession,
    selectUser,
    setAccountSystemAdmin,
    startAuthProviderLink,
    startAuthProviderLogin,
    testAdminAuthDraft,
    upsertAdminAuthProvider,
    updateAdminAuthDraft,
    updateAdminAccount,
    userExists,
    updateGlobalOptions
  };
}
