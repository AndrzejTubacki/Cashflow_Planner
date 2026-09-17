import crypto from "node:crypto";

import { createSqliteGlobalRepository } from "./cashflow-global-repository.js";
import { forbidden, unauthorized } from "./cashflow-user-utils.js";

const TOKEN_BYTES = 32;
export const SESSION_COOKIE_NAME = "cashflow_session";

export function sessionTokenFromRequest(req) {
  const cookieHeader = String(req?.headers?.cookie || "");
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      return decodeURIComponent(valueParts.join("=") || "");
    }
  }
  return "";
}

function randomToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000).toISOString();
}

function hashesMatch(left, right) {
  const leftBuffer = Buffer.from(String(left || ""), "hex");
  const rightBuffer = Buffer.from(String(right || ""), "hex");
  return leftBuffer.length === rightBuffer.length
    && leftBuffer.length > 0
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function createCashflowSessionService({
  createGlobalRepository = createSqliteGlobalRepository,
  globalStore = null,
  now = () => new Date(),
  openGlobalDb,
  resolveAccountContext,
  resolveBudgetContext
}) {
  function globalRepository(db) {
    return createGlobalRepository(db);
  }

  function withRepository(fn) {
    if (globalStore && typeof globalStore.withRepository === "function") {
      return globalStore.withRepository(fn);
    }
    const db = openGlobalDb();
    let result;
    try {
      result = fn(globalRepository(db), db);
    } catch (error) {
      db.close();
      throw error;
    }
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        db.close();
      });
    }
    db.close();
    return result;
  }

  async function sessionRowForToken(repo, token) {
    if (!String(token || "")) return null;
    return await repo.sessions.getByTokenHash(tokenHash(token));
  }

  async function activeSessionRow(repo, token, { touch = false } = {}) {
    const row = await sessionRowForToken(repo, token);
    if (!row) return null;

    const current = now();
    if (
      Date.parse(row.idle_expires_at) <= current.getTime()
      || Date.parse(row.absolute_expires_at) <= current.getTime()
    ) {
      await repo.sessions.revokeById(row.id, current.toISOString());
      return null;
    }

    const account = await repo.accounts.getStatus(row.account_id);
    if (!account || account.status !== "active") {
      await repo.sessions.revokeById(row.id, current.toISOString());
      return null;
    }

    if (touch) {
      const config = await repo.authConfig.get() || {};
      const idleMinutes = Math.max(1, Number(config.session_idle_minutes) || 720);
      await repo.sessions.touch({
        id: row.id,
        idleExpiresAt: addMinutes(current, idleMinutes),
        lastSeenAt: current.toISOString()
      });
    }

    return row;
  }

  async function createSession({ accountId, budgetId, authMethod = "none" }) {
    const context = budgetId
      ? await resolveBudgetContext(budgetId, { accountId })
      : await resolveAccountContext(accountId);
    return await withRepository(async repo => {
      const config = await repo.authConfig.get() || {};
      const idleMinutes = Math.max(1, Number(config.session_idle_minutes) || 720);
      const absoluteMinutes = Math.max(idleMinutes, Number(config.session_absolute_minutes) || 10080);
      const createdAt = now();
      const token = randomToken();
      const csrfToken = randomToken();
      const sessionId = `session_${crypto.randomUUID()}`;

      await repo.sessions.insert({
        id: sessionId,
        accountId,
        absoluteExpiresAt: addMinutes(createdAt, absoluteMinutes),
        authMethod,
        createdAt: createdAt.toISOString(),
        csrfTokenHash: tokenHash(csrfToken),
        idleExpiresAt: addMinutes(createdAt, idleMinutes),
        lastSeenAt: createdAt.toISOString(),
        selectedBudgetId: budgetId || null,
        tokenHash: tokenHash(token)
      });

      const issuedContext = {
        ...context,
        authMode: authMethod,
        session: {
          ...(context.session || {}),
          authMode: authMethod
        }
      };

      return {
        context: issuedContext,
        csrfToken,
        token
      };
    });
  }

  async function createNoneSession(budgetId, { accountId: requestedAccountId = null } = {}) {
    const accountId = await withRepository(async repo => {
      const config = await repo.authConfig.getActiveMode();
      if ((config?.active_mode || "none") !== "none") {
        throw forbidden("None-mode account selection is disabled");
      }
      return requestedAccountId || await repo.memberships.activeOwnerAccountId(budgetId);
    });

    if (!accountId) throw forbidden("Budget access denied");
    return await createSession({
      accountId,
      authMethod: "none",
      budgetId
    });
  }

  async function createNoneAccountSession(accountId) {
    await withRepository(async repo => {
      const config = await repo.authConfig.getActiveMode();
      if ((config?.active_mode || "none") !== "none") {
        throw forbidden("None-mode account selection is disabled");
      }
    });
    return await createSession({
      accountId,
      authMethod: "none",
      budgetId: null
    });
  }

  async function createInternalAccountSession(accountId) {
    await withRepository(async repo => {
      const config = await repo.authConfig.getActiveMode();
      if ((config?.active_mode || "none") !== "internal") {
        throw forbidden("Internal login is disabled");
      }
    });
    return await createSession({
      accountId,
      authMethod: "internal",
      budgetId: null
    });
  }

  async function createInternalSession(budgetId, { accountId }) {
    await withRepository(async repo => {
      const config = await repo.authConfig.getActiveMode();
      if ((config?.active_mode || "none") !== "internal") {
        throw forbidden("Internal login is disabled");
      }
    });
    return await createSession({
      accountId,
      authMethod: "internal",
      budgetId
    });
  }

  async function createExternalAccountSession(accountId) {
    await withRepository(async repo => {
      const config = await repo.authConfig.getActiveMode();
      if ((config?.active_mode || "none") !== "external") {
        throw forbidden("External authentication is disabled");
      }
    });
    return await createSession({
      accountId,
      authMethod: "external",
      budgetId: null
    });
  }

  async function resolveTokenContext(token, { touch = true } = {}) {
    const row = await withRepository(repo => activeSessionRow(repo, token, { touch }));
    if (!row) return null;

    let context;
    if (row.selected_budget_id) {
      try {
        context = await resolveBudgetContext(row.selected_budget_id, { accountId: row.account_id });
      } catch {
        context = await resolveAccountContext(row.account_id);
      }
    } else {
      context = await resolveAccountContext(row.account_id);
    }

    return {
      ...context,
      authMode: row.auth_method,
      authSession: {
        accountId: row.account_id,
        authMethod: row.auth_method,
        id: row.id,
        selectedBudgetId: row.selected_budget_id
      },
      session: {
        ...(context.session || {}),
        authMode: row.auth_method
      }
    };
  }

  async function requireTokenContext(token, options = {}) {
    const context = await resolveTokenContext(token, options);
    if (!context) throw unauthorized();
    return context;
  }

  async function rotateCsrfToken(token) {
    return await withRepository(async repo => {
      const row = await activeSessionRow(repo, token, { touch: true });
      if (!row) throw unauthorized();
      const csrfToken = randomToken();
      await repo.sessions.updateCsrfHash(row.id, tokenHash(csrfToken));
      return csrfToken;
    });
  }

  async function validateCsrfToken(token, csrfToken) {
    return await withRepository(async repo => {
      const row = await activeSessionRow(repo, token);
      return Boolean(row) && hashesMatch(row.csrf_token_hash, tokenHash(csrfToken));
    });
  }

  async function revokeSession(token) {
    return await withRepository(async repo => {
      const row = await sessionRowForToken(repo, token);
      if (!row) return false;
      await repo.sessions.revokeById(row.id, now().toISOString());
      return true;
    });
  }

  async function selectBudget(token, budgetId) {
    const context = await requireTokenContext(token);
    const selected = await resolveBudgetContext(budgetId, {
      accountId: context.account.id
    });
    await withRepository(async repo => {
      await repo.sessions.selectBudgetByTokenHash({
        budgetId,
        lastSeenAt: now().toISOString(),
        tokenHash: tokenHash(token)
      });
    });
    return selected;
  }

  return {
    createExternalAccountSession,
    createInternalAccountSession,
    createInternalSession,
    createNoneAccountSession,
    createNoneSession,
    createSession,
    requireTokenContext,
    resolveTokenContext,
    revokeSession,
    rotateCsrfToken,
    selectBudget,
    validateCsrfToken
  };
}
