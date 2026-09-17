import assert from "node:assert/strict";

import Database from "better-sqlite3";
import test from "node:test";

import { CAPABILITIES, capabilitiesFor } from "../../src/server/cashflow-authorization.js";
import { createSqliteGlobalRepository } from "../../src/server/cashflow-global-repository.js";
import {
  initializeGlobalSchema,
  LEGACY_ADMIN_ACCOUNT_ID
} from "../../src/server/cashflow-global-schema.js";

function withGlobalRepository(fn) {
  const db = new Database(":memory:");
  try {
    initializeGlobalSchema(db, { storageProfileIds: ["legacy_budget"] });
    const repo = createSqliteGlobalRepository(db, {
      generateAuditId: () => "audit_test",
      nowMs: () => Date.parse("2026-01-03T04:05:06Z")
    });
    return fn({ db, repo });
  } finally {
    db.close();
  }
}

test("SQLite global repository covers global options, users, budgets, memberships, and audit rows", () => {
  withGlobalRepository(({ db, repo }) => {
    assert.equal(repo.backend, "sqlite");
    assert.equal(repo.globalOptions.get().ledger_currency, "PLN");

    repo.globalOptions.updatePlannerDefaults({
      ledger_currency: "EUR",
      locale: "pl",
      timezone: "Europe/Warsaw",
      holiday_country: "PL",
      future_periods: 12,
      fx_provider: "manual",
      fx_buffer_percent: 2
    });
    assert.equal(repo.globalOptions.get().ledger_currency, "EUR");
    assert.equal(repo.globalOptions.get().fx_provider, "manual");

    repo.users.ensureMetadata("alice", "Alice");
    assert.equal(repo.users.getMetadata("alice").display_name, "Alice");
    repo.users.touchSelection("alice");
    assert.ok(repo.users.listMetadata().some(row => row.id === "alice"));

    assert.equal(repo.budgets.get("legacy_budget").storage_key, "legacy_budget");
    repo.budgets.updateDisplayName("legacy_budget", "Renamed Legacy");
    assert.equal(repo.budgets.get("legacy_budget").display_name, "Renamed Legacy");
    repo.budgets.markArchived("legacy_budget");
    assert.equal(repo.budgets.get("legacy_budget").status, "archived");
    assert.ok(repo.budgets.get("legacy_budget").archived_at);
    repo.budgets.markActive("legacy_budget");
    assert.equal(repo.budgets.get("legacy_budget").status, "active");
    assert.equal(repo.budgets.get("legacy_budget").archived_at, null);
    assert.equal(repo.memberships.ownerAccountId("legacy_budget"), LEGACY_ADMIN_ACCOUNT_ID);
    assert.equal(
      repo.memberships.getRole({
        accountId: LEGACY_ADMIN_ACCOUNT_ID,
        budgetId: "legacy_budget"
      }).role,
      "owner"
    );

    const globalRoles = repo.roles.listForAccount(LEGACY_ADMIN_ACCOUNT_ID);
    assert.ok(globalRoles.includes("system_admin"));
    assert.ok(capabilitiesFor({ globalRoles }).includes(CAPABILITIES.SYSTEM_ADMIN));

    repo.audit.insertSecurityEvent({
      action: "repository_contract_test",
      actorAccountId: LEGACY_ADMIN_ACCOUNT_ID,
      details: { changed: true },
      targetId: "legacy_budget",
      targetType: "budget"
    });
    const auditRow = db.prepare(`
      SELECT action, actor_account_id, target_type, target_id, details_json
      FROM security_audit_log
      WHERE id = 'audit_test'
    `).get();
    assert.equal(auditRow.action, "repository_contract_test");
    assert.equal(auditRow.actor_account_id, LEGACY_ADMIN_ACCOUNT_ID);
    assert.equal(auditRow.target_type, "budget");
    assert.equal(auditRow.target_id, "legacy_budget");
    assert.deepEqual(JSON.parse(auditRow.details_json), { changed: true });
  });
});

