import assert from "node:assert/strict";
import test from "node:test";

import {
  createCashflowSettingsService
} from "../../src/server/cashflow-settings-service.js";

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
