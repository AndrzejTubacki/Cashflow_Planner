import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

function withSession(session, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  return {
    ...options,
    skipUserHeader: true,
    headers: {
      cookie: session.cookie,
      ...(!["GET", "HEAD", "OPTIONS"].includes(method)
        ? { "x-cashflow-csrf-token": session.csrfToken }
        : {}),
      ...(options.headers || {})
    }
  };
}

function withBudgetSession(session, budgetId, options = {}) {
  return withSession(session, {
    ...options,
    headers: {
      "x-cashflow-budget-id": budgetId,
      ...(options.headers || {})
    }
  });
}

async function selectAccountSession(harness, accountId) {
  const selected = await harness.request("/api/session/select-account", {
    method: "POST",
    skipUserHeader: true,
    body: { accountId }
  });
  assert.equal(selected.response.status, 200);
  const cookie = String(selected.response.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^cashflow_session=/);
  assert.ok(selected.body?.csrfToken);
  return {
    cookie,
    csrfToken: selected.body.csrfToken
  };
}

async function createAccount(harness, userId, displayName = userId) {
  const created = await harness.request("/api/accounts", {
    method: "POST",
    skipUserHeader: true,
    body: { userId, displayName }
  });
  assert.equal(created.response.status, 200);
  return created.body;
}

test("budget management keeps storage keys immutable and supports archive, restore, and recoverable purge", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await harness.api("/api/accounts", {
      method: "POST",
      body: {
        userId: "budget_owner",
        displayName: "Budget Owner"
      }
    });
    const ownerSession = harness.session();

    const created = await harness.request("/api/budgets", withSession(ownerSession, {
      method: "POST",
      body: { displayName: "Second Budget" }
    }));
    assert.equal(created.response.status, 200);
    const budgetId = created.body.budget.id;
    assert.match(budgetId, /^budget_/);
    assert.equal(fs.existsSync(path.join(harness.dataDir, budgetId, "planning.sqlite")), true);

    const renamed = await harness.request(`/api/budgets/${budgetId}`, withSession(ownerSession, {
      method: "PUT",
      body: { displayName: "Renamed Budget" }
    }));
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.body.budget.display_name, "Renamed Budget");

    const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      const stored = db.prepare("SELECT storage_key, display_name FROM budgets WHERE id = ?").get(budgetId);
    assert.deepEqual(stored, {
      storage_key: budgetId,
      display_name: "Renamed Budget"
    });
    } finally {
      db.close();
    }

    const exported = await harness.request(`/api/budgets/${budgetId}/export`, withSession(ownerSession));
    assert.equal(exported.response.status, 200);
    assert.equal(exported.body.format, "cashflow-full-export");
    assert.match(exported.response.headers.get("content-disposition"), /full-export\.json/);

    const selected = await harness.request(`/api/budgets/${budgetId}/select`, withSession(ownerSession, {
      method: "POST",
      body: {}
    }));
    assert.equal(selected.response.status, 200);
    assert.equal(selected.body.session.budgetId, budgetId);

    const archived = await harness.request(`/api/budgets/${budgetId}/archive`, withSession(ownerSession, {
      method: "POST",
      body: {}
    }));
    assert.equal(archived.response.status, 200);
    assert.equal(archived.body.budget.status, "archived");

    const restored = await harness.request(`/api/budgets/${budgetId}/restore`, withSession(ownerSession, {
      method: "POST",
      body: {}
    }));
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.budget.status, "active");

    await harness.request(`/api/budgets/${budgetId}/archive`, withSession(ownerSession, {
      method: "POST",
      body: {}
    }));
    const purged = await harness.request(`/api/budgets/${budgetId}`, withSession(ownerSession, {
      method: "DELETE",
      body: {}
    }));
    assert.equal(purged.response.status, 200);
    assert.equal(purged.body.budget.status, "deleted");
    assert.equal(fs.existsSync(path.join(harness.dataDir, budgetId)), false);
    assert.equal(fs.existsSync(purged.body.budget.safetyBackup), true);
    assert.match(purged.body.budget.safetyBackup, /deleted-budget-recoveries/);
  } finally {
    await harness.cleanup();
  }
});

