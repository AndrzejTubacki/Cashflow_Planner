import crypto from "node:crypto";

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
  now = () => new Date(),
  openGlobalDb,
  resolveAccountContext,
  resolveBudgetContext
}) {
  function sessionRowForToken(db, token) {
    if (!String(token || "")) return null;
    return db.prepare(`
      SELECT *
      FROM auth_sessions
      WHERE token_hash = ?
        AND revoked_at IS NULL
    `).get(tokenHash(token));
  }

  function activeSessionRow(db, token, { touch = false } = {}) {
    const row = sessionRowForToken(db, token);
    if (!row) return null;

    const current = now();
    if (
      Date.parse(row.idle_expires_at) <= current.getTime()
      || Date.parse(row.absolute_expires_at) <= current.getTime()
    ) {
      db.prepare(`
        UPDATE auth_sessions
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ?
      `).run(current.toISOString(), row.id);
      return null;
    }

    const account = db.prepare(`
      SELECT status
      FROM accounts
      WHERE id = ?
    `).get(row.account_id);
    if (!account || account.status !== "active") {
      db.prepare(`
        UPDATE auth_sessions
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ?
      `).run(current.toISOString(), row.id);
      return null;
    }

    if (touch) {
      const config = db.prepare(`
        SELECT session_idle_minutes
        FROM auth_config
        WHERE id = 1
      `).get() || {};
      const idleMinutes = Math.max(1, Number(config.session_idle_minutes) || 720);
      db.prepare(`
        UPDATE auth_sessions
        SET last_seen_at = ?,
            idle_expires_at = ?
        WHERE id = ?
      `).run(current.toISOString(), addMinutes(current, idleMinutes), row.id);
    }

    return row;
  }

  function createSession({ accountId, budgetId, authMethod = "none" }) {
    const context = budgetId
      ? resolveBudgetContext(budgetId, { accountId })
      : resolveAccountContext(accountId);
    const db = openGlobalDb();
    try {
      const config = db.prepare(`
        SELECT session_idle_minutes, session_absolute_minutes
        FROM auth_config
        WHERE id = 1
      `).get() || {};
      const idleMinutes = Math.max(1, Number(config.session_idle_minutes) || 720);
      const absoluteMinutes = Math.max(idleMinutes, Number(config.session_absolute_minutes) || 10080);
      const createdAt = now();
      const token = randomToken();
      const csrfToken = randomToken();
      const sessionId = `session_${crypto.randomUUID()}`;

      db.prepare(`
        INSERT INTO auth_sessions (
          id, account_id, token_hash, csrf_token_hash, selected_budget_id,
          auth_method, created_at, last_seen_at, idle_expires_at,
          absolute_expires_at, revoked_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        sessionId,
        accountId,
        tokenHash(token),
        tokenHash(csrfToken),
        budgetId || null,
        authMethod,
        createdAt.toISOString(),
        createdAt.toISOString(),
        addMinutes(createdAt, idleMinutes),
        addMinutes(createdAt, absoluteMinutes)
      );

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
    } finally {
      db.close();
    }
  }

  function createNoneSession(budgetId, { accountId: requestedAccountId = null } = {}) {
    const db = openGlobalDb();
    let accountId;
    try {
      const config = db.prepare("SELECT active_mode FROM auth_config WHERE id = 1").get();
      if ((config?.active_mode || "none") !== "none") {
        throw forbidden("None-mode account selection is disabled");
      }
      accountId = requestedAccountId || db.prepare(`
          SELECT bm.account_id
          FROM budget_memberships bm
          JOIN accounts a ON a.id = bm.account_id
          JOIN budgets b ON b.id = bm.budget_id
          WHERE bm.budget_id = ?
            AND bm.role = 'owner'
            AND a.status = 'active'
            AND b.status = 'active'
        `).get(budgetId)?.account_id;
    } finally {
      db.close();
    }

    if (!accountId) throw forbidden("Budget access denied");
    return createSession({
      accountId,
      authMethod: "none",
      budgetId
    });
  }

  function createNoneAccountSession(accountId) {
    const db = openGlobalDb();
    try {
      const config = db.prepare("SELECT active_mode FROM auth_config WHERE id = 1").get();
      if ((config?.active_mode || "none") !== "none") {
        throw forbidden("None-mode account selection is disabled");
      }
    } finally {
      db.close();
    }
    return createSession({
      accountId,
      authMethod: "none",
      budgetId: null
    });
  }

  function createInternalAccountSession(accountId) {
    const db = openGlobalDb();
    try {
      const config = db.prepare("SELECT active_mode FROM auth_config WHERE id = 1").get();
      if ((config?.active_mode || "none") !== "internal") {
        throw forbidden("Internal login is disabled");
      }
    } finally {
      db.close();
    }
    return createSession({
      accountId,
      authMethod: "internal",
      budgetId: null
    });
  }

  function createInternalSession(budgetId, { accountId }) {
    const db = openGlobalDb();
    try {
      const config = db.prepare("SELECT active_mode FROM auth_config WHERE id = 1").get();
      if ((config?.active_mode || "none") !== "internal") {
        throw forbidden("Internal login is disabled");
      }
    } finally {
      db.close();
    }
    return createSession({
      accountId,
      authMethod: "internal",
      budgetId
    });
  }

  function createExternalAccountSession(accountId) {
    const db = openGlobalDb();
    try {
      const config = db.prepare("SELECT active_mode FROM auth_config WHERE id = 1").get();
      if ((config?.active_mode || "none") !== "external") {
        throw forbidden("External authentication is disabled");
      }
    } finally {
      db.close();
    }
    return createSession({
      accountId,
      authMethod: "external",
      budgetId: null
    });
  }

  function resolveTokenContext(token, { touch = true } = {}) {
    const db = openGlobalDb();
    let row;
    try {
      row = activeSessionRow(db, token, { touch });
    } finally {
      db.close();
    }
    if (!row) return null;

    let context;
    if (row.selected_budget_id) {
      try {
        context = resolveBudgetContext(row.selected_budget_id, { accountId: row.account_id });
      } catch {
        context = resolveAccountContext(row.account_id);
      }
    } else {
      context = resolveAccountContext(row.account_id);
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

  function requireTokenContext(token, options = {}) {
    const context = resolveTokenContext(token, options);
    if (!context) throw unauthorized();
    return context;
  }

  function rotateCsrfToken(token) {
    const db = openGlobalDb();
    try {
      const row = activeSessionRow(db, token, { touch: true });
      if (!row) throw unauthorized();
      const csrfToken = randomToken();
      db.prepare(`
        UPDATE auth_sessions
        SET csrf_token_hash = ?
        WHERE id = ?
      `).run(tokenHash(csrfToken), row.id);
      return csrfToken;
    } finally {
      db.close();
    }
  }

  function validateCsrfToken(token, csrfToken) {
    const db = openGlobalDb();
    try {
      const row = activeSessionRow(db, token);
      return Boolean(row) && hashesMatch(row.csrf_token_hash, tokenHash(csrfToken));
    } finally {
      db.close();
    }
  }

  function revokeSession(token) {
    const db = openGlobalDb();
    try {
      const row = sessionRowForToken(db, token);
      if (!row) return false;
      db.prepare(`
        UPDATE auth_sessions
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE id = ?
      `).run(now().toISOString(), row.id);
      return true;
    } finally {
      db.close();
    }
  }

  function selectBudget(token, budgetId) {
    const context = requireTokenContext(token);
    const selected = resolveBudgetContext(budgetId, {
      accountId: context.account.id
    });
    const db = openGlobalDb();
    try {
      db.prepare(`
        UPDATE auth_sessions
        SET selected_budget_id = ?,
            last_seen_at = ?
        WHERE token_hash = ? AND revoked_at IS NULL
      `).run(budgetId, now().toISOString(), tokenHash(token));
    } finally {
      db.close();
    }
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
