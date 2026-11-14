import assert from "node:assert/strict";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";

async function verifyFlow(databaseConfig) {
  let duringSnapshot = async () => {};
  const harness = await createCashflowTestHarness({ initializeUser: false, databaseConfig,
    appSnapshotReadHook: () => duringSnapshot() });
  try {
    await harness.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: "phone-owner", displayName: "Owner", email: "phone@example.test" } });
    const disabled = await harness.request("/api/device/pairings", { method: "POST", skipUserHeader: true, body: { label: "Phone" } });
    assert.equal(disabled.response.status, 403);
    await harness.api("/api/account/password", { method: "POST", useSession: true,
      body: { newPassword: "phone owner correct horse" } });
    await harness.api("/api/admin/auth/draft", { method: "PUT", useSession: true, body: { draftMode: "internal" } });
    await harness.api("/api/admin/auth/activate", { method: "POST", useSession: true, body: {} });
    await harness.api("/api/auth/internal/login", { method: "POST", skipUserHeader: true,
      body: { email: "phone@example.test", password: "phone owner correct horse" } });
    const pairing = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true, body: { label: "Android test" } });
    const csrfFailure = await harness.request("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      headers: { "x-cashflow-csrf-token": "incorrect" }, body: { verificationCode: pairing.verificationCode, budgetIds: ["phone-owner"] } });
    assert.equal(csrfFailure.response.status, 403);
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: pairing.verificationCode, budgetIds: ["phone-owner"] } });
    const tokens = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true, body: { deviceCode: pairing.deviceCode } });
    assert.equal(tokens.status, "approved");
    assert.equal(tokens.scope, "app:snapshot:read");
    // Read-only credentials keep their original envelope.
    assert.equal(Object.hasOwn(tokens, "accountId"), false);
    const syncPairing = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true,
      body: { label: "Explicit financial grant", scope: "app:financial:sync" } });
    const syncReview = await harness.api("/api/account/device-pairings/inspect", { method: "POST", useSession: true,
      body: { verificationCode: syncPairing.verificationCode } });
    assert.equal(syncReview.scope, "app:financial:sync");
    const creationWithoutWrites = await harness.request("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: syncPairing.verificationCode, budgetIds: ["phone-owner"], mayCreateBudgets: true } });
    assert.equal(creationWithoutWrites.response.status, 403);
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: syncPairing.verificationCode, budgetIds: ["phone-owner"], writeBudgetIds: ["phone-owner"], mayCreateBudgets: true } });
    const syncTokens = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true,
      body: { deviceCode: syncPairing.deviceCode } });
    assert.equal(syncTokens.scope, "app:financial:sync");
    assert.deepEqual(syncTokens.writeBudgetIds, ["phone-owner"]);
    assert.equal(syncTokens.accountId, "phone-owner");
    assert.equal(syncTokens.mayCreateBudgets, true);
    // Invalid setup must fail before account metadata/storage is allocated.
    // Otherwise a typo or an unsupported currency leaves an ungranted orphan
    // budget, and retrying from the phone creates another one.
    const beforeInvalidCreation = (await harness.api("/api/budgets", { useSession: true })).budgets.map(row => row.id).sort();
    for (const invalid of [{ currency: "XYZ" }, { openingBalance: -1 }, { openingBalance: "invalid" },
      { timezone: "Invalid/Timezone" }, { locale: "unavailable-locale" }, { holidayCountry: "XX" }]) {
      const refused = await harness.request("/api/device/budgets", { method: "POST", skipUserHeader: true,
        headers: { authorization: `Bearer ${syncTokens.accessToken}` },
        body: { name: "Invalid phone budget", currency: "EUR", openingBalance: 250, ...invalid } });
      assert.equal(refused.response.status, 400);
      assert.deepEqual((await harness.api("/api/budgets", { useSession: true })).budgets.map(row => row.id).sort(), beforeInvalidCreation);
    }
    // A permitted device creates an account-owned budget granted to it alone.
    const created = await harness.api("/api/device/budgets", { method: "POST", skipUserHeader: true,
      headers: { authorization: `Bearer ${syncTokens.accessToken}` }, body: { name: "Phone-made budget", currency: "EUR", openingBalance: 250 } });
    assert.match(created.budgetId, /^budget_/);
    assert.equal(created.name, "Phone-made budget");
    assert.deepEqual(created.budgetIds, ["phone-owner", created.budgetId]);
    assert.deepEqual(created.writeBudgetIds, ["phone-owner", created.budgetId]);
    const createdSnapshot = await harness.api("/api/app/snapshot", { skipUserHeader: true,
      headers: { authorization: `Bearer ${syncTokens.accessToken}`, "x-cashflow-budget-id": created.budgetId } });
    assert.equal(createdSnapshot.request.settings.ledger_currency, "EUR");
    // Catalog labels are limited to this device's currently granted budgets,
    // never every budget the account owns. The identity echo binds the cache.
    const catalog = await harness.api("/api/device/budgets", { skipUserHeader: true,
      headers: { authorization: `Bearer ${syncTokens.accessToken}` } });
    assert.equal(catalog.instanceId, syncTokens.instanceId);
    assert.equal(catalog.accountId, "phone-owner");
    assert.deepEqual(catalog.budgets.map(row => row.id).sort(), ["phone-owner", created.budgetId].sort());
    assert.equal(catalog.budgets.find(row => row.id === created.budgetId).name, "Phone-made budget");
    await harness.api(`/api/budgets/${created.budgetId}`, { method: "PUT", useSession: true, body: { displayName: "Renamed phone budget" } });
    const renamedCatalog = await harness.api("/api/device/budgets", { skipUserHeader: true,
      headers: { authorization: `Bearer ${syncTokens.accessToken}` } });
    assert.equal(renamedCatalog.budgets.find(row => row.id === created.budgetId).name, "Renamed phone budget");
    const ungranted = await harness.api("/api/budgets", { method: "POST", useSession: true, body: { displayName: "Not granted to phone" } });
    assert.ok(!(await harness.api("/api/device/budgets", { skipUserHeader: true,
      headers: { authorization: `Bearer ${syncTokens.accessToken}` } })).budgets.some(row => row.id === ungranted.budget.id));
    assert.equal((await harness.request("/api/device/budgets", { skipUserHeader: true,
      headers: { authorization: `Bearer ${tokens.accessToken}` } })).response.status, 401);
    assert.equal((await harness.request("/api/device/budgets", { useSession: true,
      headers: { authorization: `Bearer ${syncTokens.accessToken}` } })).response.status, 401);
    const owned = (await harness.api("/api/budgets", { useSession: true })).budgets.find(budget => budget.id === created.budgetId);
    assert.equal(owned.role, "owner");
    const syncDevice = (await harness.api("/api/account/devices", { useSession: true })).devices.find(device => device.id === syncTokens.deviceId);
    assert.equal(syncDevice.mayCreateBudgets, true);
    // Without the permission (read-only or a plain sync grant) and from a browser, creation is refused.
    for (const headers of [{ authorization: `Bearer ${tokens.accessToken}` }, {}]) {
      const refused = await harness.request("/api/device/budgets", { method: "POST", skipUserHeader: true, headers, body: { name: "Refused" } });
      assert.equal(refused.response.status, 401);
    }
    const plainPairing = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true,
      body: { label: "Sync without creation", scope: "app:financial:sync" } });
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: plainPairing.verificationCode, budgetIds: ["phone-owner"], writeBudgetIds: ["phone-owner"] } });
    const plainTokens = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true, body: { deviceCode: plainPairing.deviceCode } });
    assert.equal(plainTokens.mayCreateBudgets, false);
    assert.deepEqual((await harness.api("/api/device/budgets", { skipUserHeader: true,
      headers: { authorization: `Bearer ${plainTokens.accessToken}` } })).budgets.map(row => row.id), ["phone-owner"]);
    assert.equal((await harness.request("/api/device/budgets", { method: "POST", skipUserHeader: true,
      headers: { authorization: `Bearer ${plainTokens.accessToken}` }, body: { name: "Refused" } })).response.status, 401);
    assert.equal((await harness.request("/api/app/snapshot", { skipUserHeader: true,
      headers: { authorization: `Bearer ${plainTokens.accessToken}`, "x-cashflow-budget-id": created.budgetId } })).response.status, 401);
    // A paired phone acts with the account's own role in granted budgets: a write grant
    // changes settings and manages sharing; a read grant only reads; nothing account-wide.
    const writer = { authorization: `Bearer ${syncTokens.accessToken}`, "x-cashflow-budget-id": "phone-owner" };
    const reader = { authorization: `Bearer ${tokens.accessToken}`, "x-cashflow-budget-id": "phone-owner" };
    await harness.api("/api/settings", { method: "PUT", skipUserHeader: true, headers: writer, body: { notify_goal_funded: 1 } });
    const changed = await harness.api("/api/app/snapshot", { skipUserHeader: true, headers: writer });
    assert.equal(Number(changed.request.settings.notify_goal_funded), 1);
    assert.equal((await harness.request("/api/settings", { method: "PUT", skipUserHeader: true, headers: reader,
      body: { notify_goal_funded: 0 } })).response.status, 403);
    const members = await harness.api("/api/budgets/phone-owner/members", { skipUserHeader: true, headers: writer });
    assert.ok(JSON.stringify(members).includes("phone-owner"));
    const invitation = await harness.api("/api/budgets/phone-owner/invitations", { method: "POST", skipUserHeader: true, headers: writer,
      body: { email: "friend@example.test", role: "viewer", expiresInHours: 24 } });
    assert.match(invitation.invitation.token, /^[A-Za-z0-9_-]{20,}$/);
    // The budget in the path must be the granted, selected one; account, admin and
    // device-approval routes and money routes (sync v1 only) refuse device tokens.
    assert.equal((await harness.request(`/api/budgets/${created.budgetId}/members`, { skipUserHeader: true, headers: writer })).response.status, 401);
    for (const [route, method] of [["/api/account/devices", "GET"], ["/api/account/device-pairings/approve", "POST"],
      ["/api/admin/options", "GET"], ["/api/one-off", "POST"], ["/api/budgets", "GET"], ["/api/invitations/accept", "POST"]]) {
      const refused = await harness.request(route, { method, skipUserHeader: true, headers: writer, ...(method === "POST" ? { body: {} } : {}) });
      assert.equal(refused.response.status, 401, `${method} ${route}`);
    }
    const headers = { authorization: `Bearer ${tokens.accessToken}`, "x-cashflow-budget-id": "phone-owner" };
    const snapshot = await harness.api("/api/app/snapshot", { skipUserHeader: true, headers });
    assert.doesNotThrow(() => calculateSnapshot(snapshot));
    for (const injectedStatus of [undefined, 503, 302, 200, 401.5]) {
      duringSnapshot = async () => {
        throw Object.assign(new Error("private-database-host secret-query-marker"), {
          status: injectedStatus, details: { credential: "secret-detail-marker" }, conflicts: ["secret-conflict-marker"]
        });
      };
      const failure = await harness.request("/api/app/snapshot", { skipUserHeader: true, headers });
      assert.equal(failure.response.status, 500);
      assert.equal(failure.response.headers.get("cache-control"), "no-store");
      assert.deepEqual(failure.body, { error: "Failed to prepare app snapshot" });
    }
    duringSnapshot = async () => {};
    for (const route of ["/api", "/api/account", "/api/admin/options"]) {
      const denied = await harness.request(route, { skipUserHeader: true, headers });
      assert.equal(denied.response.status, 401);
    }
    const mixed = await harness.request("/api/app/snapshot", { useSession: true, headers });
    assert.equal(mixed.response.status, 401);
    const other = await harness.request("/api/app/snapshot", { skipUserHeader: true,
      headers: { ...headers, "x-cashflow-budget-id": "not-owned" } });
    assert.equal(other.response.status, 401);
    const devices = await harness.api("/api/account/devices", { useSession: true });
    assert.equal(devices.devices[0].label, "Android test");
    // Hold the export at its first read, revoke through the real browser API,
    // then finish reading. The second authorization must withhold the payload.
    let revokedDuringExport = false;
    duringSnapshot = async () => {
      if (revokedDuringExport) return;
      revokedDuringExport = true;
      await harness.api(`/api/account/devices/${tokens.deviceId}`, { method: "DELETE", useSession: true });
    };
    try {
      const interrupted = await harness.request("/api/app/snapshot", { skipUserHeader: true, headers });
      assert.equal(revokedDuringExport, true);
      assert.equal(interrupted.response.status, 401);
      assert.equal(interrupted.body?.request, undefined);
      assert.equal(interrupted.response.headers.get("cache-control"), "no-store");
    } finally { duringSnapshot = async () => {}; }
    await harness.api(`/api/account/devices/${tokens.deviceId}`, { method: "DELETE", useSession: true });
    const revoked = await harness.request("/api/app/snapshot", { skipUserHeader: true, headers });
    assert.equal(revoked.response.status, 401);
    const newPairing = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true, body: { label: "Before auth reconfiguration" } });
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: newPairing.verificationCode, budgetIds: ["phone-owner"] } });
    const reconfigured = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true,
      body: { deviceCode: newPairing.deviceCode } });
    const pendingAtActivation = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true,
      body: { label: "Pending during reconfiguration" } });
    const approvedAtActivation = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true,
      body: { label: "Approved but not redeemed" } });
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: approvedAtActivation.verificationCode, budgetIds: ["phone-owner"] } });
    await harness.api("/api/admin/auth/draft", { method: "PUT", useSession: true, body: { draftMode: "internal" } });
    await harness.api("/api/admin/auth/activate", { method: "POST", useSession: true, body: {} });
    const afterConfiguration = await harness.request("/api/app/snapshot", { skipUserHeader: true,
      headers: { ...headers, authorization: `Bearer ${reconfigured.accessToken}` } });
    assert.equal(afterConfiguration.response.status, 401);
    for (const challenge of [pendingAtActivation, approvedAtActivation]) {
      const denied = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true,
        body: { deviceCode: challenge.deviceCode } });
      assert.equal(denied.status, "denied");
    }
    const selfPairing = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true, body: { label: "Self revoke" } });
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: selfPairing.verificationCode, budgetIds: ["phone-owner"] } });
    const self = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true, body: { deviceCode: selfPairing.deviceCode } });
    const rotated = await harness.api("/api/device/renew", { method: "POST", skipUserHeader: true, body: { renewalToken: self.renewalToken } });
    const mixedRevoke = await harness.request("/api/device/revoke", { method: "POST", useSession: true,
      body: { renewalToken: rotated.renewalToken } });
    assert.equal(mixedRevoke.response.status, 401);
    // A consumed token can still revoke its own family after a response was lost.
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await harness.api("/api/device/revoke", { method: "POST", skipUserHeader: true,
        body: { renewalToken: self.renewalToken } }), { revoked: true });
    }
    assert.equal((await harness.request("/api/app/snapshot", { skipUserHeader: true,
      headers: { ...headers, authorization: `Bearer ${rotated.accessToken}` } })).response.status, 401);
    assert.equal((await harness.request("/api/device/renew", { method: "POST", skipUserHeader: true,
      body: { renewalToken: rotated.renewalToken } })).response.status, 401);
  } finally { await harness.cleanup(); }
}

