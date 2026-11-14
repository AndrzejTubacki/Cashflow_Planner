import assert from "node:assert/strict";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";
import { createPostgresGlobalStore } from "../../src/server/cashflow-postgres-global-store.js";
import { setTodayOverrideForTests } from "../../src/server/cashflow-date-utils.js";
import { createSqliteBudgetStore, createPostgresBudgetStore } from "../../src/server/cashflow-budget-store.js";

// The same HTTP scenarios run against SQLite and the guarded disposable PostgreSQL
// harness. Never open a SQLite planning file for a PostgreSQL assertion.
async function withHarness(backend, work) {
  const run = async postgresStore => {
    const h = await createCashflowTestHarness({ userId: "pending_recovery", inProcess: true,
      ...(backend === "postgres" ? { initializeUser: false, databaseConfig: {
        backend: "postgres", supported: true, external: true, databaseUrlConfigured: true
      } } : {}) });
    const store = backend === "postgres"
      ? postgresStore
      : createSqliteBudgetStore({ openPlanningDb: () => h.openPlanningDb() });
    try {
      if (backend === "postgres") await h.api("/api/users", { method: "POST", skipUserHeader: true,
        body: { userId: h.userId, displayName: "Synthetic owner" } });
      await h.api("/api/setup", { method: "POST", body: {
        currency: "PLN", opening_balance: 10000, income_enabled: false, future_periods: 3
      } });
      const opening = (await h.api("/api")).pendingTransactions.find(row => row.occurrence_key?.startsWith("first_run_opening_balance:"));
      assert.ok(opening);
      await h.api(`/api/pending/${opening.id}/confirm`, { method: "POST", body: {} });
      await h.api("/api/settings", { method: "PUT", body: { fx_provider: "manual", manual_fx_rates: {} } });
      await work(h, store);
      assert.deepEqual(h.errors, []);
    } finally { if (backend === "sqlite") await store.close?.(); await h.cleanup(); }
  };
  if (backend === "postgres") await withDisposablePostgresDb(async ({ databaseUrl }) => {
    const global = await createPostgresGlobalStore({ databaseUrl });
    const store = await createPostgresBudgetStore({ databaseUrl });
    try {
      await global.initialize();
      await store.initialize();
      await run(store);
    } finally { await store.close(); await global.close(); }
  });
  else await run();
}

const recurring = { name: "Scheduled", currency: "PLN", amount: 10, prediction_strategy: "fixed",
  active: 1, necessary: 1, priority: 1, repeat_every_months: 1, anchor_type: "day_of_month",
  anchor_day_of_month: 25, anchor_business_day_adjustment: "none" };
const sources = {
  recurringExpense: ["/api/recurring-expenses", "source_recurring_expense_id", recurring],
  recurringIncome: ["/api/recurring-incomes", "source_recurring_income_id", recurring],
  oneOff: ["/api/one-off", "source_one_off_id", { name: "One-off", currency: "PLN", amount: 10, type: "expense", date: "2026-05-25" }],
  goal: ["/api/goals", "source_goal_id", { name: "Goal", currency: "PLN", amount: 300, active: 1, priority: 1, due_date: "2026-05-30" }],
  flex: ["/api/flex", "source_flex_id", { name: "Flex", currency: "PLN", amount: 200, active: 1, priority: 2, allow_split: 0 }]
};

async function moveFirst(h, column, sourceId) {
  let s = await h.api("/api");
  const future = s.futureTransactions.filter(row => row[column] === sourceId).sort((a, b) => a.date.localeCompare(b.date))[0];
  assert.ok(future);
  await h.api(`/api/future/${future.id}/move-to-pending`, { method: "POST", body: { occurrenceKey: future.occurrence_key } });
  s = await h.api("/api");
  return s.pendingTransactions.find(row => row.occurrence_key === future.occurrence_key);
}