test("deleted budget recovery retention keeps a bounded set of completed exports", async () => {
  const previousRetention = process.env.CASHFLOW_DELETED_BUDGET_RECOVERY_RETENTION_COUNT;
  process.env.CASHFLOW_DELETED_BUDGET_RECOVERY_RETENTION_COUNT = "2";
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await createAccount(harness, "retention_owner", "Retention Owner");
    const ownerSession = harness.session();
    const recoveryDir = path.join(harness.dataDir, "deleted-budget-recoveries");
    fs.mkdirSync(recoveryDir, { recursive: true });
    fs.writeFileSync(path.join(recoveryDir, "budget_pending.tmp"), "pending", "utf8");

    for (let index = 0; index < 4; index += 1) {
      const created = await harness.request("/api/budgets", withSession(ownerSession, {
        method: "POST",
        body: { displayName: `Retention ${index}` }
      }));
      assert.equal(created.response.status, 200);
      const budgetId = created.body.budget.id;
      await harness.request(`/api/budgets/${budgetId}/archive`, withSession(ownerSession, {
        method: "POST",
        body: {}
      }));
      const purged = await harness.request(`/api/budgets/${budgetId}`, withSession(ownerSession, {
        method: "DELETE",
        body: {}
      }));
      assert.equal(purged.response.status, 200);
    }

    const completed = fs.readdirSync(recoveryDir)
      .filter(name => /^budget_.+\.json$/.test(name));
    assert.equal(completed.length, 2);
    assert.equal(fs.existsSync(path.join(recoveryDir, "budget_pending.tmp")), true);
  } finally {
    if (previousRetention === undefined) {
      delete process.env.CASHFLOW_DELETED_BUDGET_RECOVERY_RETENTION_COUNT;
    } else {
      process.env.CASHFLOW_DELETED_BUDGET_RECOVERY_RETENTION_COUNT = previousRetention;
    }
    await harness.cleanup();
  }
});