test("browser-approved devices act with the account role only in granted budgets", () => verifyFlow());

async function verifyDeviceSettingsAndExportSecrets(databaseConfig) {
  const harness = await createCashflowTestHarness({ initializeUser: false, databaseConfig });
  try {
    await harness.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: "phone-owner", displayName: "Owner", email: "phone@example.test" } });
    await harness.api("/api/account/password", { method: "POST", useSession: true,
      body: { newPassword: "phone owner correct horse" } });
    await harness.api("/api/admin/auth/draft", { method: "PUT", useSession: true, body: { draftMode: "internal" } });
    await harness.api("/api/admin/auth/activate", { method: "POST", useSession: true, body: {} });
    await harness.api("/api/auth/internal/login", { method: "POST", skipUserHeader: true,
      body: { email: "phone@example.test", password: "phone owner correct horse" } });
    await harness.api("/api/budgets/phone-owner/select", { method: "POST", useSession: true, body: {} });

    await harness.api("/api/admin/options", {
      method: "PUT",
      useSession: true,
      body: { ntfy_allowed_private_hosts: ["127.0.0.1"] }
    });
    const browserSaved = await harness.api("/api/settings", {
      method: "PUT",
      useSession: true,
      body: {
        notification_channels: ["ntfy"],
        ntfy_url: "https://127.0.0.1/browser-topic",
        ntfy_auth_token: "tk_secret_browser_token"
      }
    });
    assert.equal(browserSaved.ntfy_url, "https://127.0.0.1/browser-topic");
    assert.equal(browserSaved.ntfy_auth_token, "tk_secret_browser_token");
    assert.equal(Object.hasOwn(browserSaved, "discord_webhook_url"), true);
    assert.equal(Object.hasOwn(browserSaved, "backup_location"), true);

    const syncPairing = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true,
      body: { label: "Settings phone", scope: "app:financial:sync" } });
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: syncPairing.verificationCode, budgetIds: ["phone-owner"], writeBudgetIds: ["phone-owner"] } });
    const syncTokens = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true,
      body: { deviceCode: syncPairing.deviceCode } });
    const writer = { authorization: `Bearer ${syncTokens.accessToken}`, "x-cashflow-budget-id": "phone-owner" };

    for (const disallowedBody of [
      { ledger_currency: "EUR" },
      { backup_location: "/tmp/device-attempt" },
      { auto_backup_enabled: 1 },
      { future_periods: 6 },
      { unknown_key: 1 }
    ]) {
      const refused = await harness.request("/api/settings", {
        method: "PUT",
        skipUserHeader: true,
        headers: writer,
        body: disallowedBody
      });
      assert.equal(refused.response.status, 400, `device PUT /api/settings should reject ${JSON.stringify(disallowedBody)}`);
    }

    // CFSEC-01: a writer may supply a new token, but cannot move the
    // browser's retained secret to a different destination by omission.
    const destinationOnly = await harness.request("/api/settings", {
      method: "PUT", skipUserHeader: true, headers: writer,
      body: { ntfy_url: "https://127.0.0.1/device-topic" }
    });
    assert.equal(destinationOnly.response.status, 409);
    const retained = (await harness.api("/api/export/full?includeOperationalSettings=1", { useSession: true })).planning.settings[0];
    assert.equal(retained.ntfy_url, "https://127.0.0.1/browser-topic");
    assert.equal(retained.ntfy_auth_token, "tk_secret_browser_token");

    const deviceSaved = await harness.api("/api/settings", {
      method: "PUT",
      skipUserHeader: true,
      headers: writer,
      body: {
        notification_channels: ["ntfy"],
        ntfy_url: "https://127.0.0.1/device-topic",
        ntfy_auth_token: "tk_device_replacement",
        discord_webhook_url: "",
        notify_goal_funded: 1,
        ntfy_priority_goal_funded: "high"
      }
    });
    assert.equal(Number(deviceSaved.notify_goal_funded), 1);
    assert.equal(deviceSaved.ntfy_priority_goal_funded, "high");
    for (const secretField of ["ntfy_url", "ntfy_auth_token", "discord_webhook_url", "backup_location"]) {
      assert.equal(Object.hasOwn(deviceSaved, secretField), false, `device PUT /api/settings response leaked ${secretField}`);
    }

    for (const exportPath of [
      "/api/export/full?includeOperationalSettings=1",
      "/api/budgets/phone-owner/export?includeOperationalSettings=1"
    ]) {
      const exported = await harness.api(exportPath, { skipUserHeader: true, headers: writer });
      assert.equal(exported.operationalSettingsIncluded, false, exportPath);
      const exportedSettings = exported.planning.settings[0];
      for (const secretField of ["ntfy_url", "ntfy_auth_token", "discord_webhook_url", "backup_location"]) {
        assert.equal(Object.hasOwn(exportedSettings, secretField), false, `${exportPath} leaked ${secretField}`);
      }
    }

    const browserExport = await harness.api("/api/budgets/phone-owner/export?includeOperationalSettings=1", { useSession: true });
    assert.equal(browserExport.operationalSettingsIncluded, true);
    assert.equal(browserExport.planning.settings[0].ntfy_auth_token, "tk_device_replacement");
  } finally {
    await harness.cleanup();
  }
}