test("SQLite global repository exposes account and session state without leaking tokens", () => {
  withGlobalRepository(({ db, repo }) => {
    repo.users.insertNew({ id: "alice", displayName: "Alice" });
    repo.accounts.insert({
      id: "alice",
      email: "alice@example.com",
      displayName: "Alice"
    });
    repo.budgets.insert({
      id: "alice_budget",
      storageKey: "alice_budget",
      displayName: "Alice Budget",
      createdByAccountId: "alice"
    });
    repo.memberships.insertOwner({
      accountId: "alice",
      budgetId: "alice_budget"
    });
    repo.roles.insertSystemAdmin({
      accountId: "alice",
      grantedByAccountId: LEGACY_ADMIN_ACCOUNT_ID
    });
    db.prepare(`
      INSERT INTO auth_sessions (
        id, account_id, token_hash, csrf_token_hash, selected_budget_id,
        auth_method, created_at, last_seen_at, idle_expires_at,
        absolute_expires_at
      )
      VALUES (
        'session_1', 'alice', 'secret-token-hash', 'secret-csrf-hash',
        'alice_budget', 'none', '2026-01-03T04:00:00Z',
        '2026-01-03T04:01:00Z', '2026-01-03T05:00:00Z',
        '2026-01-04T04:00:00Z'
      )
    `).run();

    const account = repo.accounts.require("alice");
    assert.equal(account.email, "alice@example.com");
    assert.equal(repo.accounts.listActive().some(row => row.id === "alice"), true);
    assert.equal(repo.memberships.countForAccount("alice"), 1);
    assert.equal(repo.memberships.countOwnedForAccount("alice"), 1);
    assert.deepEqual(
      repo.memberships.listBudgetsForAccount("alice").map(row => row.id),
      ["alice_budget"]
    );
    assert.deepEqual(
      repo.memberships.listMembers("alice_budget").map(row => row.account_id),
      ["alice"]
    );
    repo.accounts.insert({
      id: "bob",
      email: "bob@example.com",
      displayName: "Bob"
    });
    repo.memberships.insert({
      accountId: "bob",
      budgetId: "alice_budget",
      role: "editor"
    });
    repo.memberships.updateRole({
      accountId: "bob",
      budgetId: "alice_budget",
      role: "manager"
    });
    assert.equal(
      repo.memberships.get({ accountId: "bob", budgetId: "alice_budget" }).role,
      "manager"
    );
    repo.memberships.delete({
      accountId: "bob",
      budgetId: "alice_budget"
    });
    assert.equal(repo.memberships.get({ accountId: "bob", budgetId: "alice_budget" }), undefined);
    assert.equal(repo.accounts.countActiveSystemAdmins(), 2);

    const sessions = repo.sessions.listActiveForAccount("alice");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "session_1");
    assert.equal(Object.hasOwn(sessions[0], "token_hash"), false);
    assert.equal(Object.hasOwn(sessions[0], "csrf_token_hash"), false);

    repo.sessions.revokeForAccountBudget("alice", "alice_budget");
    assert.equal(repo.sessions.listActiveForAccount("alice").length, 0);
  });
});

