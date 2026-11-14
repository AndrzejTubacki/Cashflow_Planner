import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { initializeGlobalSchema, applyGlobalMigrations } from "../../src/server/cashflow-global-schema.js";
import { createDeviceStore } from "../../src/server/cashflow-device-store.js";
import { createDeviceService } from "../../src/server/cashflow-device-service.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";

async function exercise(globalStore, pool = null) {
  let clock = Date.parse("2026-10-14T12:00:00Z");
  const store = createDeviceStore(globalStore);
  const service = createDeviceService({ store, now: () => clock });
  // Separate queues/pool clients emulate independent k3s replicas.
  const peer = globalStore.backend === "postgres"
    ? createDeviceService({ store: createDeviceStore(globalStore), now: () => clock }) : service;
  const sql = (query, values) => store.transaction(tx => tx.query(query, values));
  const stamp = new Date(clock).toISOString();
  await sql("INSERT INTO accounts (id, display_name, status, created_at, updated_at) VALUES ('device-user', 'Device user', 'active', ?, ?)", [stamp, stamp]);
  await sql("INSERT INTO budgets (id, storage_key, display_name, status, created_by_account_id, created_at, updated_at) VALUES ('device-budget', 'device-budget', 'Budget', 'active', 'device-user', ?, ?)", [stamp, stamp]);
  await sql("INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at) VALUES ('device-budget', 'device-user', 'owner', ?, ?)", [stamp, stamp]);
  await sql("UPDATE auth_config SET active_mode = 'internal' WHERE id = 1");
  await sql("INSERT INTO auth_sessions (id, account_id, token_hash, csrf_token_hash, auth_method, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES ('device-session', 'device-user', 'unused-token', 'unused-csrf', 'internal', ?, ?, ?, ?)",
    [stamp, stamp, new Date(clock + 3600000).toISOString(), new Date(clock + 86400000).toISOString()]);
  const approve = pairing => service.approve({ verificationCode: pairing.verificationCode, accountId: "device-user", sessionId: "device-session", budgetIds: ["device-budget"] });
  // A financial grant requires an explicit request AND browser-reviewed budget choices.
  const financial = await service.createPairing("Sync phone", "app:financial:sync");
  assert.equal((await service.inspectPairing(financial.verificationCode)).scope, "app:financial:sync");
  const financialApproval = { verificationCode: financial.verificationCode, accountId: "device-user",
    sessionId: "device-session", budgetIds: ["financial-budget"], writeBudgetIds: ["financial-budget"] };
  for (const writeBudgetIds of [null, true, "financial-budget", [1], ["other"], ["financial-budget", "financial-budget"]]) {
    await assert.rejects(service.approve({ ...financialApproval, writeBudgetIds }), /explicit write budgets/);
  }
  // A separate owner preserves the real single-owner/demotion constraints.
  await sql("INSERT INTO accounts (id, display_name, status, created_at, updated_at) VALUES ('grant-owner', 'Grant owner', 'active', ?, ?)", [stamp, stamp]);
  await sql("INSERT INTO budgets (id, storage_key, display_name, status, created_by_account_id, created_at, updated_at) VALUES ('financial-budget', 'financial-budget', 'Financial grant', 'active', 'grant-owner', ?, ?)", [stamp, stamp]);
  await sql("INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at) VALUES ('financial-budget', 'device-user', 'editor', ?, ?)", [stamp, stamp]);
  await sql("INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at) VALUES ('financial-budget', 'grant-owner', 'owner', ?, ?)", [stamp, stamp]);
  await sql("UPDATE budget_memberships SET role = 'viewer' WHERE budget_id = 'financial-budget' AND account_id = 'device-user'");
  await assert.rejects(service.approve(financialApproval), /write permission/);
  await sql("UPDATE budget_memberships SET role = 'editor' WHERE budget_id = 'financial-budget' AND account_id = 'device-user'");
  await service.approve(financialApproval);
  const financialTokens = await service.poll(financial.deviceCode);
  assert.equal(financialTokens.scope, "app:financial:sync");
  assert.deepEqual(financialTokens.writeBudgetIds, ["financial-budget"]);
  // Sync credentials name the account every sync request is bound to.
  assert.equal(financialTokens.accountId, "device-user");
  const write = (token, capability = "planner:write") => store.transaction(tx =>
    service.authorizeFinancialWrite(tx, token, "financial-budget", capability));
  assert.equal((await write(financialTokens.accessToken)).accountId, "device-user");
  await assert.rejects(write(financialTokens.accessToken, "budget:purge"));
  await sql("UPDATE budget_memberships SET role = 'editor' WHERE budget_id = 'financial-budget' AND account_id = 'device-user'");
  await write(financialTokens.accessToken, "ledger:confirm");
  await assert.rejects(write(financialTokens.accessToken, "budget:settings"), /Current budget permission/);
  await sql("UPDATE budget_memberships SET role = 'viewer' WHERE budget_id = 'financial-budget' AND account_id = 'device-user'");
  await assert.rejects(write(financialTokens.accessToken), /Current budget permission/);
  await sql("UPDATE budget_memberships SET role = 'editor' WHERE budget_id = 'financial-budget' AND account_id = 'device-user'");
  if (pool) {
    // Observe a real lock wait, not a timing-only assertion: browser demotion
    // cannot cross authorization while a financial transaction still owns it.
    const connection = await pool.connect();
    const contender = await pool.connect();
    try {
      await connection.query("BEGIN");
      const query = async (sql, args = []) => {
        let index = 0;
        return (await connection.query(sql.replace(/\?/g, () => `$${++index}`), args)).rows;
      };
      await service.authorizeFinancialWrite({ query, backend: "postgres" }, financialTokens.accessToken, "financial-budget", "planner:write");
      const pid = (await contender.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const demotion = contender.query("UPDATE budget_memberships SET role='viewer' WHERE budget_id='financial-budget' AND account_id='device-user'");
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await pool.query("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [pid])).rows[0].blocked) {
          blocked = true; break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await connection.query("COMMIT");
      await demotion;
      assert.equal(blocked, true, "membership update must wait for the financial authorization transaction");
      await assert.rejects(write(financialTokens.accessToken), /Current budget permission/);
      await sql("UPDATE budget_memberships SET role='editor' WHERE budget_id='financial-budget' AND account_id='device-user'");
    } finally {
      await connection.query("ROLLBACK");
      connection.release(); contender.release();
    }
  }
  const renewedFinancial = await service.renew(financialTokens.renewalToken);
  assert.equal(renewedFinancial.scope, "app:financial:sync");
  assert.equal(renewedFinancial.accountId, "device-user");
  await assert.rejects(store.transaction(tx => service.authorizeFinancialWrite(tx, renewedFinancial.accessToken,
    "device-budget", "planner:write")));
  await assert.rejects(write(renewedFinancial.renewalToken));
  const savedGrant = (await sql("SELECT state_json FROM app_devices WHERE id = ?", [financialTokens.deviceId]))[0].state_json;
  // A withdrawn write grant is forbidden (403), not an authentication failure (401),
  // so phones hold their work for review instead of retrying as if the token expired.
  // The device keeps a write grant for another budget it belongs to, as in real use.
  await sql("UPDATE app_devices SET state_json = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(savedGrant),
    budgetIds: ["financial-budget", "device-budget"], writeBudgetIds: ["device-budget"] }), financialTokens.deviceId]);
  await assert.rejects(write(renewedFinancial.accessToken), error => error.status === 403);
  await sql("UPDATE app_devices SET state_json = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(savedGrant), budgetIds: [], writeBudgetIds: [] }), financialTokens.deviceId]);
  await assert.rejects(write(renewedFinancial.accessToken), error => error.status === 401);
  await sql("UPDATE app_devices SET state_json = ? WHERE id = ?", [savedGrant, financialTokens.deviceId]);
  for (const malformed of [{ scope: "admin" }, { writeBudgetIds: null }, { writeBudgetIds: ["other"] },
    { writeBudgetIds: [] }, { writeBudgetIds: ["financial-budget", "financial-budget"] }]) {
    await sql("UPDATE app_devices SET state_json = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(savedGrant), ...malformed }), financialTokens.deviceId]);
    await assert.rejects(write(renewedFinancial.accessToken));
  }
  await sql("UPDATE app_devices SET state_json = ? WHERE id = ?", [savedGrant, financialTokens.deviceId]);
  await service.revoke("device-user", financialTokens.deviceId);
  await assert.rejects(write(renewedFinancial.accessToken));
  const readonly = await service.createPairing("Read-only phone");
  await assert.rejects(service.approve({ ...financialApproval, verificationCode: readonly.verificationCode }), /did not request/);
  await service.approve({ ...financialApproval, verificationCode: readonly.verificationCode, writeBudgetIds: [] });
  const readonlyTokens = await service.poll(readonly.deviceCode);
  await assert.rejects(write(readonlyTokens.accessToken));
  // Historical records without a scope must remain read-only through renewal.
  const historical = (await sql("SELECT state_json FROM app_devices WHERE id = ?", [readonlyTokens.deviceId]))[0];
  const historicalState = JSON.parse(historical.state_json);
  delete historicalState.scope; delete historicalState.writeBudgetIds;
  await sql("UPDATE app_devices SET state_json = ? WHERE id = ?", [JSON.stringify(historicalState), readonlyTokens.deviceId]);
  const renewedReadonly = await service.renew(readonlyTokens.renewalToken);
  assert.equal(renewedReadonly.scope, "app:snapshot:read");
  await assert.rejects(write(renewedReadonly.accessToken));
  await service.revoke("device-user", readonlyTokens.deviceId);
  // Other approved pairings may consume the remaining slots between approval
  // and exchange. A terminal denial must not later become an enrollment.
  const cappedPairing = await service.createPairing("Capacity race");
  await approve(cappedPairing);
  for (let index = 0; index < 20; index += 1) {
    await sql("INSERT INTO app_devices (id, account_id, state_json) VALUES (?, 'device-user', '{}')", [`capacity-${index}`]);
  }
  assert.equal((await service.poll(cappedPairing.deviceCode)).status, "denied");
  for (let index = 0; index < 20; index += 1) {
    await sql("DELETE FROM app_devices WHERE id = ?", [`capacity-${index}`]);
  }
  clock += 5001;
  assert.equal((await service.poll(cappedPairing.deviceCode)).status, "denied");
  const enroll = async () => {
    const pairing = await service.createPairing("Test phone");
    await approve(pairing);
    const results = await Promise.all([service.poll(pairing.deviceCode), peer.poll(pairing.deviceCode)]);
    assert.equal(results.filter(result => result.status === "approved").length, 1);
    return results.find(result => result.status === "approved");
  };

  // Approval, persisted-device validation and the Android contract all allow
  // 100 grants. Exercise beyond the former 50-grant active-device cutoff.
  const largeGrant = ["device-budget"];
  for (let index = 1; index <= 50; index += 1) {
    const id = `grant-budget-${index}`;
    await sql("INSERT INTO budgets (id, storage_key, display_name, status, created_by_account_id, created_at, updated_at) VALUES (?, ?, 'Grant test', 'active', 'device-user', ?, ?)", [id, id, stamp, stamp]);
    await sql("INSERT INTO budget_memberships (budget_id, account_id, role, created_at, updated_at) VALUES (?, 'device-user', 'owner', ?, ?)", [id, stamp, stamp]);
    largeGrant.push(id);
  }
  const largePairing = await service.createPairing("Many budgets");
  await service.approve({ verificationCode: largePairing.verificationCode, accountId: "device-user",
    sessionId: "device-session", budgetIds: largeGrant });
  const largeTokens = await service.poll(largePairing.deviceCode);
  assert.equal(largeTokens.status, "approved");
  assert.deepEqual(largeTokens.budgetIds, largeGrant);
  await service.authorize(largeTokens.accessToken, largeGrant.at(-1));
  const largeRenewal = await service.renew(largeTokens.renewalToken);
  assert.deepEqual(largeRenewal.budgetIds, largeGrant);
  await service.authorize(largeRenewal.accessToken, largeGrant.at(-1));
  await service.revoke("device-user", largeTokens.deviceId);

  await assert.rejects(service.createPairing("\n"));
  const pairing = await service.createPairing("Phone");
  assert.equal((await service.poll(pairing.deviceCode)).status, "pending");
  assert.equal((await service.poll(pairing.deviceCode)).status, "slow_down");
  await sql("UPDATE auth_sessions SET auth_method = 'none' WHERE id = 'device-session'");
  await assert.rejects(approve(pairing), /Recent verified/);
  await sql("UPDATE auth_sessions SET auth_method = 'internal' WHERE id = 'device-session'");
  // SQLite text columns can contain malformed timestamps; PostgreSQL rejects
  // them at insertion because these columns are typed timestamptz.
  if (globalStore.backend !== "postgres") {
    await sql("UPDATE auth_sessions SET idle_expires_at = 'invalid' WHERE id = 'device-session'");
    await assert.rejects(approve(pairing), /Recent verified/);
    await sql("UPDATE auth_sessions SET idle_expires_at = ?, absolute_expires_at = 'invalid' WHERE id = 'device-session'", [new Date(clock + 3600000).toISOString()]);
    await assert.rejects(approve(pairing), /Recent verified/);
    await sql("UPDATE auth_sessions SET absolute_expires_at = ? WHERE id = 'device-session'", [new Date(clock + 86400000).toISOString()]);
  }
  clock += 5001;
  await approve(pairing);
  await assert.rejects(approve(pairing), /Invalid or expired/);
  const tokens = await service.poll(pairing.deviceCode);
  assert.equal(tokens.status, "approved");
  assert.equal((await service.poll(pairing.deviceCode)).status, "expired");
  assert.equal((await service.authorize(tokens.accessToken, "device-budget")).accountId, "device-user");
  await assert.rejects(service.authorize(tokens.accessToken, "other-budget"));
  await assert.rejects(service.authorize(tokens.renewalToken, "device-budget"));
  const renewed = await service.renew(tokens.renewalToken);
  assert.notEqual(renewed.renewalToken, tokens.renewalToken);
  await assert.rejects(service.renew(tokens.renewalToken));
  await assert.rejects(service.authorize(renewed.accessToken, "device-budget"));

  const fresh = await enroll();
  await service.revoke("someone-else", fresh.deviceId);
  await service.authorize(fresh.accessToken, "device-budget");
  await sql("UPDATE accounts SET status = 'disabled' WHERE id = 'device-user'");
  await assert.rejects(service.authorize(fresh.accessToken, "device-budget"));
  await sql("UPDATE accounts SET status = 'active' WHERE id = 'device-user'");
  await service.revoke("device-user", fresh.deviceId);
  await assert.rejects(service.renew(fresh.renewalToken));
  assert.equal((await service.list("device-user")).find(d => d.id === fresh.deviceId).revoked, true);

  const corrupted = await enroll();
  const original = (await sql("SELECT state_json FROM app_devices WHERE id = ?", [corrupted.deviceId]))[0].state_json;
  for (const changed of [
    "{invalid", "null", "[]",
    JSON.stringify({ ...JSON.parse(original), absoluteExpiresMs: "invalid" }),
    JSON.stringify({ ...JSON.parse(original), absoluteExpiresMs: null }),
    JSON.stringify({ ...JSON.parse(original), budgetIds: "device-budget" }),
    JSON.stringify({ ...JSON.parse(original), createdMs: clock + 1000 })
  ]) {
    await sql("UPDATE app_devices SET state_json = ? WHERE id = ?", [changed, corrupted.deviceId]);
    await assert.rejects(service.authorize(corrupted.accessToken, "device-budget"));
    await assert.rejects(service.renew(corrupted.renewalToken));
    await service.list("device-user");
  }
  await sql("UPDATE app_devices SET state_json = ? WHERE id = ?", [original, corrupted.deviceId]);
  await service.authorize(corrupted.accessToken, "device-budget");
  // JSON may not override the authoritative SQL revocation column.
  await sql("UPDATE app_devices SET state_json = ? WHERE id = ?", [JSON.stringify({ ...JSON.parse(original), revoked_ms: null }), corrupted.deviceId]);
  await service.revoke("device-user", corrupted.deviceId);
  await assert.rejects(service.authorize(corrupted.accessToken, "device-budget"));

  if (globalStore.backend !== "postgres") {
    const invalidExpiry = await enroll();
    await sql("UPDATE app_device_tokens SET expires_ms = 'invalid' WHERE device_id = ?", [invalidExpiry.deviceId]);
    await assert.rejects(service.authorize(invalidExpiry.accessToken, "device-budget"));
    await assert.rejects(service.renew(invalidExpiry.renewalToken));
    const challenge = await service.createPairing("Invalid expiry");
    await sql("UPDATE app_device_pairings SET expires_ms = 'invalid' WHERE status = 'pending'");
    await assert.rejects(approve(challenge), /Invalid or expired/);
    assert.equal((await service.poll(challenge.deviceCode)).status, "expired");
    await assert.rejects(service.inspectPairing(challenge.verificationCode), /Invalid or expired/);
  }

  const rotation = await enroll();
  const attempts = await Promise.allSettled([service.renew(rotation.renewalToken), peer.renew(rotation.renewalToken)]);
  assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
  await assert.rejects(service.authorize(attempts.find(r => r.status === "fulfilled").value.accessToken, "device-budget"));

  const expiry = await enroll();
  const identity = await enroll();
  await sql("UPDATE app_device_instance SET instance_id = 'rotated-test-instance' WHERE id = 1");
  await assert.rejects(service.authorize(identity.accessToken, "device-budget"));
  await assert.rejects(service.renew(identity.renewalToken));
  const configuration = await enroll();
  await sql("UPDATE auth_config SET active_mode = 'none' WHERE id = 1");
  await assert.rejects(service.authorize(configuration.accessToken, "device-budget"));
  await sql("UPDATE auth_config SET active_mode = 'internal' WHERE id = 1");
  const membership = await enroll();
  const beforeExchange = await service.createPairing("Membership lost before exchange");
  await approve(beforeExchange);
  await sql("UPDATE budgets SET status = 'archived' WHERE id = 'device-budget'");
  assert.equal((await service.poll(beforeExchange.deviceCode)).status, "denied");
  await assert.rejects(service.renew(membership.renewalToken));
  await assert.rejects(service.authorize(membership.accessToken, "device-budget"));
  await sql("UPDATE budgets SET status = 'active' WHERE id = 'device-budget'");
  clock += 5001;
  assert.equal((await service.poll(beforeExchange.deviceCode)).status, "denied");
  await assert.rejects(service.authorize(membership.accessToken, "device-budget"));
  await assert.rejects(service.renew(membership.renewalToken));
  clock += 15 * 60000;
  await assert.rejects(service.authorize(expiry.accessToken, "device-budget"));
  await assert.rejects(approve(await service.createPairing("Old login")), /Recent verified/);
  const stored = JSON.stringify(await sql("SELECT * FROM app_device_tokens"));
  assert.ok(!stored.includes(expiry.accessToken));
  assert.ok(!stored.includes(expiry.renewalToken));
  const audit = JSON.stringify(await sql("SELECT action, details_json FROM security_audit_log WHERE target_type = 'device'"));
  assert.match(audit, /device.enrolled/);
  assert.match(audit, /device.renewal_reuse_revoked/);
  assert.match(audit, /device.revoked/);
  assert.ok(!audit.includes(expiry.accessToken));
}

test("SQLite device enrollment, rotation, replay revocation, scope and expiry", async () => {
  const db = new Database(":memory:");
  try {
    db.pragma("foreign_keys = ON");
    initializeGlobalSchema(db);
    applyGlobalMigrations(db);
    await exercise({ withRepository: callback => callback({ backend: "sqlite" }, db) });
  } finally { db.close(); }
});

test("PostgreSQL device enrollment and transactional rotation", {
  skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests"
}, async () => {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const globalStore = await createPostgresGlobalStore({ databaseUrl });
    try {
      await globalStore.initialize();
      await exercise(globalStore, pool);
    } finally { await globalStore.close(); }
  });
});