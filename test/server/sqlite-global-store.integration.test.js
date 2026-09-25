import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSqliteGlobalStore } from "../../src/server/cashflow-sqlite-global-store.js";
import { ensureLegacyBudget } from "../../src/server/cashflow-global-schema.js";

test("SQLite global store replaceRows bypasses guard triggers", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cashflow-test-"));
  const store = createSqliteGlobalStore({
    dataDir: tmpDir,
    listCashflowUserIds: () => []
  });

  store.initialize();
  
  // Create an account and budget, which establishes a 'legacy-admin' as the 'owner'
  store.withRepository((repo, db) => {
    ensureLegacyBudget(db, { budgetId: "test-budget" });
  });

  // Try updating manually. The guard trigger prevents demoting the last owner.
  assert.throws(() => {
    store.transaction((repo, db) => {
      db.prepare("UPDATE budget_memberships SET role = 'viewer' WHERE budget_id = 'test-budget' AND role = 'owner'").run();
    });
  }, /last_budget_owner/);

  // Use replaceRows to replace the memberships, including a demotion. 
  // It should drop the guard triggers, do the replace, and recreate them.
  await store.replaceRows("budget_memberships", [{
    budget_id: "test-budget",
    account_id: "legacy-admin",
    role: "viewer", // Demoted to viewer! This would fail without dropping the trigger.
    invited_by_account_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }]);

  // Read back to ensure the trigger is back
  // Now there are NO owners, so if we tried to change the viewer to something else, there's no owner to protect,
  // but if we recreate an owner and try to demote it, it should fail.
  store.transaction((repo, db) => {
    db.prepare("UPDATE budget_memberships SET role = 'owner' WHERE budget_id = 'test-budget'").run();
  });

  assert.throws(() => {
    store.transaction((repo, db) => {
      db.prepare("UPDATE budget_memberships SET role = 'viewer' WHERE budget_id = 'test-budget' AND role = 'owner'").run();
    });
  }, /last_budget_owner/);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