for (const backend of ["sqlite", "postgres"]) {
  test(`${backend}: pending occurrence regressions`, {
    skip: backend === "postgres" && !postgresRuntimeTestsEnabled() ? "enable disposable Postgres tests" : false
  }, async t => {
    for (const type of ["income", "expense"]) for (const date of ["2026-05-10", "2026-05-20", "2026-07-10"]) {
      await t.test(`one-off ${type} edit to ${date} preserves the row and audit`, () => withHarness(backend, async (h, store) => {
        const source = await h.api("/api/one-off", { method: "POST", body: {
          name: "Original", currency: "PLN", amount: 40, type, date: "2026-05-25"
        } });
        const pending = await moveFirst(h, "source_one_off_id", source.id);
        await store.insertPlanningRows(h.userId, "event_log", [{ id: "pending-history", action: "synthetic_pending_history",
          entity_type: "pending", entity_id: pending.id, details: JSON.stringify({ original: true }), timestamp: "2026-05-20T00:00:00.000Z" }]);
        await h.api(`/api/pending/${pending.id}`, { method: "PUT", body: { date, amount: 37, name: "Edited" } });
        for (let pass = 0; pass < 2; pass++) {
          await h.api("/api/run-jobs", { method: "POST", body: {} });
          const s = await h.api("/api");
          const rows = s.pendingTransactions.filter(row => row.source_one_off_id === source.id);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].id, pending.id);
          assert.equal(rows[0].created_at, pending.created_at);
          assert.equal(rows[0].date, date);
          assert.equal(rows[0].amount, 37);
          assert.equal(rows[0].requested_amount, 37);
          assert.equal(rows[0].funded_amount, 37);
          assert.equal(rows[0].ledger_amount, 37);
          assert.equal(rows[0].occurrence_key, `one_off:${source.id}:${type}:${date}`);
          assert.ok(!s.futureTransactions.some(row => row.source_one_off_id === source.id));
          assert.ok((await store.listPlanningRows(h.userId, "event_log")).some(row => row.entity_id === pending.id && row.action === "synthetic_pending_history"));
        }
      }));
    }
    for (const [label, [url, column, body]] of Object.entries(sources)) {
      await t.test(`regenerate ${label} after its period ends at scheduled date and amount`, () => withHarness(backend, async h => {
        const source = await h.api(url, { method: "POST", body });
        const pending = await moveFirst(h, column, source.id);
        // Keep the original scheduled identity even after a pending date/amount edit.
        await h.api(`/api/pending/${pending.id}`, { method: "PUT", body: { date: "2026-06-02", ...(["goal", "flex"].includes(label) ? {} : { amount: 7 }) } });
        if (label !== "oneOff") {
          const edited = (await h.api("/api")).pendingTransactions.find(row => row.id === pending.id);
          assert.equal(edited.occurrence_key, pending.occurrence_key);
        }
        setTodayOverrideForTests("2026-06-03");
        await h.api("/api/run-jobs", { method: "POST", body: {} });
        const result = await h.api(`/api/pending/${pending.id}/regenerate`, { method: "POST" });
        assert.equal(result._projection.projection_ok, true);
        for (let pass = 0; pass < 2; pass++) {
          const s = await h.api("/api");
          const key = label === "oneOff" ? `one_off:${source.id}:expense:2026-06-02` : pending.occurrence_key;
          const rows = s.pendingTransactions.filter(row => row.occurrence_key === key);
          assert.equal(rows.length, 1, label);
          assert.notEqual(rows[0].id, pending.id);
          assert.equal(rows[0].date, label === "oneOff" ? "2026-06-02" : pending.date);
          assert.equal(rows[0].amount, label === "oneOff" ? 7 : body.amount);
          assert.ok(!s.futureTransactions.some(row => row.occurrence_key === key));
          await h.api("/api/run-jobs", { method: "POST", body: {} });
        }
      }));
    }
    await t.test("one-off regeneration retains an ended-period source date", () => withHarness(backend, async h => {
      const [url, column, body] = sources.oneOff;
      const source = await h.api(url, { method: "POST", body });
      const pending = await moveFirst(h, column, source.id);
      setTodayOverrideForTests("2026-06-03");
      await h.api(`/api/pending/${pending.id}/regenerate`, { method: "POST" });
      const s = await h.api("/api");
      const rows = s.pendingTransactions.filter(row => row[column] === source.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].date, "2026-05-25");
      assert.equal(rows[0].amount, 10);
      assert.ok(!s.futureTransactions.some(row => row[column] === source.id));
    }));
    await t.test("pending one-off remainder date edits retain installment identity", () => withHarness(backend, async h => {
      const source = await h.api("/api/one-off", { method: "POST", body: {
        name: "Installments", currency: "PLN", amount: 40, type: "expense", date: h.today
      } });
      const first = (await h.api("/api")).pendingTransactions.find(row => row.source_one_off_id === source.id);
      await h.api(`/api/pending/${first.id}/confirm`, { method: "POST", body: { amount: 10, date: h.today } });
      const remainder = (await h.api("/api")).pendingTransactions.find(row => row.source_one_off_id === source.id);
      assert.ok(remainder.occurrence_key.startsWith("one_off_remainder:"));
      await h.api(`/api/pending/${remainder.id}`, { method: "PUT", body: { date: "2026-07-10" } });
      await h.api("/api/run-jobs", { method: "POST", body: {} });
      const s = await h.api("/api");
      const rows = s.pendingTransactions.filter(row => row.source_one_off_id === source.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, remainder.id);
      assert.equal(rows[0].occurrence_key, remainder.occurrence_key);
      assert.equal(rows[0].amount, 30);
      assert.ok(!s.futureTransactions.some(row => row.source_one_off_id === source.id));
    }));
    await t.test("catch-up and regeneration respect income-anchored period boundaries", () => withHarness(backend, async h => {
      const income = await h.api("/api/recurring-incomes", { method: "POST", body: {
        ...recurring, name: "Period income", anchor_day_of_month: 20, period_setting: 1
      } });
      await h.api("/api/settings", { method: "PUT", body: { budget_period_income_id: income.id } });
      const source = await h.api("/api/recurring-expenses", { method: "POST", body: recurring });
      const future = (await h.api("/api")).futureTransactions.find(row => row.source_recurring_expense_id === source.id && row.date === "2026-05-25");
      assert.equal(future.period, "2026-05-20");
      setTodayOverrideForTests("2026-06-25");
      await h.api("/api/run-jobs", { method: "POST", body: {} });
      const pending = (await h.api("/api")).pendingTransactions.find(row => row.occurrence_key === future.occurrence_key);
      assert.ok(pending);
      await h.api(`/api/pending/${pending.id}/regenerate`, { method: "POST" });
      const s = await h.api("/api");
      assert.equal(s.pendingTransactions.filter(row => row.occurrence_key === future.occurrence_key).length, 1);
      assert.ok(!s.futureTransactions.some(row => row.occurrence_key === future.occurrence_key));
    }));
    for (const label of ["oneOff", "goal", "flex"]) {
      await t.test(`missed ${label} in an ended period catches up`, () => withHarness(backend, async h => {
        const [url, column, body] = sources[label];
        const source = await h.api(url, { method: "POST", body });
        const future = (await h.api("/api")).futureTransactions.find(row => row[column] === source.id);
        assert.ok(future);
        setTodayOverrideForTests("2026-06-03");
        await h.api("/api/run-jobs", { method: "POST", body: {} });
        const s = await h.api("/api");
        assert.equal(s.pendingTransactions.filter(row => row.occurrence_key === future.occurrence_key).length, 1);
        assert.ok(!s.futureTransactions.some(row => row.occurrence_key === future.occurrence_key));
      }));
    }
    for (const today of ["2026-05-28", "2026-06-03", "2026-08-03"]) {
      await t.test(`missed jobs catch up known due occurrences on ${today}`, () => withHarness(backend, async h => {
        const source = await h.api("/api/recurring-expenses", { method: "POST", body: recurring });
        const before = await h.api("/api");
        const due = before.futureTransactions.filter(row => row.source_recurring_expense_id === source.id && row.date <= today);
        assert.ok(due.some(row => row.date === "2026-05-25"));
        setTodayOverrideForTests(today);
        for (let pass = 0; pass < 2; pass++) {
          await h.api("/api/run-jobs", { method: "POST", body: {} });
          const s = await h.api("/api");
          for (const old of due) {
            const rows = s.pendingTransactions.filter(row => row.occurrence_key === old.occurrence_key);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].date, old.date);
            assert.equal(rows[0].amount, 10);
            assert.ok(!s.futureTransactions.some(row => row.occurrence_key === old.occurrence_key));
          }
          assert.ok(!s.pendingTransactions.some(row => row.source_recurring_expense_id === source.id && row.date < "2026-05-20"));
        }
      }));
    }
  });
}
