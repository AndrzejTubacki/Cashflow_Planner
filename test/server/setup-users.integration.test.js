import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCashflowGlobalService } from "../../src/server/cashflow-global-service.js";
import { initializeLedgerSchema } from "../../src/server/cashflow-schema.js";
import {
  createCashflowTestHarness,
  ledgerDbPath
} from "../helpers/cashflow-test-harness.js";

async function withHarness(fn) {
  const harness = await createCashflowTestHarness();
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

test("users endpoint lists local and later accounts receive no global admin role", async () => withHarness(async harness => {
  const listed = await harness.api("/api/users");

  assert.ok(listed.users.some(user => user.id === "local"));

  const created = await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "first_run_user",
      displayName: "First Run User"
    }
  });

  assert.equal(created.session.userId, "first_run_user");
  assert.equal(created.session.displayName, "First Run User");
  assert.deepEqual(created.session.permissions, []);
  assert.equal(created.session.budgetRole, "owner");
}));

test("the first account on a fresh installation becomes the system administrator", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    const created = await harness.api("/api/users", {
      method: "POST",
      body: {
        userId: "first_admin",
        displayName: "First Administrator"
      }
    });

    assert.deepEqual(created.session.permissions, ["admin"]);
    assert.ok(created.session.globalRoles.includes("system_admin"));
    assert.equal(created.session.budgetRole, "owner");

    const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM account_global_roles").get().count, 1);
      assert.ok(db.prepare("SELECT bootstrap_completed_at FROM auth_config WHERE id = 1").get().bootstrap_completed_at);
    } finally {
      db.close();
    }
  } finally {
    await harness.cleanup();
  }
});

test("concurrent fresh account creation grants exactly one system administrator", async () => {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-bootstrap-test-"));
  const storage = new Set();
  const service = createCashflowGlobalService({
    cashflowUserStorageExists: userId => storage.has(userId),
    dataDir: path.join(runtimeRoot, "data"),
    listCashflowUserIds: () => [...storage],
    openPlanningDb: userId => ({
      close: () => {},
      prepare: () => ({
        run: () => {
          storage.add(userId);
        }
      })
    })
  });

  try {
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => service.createUser({ userId: "bootstrap_a" })),
      Promise.resolve().then(() => service.createUser({ userId: "bootstrap_b" }))
    ]);
    assert.equal(first.authenticated, true);
    assert.equal(second.authenticated, true);

    const db = new Database(path.join(runtimeRoot, "data", "cashflow-global.sqlite"));
    try {
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM account_global_roles
        WHERE role = 'system_admin'
      `).get().count, 1);
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM budget_memberships
        WHERE role = 'owner'
      `).get().count, 2);
    } finally {
      db.close();
    }
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
});

test("none-mode selections issue opaque revocable sessions with CSRF protection", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    const created = await harness.request("/api/users", {
      method: "POST",
      body: { userId: "session_owner" }
    });
    assert.equal(created.response.status, 200);
    assert.ok(created.body.csrfToken);

    const issued = harness.session();
    assert.match(issued.cookie, /^cashflow_session=/);
    assert.ok(issued.csrfToken);
    const rawToken = issued.cookie.split("=")[1];

    const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      const row = db.prepare("SELECT token_hash, csrf_token_hash FROM auth_sessions").get();
      assert.notEqual(row.token_hash, rawToken);
      assert.notEqual(row.csrf_token_hash, issued.csrfToken);
      assert.equal(row.token_hash.length, 64);
      assert.equal(row.csrf_token_hash.length, 64);
    } finally {
      db.close();
    }

    const missingCsrf = await harness.request("/api/one-off", {
      method: "POST",
      skipUserHeader: true,
      headers: { cookie: issued.cookie },
      body: {
        name: "Blocked",
        type: "income",
        amount: 1,
        currency: "PLN",
        date: "2026-06-01"
      }
    });
    assert.equal(missingCsrf.response.status, 403);

    const allowed = await harness.request("/api/one-off", {
      method: "POST",
      useSession: true,
      body: {
        name: "Allowed",
        type: "income",
        amount: 1,
        currency: "PLN",
        date: "2026-06-01"
      }
    });
    assert.equal(allowed.response.status, 200);

    const beforeRotation = harness.session();
    const rotated = await harness.request("/api/session", {
      useSession: true
    });
    assert.equal(rotated.response.status, 200);
    assert.ok(rotated.body.csrfToken);
    assert.notEqual(rotated.body.csrfToken, beforeRotation.csrfToken);

    const staleCsrf = await harness.request("/api/one-off", {
      method: "POST",
      skipUserHeader: true,
      headers: {
        cookie: beforeRotation.cookie,
        "x-cashflow-csrf-token": beforeRotation.csrfToken
      },
      body: {
        name: "Stale CSRF blocked",
        type: "income",
        amount: 1,
        currency: "PLN",
        date: "2026-06-01"
      }
    });
    assert.equal(staleCsrf.response.status, 403);

    const freshCsrf = await harness.request("/api/one-off", {
      method: "POST",
      useSession: true,
      body: {
        name: "Fresh CSRF allowed",
        type: "income",
        amount: 1,
        currency: "PLN",
        date: "2026-06-01"
      }
    });
    assert.equal(freshCsrf.response.status, 200);

    const logout = await harness.request("/api/logout", {
      method: "POST",
      useSession: true,
      body: {}
    });
    assert.equal(logout.response.status, 200);

    const revoked = await harness.request("/api/session", {
      skipUserHeader: true,
      headers: { cookie: issued.cookie }
    });
    assert.equal(revoked.response.status, 401);
  } finally {
    await harness.cleanup();
  }
});

test("legacy session selection is disabled in credential auth modes before storage creation", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    const created = await harness.request("/api/users", {
      method: "POST",
      skipUserHeader: true,
      body: {
        userId: "internal_guard_admin",
        displayName: "Internal Guard Admin",
        email: "guard-admin@example.com"
      }
    });
    assert.equal(created.response.status, 200);

    const tokenResult = await harness.api("/api/admin/accounts/internal_guard_admin/password-reset-token", {
      method: "POST",
      useSession: true,
      body: { purpose: "password_setup" }
    });
    const completed = await harness.request("/api/auth/internal/password", {
      method: "POST",
      skipUserHeader: true,
      body: {
        token: tokenResult.token,
        password: "correct horse battery staple"
      }
    });
    assert.equal(completed.response.status, 200);

    await harness.api("/api/session/select-account", {
      method: "POST",
      skipUserHeader: true,
      body: {
        accountId: "internal_guard_admin"
      }
    });
    await harness.api("/api/admin/auth/draft", {
      method: "PUT",
      useSession: true,
      body: {
        draftMode: "internal",
        draftConfig: {
          internal: {
            allowPasswordLogin: true
          }
        }
      }
    });
    await harness.api("/api/admin/auth/activate", {
      method: "POST",
      useSession: true,
      body: {}
    });

    const selected = await harness.request("/api/session/select", {
      method: "POST",
      skipUserHeader: true,
      body: { userId: "local" }
    });
    assert.equal(selected.response.status, 403);
    assert.match(selected.body.error, /None-mode account selection is disabled/);
    assert.equal(fs.existsSync(path.join(harness.dataDir, "local")), false);

    const verifyDb = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      assert.equal(verifyDb.prepare("SELECT 1 FROM users WHERE id = 'local'").get(), undefined);
      assert.equal(verifyDb.prepare("SELECT 1 FROM budgets WHERE id = 'local'").get(), undefined);
    } finally {
      verifyDb.close();
    }
  } finally {
    await harness.cleanup();
  }
});