async function verifyBrowserSessionExpiryDoesNotRevokeDevices(databaseConfig) {
  let sessionMs = Date.now();
  const harness = await createCashflowTestHarness({
    initializeUser: false,
    databaseConfig,
    deviceNow: () => sessionMs,
    sessionNow: () => new Date(sessionMs)
  });
  try {
    await harness.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: "phone-owner", displayName: "Owner", email: "phone@example.test" } });
    await harness.api("/api/account/password", { method: "POST", useSession: true,
      body: { newPassword: "phone owner correct horse" } });
    await harness.api("/api/admin/auth/draft", { method: "PUT", useSession: true, body: { draftMode: "internal" } });
    await harness.api("/api/admin/auth/activate", { method: "POST", useSession: true, body: {} });
    await harness.api("/api/auth/internal/login", { method: "POST", skipUserHeader: true,
      body: { email: "phone@example.test", password: "phone owner correct horse" } });
    await harness.api("/api/admin/options", {
      method: "PUT",
      useSession: true,
      body: { device_access_minutes: 1440 }
    });

    const pairing1 = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true, body: { label: "Survives expiry" } });
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: pairing1.verificationCode, budgetIds: ["phone-owner"] } });
    const device1 = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true,
      body: { deviceCode: pairing1.deviceCode } });

    // 1. Advance past the 12h browser idle expiry (while the 24h device access token is still valid)
    // and use the browser cookie to trigger activeSessionRow's expiry path.
    sessionMs += 13 * 3_600_000;
    const idleExpiredBrowser = await harness.request("/api/account", { useSession: true });
    assert.equal(idleExpiredBrowser.response.status, 401);

    const snapshotAfterIdleExpiry = await harness.request("/api/app/snapshot", {
      skipUserHeader: true,
      headers: { authorization: `Bearer ${device1.accessToken}`, "x-cashflow-budget-id": "phone-owner" }
    });
    assert.equal(snapshotAfterIdleExpiry.response.status, 200);

    // 2. Advance past the 7d browser absolute expiry and verify device renewal + access still work.
    sessionMs += 8 * 86_400_000;
    const renewedAfterExpiry = await harness.request("/api/device/renew", {
      method: "POST",
      skipUserHeader: true,
      body: { renewalToken: device1.renewalToken }
    });
    assert.equal(renewedAfterExpiry.response.status, 200);
    const snapshotAfterAbsoluteExpiry = await harness.request("/api/app/snapshot", {
      skipUserHeader: true,
      headers: { authorization: `Bearer ${renewedAfterExpiry.body.accessToken}`, "x-cashflow-budget-id": "phone-owner" }
    });
    assert.equal(snapshotAfterAbsoluteExpiry.response.status, 200);

    // Explicit logout of an approving session must still block devices approved by that session.
    await harness.api("/api/auth/internal/login", { method: "POST", skipUserHeader: true,
      body: { email: "phone@example.test", password: "phone owner correct horse" } });
    const pairing2 = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true, body: { label: "Blocked on logout" } });
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: pairing2.verificationCode, budgetIds: ["phone-owner"] } });
    const device2 = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true,
      body: { deviceCode: pairing2.deviceCode } });
    await harness.api("/api/logout", { method: "POST", useSession: true, body: {} });
    const afterLogout = await harness.request("/api/app/snapshot", {
      skipUserHeader: true,
      headers: { authorization: `Bearer ${device2.accessToken}`, "x-cashflow-budget-id": "phone-owner" }
    });
    assert.equal(afterLogout.response.status, 401);
  } finally {
    await harness.cleanup();
  }
}

