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
        authMode: "none"
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

      const audit = await pool.query("SELECT action FROM security_audit_log WHERE target_id = 'pg_self' ORDER BY created_at, id");
      const actions = audit.rows.map(row => row.action);
      for (const action of ["account_self_update", "account_password_set", "account_password_change", "account_current_password_check"]) {
        assert.ok(actions.includes(action), action);
      }
    } finally {
      await globalStore.close();
    }
  });
});