test("global database protects the last active system administrator and budget owner", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await harness.api("/api/users", {
      method: "POST",
      body: { userId: "protected_admin" }
    });
    await harness.api("/api/users", {
      method: "POST",
      body: { userId: "ordinary_account" }
    });

    const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      assert.throws(
        () => db.prepare(`
          DELETE FROM account_global_roles
          WHERE account_id = 'protected_admin' AND role = 'system_admin'
        `).run(),
        /last_system_admin/
      );
      assert.throws(
        () => db.prepare(`
          UPDATE accounts
          SET status = 'disabled'
          WHERE id = 'protected_admin'
        `).run(),
        /last_system_admin/
      );
      assert.throws(
        () => db.prepare(`
          DELETE FROM budget_memberships
          WHERE budget_id = 'protected_admin' AND account_id = 'protected_admin'
        `).run(),
        /last_budget_owner/
      );
      assert.throws(
        () => db.prepare(`
          UPDATE budget_memberships
          SET role = 'manager'
          WHERE budget_id = 'protected_admin' AND account_id = 'protected_admin'
        `).run(),
        /last_budget_owner/
      );
    } finally {
      db.close();
    }
  } finally {
    await harness.cleanup();
  }
});

test("offline operator command grants an audited system administrator role", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await harness.api("/api/users", {
      method: "POST",
      body: { userId: "initial_admin" }
    });
    await harness.api("/api/users", {
      method: "POST",
      body: { userId: "recovery_target" }
    });

    const result = spawnSync(process.execPath, [
      path.resolve(import.meta.dirname, "../../scripts/operator-admin.mjs"),
      "--data-dir",
      harness.dataDir,
      "--account-id",
      "recovery_target"
    ], {
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);

    const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      assert.ok(db.prepare(`
        SELECT 1
        FROM account_global_roles
        WHERE account_id = 'recovery_target' AND role = 'system_admin'
      `).get());
      assert.ok(db.prepare(`
        SELECT 1
        FROM security_audit_log
        WHERE action = 'operator_grant_system_admin'
          AND target_id = 'recovery_target'
          AND outcome = 'success'
      `).get());
    } finally {
      db.close();
    }
  } finally {
    await harness.cleanup();
  }
});

test("system admins can manage accounts, roles, sessions, and deletion guards", async () => withHarness(async harness => {
  await harness.api("/api/accounts", {
    method: "POST",
    body: {
      userId: "admin_seed",
      displayName: "Admin Seed"
    }
  });

  await harness.api("/api/accounts", {
    method: "POST",
    body: {
      userId: "managed_account",
      displayName: "Managed Account"
    }
  });
  const managedSession = harness.session();

  const forbiddenAdmin = await harness.request("/api/admin/accounts", {
    useSession: true
  });
  assert.equal(forbiddenAdmin.response.status, 403);

  const listed = await harness.api("/api/admin/accounts");
  const managed = listed.accounts.find(account => account.id === "managed_account");
  assert.ok(managed);
  assert.equal(managed.display_name, "Managed Account");
  assert.equal(managed.globalRoles.includes("system_admin"), false);
  assert.equal(managed.activeSessionCount, 1);
  assert.equal(managed.sessions.length, 1);
  assert.equal(Object.hasOwn(managed.sessions[0], "token_hash"), false);

  const renamed = await harness.api("/api/admin/accounts/managed_account", {
    method: "PUT",
    body: { displayName: "Managed Rename" }
  });
  assert.equal(renamed.account.display_name, "Managed Rename");

  const granted = await harness.api("/api/admin/accounts/managed_account/system-admin", {
    method: "PUT",
    body: { enabled: true }
  });
  assert.equal(granted.account.globalRoles.includes("system_admin"), true);

  const revokedSession = await harness.api(`/api/admin/accounts/managed_account/sessions/${listed.accounts.find(account => account.id === "managed_account").sessions[0].id}/revoke`, {
    method: "POST",
    body: {}
  });
  assert.equal(revokedSession.account.activeSessionCount, 0);

  const oldSessionRejected = await harness.request("/api/session", {
    skipUserHeader: true,
    headers: { cookie: managedSession.cookie }
  });
  assert.equal(oldSessionRejected.response.status, 401);

  const revokedAdmin = await harness.api("/api/admin/accounts/managed_account/system-admin", {
    method: "PUT",
    body: { enabled: false }
  });
  assert.equal(revokedAdmin.account.globalRoles.includes("system_admin"), false);

  const disabled = await harness.api("/api/admin/accounts/managed_account", {
    method: "PUT",
    body: { status: "disabled" }
  });
  assert.equal(disabled.account.status, "disabled");

  const enabled = await harness.api("/api/admin/accounts/managed_account", {
    method: "PUT",
    body: { status: "active" }
  });
  assert.equal(enabled.account.status, "active");

  const blockedDelete = await harness.request("/api/admin/accounts/managed_account", {
    method: "DELETE"
  });
  assert.equal(blockedDelete.response.status, 409);

  await harness.api("/api/accounts", {
    method: "POST",
    body: {
      userId: "deletable_account",
      displayName: "Deletable Account"
    }
  });
  const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
  try {
    db.prepare(`
      UPDATE budgets
      SET status = 'deleted',
          deleted_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = 'deletable_account'
    `).run();
  } finally {
    db.close();
  }

  const deleted = await harness.api("/api/admin/accounts/deletable_account", {
    method: "DELETE"
  });
  assert.equal(deleted.account.status, "deleted");

  const auditDb = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
  try {
    assert.ok(auditDb.prepare(`
      SELECT 1
      FROM security_audit_log
      WHERE action = 'admin_account_update'
        AND target_id = 'managed_account'
    `).get());
    assert.ok(auditDb.prepare(`
      SELECT 1
      FROM users
      WHERE id = 'managed_account'
        AND display_name = 'Managed Rename'
    `).get());
  } finally {
    auditDb.close();
  }
}));