test("SQLite global repository covers provider, OAuth, invitation, and credential rows", () => {
  withGlobalRepository(({ db, repo }) => {
    repo.accounts.insert({
      id: "alice",
      email: "alice@example.com",
      displayName: "Alice"
    });
    repo.authProviders.upsert({
      id: "github",
      kind: "github",
      displayName: "GitHub",
      enabled: true,
      issuer: "https://github.com",
      clientId: "client-id",
      secretRef: "env:GITHUB_SECRET",
      configJson: JSON.stringify({
        authorizationEndpoint: "https://github.com/login/oauth/authorize",
        redirectUri: "https://example.com/callback",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        userInfoEndpoint: "https://api.github.com/user"
      })
    });

    assert.equal(repo.authProviders.list({ publicOnly: true }).length, 1);
    assert.equal(repo.authProviders.get("github").kind, "github");

    repo.oauthStates.insert({
      providerId: "github",
      stateHash: "state_hash",
      purpose: "link",
      accountId: "alice",
      codeVerifier: "code-verifier",
      nonce: "nonce",
      redirectUri: "https://example.com/callback",
      expiresAt: "2026-01-03T05:00:00Z",
      id: "oauth_state_test"
    });
    assert.equal(
      repo.oauthStates.getByHashAndProvider({
        providerId: "github",
        stateHash: "state_hash"
      }).id,
      "oauth_state_test"
    );
    repo.oauthStates.markConsumed("oauth_state_test");
    assert.equal(repo.oauthStates.get("oauth_state_test").status, "consumed");

    repo.identities.upsert({
      id: "identity_test",
      accountId: "alice",
      providerId: "github",
      subject: "github-subject",
      email: "alice@example.com",
      emailVerified: true,
      lastUsedNow: true,
      profileJson: '{"source":"test"}'
    });
    assert.equal(
      repo.identities.findWithAccountByProviderSubject("github", "github-subject").account_id,
      "alice"
    );
    repo.identities.updateProviderLogin({
      providerId: "github",
      subject: "github-subject",
      email: "alice-new@example.com",
      emailVerified: true,
      profileJson: '{"updated":true}'
    });
    assert.equal(repo.identities.listForAccount("alice")[0].email, "alice-new@example.com");

    repo.passwordCredentials.insert({
      accountId: "alice",
      passwordHash: "argon2-hash"
    });
    assert.equal(repo.passwordCredentials.getLoginByEmail("alice@example.com").account_id, "alice");
    repo.passwordCredentials.recordFailedLogin({
      accountId: "alice",
      attempts: 5,
      lockThreshold: 5,
      lockUntil: "2026-01-03T06:00:00Z"
    });
    assert.equal(repo.passwordCredentials.getLoginByEmail("alice@example.com").failed_attempts, 5);
    repo.passwordCredentials.recordSuccessfulLogin("alice");
    assert.equal(repo.passwordCredentials.getLoginByEmail("alice@example.com").failed_attempts, 0);

    repo.passwordResetTokens.insert({
      accountId: "alice",
      tokenHash: "token_hash",
      purpose: "password_reset",
      expiresAt: "2026-01-04T04:00:00Z",
      id: "password_token_test"
    });
    assert.equal(repo.passwordResetTokens.getPendingWithAccountByHash("token_hash").account_id, "alice");
    repo.passwordResetTokens.markExpired("password_token_test");
    assert.equal(
      db.prepare("SELECT status FROM password_reset_tokens WHERE id = ?").get("password_token_test").status,
      "expired"
    );

    repo.invitations.insertPending({
      budgetId: "legacy_budget",
      expiresAt: "2026-01-04T04:00:00Z",
      id: "invite_test",
      invitedByAccountId: LEGACY_ADMIN_ACCOUNT_ID,
      role: "editor",
      targetEmail: "alice@example.com",
      tokenHash: "invite_hash"
    });
    assert.equal(repo.invitations.findPendingForEmail("alice@example.com").id, "invite_test");
    assert.equal(repo.invitations.getForBudget({
      budgetId: "legacy_budget",
      invitationId: "invite_test"
    }).role, "editor");
    assert.equal(repo.invitations.listForBudget("legacy_budget")[0].id, "invite_test");
    assert.equal(repo.invitations.acceptForAccount({
      accountId: "alice",
      invitationId: "invite_test",
      role: "editor"
    }), 1);
    repo.memberships.upsertFromInvitation({
      accountId: "alice",
      budgetId: "legacy_budget",
      invitedByAccountId: LEGACY_ADMIN_ACCOUNT_ID,
      role: "editor"
    });
    assert.equal(
      repo.memberships.get({ accountId: "alice", budgetId: "legacy_budget" }).role,
      "editor"
    );
    assert.equal(repo.invitations.getByTokenHash("invite_hash").status, "accepted");

    repo.invitations.insertPending({
      budgetId: "legacy_budget",
      expiresAt: "2026-01-04T04:00:00Z",
      id: "invite_revoke",
      invitedByAccountId: LEGACY_ADMIN_ACCOUNT_ID,
      role: "viewer",
      targetEmail: "revoke@example.com",
      tokenHash: "invite_revoke_hash"
    });
    assert.equal(repo.invitations.revokePending("invite_revoke"), 1);
    assert.equal(repo.invitations.getByTokenHash("invite_revoke_hash").status, "revoked");

    repo.invitations.insertPending({
      budgetId: "legacy_budget",
      expiresAt: "2026-01-01T00:00:00Z",
      id: "invite_expired",
      invitedByAccountId: LEGACY_ADMIN_ACCOUNT_ID,
      role: "viewer",
      targetEmail: "late@example.com",
      tokenHash: "invite_expired_hash"
    });
    assert.equal(repo.invitations.expirePendingForBudget("legacy_budget"), 1);
    assert.equal(repo.invitations.getByTokenHash("invite_expired_hash").status, "expired");
  });
});
