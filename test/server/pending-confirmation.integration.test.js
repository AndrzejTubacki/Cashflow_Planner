import assert from "node:assert/strict";
import test from "node:test";

import { createCashflowTestHarness } from "../helpers/cashflow-test-harness.js";

async function withHarness(fn, options = {}) {
  const harness = await createCashflowTestHarness(options);
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
      row.occurrenceKey ?? null
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

test("recalculating pending deletes pending rows and regenerates allocations", async () => withHarness(async harness => {
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
      name: "Pending recalculation expense",
      currency: "PLN",
      amount: 100,
      type: "expense",
      date: "2026-06-01"
    }
  });

  let snapshot = await harness.api("/api");
  const future = snapshot.futureTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(future);

  const moved = await harness.api(`/api/future/${encodeURIComponent(future.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: future.occurrence_key }
  });

  assert.equal(moved.pendingTransactions.some(tx => tx.occurrence_key === future.occurrence_key), true);
  assert.equal(moved.futureTransactions.some(tx => tx.occurrence_key === future.occurrence_key), false);

  const recalculated = await harness.api("/api/pending/recalculate", {
    method: "POST",
    body: {}
  });

  assert.equal(recalculated.deletedPendingCount, 1);
  assert.equal(recalculated.pendingTransactions.some(tx => tx.occurrence_key === future.occurrence_key), false);
  assert.equal(recalculated.futureTransactions.some(tx => tx.occurrence_key === future.occurrence_key), true);
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

test("changing ledger currency creates and confirms a visible pending conversion row", async () => withHarness(async harness => {
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      fx_provider: "manual",
      fx_buffer_percent: 0,
      manual_fx_rates: {}
    }
  });

  const oneOff = await harness.api("/api/one-off", {
    method: "POST",
    body: {
      name: "Starting PLN balance",
      currency: "PLN",
      amount: 100,
      type: "income",
      date: "2026-05-21"
    }
  });

  let snapshot = await harness.api("/api");
  const future = snapshot.futureTransactions.find(tx => tx.source_one_off_id === oneOff.id);
  assert.ok(future);

  const moved = await harness.api(`/api/future/${encodeURIComponent(future.id)}/move-to-pending`, {
    method: "POST",
    body: { occurrenceKey: future.occurrence_key }
  });
  const pendingIncome = moved.pendingTransactions.find(tx => tx.occurrence_key === future.occurrence_key);
  assert.ok(pendingIncome);

  await harness.api(`/api/pending/${encodeURIComponent(pendingIncome.id)}/confirm`, {
    method: "POST",
    body: {
      amount: 100,
      confirmed_date: "2026-05-21"
    }
  });

  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      ledger_currency: "USD",
      fx_provider: "manual",
      fx_used_currencies: ["PLN"],
      manual_fx_rates: { PLN: 0.25 },
      fx_buffer_percent: 0
    }
  });

  snapshot = await harness.api("/api");
  assert.equal(snapshot.settings.ledger_currency, "USD");

  const conversionRows = snapshot.pendingTransactions.filter(tx =>
    String(tx.occurrence_key || "").startsWith("ledger_currency_conversion:")
  );
  assert.equal(conversionRows.length, 1);

  const conversion = conversionRows[0];
  assert.equal(conversion.name, "Opening balance conversion PLN to USD");
  assert.equal(conversion.currency, "USD");
  assert.equal(conversion.ledger_currency, "USD");
  assert.equal(conversion.type, "income");
  assert.equal(conversion.amount, 25);
  assert.equal(conversion.ledger_amount, 25);
  assert.equal(conversion.fx_rate, 1);
  assert.equal(conversion.buffered_fx_rate, 1);

  await harness.api(`/api/pending/${encodeURIComponent(conversion.id)}/confirm`, {
    method: "POST",
    body: {
      amount: 25,
      confirmed_date: "2026-05-21"
    }
  });

  snapshot = await harness.api("/api");
  const confirmedConversion = snapshot.confirmedTransactions.find(tx => tx.id === conversion.id);
  const originalConfirmed = snapshot.confirmedTransactions.find(tx => tx.id === pendingIncome.id);

  assert.ok(confirmedConversion);
  assert.ok(originalConfirmed);
  assert.equal(confirmedConversion.ledger_currency, "USD");
  assert.equal(confirmedConversion.running_balance, 25);
  assert.equal(originalConfirmed.ledger_currency, "PLN");
}));

test("changing ledger currency with a non-zero balance requires an FX rate", async () => withHarness(async harness => {
  await harness.api("/api");

  insertPending(harness, {
    id: "pending-balance",
    name: "Balance",
    type: "income",
    amount: 100,
    date: "2026-05-21",
    occurrenceKey: "test:balance"
  });

  await harness.api("/api/pending/pending-balance/confirm", {
    method: "POST",
    body: {
      amount: 100,
      confirmed_date: "2026-05-21"
    }
  });

  const result = await harness.request("/api/settings", {
    method: "PUT",
    body: {
      ledger_currency: "USD",
      fx_provider: "manual",
      manual_fx_rates: {}
    }
  });

  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /Missing FX rate for PLN\/USD/);
}));

test("pending edits and confirmations reject negative or malformed amounts", async () => withHarness(async harness => {
  insertPending(harness, {
    id: "strict-pending",
    name: "Strict pending",
    type: "income",
    amount: 100,
    date: "2026-05-20",
    occurrenceKey: "strict-pending"
  });

  for (const amount of [-1, "abc", ""]) {
    const edit = await harness.request("/api/pending/strict-pending", {
      method: "PUT",
      body: { amount }
    });
    assert.equal(edit.response.status, 400, `edit ${JSON.stringify(amount)}`);

    const confirm = await harness.request("/api/pending/strict-pending/confirm", {
      method: "POST",
      body: { amount, confirmed_date: "2026-05-20" }
    });
    assert.equal(confirm.response.status, 400, `confirm ${JSON.stringify(amount)}`);
  }

  const snapshot = await harness.api("/api");
  assert.equal(snapshot.pendingTransactions.some(row => row.id === "strict-pending"), true);
  assert.equal(snapshot.confirmedTransactions.some(row => row.id === "strict-pending"), false);
}));

test("source-less pending rows with matching type and date confirm independently", async () => withHarness(async harness => {
  for (const id of ["manual-pending-a", "manual-pending-b"]) {
    insertPending(harness, {
      id,
      name: id,
      type: "income",
      amount: 10,
      date: "2026-05-20"
    });
  }

  await harness.api("/api/pending/manual-pending-a/confirm", {
    method: "POST",
    body: { amount: 10, confirmed_date: "2026-05-20" }
  });
  await harness.api("/api/pending/manual-pending-b/confirm", {
    method: "POST",
    body: { amount: 10, confirmed_date: "2026-05-20" }
  });

  const snapshot = await harness.api("/api");
  const rows = snapshot.confirmedTransactions.filter(row => row.id.startsWith("manual-pending-"));
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map(row => row.occurrence_key)).size, 2);
  assert.ok(rows.every(row => row.occurrence_key.startsWith(`manual:${row.id}:income:2026-05-20`)));
  assert.equal(snapshot.pendingTransactions.some(row => row.id.startsWith("manual-pending-")), false);
}));

test("a second ledger currency switch is blocked until the pending conversion is resolved", async () => withHarness(async harness => {
  insertPending(harness, {
    id: "switch-seed",
    name: "Switch seed",
    type: "income",
    amount: 100,
    date: "2026-05-20",
    occurrenceKey: "switch-seed"
  });
  await harness.api("/api/pending/switch-seed/confirm", {
    method: "POST",
    body: { amount: 100, confirmed_date: "2026-05-20" }
  });

  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      ledger_currency: "USD",
      fx_provider: "manual",
      manual_fx_rates: { "PLN/USD": 0.25 }
    }
  });

  let snapshot = await harness.api("/api");
  const firstConversion = snapshot.pendingTransactions.find(row =>
    String(row.occurrence_key || "").startsWith("ledger_currency_conversion:")
  );
  assert.ok(firstConversion);
  const beforeEventCount = (() => {
    const db = harness.openPlanningDb();
    try {
      return db.prepare("SELECT COUNT(*) AS count FROM ledger_currency_events").get().count;
    } finally {
      db.close();
    }
  })();

  const blocked = await harness.request("/api/settings", {
    method: "PUT",
    body: {
      ledger_currency: "EUR",
      fx_provider: "manual",
      manual_fx_rates: { "USD/EUR": 0.9 }
    }
  });
  assert.equal(blocked.response.status, 409);
  assert.ok(blocked.body.details.some(detail => detail.reason === "pending_conversion"));

  snapshot = await harness.api("/api");
  assert.equal(snapshot.settings.ledger_currency, "USD");
  assert.equal(snapshot.pendingTransactions.filter(row =>
    String(row.occurrence_key || "").startsWith("ledger_currency_conversion:")
  ).length, 1);
  const blockedDb = harness.openPlanningDb();
  try {
    assert.equal(blockedDb.prepare("SELECT COUNT(*) AS count FROM ledger_currency_events").get().count, beforeEventCount);
  } finally {
    blockedDb.close();
  }

  await harness.api(`/api/pending/${encodeURIComponent(firstConversion.id)}/confirm`, {
    method: "POST",
    body: { amount: firstConversion.amount, confirmed_date: "2026-05-20" }
  });
  await harness.api("/api/settings", {
    method: "PUT",
    body: {
      ledger_currency: "EUR",
      fx_provider: "manual",
      manual_fx_rates: { "USD/EUR": 0.9 }
    }
  });

  const eventDb = harness.openPlanningDb();
  try {
    const latest = eventDb.prepare(`
      SELECT old_currency, new_currency, old_balance, converted_opening_balance
      FROM ledger_currency_events
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get();
    assert.equal(latest.old_currency, "USD");
    assert.equal(latest.new_currency, "EUR");
    assert.equal(latest.old_balance, 25);
    assert.equal(latest.converted_opening_balance, 22.5);
  } finally {
    eventDb.close();
  }
}));

test("failed cross-database pending confirmation restores pending and ledger state", async () => {
  let failConfirmation = false;
  await withHarness(async harness => {
    insertPending(harness, {
      id: "rollback-confirmation",
      name: "Rollback confirmation",
      type: "income",
      amount: 100,
      date: "2026-05-20",
      occurrenceKey: "rollback-confirmation"
    });

    failConfirmation = true;
    const failed = await harness.request("/api/pending/rollback-confirmation/confirm", {
      method: "POST",
      body: { amount: 100, confirmed_date: "2026-05-20" }
    });
    assert.equal(failed.response.status, 500);

    const snapshot = await harness.api("/api");
    assert.equal(snapshot.pendingTransactions.some(row => row.id === "rollback-confirmation"), true);
    assert.equal(snapshot.confirmedTransactions.some(row => row.id === "rollback-confirmation"), false);
    assert.ok(harness.events.some(event =>
      event.kind === "cashflow_recoverable_mutation_rolled_back"
      && event.details.operation === "confirm_pending_transaction"
    ));
  }, {
    recoverableMutationHook: ({ operation }) => {
      if (failConfirmation && operation === "confirm_pending_transaction") {
        throw new Error("forced confirmation failure");
      }
    }
  });
});
