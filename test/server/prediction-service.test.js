import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCashflowPredictionService } from "../../src/server/cashflow-prediction-service.js";

async function withPredictionService(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "cashflow-prediction-test-"));
  const dbPath = path.join(dir, "ledger_2026.sqlite");
  const db = new Database(dbPath);

  try {
    db.exec(`
      CREATE TABLE confirmed_transactions (
        id TEXT PRIMARY KEY,
        amount REAL NOT NULL,
        type TEXT NOT NULL,
        date TEXT NOT NULL,
        source_recurring_expense_id TEXT,
        source_recurring_income_id TEXT,
        created_at TEXT
      );
    `);

    const service = createCashflowPredictionService({
      listLedgerYears: () => ["2026"],
      openLedgerDb: () => new Database(dbPath)
    });

    return await fn(service, db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function insertConfirmed(db, row) {
  db.prepare(`
    INSERT INTO confirmed_transactions (
      id, amount, type, date, source_recurring_expense_id, source_recurring_income_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.amount,
    row.type,
    row.date,
    row.sourceRecurringExpenseId || null,
    row.sourceRecurringIncomeId || null,
    row.createdAt || `${row.date}T00:00:00Z`
  );
}

test("12-month minimum income can substitute missing months from starting amount", () => withPredictionService((service, db) => {
  insertConfirmed(db, {
    id: "income-high",
    amount: 600,
    type: "income",
    date: "2026-04-01",
    sourceRecurringIncomeId: "income-1"
  });

  insertConfirmed(db, {
    id: "income-old-low",
    amount: 300,
    type: "income",
    date: "2025-04-01",
    sourceRecurringIncomeId: "income-1"
  });

  const baseIncome = {
    id: "income-1",
    amount: 500,
    prediction_strategy: "12month_min"
  };

  assert.equal(
    service.predictedAmountForRecurringIncome("local", {
      ...baseIncome,
      prediction_substitute_missing: "none"
    }, "2026-05-20"),
    600
  );
  assert.equal(
    service.predictedAmountForRecurringIncome("local", {
      ...baseIncome,
      prediction_substitute_missing: "starting_value"
    }, "2026-05-20"),
    500
  );
  assert.equal(
    service.predictedAmountForRecurringIncome("local", {
      ...baseIncome,
      prediction_substitute_missing: "average_extreme_starting_value"
    }, "2026-05-20"),
    550
  );

  insertConfirmed(db, {
    id: "income-low",
    amount: 400,
    type: "income",
    date: "2026-03-01",
    sourceRecurringIncomeId: "income-1"
  });

  assert.equal(
    service.predictedAmountForRecurringIncome("local", {
      ...baseIncome,
      prediction_substitute_missing: "starting_value"
    }, "2026-05-20"),
    400
  );
  assert.equal(
    service.predictedAmountForRecurringIncome("local", {
      ...baseIncome,
      prediction_substitute_missing: "average_extreme_starting_value"
    }, "2026-05-20"),
    400
  );
}));

test("12-month maximum expense can substitute missing months from starting amount", () => withPredictionService((service, db) => {
  insertConfirmed(db, {
    id: "expense-low",
    amount: 400,
    type: "expense",
    date: "2026-04-01",
    sourceRecurringExpenseId: "expense-1"
  });

  const baseExpense = {
    id: "expense-1",
    amount: 500,
    prediction_strategy: "12month_max"
  };

  assert.equal(
    service.predictedAmountForRecurringExpense("local", {
      ...baseExpense,
      prediction_substitute_missing: "none"
    }, "2026-05-20"),
    400
  );
  assert.equal(
    service.predictedAmountForRecurringExpense("local", {
      ...baseExpense,
      prediction_substitute_missing: "starting_value"
    }, "2026-05-20"),
    500
  );
  assert.equal(
    service.predictedAmountForRecurringExpense("local", {
      ...baseExpense,
      prediction_substitute_missing: "average_extreme_starting_value"
    }, "2026-05-20"),
    450
  );

  insertConfirmed(db, {
    id: "expense-high",
    amount: 600,
    type: "expense",
    date: "2026-03-01",
    sourceRecurringExpenseId: "expense-1"
  });

  assert.equal(
    service.predictedAmountForRecurringExpense("local", {
      ...baseExpense,
      prediction_substitute_missing: "starting_value"
    }, "2026-05-20"),
    600
  );
  assert.equal(
    service.predictedAmountForRecurringExpense("local", {
      ...baseExpense,
      prediction_substitute_missing: "average_extreme_starting_value"
    }, "2026-05-20"),
    600
  );
}));

test("12-month predictions can use median recorded amounts", () => withPredictionService((service, db) => {
  for (const row of [
    { id: "income-1", amount: 400, type: "income", date: "2026-01-01", sourceRecurringIncomeId: "income-median" },
    { id: "income-2", amount: 700, type: "income", date: "2026-02-01", sourceRecurringIncomeId: "income-median" },
    { id: "income-3", amount: 900, type: "income", date: "2026-03-01", sourceRecurringIncomeId: "income-median" },
    { id: "expense-1", amount: 100, type: "expense", date: "2026-01-01", sourceRecurringExpenseId: "expense-median" },
    { id: "expense-2", amount: 300, type: "expense", date: "2026-02-01", sourceRecurringExpenseId: "expense-median" },
    { id: "expense-3", amount: 800, type: "expense", date: "2026-03-01", sourceRecurringExpenseId: "expense-median" }
  ]) {
    insertConfirmed(db, row);
  }

  assert.equal(
    service.predictedAmountForRecurringIncome("local", {
      id: "income-median",
      amount: 500,
      prediction_strategy: "12month_min",
      prediction_substitute_missing: "median_recorded"
    }, "2026-05-20"),
    700
  );

  assert.equal(
    service.predictedAmountForRecurringExpense("local", {
      id: "expense-median",
      amount: 500,
      prediction_strategy: "12month_max",
      prediction_substitute_missing: "median_recorded"
    }, "2026-05-20"),
    300
  );
}));

test("12-month predictions can use the last confirmed amount", () => withPredictionService((service, db) => {
  for (const row of [
    {
      id: "income-old",
      amount: 900,
      type: "income",
      date: "2026-03-01",
      sourceRecurringIncomeId: "income-last",
      createdAt: "2026-03-01T10:00:00Z"
    },
    {
      id: "income-new",
      amount: 650,
      type: "income",
      date: "2026-03-01",
      sourceRecurringIncomeId: "income-last",
      createdAt: "2026-03-01T12:00:00Z"
    },
    {
      id: "expense-old",
      amount: 300,
      type: "expense",
      date: "2026-01-01",
      sourceRecurringExpenseId: "expense-last"
    },
    {
      id: "expense-new",
      amount: 450,
      type: "expense",
      date: "2026-04-01",
      sourceRecurringExpenseId: "expense-last"
    }
  ]) {
    insertConfirmed(db, row);
  }

  assert.equal(
    service.predictedAmountForRecurringIncome("local", {
      id: "income-last",
      amount: 500,
      prediction_strategy: "12month_min",
      prediction_substitute_missing: "last_confirmed"
    }, "2026-05-20"),
    650
  );

  assert.equal(
    service.predictedAmountForRecurringExpense("local", {
      id: "expense-last",
      amount: 500,
      prediction_strategy: "12month_max",
      prediction_substitute_missing: "last_confirmed"
    }, "2026-05-20"),
    450
  );
}));

test("12-month predictions can use the previous year same month for an occurrence", () => withPredictionService((service, db) => {
  for (const row of [
    { id: "income-may", amount: 500, type: "income", date: "2025-05-30", sourceRecurringIncomeId: "income-prev-year" },
    { id: "income-june", amount: 720, type: "income", date: "2025-06-30", sourceRecurringIncomeId: "income-prev-year" },
    { id: "expense-june-old", amount: 250, type: "expense", date: "2025-06-01", sourceRecurringExpenseId: "expense-prev-year" },
    { id: "expense-june-new", amount: 350, type: "expense", date: "2025-06-15", sourceRecurringExpenseId: "expense-prev-year" }
  ]) {
    insertConfirmed(db, row);
  }

  assert.equal(
    service.predictedAmountForRecurringIncome("local", {
      id: "income-prev-year",
      amount: 600,
      prediction_strategy: "12month_min",
      prediction_substitute_missing: "previous_year_same_month"
    }, "2026-05-20", "2026-06-26"),
    720
  );

  assert.equal(
    service.predictedAmountForRecurringExpense("local", {
      id: "expense-prev-year",
      amount: 500,
      prediction_strategy: "12month_max",
      prediction_substitute_missing: "previous_year_same_month"
    }, "2026-05-20", "2026-06-10"),
    350
  );

  assert.equal(
    service.predictedAmountForRecurringIncome("local", {
      id: "income-prev-year",
      amount: 600,
      prediction_strategy: "12month_min",
      prediction_substitute_missing: "previous_year_same_month"
    }, "2026-05-20", "2026-07-26"),
    600
  );
}));

test("12-month predictions can require a minimum recorded month count", () => withPredictionService((service, db) => {
  for (const row of [
    { id: "income-jan", amount: 400, type: "income", date: "2026-01-01", sourceRecurringIncomeId: "income-min-count" },
    { id: "income-feb", amount: 450, type: "income", date: "2026-02-01", sourceRecurringIncomeId: "income-min-count" },
    { id: "expense-jan", amount: 700, type: "expense", date: "2026-01-01", sourceRecurringExpenseId: "expense-min-count" },
    { id: "expense-feb", amount: 750, type: "expense", date: "2026-02-01", sourceRecurringExpenseId: "expense-min-count" }
  ]) {
    insertConfirmed(db, row);
  }

  assert.equal(
    service.predictedAmountForRecurringIncome("local", {
      id: "income-min-count",
      amount: 500,
      prediction_strategy: "12month_min",
      prediction_substitute_missing: "require_min_recorded_months",
      prediction_min_recorded_months: 3
    }, "2026-05-20"),
    500
  );

  assert.equal(
    service.predictedAmountForRecurringExpense("local", {
      id: "expense-min-count",
      amount: 500,
      prediction_strategy: "12month_max",
      prediction_substitute_missing: "require_min_recorded_months",
      prediction_min_recorded_months: 2
    }, "2026-05-20"),
    750
  );
}));

test("12-month prediction fallbacks use configured amount when no rows match", () => withPredictionService((service) => {
  assert.equal(
    service.predictedAmountForRecurringIncome("local", {
      id: "income-empty",
      amount: 500,
      prediction_strategy: "12month_min",
      prediction_substitute_missing: "median_recorded"
    }, "2026-05-20"),
    500
  );

  assert.equal(
    service.predictedAmountForRecurringExpense("local", {
      id: "expense-empty",
      amount: 700,
      prediction_strategy: "12month_max",
      prediction_substitute_missing: "previous_year_same_month"
    }, "2026-05-20", "2026-06-01"),
    700
  );
}));