async function verifyAccountCredentialChangesRevokeDevices(databaseConfig) {
  const harness = await createCashflowTestHarness({ initializeUser: false, databaseConfig });
  try {
    await harness.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: "phone-owner", displayName: "Owner", email: "phone@example.test" } });
    await harness.api("/api/account/password", { method: "POST", useSession: true,
      body: { newPassword: "phone owner correct horse" } });
    await harness.api("/api/admin/auth/draft", { method: "PUT", useSession: true, body: { draftMode: "internal" } });
    await harness.api("/api/admin/auth/activate", { method: "POST", useSession: true, body: {} });
    await harness.api("/api/auth/internal/login", { method: "POST", skipUserHeader: true,
      body: { email: "phone@example.test", password: "phone owner correct horse" } });

    const pairDevice = async label => {
      const p = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true, body: { label } });
      await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
        body: { verificationCode: p.verificationCode, budgetIds: ["phone-owner"] } });
      return await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true, body: { deviceCode: p.deviceCode } });
    };

    // 1. Password change revokes devices (including those approved by the current session).
    const d1 = await pairDevice("Before password change");
    await harness.api("/api/account/password", {
      method: "POST",
      useSession: true,
      body: { currentPassword: "phone owner correct horse", newPassword: "phone owner battery staple" }
    });
    assert.equal((await harness.request("/api/app/snapshot", {
      skipUserHeader: true,
      headers: { authorization: `Bearer ${d1.accessToken}`, "x-cashflow-budget-id": "phone-owner" }
    })).response.status, 401);

    // 2. Password removal revokes devices.
    await harness.api("/api/admin/auth/providers/google-test", {
      method: "PUT",
      useSession: true,
      body: {
        kind: "google",
        displayName: "Google",
        enabled: true,
        issuer: "https://accounts.google.com",
        clientId: "client-1",
        redirectUri: "https://example.com/api/auth/providers/google-test/callback"
      }
    });
    await harness.api("/api/admin/accounts/phone-owner/provider-identities/google-test", {
      method: "PUT",
      useSession: true,
      body: { subject: "google-sub-1", email: "phone@example.test" }
    });
    const d2 = await pairDevice("Before password removal");
    await harness.api("/api/account/password", {
      method: "DELETE",
      useSession: true,
      body: { currentPassword: "phone owner battery staple" }
    });
    assert.equal((await harness.request("/api/app/snapshot", {
      skipUserHeader: true,
      headers: { authorization: `Bearer ${d2.accessToken}`, "x-cashflow-budget-id": "phone-owner" }
    })).response.status, 401);

    // 3. External/provider identity unlink revokes devices.
    await harness.api("/api/account/password", {
      method: "POST",
      useSession: true,
      body: { newPassword: "phone owner restored password" }
    });
    const d3 = await pairDevice("Before identity unlink");
    const ownAccount = (await harness.api("/api/account", { useSession: true })).account;
    const linkedIdentity = ownAccount.identities.find(item => item.providerId === "google-test");
    assert.ok(linkedIdentity?.id);
    await harness.api(`/api/account/identities/${linkedIdentity.id}`, {
      method: "DELETE",
      useSession: true
    });
    assert.equal((await harness.request("/api/app/snapshot", {
      skipUserHeader: true,
      headers: { authorization: `Bearer ${d3.accessToken}`, "x-cashflow-budget-id": "phone-owner" }
    })).response.status, 401);
  } finally {
    await harness.cleanup();
  }
}

