import assert from "node:assert/strict";
import test from "node:test";
import { createAppSnapshotService } from "../../src/server/cashflow-app-snapshot-service.js";

test("snapshot export rejects malformed or duplicate ledger years before reading history", async () => {
  for (const years of [null, {}, "2026", ["2026"], [null], [true], [2026.5], [NaN],
    [Infinity], [0], [-1], [10000], [2026, 2026]]) {
    let historyReads = 0;
    const get = createAppSnapshotService({ budgetStore: {
      listPlanningRows: async (_id, table) => table === "settings"
        ? [{ ledger_currency: "PLN", timezone: "UTC", future_periods: 3 }] : [],
      listLedgerYears: async () => years,
      listConfirmedTransactions: async () => { historyReads++; return []; }
    } });
    await assert.rejects(() => get("budget"), error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /ledger years are unavailable or invalid/);
      return true;
    });
    assert.equal(historyReads, 0);
  }
});

test("snapshot export reads each valid ledger year once in deterministic order", async () => {
  const reads = [];
  const get = createAppSnapshotService({ budgetStore: {
    listPlanningRows: async (_id, table) => table === "settings"
      ? [{ ledger_currency: "PLN", timezone: "UTC", future_periods: 3 }] : [],
    listLedgerYears: async () => [2026, 2024, 2025],
    listConfirmedTransactions: async (_id, { ledgerYear }) => { reads.push(ledgerYear); return []; }
  } });
  assert.equal((await get("budget")).budgetId, "budget");
  assert.deepEqual(reads, [2024, 2025, 2026, 2024, 2025, 2026]);
});

test("snapshot export rejects foreign settings, planning and ledger rows without disclosing them", async () => {
  for (const location of ["settings", "one_off_transactions", "projection_snapshots", "ledger"]) {
    const foreign = { budget_id: "private-other-budget", name: "private financial details" };
    const get = createAppSnapshotService({ budgetStore: {
      listPlanningRows: async (_id, table) => table === "settings"
        ? [{ ledger_currency: "PLN", timezone: "UTC", future_periods: 3, ...(location === table ? foreign : {}) }]
        : table === location ? [foreign] : [],
      listLedgerYears: async () => [2026],
      listConfirmedTransactions: async () => location === "ledger" ? [foreign] : []
    } });
    await assert.rejects(() => get("budget"), error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /incorrectly scoped/);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
  }
});

test("snapshot export accepts matching explicit scope and legacy unscoped rows", async () => {
  for (const scope of [{}, { budget_id: "budget" }]) {
    const get = createAppSnapshotService({ budgetStore: {
      listPlanningRows: async (_id, table) => table === "settings"
        ? [{ ledger_currency: "PLN", timezone: "UTC", future_periods: 3, ...scope }] : [],
      listLedgerYears: async () => [], listConfirmedTransactions: async () => []
    } });
    assert.equal((await get("budget")).budgetId, "budget");
  }
});

test("snapshot export rejects malformed table and ledger collections", async () => {
  for (const rows of [null, {}, [null], ["invalid"], [[]]]) {
    for (const ledger of [false, true]) {
      const get = createAppSnapshotService({ budgetStore: {
        listPlanningRows: async (_id, table) => table === "settings"
          ? [{ ledger_currency: "PLN", timezone: "UTC", future_periods: 3 }]
          : !ledger && table === "one_off_transactions" ? rows : [],
        listLedgerYears: async () => ledger ? [2026] : [],
        listConfirmedTransactions: async () => rows
      } });
      await assert.rejects(() => get("budget"), /incorrectly scoped/);
    }
  }
});

test("snapshot export never substitutes defaults for missing or ambiguous settings", async () => {
  for (const settings of [[], [{ ledger_currency: "PLN" }, { ledger_currency: "EUR" }]]) {
    let otherReads = 0;
    const get = createAppSnapshotService({ budgetStore: {
      listPlanningRows: async (_id, table) => {
        if (table === "settings") return settings;
        otherReads++;
        return [];
      },
      listLedgerYears: async () => { otherReads++; return []; }
    } });
    await assert.rejects(() => get("budget"), error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /settings are unavailable or ambiguous/);
      return true;
    });
    assert.equal(otherReads, 0);
  }
});

