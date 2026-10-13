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
    /public external service/
  );
  await assert.rejects(
    () => service.updateSettings("household", { discord_webhook_url: "http://[fe9a::1]/hook" }),
    /public external service/
  );
  assert.equal(isPrivateIp("fe9a::1"), true);
  assert.equal(isPrivateIp("febf::1"), true);
  assert.equal(isPrivateIp("fec0::1"), false);
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
