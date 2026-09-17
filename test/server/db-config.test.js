import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertCashflowDatabaseUrlConfigured,
  assertCashflowDbBackendSupported,
  resolveCashflowDbConfig
} from "../../src/server/cashflow-db-config.js";
import {
  createCashflowStorageBackend,
  describeCashflowStorageBackend
} from "../../src/server/cashflow-storage-backend.js";

async function withTempDir(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "cashflow-db-config-test-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("database backend defaults to supported SQLite mode", () => {
  const config = resolveCashflowDbConfig({});
  assert.deepEqual(config, {
    backend: "sqlite",
    databaseUrlConfigured: false,
    external: false,
    supported: true
  });
  assert.equal(assertCashflowDbBackendSupported(config), config);
});

test("database backend recognizes Postgres aliases and treats them as supported", () => {
  for (const value of ["postgres", "postgresql", "pg"]) {
    const config = resolveCashflowDbConfig({
      CASHFLOW_DB_BACKEND: value,
      CASHFLOW_DATABASE_URL: "postgres://cashflow:secret@example.invalid/cashflow"
    });

    assert.equal(config.backend, "postgres");
    assert.equal(config.databaseUrlConfigured, true);
    assert.equal(config.external, true);
    assert.equal(config.supported, true);
    assert.equal(assertCashflowDbBackendSupported(config), config);
    assert.equal(assertCashflowDatabaseUrlConfigured(config), config);
  }
});

test("database backend requires a database URL for Postgres", () => {
  const config = resolveCashflowDbConfig({
    CASHFLOW_DB_BACKEND: "postgres"
  });

  assert.equal(config.backend, "postgres");
  assert.equal(config.databaseUrlConfigured, false);
  assert.throws(
    () => assertCashflowDatabaseUrlConfigured(config),
    error => {
      assert.equal(error.code, "CASHFLOW_DATABASE_URL_REQUIRED");
      assert.match(error.message, /CASHFLOW_DATABASE_URL/);
      return true;
    }
  );
});

test("database backend rejects unknown values without using the database URL", () => {
  const config = resolveCashflowDbConfig({
    CASHFLOW_DB_BACKEND: "oracle",
    CASHFLOW_DATABASE_URL: "postgres://cashflow:secret@example.invalid/cashflow"
  });

  assert.equal(config.backend, "oracle");
  assert.equal(config.supported, false);
  assert.throws(
    () => assertCashflowDbBackendSupported(config),
    error => {
      assert.match(error.message, /Unsupported CASHFLOW_DB_BACKEND "oracle"/);
      assert.match(error.message, /sqlite, postgres/);
      assert.doesNotMatch(error.message, /secret/);
      assert.doesNotMatch(error.message, /example\.invalid/);
      return true;
    }
  );
});

test("storage backend descriptor keeps SQLite as the synchronous runtime backend", () => {
  const description = describeCashflowStorageBackend(resolveCashflowDbConfig({}));

  assert.equal(description.backend, "sqlite");
  assert.equal(description.runtimeSupported, true);
  assert.equal(description.external, false);
  assert.equal(description.failClosedReason, null);
  assert.equal(description.capabilities.sqliteSyncRuntime, true);
  assert.equal(description.capabilities.globalRuntime, "sqlite-file");
  assert.equal(description.capabilities.budgetRuntime, "sqlite-files");
  assert.equal(description.capabilities.multiReplicaSafe, false);
});

test("storage backend descriptor recognizes Postgres as a real, supported runtime backend", () => {
  const description = describeCashflowStorageBackend(resolveCashflowDbConfig({
    CASHFLOW_DB_BACKEND: "postgres",
    CASHFLOW_DATABASE_URL: "postgres://cashflow:secret@example.invalid/cashflow"
  }));

  assert.equal(description.backend, "postgres");
  assert.equal(description.runtimeSupported, true);
  assert.equal(description.external, true);
  assert.equal(description.failClosedReason, null);
  assert.equal(description.capabilities.migrationOnly, false);
  assert.equal(description.capabilities.multiReplicaSafe, true);
  assert.equal(description.capabilities.sqliteSyncRuntime, false);
  assert.doesNotMatch(JSON.stringify(description), /secret/);
  assert.doesNotMatch(JSON.stringify(description), /example\.invalid/);
});

test("storage backend factory fails closed for an unrecognized backend name before touching SQLite openers", async () => {
  await withTempDir(async dataDir => {
    const calls = [];

    await assert.rejects(
      () => createCashflowStorageBackend({
        databaseConfig: resolveCashflowDbConfig({
          CASHFLOW_DB_BACKEND: "oracle"
        }),
        dataDir,
        listCashflowUserIds: () => {
          calls.push("listCashflowUserIds");
          return [];
        },
        listLedgerYears: () => {
          calls.push("listLedgerYears");
          return [];
        },
        openLedgerDb: () => {
          calls.push("openLedgerDb");
          throw new Error("sqlite ledger opener should not run");
        },
        openPlanningDb: () => {
          calls.push("openPlanningDb");
          throw new Error("sqlite planning opener should not run");
        }
      }),
      error => {
        assert.equal(error.code, "CASHFLOW_DB_BACKEND_UNSUPPORTED");
        assert.match(error.message, /Unsupported CASHFLOW_DB_BACKEND "oracle"/);
        return true;
      }
    );

    assert.deepEqual(calls, []);
  });
});

test("storage backend factory fails closed for Postgres without a database URL, before touching SQLite openers", async () => {
  await withTempDir(async dataDir => {
    const calls = [];

    await assert.rejects(
      () => createCashflowStorageBackend({
        databaseConfig: resolveCashflowDbConfig({
          CASHFLOW_DB_BACKEND: "postgres"
        }),
        dataDir,
        env: {},
        listCashflowUserIds: () => {
          calls.push("listCashflowUserIds");
          return [];
        },
        listLedgerYears: () => {
          calls.push("listLedgerYears");
          return [];
        },
        openLedgerDb: () => {
          calls.push("openLedgerDb");
          throw new Error("sqlite ledger opener should not run");
        },
        openPlanningDb: () => {
          calls.push("openPlanningDb");
          throw new Error("sqlite planning opener should not run");
        }
      }),
      error => {
        assert.equal(error.code, "CASHFLOW_DATABASE_URL_REQUIRED");
        return true;
      }
    );

    assert.deepEqual(calls, []);
  });
});

test("storage backend factory wires the SQLite global and budget adapters", async () => {
  await withTempDir(async dataDir => {
    const storage = await createCashflowStorageBackend({
      dataDir,
      listCashflowUserIds: () => [],
      listLedgerYears: () => [],
      openLedgerDb: () => {
        throw new Error("not used");
      },
      openPlanningDb: () => {
        throw new Error("not used");
      }
    });

    assert.equal(storage.backend, "sqlite");
    assert.equal(storage.runtimeSupported, true);
    assert.equal(storage.config.backend, "sqlite");
    assert.equal(storage.globalStore.backend, "sqlite");
    assert.equal(storage.budgetStore.backend, "sqlite");
    assert.equal(storage.capabilities.sqliteSyncRuntime, true);

    assert.equal(storage.globalStore.checkReadiness().ok, true);
  });
});
