import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

async function withHarness(fn) {
  const harness = await createCashflowTestHarness();
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

function insertPending(harness, row) {
  const db = harness.openPlanningDb();

  try {
    db.prepare(`
      INSERT INTO pending_transactions (
        id, name, currency, amount, type, date,
        fx_rate, buffered_fx_rate, status, funded_amount, requested_amount,
        ledger_amount, occurrence_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 'pending', ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      row.id,
      row.name,
      row.currency || "PLN",
      row.amount,
      row.type,
      row.date,
      row.amount,
      row.amount,
      row.amount,
      row.occurrenceKey
    );
  } finally {
    db.close();
  }
}

test("moving future to pending removes future row and is idempotent by occurrence key", async () => withHarness(async harness => {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      future_periods: 2,
      fx_provider: "manual",
      manual_fx_rates: {}
    }
  });

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Pending move income",
      currency: "PLN",
      amount: 100,
      type: "income",
      date: "2026-06-01"
    }
  });

  const snapshot = await harness.api("/api");
  const future = snapshot.futureTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(future);

  const firstMove = await harness.api(`/api/future/${encodeURIComponent(future.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: future.occurrence_key }
  });

  assert.equal(firstMove.move.moved, true);
  assert.equal(firstMove.pendingTransactions.filter(tx => tx.occurrence_key === future.occurrence_key).length, 1);
  assert.equal(firstMove.futureTransactions.filter(tx => tx.id === future.id).length, 0);

  const secondMove = await harness.api(`/api/future/${encodeURIComponent(future.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: future.occurrence_key }
  });

  assert.equal(secondMove.move.alreadyPending, true);
  assert.equal(secondMove.pendingTransactions.filter(tx => tx.occurrence_key === future.occurrence_key).length, 1);
  assert.equal(secondMove.futureTransactions.filter(tx => tx.id === future.id).length, 0);
}));

test("editing a period-setting pending income date keeps the original source occurrence handled", async () => withHarness(async harness => {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      future_periods: 2,
      fx_provider: "manual",
      fx_used_currencies: ["EUR"],
      manual_fx_rates: { EUR: 4 },
      fx_buffer_percent: 0
    }
  });

  const income = await harness.api("/api/recurring-incomes", {
    method: "POST",
    body: {
      name: "BBMF",
      currency: "EUR",
      amount: 100,
      prediction_strategy: "fixed",
      active: 1,
      repeat_every_months: 1,
      anchor_type: "month_end",
      anchor_offset_days: -2,
      anchor_business_day_adjustment: "previous",
      anchor_holiday_country: "DE",
      period_setting: 1
    }
  });

  let snapshot = await harness.api("/api");
  const future = snapshot.futureTransactions.find(tx =>
    tx.source_recurring_income_id === income.id &&
    tx.date === "2026-05-29"
  );
  assert.ok(future);

  const moved = await harness.api(`/api/future/${encodeURIComponent(future.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: future.occurrence_key }
  });
  const pending = moved.pendingTransactions.find(tx => tx.occurrence_key === future.occurrence_key);
  assert.ok(pending);

  const edited = await harness.api(`/api/pending/${encodeURIComponent(pending.id)}`, {
    method: "PUT",
    body: {
      date: "2026-05-28",
      amount: 110
    }
  });
  assert.equal(edited.date, "2026-05-28");
  assert.equal(edited.occurrence_key, future.occurrence_key);

  await harness.api(`/api/pending/${encodeURIComponent(pending.id)}/confirm`, {
    method: "POST",
    body: {
      amount: 110,
      confirmed_date: "2026-05-28"
    }
  });

  await harness.api("/api/run-jobs", { method: "POST", body: {} });
  snapshot = await harness.api("/api");

  assert.equal(
    snapshot.futureTransactions.some(tx => tx.occurrence_key === future.occurrence_key),
    false
  );

  const confirmed = snapshot.confirmedTransactions.find(tx => tx.id === pending.id);
  assert.ok(confirmed);
  assert.equal(confirmed.date, "2026-05-28");
  assert.equal(confirmed.occurrence_key, future.occurrence_key);
}));

test("confirming pending rows deletes pending rows and recalculates ledger balances across years", async () => withHarness(async harness => {
  await harness.api("/api");

  const rows = [
    { id: "pend-2025-income", name: "Prior year income", type: "income", amount: 100, date: "2025-12-31", occurrenceKey: "test:2025-income" },
    { id: "pend-2026-income", name: "Income", type: "income", amount: 1000, date: "2026-01-01", occurrenceKey: "test:2026-income" },
    { id: "pend-2026-expense", name: "Expense", type: "expense", amount: 200, date: "2026-01-02", occurrenceKey: "test:2026-expense" },
    { id: "pend-2026-goal", name: "Goal allocation", type: "goal_allocation", amount: 300, date: "2026-01-03", occurrenceKey: "test:2026-goal" },
    { id: "pend-2026-flex", name: "Flex allocation", type: "expense", amount: 100, date: "2026-01-04", occurrenceKey: "test:2026-flex" }
  ];

  for (const row of rows) {
    insertPending(harness, row);
  }

  for (const row of rows) {
    await harness.api(`/api/pending/${encodeURIComponent(row.id)}/confirm`, {
      method: "POST",
      body: {
        amount: row.amount,
        confirmed_date: row.date
      }
    });
  }

  const snapshot = await harness.api("/api");
  for (const row of rows) {
    assert.equal(snapshot.pendingTransactions.some(tx => tx.id === row.id), false);
  }

  const ledger2025 = harness.openLedgerDb("2025");
  const ledger2026 = harness.openLedgerDb("2026");

  try {
    const confirmed = [
      ...ledger2025.prepare("SELECT * FROM confirmed_transactions").all(),
      ...ledger2026.prepare("SELECT * FROM confirmed_transactions").all()
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id)));

    assert.deepEqual(
      confirmed.map(row => [row.id, row.running_balance_pln, row.ledger_amount]),
      [
        ["pend-2025-income", 100, 100],
        ["pend-2026-income", 1100, 1000],
        ["pend-2026-expense", 900, 200],
        ["pend-2026-goal", 600, 300],
        ["pend-2026-flex", 500, 100]
      ]
    );

    let balance = 0;
    for (const row of confirmed) {
      const expectedLedgerAmount = Number(row.amount) * Number(row.buffered_fx_rate || row.fx_rate || 1);
      balance += row.type === "income" ? expectedLedgerAmount : -expectedLedgerAmount;
      assert.equal(row.ledger_amount, expectedLedgerAmount);
      assert.equal(row.running_balance_pln, balance);
    }
  } finally {
    ledger2025.close();
    ledger2026.close();
  }
}));
