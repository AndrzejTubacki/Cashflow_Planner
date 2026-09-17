import assert from "node:assert/strict";
import test from "node:test";

import {
  createCashflowRuntimeLockService,
  describeCashflowRuntimeLockConfig
} from "../../src/server/cashflow-runtime-lock-service.js";
import {
  BUDGET_RUNTIME_LOCK_JOBS,
  budgetRuntimeLockName,
  GLOBAL_BACKGROUND_TICK_LOCK,
  runtimeLockName
} from "../../src/server/cashflow-runtime-locks.js";

function fakePgModule() {
  const queries = [];
  const pools = [];

  class Pool {
    constructor(options) {
      this.options = options;
      this.ended = false;
      pools.push(this);
    }

    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (String(sql).includes("INSERT INTO cashflow_runtime_locks")) {
            return {
              rows: [{
                name: params[0],
                owner_id: params[1],
                expires_at: params[3]
              }],
              rowCount: 1
            };
          }
          if (String(sql).includes("DELETE FROM cashflow_runtime_locks")) {
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {}
      };
    }

    async end() {
      this.ended = true;
    }
  }

  return {
    module: { Pool },
    pools,
    queries
  };
}

test("runtime lock names are deterministic and accepted by the Postgres lock regex", () => {
  assert.equal(GLOBAL_BACKGROUND_TICK_LOCK, "background:tick");
  assert.equal(runtimeLockName("background", "tick"), GLOBAL_BACKGROUND_TICK_LOCK);
  assert.equal(
    budgetRuntimeLockName("budget_1", BUDGET_RUNTIME_LOCK_JOBS.projection),
    "budget:budget_1:projection"
  );
  assert.equal(
    budgetRuntimeLockName("budget-1", BUDGET_RUNTIME_LOCK_JOBS.automaticBackup),
    "budget:budget-1:automatic-backup"
  );

  for (const jobName of Object.values(BUDGET_RUNTIME_LOCK_JOBS)) {
    assert.match(budgetRuntimeLockName("budget_1", jobName), /^[A-Za-z0-9:_-]{1,128}$/);
  }
});

test("runtime lock names reject path-like, empty, and oversized segments", () => {
  assert.throws(() => runtimeLockName("budget", "../bad"), /lock segment 2/);
  assert.throws(() => runtimeLockName("budget", ""), /lock segment 2/);
  assert.throws(() => budgetRuntimeLockName("budget/1", "projection"), /budgetId/);
  assert.throws(() => budgetRuntimeLockName("budget_1", "projection!"), /jobName/);
  assert.throws(
    () => runtimeLockName("a".repeat(64), "b".repeat(64), "c"),
    /128 chars/
  );
});

test("runtime lock service is disabled by default", async () => {
  const events = [];
  const runtime = await createCashflowRuntimeLockService({
    env: {},
    logServerEvent: (kind, details) => events.push({ kind, details })
  });

  assert.equal(runtime.lockService, null);
  assert.equal(runtime.config.enabled, false);
  assert.deepEqual(describeCashflowRuntimeLockConfig({}), {
    backend: "none",
    databaseUrlConfigured: false,
    enabled: false,
    supported: true
  });
  assert.equal(events[0].kind, "cashflow_runtime_lock_service_disabled");
  await runtime.close();
});

test("runtime lock service fail-closes unsupported or incomplete config without logging secrets", async () => {
  await assert.rejects(
    () => createCashflowRuntimeLockService({
      env: {
        CASHFLOW_RUNTIME_LOCK_BACKEND: "redis"
      }
    }),
    error => {
      assert.equal(error.code, "CASHFLOW_RUNTIME_LOCK_BACKEND_UNSUPPORTED");
      assert.match(error.message, /Unsupported CASHFLOW_RUNTIME_LOCK_BACKEND "redis"/);
      return true;
    }
  );

  await assert.rejects(
    () => createCashflowRuntimeLockService({
      env: {
        CASHFLOW_RUNTIME_LOCK_BACKEND: "postgres"
      }
    }),
    error => {
      assert.equal(error.code, "CASHFLOW_RUNTIME_LOCK_DATABASE_URL_REQUIRED");
      assert.match(error.message, /requires CASHFLOW_RUNTIME_LOCK_DATABASE_URL/);
      return true;
    }
  );

  const config = describeCashflowRuntimeLockConfig({
    CASHFLOW_RUNTIME_LOCK_BACKEND: "pg",
    CASHFLOW_DATABASE_URL: "postgres://cashflow:secret@example.invalid/cashflow"
  });
  assert.equal(config.backend, "postgres");
  assert.equal(config.databaseUrlConfigured, true);
  assert.doesNotMatch(JSON.stringify(config), /secret/);
  assert.doesNotMatch(JSON.stringify(config), /example\.invalid/);
});

test("runtime lock service can use Postgres without exposing connection details", async () => {
  const fakePg = fakePgModule();
  const events = [];
  const runtime = await createCashflowRuntimeLockService({
    env: {
      CASHFLOW_RUNTIME_LOCK_BACKEND: "postgres",
      CASHFLOW_RUNTIME_LOCK_DATABASE_URL: "postgres://cashflow:secret@example.invalid/cashflow",
      CASHFLOW_RUNTIME_LOCK_OWNER_ID: "test-owner"
    },
    logServerEvent: (kind, details = {}) => events.push({ kind, details }),
    pgModule: fakePg.module
  });

  assert.equal(runtime.config.backend, "postgres");
  assert.equal(runtime.lockService.ownerId, "test-owner");
  assert.equal(events.some(entry => entry.kind === "cashflow_postgres_global_schema_ready"), true);
  assert.deepEqual(
    events.find(entry => entry.kind === "cashflow_runtime_lock_service_enabled")?.details,
    {
      backend: "postgres",
      databaseUrlConfigured: true
    }
  );
  assert.doesNotMatch(JSON.stringify(events), /secret/);
  assert.doesNotMatch(JSON.stringify(events), /example\.invalid/);

  const locked = await runtime.lockService.withLock("background:tick", async () => "ok");
  assert.equal(locked.acquired, true);
  assert.equal(locked.result, "ok");
  assert.equal(fakePg.queries.some(entry => String(entry.sql).includes("CREATE TABLE IF NOT EXISTS cashflow_runtime_locks")), true);
  assert.equal(fakePg.queries.some(entry => String(entry.sql).includes("INSERT INTO cashflow_runtime_locks")), true);

  await runtime.close();
  assert.equal(fakePg.pools[0].ended, true);
});
