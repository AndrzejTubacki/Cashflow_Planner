import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeviceTokenPolicy } from "../../src/server/cashflow-device-token-policy.js";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

test("device issuance policy accepts partial updates and rejects invalid lifetimes", () => {
  assert.deepEqual(normalizeDeviceTokenPolicy({}, {}), {});
  assert.deepEqual(normalizeDeviceTokenPolicy({ device_access_minutes: "30" }, {}), { device_access_minutes: 30 });
  for (const value of [0, -1, 1441, 1.5, "", null, true, "15min"]) {
    assert.throws(() => normalizeDeviceTokenPolicy({ device_access_minutes: value }, {}));
  }
  assert.throws(() => normalizeDeviceTokenPolicy({ device_renewal_idle_days: 366 }, {}), /must not exceed/);
  assert.throws(() => normalizeDeviceTokenPolicy({ device_absolute_days: 10 }, { device_renewal_idle_days: 90 }), /must not exceed/);
  assert.deepEqual(normalizeDeviceTokenPolicy({ device_renewal_idle_days: 60, device_absolute_days: 180 }, {}),
    { device_renewal_idle_days: 60, device_absolute_days: 180 });
});

test("Admin UI policy API persists defaults and validated overrides without altering other options", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    await harness.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: "policy-admin", displayName: "Policy admin" } });
    const before = await harness.api("/api/admin/options", { useSession: true });
    const options = before.options || before;
    assert.equal(options.device_access_minutes, 15);
    assert.equal(options.device_renewal_idle_days, 90);
    assert.equal(options.device_absolute_days, 365);
    const saved = await harness.api("/api/admin/options", { method: "PUT", useSession: true,
      body: { device_access_minutes: 30, device_renewal_idle_days: 60, device_absolute_days: 180 } });
    const result = saved.options || saved;
    assert.equal(result.device_access_minutes, 30);
    assert.equal(result.device_renewal_idle_days, 60);
    assert.equal(result.device_absolute_days, 180);
    assert.equal(result.ledger_currency, options.ledger_currency);
    const invalid = await harness.request("/api/admin/options", { method: "PUT", useSession: true,
      body: { device_absolute_days: 1 } });
    assert.equal(invalid.response.status, 400);
    const after = await harness.api("/api/admin/options", { useSession: true });
    assert.equal((after.options || after).device_absolute_days, 180);
    await harness.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: "policy-member", displayName: "Non-admin" } });
    const forbidden = await harness.request("/api/admin/options", { method: "PUT", useSession: true,
      body: { device_access_minutes: 10 } });
    assert.equal(forbidden.response.status, 403);
  } finally { await harness.cleanup(); }
});