async function verifyDeviceBudgetCreationRollbackOnFailure(databaseConfig) {
  let offsetMs = 0;
  let advanceAfterNextDeviceNowMs = 0;
  const harness = await createCashflowTestHarness({
    initializeUser: false,
    databaseConfig,
    deviceNow: () => {
      const current = Date.now() + offsetMs;
      if (advanceAfterNextDeviceNowMs > 0) {
        offsetMs += advanceAfterNextDeviceNowMs;
        advanceAfterNextDeviceNowMs = 0;
      }
      return current;
    }
  });
  try {
    await harness.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: "phone-owner", displayName: "Owner", email: "phone@example.test" } });
    await harness.api("/api/account/password", { method: "POST", useSession: true,
      body: { newPassword: "phone owner correct horse" } });
    await harness.api("/api/admin/auth/draft", { method: "PUT", useSession: true, body: { draftMode: "internal" } });
    await harness.api("/api/admin/auth/activate", { method: "POST", useSession: true, body: {} });
    await harness.api("/api/auth/internal/login", { method: "POST", skipUserHeader: true,
      body: { email: "phone@example.test", password: "phone owner correct horse" } });

    const syncPairing = await harness.api("/api/device/pairings", { method: "POST", skipUserHeader: true,
      body: { label: "Budget creator", scope: "app:financial:sync" } });
    await harness.api("/api/account/device-pairings/approve", { method: "POST", useSession: true,
      body: { verificationCode: syncPairing.verificationCode, budgetIds: ["phone-owner"], writeBudgetIds: ["phone-owner"], mayCreateBudgets: true } });
    const syncTokens = await harness.api("/api/device/pairings/poll", { method: "POST", skipUserHeader: true,
      body: { deviceCode: syncPairing.deviceCode } });

    const beforeBudgets = (await harness.api("/api/budgets", { useSession: true })).budgets.map(row => row.id).sort();
    // Let authorizeBudgetCreation succeed, then expire the access token before grantCreatedBudget runs.
    advanceAfterNextDeviceNowMs = 16 * 60_000;
    const failedCreate = await harness.request("/api/device/budgets", {
      method: "POST",
      skipUserHeader: true,
      headers: { authorization: `Bearer ${syncTokens.accessToken}` },
      body: { name: "Orphan on grant failure", currency: "EUR", openingBalance: 100 }
    });
    assert.equal(failedCreate.response.status, 401);
    const afterBudgets = (await harness.api("/api/budgets", { useSession: true })).budgets;
    assert.deepEqual(afterBudgets.map(row => row.id).sort(), beforeBudgets);
    assert.equal(afterBudgets.some(row => row.display_name === "Orphan on grant failure" || row.displayName === "Orphan on grant failure"), false);
  } finally {
    await harness.cleanup();
  }
}