test("admin account routes preserve the last active system administrator", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await harness.api("/api/accounts", {
      method: "POST",
      body: { userId: "only_admin", displayName: "Only Admin" }
    });

    const revoke = await harness.request("/api/admin/accounts/only_admin/system-admin", {
      method: "PUT",
      useSession: true,
      body: { enabled: false }
    });
    assert.equal(revoke.response.status, 409);

    const disable = await harness.request("/api/admin/accounts/only_admin", {
      method: "PUT",
      useSession: true,
      body: { status: "disabled" }
    });
    assert.equal(disable.response.status, 409);
  } finally {
    await harness.cleanup();
  }
});

test("admin auth configuration is staged, validated, audited, and safe to activate", async () => withHarness(async harness => {
  await harness.api("/api/accounts", {
    method: "POST",
    body: {
      userId: "auth_admin_seed",
      displayName: "Auth Admin Seed"
    }
  });
  await harness.api("/api/accounts", {
    method: "POST",
    body: {
      userId: "auth_non_admin",
      displayName: "Auth Non Admin"
    }
  });

  const nonAdmin = await harness.request("/api/admin/auth", {
    useSession: true
  });
  assert.equal(nonAdmin.response.status, 403);

  const initial = await harness.api("/api/admin/auth");
  assert.equal(initial.authConfig.activeMode, "none");
  assert.equal(initial.authConfig.draftMode, "none");

  const invalidSecret = await harness.request("/api/admin/auth/draft", {
    method: "PUT",
    body: {
      draftMode: "external",
      draftConfig: {
        external: {
          subjectHeader: "x-auth-request-user",
          clientSecret: "do-not-store"
        }
      }
    }
  });
  assert.equal(invalidSecret.response.status, 400);

  const invalidTimeout = await harness.request("/api/admin/auth/draft", {
    method: "PUT",
    body: {
      sessionIdleMinutes: 600,
      sessionAbsoluteMinutes: 60
    }
  });
  assert.equal(invalidTimeout.response.status, 400);

  const staged = await harness.api("/api/admin/auth/draft", {
    method: "PUT",
    body: {
      draftMode: "external",
      sessionIdleMinutes: 30,
      sessionAbsoluteMinutes: 120,
      draftConfig: {
        external: {
          subjectHeader: "x-auth-request-user",
          emailHeader: "x-auth-request-email",
          displayNameHeader: "x-auth-request-name",
          groupsHeader: "x-auth-request-groups",
          trustedIssuer: "oauth2-proxy",
          provisioningMode: "deny_unknown",
          allowedDomains: ["example.com"],
          adminGroups: ["cashflow-admins"]
        },
        internal: {
          allowPasswordLogin: true
        }
      }
    }
  });
  assert.equal(staged.authConfig.activeMode, "none");
  assert.equal(staged.authConfig.draftMode, "external");
  assert.equal(staged.authConfig.sessionIdleMinutes, 30);
  assert.equal(staged.authConfig.draftConfig.external.subjectHeader, "x-auth-request-user");

  const testedExternal = await harness.api("/api/admin/auth/test", {
    method: "POST",
    body: {}
  });
  assert.equal(testedExternal.ok, false);
  assert.equal(testedExternal.activatable, false);
  assert.ok(testedExternal.checks.some(check => check.code === "external_assertion_secret" && !check.ok));
  assert.ok(testedExternal.checks.some(check => check.code === "external_admin_identity" && !check.ok));

  const blockedActivation = await harness.request("/api/admin/auth/activate", {
    method: "POST",
    body: {}
  });
  assert.equal(blockedActivation.response.status, 409);

  const stagedNone = await harness.api("/api/admin/auth/draft", {
    method: "PUT",
    body: {
      draftMode: "none"
    }
  });
  assert.equal(stagedNone.authConfig.draftMode, "none");

  const testedNone = await harness.api("/api/admin/auth/test", {
    method: "POST",
    body: {}
  });
  assert.equal(testedNone.ok, true);
  assert.equal(testedNone.activatable, true);

  const activated = await harness.api("/api/admin/auth/activate", {
    method: "POST",
    body: {}
  });
  assert.equal(activated.authConfig.activeMode, "none");

  const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
  try {
    assert.ok(db.prepare(`
      SELECT 1
      FROM security_audit_log
      WHERE action = 'admin_auth_draft_update'
    `).get());
    assert.ok(db.prepare(`
      SELECT 1
      FROM security_audit_log
      WHERE action = 'admin_auth_activate'
    `).get());
  } finally {
    db.close();
  }
}));