test("budget purge recovery export survives retention pressure and can restore planner data", async () => {
  const previousRetention = process.env.CASHFLOW_DELETED_BUDGET_RECOVERY_RETENTION_COUNT;
  process.env.CASHFLOW_DELETED_BUDGET_RECOVERY_RETENTION_COUNT = "1";
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await createAccount(harness, "purge_restore_owner", "Purge Restore Owner");
    const ownerSession = harness.session();
    const recoveryDir = path.join(harness.dataDir, "deleted-budget-recoveries");
    fs.mkdirSync(recoveryDir, { recursive: true });
    const staleRecovery = path.join(recoveryDir, "budget_stale_2999-01-01T00-00-00-000Z.json");
    fs.writeFileSync(staleRecovery, "{}\n", "utf8");
    fs.utimesSync(staleRecovery, new Date("2999-01-01T00:00:00Z"), new Date("2999-01-01T00:00:00Z"));

    const created = await harness.request("/api/budgets", withSession(ownerSession, {
      method: "POST",
      body: { displayName: "Purge Source" }
    }));
    assert.equal(created.response.status, 200);
    const budgetId = created.body.budget.id;

    const oneOff = await harness.request("/api/one-off", withBudgetSession(ownerSession, budgetId, {
      method: "POST",
      body: {
        name: "Recoverable one-off",
        type: "expense",
        amount: 42.5,
        currency: "PLN",
        date: "2026-06-01"
      }
    }));
    assert.equal(oneOff.response.status, 200);

    await harness.request(`/api/budgets/${budgetId}/archive`, withSession(ownerSession, {
      method: "POST",
      body: {}
    }));
    const purged = await harness.request(`/api/budgets/${budgetId}`, withSession(ownerSession, {
      method: "DELETE",
      body: {}
    }));
    assert.equal(purged.response.status, 200);
    assert.equal(fs.existsSync(purged.body.budget.safetyBackup), true);
    assert.equal(fs.existsSync(staleRecovery), false);

    const recoveryExport = JSON.parse(fs.readFileSync(purged.body.budget.safetyBackup, "utf8"));
    assert.equal(recoveryExport.format, "cashflow-full-export");
    assert.equal(recoveryExport.operationalSettingsIncluded, false);
    assert.ok(recoveryExport.planning.one_off_transactions.some(row => row.id === oneOff.body.id));

    const replacement = await harness.request("/api/budgets", withSession(ownerSession, {
      method: "POST",
      body: { displayName: "Purge Restored" }
    }));
    assert.equal(replacement.response.status, 200);
    const imported = await harness.request("/api/import/full", withBudgetSession(ownerSession, replacement.body.budget.id, {
      method: "POST",
      body: {
        mode: "replace",
        export: recoveryExport
      }
    }));
    assert.equal(imported.response.status, 200);

    const restored = await harness.request("/api", withBudgetSession(ownerSession, replacement.body.budget.id));
    assert.equal(restored.response.status, 200);
    assert.ok(restored.body.oneOffs.some(row =>
      row.id === oneOff.body.id &&
      row.name === "Recoverable one-off" &&
      row.amount === 42.5
    ));
  } finally {
    if (previousRetention === undefined) {
      delete process.env.CASHFLOW_DELETED_BUDGET_RECOVERY_RETENTION_COUNT;
    } else {
      process.env.CASHFLOW_DELETED_BUDGET_RECOVERY_RETENTION_COUNT = previousRetention;
    }
    await harness.cleanup();
  }
});

