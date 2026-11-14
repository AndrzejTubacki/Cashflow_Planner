import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openSqliteOperationJournal, createPostgresOperationJournal } from "../../scripts/lib/app-operation-journal.mjs";
import { normalizeAppOperation, normalizeAppChangesRequest, appOperationFingerprint } from "../../src/server/cashflow-app-operation-contract.js";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

function operation(head, overrides = {}) {
  return { version: 1, operationId: randomUUID(), budgetId: "journal-test", epoch: head.epoch,
    baseRevision: head.revision, kind: "one-off.create", payload: { id: randomUUID(), name: "Bill",
      currency: "PLN", amount: 12.34, type: "expense", date: "2026-10-14" }, ...overrides };
}

test("operation contract rejects financial plan uploads and produces stable fingerprints", () => {
  const op = operation({ epoch: randomUUID(), revision: 0 });
  const reordered = Object.fromEntries(Object.entries(op).reverse());
  reordered.payload = Object.fromEntries(Object.entries(op.payload).reverse());
  assert.equal(appOperationFingerprint(op), appOperationFingerprint(reordered));
  assert.deepEqual(normalizeAppOperation(op), op);
  const floating = { ...op, payload: { ...op.payload, amount: 12.34 * 3 } };
  assert.equal(normalizeAppOperation(floating).payload.amount, 37.02);
  assert.equal(appOperationFingerprint(floating), appOperationFingerprint({ ...floating, payload: { ...floating.payload, amount: 37.02 } }));
  assert.throws(() => normalizeAppOperation({ ...op, plan: {} }), /fields/);
  assert.throws(() => normalizeAppOperation({ ...op, kind: "snapshot.replace" }), /Unsupported/);
  for (const amount of ["12.34", 0, 0.000000001, -1, 1.001, Infinity, 10000000000]) {
    assert.throws(() => normalizeAppOperation({ ...op, payload: { ...op.payload, amount } }));
  }
  for (const date of ["2026-02-30", "2026-10-14T00:00:00Z", 123]) {
    assert.throws(() => normalizeAppOperation({ ...op, payload: { ...op.payload, date } }));
  }
  for (const baseRevision of ["0", -1, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => normalizeAppOperation({ ...op, baseRevision }));
  }
  assert.throws(() => normalizeAppOperation({ ...op, payload: { ...op.payload, ledger_amount: 0 } }));
  assert.throws(() => normalizeAppOperation({ ...op, payload: { ...op.payload, name: "Bill\nInjected" } }));
  const request = { budgetId: op.budgetId, epoch: op.epoch, afterRevision: 0, limit: 2 };
  assert.deepEqual(normalizeAppChangesRequest(request), request);
  for (const limit of [0, 101, 1.5, "2", null]) assert.throws(() => normalizeAppChangesRequest({ ...request, limit }));
  for (const afterRevision of [-1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => normalizeAppChangesRequest({ ...request, afterRevision }));
  assert.equal(normalizeAppChangesRequest({ ...request, afterRevision: Number.MAX_SAFE_INTEGER }).afterRevision, Number.MAX_SAFE_INTEGER);
  assert.throws(() => normalizeAppChangesRequest({ ...request, snapshotToken: "not-a-cursor" }));
});

async function verifyJournal(first, second) {
  const head = await first.create("journal-test");
  const op = operation(head);
  const accepted = await first.apply(op);
  assert.equal(accepted.revision, 1);
  assert.equal(accepted.replayed, false);
  // A valid draft deletion must not enter the create-only journal, even for
  // an existing source at the current head. Both adapters fail without writes.
  const unsupportedDelete = { ...op, operationId: randomUUID(), baseRevision: 1,
    kind: "one-off.delete", payload: { id: op.payload.id } };
  await assert.rejects(async () => second.apply(unsupportedDelete), /Unsupported/);
  assert.equal(Number((await first.head("journal-test")).revision), 1);
  assert.equal(await first.receiptCount("journal-test"), 1);
  assert.deepEqual(await first.sources("journal-test"), [op.payload]);
  const next = operation({ ...head, revision: 1 });
  await second.apply(next);
  // Retry after another writer advances the head must return the original receipt.
  assert.deepEqual(await second.apply(op), { ...accepted, replayed: true });
  await assert.rejects(async () => second.apply({ ...op, payload: { ...op.payload, amount: 20 } }), { code: "OPERATION_ID_REUSED" });
  await assert.rejects(async () => first.apply(operation(head)), { code: "REVISION_CONFLICT" });
  const current = { epoch: head.epoch, revision: 2 };
  await assert.rejects(async () => first.apply(operation(current, { payload: op.payload })), { code: "SOURCE_EXISTS" });
  const failing = operation(current);
  await assert.rejects(async () => first.apply(failing, { afterWrite: () => { throw new Error("injected failure"); } }), /injected failure/);
  assert.equal(Number((await second.head("journal-test")).revision), 2);
  assert.equal((await first.sources("journal-test")).length, 2);
  assert.equal(await first.receiptCount("journal-test"), 2);
  assert.equal((await second.apply(failing)).revision, 3);
  const raceHead = { epoch: head.epoch, revision: 3 };
  const race = await Promise.allSettled([Promise.resolve().then(() => first.apply(operation(raceHead))),
    Promise.resolve().then(() => second.apply(operation(raceHead)))]);
  assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(race.find(r => r.status === "rejected").reason.code, "REVISION_CONFLICT");
  const same = operation({ epoch: head.epoch, revision: 4 });
  const retries = await Promise.all([Promise.resolve().then(() => first.apply(same)), Promise.resolve().then(() => second.apply(same))]);
  assert.deepEqual(retries.map(r => r.replayed).sort(), [false, true]);
  assert.equal(await first.receiptCount("journal-test"), 5);
  const request = { budgetId: "journal-test", epoch: head.epoch, afterRevision: 0, limit: 2 };
  const page = await first.changes(request);
  assert.equal(page.headRevision, 5);
  assert.equal(page.nextRevision, 2);
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.changes.map(row => row.revision), [1, 2]);
  assert.deepEqual(page.changes[0], { operationId: op.operationId, revision: 1, kind: "one-off.create", payload: op.payload });
  assert.deepEqual(await second.changes(request), page);
  const rest = await second.changes({ ...request, afterRevision: page.nextRevision, limit: 100 });
  assert.deepEqual(rest.changes.map(row => row.revision), [3, 4, 5]);
  assert.equal(rest.hasMore, false);
  assert.equal(rest.nextRevision, 5);
  assert.deepEqual((await first.changes({ ...request, afterRevision: 5 })).changes, []);
  await assert.rejects(async () => first.changes({ ...request, afterRevision: 6 }), { code: "INVALID_CURSOR" });
  await assert.rejects(async () => first.changes({ ...request, budgetId: "unknown" }), { code: "UNKNOWN_BUDGET" });
  const reset = await first.reset("journal-test");
  assert.notEqual(reset.epoch, head.epoch);
  await assert.rejects(async () => first.apply(op), { code: "RESYNC_REQUIRED" });
  await assert.rejects(async () => second.changes(request), { code: "RESYNC_REQUIRED" });
  assert.deepEqual((await first.changes({ ...request, epoch: reset.epoch })).changes, []);
  assert.equal((await first.sources("journal-test")).length, 0);
  assert.equal(await first.receiptCount("journal-test"), 0);
  assert.equal((await first.apply(operation(reset))).revision, 1);
}