test("internal authentication uses admin-issued tokens, Argon2 credentials, and session login", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await harness.api("/api/accounts", {
      method: "POST",
      body: {
        userId: "internal_admin",
        displayName: "Internal Admin",
        email: "Admin@Example.COM"
      }
    });

    const tokenResult = await harness.api("/api/admin/accounts/internal_admin/password-reset-token", {
      method: "POST",
      useSession: true,
      body: {
        purpose: "password_setup"
      }
    });
    assert.equal(tokenResult.account.email, "admin@example.com");
    assert.equal(tokenResult.purpose, "password_setup");
    assert.ok(tokenResult.token);

    const password = "correct horse battery staple";
    const completed = await harness.request("/api/auth/internal/password", {
      method: "POST",
      skipUserHeader: true,
      body: {
        token: tokenResult.token,
        password
      }
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.account.hasPasswordCredential, true);

    const reused = await harness.request("/api/auth/internal/password", {
      method: "POST",
      skipUserHeader: true,
      body: {
        token: tokenResult.token,
        password
      }
    });
    assert.equal(reused.response.status, 400);

    const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      const credential = db.prepare(`
        SELECT password_hash
        FROM password_credentials
        WHERE account_id = 'internal_admin'
      `).get();
      assert.match(credential.password_hash, /^\$argon2id\$/);
      assert.equal(credential.password_hash.includes(password), false);
      assert.equal(db.prepare(`
        SELECT status
        FROM password_reset_tokens
        WHERE account_id = 'internal_admin'
      `).get().status, "consumed");
    } finally {
      db.close();
    }

    await harness.api("/api/session/select-account", {
      method: "POST",
      skipUserHeader: true,
      body: {
        accountId: "internal_admin"
      }
    });
    const noneSessionBeforeInternal = harness.session();
    await harness.api("/api/admin/auth/draft", {
      method: "PUT",
      useSession: true,
      body: {
        draftMode: "internal",
        draftConfig: {
          internal: {
            allowPasswordLogin: true
          }
        }
      }
    });

    const tested = await harness.api("/api/admin/auth/test", {
      method: "POST",
      useSession: true,
      body: {}
    });
    assert.equal(tested.ok, true);
    assert.equal(tested.activatable, true);
    assert.ok(tested.checks.some(check => check.code === "internal_admin_credential" && check.ok));

    const activated = await harness.api("/api/admin/auth/activate", {
      method: "POST",
      useSession: true,
      body: {}
    });
    assert.equal(activated.authConfig.activeMode, "internal");

    const revokedNoneSession = await harness.request("/api/session", {
      skipUserHeader: true,
      headers: {
        cookie: noneSessionBeforeInternal.cookie
      }
    });
    assert.equal(revokedNoneSession.response.status, 401);

    const publicAccounts = await harness.request("/api/accounts", {
      skipUserHeader: true
    });
    assert.equal(publicAccounts.response.status, 401);

    const legacySession = await harness.request("/api/session", {
      skipUserHeader: true,
      headers: {
        "x-cashflow-user-id": "internal_admin"
      }
    });
    assert.equal(legacySession.response.status, 401);

    const openCreate = await harness.request("/api/accounts", {
      method: "POST",
      skipUserHeader: true,
      body: {
        userId: "should_not_create",
        displayName: "Should Not Create"
      }
    });
    assert.equal(openCreate.response.status, 403);

    const wrongLogin = await harness.request("/api/auth/internal/login", {
      method: "POST",
      skipUserHeader: true,
      body: {
        email: "admin@example.com",
        password: "wrong horse battery staple"
      }
    });
    assert.equal(wrongLogin.response.status, 401);
    assert.equal(wrongLogin.body.error, "Invalid email or password");

    const wrongEmail = await harness.request("/api/auth/internal/login", {
      method: "POST",
      skipUserHeader: true,
      body: {
        email: "missing@example.com",
        password
      }
    });
    assert.equal(wrongEmail.response.status, 401);
    assert.equal(wrongEmail.body.error, wrongLogin.body.error);

    const login = await harness.request("/api/auth/internal/login", {
      method: "POST",
      skipUserHeader: true,
      headers: {
        cookie: "cashflow_session=fixed-attacker-token"
      },
      body: {
        email: "ADMIN@example.com",
        password
      }
    });
    assert.equal(login.response.status, 200);
    assert.equal(login.body.session.accountId, "internal_admin");
    assert.equal(login.body.session.authMode, "internal");
    assert.ok(login.body.csrfToken);
    const loginCookie = String(login.response.headers.get("set-cookie") || "").split(";")[0];
    assert.match(loginCookie, /^cashflow_session=/);
    assert.notEqual(loginCookie, "cashflow_session=fixed-attacker-token");

    const authenticatedAccounts = await harness.request("/api/accounts", {
      useSession: true
    });
    assert.equal(authenticatedAccounts.response.status, 200);
    assert.ok(authenticatedAccounts.body.accounts.some(account => account.id === "internal_admin"));

    const resetToken = await harness.api("/api/admin/accounts/internal_admin/password-reset-token", {
      method: "POST",
      useSession: true,
      body: {
        purpose: "password_reset"
      }
    });
    assert.ok(resetToken.token);
    const reset = await harness.request("/api/auth/internal/password", {
      method: "POST",
      skipUserHeader: true,
      body: {
        token: resetToken.token,
        password: "updated correct horse battery staple"
      }
    });
    assert.equal(reset.response.status, 200);
    const resetRevokedSession = await harness.request("/api/session", {
      skipUserHeader: true,
      headers: {
        cookie: loginCookie
      }
    });
    assert.equal(resetRevokedSession.response.status, 401);

    const relogin = await harness.request("/api/auth/internal/login", {
      method: "POST",
      skipUserHeader: true,
      body: {
        email: "admin@example.com",
        password: "updated correct horse battery staple"
      }
    });
    assert.equal(relogin.response.status, 200);
    assert.equal(relogin.body.session.accountId, "internal_admin");

    const invite = await harness.request("/api/budgets/internal_admin/invitations", {
      method: "POST",
      useSession: true,
      body: {
        email: "New.Member@Example.COM",
        role: "viewer"
      }
    });
    assert.equal(invite.response.status, 200);
    assert.ok(invite.body.invitation.token);

    const registered = await harness.request("/api/auth/internal/register", {
      method: "POST",
      skipUserHeader: true,
      body: {
        invitationToken: invite.body.invitation.token,
        email: "new.member@example.com",
        displayName: "New Member",
        password: "another correct horse passphrase"
      }
    });
    assert.equal(registered.response.status, 200);
    assert.match(registered.body.account.id, /^account_/);
    assert.equal(registered.body.account.email, "new.member@example.com");
    assert.equal(registered.body.invitation.membership.role, "viewer");
    assert.equal(registered.body.session.accountId, registered.body.account.id);
    assert.equal(registered.body.session.budgetId, "internal_admin");
    assert.equal(registered.body.session.authMode, "internal");

    const replayInvite = await harness.request("/api/auth/internal/register", {
      method: "POST",
      skipUserHeader: true,
      body: {
        invitationToken: invite.body.invitation.token,
        email: "new.member@example.com",
        displayName: "Replay",
        password: "another correct horse passphrase"
      }
    });
    assert.equal(replayInvite.response.status, 409);

    const viewerAdmin = await harness.request("/api/admin/accounts", {
      useSession: true
    });
    assert.equal(viewerAdmin.response.status, 403);

    const registerDb = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      const stored = registerDb.prepare(`
        SELECT a.email, pc.password_hash, bi.status
        FROM accounts a
        JOIN password_credentials pc ON pc.account_id = a.id
        JOIN budget_invitations bi ON bi.target_account_id = a.id
        WHERE a.email = 'new.member@example.com'
      `).get();
      assert.equal(stored.email, "new.member@example.com");
      assert.match(stored.password_hash, /^\$argon2id\$/);
      assert.equal(stored.password_hash.includes("another correct horse passphrase"), false);
      assert.equal(stored.status, "accepted");
    } finally {
      registerDb.close();
    }
  } finally {
    await harness.cleanup();
  }
});