test("authorization matrix covers account, budget role, and system-admin contexts", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await createAccount(harness, "matrix_owner", "Matrix Owner");
    await createAccount(harness, "matrix_viewer", "Matrix Viewer");
    await createAccount(harness, "matrix_editor", "Matrix Editor");
    await createAccount(harness, "matrix_manager", "Matrix Manager");
    await createAccount(harness, "matrix_admin", "Matrix Admin");
    await createAccount(harness, "matrix_outsider", "Matrix Outsider");

    const targetBudgetId = "matrix_owner";
    const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      db.transaction(() => {
        for (const [accountId, role] of [
          ["matrix_viewer", "viewer"],
          ["matrix_editor", "editor"],
          ["matrix_manager", "manager"]
        ]) {
          db.prepare(`
            INSERT OR REPLACE INTO budget_memberships (
              budget_id, account_id, role, invited_by_account_id, created_at, updated_at
            )
            VALUES (?, ?, ?, 'matrix_owner', datetime('now'), datetime('now'))
          `).run(targetBudgetId, accountId, role);
        }
        db.prepare(`
          INSERT OR IGNORE INTO account_global_roles (
            account_id, role, granted_by_account_id, created_at
          )
          VALUES ('matrix_admin', 'system_admin', 'matrix_owner', datetime('now'))
        `).run();
        db.prepare(`
          DELETE FROM account_global_roles
          WHERE account_id = 'matrix_owner' AND role = 'system_admin'
        `).run();
        db.prepare(`
          UPDATE users
          SET permissions = '[]'
          WHERE id = 'matrix_owner'
        `).run();
      })();
    } finally {
      db.close();
    }

    const owner = await selectAccountSession(harness, "matrix_owner");
    const viewer = await selectAccountSession(harness, "matrix_viewer");
    const editor = await selectAccountSession(harness, "matrix_editor");
    const manager = await selectAccountSession(harness, "matrix_manager");
    const admin = await selectAccountSession(harness, "matrix_admin");
    const outsider = await selectAccountSession(harness, "matrix_outsider");

    const assertStatus = async (label, expectedStatus, pathname, session, options = {}) => {
      const result = await harness.request(pathname, session
        ? withBudgetSession(session, targetBudgetId, options)
        : {
            ...options,
            skipUserHeader: true,
            headers: {
              "x-cashflow-budget-id": targetBudgetId,
              ...(options.headers || {})
            }
          });
      assert.equal(result.response.status, expectedStatus, label);
      return result;
    };

    await assertStatus("none-mode requests without a usable budget actor are denied", 403, "/api/budgets", null);
    await assertStatus("account without membership cannot read a selected budget", 403, "/api", outsider);
    await assertStatus("system admin without membership cannot read budget data", 403, "/api", admin);

    await assertStatus("viewer can read the budget snapshot", 200, "/api", viewer);
    await assertStatus("viewer cannot mutate planner data", 403, "/api/one-off", viewer, {
      method: "POST",
      body: {
        name: "Viewer write blocked",
        type: "expense",
        amount: 1,
        currency: "PLN",
        date: "2026-05-20"
      }
    });
    await assertStatus("viewer cannot export data", 403, "/api/export/full", viewer);
    await assertStatus("viewer cannot list members", 403, `/api/budgets/${targetBudgetId}/members`, viewer);

    await assertStatus("editor can create planner rows", 200, "/api/one-off", editor, {
      method: "POST",
      body: {
        name: "Editor planned expense",
        type: "expense",
        amount: 10,
        currency: "PLN",
        date: "2026-05-21"
      }
    });
    await assertStatus("editor cannot rename budgets", 403, `/api/budgets/${targetBudgetId}`, editor, {
      method: "PUT",
      body: { displayName: "Editor rename blocked" }
    });
    await assertStatus("editor cannot run validation", 403, "/api/validate", editor, {
      method: "POST",
      body: {}
    });
    await assertStatus("editor cannot run maintenance", 403, "/api/pending/recalculate", editor, {
      method: "POST",
      body: {}
    });

    await assertStatus("manager can rename budgets", 200, `/api/budgets/${targetBudgetId}`, manager, {
      method: "PUT",
      body: { displayName: "Matrix Managed Budget" }
    });
    await assertStatus("manager can list members", 200, `/api/budgets/${targetBudgetId}/members`, manager);
    await assertStatus("manager can create limited invitations", 200, `/api/budgets/${targetBudgetId}/invitations`, manager, {
      method: "POST",
      body: {
        accountId: "matrix_outsider",
        role: "viewer"
      }
    });
    await assertStatus("manager cannot grant owner invitations", 400, `/api/budgets/${targetBudgetId}/invitations`, manager, {
      method: "POST",
      body: {
        accountId: "matrix_outsider",
        role: "owner"
      }
    });
    await assertStatus("manager can run validation", 200, "/api/validate", manager, {
      method: "POST",
      body: {}
    });
    await assertStatus("manager cannot run owner maintenance", 403, "/api/pending/recalculate", manager, {
      method: "POST",
      body: {}
    });
    await assertStatus("manager cannot create backups", 403, "/api/backup", manager, {
      method: "POST",
      body: {}
    });

    await assertStatus("owner can run maintenance", 200, "/api/pending/recalculate", owner, {
      method: "POST",
      body: {}
    });
    await assertStatus("owner can export data", 200, "/api/export/full", owner);
    await assertStatus("owner can create backups", 200, "/api/backup", owner, {
      method: "POST",
      body: {}
    });
    await assertStatus("owner is not automatically a system admin", 403, "/api/admin/accounts", owner);
    await assertStatus("system admin can use admin routes", 200, "/api/admin/accounts", admin);
  } finally {
    await harness.cleanup();
  }
});

