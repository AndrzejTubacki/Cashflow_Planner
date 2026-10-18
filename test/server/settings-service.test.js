import assert from "node:assert/strict";
import test from "node:test";

import {
  createCashflowSettingsService,
  isPrivateIp
} from "../../src/server/cashflow-settings-service.js";

function sqliteSettingsDb() {
  return {
    close() {},
    prepare(sql) {
      assert.match(sql, /SELECT \* FROM settings WHERE id = 1/);
      return {
        get() {
          return { id: 1, ledger_currency: "PLN", timezone: "UTC" };
        }
      };
    }
  };
}

function writableSqliteSettingsDb() {
  const settings = { id: 1, ledger_currency: "PLN", timezone: "UTC", ntfy_url: null };
  return {
    settings,
    close() {},
    transaction(work) {
      return () => work();
    },
    prepare(sql) {
      if (/SELECT \* FROM settings WHERE id = 1/.test(sql)) return { get: () => ({ ...settings }) };
      if (/UPDATE settings/.test(sql)) {
        return {
          run(value) {
            settings.ntfy_url = value;
            return { changes: 1 };
          }
        };
      }
      throw new Error(`Unexpected SQL in settings test: ${sql}`);
    }
  };
}

test("settings service can read settings through the budget-store facade", async () => {
  const calls = [];
  const service = createCashflowSettingsService({
    budgetStore: {
      async listPlanningRows(budgetId, tableName) {
        calls.push({ budgetId, tableName });
        return [
          { id: 2, timezone: "UTC" },
          { id: 1, timezone: "Europe/Warsaw" }
        ];
      }
    },
    openPlanningDb: () => {
      throw new Error("SQLite planning DB should not be opened for async settings reads");
    }
  });

  assert.deepEqual(await service.getSettingsAsync("household"), {
    id: 1,
    timezone: "Europe/Warsaw"
  });
  assert.deepEqual(calls, [{
    budgetId: "household",
    tableName: "settings"
  }]);
});

test("settings service async read falls back to the existing SQLite settings reader", async () => {
  let closed = false;
  const service = createCashflowSettingsService({
    openPlanningDb: userId => {
      assert.equal(userId, "household");
      return {
        close() {
          closed = true;
        },
        prepare(sql) {
          assert.match(sql, /SELECT \* FROM settings WHERE id = 1/);
          return {
            get() {
              return {
                id: 1,
                timezone: "UTC"
              };
            }
          };
        }
      };
    }
  });

  assert.deepEqual(await service.getSettingsAsync("household"), {
    id: 1,
    timezone: "UTC"
  });
  assert.equal(closed, true);
});

test("settings save rejects bracketed and complete link-local IPv6 ranges before SQLite writes", async () => {
  const service = createCashflowSettingsService({
    openPlanningDb: () => sqliteSettingsDb()
  });

  await assert.rejects(
    () => service.updateSettings("household", { ntfy_url: "http://[::1]/topic" }),
    /administrator can allow this host/
  );
  await assert.rejects(
    () => service.updateSettings("household", { discord_webhook_url: "http://[fe9a::1]/hook" }),
    /public external service/
  );
  assert.equal(isPrivateIp("fe9a::1"), true);
  assert.equal(isPrivateIp("febf::1"), true);
  assert.equal(isPrivateIp("fec0::1"), false);
  // Mapped IPv6 must not bypass either save-time destination validation path.
  await assert.rejects(
    () => service.updateSettings("household", { ntfy_url: "http://[::ffff:7f00:1]/topic" }),
    /administrator can allow this host/
  );
});

test("Postgres settings save checks every resolved webhook address before opening a transaction", async () => {
  let transactionOpened = false;
  const service = createCashflowSettingsService({
    budgetStore: {
      backend: "postgres",
      async listPlanningRows() {
        return [{ id: 1, ledger_currency: "PLN", timezone: "UTC" }];
      },
      async transaction() {
        transactionOpened = true;
        throw new Error("transaction must not open for a private webhook target");
      }
    },
    lookupHost: async (hostname, options) => {
      assert.equal(hostname, "hooks.example.test");
      assert.deepEqual(options, { all: true });
      return [
        { address: "203.0.113.10", family: 4 },
        { address: "192.168.1.20", family: 4 }
      ];
    },
    openPlanningDb: () => {
      throw new Error("Postgres settings save must not open SQLite");
    }
  });

  await assert.rejects(
    () => service.updateSettings("household", {
      discord_webhook_url: "https://hooks.example.test/webhook"
    }),
    /resolves to a private IP address/
  );
  assert.equal(transactionOpened, false);
});

test("settings save rejects a private ntfy host unless an administrator allowed it", async () => {
  const service = createCashflowSettingsService({
    getGlobalOptions: async () => ({ ntfy_allowed_private_hosts: [] }),
    lookupHost: async () => [{ address: "192.168.1.20", family: 4 }],
    openPlanningDb: writableSqliteSettingsDb
  });

  await assert.rejects(
    () => service.updateSettings("household", { ntfy_url: "https://ntfy.lan/topic" }),
    /administrator can allow this host under Settings > Admin > Global options/
  );
});

test("settings save accepts and logs an exactly allowed private ntfy host", async () => {
  const db = writableSqliteSettingsDb();
  const events = [];
  const service = createCashflowSettingsService({
    getGlobalOptions: async () => ({ ntfy_allowed_private_hosts: ["NTFY.LAN."] }),
    logServerEvent: (kind, details) => events.push({ kind, details }),
    lookupHost: async hostname => {
      assert.equal(hostname, "ntfy.lan");
      return [{ address: "192.168.1.20", family: 4 }];
    },
    openPlanningDb: () => db
  });

  const saved = await service.updateSettings("household", { ntfy_url: "https://ntfy.lan/topic/token" });
  assert.equal(saved.ntfy_url, "https://ntfy.lan/topic/token");
  assert.deepEqual(events, [{
    kind: "cashflow_ntfy_private_host_allowed",
    details: { host: "ntfy.lan" }
  }]);
});

test("an allowed private ntfy host must still resolve", async () => {
  const service = createCashflowSettingsService({
    getGlobalOptions: async () => ({ ntfy_allowed_private_hosts: ["missing.lan"] }),
    lookupHost: async () => { throw new Error("not found"); },
    openPlanningDb: writableSqliteSettingsDb
  });

  await assert.rejects(
    () => service.updateSettings("household", { ntfy_url: "https://missing.lan/topic" }),
    /ntfy_url hostname could not be resolved/
  );
});

test("an ntfy allow-list entry never permits a private Discord webhook", async () => {
  const service = createCashflowSettingsService({
    getGlobalOptions: async () => ({ ntfy_allowed_private_hosts: ["hooks.lan"] }),
    lookupHost: async () => [{ address: "10.0.0.8", family: 4 }],
    openPlanningDb: writableSqliteSettingsDb
  });

  await assert.rejects(
    () => service.updateSettings("household", { discord_webhook_url: "https://hooks.lan/webhook" }),
    /resolves to a private IP address and is not allowed/
  );
});