test("SQLite journal atomically deduplicates, rejects stale writes, rolls back and fences restore epochs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-operation-journal-"));
  const filename = path.join(directory, "journal.sqlite");
  const first = openSqliteOperationJournal(filename);
  const second = openSqliteOperationJournal(filename);
  try { await verifyJournal(first, second); }
  finally { first.close(); second.close(); }
  const reopened = openSqliteOperationJournal(filename);
  try {
    assert.equal(Number(reopened.head("journal-test").revision), 1);
    assert.equal(reopened.sources("journal-test").length, 1);
    assert.equal(reopened.receiptCount("journal-test"), 1);
    const head = reopened.head("journal-test");
    assert.equal(reopened.changes({ budgetId: "journal-test", epoch: head.epoch, afterRevision: 0, limit: 1 }).changes.length, 1);
  } finally { reopened.close(); await rm(directory, { recursive: true, force: true }); }
});

async function verifyMissingChanges(journal, execute) {
  const head = await journal.create("journal-test");
  const op = operation(head);
  const accepted = await journal.apply(op);
  const request = { budgetId: op.budgetId, epoch: head.epoch, afterRevision: 0, limit: 10 };
  for (const corrupted of ["not-json", "null", JSON.stringify({ ...accepted, version: 2 }),
    JSON.stringify({ ...accepted, replayed: true }), JSON.stringify({ ...accepted, revision: 2 }),
    JSON.stringify({ ...accepted, sourceId: "not-a-source" }), JSON.stringify({ ...accepted, epoch: randomUUID() }),
    JSON.stringify({ ...accepted, budgetId: "other" }), JSON.stringify({ ...accepted, extra: true })]) {
    await execute(`UPDATE cashflow_app_sync_receipts SET result_json = '${corrupted}'`);
    await assert.rejects(async () => journal.apply(op), { code: "JOURNAL_INCOMPLETE" });
    await assert.rejects(async () => journal.changes(request), { code: "JOURNAL_INCOMPLETE" });
  }
  await execute(`UPDATE cashflow_app_sync_receipts SET result_json = '${JSON.stringify(accepted)}'`);
  assert.equal((await journal.apply(op)).replayed, true);
  await execute(`UPDATE cashflow_app_sync_events SET payload_json = '${JSON.stringify({ ...op.payload, amount: 999 })}'`);
  await assert.rejects(async () => journal.apply(op), { code: "JOURNAL_INCOMPLETE" });
  await assert.rejects(async () => journal.changes(request), { code: "JOURNAL_INCOMPLETE" });
  await execute("UPDATE cashflow_app_sync_events SET payload_json = 'not-json'");
  await assert.rejects(async () => journal.apply(op), { code: "JOURNAL_INCOMPLETE" });
  await assert.rejects(async () => journal.changes(request), { code: "JOURNAL_INCOMPLETE" });
  await execute(`UPDATE cashflow_app_sync_events SET payload_json = '${JSON.stringify(op.payload)}'`);
  await execute("UPDATE cashflow_app_sync_heads SET revision = 0");
  await assert.rejects(async () => journal.apply(op), { code: "JOURNAL_INCOMPLETE" });
  await execute("UPDATE cashflow_app_sync_heads SET revision = 9007199254740992");
  await assert.rejects(async () => journal.apply(op), { code: "JOURNAL_INCOMPLETE" });
  await assert.rejects(async () => journal.changes(request), { code: "JOURNAL_INCOMPLETE" });
  await execute("UPDATE cashflow_app_sync_heads SET revision = 1");
  assert.equal((await journal.apply(op)).replayed, true);
  await execute("DELETE FROM cashflow_app_sync_events");
  await assert.rejects(async () => journal.apply(op), { code: "JOURNAL_INCOMPLETE" });
  await assert.rejects(async () => journal.changes(request), { code: "JOURNAL_INCOMPLETE" });
  await execute("DELETE FROM cashflow_app_sync_receipts");
  await assert.rejects(async () => journal.changes(request), { code: "JOURNAL_INCOMPLETE" });
  await execute(`UPDATE cashflow_app_sync_heads SET revision = ${Number.MAX_SAFE_INTEGER} WHERE budget_id = 'journal-test'`);
  const terminal = await journal.changes({ ...request, afterRevision: Number.MAX_SAFE_INTEGER });
  assert.equal(terminal.hasMore, false);
  assert.deepEqual(terminal.changes, []);
  await assert.rejects(async () => journal.apply(operation({ epoch: head.epoch, revision: Number.MAX_SAFE_INTEGER })), /revision/);
}