test("budget invitations are hashed, single-use, role-limited, and enforce membership capabilities", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await harness.api("/api/accounts", {
      method: "POST",
      body: { userId: "sharing_owner", displayName: "Sharing Owner" }
    });
    const ownerSession = harness.session();

    await harness.api("/api/accounts", {
      method: "POST",
      body: { userId: "sharing_member", displayName: "Sharing Member" }
    });
    const memberSession = harness.session();
    await harness.api("/api/accounts", {
      method: "POST",
      body: { userId: "sharing_other", displayName: "Sharing Other" }
    });
    const otherSession = harness.session();
    await harness.api("/api/accounts", {
      method: "POST",
      body: { userId: "sharing_racer", displayName: "Sharing Racer" }
    });
    const racerSession = harness.session();

    const invited = await harness.request("/api/budgets/sharing_owner/invitations", withSession(ownerSession, {
      method: "POST",
      body: {
        accountId: "sharing_member",
        role: "editor"
      }
    }));
    assert.equal(invited.response.status, 200);
    const invitation = invited.body.invitation;
    assert.ok(invitation.token);

    const db = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      const stored = db.prepare("SELECT token_hash FROM budget_invitations WHERE id = ?").get(invitation.id);
      assert.notEqual(stored.token_hash, invitation.token);
      assert.equal(stored.token_hash.length, 64);
    } finally {
      db.close();
    }

    const accepted = await harness.request("/api/invitations/accept", withSession(memberSession, {
      method: "POST",
      body: { token: invitation.token }
    }));
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.invitation.membership.role, "editor");

    const replay = await harness.request("/api/invitations/accept", withSession(memberSession, {
      method: "POST",
      body: { token: invitation.token }
    }));
    assert.equal(replay.response.status, 409);

    const targeted = await harness.request("/api/budgets/sharing_owner/invitations", withSession(ownerSession, {
      method: "POST",
      body: {
        accountId: "sharing_member",
        role: "viewer"
      }
    }));
    assert.equal(targeted.response.status, 200);
    const targetMismatch = await harness.request("/api/invitations/accept", withSession(otherSession, {
      method: "POST",
      body: { token: targeted.body.invitation.token }
    }));
    assert.equal(targetMismatch.response.status, 403);

    const revoked = await harness.request("/api/budgets/sharing_owner/invitations", withSession(ownerSession, {
      method: "POST",
      body: {
        accountId: "sharing_other",
        role: "viewer"
      }
    }));
    assert.equal(revoked.response.status, 200);
    const revokeResult = await harness.request(`/api/budgets/sharing_owner/invitations/${revoked.body.invitation.id}`, withSession(ownerSession, {
      method: "DELETE",
      body: {}
    }));
    assert.equal(revokeResult.response.status, 200);
    const revokedAccept = await harness.request("/api/invitations/accept", withSession(otherSession, {
      method: "POST",
      body: { token: revoked.body.invitation.token }
    }));
    assert.equal(revokedAccept.response.status, 409);

    const expired = await harness.request("/api/budgets/sharing_owner/invitations", withSession(ownerSession, {
      method: "POST",
      body: {
        accountId: "sharing_other",
        role: "viewer"
      }
    }));
    assert.equal(expired.response.status, 200);
    const expireDb = new Database(path.join(harness.dataDir, "cashflow-global.sqlite"));
    try {
      expireDb.prepare(`
        UPDATE budget_invitations
        SET expires_at = datetime('now', '-1 hour')
        WHERE id = ?
      `).run(expired.body.invitation.id);
    } finally {
      expireDb.close();
    }
    const expiredAccept = await harness.request("/api/invitations/accept", withSession(otherSession, {
      method: "POST",
      body: { token: expired.body.invitation.token }
    }));
    assert.equal(expiredAccept.response.status, 409);

    const racing = await harness.request("/api/budgets/sharing_owner/invitations", withSession(ownerSession, {
      method: "POST",
      body: {
        accountId: "sharing_racer",
        role: "viewer"
      }
    }));
    assert.equal(racing.response.status, 200);
    const racingStatuses = (await Promise.all([
      harness.request("/api/invitations/accept", withSession(racerSession, {
        method: "POST",
        body: { token: racing.body.invitation.token }
      })),
      harness.request("/api/invitations/accept", withSession(racerSession, {
        method: "POST",
        body: { token: racing.body.invitation.token }
      }))
    ])).map(result => result.response.status).sort((a, b) => a - b);
    assert.deepEqual(racingStatuses, [200, 409]);

    const editorRename = await harness.request("/api/budgets/sharing_owner", withSession(memberSession, {
      method: "PUT",
      body: { displayName: "Not allowed" }
    }));
    assert.equal(editorRename.response.status, 403);

    const promoted = await harness.request("/api/budgets/sharing_owner/members/sharing_member", withSession(ownerSession, {
      method: "PUT",
      body: { role: "manager" }
    }));
    assert.equal(promoted.response.status, 200);
    assert.equal(promoted.body.membership.role, "manager");

    const managerRename = await harness.request("/api/budgets/sharing_owner", withSession(memberSession, {
      method: "PUT",
      body: { displayName: "Shared Household" }
    }));
    assert.equal(managerRename.response.status, 200);

    const managerOwnerInvite = await harness.request("/api/budgets/sharing_owner/invitations", withSession(memberSession, {
      method: "POST",
      body: {
        accountId: "sharing_other",
        role: "owner"
      }
    }));
    assert.equal(managerOwnerInvite.response.status, 400);

    const disabledInvite = await harness.request("/api/budgets/sharing_owner/invitations", withSession(ownerSession, {
      method: "POST",
      body: {
        accountId: "sharing_other",
        role: "viewer"
      }
    }));
    assert.equal(disabledInvite.response.status, 200);
    const disabledAccept = await harness.request("/api/invitations/accept", withSession(otherSession, {
      method: "POST",
      body: { token: disabledInvite.body.invitation.token }
    }));
    assert.equal(disabledAccept.response.status, 200);
    const disabledAccount = await harness.request("/api/admin/accounts/sharing_other", withSession(ownerSession, {
      method: "PUT",
      body: { status: "disabled" }
    }));
    assert.equal(disabledAccount.response.status, 200);
    const disabledRoleChange = await harness.request("/api/budgets/sharing_owner/members/sharing_other", withSession(ownerSession, {
      method: "PUT",
      body: { role: "manager" }
    }));
    assert.equal(disabledRoleChange.response.status, 404);
    const disabledTransfer = await harness.request("/api/budgets/sharing_owner/transfer-ownership", withSession(ownerSession, {
      method: "POST",
      body: { accountId: "sharing_other" }
    }));
    assert.equal(disabledTransfer.response.status, 404);
    const membersAfterDisabledTransfer = await harness.request("/api/budgets/sharing_owner/members", withSession(ownerSession));
    assert.equal(membersAfterDisabledTransfer.response.status, 200);
    assert.equal(
      membersAfterDisabledTransfer.body.members.find(member => member.account_id === "sharing_owner")?.role,
      "owner"
    );

    const transferred = await harness.request("/api/budgets/sharing_owner/transfer-ownership", withSession(ownerSession, {
      method: "POST",
      body: { accountId: "sharing_member" }
    }));
    assert.equal(transferred.response.status, 200);
    assert.equal(transferred.body.membership.role, "owner");

    const formerOwnerLeave = await harness.request("/api/budgets/sharing_owner/leave", withSession(ownerSession, {
      method: "POST",
      body: {}
    }));
    assert.equal(formerOwnerLeave.response.status, 200);

    const currentOwnerLeave = await harness.request("/api/budgets/sharing_owner/leave", withSession(memberSession, {
      method: "POST",
      body: {}
    }));
    assert.equal(currentOwnerLeave.response.status, 409);
  } finally {
    await harness.cleanup();
  }
});