test("snapshot export detects a changed budget between complete reads", async () => {
  let reads = 0;
  const get = createAppSnapshotService({ budgetStore: {
    listPlanningRows: async (id, name) => name === "settings"
      ? [{ ledger_currency: "PLN", timezone: "UTC", future_periods: ++reads }] : [],
    listLedgerYears: async () => [], listConfirmedTransactions: async () => []
  } });
  await assert.rejects(() => get("budget"), /changed while reading/);
});

test("snapshot export rejects missing or malformed ledger currency before further reads", async () => {
  for (const settings of [null, {}, { ledger_currency: null }, { ledger_currency: 123 },
    { ledger_currency: "" }, { ledger_currency: "pln" }, { ledger_currency: " PLN" }, { ledger_currency: "EURO" }]) {
    let otherReads = 0;
    const get = createAppSnapshotService({ budgetStore: {
      listPlanningRows: async (_id, name) => {
        if (name === "settings") return [settings];
        otherReads++;
        return [];
      },
      listLedgerYears: async () => { otherReads++; return []; }
    } });
    await assert.rejects(() => get("budget"), error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /ledger currency is unavailable or invalid/);
      return true;
    });
    assert.equal(otherReads, 0);
  }
});

test("snapshot export rejects missing or invalid timezone before other financial reads", async () => {
  for (const timezone of [undefined, null, 123, "", " UTC", "UTC ", "Not/A_Timezone"]) {
    let otherReads = 0;
    const get = createAppSnapshotService({ budgetStore: {
      listPlanningRows: async (_id, table) => {
        if (table === "settings") return [{ ledger_currency: "PLN", timezone }];
        otherReads++;
        return [];
      },
      listLedgerYears: async () => { otherReads++; return []; }
    } });
    await assert.rejects(() => get("budget"), error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /timezone is unavailable or invalid/);
      return true;
    });
    assert.equal(otherReads, 0);
  }
});

test("snapshot export preserves valid UTC and non-default timezone metadata", async () => {
  for (const timezone of ["UTC", "Europe/Warsaw", "Pacific/Kiritimati"]) {
    const get = createAppSnapshotService({ budgetStore: {
      listPlanningRows: async (_id, table) => table === "settings"
        ? [{ ledger_currency: "PLN", timezone, future_periods: 3 }] : [],
      listLedgerYears: async () => [], listConfirmedTransactions: async () => []
    } });
    const snapshot = await get("budget");
    assert.equal(snapshot.request.settings.timezone, timezone);
    assert.match(snapshot.request.today, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("PostgreSQL exports pin all tables to one read-only repeatable-read transaction", async () => {
  let isolation = false;
  const reader = {
    listPlanningRows: async (_id, name) => {
      assert.ok(isolation);
      return name === "settings" ? [{ ledger_currency: "PLN", future_periods: 3, timezone: "UTC" }] : [];
    },
    listLedgerYears: async () => [], listConfirmedTransactions: async () => []
  };
  const get = createAppSnapshotService({ budgetStore: {
    backend: "postgres",
    transaction: async callback => callback(reader, { query: async sql => {
      assert.equal(sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      isolation = true;
    } })
  } });
  assert.equal((await get("budget")).consistency, "postgres-repeatable-read");
});

test("snapshot export size bound counts UTF-8 bytes rather than characters", async () => {
  const get = createAppSnapshotService({ budgetStore: {
    listPlanningRows: async (_id, name) => name === "settings"
      ? [{ ledger_currency: "PLN", future_periods: 3, timezone: "UTC" }]
      : name === "one_off_transactions" ? [{ id: "large", name: "界".repeat(4 * 1024 * 1024), amount: 1, type: "expense", date: "2026-06-01", currency: "PLN" }] : [],
    listLedgerYears: async () => [], listConfirmedTransactions: async () => []
  } });
  await assert.rejects(() => get("budget"), /snapshot size limit/);
});