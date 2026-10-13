import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

import { configureTrustProxy, resolveTrustProxySetting } from "../../src/server/cashflow-trust-proxy.js";

test("resolveTrustProxySetting leaves trust proxy unset by default", () => {
  assert.deepEqual(resolveTrustProxySetting(undefined), { value: undefined, source: "default" });
  assert.deepEqual(resolveTrustProxySetting(""), { value: undefined, source: "default" });
  assert.deepEqual(resolveTrustProxySetting("   "), { value: undefined, source: "default" });
});

test("resolveTrustProxySetting parses a hop count", () => {
  assert.deepEqual(resolveTrustProxySetting("1"), { value: 1, source: "hop-count" });
  assert.deepEqual(resolveTrustProxySetting(" 3 "), { value: 3, source: "hop-count" });
});

test("resolveTrustProxySetting parses a single IP, CIDR, or named preset", () => {
  assert.deepEqual(resolveTrustProxySetting("loopback"), { value: "loopback", source: "list" });
  assert.deepEqual(resolveTrustProxySetting("10.0.0.1"), { value: "10.0.0.1", source: "list" });
  assert.deepEqual(resolveTrustProxySetting("10.0.0.0/8"), { value: "10.0.0.0/8", source: "list" });
  assert.deepEqual(resolveTrustProxySetting("::1"), { value: "::1", source: "list" });
});

test("resolveTrustProxySetting parses a comma-separated list", () => {
  assert.deepEqual(
    resolveTrustProxySetting("loopback, 10.0.0.0/8, 192.168.1.1"),
    { value: ["loopback", "10.0.0.0/8", "192.168.1.1"], source: "list" }
  );
});

test("resolveTrustProxySetting only rejects an empty-looking list at the shape level", () => {
  // Entry-level validation (is "abc" a real IP/CIDR/preset?) is deliberately
  // not done here - see configureTrustProxy below, which hands entries to
  // Express's own validation instead of a hand-rolled one. This layer only
  // rejects a value with no usable entries at all.
  assert.deepEqual(resolveTrustProxySetting(",,"), { value: undefined, source: "invalid" });
  assert.deepEqual(resolveTrustProxySetting(", ,"), { value: undefined, source: "invalid" });
});

function fakeApp() {
  const calls = [];
  return {
    calls,
    set(key, value) {
      // Mirrors a real Express app closely enough for this: "trust proxy"
      // is the only setting configureTrustProxy touches, and a real Express
      // app validates its value by compiling it with the "proxy-addr"
      // package, throwing synchronously on anything that isn't a real hop
      // count, IP, CIDR, or named range.
      if (key !== "trust proxy") { calls.push([key, value]); return; }
      const realApp = express();
      realApp.set("trust proxy", value); // throws for a malformed value, exactly like production
      calls.push([key, value]);
    }
  };
}

function hookRecorder() {
  const errors = [];
  const events = [];
  return {
    errors,
    events,
    logError: (kind, details) => errors.push({ kind, details }),
    logServerEvent: (kind, details) => events.push({ kind, details })
  };
}

test("configureTrustProxy leaves trust proxy unset by default and logs nothing", () => {
  const app = fakeApp();
  const { errors, events, logError, logServerEvent } = hookRecorder();
  const resolved = configureTrustProxy(app, undefined, { logError, logServerEvent });
  assert.deepEqual(resolved, { value: undefined, source: "default" });
  assert.deepEqual(app.calls, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(events, []);
});

test("configureTrustProxy applies a real hop count and logs it", () => {
  const app = fakeApp();
  const { errors, events, logError, logServerEvent } = hookRecorder();
  const resolved = configureTrustProxy(app, "1", { logError, logServerEvent });
  assert.deepEqual(resolved, { value: 1, source: "hop-count" });
  assert.deepEqual(app.calls, [["trust proxy", 1]]);
  assert.deepEqual(errors, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "cashflow_trust_proxy_configured");
});

// Each of these has the right *shape* for resolveTrustProxySetting (a
// single comma-list entry) but is not a real IP, CIDR, or named range, so
// Express itself rejects it when configureTrustProxy actually applies it.
// Before this fix, a hand-rolled regex accepted all four, so configureTrustProxy
// (and server.mjs, which called an equivalent check inline) tried app.set
// anyway, which threw synchronously and crashed startup instead of just
// logging and leaving trust proxy off.
for (const invalidValue of ["abc", "999.1.1.1", "10.0.0.0/99", "..."]) {
  test(`configureTrustProxy rejects "${invalidValue}" without throwing and leaves trust off`, () => {
    const app = fakeApp();
    const { errors, events, logError, logServerEvent } = hookRecorder();
    assert.doesNotThrow(() => {
      const resolved = configureTrustProxy(app, invalidValue, { logError, logServerEvent });
      assert.deepEqual(resolved, { value: undefined, source: "invalid" });
    });
    assert.deepEqual(app.calls, [], "trust proxy must never be left set to an invalid value");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].kind, "cashflow_trust_proxy_invalid");
    assert.equal(errors[0].details.value, invalidValue);
    assert.deepEqual(events, [], "an invalid value must never log a configured event");
  });
}
