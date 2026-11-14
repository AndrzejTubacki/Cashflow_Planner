import assert from "node:assert/strict";
import test from "node:test";
import { createGlobalStoreExport } from "../../src/server/cashflow-global-store-export.js";
import { applyGlobalStoreImportPlan } from "../../src/server/cashflow-global-store-import-plan.js";

test("portable global exports never read device credentials or instance identity", async () => {
  const exported = await createGlobalStoreExport({ globalStore: {
    backend: "sqlite",
    listRows: async table => {
      assert.ok(!table.startsWith("app_device"));
      return [];
    }
  } });
  for (const [table, rows] of Object.entries(exported.tables)) {
    if (table.startsWith("app_device")) assert.deepEqual(rows, []);
  }
});

test("even caller-supplied import plans cannot restore device credentials", async () => {
  const calls = [];
  const plan = { rowCounts: {}, writeBatches: [
    { tableName: "app_devices", rows: [{ id: "old-device" }] },
    { tableName: "app_device_instance", rows: [{ id: 1, instance_id: "cloned" }] },
    { tableName: "app_device_tokens", rows: [{ token_hash: "old-hash" }] }
  ] };
  await applyGlobalStoreImportPlan({ plan, mode: "append", globalStore: {
    insertRows: async table => { calls.push(table); }
  } });
  assert.deepEqual(calls, []);
  await applyGlobalStoreImportPlan({ plan, mode: "replace", globalStore: {
    replaceAllRows: async tables => {
      for (const [table, rows] of Object.entries(tables)) {
        if (table.startsWith("app_device")) assert.deepEqual(rows, []);
      }
    }
  } });
});