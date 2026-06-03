import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

async function withHarness(fn) {
  const harness = await createCashflowTestHarness();
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

function latestBackupId(harness) {
  const db = harness.openPlanningDb();
  try {
    return db.prepare(`
      SELECT id
      FROM backup_metadata
      WHERE success = 1
      ORDER BY backup_timestamp DESC
      LIMIT 1
    `).get()?.id;
  } finally {
    db.close();
  }
}

function insertLedgerCurrencyEvent(harness, id, oldCurrency = "PLN", newCurrency = "USD") {
  const db = harness.openPlanningDb();
  try {
    db.prepare(`
      INSERT INTO ledger_currency_events (
        id, old_currency, new_currency, old_balance, converted_opening_balance,
        fx_rate, rate_date, source, details, created_at
      ) VALUES (?, ?, ?, 100, 25, 0.25, '2026-06-01', 'test', '{}', datetime('now'))
    `).run(id, oldCurrency, newCurrency);
  } finally {
    db.close();
  }
}

function ledgerCurrencyEventIds(harness) {
  const db = harness.openPlanningDb();
  try {
    return db.prepare("SELECT id FROM ledger_currency_events ORDER BY id").all().map(row => row.id);
  } finally {
    db.close();
  }
}

test("backup and restore preserve planning data and validate after restore", async () => withHarness(async harness => {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      future_periods: 2,
      fx_provider: "manual",
      manual_fx_rates: {},
      fx_buffer_percent: 0
    }
  });

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Backup one-off",
      currency: "PLN",
      amount: 123,
      type: "income",
      date: "2026-06-01"
    }
  });
  const flex = await harness.api("/api/flex", {
    method: "POST",
    body: {
      name: "Backup flex",
      currency: "PLN",
      amount: 50,
      priority: 1,
      active: 1,
      allow_split: 1,
      min_amount: 10,
      max_amount: 50
    }
  });

  const before = await harness.api("/api");
  await harness.api("/api/backup", { method: "POST", body: {} });
  const backupId = latestBackupId(harness);
  assert.ok(backupId);

  await harness.api(`/api/one-off/${encodeURIComponent(oneOff.id)}`, { method: "DELETE" });
  await harness.api(`/api/flex/${encodeURIComponent(flex.id)}`, { method: "DELETE" });

  let mutated = await harness.api("/api");
  assert.equal(mutated.oneOffs.some(row => row.id === oneOff.id), false);
  assert.equal(mutated.flexTransactions.some(row => row.id === flex.id), false);

  await harness.api(`/api/restore/${encodeURIComponent(backupId)}`, {
    method: "POST",
    body: {}
  });

  const restored = await harness.api("/api");
  const validation = await harness.api("/api/validate", { method: "POST", body: {} });

  assert.equal(restored.oneOffs.some(row => row.id === oneOff.id && row.name === "Backup one-off"), true);
  assert.equal(restored.flexTransactions.some(row => row.id === flex.id && row.name === "Backup flex"), true);
  assert.equal(validation.ok, true);
  assert.equal(restored.settings.fx_provider, before.settings.fx_provider);
  assert.equal(restored.settings.future_periods, before.settings.future_periods);
}));

test("backup and restore replace ledger currency events", async () => withHarness(async harness => {
  insertLedgerCurrencyEvent(harness, "event-backed-up");

  await harness.api("/api/backup", { method: "POST", body: {} });
  const backupId = latestBackupId(harness);
  assert.ok(backupId);

  const db = harness.openPlanningDb();
  try {
    db.prepare("DELETE FROM ledger_currency_events").run();
    db.prepare(`
      INSERT INTO ledger_currency_events (
        id, old_currency, new_currency, old_balance, converted_opening_balance,
        fx_rate, rate_date, source, details, created_at
      ) VALUES ('event-live-only', 'USD', 'EUR', 10, 9, 0.9, '2026-06-02', 'test', '{}', datetime('now'))
    `).run();
  } finally {
    db.close();
  }

  await harness.api(`/api/restore/${encodeURIComponent(backupId)}`, {
    method: "POST",
    body: {}
  });

  assert.deepEqual(ledgerCurrencyEventIds(harness), ["event-backed-up"]);
}));
