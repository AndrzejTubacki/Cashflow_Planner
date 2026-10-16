import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import test from "node:test";

import { createCashflowModule } from "../../src/cashflow.js";
import { createCashflowBackupService } from "../../src/server/cashflow-backup-service.js";
import { createCashflowPlanMutationService } from "../../src/server/cashflow-plan-mutation-service.js";
import { createPostgresBudgetStore, createSqliteBudgetStore } from "../../src/server/cashflow-budget-store.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { initializeLedgerSchema } from "../../src/server/cashflow-schema.js";
import { computeProjectionPlan, buildProjectionFundingState, makeProjectionConverter,
  applyProjectionGenerationPlanToBudgetStore } from "../../src/server/cashflow-projection-engine-service.js";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

const gated = { skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests" };
const stamp = "2026-10-16T08:00:00.000Z";
const generateId = prefix => `${prefix}_${crypto.randomUUID()}`;

test("Postgres single pending regeneration deletes only the selected budget row and preserves sources", gated, async () => {
  await withStores(async store => {
    for (const budgetId of ["firma_test", "other_test"]) {
      await store.insertPlanningRows(budgetId, "one_off_transactions", [{
        id: "source", name: "Synthetic source", type: "income", amount: 100,
        currency: "PLN", date: "2026-11-30", created_at: stamp, updated_at: stamp
      }]);
      await store.insertPlanningRows(budgetId, "pending_transactions", ["selected", "other"].map(id => ({
        id, name: id, type: "income", amount: 100, currency: "PLN", date: "2026-11-30",
        source_one_off_id: "source", status: "pending", created_at: stamp, updated_at: stamp
      })));
    }
    let regenerationCalls = 0;
    const service = createCashflowPlanMutationService({
      budgetStore: store,
      openPlanningDb: () => { throw new Error("Postgres must not open SQLite"); },
      withProjectionStatus: async (budgetId, result, options) => {
        assert.equal(budgetId, "firma_test");
        assert.deepEqual(options, { preservePending: true });
        assert.deepEqual((await store.listPlanningRows(budgetId, "pending_transactions")).map(row => row.id), ["other"]);
        regenerationCalls++;
        return result;
      }
    });
    await service.regeneratePendingTransaction("firma_test", "selected");
    assert.equal(regenerationCalls, 1);
    assert.equal((await store.listPlanningRows("other_test", "pending_transactions")).length, 2);
    assert.equal((await store.listPlanningRows("firma_test", "one_off_transactions"))[0].amount, 100);
    assert.equal((await store.listPlanningRows("firma_test", "event_log"))[0].action, "pending_regenerated");
    await assert.rejects(service.regeneratePendingTransaction("firma_test", "missing"), /Pending transaction not found/);
    assert.equal(regenerationCalls, 1);
  });
});

async function withStores(work) {
  await withDisposablePostgresDb(async ({ databaseUrl, pool }) => {
    const globalStore = await createPostgresGlobalStore({ databaseUrl });
    const store = await createPostgresBudgetStore({ databaseUrl });
    try {
      await globalStore.initialize();
      await store.initialize();
      for (const id of ["firma_test", "other_test"]) {
        await pool.query("INSERT INTO budgets (id, storage_key, display_name, created_at, updated_at) VALUES ($1, $1, $1, now(), now())", [id]);
        await pool.query("INSERT INTO settings (budget_id, updated_at) VALUES ($1, now())", [id]);
      }
      await work(store, databaseUrl, pool);
    } finally {
      await store.close();
      await globalStore.close();
    }
  });
}

test("Postgres notification batches match sequential SQLite upserts, including chunk boundaries and null keys", gated, async () => {
  await withStores(async store => {
    const harness = await createCashflowTestHarness();
    const sqlite = createSqliteBudgetStore({ openPlanningDb: () => harness.openPlanningDb() });
    try {
      const row = (id, dedupe_key, extra = {}) => ({ id, dedupe_key, notification_type: "funding_shortfall",
        title: id, message: id, priority: "default", entity_id: id, queued_at: stamp, ...extra });
      const existing = row("existing", "existing-key", { sent_at: stamp });
      const rows = [row("first", "duplicate"), row("last", "duplicate", { priority: "high" }),
        row("null-a", null), row("null-b", null), row("update-existing", "existing-key")];
      for (let index = 0; index < 1001; index++) rows.push(row(`unique-${index}`, `key-${index}`));
      rows.push(row("across-chunks", "duplicate", { priority: "urgent" }));
      for (const target of [sqlite, store]) {
        await target.upsertNotifications("firma_test", [existing]);
        if (target.transaction) await target.transaction(writer => writer.upsertNotifications("firma_test", rows));
        else await target.upsertNotifications("firma_test", rows);
      }
      const clean = records => records.map(({ budget_id, ...record }) => record).sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(clean(await store.listPlanningRows("firma_test", "notification_queue")),
        clean(await sqlite.listPlanningRows("firma_test", "notification_queue")));
      await store.upsertNotifications("other_test", [row("other", "duplicate")]);
      assert.equal((await store.listPlanningRows("other_test", "notification_queue"))[0].message, "other");
    } finally {
      await harness.cleanup();
    }
  });
});

test("Postgres commits a projection with repeated shortfalls for the same recurring expense", gated, async () => {
  await withStores(async store => {
    const settings = { ledger_currency: "PLN", timezone: "Europe/Warsaw", notify_funding_shortfall: 1 };
    await store.insertPlanningRows("firma_test", "planned_transactions", [{ id: "plan", type: "recurring_expense", operating_priority: 1, created_at: stamp, updated_at: stamp }]);
    const expense = { id: "expense", planned_transaction_id: "plan", name: "Synthetic bill", amount: 100,
      currency: "PLN", necessary: true, active: true, repeat_every_months: 1, start_month_year: "2026-11",
      prediction_strategy: "fixed", prediction_substitute_missing: "none", prediction_min_recorded_months: 6,
      anchor_type: "day_of_month", anchor_day_of_month: 5, anchor_offset_days: 0,
      anchor_business_day_adjustment: "none", anchor_holiday_country: "PL", created_at: stamp, updated_at: stamp };
    await store.insertPlanningRows("firma_test", "recurring_expenses", [expense]);
    const plan = computeProjectionPlan({ today: "2026-10-16", settings,
      convert: makeProjectionConverter({ settings }), fundingState: buildProjectionFundingState(),
      flexTargetLedger: new Map(), goalTargetLedger: new Map(), recurringExpenses: [expense],
      periods: [{ key: "2026-11", start: "2026-11-01", end: "2026-11-30", available: 0 },
        { key: "2026-12", start: "2026-12-01", end: "2026-12-31", available: 0 }] });
    assert.equal(plan.notificationRows.length, 2);
    assert.equal(plan.notificationRows[0].dedupe_key, plan.notificationRows[1].dedupe_key);
    await applyProjectionGenerationPlanToBudgetStore({ budgetId: "firma_test", budgetStore: store, plan });
    assert.equal((await store.listPlanningRows("firma_test", "notification_queue")).length, 1);
    assert.equal((await store.listPlanningRows("firma_test", "future_transactions")).length, 2);
    assert.equal((await store.listPlanningRows("firma_test", "projection_snapshots")).length, 1);
  });
});

test("Postgres validation preserves SQLite warnings, ledger checks, audit events and HTTP route wiring", gated, async () => {
  await withStores(async (store, databaseUrl, pool) => {
    const harness = await createCashflowTestHarness();
    const root = await mkdtemp(path.join(tmpdir(), "cashflow-validation-postgres-"));
    let cashflow, server;
    try {
      // Seed identical real SQLite/Postgres rows, not mocked validation inputs.
      const db = harness.openPlanningDb();
      let settings;
      try {
        settings = db.prepare("SELECT * FROM settings").get();
        db.prepare("INSERT INTO planned_transactions (id, type, operating_priority, created_at, updated_at) VALUES ('orphan', 'flex', 1, ?, ?)").run(stamp, stamp);
      } finally { db.close(); }
      const { budget_id, ...sqliteSettings } = settings;
      await store.replacePlanningRows("firma_test", "settings", [sqliteSettings]);
      await store.insertPlanningRows("firma_test", "planned_transactions", [{ id: "orphan", type: "flex", operating_priority: 1, created_at: stamp, updated_at: stamp }]);
      const ledger = { id: "opening", name: "Opening", type: "income", amount: 100, currency: "PLN", ledger_currency: "PLN",
        ledger_year: 2026, date: "2026-10-16", confirmed_date: "2026-10-16", fx_rate: 1, buffered_fx_rate: 1,
        ledger_amount: 100, running_balance_pln: 90, created_at: stamp, updated_at: stamp };
      await store.insertConfirmedTransactions("firma_test", [ledger]);
      const ledgerDb = harness.openLedgerDb(2026);
      try {
        initializeLedgerSchema(ledgerDb);
        const { ledger_year, ...row } = ledger;
        const columns = Object.keys(row);
        ledgerDb.prepare(`INSERT INTO confirmed_transactions (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(row));
      } finally { ledgerDb.close(); }
      const expected = await harness.api("/api/validate", { method: "POST", body: {} });
      const service = createCashflowBackupService({ budgetStore: store, generateId,
        openPlanningDb: () => { throw new Error("SQLite planning access"); },
        openLedgerDb: () => { throw new Error("SQLite ledger access"); } });
      // PostgreSQL rows carry a budget_id and numeric years; SQLite filenames
      // supply string years. Compare the same diagnostics, not storage metadata.
      const normalize = value => JSON.parse(JSON.stringify(value, (key, item) =>
        key === "budget_id" ? undefined : key === "year" ? String(item) : item));
      assert.deepEqual(normalize(await service.validateCashflowDataAsync("firma_test")), normalize(expected));
      assert.ok(expected.warnings.some(row => row.type === "active_ledger_running_balance_drift"));
      assert.ok(expected.warnings.some(row => row.type === "orphan_planned_transaction"));
      assert.equal((await store.listPlanningRows("other_test", "event_log")).length, 0);
      const audit = (await store.listPlanningRows("firma_test", "event_log"))
        .find(row => row.action === "validation_completed");
      const auditDetails = typeof audit.details === "string" ? JSON.parse(audit.details) : audit.details;
      assert.equal(auditDetails.warning_count, expected.warnings.length);
      assert.deepEqual(await service.validateCashflowDataAsync("other_test"), { ok: true, warnings: [] });

      cashflow = await createCashflowModule({ dataDir: root,
        localeDir: path.resolve(import.meta.dirname, "../../public/app/cashflow/locales"),
        databaseConfig: { backend: "postgres", databaseUrlConfigured: true, external: true, supported: true },
        env: { CASHFLOW_DATABASE_URL: databaseUrl } });
      const app = express();
      app.use(express.json());
      cashflow.registerRoutes(app);
      server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
      // Establish the normal none-mode session, including CSRF, instead of bypassing auth.
      const base = `http://127.0.0.1:${server.address().port}`;
      const sessionResponse = await fetch(`${base}/api/users`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "validation_tester", displayName: "Validation tester" }) });
      const session = await sessionResponse.json();
      assert.equal(sessionResponse.status, 200, JSON.stringify(session));
      const cookie = sessionResponse.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      const response = await fetch(`${base}/api/validate`, { method: "POST", headers: {
        cookie, "x-cashflow-csrf-token": session.csrfToken || ""
      } });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(body, { ok: true, warnings: [] });
      assert.ok((await pool.query("SELECT count(*) FROM event_log WHERE action = 'validation_completed'")).rows[0].count >= 2);
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      await cashflow?.close();
      await harness.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});