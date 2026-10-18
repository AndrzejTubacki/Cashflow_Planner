import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { isPrivateIp, resolveNotificationDestination, sendToNotificationDestination } from "../../src/server/cashflow-notification-destination.js";
import { fetchWithTimeout } from "../../src/server/cashflow-fetch-utils.js";

test("notification checks reject mapped private IPv6 and non-public ranges", () => {
  for (const address of ["::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:c0a8:101", "::1", "fe9a::1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "64:ff9b::7f00:1", "invalid"]) {
    assert.equal(isPrivateIp(address), true, address);
  }
  assert.equal(isPrivateIp("93.184.216.34"), false);
  assert.equal(isPrivateIp("2606:4700:4700::1111"), false);
});

test("delivery checks every current DNS answer and fails closed before transport", async () => {
  let calls = 0;
  await assert.rejects(() => sendToNotificationDestination("https://notify.example/topic", {}, {
    lookupHost: async () => [{ address: "93.184.216.34" }, { address: "::ffff:7f00:1" }],
    requestImpl: () => { calls++; }
  }), /non-public/);
  assert.equal(calls, 0);
  for (const url of ["http://[::ffff:7f00:1]/topic", "file:///tmp/test", "invalid"]) {
    await assert.rejects(() => resolveNotificationDestination(url));
  }
});

test("transport lookup is pinned to the checked answer without a second DNS resolution", async () => {
  let lookups = 0;
  await sendToNotificationDestination("https://notify.example/topic", {}, {
    lookupHost: async () => { lookups++; return [{ address: "93.184.216.34", family: 4 }]; },
    requestImpl: async (url, options) => {
      assert.equal(url, "https://notify.example/topic");
      assert.equal(options.redirect, "error");
      for (let i = 0; i < 2; i++) {
        options.lookup("notify.example", { all: true }, (error, rows) => {
          assert.ifError(error);
          assert.deepEqual(rows, [{ address: "93.184.216.34", family: 4 }]);
        });
      }
      return { ok: true, status: 200 };
    }
  });
  assert.equal(lookups, 1);
});

test("only the exact approved private host is accepted", async () => {
  const config = { allowedPrivateHosts: ["notify.example"], lookupHost: async () => [{ address: "127.0.0.1", family: 4 }] };
  assert.equal((await resolveNotificationDestination("http://notify.example/topic", config))[0].address, "127.0.0.1");
  await assert.rejects(() => resolveNotificationDestination("http://other.notify.example/topic", config), /non-public/);
});

test("actual pinned HTTP transport preserves Host and never follows a redirect", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    assert.match(req.headers.host, /^notify\.example:/);
    res.writeHead(302, { location: "/private" });
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(() => sendToNotificationDestination(`http://notify.example:${server.address().port}/topic`, { method: "POST", body: "test" }, {
      allowedPrivateHosts: ["notify.example"],
      lookupHost: async () => [{ address: "127.0.0.1", family: 4 }]
    }), /redirects are not allowed/);
    assert.equal(hits, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("notification timeout includes stalled DNS resolution", async () => {
  await assert.rejects(() => fetchWithTimeout("https://notify.example/topic", {}, 20,
    (url, options) => sendToNotificationDestination(url, options, {
      lookupHost: () => new Promise(() => {})
    })), error => error.status === 504);
});