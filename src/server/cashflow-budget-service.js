import crypto from "node:crypto";

import {
  badRequest,
  conflict,
  forbidden,
  normalizeUserId,
  notFound
} from "./cashflow-user-utils.js";

const MEMBER_ROLES = new Set(["manager", "editor", "viewer"]);

function displayName(value, field = "displayName") {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 120) {
    throw badRequest(`${field} must use 1-120 characters`, [{
      field,
      reason: "invalid_length"
    }]);
  }
  return normalized;
}

function memberRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (!MEMBER_ROLES.has(role)) {
    throw badRequest("Invalid budget member role", [{
      field: "role",
      reason: "unsupported_value"
    }]);
  }
  return role;
}

function inviteTokenHash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function invitationExpiryMs(value) {
  const text = String(value || "").trim();
  if (!text) return NaN;
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(normalized)) {
    return Date.parse(normalized);
  }
  return Date.parse(`${normalized}Z`);
}

function audit(db, {
  action,
  actorAccountId,
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
    JSON.stringify(details)
  );
}

export function createCashflowBudgetService({
  createBudgetBackup = null,
  createBudgetBackupAsync = null,
  deleteBudgetStorage,
  globalStore = null,
  initializeBudgetStorage,
  initializeBudgetStorageAsync = null,
  openGlobalDb
}) {
  async function withGlobalRepository(fn) {
    if (globalStore && typeof globalStore.withRepository === "function") {
      return await globalStore.withRepository(fn);
    }
    return await fn(null, null);
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

  function accountRow(db, accountId) {
    return db.prepare(`
      SELECT id, email, display_name, status, created_at, updated_at
      FROM accounts
      WHERE id = ?
    `).get(normalizeUserId(accountId));
  }

  function requireActiveAccount(db, accountId) {
    const account = accountRow(db, accountId);
    if (!account || account.status !== "active") throw notFound("Account not found");
    return account;
  }

  function budgetRow(db, budgetId) {
    return db.prepare(`
      SELECT id, storage_key, display_name, status, created_by_account_id,
        created_at, updated_at, archived_at, deleted_at
      FROM budgets
      WHERE id = ?
    `).get(normalizeUserId(budgetId));
  }

  function requireBudget(db, budgetId) {
    const budget = budgetRow(db, budgetId);
    if (!budget) throw notFound("Budget not found");
    return budget;
  }

  function membershipRow(db, budgetId, accountId) {
    return db.prepare(`
      SELECT budget_id, account_id, role, invited_by_account_id, created_at, updated_at
      FROM budget_memberships
      WHERE budget_id = ? AND account_id = ?
    `).get(budgetId, accountId);
  }

  function requireMembershipRole(db, budgetId, accountId, roles) {
    const membership = membershipRow(db, budgetId, accountId);
    if (!membership || !roles.includes(membership.role)) {
      throw forbidden("Budget permission required");
    }
    return membership;
  }

  async function requireBudgetForRepo(repo, budgetId) {
    const budget = await repo.budgets.get(budgetId);
    if (!budget) throw notFound("Budget not found");
    return budget;
  }

  async function requireMembershipRoleForRepo(repo, budgetId, accountId, roles) {
    const membership = await repo.memberships.getRole({ budgetId, accountId });
    if (!membership || !roles.includes(membership.role)) {
      throw forbidden("Budget permission required");
    }
    return membership;
  }

  async function requireActiveAccountForRepo(repo, accountId) {
    const account = await repo.accounts.get(normalizeUserId(accountId));
    if (!account || account.status !== "active") throw notFound("Account not found");
    return account;
  }

  async function requireMembershipForRepo(repo, budgetId, accountId) {
    const membership = await repo.memberships.get({
      budgetId,
      accountId
    });
    if (!membership) throw notFound("Budget member not found");
    return membership;
  }

  function listAccounts() {
    const db = openGlobalDb();
    try {
      return db.prepare(`
        SELECT id, email, display_name, status, created_at, updated_at
        FROM accounts
        WHERE status = 'active'
        ORDER BY LOWER(display_name), id
      `).all().map(account => ({
        ...account,
        globalRoles: db.prepare(`
          SELECT role
          FROM account_global_roles
          WHERE account_id = ?
          ORDER BY role
        `).all(account.id).map(row => row.role)
      }));
    } finally {
      db.close();
    }
  }

  function listBudgetsForAccount(accountId, { includeArchived = true } = {}) {
    const normalizedAccountId = normalizeUserId(accountId);
    const db = openGlobalDb();
    try {
      requireActiveAccount(db, normalizedAccountId);
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
      `).all(normalizedAccountId, includeArchived ? 1 : 0);
    } finally {
      db.close();
    }
  }

  async function listAccountsAsync() {
    return await withGlobalRepository(async (repo, db) => {
      if (!repo) return listAccounts();
      const accounts = await repo.accounts.listActive();
      const result = [];
      for (const account of accounts) {
        result.push({
          ...account,
          globalRoles: await repo.roles.listForAccount(account.id)
        });
      }
      return result;
    });
  }

  async function listBudgetsForAccountAsync(accountId, { includeArchived = true } = {}) {
    const normalizedAccountId = normalizeUserId(accountId);
    return await withGlobalRepository(async (repo, db) => {
      if (!repo) return listBudgetsForAccount(normalizedAccountId, { includeArchived });
      const account = await repo.accounts.get(normalizedAccountId);
      if (!account || account.status !== "active") throw notFound("Account not found");
      return await repo.memberships.listBudgetsForAccount(normalizedAccountId, { includeArchived });
    });
  }

  function createBudget(accountId, input = {}) {
    const normalizedAccountId = normalizeUserId(accountId);
    const name = displayName(input.displayName || input.display_name || input.name, "displayName");
    const budgetId = `budget_${crypto.randomUUID()}`;

    const checkDb = openGlobalDb();
    try {
      requireActiveAccount(checkDb, normalizedAccountId);
    } finally {
      checkDb.close();
    }

    try {
      initializeBudgetStorage(budgetId);
      const db = openGlobalDb();
      try {
        db.transaction(() => {
          db.prepare(`
            INSERT INTO budgets (
              id, storage_key, display_name, status, created_by_account_id,
              created_at, updated_at
            )
            VALUES (?, ?, ?, 'active', ?, datetime('now'), datetime('now'))
          `).run(budgetId, budgetId, name, normalizedAccountId);
          db.prepare(`
            INSERT INTO budget_memberships (
              budget_id, account_id, role, invited_by_account_id, created_at, updated_at
            )
            VALUES (?, ?, 'owner', NULL, datetime('now'), datetime('now'))
          `).run(budgetId, normalizedAccountId);
          audit(db, {
            action: "budget_create",
            actorAccountId: normalizedAccountId,
            targetId: budgetId,
            targetType: "budget"
          });
        })();
        return {
          ...budgetRow(db, budgetId),
          role: "owner"
        };
      } finally {
        db.close();
      }
    } catch (error) {
      try {
        deleteBudgetStorage(budgetId);
      } catch {
        // Preserve the original creation failure.
      }
      throw error;
    }
  }

  async function createBudgetAsync(accountId, input = {}) {
    if (!globalStore || globalStore.backend === "sqlite" || typeof globalStore.transaction !== "function") {
      return createBudget(accountId, input);
    }

    const normalizedAccountId = normalizeUserId(accountId);
    const name = displayName(input.displayName || input.display_name || input.name, "displayName");
    const budgetId = `budget_${crypto.randomUUID()}`;

    await globalStore.transaction(async repo => {
      await requireActiveAccountForRepo(repo, normalizedAccountId);
    });

    try {
      // The budgets row must exist before initializing storage, not after:
      // in Postgres, settings.budget_id is a real foreign key to
      // budgets.id (unlike SQLite, where the planning file and the global
      // budgets table are separate files with no cross-file constraint).
      const result = await globalStore.transaction(async repo => {
        await repo.budgets.insert({
          id: budgetId,
          displayName: name,
          storageKey: budgetId,
          createdByAccountId: normalizedAccountId
        });
        await repo.memberships.insertOwner({ accountId: normalizedAccountId, budgetId });
        await repo.audit.insertSecurityEvent({
          action: "budget_create",
          actorAccountId: normalizedAccountId,
          targetId: budgetId,
          targetType: "budget"
        });
        return await repo.budgets.get(budgetId);
      });
      if (typeof initializeBudgetStorageAsync === "function") {
        await initializeBudgetStorageAsync(budgetId);
      } else {
        initializeBudgetStorage(budgetId);
      }

      return {
        ...result,
        role: "owner"
      };
    } catch (error) {
      try {
        deleteBudgetStorage(budgetId);
      } catch {
        // Preserve the original creation failure.
      }
      throw error;
    }
  }

  function renameBudget(actorAccountId, budgetId, input = {}) {
    const name = displayName(input.displayName || input.display_name || input.name, "displayName");
    const db = openGlobalDb();
    try {
      requireBudget(db, budgetId);
      requireMembershipRole(db, budgetId, actorAccountId, ["owner", "manager"]);
      db.transaction(() => {
        db.prepare(`
          UPDATE budgets
          SET display_name = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(name, budgetId);
        audit(db, {
          action: "budget_rename",
          actorAccountId,
          targetId: budgetId,
          targetType: "budget"
        });
      })();
      return budgetRow(db, budgetId);
    } finally {
      db.close();
    }
  }

  async function renameBudgetAsync(actorAccountId, budgetId, input = {}) {
    const name = displayName(input.displayName || input.display_name || input.name, "displayName");
    const normalizedBudgetId = normalizeUserId(budgetId);
    return await withExternalGlobalTransaction(async repo => {
      await requireBudgetForRepo(repo, normalizedBudgetId);
      await requireMembershipRoleForRepo(repo, normalizedBudgetId, actorAccountId, ["owner", "manager"]);
      await repo.budgets.updateDisplayName(normalizedBudgetId, name);
      await repo.audit.insertSecurityEvent({
        action: "budget_rename",
        actorAccountId,
        targetId: normalizedBudgetId,
        targetType: "budget"
      });
      return await repo.budgets.get(normalizedBudgetId);
    }, () => renameBudget(actorAccountId, normalizedBudgetId, { displayName: name }));
  }

  function archiveBudget(actorAccountId, budgetId) {
    const db = openGlobalDb();
    try {
      const budget = requireBudget(db, budgetId);
      requireMembershipRole(db, budgetId, actorAccountId, ["owner"]);
      if (budget.status !== "active") throw conflict("Only active budgets can be archived");
      db.transaction(() => {
        db.prepare(`
          UPDATE budgets
          SET status = 'archived',
              archived_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(budgetId);
        audit(db, {
          action: "budget_archive",
          actorAccountId,
          targetId: budgetId,
          targetType: "budget"
        });
      })();
      return budgetRow(db, budgetId);
    } finally {
      db.close();
    }
  }

  async function archiveBudgetAsync(actorAccountId, budgetId) {
    const normalizedBudgetId = normalizeUserId(budgetId);
    return await withExternalGlobalTransaction(async repo => {
      const budget = await requireBudgetForRepo(repo, normalizedBudgetId);
      await requireMembershipRoleForRepo(repo, normalizedBudgetId, actorAccountId, ["owner"]);
      if (budget.status !== "active") throw conflict("Only active budgets can be archived");
      await repo.budgets.markArchived(normalizedBudgetId);
      await repo.audit.insertSecurityEvent({
        action: "budget_archive",
        actorAccountId,
        targetId: normalizedBudgetId,
        targetType: "budget"
      });
      return await repo.budgets.get(normalizedBudgetId);
    }, () => archiveBudget(actorAccountId, normalizedBudgetId));
  }

  function restoreBudget(actorAccountId, budgetId) {
    const db = openGlobalDb();
    try {
      const budget = requireBudget(db, budgetId);
      requireMembershipRole(db, budgetId, actorAccountId, ["owner"]);
      if (budget.status !== "archived") throw conflict("Only archived budgets can be restored");
      db.transaction(() => {
        db.prepare(`
          UPDATE budgets
          SET status = 'active',
              archived_at = NULL,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(budgetId);
        audit(db, {
          action: "budget_restore",
          actorAccountId,
          targetId: budgetId,
          targetType: "budget"
        });
      })();
      return budgetRow(db, budgetId);
    } finally {
      db.close();
    }
  }

  async function restoreBudgetAsync(actorAccountId, budgetId) {
    const normalizedBudgetId = normalizeUserId(budgetId);
    return await withExternalGlobalTransaction(async repo => {
      const budget = await requireBudgetForRepo(repo, normalizedBudgetId);
      await requireMembershipRoleForRepo(repo, normalizedBudgetId, actorAccountId, ["owner"]);
      if (budget.status !== "archived") throw conflict("Only archived budgets can be restored");
      await repo.budgets.markActive(normalizedBudgetId);
      await repo.audit.insertSecurityEvent({
        action: "budget_restore",
        actorAccountId,
        targetId: normalizedBudgetId,
        targetType: "budget"
      });
      return await repo.budgets.get(normalizedBudgetId);
    }, () => restoreBudget(actorAccountId, normalizedBudgetId));
  }

  function purgeBudget(actorAccountId, budgetId) {
    const db = openGlobalDb();
    let budget;
    try {
      budget = requireBudget(db, budgetId);
      requireMembershipRole(db, budgetId, actorAccountId, ["owner"]);
      if (budget.status !== "archived") {
        throw conflict("Budget must be archived before purge");
      }
    } finally {
      db.close();
    }

    const safetyBackup = typeof createBudgetBackup === "function"
      ? createBudgetBackup(budgetId)
      : null;
    deleteBudgetStorage(budgetId);

    const finalizeDb = openGlobalDb();
    try {
      finalizeDb.transaction(() => {
        finalizeDb.prepare(`
          UPDATE budgets
          SET status = 'deleted',
              deleted_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(budgetId);
        finalizeDb.prepare(`
          UPDATE auth_sessions
          SET selected_budget_id = NULL,
              revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE selected_budget_id = ?
        `).run(budgetId);
        finalizeDb.prepare("DELETE FROM budget_invitations WHERE budget_id = ?").run(budgetId);
        finalizeDb.prepare("DELETE FROM budget_memberships WHERE budget_id = ?").run(budgetId);
        audit(finalizeDb, {
          action: "budget_purge",
          actorAccountId,
          details: { safetyBackup },
          targetId: budgetId,
          targetType: "budget"
        });
      })();
      return {
        ...budgetRow(finalizeDb, budgetId),
        safetyBackup
      };
    } finally {
      finalizeDb.close();
    }
  }

  async function purgeBudgetAsync(actorAccountId, budgetId) {
    if (!globalStore || globalStore.backend === "sqlite" || typeof globalStore.transaction !== "function") {
      return purgeBudget(actorAccountId, budgetId);
    }

    const normalizedBudgetId = normalizeUserId(budgetId);

    await withExternalGlobalTransaction(async repo => {
      const budget = await requireBudgetForRepo(repo, normalizedBudgetId);
      await requireMembershipRoleForRepo(repo, normalizedBudgetId, actorAccountId, ["owner"]);
      if (budget.status !== "archived") {
        throw conflict("Budget must be archived before purge");
      }
    }, () => purgeBudget(actorAccountId, normalizedBudgetId));

    const safetyBackup = typeof createBudgetBackupAsync === "function"
      ? await createBudgetBackupAsync(normalizedBudgetId)
      : typeof createBudgetBackup === "function"
        ? createBudgetBackup(normalizedBudgetId)
        : null;
    deleteBudgetStorage(normalizedBudgetId);

    const result = await globalStore.transaction(async repo => {
      await repo.budgets.markDeleted(normalizedBudgetId);
      await repo.sessions.revokeAllForBudget(normalizedBudgetId);
      await repo.invitations.deleteAllForBudget(normalizedBudgetId);
      await repo.memberships.deleteAllForBudget(normalizedBudgetId);
      await repo.audit.insertSecurityEvent({
        action: "budget_purge",
        actorAccountId,
        details: { safetyBackup },
        targetId: normalizedBudgetId,
        targetType: "budget"
      });
      return await repo.budgets.get(normalizedBudgetId);
    });

    return {
      ...result,
      safetyBackup
    };
  }

  function listMembers(budgetId, actorAccountId) {
    const db = openGlobalDb();
    try {
      requireBudget(db, budgetId);
      requireMembershipRole(db, budgetId, actorAccountId, ["owner", "manager"]);
      return db.prepare(`
        SELECT a.id AS account_id, a.email, a.display_name, a.status,
          bm.role, bm.created_at, bm.updated_at
        FROM budget_memberships bm
        JOIN accounts a ON a.id = bm.account_id
        WHERE bm.budget_id = ?
        ORDER BY CASE bm.role
          WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
          LOWER(a.display_name), a.id
      `).all(budgetId);
    } finally {
      db.close();
    }
  }

  async function listMembersAsync(budgetId, actorAccountId) {
    return await withGlobalRepository(async repo => {
      if (!repo) return listMembers(budgetId, actorAccountId);
      await requireBudgetForRepo(repo, budgetId);
      await requireMembershipRoleForRepo(repo, budgetId, actorAccountId, ["owner", "manager"]);
      return await repo.memberships.listMembers(budgetId);
    });
  }

  function updateMemberRole(actorAccountId, budgetId, targetAccountId, input = {}) {
    const role = memberRole(input.role);
    const normalizedTargetAccountId = normalizeUserId(targetAccountId);
    const db = openGlobalDb();
    try {
      requireMembershipRole(db, budgetId, actorAccountId, ["owner", "manager"]);
      requireActiveAccount(db, normalizedTargetAccountId);
      const current = membershipRow(db, budgetId, normalizedTargetAccountId);
      if (!current) throw notFound("Budget member not found");
      if (current.role === "owner") throw conflict("Transfer ownership before changing the owner role");
      db.transaction(() => {
        db.prepare(`
          UPDATE budget_memberships
          SET role = ?,
              updated_at = datetime('now')
          WHERE budget_id = ? AND account_id = ?
        `).run(role, budgetId, normalizedTargetAccountId);
        audit(db, {
          action: "budget_member_role_update",
          actorAccountId,
          details: { role },
          targetId: normalizedTargetAccountId,
          targetType: "account"
        });
      })();
      return membershipRow(db, budgetId, normalizedTargetAccountId);
    } finally {
      db.close();
    }
  }

  async function updateMemberRoleAsync(actorAccountId, budgetId, targetAccountId, input = {}) {
    const role = memberRole(input.role);
    const normalizedBudgetId = normalizeUserId(budgetId);
    const normalizedTargetAccountId = normalizeUserId(targetAccountId);
    return await withExternalGlobalTransaction(async repo => {
      await requireMembershipRoleForRepo(repo, normalizedBudgetId, actorAccountId, ["owner", "manager"]);
      await requireActiveAccountForRepo(repo, normalizedTargetAccountId);
      const current = await requireMembershipForRepo(repo, normalizedBudgetId, normalizedTargetAccountId);
      if (current.role === "owner") throw conflict("Transfer ownership before changing the owner role");
      await repo.memberships.updateRole({
        accountId: normalizedTargetAccountId,
        budgetId: normalizedBudgetId,
        role
      });
      await repo.audit.insertSecurityEvent({
        action: "budget_member_role_update",
        actorAccountId,
        details: { role },
        targetId: normalizedTargetAccountId,
        targetType: "account"
      });
      return await repo.memberships.get({
        accountId: normalizedTargetAccountId,
        budgetId: normalizedBudgetId
      });
    }, () => updateMemberRole(actorAccountId, normalizedBudgetId, normalizedTargetAccountId, { role }));
  }

  function removeMember(actorAccountId, budgetId, targetAccountId) {
    const db = openGlobalDb();
    try {
      requireMembershipRole(db, budgetId, actorAccountId, ["owner", "manager"]);
      const current = membershipRow(db, budgetId, targetAccountId);
      if (!current) throw notFound("Budget member not found");
      if (current.role === "owner") throw conflict("Transfer ownership before removing the owner");
      db.transaction(() => {
        db.prepare(`
          DELETE FROM budget_memberships
          WHERE budget_id = ? AND account_id = ?
        `).run(budgetId, targetAccountId);
        db.prepare(`
          UPDATE auth_sessions
          SET selected_budget_id = NULL,
              revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE account_id = ? AND selected_budget_id = ?
        `).run(targetAccountId, budgetId);
        audit(db, {
          action: "budget_member_remove",
          actorAccountId,
          targetId: targetAccountId,
          targetType: "account"
        });
      })();
      return true;
    } finally {
      db.close();
    }
  }

  async function removeMemberAsync(actorAccountId, budgetId, targetAccountId) {
    const normalizedBudgetId = normalizeUserId(budgetId);
    const normalizedTargetAccountId = normalizeUserId(targetAccountId);
    return await withExternalGlobalTransaction(async repo => {
      await requireMembershipRoleForRepo(repo, normalizedBudgetId, actorAccountId, ["owner", "manager"]);
      const current = await requireMembershipForRepo(repo, normalizedBudgetId, normalizedTargetAccountId);
      if (current.role === "owner") throw conflict("Transfer ownership before removing the owner");
      await repo.memberships.delete({
        accountId: normalizedTargetAccountId,
        budgetId: normalizedBudgetId
      });
      await repo.sessions.revokeForAccountBudget(normalizedTargetAccountId, normalizedBudgetId);
      await repo.audit.insertSecurityEvent({
        action: "budget_member_remove",
        actorAccountId,
        targetId: normalizedTargetAccountId,
        targetType: "account"
      });
      return true;
    }, () => removeMember(actorAccountId, normalizedBudgetId, normalizedTargetAccountId));
  }

  function leaveBudget(accountId, budgetId) {
    const db = openGlobalDb();
    try {
      const current = membershipRow(db, budgetId, accountId);
      if (!current) throw notFound("Budget member not found");
      if (current.role === "owner") throw conflict("Transfer ownership before leaving the budget");
      db.transaction(() => {
        db.prepare(`
          DELETE FROM budget_memberships
          WHERE budget_id = ? AND account_id = ?
        `).run(budgetId, accountId);
        db.prepare(`
          UPDATE auth_sessions
          SET selected_budget_id = NULL,
              revoked_at = COALESCE(revoked_at, datetime('now'))
          WHERE account_id = ? AND selected_budget_id = ?
        `).run(accountId, budgetId);
        audit(db, {
          action: "budget_member_leave",
          actorAccountId: accountId,
          targetId: budgetId,
          targetType: "budget"
        });
      })();
      return true;
    } finally {
      db.close();
    }
  }

  async function leaveBudgetAsync(accountId, budgetId) {
    const normalizedBudgetId = normalizeUserId(budgetId);
    const normalizedAccountId = normalizeUserId(accountId);
    return await withExternalGlobalTransaction(async repo => {
      const current = await requireMembershipForRepo(repo, normalizedBudgetId, normalizedAccountId);
      if (current.role === "owner") throw conflict("Transfer ownership before leaving the budget");
      await repo.memberships.delete({
        accountId: normalizedAccountId,
        budgetId: normalizedBudgetId
      });
      await repo.sessions.revokeForAccountBudget(normalizedAccountId, normalizedBudgetId);
      await repo.audit.insertSecurityEvent({
        action: "budget_member_leave",
        actorAccountId: normalizedAccountId,
        targetId: normalizedBudgetId,
        targetType: "budget"
      });
      return true;
    }, () => leaveBudget(normalizedAccountId, normalizedBudgetId));
  }

  function transferOwnership(actorAccountId, budgetId, targetAccountId) {
    const normalizedTargetAccountId = normalizeUserId(targetAccountId);
    const db = openGlobalDb();
    try {
      const actorMembership = membershipRow(db, budgetId, actorAccountId);
      requireActiveAccount(db, normalizedTargetAccountId);
      const targetMembership = membershipRow(db, budgetId, normalizedTargetAccountId);
      if (actorMembership?.role !== "owner") throw forbidden("Only the budget owner can transfer ownership");
      if (!targetMembership) throw notFound("Target account is not a budget member");
      if (targetMembership.role === "owner") return targetMembership;

      db.transaction(() => {
        db.prepare(`
          DELETE FROM budget_memberships
          WHERE budget_id = ? AND account_id = ?
        `).run(budgetId, normalizedTargetAccountId);
        db.prepare(`
          UPDATE budget_memberships
          SET account_id = ?,
              updated_at = datetime('now')
          WHERE budget_id = ? AND account_id = ? AND role = 'owner'
        `).run(normalizedTargetAccountId, budgetId, actorAccountId);
        db.prepare(`
          INSERT INTO budget_memberships (
            budget_id, account_id, role, invited_by_account_id, created_at, updated_at
          )
          VALUES (?, ?, 'manager', ?, datetime('now'), datetime('now'))
        `).run(budgetId, actorAccountId, normalizedTargetAccountId);
        audit(db, {
          action: "budget_ownership_transfer",
          actorAccountId,
          targetId: normalizedTargetAccountId,
          targetType: "account"
        });
      })();
      return membershipRow(db, budgetId, normalizedTargetAccountId);
    } finally {
      db.close();
    }
  }

  async function transferOwnershipAsync(actorAccountId, budgetId, targetAccountId) {
    const normalizedBudgetId = normalizeUserId(budgetId);
    const normalizedTargetAccountId = normalizeUserId(targetAccountId);
    return await withExternalGlobalTransaction(async repo => {
      const actorMembership = await repo.memberships.get({
        accountId: actorAccountId,
        budgetId: normalizedBudgetId
      });
      await requireActiveAccountForRepo(repo, normalizedTargetAccountId);
      const targetMembership = await repo.memberships.get({
        accountId: normalizedTargetAccountId,
        budgetId: normalizedBudgetId
      });
      if (actorMembership?.role !== "owner") throw forbidden("Only the budget owner can transfer ownership");
      if (!targetMembership) throw notFound("Target account is not a budget member");
      if (targetMembership.role === "owner") return targetMembership;

      await repo.memberships.delete({
        accountId: normalizedTargetAccountId,
        budgetId: normalizedBudgetId
      });
      await repo.memberships.updateOwnerAccount({
        budgetId: normalizedBudgetId,
        fromAccountId: actorAccountId,
        toAccountId: normalizedTargetAccountId
      });
      await repo.memberships.insert({
        budgetId: normalizedBudgetId,
        accountId: actorAccountId,
        role: "manager",
        invitedByAccountId: normalizedTargetAccountId
      });
      await repo.audit.insertSecurityEvent({
        action: "budget_ownership_transfer",
        actorAccountId,
        targetId: normalizedTargetAccountId,
        targetType: "account"
      });
      return await repo.memberships.get({
        accountId: normalizedTargetAccountId,
        budgetId: normalizedBudgetId
      });
    }, () => transferOwnership(actorAccountId, normalizedBudgetId, normalizedTargetAccountId));
  }

  function createInvitation(actorAccountId, budgetId, input = {}) {
    const role = memberRole(input.role);
    const targetAccountId = input.accountId ? normalizeUserId(input.accountId) : null;
    const targetEmail = String(input.email || "").trim().toLowerCase() || null;
    if (!targetAccountId && !targetEmail) {
      throw badRequest("Invitation requires an accountId or email");
    }
    const expiresInHours = Number(input.expiresInHours ?? 168);
    if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) {
      throw badRequest("Invitation expiry must be between 1 and 720 hours");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const invitationId = `invite_${crypto.randomUUID()}`;
    const db = openGlobalDb();
    try {
      requireBudget(db, budgetId);
      requireMembershipRole(db, budgetId, actorAccountId, ["owner", "manager"]);
      if (targetAccountId) requireActiveAccount(db, targetAccountId);
      db.transaction(() => {
        db.prepare(`
          INSERT INTO budget_invitations (
            id, budget_id, target_account_id, target_email, role, token_hash,
            status, invited_by_account_id, expires_at, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?,
            datetime('now', ?), datetime('now'), datetime('now'))
        `).run(
          invitationId,
          budgetId,
          targetAccountId,
          targetEmail,
          role,
          inviteTokenHash(token),
          actorAccountId,
          `+${expiresInHours} hours`
        );
        audit(db, {
          action: "budget_invitation_create",
          actorAccountId,
          details: { role },
          targetId: invitationId,
          targetType: "budget_invitation"
        });
      })();
      return {
        ...db.prepare(`
          SELECT id, budget_id, target_account_id, target_email, role, status,
            expires_at, created_at, updated_at
          FROM budget_invitations
          WHERE id = ?
        `).get(invitationId),
        token
      };
    } finally {
      db.close();
    }
  }

  async function createInvitationAsync(actorAccountId, budgetId, input = {}) {
    const role = memberRole(input.role);
    const normalizedBudgetId = normalizeUserId(budgetId);
    const targetAccountId = input.accountId ? normalizeUserId(input.accountId) : null;
    const targetEmail = String(input.email || "").trim().toLowerCase() || null;
    if (!targetAccountId && !targetEmail) {
      throw badRequest("Invitation requires an accountId or email");
    }
    const expiresInHours = Number(input.expiresInHours ?? 168);
    if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) {
      throw badRequest("Invitation expiry must be between 1 and 720 hours");
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const invitationId = `invite_${crypto.randomUUID()}`;
    return await withExternalGlobalTransaction(async repo => {
      await requireBudgetForRepo(repo, normalizedBudgetId);
      await requireMembershipRoleForRepo(repo, normalizedBudgetId, actorAccountId, ["owner", "manager"]);
      if (targetAccountId) await requireActiveAccountForRepo(repo, targetAccountId);
      await repo.invitations.insertPending({
        id: invitationId,
        budgetId: normalizedBudgetId,
        targetAccountId,
        targetEmail,
        role,
        tokenHash: inviteTokenHash(token),
        invitedByAccountId: actorAccountId,
        expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString()
      });
      await repo.audit.insertSecurityEvent({
        action: "budget_invitation_create",
        actorAccountId,
        details: { role },
        targetId: invitationId,
        targetType: "budget_invitation"
      });
      return {
        ...(await repo.invitations.getForBudget({
          budgetId: normalizedBudgetId,
          invitationId
        })),
        token
      };
    }, () => createInvitation(actorAccountId, normalizedBudgetId, {
      accountId: targetAccountId,
      email: targetEmail,
      expiresInHours,
      role
    }));
  }

  function listInvitations(budgetId, actorAccountId) {
    const db = openGlobalDb();
    try {
      requireBudget(db, budgetId);
      requireMembershipRole(db, budgetId, actorAccountId, ["owner", "manager"]);
      db.prepare(`
        UPDATE budget_invitations
        SET status = 'expired',
            updated_at = datetime('now')
        WHERE budget_id = ? AND status = 'pending' AND expires_at <= datetime('now')
      `).run(budgetId);
      return db.prepare(`
        SELECT id, budget_id, target_account_id, target_email, role, status,
          invited_by_account_id, expires_at, accepted_at, revoked_at, created_at,
          updated_at
        FROM budget_invitations
        WHERE budget_id = ?
        ORDER BY created_at DESC
      `).all(budgetId);
    } finally {
      db.close();
    }
  }

  async function listInvitationsAsync(budgetId, actorAccountId) {
    return await withGlobalRepository(async repo => {
      if (!repo) return listInvitations(budgetId, actorAccountId);
      await requireBudgetForRepo(repo, budgetId);
      await requireMembershipRoleForRepo(repo, budgetId, actorAccountId, ["owner", "manager"]);
      await repo.invitations.expirePendingForBudget(budgetId);
      return await repo.invitations.listForBudget(budgetId);
    });
  }

  function revokeInvitation(actorAccountId, budgetId, invitationId) {
    const db = openGlobalDb();
    try {
      requireMembershipRole(db, budgetId, actorAccountId, ["owner", "manager"]);
      const invitation = db.prepare(`
        SELECT id, status
        FROM budget_invitations
        WHERE id = ? AND budget_id = ?
      `).get(invitationId, budgetId);
      if (!invitation) throw notFound("Invitation not found");
      if (invitation.status !== "pending") throw conflict("Only pending invitations can be revoked");
      db.transaction(() => {
        db.prepare(`
          UPDATE budget_invitations
          SET status = 'revoked',
              revoked_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `).run(invitationId);
        audit(db, {
          action: "budget_invitation_revoke",
          actorAccountId,
          targetId: invitationId,
          targetType: "budget_invitation"
        });
      })();
      return true;
    } finally {
      db.close();
    }
  }

  async function revokeInvitationAsync(actorAccountId, budgetId, invitationId) {
    const normalizedBudgetId = normalizeUserId(budgetId);
    return await withExternalGlobalTransaction(async repo => {
      await requireMembershipRoleForRepo(repo, normalizedBudgetId, actorAccountId, ["owner", "manager"]);
      const invitation = await repo.invitations.getForBudget({
        budgetId: normalizedBudgetId,
        invitationId
      });
      if (!invitation) throw notFound("Invitation not found");
      if (invitation.status !== "pending") throw conflict("Only pending invitations can be revoked");
      await repo.invitations.revokePending(invitationId);
      await repo.audit.insertSecurityEvent({
        action: "budget_invitation_revoke",
        actorAccountId,
        targetId: invitationId,
        targetType: "budget_invitation"
      });
      return true;
    }, () => revokeInvitation(actorAccountId, normalizedBudgetId, invitationId));
  }

  function acceptInvitation(accountId, token) {
    const normalizedAccountId = normalizeUserId(accountId);
    const db = openGlobalDb();
    try {
      const account = requireActiveAccount(db, normalizedAccountId);
      const invitation = db.prepare(`
        SELECT *
        FROM budget_invitations
        WHERE token_hash = ?
      `).get(inviteTokenHash(token));
      if (!invitation) throw notFound("Invitation not found");
      if (invitation.status !== "pending") throw conflict("Invitation is no longer available");
      if (Date.parse(`${invitation.expires_at}Z`) <= Date.now()) throw conflict("Invitation has expired");
      if (invitation.target_account_id && invitation.target_account_id !== normalizedAccountId) {
        throw forbidden("Invitation target does not match the current account");
      }
      if (
        invitation.target_email
        && String(account.email || "").toLowerCase() !== String(invitation.target_email).toLowerCase()
      ) {
        throw forbidden("Invitation target does not match the current account");
      }

      db.transaction(() => {
        const accepted = db.prepare(`
          UPDATE budget_invitations
          SET status = 'accepted',
              accepted_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'
        `).run(invitation.id);
        if (accepted.changes !== 1) {
          throw conflict("Invitation is no longer available");
        }
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
          invitation.budget_id,
          normalizedAccountId,
          invitation.role,
          invitation.invited_by_account_id
        );
        audit(db, {
          action: "budget_invitation_accept",
          actorAccountId: normalizedAccountId,
          targetId: invitation.id,
          targetType: "budget_invitation"
        });
      })();
      return {
        budgetId: invitation.budget_id,
        membership: membershipRow(db, invitation.budget_id, normalizedAccountId)
      };
    } finally {
      db.close();
    }
  }

  async function acceptInvitationAsync(accountId, token) {
    const normalizedAccountId = normalizeUserId(accountId);
    return await withExternalGlobalTransaction(async repo => {
      const account = await requireActiveAccountForRepo(repo, normalizedAccountId);
      const invitation = await repo.invitations.getByTokenHash(inviteTokenHash(token));
      if (!invitation) throw notFound("Invitation not found");
      if (invitation.status !== "pending") throw conflict("Invitation is no longer available");
      if (invitationExpiryMs(invitation.expires_at) <= Date.now()) throw conflict("Invitation has expired");
      if (invitation.target_account_id && invitation.target_account_id !== normalizedAccountId) {
        throw forbidden("Invitation target does not match the current account");
      }
      if (
        invitation.target_email
        && String(account.email || "").toLowerCase() !== String(invitation.target_email).toLowerCase()
      ) {
        throw forbidden("Invitation target does not match the current account");
      }

      const accepted = await repo.invitations.acceptForAccount({
        accountId: normalizedAccountId,
        invitationId: invitation.id,
        role: invitation.role
      });
      if (accepted !== 1) {
        throw conflict("Invitation is no longer available");
      }
      await repo.memberships.upsertFromInvitation({
        budgetId: invitation.budget_id,
        accountId: normalizedAccountId,
        role: invitation.role,
        invitedByAccountId: invitation.invited_by_account_id
      });
      await repo.audit.insertSecurityEvent({
        action: "budget_invitation_accept",
        actorAccountId: normalizedAccountId,
        targetId: invitation.id,
        targetType: "budget_invitation"
      });
      return {
        budgetId: invitation.budget_id,
        membership: await repo.memberships.get({
          budgetId: invitation.budget_id,
          accountId: normalizedAccountId
        })
      };
    }, () => acceptInvitation(normalizedAccountId, token));
  }

  return {
    acceptInvitation,
    acceptInvitationAsync,
    archiveBudget,
    archiveBudgetAsync,
    createBudget,
    createBudgetAsync,
    createInvitation,
    createInvitationAsync,
    leaveBudget,
    leaveBudgetAsync,
    listAccounts,
    listAccountsAsync,
    listBudgetsForAccount,
    listBudgetsForAccountAsync,
    listInvitations,
    listInvitationsAsync,
    listMembers,
    listMembersAsync,
    purgeBudget,
    purgeBudgetAsync,
    removeMember,
    removeMemberAsync,
    renameBudget,
    renameBudgetAsync,
    restoreBudget,
    restoreBudgetAsync,
    revokeInvitation,
    revokeInvitationAsync,
    transferOwnership,
    transferOwnershipAsync,
    updateMemberRole,
    updateMemberRoleAsync
  };
}
