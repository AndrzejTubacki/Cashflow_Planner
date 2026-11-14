import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { isDevicePairingPoll } from "../../src/server/cashflow-auth-rate-limit.js";

test("poll aliases accepted by Express do not consume enrollment limits", async () => {
  const app = express();
  let enrollmentHits = 0;
  app.use("/api/device/pairings", (req, _res, next) => {
    if (!isDevicePairingPoll(req)) enrollmentHits++;
    next();
  });
  app.post("/api/device/pairings/poll", (_req, res) => res.json({ status: "pending" }));
  const server = app.listen(0, "127.0.0.1");
  try {
    if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const path of ["/api/device/pairings/poll", "/API/DEVICE/PAIRINGS/POLL", "/Api/Device/Pairings/Poll/", "/api/device/pairings/poll/?ignored=1"]) {
      const response = await fetch(origin + path, { method: "POST" });
      assert.equal(response.status, 200, path);
      await response.json();
    }
    assert.equal(enrollmentHits, 0);
    for (const path of ["/api/device/pairings", "/api/device/pairings/poll/other", "/api/device/pairings/poll-other"]) {
      await fetch(origin + path, { method: "POST" });
    }
    assert.equal(enrollmentHits, 3);
  } finally { await new Promise(resolve => server.close(resolve)); }
});