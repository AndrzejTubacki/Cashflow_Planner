import argon2 from "argon2";
import crypto from "crypto";
import fs from "fs";
import * as oidcClient from "openid-client";
import path from "path";
import { capabilitiesFor, CAPABILITIES } from "./cashflow-authorization.js";
import { createCashflowGlobalDbService } from "./cashflow-global-db-service.js";
import { createSqliteGlobalRepository } from "./cashflow-global-repository.js";
import {
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

function databaseTimestampMs(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(text)) return Date.parse(text);
  return Date.parse(`${text}Z`);
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
  budgetStore = null,
  cashflowUserStorageExists,
  createGlobalRepository = createSqliteGlobalRepository,
  dataDir,
  deleteCashflowUserStorage = null,
  globalStore = null,
  listCashflowUserIds,
  logError = () => {},
  logServerEvent = () => {},
  normalizeLocale = value => String(value || "en"),
  openGlobalDb: injectedOpenGlobalDb = null,
  openPlanningDb
}) {
  const globalDbService = injectedOpenGlobalDb
    ? { backend: "custom", openGlobalDb: injectedOpenGlobalDb }
    : createCashflowGlobalDbService({
        beforeGlobalMigrationStep,
        dataDir,
        listCashflowUserIds,
        logError,
        logServerEvent
      });
  const { openGlobalDb } = globalDbService;

  function globalRepository(db) {
    return createGlobalRepository(db);
  }

  async function withGlobalRepository(fn) {
    if (globalStore && typeof globalStore.withRepository === "function") {
      return await globalStore.withRepository(fn);
    }

    const db = openGlobalDb();
    try {
      return await fn(globalRepository(db), db);
    } finally {
      db.close();
    }
  }

  async function withExternalGlobalTransaction(fn, syncFallback) {
    if (
      !globalStore
      || globalStore.backend === "sqlite"
      || typeof globalStore.transaction !== "function"
    ) {
      return syncFallback();
    }
    return await globalStore.transaction(async repo => await fn(repo));
  }

  function auditGlobalSecurity(db, {
    action,
    actorAccountId = null,
    details = {},
    outcome = "success",
    targetId = null,
    targetType = null
  }) {
    globalRepository(db).audit.insertSecurityEvent({
      action,
      actorAccountId,
      details,
      outcome,
      targetId,
      targetType
    });
  }

  function getGlobalOptions() {
    const db = openGlobalDb();
    try {
      return globalRepository(db).globalOptions.get();
    } finally {
      db.close();
    }
  }

  async function getGlobalOptionsAsync() {
    return await withGlobalRepository(async repo => await repo.globalOptions.get());
  }

  function ensureUserMetadata(db, userId, displayName = "") {
    return globalRepository(db).users.ensureMetadata(userId, displayName);
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

    globalRepository(db).budgets.ensureLegacy({
      id: normalizedId,
      displayName: String(displayName || normalizedId).trim() || normalizedId,
      storageKey: normalizedId
    });
    return normalizedId;
  }

  async function ensureCompatibilityBudgetForRepo(repo, userId, displayName = "") {
    const normalizedId = normalizeUserId(userId);
    if (await repo.budgets.get(normalizedId)) {
      return normalizedId;
    }
    if (
      typeof cashflowUserStorageExists !== "function"
      || !cashflowUserStorageExists(normalizedId)
    ) {
      return normalizedId;
    }

    await repo.budgets.ensureLegacy({
      id: normalizedId,
      displayName: String(displayName || normalizedId).trim() || normalizedId,
      storageKey: normalizedId
    });
    return normalizedId;
  }

  function metadataUser(db, userId) {
    const normalizedId = normalizeUserId(userId);
    return globalRepository(db).users.getMetadata(normalizedId);
  }

  function budgetMetadata(db, budgetId) {
    const normalizedId = normalizeUserId(budgetId);
    return globalRepository(db).budgets.get(normalizedId);
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

  async function userExistsAsync(userId) {
    const normalizedId = normalizeUserId(userId);
    if (normalizedId === "local") return true;
    if (typeof cashflowUserStorageExists === "function" && cashflowUserStorageExists(normalizedId)) return true;
    return await withGlobalRepository(async repo => Boolean(await repo.users.getMetadata(normalizedId)));
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

  // Postgres has no per-budget file to create: `settings` is a shared table
  // with a budget_id column, and every column but budget_id already has a
  // DDL-level default, so a brand-new budget's row is a single insert of
  // just the global-option overrides — there is no existing default row to
  // UPDATE the way the SQLite path does.
  async function initializeBudgetStorageAsync(budgetId, options = null) {
    if (!budgetStore || budgetStore.backend !== "postgres") {
      return initializeBudgetStorage(budgetId);
    }
    const normalizedId = normalizeUserId(budgetId);
    const defaults = options || await getGlobalOptionsAsync();
    await budgetStore.insertPlanningRows(normalizedId, "settings", [{
      fx_buffer_percent: Math.max(0, Math.min(100, Number(defaults?.fx_buffer_percent) || DEFAULT_FX_BUFFER_PERCENT)),
      fx_provider: normalizeFxProvider(defaults?.fx_provider || "nbp"),
      future_periods: Math.max(1, Math.min(60, Number(defaults?.future_periods) || DEFAULT_FUTURE_PERIODS)),
      holiday_country: normalizeHolidayCountry(defaults?.holiday_country || "PL"),
      ledger_currency: normalizeSupportedCurrency(defaults?.ledger_currency || "PLN"),
      locale: normalizeLocale(defaults?.locale || "en"),
      timezone: normalizeTimezone(defaults?.timezone || DEFAULT_TIMEZONE),
      // settings.updated_at is NOT NULL with no DDL default (unlike every
      // other column this insert touches), so it must be supplied here.
      updated_at: new Date().toISOString()
    }]);
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

      return globalRepository(db).users.listMetadata().map(row => ({
        ...row,
        permissions: normalizePermissions(row.permissions)
      }));
    } finally {
      db.close();
    }
  }

  async function listUsersAsync() {
    return await withGlobalRepository(async repo => {
      const ids = new Set(["local", ...listCashflowUserIds()]);
      for (const userId of ids) {
        await repo.users.ensureMetadata(userId);
        const metadata = await repo.users.getMetadata(userId);
        await ensureCompatibilityBudgetForRepo(repo, userId, metadata?.display_name);
      }

      const rows = await repo.users.listMetadata();
      return rows.map(row => ({
        ...row,
        permissions: normalizePermissions(row.permissions)
      }));
    });
  }

  async function syncExistingStorageBudgetsForRepo(repo, {
    excludeIds = []
  } = {}) {
    const excluded = new Set([...excludeIds].map(id => normalizeUserId(id)));
    for (const userId of listCashflowUserIds()) {
      if (excluded.has(normalizeUserId(userId))) continue;
      const metadata = await repo.users.getMetadata(userId);
      await ensureCompatibilityBudgetForRepo(repo, userId, metadata?.display_name || userId);
    }
  }

  function accountExistsRow(db, accountId) {
    return globalRepository(db).accounts.require(accountId);
  }

  function activeSessionsForAccount(db, accountId) {
    return globalRepository(db).sessions.listActiveForAccount(accountId);
  }

  function accountSummary(db, accountId) {
    const repo = globalRepository(db);
    const account = accountExistsRow(db, accountId);
    const globalRoles = repo.roles.listForAccount(account.id);
    const membershipCount = repo.memberships.countForAccount(account.id);
    const ownedBudgetCount = repo.memberships.countOwnedForAccount(account.id);
    const identityCount = repo.identities.countForAccount(account.id);
    const identities = repo.identities.listForAccount(account.id);
    const hasPasswordCredential = repo.passwordCredentials.existsForAccount(account.id);
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

  async function accountSummaryForRepo(repo, accountId) {
    const account = await repo.accounts.require(accountId);
    const globalRoles = await repo.roles.listForAccount(account.id);
    const membershipCount = await repo.memberships.countForAccount(account.id);
    const ownedBudgetCount = await repo.memberships.countOwnedForAccount(account.id);
    const identityCount = await repo.identities.countForAccount(account.id);
    const identities = await repo.identities.listForAccount(account.id);
    const hasPasswordCredential = await repo.passwordCredentials.existsForAccount(account.id);
    const sessions = await repo.sessions.listActiveForAccount(account.id);

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
      return globalRepository(db).accounts.listAdminIds().map(row => accountSummary(db, row.id));
    } finally {
      db.close();
    }
  }

  async function listAdminAccountsAsync() {
    return await withGlobalRepository(async repo => {
      const rows = await repo.accounts.listAdminIds();
      const accounts = [];
      for (const row of rows) {
        accounts.push(await accountSummaryForRepo(repo, row.id));
      }
      return accounts;
    });
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
        const repo = globalRepository(db);
        const account = accountExistsRow(db, normalizedId);
        if (account.status === "deleted") throw conflict("Deleted accounts cannot be changed");

        if (updates.displayName) {
          repo.accounts.updateDisplayName(normalizedId, updates.displayName);
          repo.users.setDisplayName(normalizedId, updates.displayName);
        }

        if (updates.email && updates.email !== account.email) {
          try {
            repo.accounts.updateEmail(normalizedId, updates.email);
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
            repo.accounts.updateStatus(normalizedId, updates.status);
          } catch (error) {
            mapGlobalConstraintError(error);
          }

          if (updates.status !== "active") {
            repo.sessions.revokeForAccount(normalizedId);
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

  async function updateAdminAccountAsync(actorAccountId, accountId, input = {}) {
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

    return await withExternalGlobalTransaction(async repo => {
      const account = await repo.accounts.require(normalizedId);
      if (account.status === "deleted") throw conflict("Deleted accounts cannot be changed");

      if (updates.displayName) {
        await repo.accounts.updateDisplayName(normalizedId, updates.displayName);
        await repo.users.setDisplayName(normalizedId, updates.displayName);
      }

      if (updates.email && updates.email !== account.email) {
        try {
          await repo.accounts.updateEmail(normalizedId, updates.email);
        } catch (error) {
          if (String(error?.message || "").includes("UNIQUE") || error?.code === "23505") {
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
          await repo.accounts.updateStatus(normalizedId, updates.status);
        } catch (error) {
          mapGlobalConstraintError(error);
        }

        if (updates.status !== "active") {
          await repo.sessions.revokeForAccount(normalizedId);
        }
      }

      await repo.audit.insertSecurityEvent({
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
      return await accountSummaryForRepo(repo, normalizedId);
    }, () => updateAdminAccount(actorAccountId, normalizedId, input));
  }

  function setAccountSystemAdmin(actorAccountId, accountId, enabledValue) {
    const normalizedId = normalizeUserId(accountId);
    const enabled = normalizeAdminBoolean(enabledValue, "enabled");
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const repo = globalRepository(db);
        const account = accountExistsRow(db, normalizedId);
        if (account.status !== "active") throw conflict("Only active accounts can hold system administrator role");

        try {
          if (enabled) {
            repo.roles.insertSystemAdmin({ accountId: normalizedId, grantedByAccountId: actorAccountId || null });
            repo.users.setPermissions(normalizedId, '["admin"]');
          } else {
            repo.roles.deleteSystemAdmin(normalizedId);
            repo.users.setPermissions(normalizedId, "[]");
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

  async function setAccountSystemAdminAsync(actorAccountId, accountId, enabledValue) {
    const normalizedId = normalizeUserId(accountId);
    const enabled = normalizeAdminBoolean(enabledValue, "enabled");
    return await withExternalGlobalTransaction(async repo => {
      const account = await repo.accounts.require(normalizedId);
      if (account.status !== "active") throw conflict("Only active accounts can hold system administrator role");

      try {
        if (enabled) {
          await repo.roles.insertSystemAdmin({ accountId: normalizedId, grantedByAccountId: actorAccountId || null });
          await repo.users.setPermissions(normalizedId, '["admin"]');
        } else {
          await repo.roles.deleteSystemAdmin(normalizedId);
          await repo.users.setPermissions(normalizedId, "[]");
        }
      } catch (error) {
        mapGlobalConstraintError(error);
      }

      await repo.audit.insertSecurityEvent({
        action: enabled ? "admin_account_grant_system_admin" : "admin_account_revoke_system_admin",
        actorAccountId,
        targetId: normalizedId,
        targetType: "account"
      });
      return await accountSummaryForRepo(repo, normalizedId);
    }, () => setAccountSystemAdmin(actorAccountId, normalizedId, enabled));
  }

  function revokeAdminAccountSession(actorAccountId, accountId, sessionId) {
    const normalizedId = normalizeUserId(accountId);
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) throw badRequest("sessionId is required", [{ field: "sessionId", reason: "required" }]);

    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const repo = globalRepository(db);
        accountExistsRow(db, normalizedId);
        const changes = repo.sessions.revoke(normalizedSessionId, normalizedId);
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

  async function revokeAdminAccountSessionAsync(actorAccountId, accountId, sessionId) {
    const normalizedId = normalizeUserId(accountId);
    const normalizedSessionId = String(sessionId || "").trim();
    if (!normalizedSessionId) throw badRequest("sessionId is required", [{ field: "sessionId", reason: "required" }]);

    return await withExternalGlobalTransaction(async repo => {
      await repo.accounts.require(normalizedId);
      const changes = await repo.sessions.revoke(normalizedSessionId, normalizedId);
      if (changes !== 1) throw notFound("Session not found");
      await repo.audit.insertSecurityEvent({
        action: "admin_account_session_revoke",
        actorAccountId,
        targetId: normalizedSessionId,
        targetType: "auth_session"
      });
      return await accountSummaryForRepo(repo, normalizedId);
    }, () => revokeAdminAccountSession(actorAccountId, normalizedId, normalizedSessionId));
  }

  function deleteAdminAccount(actorAccountId, accountId) {
    const normalizedId = normalizeUserId(accountId);
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const repo = globalRepository(db);
        const account = accountExistsRow(db, normalizedId);
        if (account.status === "deleted") {
          result = accountSummary(db, normalizedId);
          return;
        }

        const ownedBudgetCount = repo.memberships.countOwnedForAccount(normalizedId);
        if (ownedBudgetCount > 0) throw conflict("Transfer or delete owned budgets before deleting this account");

        const membershipCount = repo.memberships.countForAccount(normalizedId);
        if (membershipCount > 0) throw conflict("Remove this account from budgets before deleting it");

        try {
          repo.roles.deleteSystemAdmin(normalizedId);
        } catch (error) {
          mapGlobalConstraintError(error);
        }

        repo.sessions.revokeForAccount(normalizedId);
        repo.identities.deleteForAccount(normalizedId);
        repo.passwordCredentials.deleteForAccount(normalizedId);
        repo.passwordResetTokens.deleteForAccount(normalizedId);
        repo.invitations.revokePendingForTargetAccount(normalizedId);
        repo.accounts.markDeleted(normalizedId);
        repo.users.setPermissions(normalizedId, "[]");
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

  async function deleteAdminAccountAsync(actorAccountId, accountId) {
    const normalizedId = normalizeUserId(accountId);
    return await withExternalGlobalTransaction(async repo => {
      const account = await repo.accounts.require(normalizedId);
      if (account.status === "deleted") {
        return await accountSummaryForRepo(repo, normalizedId);
      }

      const ownedBudgetCount = await repo.memberships.countOwnedForAccount(normalizedId);
      if (ownedBudgetCount > 0) throw conflict("Transfer or delete owned budgets before deleting this account");

      const membershipCount = await repo.memberships.countForAccount(normalizedId);
      if (membershipCount > 0) throw conflict("Remove this account from budgets before deleting it");

      try {
        await repo.roles.deleteSystemAdmin(normalizedId);
      } catch (error) {
        mapGlobalConstraintError(error);
      }

      await repo.sessions.revokeForAccount(normalizedId);
      await repo.identities.deleteForAccount(normalizedId);
      await repo.passwordCredentials.deleteForAccount(normalizedId);
      await repo.passwordResetTokens.deleteForAccount(normalizedId);
      await repo.invitations.revokePendingForTargetAccount(normalizedId);
      await repo.accounts.markDeleted(normalizedId);
      await repo.users.setPermissions(normalizedId, "[]");
      await repo.audit.insertSecurityEvent({
        action: "admin_account_delete",
        actorAccountId,
        targetId: normalizedId,
        targetType: "account"
      });
      return await accountSummaryForRepo(repo, normalizedId);
    }, () => deleteAdminAccount(actorAccountId, normalizedId));
  }

  function listActiveBudgetIds() {
    const db = openGlobalDb();
    try {
      syncExistingStorageBudgets(db);
      return globalRepository(db).budgets.listActiveStorage()
        .filter(row =>
          typeof cashflowUserStorageExists !== "function"
          || cashflowUserStorageExists(row.storage_key)
        )
        .map(row => row.id);
    } finally {
      db.close();
    }
  }

  async function listActiveBudgetIdsAsync() {
    return await withGlobalRepository(async repo => {
      await syncExistingStorageBudgetsForRepo(repo);
      const rows = await repo.budgets.listActiveStorage();
      return rows
        .filter(row =>
          typeof cashflowUserStorageExists !== "function"
          || cashflowUserStorageExists(row.storage_key)
        )
        .map(row => row.id);
    });
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
      const repo = globalRepository(db);
      db.transaction(() => {
        syncExistingStorageBudgets(db);
        if (
          repo.identity.legacyUserAccountOrBudgetExists(userId)
          || (typeof cashflowUserStorageExists === "function" && cashflowUserStorageExists(userId))
        ) {
          throw conflict("User already exists");
        }
        if (email && repo.accounts.emailExists(email)) {
          throw conflict("Email is already assigned to another account", [{
            field: "email",
            reason: "not_unique"
          }]);
        }

        repo.users.insertNew({ id: userId, displayName });
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
          const repo = globalRepository(metadataDb);
          syncExistingStorageBudgets(metadataDb, { excludeIds: [userId] });
          const bootstrapRequired = repo.accounts.count() === 0;

          repo.accounts.insert({ id: userId, email, displayName });
          repo.budgets.insert({
            id: userId,
            storageKey: userId,
            displayName,
            createdByAccountId: userId
          });
          repo.memberships.insertOwner({ budgetId: userId, accountId: userId });

          if (bootstrapRequired) {
            repo.roles.insertSystemAdmin({ accountId: userId });
            repo.authConfig.markBootstrapCompleted();
            repo.users.setPermissions(userId, '["admin"]');
          }
        })();
      } finally {
        metadataDb.close();
      }
    } catch (error) {
      const cleanupDb = openGlobalDb();
      try {
        const repo = globalRepository(cleanupDb);
        repo.budgets.markDeleted(userId);
        repo.budgets.delete(userId);
        repo.accounts.delete(userId);
        repo.users.delete(userId);
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

  // Postgres port of createUser. Kept as the same multi-phase shape as the
  // SQLite version above rather than one atomic transaction — budgetStore
  // and globalStore are separate connections/transactions in this
  // codebase's abstraction even when they point at the same Postgres
  // database, so there is no single transaction that could span both
  // writes anyway, matching createBudgetAsync's already-established
  // pattern in cashflow-budget-service.js. **The phase order is not the
  // same as the SQLite version above**, though: SQLite creates the
  // planning.sqlite file (with its own independent default settings row)
  // before touching the global accounts/budgets tables, which is safe only
  // because separate SQLite files have no foreign key between them. In
  // Postgres, `settings.budget_id` has a real foreign key to `budgets.id`,
  // so the budget row must exist first — initializeBudgetStorageAsync (the
  // settings insert) runs after the accounts/budgets/memberships/
  // bootstrap-admin transaction here, not before it.
  async function createUserAsync(input = {}) {
    if (!globalStore || globalStore.backend === "sqlite" || typeof globalStore.transaction !== "function") {
      return createUser(input);
    }

    const userId = normalizeUserId(input.userId || input.id);
    const displayName = String(input.displayName || input.display_name || userId).trim() || userId;
    const email = Object.prototype.hasOwnProperty.call(input, "email")
      ? normalizeAccountEmail(input.email, "email")
      : null;
    const options = await getGlobalOptionsAsync();

    await globalStore.transaction(async repo => {
      await syncExistingStorageBudgetsForRepo(repo);
      if (
        await repo.identity.legacyUserAccountOrBudgetExists(userId)
        || (typeof cashflowUserStorageExists === "function" && cashflowUserStorageExists(userId))
      ) {
        throw conflict("User already exists");
      }
      if (email && await repo.accounts.emailExists(email)) {
        throw conflict("Email is already assigned to another account", [{
          field: "email",
          reason: "not_unique"
        }]);
      }

      await repo.users.insertNew({ id: userId, displayName });
    });

    try {
      await globalStore.transaction(async repo => {
        await syncExistingStorageBudgetsForRepo(repo, { excludeIds: [userId] });
        const bootstrapRequired = (await repo.accounts.count()) === 0;

        await repo.accounts.insert({ id: userId, email, displayName });
        await repo.budgets.insert({
          id: userId,
          storageKey: userId,
          displayName,
          createdByAccountId: userId
        });
        await repo.memberships.insertOwner({ budgetId: userId, accountId: userId });

        if (bootstrapRequired) {
          await repo.roles.insertSystemAdmin({ accountId: userId });
          await repo.authConfig.markBootstrapCompleted();
          await repo.users.setPermissions(userId, '["admin"]');
        }
      });
      await initializeBudgetStorageAsync(userId, options);
    } catch (error) {
      try {
        // Deleting the budgets row cascades to settings (ON DELETE CASCADE)
        // if initializeBudgetStorageAsync had already run, so no separate
        // settings cleanup is needed here.
        await globalStore.transaction(async repo => {
          await repo.budgets.markDeleted(userId);
          await repo.budgets.delete(userId);
          await repo.accounts.delete(userId);
          await repo.users.delete(userId);
        });
      } catch (cleanupError) {
        logError("cashflow_user_create_cleanup_failed", {
          userId,
          error: cleanupError.message
        });
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

    return (await resolveBudgetContextAsync(userId, {
      accountId: userId,
      skipStorageExistenceCheck: true
    })).session;
  }

  function selectUser(userId = "") {
    const normalizedId = normalizeUserId(userId);
    if (normalizedId !== "local" && !userExists(normalizedId)) {
      throw userNotFoundError(normalizedId);
    }

    const db = openGlobalDb();
    try {
      const repo = globalRepository(db);
      ensureUserMetadata(db, normalizedId);
      repo.users.touchSelection(normalizedId);
      openPlanningDb(normalizedId).close();
      ensureCompatibilityBudget(db, normalizedId, metadataUser(db, normalizedId)?.display_name);
      const ownerAccountId = repo.memberships.ownerAccountId(normalizedId);
      return resolveBudgetContext(normalizedId, {
        accountId: ownerAccountId || LEGACY_ADMIN_ACCOUNT_ID
      }).session;
    } finally {
      db.close();
    }
  }

  // Postgres port of selectUser. Skips the SQLite version's
  // `openPlanningDb(normalizedId).close()` call — that's a lazy
  // create-if-missing/schema-migration touch on the planning file, which
  // has no Postgres equivalent (a Postgres budget's settings row already
  // exists once its budgets row does; there's nothing to lazily create on
  // selection). ensureCompatibilityBudgetForRepo is still safe to call: it
  // only does anything when cashflowUserStorageExists() finds real local
  // storage, which a genuine Postgres-native budget never has.
  async function selectUserAsync(userId = "") {
    if (!globalStore || globalStore.backend === "sqlite" || typeof globalStore.transaction !== "function") {
      return selectUser(userId);
    }

    const normalizedId = normalizeUserId(userId);
    if (normalizedId !== "local" && !(await userExistsAsync(normalizedId))) {
      throw userNotFoundError(normalizedId);
    }

    const ownerAccountId = await globalStore.transaction(async repo => {
      await repo.users.ensureMetadata(normalizedId);
      await repo.users.touchSelection(normalizedId);
      const metadata = await repo.users.getMetadata(normalizedId);
      await ensureCompatibilityBudgetForRepo(repo, normalizedId, metadata?.display_name);
      return await repo.memberships.ownerAccountId(normalizedId);
    });

    return (await resolveBudgetContextAsync(normalizedId, {
      accountId: ownerAccountId || LEGACY_ADMIN_ACCOUNT_ID
    })).session;
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

  async function resolveSessionAsync(userId = "") {
    if (!String(userId || "").trim()) {
      return {
        authenticated: false,
        userId: "",
        displayName: "",
        permissions: []
      };
    }

    return (await resolveBudgetContextAsync(userId)).session;
  }

  function resolveAccountContext(accountId = "") {
    const normalizedId = normalizeUserId(accountId);
    const db = openGlobalDb();
    try {
      const repo = globalRepository(db);
      const account = repo.accounts.get(normalizedId);
      if (!account || account.status !== "active") {
        throw userNotFoundError(normalizedId);
      }
      const globalRoles = repo.roles.listForAccount(normalizedId);
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

  async function resolveAccountContextAsync(accountId = "") {
    const normalizedId = normalizeUserId(accountId);
    return await withGlobalRepository(async repo => {
      const account = await repo.accounts.get(normalizedId);
      if (!account || account.status !== "active") {
        throw userNotFoundError(normalizedId);
      }
      const globalRoles = await repo.roles.listForAccount(normalizedId);
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
    });
  }

  function resolveBudgetContext(budgetId = "", {
    accountId = LEGACY_ADMIN_ACCOUNT_ID,
    skipStorageExistenceCheck = false
  } = {}) {
    const normalizedId = normalizeUserId(budgetId);
    const db = openGlobalDb();
    try {
      const repo = globalRepository(db);
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

      const account = repo.accounts.get(accountId);
      const globalRoles = repo.roles.listForAccount(accountId);
      const membership = repo.memberships.getRole({
        accountId,
        budgetId: budget.id
      });
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

  async function resolveBudgetContextAsync(budgetId = "", options = {}) {
    const {
      accountId = LEGACY_ADMIN_ACCOUNT_ID,
      skipStorageExistenceCheck = false
    } = options;
    const normalizedId = normalizeUserId(budgetId);
    return await withGlobalRepository(async repo => {
      let budget = await repo.budgets.get(normalizedId);
      if (!budget) {
        const storageExists = normalizedId === "local"
          || (typeof cashflowUserStorageExists === "function" && cashflowUserStorageExists(normalizedId));
        if (!storageExists) {
          throw userNotFoundError(normalizedId);
        }

        let metadata = await repo.users.getMetadata(normalizedId);
        if (!metadata) {
          await repo.users.ensureMetadata(normalizedId);
          metadata = await repo.users.getMetadata(normalizedId);
        }
        await ensureCompatibilityBudgetForRepo(repo, normalizedId, metadata?.display_name);
        budget = await repo.budgets.get(normalizedId);
      }

      if (
        !budget
        || budget.status !== "active"
        || (
          typeof cashflowUserStorageExists === "function"
          && !skipStorageExistenceCheck
          // A Postgres budget has no local SQLite directory to check — its
          // row in `budgets` (already confirmed active above) is the only
          // existence signal that applies. Without this guard every
          // Postgres-backed budget context lookup that doesn't pass
          // skipStorageExistenceCheck (e.g. GET /api/budgets/:id/export)
          // would incorrectly 404, since cashflowUserStorageExists() can
          // only ever see local files.
          && globalStore?.backend !== "postgres"
          && !cashflowUserStorageExists(budget.storage_key)
        )
      ) {
        throw userNotFoundError(normalizedId);
      }

      const account = await repo.accounts.get(accountId);
      const globalRoles = await repo.roles.listForAccount(accountId);
      const membership = await repo.memberships.getRole({
        accountId,
        budgetId: budget.id
      });
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
    });
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
      globalRepository(db).globalOptions.updatePlannerDefaults(safe);
    } finally {
      db.close();
    }

    return getGlobalOptions();
  }

  async function updateGlobalOptionsAsync(updates = {}) {
    const current = await getGlobalOptionsAsync();
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

    await withGlobalRepository(async repo => {
      await repo.globalOptions.updatePlannerDefaults(safe);
    });

    return await getGlobalOptionsAsync();
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
      const row = globalRepository(db).authConfig.get();
      return authConfigFromRow(row || {});
    } finally {
      db.close();
    }
  }

  async function getAdminAuthConfigAsync() {
    return await withGlobalRepository(async repo =>
      authConfigFromRow(await repo.authConfig.get() || {})
    );
  }

  function countActiveSystemAdmins(db) {
    return globalRepository(db).accounts.countActiveSystemAdmins();
  }

  function countActiveInternalSystemAdmins(db) {
    return globalRepository(db).accounts.countActiveInternalSystemAdmins();
  }

  function countActiveExternalSystemAdmins(db, externalConfig = {}) {
    const providerId = externalProviderId(externalConfig);
    return globalRepository(db).accounts.countActiveExternalSystemAdmins(providerId);
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
      const rows = globalRepository(db).authProviders.list({ publicOnly });
      return rows.map(providerConfigFromRow).filter(Boolean);
    } finally {
      db.close();
    }
  }

  async function listAuthProvidersAsync(options = {}) {
    return await withGlobalRepository(async repo =>
      (await repo.authProviders.list(options)).map(providerConfigFromRow).filter(Boolean)
    );
  }

  function authProviderRow(db, providerId) {
    const id = normalizeAuthProviderId(providerId);
    const row = globalRepository(db).authProviders.get(id);
    if (!row) throw notFound("Authentication provider not found");
    return row;
  }

  async function authProviderRowForRepo(repo, providerId) {
    const id = normalizeAuthProviderId(providerId);
    const row = await repo.authProviders.get(id);
    if (!row) throw notFound("Authentication provider not found");
    return row;
  }

  function upsertAdminAuthProvider(actorAccountId, providerId, input = {}) {
    const id = normalizeAuthProviderId(providerId);
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const repo = globalRepository(db);
        const existing = repo.authProviders.get(id);
        const next = normalizeProviderPayload(id, input, existing || null);
        repo.authProviders.upsert({
          id,
          kind: next.kind,
          displayName: next.displayName,
          enabled: next.enabled,
          issuer: next.issuer,
          clientId: next.clientId,
          secretRef: next.secretRef,
          configJson: JSON.stringify(next.config)
        });
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
        result = providerConfigFromRow(repo.authProviders.get(id));
      })();
      return result;
    } finally {
      db.close();
    }
  }

  async function upsertAdminAuthProviderAsync(actorAccountId, providerId, input = {}) {
    const id = normalizeAuthProviderId(providerId);
    return await withExternalGlobalTransaction(async repo => {
      const existing = await repo.authProviders.get(id);
      const next = normalizeProviderPayload(id, input, existing || null);
      await repo.authProviders.upsert({
        id,
        kind: next.kind,
        displayName: next.displayName,
        enabled: next.enabled,
        issuer: next.issuer,
        clientId: next.clientId,
        secretRef: next.secretRef,
        configJson: JSON.stringify(next.config)
      });
      await repo.audit.insertSecurityEvent({
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
      return providerConfigFromRow(await repo.authProviders.get(id));
    }, () => upsertAdminAuthProvider(actorAccountId, id, input));
  }

  function deleteAdminAuthProvider(actorAccountId, providerId) {
    const id = normalizeAuthProviderId(providerId);
    const db = openGlobalDb();
    try {
      db.transaction(() => {
        const repo = globalRepository(db);
        const row = authProviderRow(db, id);
        repo.authProviders.delete(row.id);
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

  async function deleteAdminAuthProviderAsync(actorAccountId, providerId) {
    const id = normalizeAuthProviderId(providerId);
    return await withExternalGlobalTransaction(async repo => {
      const row = await authProviderRowForRepo(repo, id);
      await repo.authProviders.delete(row.id);
      await repo.audit.insertSecurityEvent({
        action: "admin_auth_provider_delete",
        actorAccountId,
        targetId: id,
        targetType: "auth_provider"
      });
      return { deleted: true, providerId: id };
    }, () => deleteAdminAuthProvider(actorAccountId, id));
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

  async function oidcConfigurationForProvider(provider, explicitSecret = null) {
    const secret = explicitSecret === null ? providerSecret(provider.id) : explicitSecret;
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

  async function authorizationUrlForProvider(provider, { nonce, state, codeVerifier, secret = null }) {
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
    const config = await oidcConfigurationForProvider(provider, secret);
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

  async function providerProfileFromCallback(provider, callbackUrl, stateRow, secret = null) {
    if (typeof authProviderHook === "function") {
      const hooked = await authProviderHook({
        action: "callback",
        callbackUrl,
        provider,
        state: stateRow
      });
      if (hooked?.profile) return hooked.profile;
    }
    const config = await oidcConfigurationForProvider(provider, secret);
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

  function providerForUseRow(row) {
    const provider = providerConfigFromRow(row);
    if (!provider) throw notFound("Authentication provider not found");
    if (!provider.enabled) throw forbidden("Authentication provider is disabled");
    if (!provider.clientId || !provider.config.redirectUri) {
      throw conflict("Authentication provider is incomplete");
    }
    return provider;
  }

  async function startAuthProviderLoginSqlite(providerId) {
    const db = openGlobalDb();
    try {
      let stateRow;
      let provider;
      db.transaction(() => {
        const repo = globalRepository(db);
        const config = repo.authConfig.getActiveMode();
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
        repo.oauthStates.insert({
          stateHash: stateRow.state_hash,
          providerId: provider.id,
          purpose: "login",
          codeVerifier,
          nonce,
          redirectUri: provider.config.redirectUri,
          expiresAt
        });
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

  async function startAuthProviderLogin(providerId) {
    const id = normalizeAuthProviderId(providerId);
    const prepared = await withExternalGlobalTransaction(async repo => {
      const config = await repo.authConfig.getActiveMode();
      if ((config.active_mode || "none") !== "internal") {
        throw forbidden("Provider login is available only in internal authentication mode");
      }
      const providerRow = await authProviderRowForRepo(repo, id);
      const provider = providerForUseRow(providerRow);
      const state = oidcClient.randomState();
      const codeVerifier = oidcClient.randomPKCECodeVerifier();
      const nonce = oidcClient.randomNonce();
      const expiresAt = addMinutesIso(OAUTH_STATE_TTL_MINUTES);
      const stateRow = {
        code_verifier: codeVerifier,
        nonce,
        provider_id: provider.id,
        redirect_uri: provider.config.redirectUri,
        state,
        state_hash: authTokenHash(state)
      };
      await repo.oauthStates.insert({
        stateHash: stateRow.state_hash,
        providerId: provider.id,
        purpose: "login",
        codeVerifier,
        nonce,
        redirectUri: provider.config.redirectUri,
        expiresAt
      });
      return {
        provider,
        secret: secretValueFromRef(providerRow.secret_ref || ""),
        stateRow
      };
    }, () => null);

    if (!prepared) return await startAuthProviderLoginSqlite(providerId);

    return {
      authorizationUrl: await authorizationUrlForProvider(prepared.provider, {
        codeVerifier: prepared.stateRow.code_verifier,
        nonce: prepared.stateRow.nonce,
        secret: prepared.secret,
        state: prepared.stateRow.state
      }),
      provider: prepared.provider
    };
  }

  async function startAuthProviderLinkSqlite(actorAccountId, providerId) {
    const accountId = normalizeUserId(actorAccountId);
    const db = openGlobalDb();
    try {
      let stateRow;
      let provider;
      db.transaction(() => {
        const repo = globalRepository(db);
        const config = repo.authConfig.getActiveMode();
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
        repo.oauthStates.insert({
          stateHash: stateRow.state_hash,
          providerId: provider.id,
          accountId,
          purpose: "link",
          codeVerifier,
          nonce,
          redirectUri: provider.config.redirectUri,
          expiresAt
        });
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
    const id = normalizeAuthProviderId(providerId);
    const prepared = await withExternalGlobalTransaction(async repo => {
      const config = await repo.authConfig.getActiveMode();
      if ((config.active_mode || "none") !== "internal") {
        throw forbidden("Provider linking is available only in internal authentication mode");
      }
      const account = await repo.accounts.require(accountId);
      if (account.status !== "active") throw conflict("Only active accounts can link authentication providers");
      const providerRow = await authProviderRowForRepo(repo, id);
      const provider = providerForUseRow(providerRow);
      const state = oidcClient.randomState();
      const codeVerifier = oidcClient.randomPKCECodeVerifier();
      const nonce = oidcClient.randomNonce();
      const expiresAt = addMinutesIso(OAUTH_STATE_TTL_MINUTES);
      const stateRow = {
        code_verifier: codeVerifier,
        nonce,
        provider_id: provider.id,
        redirect_uri: provider.config.redirectUri,
        state,
        state_hash: authTokenHash(state)
      };
      await repo.oauthStates.insert({
        stateHash: stateRow.state_hash,
        providerId: provider.id,
        accountId,
        purpose: "link",
        codeVerifier,
        nonce,
        redirectUri: provider.config.redirectUri,
        expiresAt
      });
      return {
        provider,
        secret: secretValueFromRef(providerRow.secret_ref || ""),
        stateRow
      };
    }, () => null);

    if (!prepared) return await startAuthProviderLinkSqlite(actorAccountId, providerId);

    return {
      authorizationUrl: await authorizationUrlForProvider(prepared.provider, {
        codeVerifier: prepared.stateRow.code_verifier,
        nonce: prepared.stateRow.nonce,
        secret: prepared.secret,
        state: prepared.stateRow.state
      }),
      provider: prepared.provider
    };
  }

  async function completeAuthProviderCallbackSqlite(providerId, callbackUrl) {
    const id = normalizeAuthProviderId(providerId);
    const currentUrl = new URL(callbackUrl);
    const state = String(currentUrl.searchParams.get("state") || "");
    if (!state) throw badRequest("OAuth state is required", [{ field: "state", reason: "required" }]);
    const db = openGlobalDb();
    try {
      let stateRow;
      let provider;
      db.transaction(() => {
        const repo = globalRepository(db);
        provider = authProviderForUse(db, id);
        stateRow = repo.oauthStates.getByHashAndProvider({
          providerId: provider.id,
          stateHash: authTokenHash(state)
        });
        if (!stateRow || stateRow.status !== "pending" || Date.parse(stateRow.expires_at) <= Date.now()) {
          if (stateRow?.status === "pending") {
            repo.oauthStates.markExpired(stateRow.id);
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
        const repo = globalRepository(db);
        const freshState = repo.oauthStates.get(stateRow.id);
        if (!freshState || freshState.status !== "pending") {
          throw unauthorized("Authentication state is invalid or expired");
        }
        const existing = repo.identities.findWithAccountByProviderSubject(provider.id, subject);

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
          repo.identities.upsert({
            accountId: freshState.account_id,
            providerId: provider.id,
            subject,
            email,
            emailVerified,
            lastUsedNow: true,
            profileJson: JSON.stringify({
              displayName,
              providerKind: provider.kind
            })
          });
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
          repo.identities.updateProviderLogin({
            email,
            emailVerified,
            profileJson: JSON.stringify({
              displayName,
              providerKind: provider.kind
            }),
            providerId: provider.id,
            subject
          });
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

        repo.oauthStates.markConsumed(freshState.id);
      })();
      return result;
    } finally {
      db.close();
    }
  }

  async function completeAuthProviderCallback(providerId, callbackUrl) {
    if (!globalStore || globalStore.backend === "sqlite") {
      return await completeAuthProviderCallbackSqlite(providerId, callbackUrl);
    }

    const id = normalizeAuthProviderId(providerId);
    const currentUrl = new URL(callbackUrl);
    const state = String(currentUrl.searchParams.get("state") || "");
    if (!state) throw badRequest("OAuth state is required", [{ field: "state", reason: "required" }]);

    const prepared = await withExternalGlobalTransaction(async repo => {
      const providerRow = await authProviderRowForRepo(repo, id);
      const provider = providerForUseRow(providerRow);
      const stateRow = await repo.oauthStates.getByHashAndProvider({
        providerId: provider.id,
        stateHash: authTokenHash(state)
      });
      if (!stateRow || stateRow.status !== "pending" || Date.parse(stateRow.expires_at) <= Date.now()) {
        if (stateRow?.status === "pending") {
          await repo.oauthStates.markExpired(stateRow.id);
        }
        throw unauthorized("Authentication state is invalid or expired");
      }
      return {
        provider,
        secret: secretValueFromRef(providerRow.secret_ref || ""),
        stateRow
      };
    }, () => null);
    if (!prepared) return await completeAuthProviderCallbackSqlite(providerId, callbackUrl);

    const profile = await providerProfileFromCallback(
      prepared.provider,
      currentUrl.href,
      prepared.stateRow,
      prepared.secret
    );
    const subject = providerSubjectFromProfile(prepared.provider, profile);
    const email = providerEmailFromProfile(prepared.provider, profile);
    const emailVerified = providerEmailVerifiedFromProfile(prepared.provider, profile);
    const displayName = providerDisplayNameFromProfile(prepared.provider, profile, email || subject);

    return await withExternalGlobalTransaction(async repo => {
      const freshState = await repo.oauthStates.get(prepared.stateRow.id);
      if (!freshState || freshState.status !== "pending") {
        throw unauthorized("Authentication state is invalid or expired");
      }
      const existing = await repo.identities.findWithAccountByProviderSubject(prepared.provider.id, subject);

      let result;
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
        await repo.accounts.require(freshState.account_id);
        await repo.identities.upsert({
          accountId: freshState.account_id,
          providerId: prepared.provider.id,
          subject,
          email,
          emailVerified,
          lastUsedNow: true,
          profileJson: JSON.stringify({
            displayName,
            providerKind: prepared.provider.kind
          })
        });
        result = {
          accountId: freshState.account_id,
          linked: true
        };
        await repo.audit.insertSecurityEvent({
          action: "internal_provider_identity_link",
          actorAccountId: freshState.account_id,
          details: {
            providerId: prepared.provider.id
          },
          targetId: freshState.account_id,
          targetType: "account"
        });
      } else {
        if (!existing || existing.status !== "active") {
          throw unauthorized("Provider login is not linked to an active account");
        }
        await repo.identities.updateProviderLogin({
          email,
          emailVerified,
          profileJson: JSON.stringify({
            displayName,
            providerKind: prepared.provider.kind
          }),
          providerId: prepared.provider.id,
          subject
        });
        result = {
          accountId: existing.account_id,
          linked: false
        };
        await repo.audit.insertSecurityEvent({
          action: "internal_provider_login",
          actorAccountId: existing.account_id,
          details: {
            providerId: prepared.provider.id
          },
          targetId: existing.account_id,
          targetType: "account"
        });
      }

      await repo.oauthStates.markConsumed(freshState.id);
      return result;
    }, () => completeAuthProviderCallbackSqlite(providerId, callbackUrl));
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
        const repo = globalRepository(db);
        const account = accountExistsRow(db, normalizedAccountId);
        if (account.status !== "active") throw conflict("Only active accounts can receive provider identities");
        authProviderRow(db, normalizedProviderId);
        const existing = repo.identities.findAccountByProviderSubject(normalizedProviderId, subject);
        if (existing && existing.account_id !== normalizedAccountId) {
          throw conflict("Provider identity is already linked to another account", [{
            field: "subject",
            reason: "not_unique"
          }]);
        }
        repo.identities.upsert({
          accountId: normalizedAccountId,
          providerId: normalizedProviderId,
          subject,
          email,
          emailVerified,
          profileJson: JSON.stringify({
            linkedBy: "admin"
          })
        });
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

  async function setAdminProviderIdentityAsync(actorAccountId, accountId, providerId, input = {}) {
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

    return await withExternalGlobalTransaction(async repo => {
      const account = await repo.accounts.require(normalizedAccountId);
      if (account.status !== "active") throw conflict("Only active accounts can receive provider identities");
      await authProviderRowForRepo(repo, normalizedProviderId);
      const existing = await repo.identities.findAccountByProviderSubject(normalizedProviderId, subject);
      if (existing && existing.account_id !== normalizedAccountId) {
        throw conflict("Provider identity is already linked to another account", [{
          field: "subject",
          reason: "not_unique"
        }]);
      }
      await repo.identities.upsert({
        accountId: normalizedAccountId,
        providerId: normalizedProviderId,
        subject,
        email,
        emailVerified,
        profileJson: JSON.stringify({
          linkedBy: "admin"
        })
      });
      await repo.audit.insertSecurityEvent({
        action: "admin_provider_identity_link",
        actorAccountId,
        details: {
          providerId: normalizedProviderId
        },
        targetId: normalizedAccountId,
        targetType: "account"
      });
      return await accountSummaryForRepo(repo, normalizedAccountId);
    }, () => setAdminProviderIdentity(actorAccountId, normalizedAccountId, normalizedProviderId, {
      ...input,
      email,
      emailVerified,
      subject
    }));
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
        const repo = globalRepository(db);
        const account = accountExistsRow(db, normalizedId);
        if (account.status !== "active") throw conflict("Only active accounts can receive external identities");
        const config = authConfigFromRow(repo.authConfig.get() || {});
        const providerId = externalProviderId(config.draftConfig.external);
        const existing = repo.identities.findAccountByProviderSubject(providerId, subject);
        if (existing && existing.account_id !== normalizedId) {
          throw conflict("External identity is already linked to another account", [{
            field: "subject",
            reason: "not_unique"
          }]);
        }

        repo.identities.upsert({
          accountId: normalizedId,
          providerId,
          subject,
          email,
          emailVerified,
          profileJson: JSON.stringify({
            trustedIssuer: config.draftConfig.external.trustedIssuer || ""
          })
        });
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

  async function setAdminExternalIdentityAsync(actorAccountId, accountId, input = {}) {
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

    return await withExternalGlobalTransaction(async repo => {
      const account = await repo.accounts.require(normalizedId);
      if (account.status !== "active") throw conflict("Only active accounts can receive external identities");
      const config = authConfigFromRow(await repo.authConfig.get() || {});
      const providerId = externalProviderId(config.draftConfig.external);
      const existing = await repo.identities.findAccountByProviderSubject(providerId, subject);
      if (existing && existing.account_id !== normalizedId) {
        throw conflict("External identity is already linked to another account", [{
          field: "subject",
          reason: "not_unique"
        }]);
      }

      await repo.identities.upsert({
        accountId: normalizedId,
        providerId,
        subject,
        email,
        emailVerified,
        profileJson: JSON.stringify({
          trustedIssuer: config.draftConfig.external.trustedIssuer || ""
        })
      });
      await repo.audit.insertSecurityEvent({
        action: "admin_external_identity_link",
        actorAccountId,
        details: {
          providerId
        },
        targetId: normalizedId,
        targetType: "account"
      });
      return await accountSummaryForRepo(repo, normalizedId);
    }, () => setAdminExternalIdentity(actorAccountId, normalizedId, {
      ...input,
      email,
      emailVerified,
      subject
    }));
  }

  function createAdminPasswordResetTokenSqlite(actorAccountId, accountId, {
    email,
    expiresAt,
    normalizedId,
    purpose,
    token,
    tokenHash
  }) {
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const repo = globalRepository(db);
        const account = accountExistsRow(db, normalizedId);
        if (account.status !== "active") throw conflict("Only active accounts can receive password setup links");

        if (email && email !== account.email) {
          if (repo.accounts.emailExists(email, { excludeId: normalizedId })) {
            throw conflict("Email is already assigned to another account", [{
              field: "email",
              reason: "not_unique"
            }]);
          }
          repo.accounts.updateEmail(normalizedId, email);
        }

        const effectiveEmail = email || account.email;
        if (!effectiveEmail) {
          throw badRequest("Account email is required before issuing an internal login setup link", [{
            field: "email",
            reason: "required"
          }]);
        }

        repo.passwordResetTokens.revokePendingForAccount(normalizedId);
        repo.passwordResetTokens.insert({
          accountId: normalizedId,
          tokenHash,
          purpose,
          expiresAt,
          createdByAccountId: actorAccountId || null
        });
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

    return await withExternalGlobalTransaction(async repo => {
      const account = await repo.accounts.require(normalizedId);
      if (account.status !== "active") throw conflict("Only active accounts can receive password setup links");

      if (email && email !== account.email) {
        if (await repo.accounts.emailExists(email, { excludeId: normalizedId })) {
          throw conflict("Email is already assigned to another account", [{
            field: "email",
            reason: "not_unique"
          }]);
        }
        await repo.accounts.updateEmail(normalizedId, email);
      }

      const effectiveEmail = email || account.email;
      if (!effectiveEmail) {
        throw badRequest("Account email is required before issuing an internal login setup link", [{
          field: "email",
          reason: "required"
        }]);
      }

      await repo.passwordResetTokens.revokePendingForAccount(normalizedId);
      await repo.passwordResetTokens.insert({
        accountId: normalizedId,
        tokenHash,
        purpose,
        expiresAt,
        createdByAccountId: actorAccountId || null
      });
      await repo.audit.insertSecurityEvent({
        action: purpose === "password_setup" ? "admin_password_setup_token_create" : "admin_password_reset_token_create",
        actorAccountId,
        details: {
          expiresAt,
          purpose
        },
        targetId: normalizedId,
        targetType: "account"
      });
      return {
        account: await accountSummaryForRepo(repo, normalizedId),
        expiresAt,
        purpose,
        token
      };
    }, () => createAdminPasswordResetTokenSqlite(actorAccountId, normalizedId, {
      email,
      expiresAt,
      normalizedId,
      purpose,
      token,
      tokenHash
    }));
  }

  function completeInternalPasswordSetupSqlite({
    nowMs,
    passwordHash,
    tokenHash
  }) {
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const repo = globalRepository(db);
        const tokenRow = repo.passwordResetTokens.getPendingWithAccountByHash(tokenHash);
        if (!tokenRow || Date.parse(tokenRow.expires_at) <= nowMs || tokenRow.account_status !== "active") {
          if (tokenRow && Date.parse(tokenRow.expires_at) <= nowMs) {
            repo.passwordResetTokens.markExpired(tokenRow.id);
          }
          throw badRequest("Password setup token is invalid or expired", [{
            field: "token",
            reason: "invalid_or_expired"
          }]);
        }
        if (!tokenRow.email) {
          throw conflict("Account email is required before setting an internal login password");
        }

        repo.passwordCredentials.upsert({
          accountId: tokenRow.account_id,
          passwordHash
        });
        repo.passwordResetTokens.markConsumed(tokenRow.id);
        repo.sessions.revokeForAccount(tokenRow.account_id);
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

    return await withExternalGlobalTransaction(async repo => {
      const tokenRow = await repo.passwordResetTokens.getPendingWithAccountByHash(tokenHash);
      if (!tokenRow || Date.parse(tokenRow.expires_at) <= nowMs || tokenRow.account_status !== "active") {
        if (tokenRow && Date.parse(tokenRow.expires_at) <= nowMs) {
          await repo.passwordResetTokens.markExpired(tokenRow.id);
        }
        throw badRequest("Password setup token is invalid or expired", [{
          field: "token",
          reason: "invalid_or_expired"
        }]);
      }
      if (!tokenRow.email) {
        throw conflict("Account email is required before setting an internal login password");
      }

      await repo.passwordCredentials.upsert({
        accountId: tokenRow.account_id,
        passwordHash
      });
      await repo.passwordResetTokens.markConsumed(tokenRow.id);
      await repo.sessions.revokeForAccount(tokenRow.account_id);
      await repo.audit.insertSecurityEvent({
        action: tokenRow.purpose === "password_setup" ? "password_setup_complete" : "password_reset_complete",
        actorAccountId: tokenRow.account_id,
        targetId: tokenRow.account_id,
        targetType: "account"
      });
      return {
        account: await accountSummaryForRepo(repo, tokenRow.account_id),
        ok: true
      };
    }, () => completeInternalPasswordSetupSqlite({
      nowMs,
      passwordHash,
      tokenHash
    }));
  }

  async function authenticateInternalLoginSqlite(input = {}) {
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
      const repo = globalRepository(db);
      const config = repo.authConfig.getActiveModeAndDraftConfig();
      if ((config.active_mode || "none") !== "internal") {
        throw forbidden("Internal login is disabled");
      }
      const draftConfig = normalizeDraftAuthConfig(safeJsonParseObject(config.draft_config_json || "{}", "draftConfig"));
      if (draftConfig.internal.allowPasswordLogin === false) {
        throw forbidden("Password login is disabled");
      }
      row = repo.passwordCredentials.getLoginByEmail(email);
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
      const repo = globalRepository(updateDb);
      if (!verified) {
        const attempts = Number(row.failed_attempts || 0) + 1;
        repo.passwordCredentials.recordFailedLogin({
          accountId: row.account_id,
          attempts,
          lockThreshold: PASSWORD_LOCK_THRESHOLD,
          lockUntil: addMinutesIso(PASSWORD_LOCK_MINUTES)
        });
        auditGlobalSecurity(updateDb, {
          action: "internal_login",
          actorAccountId: row.account_id,
          outcome: "failure",
          targetId: row.account_id,
          targetType: "account"
        });
        throw genericLoginError();
      }

      const activeAccount = repo.accounts.getStatus(row.account_id);
      if (!activeAccount || activeAccount.status !== "active") throw genericLoginError();

      repo.passwordCredentials.recordSuccessfulLogin(row.account_id);
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

  async function authenticateInternalLogin(input = {}) {
    if (!globalStore || globalStore.backend === "sqlite") {
      return await authenticateInternalLoginSqlite(input);
    }

    let email;
    try {
      email = normalizeAccountEmail(input.email, "email");
      normalizePassword(input.password, "password");
    } catch {
      throw genericLoginError();
    }

    const row = await withGlobalRepository(async repo => {
      const config = await repo.authConfig.getActiveModeAndDraftConfig();
      if ((config.active_mode || "none") !== "internal") {
        throw forbidden("Internal login is disabled");
      }
      const draftConfig = normalizeDraftAuthConfig(safeJsonParseObject(config.draft_config_json || "{}", "draftConfig"));
      if (draftConfig.internal.allowPasswordLogin === false) {
        throw forbidden("Password login is disabled");
      }
      const loginRow = await repo.passwordCredentials.getLoginByEmail(email);
      if (
        !loginRow
        || loginRow.status !== "active"
        || (loginRow.locked_until && Date.parse(loginRow.locked_until) > Date.now())
      ) {
        throw genericLoginError();
      }
      return loginRow;
    });

    const verified = await argon2.verify(row.password_hash, passwordMaterial(input.password));
    return await withExternalGlobalTransaction(async repo => {
      if (!verified) {
        const attempts = Number(row.failed_attempts || 0) + 1;
        await repo.passwordCredentials.recordFailedLogin({
          accountId: row.account_id,
          attempts,
          lockThreshold: PASSWORD_LOCK_THRESHOLD,
          lockUntil: addMinutesIso(PASSWORD_LOCK_MINUTES)
        });
        await repo.audit.insertSecurityEvent({
          action: "internal_login",
          actorAccountId: row.account_id,
          outcome: "failure",
          targetId: row.account_id,
          targetType: "account"
        });
        throw genericLoginError();
      }

      const activeAccount = await repo.accounts.getStatus(row.account_id);
      if (!activeAccount || activeAccount.status !== "active") throw genericLoginError();

      await repo.passwordCredentials.recordSuccessfulLogin(row.account_id);
      await repo.audit.insertSecurityEvent({
        action: "internal_login",
        actorAccountId: row.account_id,
        targetId: row.account_id,
        targetType: "account"
      });
      return {
        accountId: row.account_id
      };
    }, () => authenticateInternalLoginSqlite(input));
  }

  function registerInternalAccountWithInvitationSqlite({
    accountId,
    email,
    invitationHash,
    name,
    passwordHash
  }) {
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const repo = globalRepository(db);
        const config = repo.authConfig.getActiveMode();
        if ((config.active_mode || "none") !== "internal") {
          throw forbidden("Internal registration is disabled");
        }
        const invitation = repo.invitations.getByTokenHash(invitationHash);
        if (!invitation) throw notFound("Invitation not found");
        if (invitation.status !== "pending") throw conflict("Invitation is no longer available");
        if (databaseTimestampMs(invitation.expires_at) <= Date.now()) throw conflict("Invitation has expired");
        if (invitation.target_account_id) {
          throw conflict("Invitation is assigned to an existing account");
        }
        if (!invitation.target_email) {
          throw conflict("Invitation requires an email target before account registration");
        }
        if (String(invitation.target_email || "").toLowerCase() !== email) {
          throw forbidden("Invitation target does not match the requested email");
        }
        if (repo.accounts.emailExists(email)) {
          throw conflict("Email is already assigned to another account", [{
            field: "email",
            reason: "not_unique"
          }]);
        }

        repo.accounts.insert({ id: accountId, email, displayName: name });
        repo.passwordCredentials.insert({ accountId, passwordHash });
        repo.invitations.acceptForAccount({
          accountId,
          invitationId: invitation.id,
          role: invitation.role
        });
        repo.memberships.insert({
          budgetId: invitation.budget_id,
          accountId,
          role: invitation.role,
          invitedByAccountId: invitation.invited_by_account_id
        });
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
          membership: repo.memberships.get({
            budgetId: invitation.budget_id,
            accountId
          })
        };
      })();
      return result;
    } finally {
      db.close();
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

    return await withExternalGlobalTransaction(async repo => {
      const config = await repo.authConfig.getActiveMode();
      if ((config.active_mode || "none") !== "internal") {
        throw forbidden("Internal registration is disabled");
      }
      const invitation = await repo.invitations.getByTokenHash(invitationHash);
      if (!invitation) throw notFound("Invitation not found");
      if (invitation.status !== "pending") throw conflict("Invitation is no longer available");
      if (databaseTimestampMs(invitation.expires_at) <= Date.now()) throw conflict("Invitation has expired");
      if (invitation.target_account_id) {
        throw conflict("Invitation is assigned to an existing account");
      }
      if (!invitation.target_email) {
        throw conflict("Invitation requires an email target before account registration");
      }
      if (String(invitation.target_email || "").toLowerCase() !== email) {
        throw forbidden("Invitation target does not match the requested email");
      }
      if (await repo.accounts.emailExists(email)) {
        throw conflict("Email is already assigned to another account", [{
          field: "email",
          reason: "not_unique"
        }]);
      }

      await repo.accounts.insert({ id: accountId, email, displayName: name });
      await repo.passwordCredentials.insert({ accountId, passwordHash });
      const accepted = await repo.invitations.acceptForAccount({
        accountId,
        invitationId: invitation.id,
        role: invitation.role
      });
      if (accepted !== 1) throw conflict("Invitation is no longer available");
      await repo.memberships.insert({
        budgetId: invitation.budget_id,
        accountId,
        role: invitation.role,
        invitedByAccountId: invitation.invited_by_account_id
      });
      await repo.audit.insertSecurityEvent({
        action: "internal_invitation_register",
        actorAccountId: accountId,
        details: {
          invitationId: invitation.id,
          role: invitation.role
        },
        targetId: accountId,
        targetType: "account"
      });
      await repo.audit.insertSecurityEvent({
        action: "budget_invitation_accept",
        actorAccountId: accountId,
        targetId: invitation.id,
        targetType: "budget_invitation"
      });
      return {
        account: await accountSummaryForRepo(repo, accountId),
        budgetId: invitation.budget_id,
        membership: await repo.memberships.get({
          budgetId: invitation.budget_id,
          accountId
        })
      };
    }, () => registerInternalAccountWithInvitationSqlite({
      accountId,
      email,
      invitationHash,
      name,
      passwordHash
    }));
  }

  function authenticateExternalLoginSqlite(headers = {}) {
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const repo = globalRepository(db);
        const config = authConfigFromRow(repo.authConfig.get() || {});
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

        let identity = repo.identities.findWithAccountByProviderSubject(providerId, subject);

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
          if (repo.accounts.emailExists(email)) {
            throw conflict("Email is already assigned to another account", [{
              field: "email",
              reason: "not_unique"
            }]);
          }

          const accountId = `account_${crypto.randomUUID()}`;
          const pendingInvitation = provisioningMode === "allow_invited"
            ? repo.invitations.findPendingForEmail(email)
            : null;
          if (provisioningMode === "allow_invited" && (
            !pendingInvitation
            || databaseTimestampMs(pendingInvitation.expires_at) <= Date.now()
          )) {
            throw unauthorized("External authentication required");
          }

          repo.accounts.insert({ id: accountId, email, displayName: name });
          if (pendingInvitation) {
            repo.invitations.acceptForAccount({
              accountId,
              invitationId: pendingInvitation.id,
              role: pendingInvitation.role
            });
            repo.memberships.insert({
              budgetId: pendingInvitation.budget_id,
              accountId,
              role: pendingInvitation.role,
              invitedByAccountId: pendingInvitation.invited_by_account_id
            });
          }
          repo.identities.upsert({
            accountId,
            providerId,
            subject,
            email,
            emailVerified: true,
            lastUsedNow: true,
            profileJson: JSON.stringify({
              groups,
              trustedIssuer: external.trustedIssuer || ""
            })
          });
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

        repo.identities.updateProviderLogin({
          email,
          profileJson: JSON.stringify({
            groups,
            trustedIssuer: external.trustedIssuer || ""
          }),
          providerId,
          subject
        });

        const adminGroups = external.adminGroups || [];
        if (adminGroups.length && groups.some(group => adminGroups.includes(group))) {
          repo.roles.insertSystemAdmin({ accountId: identity.account_id });
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

  async function authenticateExternalLogin(headers = {}) {
    return await withExternalGlobalTransaction(async repo => {
      const config = authConfigFromRow(await repo.authConfig.get() || {});
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

      let identity = await repo.identities.findWithAccountByProviderSubject(providerId, subject);

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
        if (await repo.accounts.emailExists(email)) {
          throw conflict("Email is already assigned to another account", [{
            field: "email",
            reason: "not_unique"
          }]);
        }

        const accountId = `account_${crypto.randomUUID()}`;
        const pendingInvitation = provisioningMode === "allow_invited"
          ? await repo.invitations.findPendingForEmail(email)
          : null;
        if (provisioningMode === "allow_invited" && (
          !pendingInvitation
          || databaseTimestampMs(pendingInvitation.expires_at) <= Date.now()
        )) {
          throw unauthorized("External authentication required");
        }

        await repo.accounts.insert({ id: accountId, email, displayName: name });
        if (pendingInvitation) {
          const accepted = await repo.invitations.acceptForAccount({
            accountId,
            invitationId: pendingInvitation.id,
            role: pendingInvitation.role
          });
          if (accepted !== 1) throw conflict("Invitation is no longer available");
          await repo.memberships.insert({
            budgetId: pendingInvitation.budget_id,
            accountId,
            role: pendingInvitation.role,
            invitedByAccountId: pendingInvitation.invited_by_account_id
          });
        }
        await repo.identities.upsert({
          accountId,
          providerId,
          subject,
          email,
          emailVerified: true,
          lastUsedNow: true,
          profileJson: JSON.stringify({
            groups,
            trustedIssuer: external.trustedIssuer || ""
          })
        });
        await repo.audit.insertSecurityEvent({
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

      await repo.identities.updateProviderLogin({
        email,
        profileJson: JSON.stringify({
          groups,
          trustedIssuer: external.trustedIssuer || ""
        }),
        providerId,
        subject
      });

      const adminGroups = external.adminGroups || [];
      if (adminGroups.length && groups.some(group => adminGroups.includes(group))) {
        await repo.roles.insertSystemAdmin({ accountId: identity.account_id });
      }
      await repo.audit.insertSecurityEvent({
        action: "external_login",
        actorAccountId: identity.account_id,
        details: {
          providerId
        },
        targetId: identity.account_id,
        targetType: "account"
      });
      return {
        accountId: identity.account_id
      };
    }, () => authenticateExternalLoginSqlite(headers));
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
        globalRepository(db).authConfig.updateDraft({
          draftMode,
          sessionAbsoluteMinutes,
          sessionIdleMinutes,
          draftConfigJson: JSON.stringify(draftConfig)
        });
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

  async function updateAdminAuthDraftAsync(actorAccountId, input = {}) {
    const current = await getAdminAuthConfigAsync();
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

    return await withExternalGlobalTransaction(async repo => {
      await repo.authConfig.updateDraft({
        draftMode,
        sessionAbsoluteMinutes,
        sessionIdleMinutes,
        draftConfigJson: JSON.stringify(draftConfig)
      });
      await repo.audit.insertSecurityEvent({
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
      return authConfigFromRow(await repo.authConfig.get() || {});
    }, () => updateAdminAuthDraft(actorAccountId, input));
  }

  function testAdminAuthDraft(actorAccountId) {
    const db = openGlobalDb();
    try {
      const config = authConfigFromRow(globalRepository(db).authConfig.get() || {});
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

  async function testAdminAuthDraftAsync(actorAccountId) {
    return await withExternalGlobalTransaction(async repo => {
      const config = authConfigFromRow(await repo.authConfig.get() || {});
      const activeAdminCount = await repo.accounts.countActiveSystemAdmins();
      const checks = [
        {
          ok: activeAdminCount > 0,
          code: "active_system_admin",
          message: "At least one active system administrator exists"
        }
      ];
      if (config.draftMode === "external") {
        const externalSecretConfigured = Boolean(externalSecretForConfig(config.draftConfig.external));
        const externalAdminCount = await repo.accounts.countActiveExternalSystemAdmins(
          externalProviderId(config.draftConfig.external)
        );
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
        const internalAdminCount = await repo.accounts.countActiveInternalSystemAdmins();
        checks.push({
          ok: internalAdminCount > 0,
          code: "internal_admin_credential",
          message: "At least one active system administrator has an email and internal password credential"
        });
      }
      const ok = checks.every(check => check.ok);
      const activatable = ok;

      await repo.audit.insertSecurityEvent({
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
    }, () => testAdminAuthDraft(actorAccountId));
  }

  function activateAdminAuthDraft(actorAccountId) {
    const db = openGlobalDb();
    try {
      let result;
      db.transaction(() => {
        const repo = globalRepository(db);
        const config = authConfigFromRow(repo.authConfig.get() || {});
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

        repo.authConfig.activateDraft();
        if (config.activeMode !== config.draftMode) {
          repo.sessions.revokeAll();
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
        result = authConfigFromRow(repo.authConfig.get() || {});
      })();
      return result;
    } finally {
      db.close();
    }
  }

  async function activateAdminAuthDraftAsync(actorAccountId) {
    return await withExternalGlobalTransaction(async repo => {
      const config = authConfigFromRow(await repo.authConfig.get() || {});
      const activeAdminCount = await repo.accounts.countActiveSystemAdmins();
      if (activeAdminCount < 1) {
        throw conflict("At least one active system administrator is required");
      }
      if (config.draftMode === "external") {
        if (!externalSecretForConfig(config.draftConfig.external)) {
          throw conflict("External authentication secret is not configured");
        }
        if (await repo.accounts.countActiveExternalSystemAdmins(externalProviderId(config.draftConfig.external)) < 1) {
          throw conflict("At least one active system administrator with an external identity is required");
        }
      }
      if (config.draftMode === "internal" && await repo.accounts.countActiveInternalSystemAdmins() < 1) {
        throw conflict("At least one active system administrator with an internal password is required");
      }

      await repo.authConfig.activateDraft();
      if (config.activeMode !== config.draftMode) {
        await repo.sessions.revokeAll();
      }
      await repo.audit.insertSecurityEvent({
        action: "admin_auth_activate",
        actorAccountId,
        details: {
          activeMode: config.draftMode
        },
        targetType: "auth_config",
        targetId: "1"
      });
      return authConfigFromRow(await repo.authConfig.get() || {});
    }, () => activateAdminAuthDraft(actorAccountId));
  }

  return {
    activateAdminAuthDraft,
    activateAdminAuthDraftAsync,
    authenticateInternalLogin,
    authenticateExternalLogin,
    completeAuthProviderCallback,
    completeInternalPasswordSetup,
    createAdminPasswordResetToken,
    createUser,
    createUserAsync,
    deleteAdminAccount,
    deleteAdminAccountAsync,
    deleteAdminAuthProvider,
    deleteAdminAuthProviderAsync,
    getAdminAuthConfig,
    getAdminAuthConfigAsync,
    getGlobalOptions,
    getGlobalOptionsAsync,
    initializeBudgetStorage,
    initializeBudgetStorageAsync,
    listAdminAccounts,
    listAdminAccountsAsync,
    listActiveBudgetIds,
    listActiveBudgetIdsAsync,
    listAuthProviders,
    listAuthProvidersAsync,
    listUsers,
    listUsersAsync,
    openGlobalDb,
    registerInternalAccountWithInvitation,
    resolveAccountContext,
    resolveAccountContextAsync,
    resolveBudgetContext,
    resolveBudgetContextAsync,
    resolveBudgetStorageKey,
    resolveSession,
    resolveSessionAsync,
    setAdminProviderIdentity,
    setAdminProviderIdentityAsync,
    setAdminExternalIdentity,
    setAdminExternalIdentityAsync,
    revokeAdminAccountSession,
    revokeAdminAccountSessionAsync,
    selectUser,
    selectUserAsync,
    setAccountSystemAdmin,
    setAccountSystemAdminAsync,
    startAuthProviderLink,
    startAuthProviderLogin,
    testAdminAuthDraft,
    testAdminAuthDraftAsync,
    upsertAdminAuthProvider,
    upsertAdminAuthProviderAsync,
    updateAdminAuthDraft,
    updateAdminAuthDraftAsync,
    updateAdminAccount,
    updateAdminAccountAsync,
    userExists,
    updateGlobalOptions,
    updateGlobalOptionsAsync
  };
}