test("external authentication uses trusted proxy headers and explicit identity links", async () => {
  const oldSecret = process.env.CASHFLOW_TEST_EXTERNAL_SECRET;
  process.env.CASHFLOW_TEST_EXTERNAL_SECRET = "shared-external-secret";

  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await harness.api("/api/accounts", {
      method: "POST",
      body: {
        userId: "external_admin",
        displayName: "External Admin",
        email: "external.admin@example.com"
      }
    });

    await harness.api("/api/admin/auth/draft", {
      method: "PUT",
      useSession: true,
      body: {
        draftMode: "external",
        draftConfig: {
          external: {
            assertionSecretEnv: "CASHFLOW_TEST_EXTERNAL_SECRET",
            assertionSecretHeader: "x-cashflow-auth-secret",
            subjectHeader: "x-auth-request-user",
            emailHeader: "x-auth-request-email",
            displayNameHeader: "x-auth-request-name",
            groupsHeader: "x-auth-request-groups",
            trustedIssuer: "test-proxy",
            provisioningMode: "allow_invited",
            allowedDomains: ["example.com"],
            adminGroups: ["cashflow-admins"]
          }
        }
      }
    });

    const linked = await harness.api("/api/admin/accounts/external_admin/external-identity", {
      method: "PUT",
      useSession: true,
      body: {
        subject: "proxy-subject-admin",
        email: "external.admin@example.com"
      }
    });
    assert.equal(linked.account.identityCount, 1);
    assert.equal(linked.account.identities[0].subject, "proxy-subject-admin");

    const tested = await harness.api("/api/admin/auth/test", {
      method: "POST",
      useSession: true,
      body: {}
    });
    assert.equal(tested.ok, true);
    assert.equal(tested.activatable, true);
    assert.ok(tested.checks.some(check => check.code === "external_assertion_secret" && check.ok));
    assert.ok(tested.checks.some(check => check.code === "external_admin_identity" && check.ok));

    const activated = await harness.api("/api/admin/auth/activate", {
      method: "POST",
      useSession: true,
      body: {}
    });
    assert.equal(activated.authConfig.activeMode, "external");

    const spoofed = await harness.request("/api/auth/external/login", {
      method: "POST",
      skipUserHeader: true,
      body: {},
      headers: {
        "x-auth-request-user": "proxy-subject-admin"
      }
    });
    assert.equal(spoofed.response.status, 401);

    const loggedIn = await harness.request("/api/auth/external/login", {
      method: "POST",
      skipUserHeader: true,
      body: {},
      headers: {
        "x-cashflow-auth-secret": "shared-external-secret",
        "x-auth-request-user": "proxy-subject-admin",
        "x-auth-request-email": "external.admin@example.com",
        "x-auth-request-name": "External Admin",
        "x-auth-request-groups": "cashflow-admins"
      }
    });
    assert.equal(loggedIn.response.status, 200);
    assert.equal(loggedIn.body.session.accountId, "external_admin");
    assert.equal(loggedIn.body.session.authMode, "external");

    const invited = await harness.request("/api/budgets/external_admin/invitations", {
      method: "POST",
      useSession: true,
      body: {
        email: "external.member@example.com",
        role: "viewer"
      }
    });
    assert.equal(invited.response.status, 200);

    const provisioned = await harness.request("/api/auth/external/login", {
      method: "POST",
      skipUserHeader: true,
      body: {},
      headers: {
        "x-cashflow-auth-secret": "shared-external-secret",
        "x-auth-request-user": "proxy-subject-member",
        "x-auth-request-email": "external.member@example.com",
        "x-auth-request-name": "External Member"
      }
    });
    assert.equal(provisioned.response.status, 200);
    assert.match(provisioned.body.session.accountId, /^account_/);
    assert.equal(provisioned.body.session.budgetId, "");
    assert.ok(provisioned.body.budgets.some(budget => budget.id === "external_admin" && budget.role === "viewer"));

    const rejectedDomain = await harness.request("/api/auth/external/login", {
      method: "POST",
      skipUserHeader: true,
      body: {},
      headers: {
        "x-cashflow-auth-secret": "shared-external-secret",
        "x-auth-request-user": "proxy-subject-bad-domain",
        "x-auth-request-email": "bad@example.net",
        "x-auth-request-name": "Bad Domain"
      }
    });
    assert.equal(rejectedDomain.response.status, 403);
  } finally {
    if (oldSecret === undefined) {
      delete process.env.CASHFLOW_TEST_EXTERNAL_SECRET;
    } else {
      process.env.CASHFLOW_TEST_EXTERNAL_SECRET = oldSecret;
    }
    await harness.cleanup();
  }
});

