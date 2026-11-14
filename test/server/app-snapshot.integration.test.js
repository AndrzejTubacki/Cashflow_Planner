import assert from "node:assert/strict";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { calculateSnapshot } from "../../src/engine/snapshot.js";

test("app snapshots require a cookie-backed actor, omit secrets, and do not regenerate data", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false });
  try {
    const denied = await harness.request("/api/app/snapshot", { skipUserHeader: true });
    assert.equal(denied.response.status, 401);
    await harness.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: "snapshot-user", displayName: "Snapshot user" } });
    const db = harness.openPlanningDb("snapshot-user");
    db.prepare("UPDATE settings SET ntfy_auth_token = ?, discord_webhook_url = ?, backup_location = ? WHERE id = 1")
      .run("secret-token-marker", "secret-webhook-marker", "secret-path-marker");
    const before = db.prepare("SELECT count(*) AS n FROM projection_snapshots").get().n;
    db.close();
    const response = await harness.request("/api/app/snapshot", { useSession: true });
    assert.equal(response.response.status, 200);
    assert.equal(response.response.headers.get("cache-control"), "no-store");
    assert.equal(response.body.writesSupported, false);
    assert.match(response.body.snapshotToken, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(response.body), /secret-token-marker|secret-webhook-marker|secret-path-marker/);
    assert.doesNotThrow(() => calculateSnapshot(response.body));
    const afterDb = harness.openPlanningDb("snapshot-user");
    assert.equal(afterDb.prepare("SELECT count(*) AS n FROM projection_snapshots").get().n, before);
    afterDb.close();
    const other = await harness.request("/api/app/snapshot", { useSession: true,
      headers: { "x-cashflow-budget-id": "not-owned" } });
    assert.notEqual(other.response.status, 200);
  } finally { await harness.cleanup(); }
});
// Real SQLite filenames expose string years; the budget-store contract must present
// numeric years so a nonempty ledger remains exportable without weakening validation.
test("SQLite app download includes accepted history through the numeric-year storage contract", async () => {
  const harness = await createCashflowTestHarness({ initializeUser: false, userId: "snapshot-history" });
  try {
    await harness.api("/api/users", { method: "POST", skipUserHeader: true,
      body: { userId: "snapshot-history", displayName: "Synthetic history" } });
    await harness.api("/api/setup", { method: "POST", useSession: true,
      body: { currency: "PLN", opening_balance: 0, income_enabled: false } });
    const source = await harness.api("/api/one-off", { method: "POST", useSession: true,
      body: { name: "Recorded income", currency: "PLN", amount: 25, type: "income", date: harness.today } });
    let view = await harness.api("/api", { useSession: true });
    let pending = view.pendingTransactions.find(row => row.source_one_off_id === source.id);
    if (!pending) {
      const future = view.futureTransactions.find(row => row.source_one_off_id === source.id);
      assert.ok(future);
      view = await harness.api(`/api/future/${future.id}/move-to-pending`, { method: "POST", useSession: true,
        body: { occurrenceKey: future.occurrence_key } });
      pending = view.pendingTransactions.find(row => row.source_one_off_id === source.id);
    }
    assert.ok(pending);
    await harness.api(`/api/pending/${pending.id}/confirm`, { method: "POST", useSession: true, body: { amount: 25 } });
    const snapshot = await harness.api("/api/app/snapshot", { useSession: true });
    assert.equal(snapshot.request.predictionRows.length, 1);
    assert.equal(snapshot.request.predictionRows[0].amount, 25);
    assert.equal(snapshot.request.openingBalance, 25);
    assert.doesNotThrow(() => calculateSnapshot(snapshot));
  } finally { await harness.cleanup(); }
});
