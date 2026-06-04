import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { initializeLedgerSchema } from "../../src/server/cashflow-schema.js";
import {
  createCashflowTestHarness,
  ledgerDbPath
} from "../helpers/cashflow-test-harness.js";

async function withHarness(fn) {
  const harness = await createCashflowTestHarness();
  try {
    return await fn(harness);
  } finally {
    await harness.cleanup();
  }
}

test("users endpoint lists local and creates auth-ready admin sessions", async () => withHarness(async harness => {
  const listed = await harness.api("/api/users");

  assert.ok(listed.users.some(user => user.id === "local"));

  const created = await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "first_run_user",
      displayName: "First Run User"
    }
  });

  assert.equal(created.session.userId, "first_run_user");
  assert.equal(created.session.displayName, "First Run User");
  assert.deepEqual(created.session.permissions, ["admin"]);
}));

test("admin global options apply to newly created users", async () => withHarness(async harness => {
  const options = await harness.api("/api/admin/options", {
    method: "PUT",
    body: {
      ledger_currency: "USD",
      locale: "pl",
      timezone: "UTC",
      holiday_country: "DE",
      future_periods: 5,
      fx_provider: "manual",
      fx_buffer_percent: 2
    }
  });

  assert.equal(options.options.ledger_currency, "USD");
  assert.equal(options.options.locale, "pl");

  await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "global_defaults_user",
      displayName: "Defaults"
    }
  });

  const snapshot = await harness.api("/api", {
    headers: {
      "x-cashflow-user-id": "global_defaults_user"
    }
  });

  assert.equal(snapshot.setup_required, true);
  assert.equal(snapshot.settings.ledger_currency, "USD");
  assert.equal(snapshot.settings.locale, "pl");
  assert.equal(snapshot.settings.timezone, "UTC");
  assert.equal(snapshot.settings.holiday_country, "DE");
  assert.equal(snapshot.settings.future_periods, 5);
  assert.equal(snapshot.settings.fx_provider, "manual");
  assert.equal(snapshot.settings.fx_buffer_percent, 2);
}));

test("admin global options reject malformed values without changing defaults", async () => withHarness(async harness => {
  const before = await harness.api("/api/admin/options");
  const invalid = [
    { future_periods: "abc" },
    { future_periods: 1.5 },
    { fx_buffer_percent: -1 },
    { fx_provider: "unknown" },
    { timezone: "Not/A_Timezone" },
    { unsupported_option: true }
  ];

  for (const body of invalid) {
    const result = await harness.request("/api/admin/options", { method: "PUT", body });
    assert.equal(result.response.status, 400, JSON.stringify(body));
  }

  const after = await harness.api("/api/admin/options");
  assert.deepEqual(after.options, before.options);
}));

test("first-run setup marks setup complete and creates opening balance plus recurring income", async () => withHarness(async harness => {
  await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "setup_flow_user"
    }
  });

  const before = await harness.api("/api", {
    headers: {
      "x-cashflow-user-id": "setup_flow_user"
    }
  });

  assert.equal(before.setup_required, true);

  const after = await harness.api("/api/setup", {
    method: "POST",
    headers: {
      "x-cashflow-user-id": "setup_flow_user"
    },
    body: {
      ledger_currency: "EUR",
      locale: "en",
      timezone: "Europe/London",
      holiday_country: "DE",
      future_periods: 7,
      opening_balance: 123.45,
      income_enabled: 1,
      income_name: "Salary",
      income_amount: 2500,
      income_anchor_day: 25
    }
  });

  assert.equal(after.setup_required, false);
  assert.equal(after.today, "2026-05-20");
  assert.equal(after.settings.setup_completed, 1);
  assert.equal(after.settings.ledger_currency, "EUR");
  assert.equal(after.settings.holiday_country, "DE");
  assert.equal(after.recurringIncomes.length, 1);
  assert.equal(after.recurringIncomes[0].name, "Salary");
  assert.equal(after.recurringIncomes[0].currency, "EUR");
  assert.equal(after.recurringIncomes[0].period_setting, 1);
  assert.equal(after.recurringIncomes[0].anchor_holiday_country, "DE");
  assert.equal(after.pendingTransactions.length, 1);
  assert.equal(after.pendingTransactions[0].name, "Opening balance");
  assert.equal(after.pendingTransactions[0].type, "income");
  assert.equal(after.pendingTransactions[0].currency, "EUR");
  assert.equal(after.pendingTransactions[0].ledger_currency, "EUR");
  assert.equal(after.pendingTransactions[0].fx_rate, 1);
  assert.equal(after.pendingTransactions[0].buffered_fx_rate, 1);
}));