async function verifyHistoricalEvents(journal, execute, initialize) {
  const head = await journal.create("journal-test");
  const op = operation(head);
  const accepted = await journal.apply(op);
  const request = { budgetId: op.budgetId, epoch: head.epoch, afterRevision: 0, limit: 10 };
  // Simulate the pre-event schema, then backfill from its verified create data.
  await execute("DROP TABLE cashflow_app_sync_events; DROP TABLE cashflow_app_sync_schema");
  journal = await initialize();
  assert.deepEqual((await journal.changes(request)).changes[0].payload, op.payload);
  await execute("UPDATE cashflow_app_sync_sources SET payload_json = 'not-json'");
  assert.deepEqual(await journal.apply(op), { ...accepted, replayed: true });
  assert.deepEqual((await journal.changes(request)).changes[0].payload, op.payload);
  await execute("DELETE FROM cashflow_app_sync_sources");
  assert.deepEqual(await journal.apply(op), { ...accepted, replayed: true });
  assert.deepEqual((await journal.changes(request)).changes[0].payload, op.payload);
  // Once migrated, missing events are corruption, never reconstructed from sources.
  await execute("DELETE FROM cashflow_app_sync_events");
  journal = await initialize();
  await assert.rejects(async () => journal.apply(op), { code: "JOURNAL_INCOMPLETE" });
  await assert.rejects(async () => journal.changes(request), { code: "JOURNAL_INCOMPLETE" });
  return journal;
}