test("internal authentication supports configured provider login, explicit linking, and callback replay protection", async () => {
  const oldSecret = process.env.CASHFLOW_TEST_GOOGLE_SECRET;
  process.env.CASHFLOW_TEST_GOOGLE_SECRET = "google-test-secret";

  const profilesByCode = new Map([
    ["admin-code", {
      sub: "google-admin-sub",
      email: "provider.admin@example.com",
      email_verified: true,
      name: "Provider Admin"
    }],
    ["member-code", {
      sub: "google-member-sub",
      email: "provider.member@example.com",
      email_verified: true,
      name: "Provider Member"
    }],
    ["unknown-code", {
      sub: "google-unknown-sub",
      email: "unknown.provider@example.com",
      email_verified: true,
      name: "Provider Unknown"
    }]
  ]);

  const harness = await createCashflowTestHarness({
    initializeUser: false,
    authProviderHook: async ({ action, callbackUrl, codeChallenge, provider, state }) => {
      if (action === "authorization_url") {
        const url = new URL("https://accounts.example.test/authorize");
        url.searchParams.set("provider", provider.id);
        url.searchParams.set("state", state);
        url.searchParams.set("code_challenge", codeChallenge);
        return { authorizationUrl: url.href };
      }
      if (action === "callback") {
        const code = new URL(callbackUrl).searchParams.get("code");
        return { profile: profilesByCode.get(code) || profilesByCode.get("unknown-code") };
      }
      return null;
    }
  });

  try {
    await harness.api("/api/accounts", {
      method: "POST",
      body: {
        userId: "provider_admin",
        displayName: "Provider Admin",
        email: "provider.admin@example.com"
      }
    });
    const adminToken = await harness.api("/api/admin/accounts/provider_admin/password-reset-token", {
      method: "POST",
      useSession: true,
      body: { purpose: "password_setup" }
    });
    await harness.request("/api/auth/internal/password", {
      method: "POST",
      skipUserHeader: true,
      body: {
        token: adminToken.token,
        password: "provider admin correct horse passphrase"
      }
    });

    await harness.api("/api/accounts", {
      method: "POST",
      body: {
        userId: "provider_member",
        displayName: "Provider Member",
        email: "provider.member@example.com"
      }
    });
    await harness.api("/api/session/select-account", {
      method: "POST",
      skipUserHeader: true,
      body: { accountId: "provider_admin" }
    });
    const memberToken = await harness.api("/api/admin/accounts/provider_member/password-reset-token", {
      method: "POST",
      useSession: true,
      body: { purpose: "password_setup" }
    });
    await harness.request("/api/auth/internal/password", {
      method: "POST",
      skipUserHeader: true,
      body: {
        token: memberToken.token,
        password: "provider member correct horse passphrase"
      }
    });

    const redirectUri = `${harness.baseUrl()}/api/auth/providers/google/callback`;
    const inlineSecret = await harness.request("/api/admin/auth/providers/google", {
      method: "PUT",
      useSession: true,
      body: {
        kind: "google",
        clientSecret: "must-not-store"
      }
    });
    assert.equal(inlineSecret.response.status, 400);

    const provider = await harness.api("/api/admin/auth/providers/google", {
      method: "PUT",
      useSession: true,
      body: {
        kind: "google",
        displayName: "Google",
        enabled: true,
        issuer: "https://accounts.google.com",
        clientId: "google-client-id",
        secretEnv: "CASHFLOW_TEST_GOOGLE_SECRET",
        redirectUri
      }
    });
    assert.equal(provider.provider.id, "google");
    assert.equal(provider.provider.enabled, true);
    assert.equal(provider.provider.secretConfigured, true);
    assert.equal(Object.hasOwn(provider.provider, "secret_ref"), false);

    const linkedAdmin = await harness.api("/api/admin/accounts/provider_admin/provider-identities/google", {
      method: "PUT",
      useSession: true,
      body: {
        subject: "google-admin-sub",
        email: "provider.admin@example.com",
        emailVerified: true
      }
    });
    assert.ok(linkedAdmin.account.identities.some(identity =>
      identity.provider_id === "google" && identity.subject === "google-admin-sub"
    ));

    await harness.api("/api/admin/auth/draft", {
      method: "PUT",
      useSession: true,
      body: {
        draftMode: "internal",
        draftConfig: {
          internal: {
            allowPasswordLogin: true
          }
        }
      }
    });
    const activated = await harness.api("/api/admin/auth/activate", {
      method: "POST",
      useSession: true,
      body: {}
    });
    assert.equal(activated.authConfig.activeMode, "internal");

    const authConfig = await harness.request("/api/auth/config", {
      skipUserHeader: true
    });
    assert.equal(authConfig.response.status, 200);
    assert.ok(authConfig.body.auth.internal.providers.some(item =>
      item.id === "google" && item.displayName === "Google"
    ));

    const startAdmin = await harness.request("/api/auth/providers/google/login/start", {
      method: "POST",
      skipUserHeader: true,
      body: {}
    });
    assert.equal(startAdmin.response.status, 200);
    const adminState = new URL(startAdmin.body.authorizationUrl).searchParams.get("state");
    assert.ok(adminState);

    const adminCallback = await harness.request(`/api/auth/providers/google/callback?code=admin-code&state=${encodeURIComponent(adminState)}`, {
      skipUserHeader: true,
      redirect: "manual"
    });
    assert.equal(adminCallback.response.status, 302);
    assert.ok(harness.session().cookie);

    const adminSession = await harness.request("/api/session", {
      useSession: true
    });
    assert.equal(adminSession.response.status, 200);
    assert.equal(adminSession.body.session.accountId, "provider_admin");
    assert.equal(adminSession.body.session.authMode, "internal");

    const replay = await harness.request(`/api/auth/providers/google/callback?code=admin-code&state=${encodeURIComponent(adminState)}`, {
      skipUserHeader: true,
      redirect: "manual"
    });
    assert.equal(replay.response.status, 401);

    const unknownStart = await harness.request("/api/auth/providers/google/login/start", {
      method: "POST",
      skipUserHeader: true,
      body: {}
    });
    const unknownState = new URL(unknownStart.body.authorizationUrl).searchParams.get("state");
    const unknownCallback = await harness.request(`/api/auth/providers/google/callback?code=unknown-code&state=${encodeURIComponent(unknownState)}`, {
      skipUserHeader: true,
      redirect: "manual"
    });
    assert.equal(unknownCallback.response.status, 401);

    const memberLogin = await harness.request("/api/auth/internal/login", {
      method: "POST",
      skipUserHeader: true,
      body: {
        email: "provider.member@example.com",
        password: "provider member correct horse passphrase"
      }
    });
    assert.equal(memberLogin.response.status, 200);
    const linkStart = await harness.request("/api/auth/providers/google/link/start", {
      method: "POST",
      useSession: true,
      body: {}
    });
    assert.equal(linkStart.response.status, 200);
    const memberState = new URL(linkStart.body.authorizationUrl).searchParams.get("state");
    const memberCallback = await harness.request(`/api/auth/providers/google/callback?code=member-code&state=${encodeURIComponent(memberState)}`, {
      skipUserHeader: true,
      redirect: "manual"
    });
    assert.equal(memberCallback.response.status, 302);

    const memberProviderLoginStart = await harness.request("/api/auth/providers/google/login/start", {
      method: "POST",
      skipUserHeader: true,
      body: {}
    });
    const memberLoginState = new URL(memberProviderLoginStart.body.authorizationUrl).searchParams.get("state");
    const memberProviderCallback = await harness.request(`/api/auth/providers/google/callback?code=member-code&state=${encodeURIComponent(memberLoginState)}`, {
      skipUserHeader: true,
      redirect: "manual"
    });
    assert.equal(memberProviderCallback.response.status, 302);
    const memberSession = await harness.request("/api/session", {
      useSession: true
    });
    assert.equal(memberSession.body.session.accountId, "provider_member");

    const adminAgainStart = await harness.request("/api/auth/providers/google/login/start", {
      method: "POST",
      skipUserHeader: true,
      body: {}
    });
    const adminAgainState = new URL(adminAgainStart.body.authorizationUrl).searchParams.get("state");
    const adminAgainCallback = await harness.request(`/api/auth/providers/google/callback?code=admin-code&state=${encodeURIComponent(adminAgainState)}`, {
      skipUserHeader: true,
      redirect: "manual"
    });
    assert.equal(adminAgainCallback.response.status, 302);
    const adminAgainSession = await harness.request("/api/session", {
      useSession: true
    });
    assert.equal(adminAgainSession.body.session.accountId, "provider_admin");

    const duplicateSubject = await harness.request("/api/admin/accounts/provider_member/provider-identities/google", {
      method: "PUT",
      useSession: true,
      body: {
        subject: "google-admin-sub",
        email: "provider.member@example.com",
        emailVerified: true
      }
    });
    assert.equal(duplicateSubject.response.status, 409);

    await harness.api("/api/admin/accounts/provider_member", {
      method: "PUT",
      useSession: true,
      body: { status: "disabled" }
    });
    const disabledLoginStart = await harness.request("/api/auth/providers/google/login/start", {
      method: "POST",
      skipUserHeader: true,
      body: {}
    });
    const disabledLoginState = new URL(disabledLoginStart.body.authorizationUrl).searchParams.get("state");
    const disabledLogin = await harness.request(`/api/auth/providers/google/callback?code=member-code&state=${encodeURIComponent(disabledLoginState)}`, {
      skipUserHeader: true,
      redirect: "manual"
    });
    assert.equal(disabledLogin.response.status, 401);

    const disabledProvider = await harness.api("/api/admin/auth/providers/google", {
      method: "PUT",
      useSession: true,
      body: {
        enabled: false
      }
    });
    assert.equal(disabledProvider.provider.enabled, false);
    const disabledProviderStart = await harness.request("/api/auth/providers/google/login/start", {
      method: "POST",
      skipUserHeader: true,
      body: {}
    });
    assert.equal(disabledProviderStart.response.status, 403);

    const beforeDeleteDb = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      assert.equal(beforeDeleteDb.prepare(`
        SELECT COUNT(*) AS count
        FROM auth_oauth_states
        WHERE status = 'consumed'
      `).get().count, 4);
    } finally {
      beforeDeleteDb.close();
    }

    const deletedProvider = await harness.request("/api/admin/auth/providers/google", {
      method: "DELETE",
      useSession: true,
      body: {}
    });
    assert.equal(deletedProvider.response.status, 200);
    const deletedProviderStart = await harness.request("/api/auth/providers/google/login/start", {
      method: "POST",
      skipUserHeader: true,
      body: {}
    });
    assert.equal(deletedProviderStart.response.status, 404);

    const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      assert.ok(db.prepare(`
        SELECT 1
        FROM auth_identities
        WHERE provider_id = 'google'
          AND subject = 'google-member-sub'
          AND account_id = 'provider_member'
      `).get());
    } finally {
      db.close();
    }
  } finally {
    if (oldSecret === undefined) {
      delete process.env.CASHFLOW_TEST_GOOGLE_SECRET;
    } else {
      process.env.CASHFLOW_TEST_GOOGLE_SECRET = oldSecret;
    }
    await harness.cleanup();
  }
});

