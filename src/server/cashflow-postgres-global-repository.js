import crypto from "node:crypto";

import { LEGACY_ADMIN_ACCOUNT_ID } from "./cashflow-global-schema.js";
import { normalizeUserId, notFound } from "./cashflow-user-utils.js";

export const POSTGRES_GLOBAL_REPOSITORY_BACKEND = "postgres";

function ensureClient(client) {
  if (!client || typeof client.query !== "function") {
    throw new Error("Postgres global repository requires a client with query()");
  }
}

function nowIso(now) {
  const value = now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function bool(value) {
  return Boolean(value);
}

function jsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function changes(result) {
  return Number(result?.rowCount || 0);
}

export function createPostgresGlobalRepository(client, {
  generateAuditId = () => `audit_${crypto.randomUUID()}`,
  now = () => new Date(),
  nowMs = () => Date.now()
} = {}) {
  ensureClient(client);

  async function one(sql, params = []) {
    return (await client.query(sql, params))?.rows?.[0];
  }

  async function all(sql, params = []) {
    return (await client.query(sql, params))?.rows || [];
  }

  async function run(sql, params = []) {
    return await client.query(sql, params);
  }

  async function count(sql, params = []) {
    return Number((await one(sql, params))?.count || 0);
  }

  async function getAccount(accountId) {
    const normalizedId = normalizeUserId(accountId);
    return await one(`
      SELECT id, email, display_name, status, created_at, updated_at,
        disabled_at, deleted_at
      FROM accounts
      WHERE id = $1
    `, [normalizedId]);
  }

  async function requireAccount(accountId) {
    const account = await getAccount(accountId);
    if (!account) throw notFound("Account not found");
    return account;
  }

  async function getBudget(budgetId) {
    const normalizedId = normalizeUserId(budgetId);
    return await one(`
      SELECT id, storage_key, display_name, status, created_by_account_id,
        created_at, updated_at, archived_at, deleted_at
      FROM budgets
      WHERE id = $1
    `, [normalizedId]);
  }

  async function ensureLegacyAdmin() {
    const timestamp = nowIso(now);
    const existing = await one("SELECT id FROM accounts WHERE id = $1", [LEGACY_ADMIN_ACCOUNT_ID]);
    await run(`
      INSERT INTO accounts (
        id, email, display_name, status, created_at, updated_at
      )
      VALUES ($1, NULL, 'Legacy Administrator', 'active', $2, $2)
      ON CONFLICT (id) DO NOTHING
    `, [LEGACY_ADMIN_ACCOUNT_ID, timestamp]);

    if (!existing) {
      await run(`
        INSERT INTO account_global_roles (
          account_id, role, granted_by_account_id, created_at
        )
        VALUES ($1, 'system_admin', NULL, $2)
        ON CONFLICT (account_id, role) DO NOTHING
      `, [LEGACY_ADMIN_ACCOUNT_ID, timestamp]);
    }
  }

  async function activeSessionsForAccount(accountId) {
    const timestamp = new Date(nowMs()).toISOString();
    return await all(`
      SELECT id, auth_method, selected_budget_id, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at
      FROM auth_sessions
      WHERE account_id = $1
        AND revoked_at IS NULL
        AND idle_expires_at > $2
        AND absolute_expires_at > $2
      ORDER BY last_seen_at DESC, created_at DESC
    `, [normalizeUserId(accountId), timestamp]);
  }

  return {
    backend: POSTGRES_GLOBAL_REPOSITORY_BACKEND,
    identity: {
      async legacyUserAccountOrBudgetExists(id) {
        const normalizedId = normalizeUserId(id);
        return Boolean(await one(`
          SELECT id FROM users WHERE id = $1
          UNION ALL
          SELECT id FROM accounts WHERE id = $1
          UNION ALL
          SELECT id FROM budgets WHERE id = $1
          LIMIT 1
        `, [normalizedId]));
      }
    },
    accounts: {
      async count() {
        return await count("SELECT COUNT(*) AS count FROM accounts");
      },
      async countActiveExternalSystemAdmins(providerId) {
        return await count(`
          SELECT COUNT(*) AS count
          FROM account_global_roles agr
          JOIN accounts a ON a.id = agr.account_id
          JOIN auth_identities ai ON ai.account_id = a.id
          WHERE agr.role = 'system_admin'
            AND a.status = 'active'
            AND ai.provider_id = $1
        `, [providerId]);
      },
      async countActiveInternalSystemAdmins() {
        return await count(`
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
                  AND ap.enabled = true
              )
            )
        `);
      },
      async countActiveSystemAdmins() {
        return await count(`
          SELECT COUNT(*) AS count
          FROM account_global_roles agr
          JOIN accounts a ON a.id = agr.account_id
          WHERE agr.role = 'system_admin'
            AND a.status = 'active'
        `);
      },
      async delete(id) {
        await run("DELETE FROM accounts WHERE id = $1", [normalizeUserId(id)]);
      },
      async emailExists(email, { excludeId = null } = {}) {
        if (excludeId) {
          return Boolean(await one(`
            SELECT 1
            FROM accounts
            WHERE email = $1 AND id != $2
          `, [email, normalizeUserId(excludeId)]));
        }
        return Boolean(await one("SELECT 1 FROM accounts WHERE email = $1", [email]));
      },
      get: getAccount,
      async getStatus(id) {
        return await one(`
          SELECT status
          FROM accounts
          WHERE id = $1
        `, [normalizeUserId(id)]);
      },
      async insert({ id, email = null, displayName }) {
        const normalizedId = normalizeUserId(id);
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO accounts (
            id, email, display_name, status, created_at, updated_at
          )
          VALUES ($1, $2, $3, 'active', $4, $4)
        `, [normalizedId, email, displayName, timestamp]);
      },
      async listActive() {
        return await all(`
          SELECT id, email, display_name, status, created_at, updated_at
          FROM accounts
          WHERE status = 'active'
          ORDER BY LOWER(display_name), id
        `);
      },
      async listAdminIds() {
        return await all(`
          SELECT id
          FROM accounts
          ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'disabled' THEN 1 ELSE 2 END,
            LOWER(display_name), id
        `);
      },
      async markDeleted(id) {
        const timestamp = nowIso(now);
        await run(`
          UPDATE accounts
          SET status = 'deleted',
              deleted_at = $2,
              updated_at = $2
          WHERE id = $1
        `, [normalizeUserId(id), timestamp]);
      },
      require: requireAccount,
      async updateDisplayName(id, displayName) {
        await run(`
          UPDATE accounts
          SET display_name = $2,
              updated_at = $3
          WHERE id = $1
        `, [normalizeUserId(id), displayName, nowIso(now)]);
      },
      async updateEmail(id, email) {
        await run(`
          UPDATE accounts
          SET email = $2,
              updated_at = $3
          WHERE id = $1
        `, [normalizeUserId(id), email, nowIso(now)]);
      },
      async updateStatus(id, status) {
        const timestamp = nowIso(now);
        await run(`
          UPDATE accounts
          SET status = $2,
              disabled_at = CASE WHEN $2 = 'disabled' THEN $3 ELSE NULL END,
              updated_at = $3
          WHERE id = $1
        `, [normalizeUserId(id), status, timestamp]);
      }
    },
    audit: {
      async insertSecurityEvent({
        action,
        actorAccountId = null,
        details = {},
        outcome = "success",
        targetId = null,
        targetType = null
      }) {
        await run(`
          INSERT INTO security_audit_log (
            id, actor_account_id, action, target_type, target_id, outcome,
            details_json, created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          generateAuditId(),
          actorAccountId || null,
          action,
          targetType,
          targetId,
          outcome,
          jsonValue(details || {}, "{}"),
          nowIso(now)
        ]);
      }
    },
    authConfig: {
      async get() {
        return await one("SELECT * FROM auth_config WHERE id = 1");
      },
      async getActiveMode() {
        return await one("SELECT active_mode FROM auth_config WHERE id = 1") || {};
      },
      async getActiveModeAndDraftConfig() {
        return await one("SELECT active_mode, draft_config_json FROM auth_config WHERE id = 1") || {};
      },
      async activateDraft() {
        await run(`
          UPDATE auth_config
          SET active_mode = draft_mode,
              external_config_json = draft_config_json,
              updated_at = $1
          WHERE id = 1
        `, [nowIso(now)]);
      },
      async markBootstrapCompleted() {
        const timestamp = nowIso(now);
        await run(`
          UPDATE auth_config
          SET bootstrap_completed_at = COALESCE(bootstrap_completed_at, $1),
              updated_at = $1
          WHERE id = 1
        `, [timestamp]);
      },
      async updateDraft({
        draftConfigJson,
        draftMode,
        sessionAbsoluteMinutes,
        sessionIdleMinutes
      }) {
        await run(`
          UPDATE auth_config
          SET draft_mode = $1,
              session_idle_minutes = $2,
              session_absolute_minutes = $3,
              draft_config_json = $4,
              updated_at = $5
          WHERE id = 1
        `, [
          draftMode,
          sessionIdleMinutes,
          sessionAbsoluteMinutes,
          jsonValue(draftConfigJson, "{}"),
          nowIso(now)
        ]);
      }
    },
    authProviders: {
      async delete(id) {
        await run("DELETE FROM auth_providers WHERE id = $1", [id]);
      },
      async get(id) {
        return await one("SELECT * FROM auth_providers WHERE id = $1", [id]);
      },
      async list({ publicOnly = false } = {}) {
        return await all(`
          SELECT *
          FROM auth_providers
          ${publicOnly ? "WHERE enabled = true" : ""}
          ORDER BY display_name, id
        `);
      },
      async upsert({
        clientId,
        configJson,
        displayName,
        enabled,
        id,
        issuer,
        kind,
        secretRef
      }) {
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO auth_providers (
            id, kind, display_name, enabled, issuer, client_id, secret_ref,
            config_json, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
          ON CONFLICT (id) DO UPDATE SET
            kind = EXCLUDED.kind,
            display_name = EXCLUDED.display_name,
            enabled = EXCLUDED.enabled,
            issuer = EXCLUDED.issuer,
            client_id = EXCLUDED.client_id,
            secret_ref = EXCLUDED.secret_ref,
            config_json = EXCLUDED.config_json,
            updated_at = EXCLUDED.updated_at
        `, [
          id,
          kind,
          displayName,
          bool(enabled),
          issuer,
          clientId,
          secretRef,
          jsonValue(configJson, "{}"),
          timestamp
        ]);
      }
    },
    budgets: {
      async delete(id) {
        await run("DELETE FROM budgets WHERE id = $1", [normalizeUserId(id)]);
      },
      async ensureLegacy({ id, displayName = "", storageKey = id }) {
        const normalizedId = normalizeUserId(id);
        const normalizedStorageKey = normalizeUserId(storageKey);
        const timestamp = nowIso(now);
        await ensureLegacyAdmin();
        await run(`
          INSERT INTO budgets (
            id, storage_key, display_name, status, created_by_account_id,
            created_at, updated_at
          )
          VALUES ($1, $2, $3, 'active', $4, $5, $5)
          ON CONFLICT (id) DO NOTHING
        `, [
          normalizedId,
          normalizedStorageKey,
          String(displayName || normalizedId).trim() || normalizedId,
          LEGACY_ADMIN_ACCOUNT_ID,
          timestamp
        ]);
        await run(`
          INSERT INTO budget_memberships (
            budget_id, account_id, role, invited_by_account_id, created_at,
            updated_at
          )
          VALUES ($1, $2, 'owner', NULL, $3, $3)
          ON CONFLICT (budget_id, account_id) DO NOTHING
        `, [normalizedId, LEGACY_ADMIN_ACCOUNT_ID, timestamp]);
        return normalizedId;
      },
      get: getBudget,
      async insert({ id, displayName, storageKey = id, createdByAccountId = null }) {
        const normalizedId = normalizeUserId(id);
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO budgets (
            id, storage_key, display_name, status, created_by_account_id,
            created_at, updated_at
          )
          VALUES ($1, $2, $3, 'active', $4, $5, $5)
        `, [
          normalizedId,
          normalizeUserId(storageKey),
          displayName,
          createdByAccountId ? normalizeUserId(createdByAccountId) : null,
          timestamp
        ]);
      },
      async listActiveStorage() {
        return await all(`
          SELECT id, storage_key
          FROM budgets
          WHERE status = 'active'
          ORDER BY id
        `);
      },
      async updateDisplayName(id, displayName) {
        await run(`
          UPDATE budgets
          SET display_name = $2,
              updated_at = $3
          WHERE id = $1
        `, [normalizeUserId(id), displayName, nowIso(now)]);
      },
      async markArchived(id) {
        const timestamp = nowIso(now);
        await run(`
          UPDATE budgets
          SET status = 'archived',
              archived_at = $2,
              updated_at = $2
          WHERE id = $1
        `, [normalizeUserId(id), timestamp]);
      },
      async markActive(id) {
        await run(`
          UPDATE budgets
          SET status = 'active',
              archived_at = NULL,
              updated_at = $2
          WHERE id = $1
        `, [normalizeUserId(id), nowIso(now)]);
      },
      async markDeleted(id) {
        const timestamp = nowIso(now);
        await run(`
          UPDATE budgets
          SET status = 'deleted',
              deleted_at = $2,
              updated_at = $2
          WHERE id = $1
        `, [normalizeUserId(id), timestamp]);
      }
    },
    globalOptions: {
      async get() {
        return await one("SELECT * FROM global_options WHERE id = 1");
      },
      async updatePlannerDefaults(settings) {
        await run(`
          UPDATE global_options
          SET ledger_currency = $1,
              locale = $2,
              timezone = $3,
              holiday_country = $4,
              future_periods = $5,
              fx_provider = $6,
              fx_buffer_percent = $7,
              updated_at = $8
          WHERE id = 1
        `, [
          settings.ledger_currency,
          settings.locale,
          settings.timezone,
          settings.holiday_country,
          settings.future_periods,
          settings.fx_provider,
          settings.fx_buffer_percent,
          nowIso(now)
        ]);
      }
    },
    identities: {
      async countForAccount(accountId) {
        return await count(`
          SELECT COUNT(*) AS count
          FROM auth_identities
          WHERE account_id = $1
        `, [normalizeUserId(accountId)]);
      },
      async deleteForAccount(accountId) {
        await run("DELETE FROM auth_identities WHERE account_id = $1", [normalizeUserId(accountId)]);
      },
      async listForAccount(accountId) {
        return await all(`
          SELECT id, provider_id, subject, email, email_verified, created_at,
            updated_at, last_used_at
          FROM auth_identities
          WHERE account_id = $1
          ORDER BY provider_id, subject
        `, [normalizeUserId(accountId)]);
      },
      async findAccountByProviderSubject(providerId, subject) {
        return await one(`
          SELECT account_id
          FROM auth_identities
          WHERE provider_id = $1 AND subject = $2
        `, [providerId, subject]);
      },
      async findWithAccountByProviderSubject(providerId, subject) {
        return await one(`
          SELECT ai.account_id, a.status
          FROM auth_identities ai
          JOIN accounts a ON a.id = ai.account_id
          WHERE ai.provider_id = $1 AND ai.subject = $2
        `, [providerId, subject]);
      },
      async updateProviderLogin({
        email = null,
        emailVerified = null,
        profileJson,
        providerId,
        subject
      }) {
        const timestamp = nowIso(now);
        if (emailVerified === null || emailVerified === undefined) {
          await run(`
            UPDATE auth_identities
            SET email = COALESCE($1, email),
                profile_json = $2,
                last_used_at = $3,
                updated_at = $3
            WHERE provider_id = $4 AND subject = $5
          `, [email, jsonValue(profileJson, "{}"), timestamp, providerId, subject]);
          return;
        }
        await run(`
          UPDATE auth_identities
          SET email = COALESCE($1, email),
              email_verified = $2,
              profile_json = $3,
              last_used_at = $4,
              updated_at = $4
          WHERE provider_id = $5 AND subject = $6
        `, [email, bool(emailVerified), jsonValue(profileJson, "{}"), timestamp, providerId, subject]);
      },
      async upsert({
        accountId,
        email = null,
        emailVerified = false,
        id = `identity_${crypto.randomUUID()}`,
        lastUsedNow = false,
        profileJson = "{}",
        providerId,
        subject
      }) {
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO auth_identities (
            id, account_id, provider_id, subject, email, email_verified,
            profile_json, created_at, updated_at, last_used_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, CASE WHEN $9 THEN $8 ELSE NULL END)
          ON CONFLICT (provider_id, subject) DO UPDATE SET
            account_id = EXCLUDED.account_id,
            email = EXCLUDED.email,
            email_verified = EXCLUDED.email_verified,
            profile_json = EXCLUDED.profile_json,
            last_used_at = CASE
              WHEN $9 THEN $8
              ELSE auth_identities.last_used_at
            END,
            updated_at = $8
        `, [
          id,
          normalizeUserId(accountId),
          providerId,
          subject,
          email,
          bool(emailVerified),
          jsonValue(profileJson, "{}"),
          timestamp,
          bool(lastUsedNow)
        ]);
      }
    },
    invitations: {
      async acceptForAccount({
        accountId,
        invitationId,
        role = null
      }) {
        const timestamp = nowIso(now);
        const result = await run(`
          UPDATE budget_invitations
          SET target_account_id = $1,
              status = 'accepted',
              accepted_at = $3,
              updated_at = $3
          WHERE id = $2 AND status = 'pending'
        `, [normalizeUserId(accountId), invitationId, timestamp]);
        if (role) {
          const row = await one("SELECT role FROM budget_invitations WHERE id = $1", [invitationId]);
          if (row?.role !== role) {
            throw new Error("Invitation role changed before acceptance");
          }
        }
        return changes(result);
      },
      async findPendingForEmail(email) {
        return await one(`
          SELECT *
          FROM budget_invitations
          WHERE target_email = $1
            AND status = 'pending'
            AND target_account_id IS NULL
          ORDER BY expires_at ASC, created_at ASC
          LIMIT 1
        `, [email]);
      },
      async getByTokenHash(tokenHash) {
        return await one(`
          SELECT *
          FROM budget_invitations
          WHERE token_hash = $1
        `, [tokenHash]);
      },
      async getForBudget({ budgetId, invitationId }) {
        return await one(`
          SELECT id, budget_id, target_account_id, target_email, role, status,
            invited_by_account_id, expires_at, accepted_at, revoked_at, created_at,
            updated_at
          FROM budget_invitations
          WHERE id = $1 AND budget_id = $2
        `, [invitationId, normalizeUserId(budgetId)]);
      },
      async insertPending({
        budgetId,
        expiresAt,
        id,
        invitedByAccountId,
        role,
        targetAccountId = null,
        targetEmail = null,
        tokenHash
      }) {
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO budget_invitations (
            id, budget_id, target_account_id, target_email, role, token_hash,
            status, invited_by_account_id, expires_at, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $9)
        `, [
          id,
          normalizeUserId(budgetId),
          targetAccountId ? normalizeUserId(targetAccountId) : null,
          targetEmail,
          role,
          tokenHash,
          normalizeUserId(invitedByAccountId),
          expiresAt,
          timestamp
        ]);
      },
      async expirePendingForBudget(budgetId) {
        const result = await run(`
          UPDATE budget_invitations
          SET status = 'expired',
              updated_at = $2
          WHERE budget_id = $1
            AND status = 'pending'
            AND expires_at <= $2
        `, [normalizeUserId(budgetId), nowIso(now)]);
        return changes(result);
      },
      // Used when purging a budget: removes every invitation row regardless
      // of status, matching sync purgeBudget's unconditional
      // `DELETE FROM budget_invitations WHERE budget_id = ?`.
      async deleteAllForBudget(budgetId) {
        const result = await run(`
          DELETE FROM budget_invitations
          WHERE budget_id = $1
        `, [normalizeUserId(budgetId)]);
        return changes(result);
      },
      async listForBudget(budgetId) {
        return await all(`
          SELECT id, budget_id, target_account_id, target_email, role, status,
            invited_by_account_id, expires_at, accepted_at, revoked_at, created_at,
            updated_at
          FROM budget_invitations
          WHERE budget_id = $1
          ORDER BY created_at DESC
        `, [normalizeUserId(budgetId)]);
      },
      async revokePending(invitationId) {
        const result = await run(`
          UPDATE budget_invitations
          SET status = 'revoked',
              revoked_at = $2,
              updated_at = $2
          WHERE id = $1 AND status = 'pending'
        `, [invitationId, nowIso(now)]);
        return changes(result);
      },
      async revokePendingForTargetAccount(accountId) {
        await run(`
          UPDATE budget_invitations
          SET status = 'revoked',
              revoked_at = COALESCE(revoked_at, $2),
              updated_at = $2
          WHERE target_account_id = $1
            AND status = 'pending'
        `, [normalizeUserId(accountId), nowIso(now)]);
      }
    },
    memberships: {
      async activeOwnerAccountId(budgetId) {
        return (await one(`
          SELECT bm.account_id
          FROM budget_memberships bm
          JOIN accounts a ON a.id = bm.account_id
          JOIN budgets b ON b.id = bm.budget_id
          WHERE bm.budget_id = $1
            AND bm.role = 'owner'
            AND a.status = 'active'
            AND b.status = 'active'
        `, [normalizeUserId(budgetId)]))?.account_id || null;
      },
      async countForAccount(accountId) {
        return await count(`
          SELECT COUNT(*) AS count
          FROM budget_memberships bm
          JOIN budgets b ON b.id = bm.budget_id
          WHERE bm.account_id = $1
            AND b.status != 'deleted'
        `, [normalizeUserId(accountId)]);
      },
      async countOwnedForAccount(accountId) {
        return await count(`
          SELECT COUNT(*) AS count
          FROM budget_memberships bm
          JOIN budgets b ON b.id = bm.budget_id
          WHERE bm.account_id = $1
            AND bm.role = 'owner'
            AND b.status != 'deleted'
        `, [normalizeUserId(accountId)]);
      },
      async getRole({ accountId, budgetId }) {
        return await one(`
          SELECT role
          FROM budget_memberships
          WHERE budget_id = $1 AND account_id = $2
        `, [normalizeUserId(budgetId), normalizeUserId(accountId)]);
      },
      async get({ accountId, budgetId }) {
        return await one(`
          SELECT budget_id, account_id, role, invited_by_account_id, created_at, updated_at
          FROM budget_memberships
          WHERE budget_id = $1 AND account_id = $2
        `, [normalizeUserId(budgetId), normalizeUserId(accountId)]);
      },
      async insert({
        accountId,
        budgetId,
        invitedByAccountId = null,
        role
      }) {
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO budget_memberships (
            budget_id, account_id, role, invited_by_account_id, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $5)
        `, [
          normalizeUserId(budgetId),
          normalizeUserId(accountId),
          role,
          invitedByAccountId ? normalizeUserId(invitedByAccountId) : null,
          timestamp
        ]);
      },
      async insertOwner({ accountId, budgetId, invitedByAccountId = null }) {
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO budget_memberships (
            budget_id, account_id, role, invited_by_account_id, created_at, updated_at
          )
          VALUES ($1, $2, 'owner', $3, $4, $4)
        `, [
          normalizeUserId(budgetId),
          normalizeUserId(accountId),
          invitedByAccountId ? normalizeUserId(invitedByAccountId) : null,
          timestamp
        ]);
      },
      async upsertFromInvitation({
        accountId,
        budgetId,
        invitedByAccountId = null,
        role
      }) {
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO budget_memberships (
            budget_id, account_id, role, invited_by_account_id, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $5)
          ON CONFLICT (budget_id, account_id) DO UPDATE SET
            role = CASE
              WHEN budget_memberships.role = 'owner' THEN budget_memberships.role
              ELSE EXCLUDED.role
            END,
            invited_by_account_id = EXCLUDED.invited_by_account_id,
            updated_at = $5
        `, [
          normalizeUserId(budgetId),
          normalizeUserId(accountId),
          role,
          invitedByAccountId ? normalizeUserId(invitedByAccountId) : null,
          timestamp
        ]);
      },
      async updateRole({ accountId, budgetId, role }) {
        await run(`
          UPDATE budget_memberships
          SET role = $3,
              updated_at = $4
          WHERE budget_id = $1 AND account_id = $2
        `, [
          normalizeUserId(budgetId),
          normalizeUserId(accountId),
          role,
          nowIso(now)
        ]);
      },
      async updateOwnerAccount({ budgetId, fromAccountId, toAccountId }) {
        await run(`
          UPDATE budget_memberships
          SET account_id = $3,
              updated_at = $4
          WHERE budget_id = $1 AND account_id = $2 AND role = 'owner'
        `, [
          normalizeUserId(budgetId),
          normalizeUserId(fromAccountId),
          normalizeUserId(toAccountId),
          nowIso(now)
        ]);
      },
      async delete({ accountId, budgetId }) {
        await run(`
          DELETE FROM budget_memberships
          WHERE budget_id = $1 AND account_id = $2
        `, [normalizeUserId(budgetId), normalizeUserId(accountId)]);
      },
      // Used when purging a budget: removes every membership row for it in
      // one statement, matching sync purgeBudget's unconditional
      // `DELETE FROM budget_memberships WHERE budget_id = ?`.
      async deleteAllForBudget(budgetId) {
        const result = await run(`
          DELETE FROM budget_memberships
          WHERE budget_id = $1
        `, [normalizeUserId(budgetId)]);
        return changes(result);
      },
      async ownerAccountId(budgetId) {
        return (await one(`
          SELECT account_id
          FROM budget_memberships
          WHERE budget_id = $1 AND role = 'owner'
        `, [normalizeUserId(budgetId)]))?.account_id || null;
      },
      async listBudgetsForAccount(accountId, { includeArchived = true } = {}) {
        return await all(`
          SELECT b.id, b.display_name, b.status, b.created_at, b.updated_at,
            b.archived_at, bm.role
          FROM budget_memberships bm
          JOIN budgets b ON b.id = bm.budget_id
          WHERE bm.account_id = $1
            AND b.status != 'deleted'
            AND ($2 = true OR b.status = 'active')
          ORDER BY CASE b.status WHEN 'active' THEN 0 ELSE 1 END,
            LOWER(b.display_name), b.id
        `, [normalizeUserId(accountId), Boolean(includeArchived)]);
      },
      async listMembers(budgetId) {
        return await all(`
          SELECT a.id AS account_id, a.email, a.display_name, a.status,
            bm.role, bm.created_at, bm.updated_at
          FROM budget_memberships bm
          JOIN accounts a ON a.id = bm.account_id
          WHERE bm.budget_id = $1
          ORDER BY CASE bm.role
            WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
            LOWER(a.display_name), a.id
        `, [normalizeUserId(budgetId)]);
      }
    },
    passwordCredentials: {
      async deleteForAccount(accountId) {
        await run("DELETE FROM password_credentials WHERE account_id = $1", [normalizeUserId(accountId)]);
      },
      async existsForAccount(accountId) {
        return Boolean(await one(`
          SELECT 1
          FROM password_credentials
          WHERE account_id = $1
          LIMIT 1
        `, [normalizeUserId(accountId)]));
      },
      async getLoginByEmail(email) {
        return await one(`
          SELECT a.id AS account_id, a.status, pc.password_hash,
            pc.failed_attempts, pc.locked_until
          FROM accounts a
          JOIN password_credentials pc ON pc.account_id = a.id
          WHERE a.email = $1
        `, [email]);
      },
      async insert({ accountId, passwordHash }) {
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO password_credentials (
            account_id, password_hash, password_changed_at, failed_attempts,
            locked_until, created_at, updated_at
          )
          VALUES ($1, $2, $3, 0, NULL, $3, $3)
        `, [normalizeUserId(accountId), passwordHash, timestamp]);
      },
      async recordFailedLogin({
        accountId,
        attempts,
        lockUntil,
        lockThreshold
      }) {
        await run(`
          UPDATE password_credentials
          SET failed_attempts = $2,
              locked_until = CASE WHEN $2 >= $3 THEN $4 ELSE locked_until END,
              updated_at = $5
          WHERE account_id = $1
        `, [
          normalizeUserId(accountId),
          attempts,
          lockThreshold,
          lockUntil,
          nowIso(now)
        ]);
      },
      async recordSuccessfulLogin(accountId) {
        await run(`
          UPDATE password_credentials
          SET failed_attempts = 0,
              locked_until = NULL,
              updated_at = $2
          WHERE account_id = $1
        `, [normalizeUserId(accountId), nowIso(now)]);
      },
      async upsert({ accountId, passwordHash }) {
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO password_credentials (
            account_id, password_hash, password_changed_at, failed_attempts,
            locked_until, created_at, updated_at
          )
          VALUES ($1, $2, $3, 0, NULL, $3, $3)
          ON CONFLICT (account_id) DO UPDATE SET
            password_hash = EXCLUDED.password_hash,
            password_changed_at = EXCLUDED.password_changed_at,
            failed_attempts = 0,
            locked_until = NULL,
            updated_at = EXCLUDED.updated_at
        `, [normalizeUserId(accountId), passwordHash, timestamp]);
      }
    },
    passwordResetTokens: {
      async deleteForAccount(accountId) {
        await run("DELETE FROM password_reset_tokens WHERE account_id = $1", [normalizeUserId(accountId)]);
      },
      async getPendingWithAccountByHash(tokenHash) {
        return await one(`
          SELECT prt.*, a.email, a.display_name, a.status AS account_status
          FROM password_reset_tokens prt
          JOIN accounts a ON a.id = prt.account_id
          WHERE prt.token_hash = $1
            AND prt.status = 'pending'
        `, [tokenHash]);
      },
      async insert({
        accountId,
        createdByAccountId = null,
        expiresAt,
        id = `password_token_${crypto.randomUUID()}`,
        purpose,
        tokenHash
      }) {
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO password_reset_tokens (
            id, account_id, token_hash, purpose, status, expires_at,
            consumed_at, created_by_account_id, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, 'pending', $5, NULL, $6, $7, $7)
        `, [
          id,
          normalizeUserId(accountId),
          tokenHash,
          purpose,
          expiresAt,
          createdByAccountId ? normalizeUserId(createdByAccountId) : null,
          timestamp
        ]);
      },
      async markConsumed(id) {
        const timestamp = nowIso(now);
        await run(`
          UPDATE password_reset_tokens
          SET status = 'consumed',
              consumed_at = $2,
              updated_at = $2
          WHERE id = $1
        `, [id, timestamp]);
      },
      async markExpired(id) {
        await run(`
          UPDATE password_reset_tokens
          SET status = 'expired',
              updated_at = $2
          WHERE id = $1
        `, [id, nowIso(now)]);
      },
      async revokePendingForAccount(accountId) {
        await run(`
          UPDATE password_reset_tokens
          SET status = 'revoked',
              updated_at = $2
          WHERE account_id = $1
            AND status = 'pending'
        `, [normalizeUserId(accountId), nowIso(now)]);
      }
    },
    roles: {
      async deleteSystemAdmin(accountId) {
        await run(`
          DELETE FROM account_global_roles
          WHERE account_id = $1
            AND role = 'system_admin'
        `, [normalizeUserId(accountId)]);
      },
      async insertSystemAdmin({ accountId, grantedByAccountId = null }) {
        await run(`
          INSERT INTO account_global_roles (
            account_id, role, granted_by_account_id, created_at
          )
          VALUES ($1, 'system_admin', $2, $3)
          ON CONFLICT (account_id, role) DO NOTHING
        `, [
          normalizeUserId(accountId),
          grantedByAccountId ? normalizeUserId(grantedByAccountId) : null,
          nowIso(now)
        ]);
      },
      async listForAccount(accountId) {
        return (await all(`
          SELECT role
          FROM account_global_roles
          WHERE account_id = $1
          ORDER BY role
        `, [normalizeUserId(accountId)])).map(row => row.role);
      }
    },
    sessions: {
      async getByTokenHash(tokenHash) {
        return await one(`
          SELECT *
          FROM auth_sessions
          WHERE token_hash = $1
            AND revoked_at IS NULL
        `, [tokenHash]);
      },
      async insert({
        id,
        accountId,
        absoluteExpiresAt,
        authMethod,
        createdAt,
        csrfTokenHash,
        idleExpiresAt,
        lastSeenAt,
        selectedBudgetId = null,
        tokenHash
      }) {
        await run(`
          INSERT INTO auth_sessions (
            id, account_id, token_hash, csrf_token_hash, selected_budget_id,
            auth_method, created_at, last_seen_at, idle_expires_at,
            absolute_expires_at, revoked_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
        `, [
          id,
          normalizeUserId(accountId),
          tokenHash,
          csrfTokenHash,
          selectedBudgetId ? normalizeUserId(selectedBudgetId) : null,
          authMethod,
          createdAt,
          lastSeenAt,
          idleExpiresAt,
          absoluteExpiresAt
        ]);
      },
      listActiveForAccount: activeSessionsForAccount,
      async revokeById(sessionId, revokedAt) {
        return changes(await run(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, $2)
          WHERE id = $1
            AND revoked_at IS NULL
        `, [sessionId, revokedAt]));
      },
      async revokeByTokenHash(tokenHash, revokedAt) {
        return changes(await run(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, $2)
          WHERE token_hash = $1
            AND revoked_at IS NULL
        `, [tokenHash, revokedAt]));
      },
      async revokeAll() {
        await run(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, $1)
          WHERE revoked_at IS NULL
        `, [nowIso(now)]);
      },
      async revoke(sessionId, accountId) {
        return changes(await run(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, $3)
          WHERE id = $1
            AND account_id = $2
            AND revoked_at IS NULL
        `, [sessionId, normalizeUserId(accountId), nowIso(now)]));
      },
      async revokeForAccount(accountId) {
        await run(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, $2)
          WHERE account_id = $1
            AND revoked_at IS NULL
        `, [normalizeUserId(accountId), nowIso(now)]);
      },
      async revokeForAccountBudget(accountId, budgetId) {
        const timestamp = nowIso(now);
        await run(`
          UPDATE auth_sessions
          SET selected_budget_id = NULL,
              revoked_at = COALESCE(revoked_at, $3)
          WHERE account_id = $1
            AND selected_budget_id = $2
            AND revoked_at IS NULL
        `, [normalizeUserId(accountId), normalizeUserId(budgetId), timestamp]);
      },
      // Used when purging a budget: clears every account's session pointer to
      // it, not just one account's, matching the sync purgeBudget's
      // unconditional `WHERE selected_budget_id = ?` (no account filter).
      async revokeAllForBudget(budgetId) {
        const timestamp = nowIso(now);
        await run(`
          UPDATE auth_sessions
          SET selected_budget_id = NULL,
              revoked_at = COALESCE(revoked_at, $2)
          WHERE selected_budget_id = $1
        `, [normalizeUserId(budgetId), timestamp]);
      },
      async selectBudgetByTokenHash({
        budgetId,
        lastSeenAt,
        tokenHash
      }) {
        return changes(await run(`
          UPDATE auth_sessions
          SET selected_budget_id = $1,
              last_seen_at = $2
          WHERE token_hash = $3
            AND revoked_at IS NULL
        `, [
          normalizeUserId(budgetId),
          lastSeenAt,
          tokenHash
        ]));
      },
      async touch({
        id,
        idleExpiresAt,
        lastSeenAt
      }) {
        return changes(await run(`
          UPDATE auth_sessions
          SET last_seen_at = $2,
              idle_expires_at = $3
          WHERE id = $1
            AND revoked_at IS NULL
        `, [id, lastSeenAt, idleExpiresAt]));
      },
      async updateCsrfHash(sessionId, csrfTokenHash) {
        return changes(await run(`
          UPDATE auth_sessions
          SET csrf_token_hash = $2
          WHERE id = $1
            AND revoked_at IS NULL
        `, [sessionId, csrfTokenHash]));
      }
    },
    oauthStates: {
      async get(id) {
        return await one("SELECT * FROM auth_oauth_states WHERE id = $1", [id]);
      },
      async getByHashAndProvider({ providerId, stateHash }) {
        return await one(`
          SELECT *
          FROM auth_oauth_states
          WHERE state_hash = $1 AND provider_id = $2
        `, [stateHash, providerId]);
      },
      async insert({
        accountId = null,
        codeVerifier,
        expiresAt,
        id = `oauth_state_${crypto.randomUUID()}`,
        nonce,
        providerId,
        purpose,
        redirectUri,
        stateHash
      }) {
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO auth_oauth_states (
            id, state_hash, provider_id, account_id, purpose, code_verifier,
            nonce, redirect_uri, status, expires_at, consumed_at, created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, NULL, $10, $10)
        `, [
          id,
          stateHash,
          providerId,
          accountId ? normalizeUserId(accountId) : null,
          purpose,
          codeVerifier,
          nonce,
          redirectUri,
          expiresAt,
          timestamp
        ]);
        return id;
      },
      async markConsumed(id) {
        const timestamp = nowIso(now);
        await run(`
          UPDATE auth_oauth_states
          SET status = 'consumed',
              consumed_at = $2,
              updated_at = $2
          WHERE id = $1
        `, [id, timestamp]);
      },
      async markExpired(id) {
        await run(`
          UPDATE auth_oauth_states
          SET status = 'expired',
              updated_at = $2
          WHERE id = $1
        `, [id, nowIso(now)]);
      }
    },
    users: {
      async delete(id) {
        await run("DELETE FROM users WHERE id = $1", [normalizeUserId(id)]);
      },
      async ensureMetadata(id, displayName = "", { permissions = '["admin"]' } = {}) {
        const normalizedId = normalizeUserId(id);
        const name = String(displayName || normalizedId).trim() || normalizedId;
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO users (id, display_name, permissions, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $4)
          ON CONFLICT (id) DO UPDATE SET
            display_name = CASE
              WHEN EXCLUDED.display_name != EXCLUDED.id THEN EXCLUDED.display_name
              ELSE users.display_name
            END,
            permissions = users.permissions,
            updated_at = $4
        `, [normalizedId, name, jsonValue(permissions, '["admin"]'), timestamp]);
        return normalizedId;
      },
      async getMetadata(id) {
        return await one(`
          SELECT id, display_name, permissions
          FROM users
          WHERE id = $1
        `, [normalizeUserId(id)]);
      },
      async insertNew({ id, displayName }) {
        const timestamp = nowIso(now);
        await run(`
          INSERT INTO users (id, display_name, permissions, created_at, updated_at, last_selected_at)
          VALUES ($1, $2, '[]'::jsonb, $3, $3, $3)
        `, [normalizeUserId(id), displayName, timestamp]);
      },
      async listMetadata() {
        return await all(`
          SELECT id, display_name, permissions, created_at, updated_at, last_selected_at
          FROM users
          ORDER BY COALESCE(last_selected_at, created_at) DESC, id ASC
        `);
      },
      async setDisplayName(id, displayName) {
        await run(`
          UPDATE users
          SET display_name = $2,
              updated_at = $3
          WHERE id = $1
        `, [normalizeUserId(id), displayName, nowIso(now)]);
      },
      async setPermissions(id, permissionsJson) {
        await run(`
          UPDATE users
          SET permissions = $2,
              updated_at = $3
          WHERE id = $1
        `, [normalizeUserId(id), jsonValue(permissionsJson, "[]"), nowIso(now)]);
      },
      async touchSelection(id) {
        const timestamp = nowIso(now);
        await run(`
          UPDATE users
          SET last_selected_at = $2,
              updated_at = $2
          WHERE id = $1
        `, [normalizeUserId(id), timestamp]);
      }
    }
  };
}