test("first-run setup rejects negative opening balances without changing profile state", async () => withHarness(async harness => {
  await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "negative_setup_user"
    }
  });

  const result = await harness.request("/api/setup", {
    method: "POST",
    headers: {
      "x-cashflow-user-id": "negative_setup_user"
    },
    body: {
      ledger_currency: "PLN",
      locale: "en",
      timezone: "UTC",
      holiday_country: "PL",
      future_periods: 4,
      opening_balance: -25
    }
  });

  assert.equal(result.response.status, 400);
  assert.ok(result.body.details.some(detail =>
    detail.field === "opening_balance" && detail.reason === "must_be_non_negative"
  ));

  const snapshot = await harness.api("/api", {
    headers: {
      "x-cashflow-user-id": "negative_setup_user"
    }
  });
  assert.equal(snapshot.setup_required, true);
  assert.equal(snapshot.settings.setup_completed, 0);
  assert.equal(snapshot.pendingTransactions.length, 0);
  assert.equal(snapshot.recurringIncomes.length, 0);
}));

test("first-run setup accepts a zero opening balance without creating an opening row", async () => withHarness(async harness => {
  await harness.api("/api/users", {
    method: "POST",
    body: {
      userId: "zero_setup_user"
    }
  });

  const result = await harness.api("/api/setup", {
    method: "POST",
    headers: {
      "x-cashflow-user-id": "zero_setup_user"
    },
    body: {
      ledger_currency: "PLN",
      locale: "en",
      timezone: "UTC",
      holiday_country: "PL",
      future_periods: 4,
      opening_balance: 0
    }
  });

  assert.equal(result.setup_required, false);
  assert.equal(result.settings.setup_completed, 1);
  assert.equal(result.pendingTransactions.length, 0);
}));

test("first-run setup rejects malformed numeric and boolean values before writes", async () => withHarness(async harness => {
  await harness.api("/api/users", {
    method: "POST",
    body: { userId: "strict_setup_user" }
  });

  const invalid = [
    { future_periods: "abc" },
    { income_enabled: "yes" },
    { income_amount: -1 },
    { income_anchor_day: 1.5 },
    { opening_balance: "not-a-number" }
  ];

  for (const extra of invalid) {
    const result = await harness.request("/api/setup", {
      method: "POST",
      headers: { "x-cashflow-user-id": "strict_setup_user" },
      body: {
        ledger_currency: "PLN",
        locale: "en",
        timezone: "UTC",
        holiday_country: "PL",
        ...extra
      }
    });
    assert.equal(result.response.status, 400, JSON.stringify(extra));
  }

  const snapshot = await harness.api("/api", {
    headers: { "x-cashflow-user-id": "strict_setup_user" }
  });
  assert.equal(snapshot.setup_required, true);
  assert.equal(snapshot.pendingTransactions.length, 0);
  assert.equal(snapshot.recurringIncomes.length, 0);
}));

test("confirmed-only users are treated as already set up", async () => withHarness(async harness => {
  const userId = "confirmed_only_user";
  const userDir = path.join(harness.dataDir, userId);
  fs.mkdirSync(userDir, { recursive: true });

  const ledgerDb = new Database(ledgerDbPath(harness.dataDir, userId, "2026"));
  try {
    initializeLedgerSchema(ledgerDb);
    ledgerDb.prepare(`
      INSERT INTO confirmed_transactions (
        id, name, currency, amount, type, date, confirmed_date,
        fx_rate, buffered_fx_rate, ledger_currency, running_balance_pln,
        ledger_amount, created_at, updated_at
      ) VALUES (
        'confirmed-1', 'Historical income', 'PLN', 10, 'income', '2026-01-01', '2026-01-01',
        1, 1, 'PLN', 10, 10, datetime('now'), datetime('now')
      )
    `).run();
  } finally {
    ledgerDb.close();
  }

  const snapshot = await harness.api("/api", {
    headers: {
      "x-cashflow-user-id": userId
    }
  });

  assert.equal(snapshot.setup_required, false);
  assert.equal(snapshot.settings.setup_completed, 1);
  assert.equal(snapshot.confirmedTransactions.length, 1);
}));