test("credential hashes, session hashes, reset tokens, and provider secrets stay out of APIs, exports, sample data, and logs", async () => {
  const oldSecret = process.env.CASHFLOW_TEST_PROVIDER_SECRET;
  process.env.CASHFLOW_TEST_PROVIDER_SECRET = "provider-secret-value-that-must-not-leak";
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await harness.api("/api/accounts", {
      method: "POST",
      body: {
        userId: "sensitive_admin",
        displayName: "Sensitive Admin",
        email: "sensitive.admin@example.com"
      }
    });

    const setupToken = await harness.api("/api/admin/accounts/sensitive_admin/password-reset-token", {
      method: "POST",
      useSession: true,
      body: { purpose: "password_setup" }
    });
    const password = "sensitive correct horse passphrase";
    await harness.request("/api/auth/internal/password", {
      method: "POST",
      skipUserHeader: true,
      body: {
        token: setupToken.token,
        password
      }
    });
    await harness.api("/api/session/select-account", {
      method: "POST",
      skipUserHeader: true,
      body: {
        accountId: "sensitive_admin"
      }
    });

    await harness.api("/api/admin/auth/providers/google", {
      method: "PUT",
      useSession: true,
      body: {
        kind: "google",
        displayName: "Google",
        enabled: true,
        issuer: "https://accounts.google.com",
        clientId: "sensitive-client-id",
        secretEnv: "CASHFLOW_TEST_PROVIDER_SECRET",
        redirectUri: `${harness.baseUrl()}/api/auth/providers/google/callback`
      }
    });

    const resetToken = await harness.api("/api/admin/accounts/sensitive_admin/password-reset-token", {
      method: "POST",
      useSession: true,
      body: { purpose: "password_reset" }
    });

    const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    let storedSensitiveValues;
    try {
      storedSensitiveValues = [
        db.prepare("SELECT password_hash FROM password_credentials WHERE account_id = 'sensitive_admin'").get()?.password_hash,
        db.prepare("SELECT token_hash FROM password_reset_tokens WHERE account_id = 'sensitive_admin' ORDER BY created_at DESC LIMIT 1").get()?.token_hash,
        db.prepare("SELECT token_hash FROM auth_sessions WHERE account_id = 'sensitive_admin' ORDER BY created_at DESC LIMIT 1").get()?.token_hash,
        db.prepare("SELECT csrf_token_hash FROM auth_sessions WHERE account_id = 'sensitive_admin' ORDER BY created_at DESC LIMIT 1").get()?.csrf_token_hash,
        db.prepare("SELECT secret_ref FROM auth_providers WHERE id = 'google'").get()?.secret_ref
      ].filter(Boolean);
      assert.ok(storedSensitiveValues.length >= 5);
    } finally {
      db.close();
    }

    const payloads = [];
    payloads.push(await harness.api("/api/session", { useSession: true }));
    payloads.push(await harness.api("/api/admin/accounts", { useSession: true }));
    payloads.push(await harness.api("/api/admin/auth", { useSession: true }));
    payloads.push(await harness.api("/api/admin/auth/providers", { useSession: true }));
    payloads.push((await harness.request("/api/export/full", { useSession: true })).body);
    payloads.push((await harness.request("/api/budgets/sensitive_admin/export", { useSession: true })).body);
    payloads.push((await harness.request("/api/export/sample", { skipUserHeader: true })).body);

    const logContent = fs.existsSync(harness.logsDir)
      ? fs.readdirSync(harness.logsDir)
          .map(fileName => fs.readFileSync(path.join(harness.logsDir, fileName), "utf8"))
          .join("\n")
      : "";
    const serialized = `${JSON.stringify(payloads)}\n${logContent}`;
    const sensitiveValues = [
      password,
      setupToken.token,
      resetToken.token,
      "provider-secret-value-that-must-not-leak",
      ...storedSensitiveValues
    ];
    for (const value of sensitiveValues) {
      assert.equal(serialized.includes(value), false, `sensitive value leaked: ${value.slice(0, 16)}`);
    }
  } finally {
    if (oldSecret === undefined) {
      delete process.env.CASHFLOW_TEST_PROVIDER_SECRET;
    } else {
      process.env.CASHFLOW_TEST_PROVIDER_SECRET = oldSecret;
    }
    await harness.cleanup();
  }
});

test("admin global options apply to newly created users", async () => withHarness(async harness => {
  const options = await harness.api("/api/admin/options", {
    method: "PUT",
    body: {
      ledger_currency: "USD",
      locale: "pl",
      timezone: "UTC",
      holiday_country: "DE",
      future_periods: 5,
      fx_provider: "manual",
      fx_buffer_percent: 2
    }
  });

  assert.equal(options.options.ledger_currency, "USD");
  assert.equal(options.options.locale, "pl");

  await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "global_defaults_user",
      displayName: "Defaults"
    }
  });

  const snapshot = await harness.api("/api", {
    useSession: true,
    headers: {
      "x-cashflow-user-id": "global_defaults_user"
    }
  });

  assert.equal(snapshot.setup_required, true);
  assert.equal(snapshot.settings.ledger_currency, "USD");
  assert.equal(snapshot.settings.locale, "pl");
  assert.equal(snapshot.settings.timezone, "UTC");
  assert.equal(snapshot.settings.holiday_country, "DE");
  assert.equal(snapshot.settings.future_periods, 5);
  assert.equal(snapshot.settings.fx_provider, "manual");
  assert.equal(snapshot.settings.fx_buffer_percent, 2);
}));

