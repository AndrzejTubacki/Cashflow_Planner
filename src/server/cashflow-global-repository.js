import crypto from "crypto";

import {
  ensureLegacyBudget,
  LEGACY_ADMIN_ACCOUNT_ID
} from "./cashflow-global-schema.js";
import { normalizeUserId, notFound } from "./cashflow-user-utils.js";

export const GLOBAL_REPOSITORY_BACKEND = "sqlite";

export function createSqliteGlobalRepository(db, {
  generateAuditId = () => `audit_${crypto.randomUUID()}`,
  nowMs = () => Date.now()
} = {}) {
  function getAccount(accountId) {
    const normalizedId = normalizeUserId(accountId);
    return db.prepare(`
      SELECT id, email, display_name, status, created_at, updated_at,
        disabled_at, deleted_at
      FROM accounts
      WHERE id = ?
    `).get(normalizedId);
  }

  function requireAccount(accountId) {
    const account = getAccount(accountId);
    if (!account) throw notFound("Account not found");
    return account;
  }

  function getBudget(budgetId) {
    const normalizedId = normalizeUserId(budgetId);
    return db.prepare(`
      SELECT id, storage_key, display_name, status, created_by_account_id,
        created_at, updated_at, archived_at, deleted_at
      FROM budgets
      WHERE id = ?
    `).get(normalizedId);
  }

  function activeSessionsForAccount(accountId) {
    const now = nowMs();
    return db.prepare(`
      SELECT id, auth_method, selected_budget_id, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at
      FROM auth_sessions
      WHERE account_id = ?
        AND revoked_at IS NULL
      ORDER BY last_seen_at DESC, created_at DESC
    `).all(accountId).filter(session =>
      Date.parse(session.idle_expires_at) > now
      && Date.parse(session.absolute_expires_at) > now
    );
  }

  return {
    backend: GLOBAL_REPOSITORY_BACKEND,
    identity: {
      legacyUserAccountOrBudgetExists(id) {
        const normalizedId = normalizeUserId(id);
        return Boolean(db.prepare(`
          SELECT id FROM users WHERE id = ?
          UNION ALL
          SELECT id FROM accounts WHERE id = ?
          UNION ALL
          SELECT id FROM budgets WHERE id = ?
          LIMIT 1
        `).get(normalizedId, normalizedId, normalizedId));
      }
    },
    accounts: {
      count() {
        return Number(db.prepare(`
          SELECT COUNT(*) AS count
          FROM accounts
        `).get()?.count || 0);
      },
      countActiveExternalSystemAdmins(providerId) {
        return Number(db.prepare(`
          SELECT COUNT(*) AS count
          FROM account_global_roles agr
          JOIN accounts a ON a.id = agr.account_id
          JOIN auth_identities ai ON ai.account_id = a.id
          WHERE agr.role = 'system_admin'
            AND a.status = 'active'
            AND ai.provider_id = ?
        `).get(providerId)?.count || 0);
      },
      countActiveInternalSystemAdmins() {
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
      },
      countActiveSystemAdmins() {
        return Number(db.prepare(`
          SELECT COUNT(*) AS count
          FROM account_global_roles agr
          JOIN accounts a ON a.id = agr.account_id
          WHERE agr.role = 'system_admin'
            AND a.status = 'active'
        `).get()?.count || 0);
      },
      delete(id) {
        db.prepare("DELETE FROM accounts WHERE id = ?").run(normalizeUserId(id));
      },
      emailExists(email, { excludeId = null } = {}) {
        if (excludeId) {
          return Boolean(db.prepare(`
            SELECT 1
            FROM accounts
            WHERE email = ? AND id != ?
          `).get(email, normalizeUserId(excludeId)));
        }
        return Boolean(db.prepare("SELECT 1 FROM accounts WHERE email = ?").get(email));
      },
      get: getAccount,
      getStatus(id) {
        return db.prepare(`
          SELECT status
          FROM accounts
          WHERE id = ?
        `).get(normalizeUserId(id));
      },
      insert({ id, email = null, displayName }) {
        const normalizedId = normalizeUserId(id);
        db.prepare(`
          INSERT INTO accounts (
            id, email, display_name, status, created_at, updated_at
          )
          VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))
        `).run(normalizedId, email, displayName);
      },
      listActive() {
        return db.prepare(`
          SELECT id, email, display_name, status, created_at, updated_at
          FROM accounts
          WHERE status = 'active'
          ORDER BY LOWER(display_name), id
        `).all();
      },
      listAdminIds() {
        return db.prepare(`
          SELECT id
          FROM accounts
          ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'disabled' THEN 1 ELSE 2 END,
            LOWER(display_name), id
        `).all();
      },
      markDeleted(id) {
        db.prepare(`
          UPDATE accounts
          SET status = 'deleted',
              deleted_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizeUserId(id));
      },
      require: requireAccount,
      updateDisplayName(id, displayName) {
        db.prepare(`
          UPDATE accounts
          SET display_name = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(displayName, normalizeUserId(id));
      },
      updateEmail(id, email) {
        db.prepare(`
          UPDATE accounts
          SET email = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(email, normalizeUserId(id));
      },
      updateStatus(id, status) {
        db.prepare(`
          UPDATE accounts
          SET status = ?,
              disabled_at = CASE WHEN ? = 'disabled' THEN datetime('now') ELSE NULL END,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(status, status, normalizeUserId(id));
      }
    },
    audit: {
      insertSecurityEvent({
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
          generateAuditId(),
          actorAccountId || null,
          action,
          targetType,
          targetId,
          outcome,
          JSON.stringify(details || {})
        );
      }
    },
    authConfig: {
      get() {
        return db.prepare("SELECT * FROM auth_config WHERE id = 1").get();
      },
      getActiveMode() {
        return db.prepare("SELECT active_mode FROM auth_config WHERE id = 1").get() || {};
      },
      getActiveModeAndDraftConfig() {
        return db.prepare("SELECT active_mode, draft_config_json FROM auth_config WHERE id = 1").get() || {};
      },
      activateDraft() {
        db.prepare(`
          UPDATE auth_config
          SET active_mode = draft_mode,
              external_config_json = draft_config_json,
              updated_at = datetime('now')
          WHERE id = 1
        `).run();
      },
      markBootstrapCompleted() {
        db.prepare(`
          UPDATE auth_config
          SET bootstrap_completed_at = COALESCE(bootstrap_completed_at, datetime('now')),
              updated_at = datetime('now')
          WHERE id = 1
        `).run();
      },
      updateDraft({
        draftConfigJson,
        draftMode,
        sessionAbsoluteMinutes,
        sessionIdleMinutes
      }) {
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
          draftConfigJson
        );
      }
    },
    authProviders: {
      delete(id) {
        db.prepare("DELETE FROM auth_providers WHERE id = ?").run(id);
      },
      get(id) {
        return db.prepare("SELECT * FROM auth_providers WHERE id = ?").get(id);
      },
      list({ publicOnly = false } = {}) {
        return db.prepare(`
          SELECT *
          FROM auth_providers
          ${publicOnly ? "WHERE enabled = 1" : ""}
          ORDER BY display_name COLLATE NOCASE, id
        `).all();
      },
      upsert({
        clientId,
        configJson,
        displayName,
        enabled,
        id,
        issuer,
        kind,
        secretRef
      }) {
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
          kind,
          displayName,
          enabled ? 1 : 0,
          issuer,
          clientId,
          secretRef,
          configJson
        );
      }
    },
    budgets: {
      delete(id) {
        db.prepare("DELETE FROM budgets WHERE id = ?").run(normalizeUserId(id));
      },
      ensureLegacy({ id, displayName = "", storageKey = id }) {
        const normalizedId = normalizeUserId(id);
        ensureLegacyBudget(db, {
          budgetId: normalizedId,
          displayName: String(displayName || normalizedId).trim() || normalizedId,
          storageKey: normalizeUserId(storageKey)
        });
        return normalizedId;
      },
      get: getBudget,
      insert({ id, displayName, storageKey = id, createdByAccountId = null }) {
        const normalizedId = normalizeUserId(id);
        db.prepare(`
          INSERT INTO budgets (
            id, storage_key, display_name, status, created_by_account_id,
            created_at, updated_at
          )
          VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'))
        `).run(
          normalizedId,
          normalizeUserId(storageKey),
          displayName,
          createdByAccountId ? normalizeUserId(createdByAccountId) : null
        );
      },
      listActiveStorage() {
        return db.prepare(`
          SELECT id, storage_key
          FROM budgets
          WHERE status = 'active'
          ORDER BY id
        `).all();
      },
      updateDisplayName(id, displayName) {
        db.prepare(`
          UPDATE budgets
          SET display_name = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(displayName, normalizeUserId(id));
      },
      markArchived(id) {
        db.prepare(`
          UPDATE budgets
          SET status = 'archived',
              archived_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizeUserId(id));
      },
      markActive(id) {
        db.prepare(`
          UPDATE budgets
          SET status = 'active',
              archived_at = NULL,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizeUserId(id));
      },
      markDeleted(id) {
        db.prepare(`
          UPDATE budgets
          SET status = 'deleted',
              deleted_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizeUserId(id));
      }
    },
    globalOptions: {
      get() {
        return db.prepare("SELECT * FROM global_options WHERE id = 1").get();
      },
      updatePlannerDefaults(settings) {
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
          settings.ledger_currency,
          settings.locale,
          settings.timezone,
          settings.holiday_country,
          settings.future_periods,
          settings.fx_provider,
          settings.fx_buffer_percent
        );
      }
    },
    identities: {
      countForAccount(accountId) {
        return Number(db.prepare(`
          SELECT COUNT(*) AS count
          FROM auth_identities
          WHERE account_id = ?
        `).get(accountId)?.count || 0);
      },
      deleteForAccount(accountId) {
        db.prepare("DELETE FROM auth_identities WHERE account_id = ?").run(normalizeUserId(accountId));
      },
      listForAccount(accountId) {
        return db.prepare(`
          SELECT id, provider_id, subject, email, email_verified, created_at,
            updated_at, last_used_at
          FROM auth_identities
          WHERE account_id = ?
          ORDER BY provider_id, subject
        `).all(accountId);
      },
      findAccountByProviderSubject(providerId, subject) {
        return db.prepare(`
          SELECT account_id
          FROM auth_identities
          WHERE provider_id = ? AND subject = ?
        `).get(providerId, subject);
      },
      findWithAccountByProviderSubject(providerId, subject) {
        return db.prepare(`
          SELECT ai.account_id, a.status
          FROM auth_identities ai
          JOIN accounts a ON a.id = ai.account_id
          WHERE ai.provider_id = ? AND ai.subject = ?
        `).get(providerId, subject);
      },
      updateProviderLogin({
        email = null,
        emailVerified = null,
        profileJson,
        providerId,
        subject
      }) {
        if (emailVerified === null || emailVerified === undefined) {
          db.prepare(`
            UPDATE auth_identities
            SET email = COALESCE(?, email),
                profile_json = ?,
                last_used_at = datetime('now'),
                updated_at = datetime('now')
            WHERE provider_id = ? AND subject = ?
          `).run(email, profileJson, providerId, subject);
          return;
        }
        db.prepare(`
          UPDATE auth_identities
          SET email = COALESCE(?, email),
              email_verified = ?,
              profile_json = ?,
              last_used_at = datetime('now'),
              updated_at = datetime('now')
          WHERE provider_id = ? AND subject = ?
        `).run(email, emailVerified ? 1 : 0, profileJson, providerId, subject);
      },
      upsert({
        accountId,
        email = null,
        emailVerified = false,
        id = `identity_${crypto.randomUUID()}`,
        lastUsedNow = false,
        profileJson = "{}",
        providerId,
        subject
      }) {
        db.prepare(`
          INSERT INTO auth_identities (
            id, account_id, provider_id, subject, email, email_verified,
            profile_json, created_at, updated_at, last_used_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ${lastUsedNow ? "datetime('now')" : "NULL"})
          ON CONFLICT(provider_id, subject) DO UPDATE SET
            account_id = excluded.account_id,
            email = excluded.email,
            email_verified = excluded.email_verified,
            profile_json = excluded.profile_json,
            last_used_at = CASE
              WHEN ? = 1 THEN datetime('now')
              ELSE auth_identities.last_used_at
            END,
            updated_at = datetime('now')
        `).run(
          id,
          normalizeUserId(accountId),
          providerId,
          subject,
          email,
          emailVerified ? 1 : 0,
          profileJson,
          lastUsedNow ? 1 : 0
        );
      }
    },
    invitations: {
      acceptForAccount({
        accountId,
        invitationId,
        role = null
      }) {
        const result = db.prepare(`
          UPDATE budget_invitations
          SET target_account_id = ?,
              status = 'accepted',
              accepted_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'
        `).run(normalizeUserId(accountId), invitationId);
        if (role) {
          // The role is persisted on the invitation. Passing it here is a cheap
          // guard against callers using stale or mismatched invitation data.
          const row = db.prepare("SELECT role FROM budget_invitations WHERE id = ?").get(invitationId);
          if (row?.role !== role) {
            throw new Error("Invitation role changed before acceptance");
          }
        }
        return result.changes;
      },
      findPendingForEmail(email) {
        return db.prepare(`
          SELECT *
          FROM budget_invitations
          WHERE target_email = ?
            AND status = 'pending'
            AND target_account_id IS NULL
          ORDER BY expires_at ASC, created_at ASC
          LIMIT 1
        `).get(email);
      },
      getByTokenHash(tokenHash) {
        return db.prepare(`
          SELECT *
          FROM budget_invitations
          WHERE token_hash = ?
        `).get(tokenHash);
      },
      getForBudget({ budgetId, invitationId }) {
        return db.prepare(`
          SELECT id, budget_id, target_account_id, target_email, role, status,
            invited_by_account_id, expires_at, accepted_at, revoked_at, created_at,
            updated_at
          FROM budget_invitations
          WHERE id = ? AND budget_id = ?
        `).get(invitationId, normalizeUserId(budgetId));
      },
      insertPending({
        budgetId,
        expiresAt,
        id,
        invitedByAccountId,
        role,
        targetAccountId = null,
        targetEmail = null,
        tokenHash
      }) {
        db.prepare(`
          INSERT INTO budget_invitations (
            id, budget_id, target_account_id, target_email, role, token_hash,
            status, invited_by_account_id, expires_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          normalizeUserId(budgetId),
          targetAccountId ? normalizeUserId(targetAccountId) : null,
          targetEmail,
          role,
          tokenHash,
          normalizeUserId(invitedByAccountId),
          expiresAt
        );
      },
      expirePendingForBudget(budgetId) {
        return db.prepare(`
          UPDATE budget_invitations
          SET status = 'expired',
              updated_at = datetime('now')
          WHERE budget_id = ?
            AND status = 'pending'
            AND expires_at <= datetime('now')
        `).run(normalizeUserId(budgetId)).changes;
      },
      deleteAllForBudget(budgetId) {
        return db.prepare(`
          DELETE FROM budget_invitations
          WHERE budget_id = ?
        `).run(normalizeUserId(budgetId)).changes;
      },
      listForBudget(budgetId) {
        return db.prepare(`
          SELECT id, budget_id, target_account_id, target_email, role, status,
            invited_by_account_id, expires_at, accepted_at, revoked_at, created_at,
            updated_at
          FROM budget_invitations
          WHERE budget_id = ?
          ORDER BY created_at DESC
        `).all(normalizeUserId(budgetId));
      },
      revokePending(invitationId) {
        return db.prepare(`
          UPDATE budget_invitations
          SET status = 'revoked',
              revoked_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'
        `).run(invitationId).changes;
      },
      revokePendingForTargetAccount(accountId) {
        db.prepare(`
          UPDATE budget_invitations
          SET status = 'revoked',
              revoked_at = COALESCE(revoked_at, datetime('now')),
              updated_at = datetime('now')
          WHERE target_account_id = ?
            AND status = 'pending'
        `).run(normalizeUserId(accountId));
      }
    },
    memberships: {
      activeOwnerAccountId(budgetId) {
        return db.prepare(`
          SELECT bm.account_id
          FROM budget_memberships bm
          JOIN accounts a ON a.id = bm.account_id
          JOIN budgets b ON b.id = bm.budget_id
          WHERE bm.budget_id = ?
            AND bm.role = 'owner'
            AND a.status = 'active'
            AND b.status = 'active'
        `).get(normalizeUserId(budgetId))?.account_id || null;
      },
      countForAccount(accountId) {
        return Number(db.prepare(`
          SELECT COUNT(*) AS count
          FROM budget_memberships bm
          JOIN budgets b ON b.id = bm.budget_id
          WHERE bm.account_id = ?
            AND b.status != 'deleted'
        `).get(accountId)?.count || 0);
      },
      countOwnedForAccount(accountId) {
        return Number(db.prepare(`
          SELECT COUNT(*) AS count
          FROM budget_memberships bm
          JOIN budgets b ON b.id = bm.budget_id
          WHERE bm.account_id = ?
            AND bm.role = 'owner'
            AND b.status != 'deleted'
        `).get(accountId)?.count || 0);
      },
      getRole({ accountId, budgetId }) {
        return db.prepare(`
          SELECT role
          FROM budget_memberships
          WHERE budget_id = ? AND account_id = ?
        `).get(budgetId, accountId);
      },
      get({ accountId, budgetId }) {
        return db.prepare(`
          SELECT budget_id, account_id, role, invited_by_account_id, created_at, updated_at
          FROM budget_memberships
          WHERE budget_id = ? AND account_id = ?
        `).get(budgetId, accountId);
      },
      insert({
        accountId,
        budgetId,
        invitedByAccountId = null,
        role
      }) {
        db.prepare(`
          INSERT INTO budget_memberships (
            budget_id, account_id, role, invited_by_account_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(
          normalizeUserId(budgetId),
          normalizeUserId(accountId),
          role,
          invitedByAccountId ? normalizeUserId(invitedByAccountId) : null
        );
      },
      insertOwner({ accountId, budgetId, invitedByAccountId = null }) {
        db.prepare(`
          INSERT INTO budget_memberships (
            budget_id, account_id, role, invited_by_account_id, created_at, updated_at
          )
          VALUES (?, ?, 'owner', ?, datetime('now'), datetime('now'))
        `).run(
          normalizeUserId(budgetId),
          normalizeUserId(accountId),
          invitedByAccountId ? normalizeUserId(invitedByAccountId) : null
        );
      },
      upsertFromInvitation({
        accountId,
        budgetId,
        invitedByAccountId = null,
        role
      }) {
        db.prepare(`
          INSERT INTO budget_memberships (
            budget_id, account_id, role, invited_by_account_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(budget_id, account_id) DO UPDATE SET
            role = CASE
              WHEN budget_memberships.role = 'owner' THEN budget_memberships.role
              ELSE excluded.role
            END,
            invited_by_account_id = excluded.invited_by_account_id,
            updated_at = datetime('now')
        `).run(
          normalizeUserId(budgetId),
          normalizeUserId(accountId),
          role,
          invitedByAccountId ? normalizeUserId(invitedByAccountId) : null
        );
      },
      updateRole({ accountId, budgetId, role }) {
        db.prepare(`
          UPDATE budget_memberships
          SET role = ?,
              updated_at = datetime('now')
          WHERE budget_id = ? AND account_id = ?
        `).run(role, normalizeUserId(budgetId), normalizeUserId(accountId));
      },
      updateOwnerAccount({ budgetId, fromAccountId, toAccountId }) {
        db.prepare(`
          UPDATE budget_memberships
          SET account_id = ?,
              updated_at = datetime('now')
          WHERE budget_id = ? AND account_id = ? AND role = 'owner'
        `).run(
          normalizeUserId(toAccountId),
          normalizeUserId(budgetId),
          normalizeUserId(fromAccountId)
        );
      },
      delete({ accountId, budgetId }) {
        db.prepare(`
          DELETE FROM budget_memberships
          WHERE budget_id = ? AND account_id = ?
        `).run(normalizeUserId(budgetId), normalizeUserId(accountId));
      },
      deleteAllForBudget(budgetId) {
        return db.prepare(`
          DELETE FROM budget_memberships
          WHERE budget_id = ?
        `).run(normalizeUserId(budgetId)).changes;
      },
      ownerAccountId(budgetId) {
        return db.prepare(`
          SELECT account_id
          FROM budget_memberships
          WHERE budget_id = ? AND role = 'owner'
        `).get(normalizeUserId(budgetId))?.account_id || null;
      },
      listBudgetsForAccount(accountId, { includeArchived = true } = {}) {
        return db.prepare(`
          SELECT b.id, b.display_name, b.status, b.created_at, b.updated_at,
            b.archived_at, bm.role
          FROM budget_memberships bm
          JOIN budgets b ON b.id = bm.budget_id
          WHERE bm.account_id = ?
            AND b.status != 'deleted'
            AND (? = 1 OR b.status = 'active')
          ORDER BY CASE b.status WHEN 'active' THEN 0 ELSE 1 END,
            LOWER(b.display_name), b.id
        `).all(normalizeUserId(accountId), includeArchived ? 1 : 0);
      },
      listMembers(budgetId) {
        return db.prepare(`
          SELECT a.id AS account_id, a.email, a.display_name, a.status,
            bm.role, bm.created_at, bm.updated_at
          FROM budget_memberships bm
          JOIN accounts a ON a.id = bm.account_id
          WHERE bm.budget_id = ?
          ORDER BY CASE bm.role
            WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
            LOWER(a.display_name), a.id
        `).all(normalizeUserId(budgetId));
      }
    },
    passwordCredentials: {
      deleteForAccount(accountId) {
        db.prepare("DELETE FROM password_credentials WHERE account_id = ?").run(normalizeUserId(accountId));
      },
      existsForAccount(accountId) {
        return Boolean(db.prepare(`
          SELECT 1
          FROM password_credentials
          WHERE account_id = ?
          LIMIT 1
        `).get(accountId));
      },
      getLoginByEmail(email) {
        return db.prepare(`
          SELECT a.id AS account_id, a.status, pc.password_hash,
            pc.failed_attempts, pc.locked_until
          FROM accounts a
          JOIN password_credentials pc ON pc.account_id = a.id
          WHERE a.email = ?
        `).get(email);
      },
      insert({ accountId, passwordHash }) {
        db.prepare(`
          INSERT INTO password_credentials (
            account_id, password_hash, password_changed_at, failed_attempts,
            locked_until, created_at, updated_at
          )
          VALUES (?, ?, datetime('now'), 0, NULL, datetime('now'), datetime('now'))
        `).run(normalizeUserId(accountId), passwordHash);
      },
      recordFailedLogin({
        accountId,
        attempts,
        lockUntil,
        lockThreshold
      }) {
        db.prepare(`
          UPDATE password_credentials
          SET failed_attempts = ?,
              locked_until = CASE WHEN ? >= ? THEN ? ELSE locked_until END,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(
          attempts,
          attempts,
          lockThreshold,
          lockUntil,
          normalizeUserId(accountId)
        );
      },
      recordSuccessfulLogin(accountId) {
        db.prepare(`
          UPDATE password_credentials
          SET failed_attempts = 0,
              locked_until = NULL,
              updated_at = datetime('now')
          WHERE account_id = ?
        `).run(normalizeUserId(accountId));
      },
      upsert({ accountId, passwordHash }) {
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
        `).run(normalizeUserId(accountId), passwordHash);
      }
    },
    passwordResetTokens: {
      deleteForAccount(accountId) {
        db.prepare("DELETE FROM password_reset_tokens WHERE account_id = ?").run(normalizeUserId(accountId));
      },
      getPendingWithAccountByHash(tokenHash) {
        return db.prepare(`
          SELECT prt.*, a.email, a.display_name, a.status AS account_status
          FROM password_reset_tokens prt
          JOIN accounts a ON a.id = prt.account_id
          WHERE prt.token_hash = ?
            AND prt.status = 'pending'
        `).get(tokenHash);
      },
      insert({
        accountId,
        createdByAccountId = null,
        expiresAt,
        id = `password_token_${crypto.randomUUID()}`,
        purpose,
        tokenHash
      }) {
        db.prepare(`
          INSERT INTO password_reset_tokens (
            id, account_id, token_hash, purpose, status, expires_at,
            consumed_at, created_by_account_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, 'pending', ?, NULL, ?, datetime('now'), datetime('now'))
        `).run(
          id,
          normalizeUserId(accountId),
          tokenHash,
          purpose,
          expiresAt,
          createdByAccountId ? normalizeUserId(createdByAccountId) : null
        );
      },
      markConsumed(id) {
        db.prepare(`
          UPDATE password_reset_tokens
          SET status = 'consumed',
              consumed_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(id);
      },
      markExpired(id) {
        db.prepare(`
          UPDATE password_reset_tokens
          SET status = 'expired',
              updated_at = datetime('now')
          WHERE id = ?
        `).run(id);
      },
      revokePendingForAccount(accountId) {
        db.prepare(`
          UPDATE password_reset_tokens
          SET status = 'revoked',
              updated_at = datetime('now')
          WHERE account_id = ?
            AND status = 'pending'
        `).run(normalizeUserId(accountId));
      }
    },
    roles: {
      deleteSystemAdmin(accountId) {
        db.prepare(`
          DELETE FROM account_global_roles
          WHERE account_id = ?
            AND role = 'system_admin'
        `).run(normalizeUserId(accountId));
      },
      insertSystemAdmin({ accountId, grantedByAccountId = null }) {
        db.prepare(`
          INSERT OR IGNORE INTO account_global_roles (
            account_id, role, granted_by_account_id, created_at
          )
          VALUES (?, 'system_admin', ?, datetime('now'))
        `).run(
          normalizeUserId(accountId),
          grantedByAccountId ? normalizeUserId(grantedByAccountId) : null
        );
      },
      listForAccount(accountId) {
        return db.prepare(`
          SELECT role
          FROM account_global_roles
          WHERE account_id = ?
          ORDER BY role
        `).all(accountId).map(row => row.role);
      }
    },
    sessions: {
      getByTokenHash(tokenHash) {
        return db.prepare(`
          SELECT *
          FROM auth_sessions
          WHERE token_hash = ?
            AND revoked_at IS NULL
        `).get(tokenHash);
      },
      insert({
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
        db.prepare(`
          INSERT INTO auth_sessions (
            id, account_id, token_hash, csrf_token_hash, selected_budget_id,
            auth_method, created_at, last_seen_at, idle_expires_at,
            absolute_expires_at, revoked_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `).run(
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
        );
      },
      listActiveForAccount: activeSessionsForAccount,
      revokeById(sessionId, revokedAt) {
        return db.prepare(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, ?)
          WHERE id = ?
            AND revoked_at IS NULL
        `).run(revokedAt, sessionId).changes;
      },
      revokeByTokenHash(tokenHash, revokedAt) {
        return db.prepare(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, ?)
          WHERE token_hash = ?
            AND revoked_at IS NULL
        `).run(revokedAt, tokenHash).changes;
      },
      revokeAll() {
        db.prepare(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE revoked_at IS NULL
        `).run();
      },
      revoke(sessionId, accountId) {
        return db.prepare(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE id = ?
            AND account_id = ?
            AND revoked_at IS NULL
        `).run(sessionId, normalizeUserId(accountId)).changes;
      },
      revokeForAccount(accountId) {
        db.prepare(`
          UPDATE auth_sessions
          SET revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE account_id = ?
            AND revoked_at IS NULL
        `).run(normalizeUserId(accountId));
      },
      revokeForAccountBudget(accountId, budgetId) {
        db.prepare(`
          UPDATE auth_sessions
          SET selected_budget_id = NULL,
              revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE account_id = ?
            AND selected_budget_id = ?
            AND revoked_at IS NULL
        `).run(normalizeUserId(accountId), normalizeUserId(budgetId));
      },
      revokeAllForBudget(budgetId) {
        db.prepare(`
          UPDATE auth_sessions
          SET selected_budget_id = NULL,
              revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE selected_budget_id = ?
        `).run(normalizeUserId(budgetId));
      },
      selectBudgetByTokenHash({
        budgetId,
        lastSeenAt,
        tokenHash
      }) {
        return db.prepare(`
          UPDATE auth_sessions
          SET selected_budget_id = ?,
              last_seen_at = ?
          WHERE token_hash = ?
            AND revoked_at IS NULL
        `).run(normalizeUserId(budgetId), lastSeenAt, tokenHash).changes;
      },
      touch({
        id,
        idleExpiresAt,
        lastSeenAt
      }) {
        return db.prepare(`
          UPDATE auth_sessions
          SET last_seen_at = ?,
              idle_expires_at = ?
          WHERE id = ?
            AND revoked_at IS NULL
        `).run(lastSeenAt, idleExpiresAt, id).changes;
      },
      updateCsrfHash(sessionId, csrfTokenHash) {
        return db.prepare(`
          UPDATE auth_sessions
          SET csrf_token_hash = ?
          WHERE id = ?
            AND revoked_at IS NULL
        `).run(csrfTokenHash, sessionId).changes;
      }
    },
    oauthStates: {
      get(id) {
        return db.prepare("SELECT * FROM auth_oauth_states WHERE id = ?").get(id);
      },
      getByHashAndProvider({ providerId, stateHash }) {
        return db.prepare(`
          SELECT *
          FROM auth_oauth_states
          WHERE state_hash = ? AND provider_id = ?
        `).get(stateHash, providerId);
      },
      insert({
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
        db.prepare(`
          INSERT INTO auth_oauth_states (
            id, state_hash, provider_id, account_id, purpose, code_verifier,
            nonce, redirect_uri, status, expires_at, consumed_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, datetime('now'), datetime('now'))
        `).run(
          id,
          stateHash,
          providerId,
          accountId ? normalizeUserId(accountId) : null,
          purpose,
          codeVerifier,
          nonce,
          redirectUri,
          expiresAt
        );
        return id;
      },
      markConsumed(id) {
        db.prepare(`
          UPDATE auth_oauth_states
          SET status = 'consumed',
              consumed_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(id);
      },
      markExpired(id) {
        db.prepare(`
          UPDATE auth_oauth_states
          SET status = 'expired',
              updated_at = datetime('now')
          WHERE id = ?
        `).run(id);
      }
    },
    users: {
      delete(id) {
        db.prepare("DELETE FROM users WHERE id = ?").run(normalizeUserId(id));
      },
      ensureMetadata(id, displayName = "", { permissions = '["admin"]' } = {}) {
        const normalizedId = normalizeUserId(id);
        const name = String(displayName || normalizedId).trim() || normalizedId;
        db.prepare(`
          INSERT INTO users (id, display_name, permissions, created_at, updated_at)
          VALUES (?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            display_name = CASE
              WHEN excluded.display_name != excluded.id THEN excluded.display_name
              ELSE users.display_name
            END,
            permissions = COALESCE(NULLIF(users.permissions, ''), excluded.permissions),
            updated_at = datetime('now')
        `).run(normalizedId, name, permissions);
        return normalizedId;
      },
      getMetadata(id) {
        return db.prepare(`
          SELECT id, display_name, permissions
          FROM users
          WHERE id = ?
        `).get(normalizeUserId(id));
      },
      insertNew({ id, displayName }) {
        db.prepare(`
          INSERT INTO users (id, display_name, permissions, created_at, updated_at, last_selected_at)
          VALUES (?, ?, '[]', datetime('now'), datetime('now'), datetime('now'))
        `).run(normalizeUserId(id), displayName);
      },
      listMetadata() {
        return db.prepare(`
          SELECT id, display_name, permissions, created_at, updated_at, last_selected_at
          FROM users
          ORDER BY COALESCE(last_selected_at, created_at) DESC, id ASC
        `).all();
      },
      setDisplayName(id, displayName) {
        db.prepare(`
          UPDATE users
          SET display_name = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(displayName, normalizeUserId(id));
      },
      setPermissions(id, permissionsJson) {
        db.prepare(`
          UPDATE users
          SET permissions = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(permissionsJson, normalizeUserId(id));
      },
      touchSelection(id) {
        db.prepare(`
          UPDATE users
          SET last_selected_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizeUserId(id));
      }
    }
  };
}
