import assert from "node:assert/strict";
import test from "node:test";

import {
  isValidNtfyHost,
  normalizeNtfyAllowedPrivateHosts,
  ntfyHostIsAllowed
} from "../../src/server/cashflow-ntfy-private-hosts.js";

test("private ntfy hosts normalize DNS names and IP literals", () => {
  assert.deepEqual(normalizeNtfyAllowedPrivateHosts([
    " NTFY.LAN. ", "ntfy.lan", "192.168.1.20", "[fd00::20]", ""
  ]), ["ntfy.lan", "192.168.1.20", "fd00::20"]);
  assert.deepEqual(normalizeNtfyAllowedPrivateHosts("one.lan, TWO.lan.\n10.0.0.2"), [
    "one.lan", "two.lan", "10.0.0.2"
  ]);
  assert.equal(isValidNtfyHost("a-b.example.internal"), true);
  assert.equal(isValidNtfyHost("2001:db8::1"), true);
});

test("private ntfy host validation rejects URLs, ports, wildcards, and oversized lists", () => {
  for (const entry of ["https://ntfy.lan", "ntfy.lan:8443", "*.ntfy.lan", "bad_label.lan", `${"a".repeat(64)}.lan`]) {
    assert.throws(() => normalizeNtfyAllowedPrivateHosts([entry]), new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.throws(
    () => normalizeNtfyAllowedPrivateHosts(Array.from({ length: 51 }, (_, index) => `host-${index}.lan`)),
    /at most 50/
  );
});

test("private ntfy allow-list matching is exact and normalized", () => {
  assert.equal(ntfyHostIsAllowed("NTFY.LAN.", ["ntfy.lan"]), true);
  assert.equal(ntfyHostIsAllowed("child.ntfy.lan", ["ntfy.lan"]), false);
  assert.equal(ntfyHostIsAllowed("[FD00::20]", ["fd00::20"]), true);
});