test("admin global options reject malformed values without changing defaults", async () => withHarness(async harness => {
  const before = await harness.api("/api/admin/options");
  const invalid = [
    { future_periods: "abc" },
    { future_periods: 1.5 },
    { fx_buffer_percent: -1 },
    { fx_provider: "unknown" },
    { timezone: "Not/A_Timezone" },
    { unsupported_option: true }
  ];

  for (const body of invalid) {
    const result = await harness.request("/api/admin/options", { method: "PUT", body });
    assert.equal(result.response.status, 400, JSON.stringify(body));
  }

  const after = await harness.api("/api/admin/options");
  assert.deepEqual(after.options, before.options);
}));

test("first-run setup marks setup complete and creates opening balance plus recurring income", async () => withHarness(async harness => {
  await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "setup_flow_user"
    }
  });

  const before = await harness.api("/api", {
    useSession: true,
    headers: {
      "x-cashflow-user-id": "setup_flow_user"
    }
  });

  assert.equal(before.setup_required, true);

  const after = await harness.api("/api/setup", {
    method: "POST",
    useSession: true,
    headers: {
      "x-cashflow-user-id": "setup_flow_user"
    },
    body: {
      ledger_currency: "EUR",
      locale: "en",
      timezone: "Europe/London",
      holiday_country: "DE",
      future_periods: 7,
      opening_balance: "123,456",
      income_enabled: 1,
      income_name: "Salary",
      income_amount: "2500,555",
      income_anchor_day: 25
    }
  });

  assert.equal(after.setup_required, false);
  assert.equal(after.today, "2026-05-20");
  assert.equal(after.settings.setup_completed, 1);
  assert.equal(after.settings.ledger_currency, "EUR");
  assert.equal(after.settings.holiday_country, "DE");
  assert.equal(after.recurringIncomes.length, 1);
  assert.equal(after.recurringIncomes[0].name, "Salary");
  assert.equal(after.recurringIncomes[0].currency, "EUR");
  assert.equal(after.recurringIncomes[0].amount, 2500.56);
  assert.equal(after.recurringIncomes[0].period_setting, 1);
  assert.equal(after.recurringIncomes[0].anchor_holiday_country, "DE");
  assert.equal(after.pendingTransactions.length, 1);
  assert.equal(after.pendingTransactions[0].name, "Opening balance");
  assert.equal(after.pendingTransactions[0].type, "income");
  assert.equal(after.pendingTransactions[0].amount, 123.46);
  assert.equal(after.pendingTransactions[0].ledger_amount, 123.46);
  assert.equal(after.pendingTransactions[0].currency, "EUR");
  assert.equal(after.pendingTransactions[0].ledger_currency, "EUR");
  assert.equal(after.pendingTransactions[0].fx_rate, 1);
  assert.equal(after.pendingTransactions[0].buffered_fx_rate, 1);
}));

test("first-run setup rejects negative opening balances without changing profile state", async () => withHarness(async harness => {
  await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "negative_setup_user"
    }
  });

  const result = await harness.request("/api/setup", {
    method: "POST",
    useSession: true,
    headers: {
      "x-cashflow-user-id": "negative_setup_user"
    },
    body: {
      ledger_currency: "PLN",
      locale: "en",
      timezone: "UTC",
      holiday_country: "PL",
      future_periods: 4,
      opening_balance: -25
    }
  });

  assert.equal(result.response.status, 400);
  assert.ok(result.body.details.some(detail =>
    detail.field === "opening_balance" && detail.reason === "must_be_non_negative"
  ));

  const snapshot = await harness.api("/api", {
    useSession: true,
    headers: {
      "x-cashflow-user-id": "negative_setup_user"
    }
  });
  assert.equal(snapshot.setup_required, true);
  assert.equal(snapshot.settings.setup_completed, 0);
  assert.equal(snapshot.pendingTransactions.length, 0);
  assert.equal(snapshot.recurringIncomes.length, 0);
}));

test("first-run setup accepts a zero opening balance without creating an opening row", async () => withHarness(async harness => {
  await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "zero_setup_user"
    }
  });

  const result = await harness.api("/api/setup", {
    method: "POST",
    useSession: true,
    headers: {
      "x-cashflow-user-id": "zero_setup_user"
    },
    body: {
      ledger_currency: "PLN",
      locale: "en",
      timezone: "UTC",
      holiday_country: "PL",
      future_periods: 4,
      opening_balance: 0
    }
  });

  assert.equal(result.setup_required, false);
  assert.equal(result.settings.setup_completed, 1);
  assert.equal(result.pendingTransactions.length, 0);
}));

test("first-run setup rejects malformed numeric and boolean values before writes", async () => withHarness(async harness => {
  await harness.api("/api/users", {
    method: "POST",
    body: { userId: "strict_setup_user" }
  });

  const invalid = [
    { future_periods: "abc" },
    { income_enabled: "yes" },
    { income_amount: -1 },
    { income_anchor_day: 1.5 },
    { opening_balance: "not-a-number" }
  ];

  for (const extra of invalid) {
    const result = await harness.request("/api/setup", {
      method: "POST",
      useSession: true,
      headers: { "x-cashflow-user-id": "strict_setup_user" },
      body: {
        ledger_currency: "PLN",
        locale: "en",
        timezone: "UTC",
        holiday_country: "PL",
        ...extra
      }
    });
    assert.equal(result.response.status, 400, JSON.stringify(extra));
  }

  const snapshot = await harness.api("/api", {
    useSession: true,
    headers: { "x-cashflow-user-id": "strict_setup_user" }
  });
  assert.equal(snapshot.setup_required, true);
  assert.equal(snapshot.pendingTransactions.length, 0);
  assert.equal(snapshot.recurringIncomes.length, 0);
}));

test("confirmed-only users are treated as already set up", async () => withHarness(async harness => {
  const userId = "confirmed_only_user";
  const userDir = path.join(harness.dataDir, userId);
  fs.mkdirSync(userDir, { recursive: true });

  const ledgerDb = new Database(ledgerDbPath(harness.dataDir, userId, "2026"));
  try {
    initializeLedgerSchema(ledgerDb);
    ledgerDb.prepare(`
      INSERT INTO confirmed_transactions (
        id, name, currency, amount, type, date, confirmed_date,
        fx_rate, buffered_fx_rate, ledger_currency, running_balance_pln,
        ledger_amount, created_at, updated_at
      ) VALUES (
        'confirmed-1', 'Historical income', 'PLN', 10, 'income', '2026-01-01', '2026-01-01',
        1, 1, 'PLN', 10, 10, datetime('now'), datetime('now')
      )
    `).run();
  } finally {
    ledgerDb.close();
  }

  const snapshot = await harness.api("/api", {
    headers: {
      "x-cashflow-user-id": userId
    }
  });

  assert.equal(snapshot.setup_required, false);
  assert.equal(snapshot.settings.setup_completed, 1);
  assert.equal(snapshot.confirmedTransactions.length, 1);
}));