test("device writers replace notification secrets explicitly while settings and exports redact secrets", () => verifyDeviceSettingsAndExportSecrets());
test("browser session natural expiry does not revoke approved devices", () => verifyBrowserSessionExpiryDoesNotRevokeDevices());
test("account password change, password removal, and identity unlink revoke devices", () => verifyAccountCredentialChangesRevokeDevices());
test("failed device budget creation cleans up the ungranted budget", () => verifyDeviceBudgetCreationRollbackOnFailure());

test("PostgreSQL browser pairing and bearer snapshot flow", {
  skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests"
}, async () => {
  // Each scenario activates sign-in on its own server, so each needs a fresh database.
  for (const scenario of [verifyFlow, verifyDeviceSettingsAndExportSecrets, verifyBrowserSessionExpiryDoesNotRevokeDevices,
    verifyAccountCredentialChangesRevokeDevices, verifyDeviceBudgetCreationRollbackOnFailure]) {
    await withDisposablePostgresDb(async ({ databaseUrl }) => {
      assert.equal(databaseUrl, process.env.CASHFLOW_DATABASE_URL);
      const global = await createPostgresGlobalStore({ databaseUrl });
      const budget = await createPostgresBudgetStore({ databaseUrl });
      try { await global.initialize(); await budget.initialize(); }
      finally { await global.close(); await budget.close(); }
      await scenario({ backend: "postgres", supported: true, external: true, databaseUrlConfigured: true });
    });
  }
});
