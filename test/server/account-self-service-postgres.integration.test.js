import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowGlobalService } from "../../src/server/cashflow-global-service.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

const gated = { skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests" };

async function insertSession(globalStore, id, accountId) {
  const now = new Date();
  const later = new Date(now.getTime() + 3_600_000).toISOString();
  await globalStore.transaction(async repo => {
    await repo.sessions.insert({
      id,
      accountId,
      absoluteExpiresAt: later,
      authMethod: "none",
      createdAt: now.toISOString(),
      csrfTokenHash: `csrf_${id}`,
      idleExpiresAt: later,
      lastSeenAt: now.toISOString(),
      tokenHash: `token_${id}`
    });
  });
}

test("account self-service edits profile and password on Postgres with lockout and session revocation", gated, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const globalStore = await createPostgresGlobalStore({ databaseUrl });
    try {
      await globalStore.initialize();
      await globalStore.transaction(async repo => {
        await repo.accounts.insert({ id: "pg_self", displayName: "Self" });
        await repo.accounts.insert({ id: "pg_other", displayName: "Other", email: "taken@example.com" });
      });
      const service = createCashflowGlobalService({
        globalStore,
        openGlobalDb: () => { throw new Error("unexpected SQLite access"); }
      });

      assert.deepEqual(await service.getOwnAccount("pg_self"), {
        id: "pg_self",
        displayName: "Self",
        email: "",
        hasPasswordCredential: false,
        authMode: "none",
        identities: []
      });

      await assert.rejects(service.changeOwnPassword("pg_self", "keep", { newPassword: "correct horse battery staple" }),
        error => error.status === 409);
      await assert.rejects(service.updateOwnAccount("pg_self", { email: "TAKEN@example.com" }),
        error => error.status === 409);

      const renamed = await service.updateOwnAccount("pg_self", { displayName: "Renamed", email: "Self@Example.com" });
      assert.equal(renamed.displayName, "Renamed");
      assert.equal(renamed.email, "self@example.com");

      await insertSession(globalStore, "keep", "pg_self");
      await insertSession(globalStore, "other", "pg_self");
      await insertSession(globalStore, "foreign", "pg_other");
      await globalStore.transaction(async repo => {
        await repo.passwordResetTokens.insert({
          accountId: "pg_self",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          purpose: "password_setup",
          tokenHash: "pending_hash"
        });
      });

      const first = "correct horse battery staple";
      const set = await service.changeOwnPassword("pg_self", "keep", { newPassword: first });
      assert.equal(set.hasPasswordCredential, true);
      const sessions = await pool.query("SELECT id, revoked_at IS NOT NULL AS revoked FROM auth_sessions ORDER BY id");
      assert.deepEqual(sessions.rows, [
        { id: "foreign", revoked: false },
        { id: "keep", revoked: false },
        { id: "other", revoked: true }
      ]);
      const tokens = await pool.query("SELECT status FROM password_reset_tokens WHERE account_id = 'pg_self'");
      assert.deepEqual(tokens.rows.map(row => row.status), ["revoked"]);

      await assert.rejects(service.updateOwnAccount("pg_self", { email: "new@example.com" }),
        error => error.status === 400 && /Current password is incorrect/.test(error.message));
      const changedEmail = await service.updateOwnAccount("pg_self", { email: "new@example.com", currentPassword: first });
      assert.equal(changedEmail.email, "new@example.com");

      const second = "another long passphrase";
      await service.changeOwnPassword("pg_self", "keep", { currentPassword: first, newPassword: second });
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await assert.rejects(service.changeOwnPassword("pg_self", "keep", { currentPassword: `guess ${attempt}`, newPassword: first }),
          error => error.status === 400);
      }
      const credential = await pool.query("SELECT failed_attempts, locked_until FROM password_credentials WHERE account_id = 'pg_self'");
      assert.equal(credential.rows[0].failed_attempts, 4);
      assert.equal(credential.rows[0].locked_until, null);
      await assert.rejects(service.changeOwnPassword("pg_self", "keep", { currentPassword: "guess 5", newPassword: first }),
        error => error.status === 400);
      await assert.rejects(service.changeOwnPassword("pg_self", "keep", { currentPassword: second, newPassword: first }),
        error => error.status === 429, "the correct password is refused while the account is locked");

      // Internal login shares recordFailedLogin; a wrong password must be a counted 401, not a SQL error.
      const otherPassword = "other account passphrase";
      await service.changeOwnPassword("pg_other", "foreign", { newPassword: otherPassword });
      await pool.query("UPDATE auth_config SET active_mode = 'internal' WHERE id = 1");
      await assert.rejects(service.authenticateInternalLogin({ email: "taken@example.com", password: "not the password" }),
        error => error.status === 401 && error.message === "Invalid email or password");
      const otherCredential = await pool.query("SELECT failed_attempts FROM password_credentials WHERE account_id = 'pg_other'");
      assert.equal(otherCredential.rows[0].failed_attempts, 1);
      assert.equal((await service.authenticateInternalLogin({ email: "taken@example.com", password: otherPassword })).accountId, "pg_other");

      await globalStore.transaction(async repo => {
        await repo.accounts.insert({ id: "pg_nopass", displayName: "No password", email: "nopass@example.com" });
        await repo.identities.upsert({ accountId: "pg_nopass", providerId: "github", subject: "777", email: "nopass@example.com", emailVerified: true });
        await repo.identities.upsert({ accountId: "pg_nopass", providerId: "external_abc", subject: "proxy-user" });
        await repo.identities.upsert({ accountId: "pg_self", providerId: "facebook", subject: "fb-9", email: "self@example.com", emailVerified: false });
      });
      const noPass = await service.getOwnAccount("pg_nopass");
      assert.deepEqual(noPass.identities.map(identity => [identity.providerId, identity.emailVerified]), [["github", true]],
        "proxy identities are hidden and Postgres booleans map to emailVerified");
      await assert.rejects(service.unlinkOwnIdentity("pg_nopass", noPass.identities[0].id),
        error => error.status === 409 && /only way to sign in/.test(error.message));
      await assert.rejects(service.unlinkOwnIdentity("pg_self", noPass.identities[0].id), error => error.status === 404,
        "another account's identity can't be unlinked");
      const selfView = await service.getOwnAccount("pg_self");
      assert.equal(selfView.identities[0].emailVerified, false);
      const afterUnlink = await service.unlinkOwnIdentity("pg_self", selfView.identities[0].id);
      assert.deepEqual(afterUnlink.identities, []);

      // A setup token typed as the password opens setup instead of failing (internal mode is active here).
      const setup = await service.createAdminPasswordResetToken("pg_self", "pg_nopass", { purpose: "password_setup" });
      assert.deepEqual(await service.authenticateInternalLogin({ email: "nopass@example.com", password: setup.token }),
        { passwordSetupRequired: true, purpose: "password_setup" });
      await assert.rejects(service.authenticateInternalLogin({ email: "taken@example.com", password: setup.token }),
        error => error.status === 401);

      // pg_other has a password but no linked provider, so it can't turn the password off.
      await assert.rejects(service.removeOwnPassword("pg_other", { currentPassword: otherPassword }), error => error.status === 409);
      await globalStore.transaction(async repo => {
        await repo.identities.upsert({ accountId: "pg_other", providerId: "google", subject: "g-other", email: "taken@example.com", emailVerified: true });
      });
      const passwordOff = await service.removeOwnPassword("pg_other", { currentPassword: otherPassword });
      assert.equal(passwordOff.hasPasswordCredential, false);
      assert.equal((await pool.query("SELECT 1 FROM password_credentials WHERE account_id = 'pg_other'")).rowCount, 0);

      await service.recordAdminSecurityEvent("pg_self", "admin_auth_secret_store", {
        details: { name: "CASHFLOW_X_CLIENT_SECRET", target: "dotenv" },
        targetId: "CASHFLOW_X_CLIENT_SECRET",
        targetType: "auth_secret"
      });
      assert.equal((await pool.query("SELECT 1 FROM security_audit_log WHERE action = 'admin_auth_secret_store' AND target_id = 'CASHFLOW_X_CLIENT_SECRET'")).rowCount, 1);

      const audit = await pool.query("SELECT action FROM security_audit_log WHERE target_id = 'pg_self' ORDER BY created_at, id");
      const actions = audit.rows.map(row => row.action);
      for (const action of ["account_self_update", "account_password_set", "account_password_change", "account_current_password_check", "account_identity_unlink"]) {
        assert.ok(actions.includes(action), action);
      }
    } finally {
      await globalStore.close();
    }
  });
});

