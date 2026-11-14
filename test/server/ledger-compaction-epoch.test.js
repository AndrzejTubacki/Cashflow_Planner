import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { createCashflowLedgerService } from "../../src/server/cashflow-ledger-service.js";

/** Derived summaries preserve both accepted facts and outstanding device cursors. */
test("SQLite history summaries preserve the sync epoch and accepted revision", async () => {
  const harness = await createCashflowTestHarness({ userId: "compaction-epoch", today: "2026-05-20" });
  const db = createCashflowDbService(createCashflowStoragePaths(harness.dataDir));
  try {
    const ledgerDb = db.openLedgerDb(harness.userId, 2025);
    try {
      const insert = ledgerDb.prepare(`INSERT INTO confirmed_transactions (id, name, currency, amount, type, date, confirmed_date,
        fx_rate, buffered_fx_rate, ledger_currency, running_balance_pln, occurrence_key, ledger_amount, created_at, updated_at)
        VALUES (?, ?, 'PLN', ?, ?, ?, ?, 1, 1, 'PLN', 0, ?, ?, ?, ?)`);
      insert.run("old-income", "Old income", 1000, "income", "2025-01-10", "2025-01-10", "manual:old-income:income:2025-01-10", 1000, "2025-01-10T00:00:00Z", "2025-01-10T00:00:00Z");
      insert.run("old-expense", "Old expense", 250, "expense", "2025-02-10", "2025-02-10", "manual:old-expense:expense:2025-02-10", 250, "2025-02-10T00:00:00Z", "2025-02-10T00:00:00Z");
    } finally { ledgerDb.close(); }
    const oldEpoch = randomUUID();
    const planning = db.openPlanningDb(harness.userId);
    try { planning.prepare("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 4)").run(harness.userId, oldEpoch); } finally { planning.close(); }
    const ledger = createCashflowLedgerService({ openPlanningDb: db.openPlanningDb, openLedgerDb: db.openLedgerDb, listLedgerYears: db.listLedgerYears });
    const plan = ledger.historicalLedgerCompactionPlan(harness.userId, { months: 12, today: "2026-05-20" });
    assert.equal(plan.needsCompaction, true);
    const result = ledger.compactHistoricalLedger(harness.userId, { months: 12, today: "2026-05-20", now: "2026-05-20T00:00:00.000Z", plan });
    assert.equal(result.compactedRows, 2);
    const check = db.openPlanningDb(harness.userId);
    try {
      const head = check.prepare("SELECT epoch, revision FROM cashflow_sync_heads").get();
      assert.equal(head.epoch, oldEpoch);
      assert.equal(head.revision, 4);
      assert.equal(check.prepare("SELECT COUNT(*) AS n FROM ledger_transactions").get().n, 2);
    } finally { check.close(); }
  } finally { await harness.cleanup(); }
});