test("SQLite migrates legacy creates and history survives current source loss", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-events-"));
  const filename = path.join(directory, "journal.sqlite");
  let journal = openSqliteOperationJournal(filename);
  const connection = new Database(filename);
  try {
    await verifyHistoricalEvents(journal, sql => connection.exec(sql), () => {
      journal.close(); journal = openSqliteOperationJournal(filename); return journal;
    });
  } finally { connection.close(); journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SQLite legacy migration rolls back when source cannot prove event history", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-events-migration-"));
  const filename = path.join(directory, "journal.sqlite");
  const journal = openSqliteOperationJournal(filename);
  const head = journal.create("journal-test");
  const op = operation(head);
  journal.apply(op);
  const later = operation({ epoch: head.epoch, revision: 1 });
  journal.apply(later); journal.close();
  const connection = new Database(filename);
  try {
    connection.exec("DROP TABLE cashflow_app_sync_events; DROP TABLE cashflow_app_sync_schema");
    connection.prepare("DELETE FROM cashflow_app_sync_sources WHERE source_id = ?").run(later.payload.id);
    assert.throws(() => openSqliteOperationJournal(filename), { code: "JOURNAL_INCOMPLETE" });
    assert.equal(connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('cashflow_app_sync_events', 'cashflow_app_sync_schema')").get().n, 0);
    assert.equal(connection.prepare("SELECT COUNT(*) AS n FROM cashflow_app_sync_receipts").get().n, 2);
    assert.equal(connection.prepare("SELECT revision FROM cashflow_app_sync_heads").get().revision, 2);
    // Repair the missing source and retry the complete migration, not a partial one.
    connection.prepare("INSERT INTO cashflow_app_sync_sources VALUES (?, ?, ?)")
      .run(later.budgetId, later.payload.id, JSON.stringify(later.payload));
    const recovered = openSqliteOperationJournal(filename);
    try {
      assert.equal(recovered.apply(op).replayed, true);
      assert.equal(recovered.apply(later).replayed, true);
      assert.equal(connection.prepare("SELECT COUNT(*) AS n FROM cashflow_app_sync_events").get().n, 2);
    } finally { recovered.close(); }
  } finally { connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SQLite event insertion failure rolls back source, receipt and revision", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-event-rollback-"));
  const filename = path.join(directory, "journal.sqlite");
  const journal = openSqliteOperationJournal(filename);
  const connection = new Database(filename);
  try {
    const head = journal.create("journal-test");
    const op = operation(head);
    connection.exec(`CREATE TRIGGER fail_event BEFORE INSERT ON cashflow_app_sync_events
      BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`);
    assert.throws(() => journal.apply(op), /injected event failure/);
    assert.equal(journal.head("journal-test").revision, 0);
    assert.deepEqual(journal.sources("journal-test"), []);
    assert.equal(journal.receiptCount("journal-test"), 0);
    assert.equal(connection.prepare("SELECT COUNT(*) AS n FROM cashflow_app_sync_events").get().n, 0);
    connection.exec("DROP TRIGGER fail_event");
    assert.equal(journal.apply(op).revision, 1);
  } finally { connection.close(); journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test("PostgreSQL event insertion failure rolls back source, receipt and revision", {
  skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests"
}, async () => {
  await withDisposablePostgresDb(async ({ pool }) => {
    const journal = createPostgresOperationJournal(pool);
    try {
      await journal.initialize();
      const head = await journal.create("journal-test");
      const op = operation(head);
      await pool.query(`CREATE FUNCTION cashflow_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected event failure'; END $$;
        CREATE TRIGGER fail_event BEFORE INSERT ON cashflow_app_sync_events
        FOR EACH ROW EXECUTE FUNCTION cashflow_fail_event()`);
      await assert.rejects(journal.apply(op), /injected event failure/);
      assert.equal(Number((await journal.head("journal-test")).revision), 0);
      assert.deepEqual(await journal.sources("journal-test"), []);
      assert.equal(await journal.receiptCount("journal-test"), 0);
      assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM cashflow_app_sync_events")).rows[0].n), 0);
      await pool.query("DROP TRIGGER fail_event ON cashflow_app_sync_events");
      assert.equal((await journal.apply(op)).revision, 1);
    } finally {
      await pool.query("DROP TABLE IF EXISTS cashflow_app_sync_events, cashflow_app_sync_schema, cashflow_app_sync_receipts, cashflow_app_sync_sources, cashflow_app_sync_heads CASCADE; DROP FUNCTION IF EXISTS cashflow_fail_event()");
    }
  });
});

test("PostgreSQL migrates legacy events and never repairs missing history from sources", {
  skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests"
}, async () => {
  await withDisposablePostgresDb(async ({ pool }) => {
    const journal = createPostgresOperationJournal(pool);
    try {
      await journal.initialize();
      await verifyHistoricalEvents(journal, sql => pool.query(sql), async () => { await journal.initialize(); return journal; });
    } finally {
      await pool.query("DROP TABLE IF EXISTS cashflow_app_sync_events, cashflow_app_sync_schema, cashflow_app_sync_receipts, cashflow_app_sync_sources, cashflow_app_sync_heads");
    }
  });
});

test("PostgreSQL legacy event migration fails atomically on unprovable history", {
  skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests"
}, async () => {
  await withDisposablePostgresDb(async ({ pool }) => {
    const journal = createPostgresOperationJournal(pool);
    try {
      await journal.initialize();
      const head = await journal.create("journal-test");
      const first = operation(head);
      await journal.apply(first);
      const later = operation({ epoch: head.epoch, revision: 1 });
      await journal.apply(later);
      await pool.query("DROP TABLE cashflow_app_sync_events; DROP TABLE cashflow_app_sync_schema");
      await pool.query("DELETE FROM cashflow_app_sync_sources WHERE source_id = $1", [later.payload.id]);
      await assert.rejects(journal.initialize(), { code: "JOURNAL_INCOMPLETE" });
      assert.equal((await pool.query("SELECT to_regclass('cashflow_app_sync_events') AS name")).rows[0].name, null);
      assert.equal(await journal.receiptCount("journal-test"), 2);
      assert.equal(Number((await journal.head("journal-test")).revision), 2);
      await pool.query("INSERT INTO cashflow_app_sync_sources VALUES ($1, $2, $3)",
        [later.budgetId, later.payload.id, JSON.stringify(later.payload)]);
      await journal.initialize();
      assert.equal((await journal.apply(first)).replayed, true);
      assert.equal((await journal.apply(later)).replayed, true);
      assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM cashflow_app_sync_events")).rows[0].n), 2);
    } finally {
      await pool.query("DROP TABLE IF EXISTS cashflow_app_sync_events, cashflow_app_sync_schema, cashflow_app_sync_receipts, cashflow_app_sync_sources, cashflow_app_sync_heads");
    }
  });
});

test("SQLite change feed does not skip missing receipts or immutable event payloads", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-feed-corrupt-"));
  const filename = path.join(directory, "journal.sqlite");
  const journal = openSqliteOperationJournal(filename);
  const connection = new Database(filename);
  try { await verifyMissingChanges(journal, sql => connection.exec(sql)); }
  finally { connection.close(); journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test("SQLite reset rollback preserves the epoch, source and retry receipt", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-reset-rollback-"));
  const filename = path.join(directory, "journal.sqlite");
  const journal = openSqliteOperationJournal(filename);
  const connection = new Database(filename);
  try {
    const head = await journal.create("journal-test");
    const op = operation(head);
    const accepted = await journal.apply(op);
    connection.exec(`CREATE TRIGGER fail_reset BEFORE DELETE ON cashflow_app_sync_sources
      BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END`);
    await assert.rejects(async () => journal.reset("journal-test"), /injected reset failure/);
    assert.equal(journal.head("journal-test").epoch, head.epoch);
    assert.equal(journal.head("journal-test").revision, 1);
    assert.equal(journal.receiptCount("journal-test"), 1);
    assert.deepEqual(await journal.apply(op), { ...accepted, replayed: true });
    connection.exec("DROP TRIGGER fail_reset");
    const reset = await journal.reset("journal-test");
    assert.notEqual(reset.epoch, head.epoch);
    assert.equal(journal.receiptCount("journal-test"), 0);
    assert.deepEqual(journal.sources("journal-test"), []);
    await assert.rejects(async () => journal.apply(op), { code: "RESYNC_REQUIRED" });
  } finally {
    connection.close(); journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PostgreSQL reset waits for an in-flight write and fences its acknowledged epoch", {
  skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests",
  timeout: 20000
}, async () => {
  await withDisposablePostgresDb(async ({ pool }) => {
    const writer = createPostgresOperationJournal(pool);
    const resetter = createPostgresOperationJournal(pool);
    await writer.initialize();
    const head = await writer.create("journal-test");
    const op = operation(head);
    let releaseWrite;
    let enteredWrite;
    const gate = new Promise(resolve => { releaseWrite = resolve; });
    const entered = new Promise(resolve => { enteredWrite = resolve; });
    const write = writer.apply(op, { afterWrite: async () => { enteredWrite(); await gate; } });
    let reset;
    try {
      await Promise.race([entered, write.then(() => { throw new Error("Write did not reach barrier"); })]);
      reset = resetter.reset("journal-test");
      // Observe a real database lock wait, rather than assuming timing establishes ordering.
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const result = await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND query LIKE '%cashflow_app_sync_heads%FOR UPDATE%'
          AND cardinality(pg_blocking_pids(pid)) > 0`);
        if (result.rowCount) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(blocked, "Reset must wait on the writer's budget-head lock");
      releaseWrite();
      const accepted = await write;
      assert.equal(accepted.revision, 1);
      const replacement = await reset;
      assert.notEqual(replacement.epoch, accepted.epoch);
      assert.equal(replacement.revision, 0);
      assert.equal(await writer.receiptCount("journal-test"), 0);
      assert.deepEqual(await writer.sources("journal-test"), []);
      await assert.rejects(writer.apply(op), { code: "RESYNC_REQUIRED" });
      await assert.rejects(writer.changes({ budgetId: op.budgetId, epoch: head.epoch, afterRevision: 0, limit: 10 }),
        { code: "RESYNC_REQUIRED" });
      assert.equal((await writer.apply(operation(replacement))).revision, 1);
    } finally {
      releaseWrite();
      await Promise.allSettled([write, reset]);
      await pool.query("DROP TABLE IF EXISTS cashflow_app_sync_events, cashflow_app_sync_schema, cashflow_app_sync_receipts, cashflow_app_sync_sources, cashflow_app_sync_heads");
    }
  });
});

test("PostgreSQL operation journal uses independent clients for deduplication and revision races", {
  skip: postgresRuntimeTestsEnabled() ? false : "enable disposable Postgres tests"
}, async () => {
  await withDisposablePostgresDb(async ({ pool }) => {
    const first = createPostgresOperationJournal(pool);
    const second = createPostgresOperationJournal(pool);
    try {
      await first.initialize(); await verifyJournal(first, second);
      await pool.query("DELETE FROM cashflow_app_sync_events; DELETE FROM cashflow_app_sync_receipts; DELETE FROM cashflow_app_sync_sources; DELETE FROM cashflow_app_sync_heads");
      await verifyMissingChanges(first, sql => pool.query(sql));
    }
    finally {
      await pool.query("DROP TABLE IF EXISTS cashflow_app_sync_events, cashflow_app_sync_schema, cashflow_app_sync_receipts, cashflow_app_sync_sources, cashflow_app_sync_heads");
    }
  });
});