test("GitHub provider linking and sign-in run end to end on Postgres", gated, async () => {
  const previousSecret = process.env.CASHFLOW_TEST_PG_GITHUB_SECRET;
  process.env.CASHFLOW_TEST_PG_GITHUB_SECRET = "pg-github-secret";
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const globalStore = await createPostgresGlobalStore({ databaseUrl });
    try {
      await globalStore.initialize();
      await globalStore.transaction(async repo => {
        await repo.accounts.insert({ id: "pg_linker", displayName: "Linker", email: "linker@example.com" });
      });
      const service = createCashflowGlobalService({
        globalStore,
        openGlobalDb: () => { throw new Error("unexpected SQLite access"); },
        fetchImpl: async url => {
          assert.equal(String(url), "https://api.github.com/user/emails");
          return new Response(JSON.stringify([{ email: "linker@example.com", primary: true, verified: true }]), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        },
        authProviderHook: async ({ action, state }) => {
          if (action === "authorization_url") return { authorizationUrl: `https://github.example.test/authorize?state=${state}` };
          if (action === "callback") return { profile: { id: 9001, login: "linker", name: "Linker" }, accessToken: "pg-token" };
          return null;
        }
      });
      await service.upsertAdminAuthProviderAsync("pg_linker", "github", {
        kind: "github",
        displayName: "GitHub",
        enabled: true,
        clientId: "github-client",
        secretEnv: "CASHFLOW_TEST_PG_GITHUB_SECRET",
        redirectUri: "https://cashflow.example.test/api/auth/providers/github/callback"
      });
      await pool.query("UPDATE auth_config SET active_mode = 'internal' WHERE id = 1");

      const callbackFor = authorizationUrl => {
        const state = new URL(authorizationUrl).searchParams.get("state");
        return `https://cashflow.example.test/api/auth/providers/github/callback?code=pg-code&state=${encodeURIComponent(state)}`;
      };
      const link = await service.startAuthProviderLink("pg_linker", "github");
      assert.deepEqual(await service.completeAuthProviderCallback("github", callbackFor(link.authorizationUrl)),
        { accountId: "pg_linker", linked: true });
      const identity = (await pool.query("SELECT subject, email, email_verified, last_used_at FROM auth_identities WHERE account_id = 'pg_linker'")).rows[0];
      assert.equal(identity.subject, "9001");
      assert.equal(identity.email, "linker@example.com");
      assert.equal(identity.email_verified, true);
      assert.ok(identity.last_used_at);

      const login = await service.startAuthProviderLogin("github");
      assert.deepEqual(await service.completeAuthProviderCallback("github", callbackFor(login.authorizationUrl)),
        { accountId: "pg_linker", linked: false });
    } finally {
      await globalStore.close();
      if (previousSecret === undefined) delete process.env.CASHFLOW_TEST_PG_GITHUB_SECRET;
      else process.env.CASHFLOW_TEST_PG_GITHUB_SECRET = previousSecret;
    }
  });
});
