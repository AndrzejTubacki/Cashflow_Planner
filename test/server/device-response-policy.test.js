import assert from "node:assert/strict";
import test from "node:test";
import { deviceResponsePolicy } from "../../src/server/cashflow-device-response-policy.js";

test("sensitive device paths get early no-store headers without capturing unrelated prefixes", () => {
  for (const path of ["/api/device/pairings?label=phone", "/api/device/renew", "/api/device/revoke",
    "/api/account/devices", "/api/account/devices/id", "/api/account/device-pairings/review", "/api/app/snapshot",
    "/API/DEVICE/PAIRINGS", "/Api/Device/Renew/", "/API/ACCOUNT/DEVICES", "/Api/App/Snapshot?ignored=1"]) {
    const headers = {};
    let continued = false;
    deviceResponsePolicy({ originalUrl: path }, { setHeader: (key, value) => { headers[key] = value; } }, () => { continued = true; });
    assert.equal(headers["Cache-Control"], "no-store", path);
    assert.equal(headers.Pragma, "no-cache");
    assert.equal(headers["Referrer-Policy"], "no-referrer");
    assert.equal(continued, true);
  }
  for (const path of ["/api/device-other", "/api/app/snapshots", "/api/account", "/"]) {
    deviceResponsePolicy({ url: path }, { setHeader: () => assert.fail(path) }, () => {});
  }
});