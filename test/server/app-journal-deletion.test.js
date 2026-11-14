import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { openSqliteOperationJournal, createPostgresOperationJournal } from "../../scripts/lib/app-operation-journal.mjs";
import { postgresRuntimeTestsEnabled, withDisposablePostgresDb } from "../helpers/postgres-test-db.js";

async function verify(journal) {
  const head = await journal.create("deletions");
  const create = { version: 1, operationId: randomUUID(), budgetId: "deletions", epoch: head.epoch,
    baseRevision: 0, kind: "one-off.create", payload: { id: randomUUID(), name: "Synthetic",
      amount: 10, currency: "PLN", type: "expense", date: "2026-10-14" } };
  const accepted = await journal.apply(create);
  const deletion = { ...create, operationId: randomUUID(), baseRevision: 1,
    kind: "one-off.delete", payload: { id: create.payload.id } };
  await assert.rejects(async () => journal.apply(deletion, { afterWrite: () => { throw new Error("injected"); } }), /injected/);
  assert.deepEqual(await journal.sources("deletions"), [create.payload]);
  assert.equal(Number((await journal.head("deletions")).revision), 1);
  assert.equal(await journal.receiptCount("deletions"), 1);
  const removed = await journal.apply(deletion);
  assert.equal(removed.revision, 2);
  assert.deepEqual(await journal.sources("deletions"), []);
  assert.deepEqual(await journal.apply(create), { ...accepted, replayed: true });
  assert.deepEqual(await journal.apply(deletion), { ...removed, replayed: true });
  const request = { budgetId: "deletions", epoch: head.epoch, afterRevision: 0, limit: 1 };
  const first = await journal.changes(request);
  assert.equal(first.changes[0].kind, "one-off.create");
  assert.deepEqual(first.changes[0].payload, create.payload);
  const second = await journal.changes({ ...request, afterRevision: 1 });
  assert.deepEqual(second.changes[0], { operationId: deletion.operationId, revision: 2,
    kind: "one-off.delete", payload: deletion.payload });
  assert.equal(second.hasMore, false);
  await assert.rejects(async () => journal.apply({ ...create, operationId: randomUUID(), baseRevision: 2 }), { code: "SOURCE_DELETED" });
  await assert.rejects(async () => journal.apply({ ...deletion, operationId: randomUUID(), baseRevision: 2 }), { code: "SOURCE_NOT_FOUND" });
  assert.equal(await journal.receiptCount("deletions"), 2);
  const reset = await journal.reset("deletions");
  await assert.rejects(async () => journal.apply(deletion), { code: "RESYNC_REQUIRED" });
  await journal.apply({ ...create, epoch: reset.epoch });
  assert.deepEqual(await journal.sources("deletions"), [create.payload]);
}

test("opt-in SQLite deletion is atomic, replayable and prevents resurrection", async () => {
  const journal = openSqliteOperationJournal(":memory:", { deletions: true });
  try { await verify(journal); } finally { journal.close(); }
});

test("default journal refuses deletion history and deletion-event corruption fails closed", async () => {
  // Exercise on-disk corruption through an independently opened connection.
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-delete-"));
  const filename = path.join(directory, "journal.sqlite");
  const enabled = openSqliteOperationJournal(filename, { deletions: true });
  try {
    const head = enabled.create("isolated");
    const create = { version: 1, operationId: randomUUID(), budgetId: "isolated", epoch: head.epoch,
      baseRevision: 0, kind: "one-off.create", payload: { id: randomUUID(), name: "Synthetic",
        amount: 1, currency: "PLN", type: "expense", date: "2026-10-14" } };
    enabled.apply(create);
    const deletion = { ...create, operationId: randomUUID(), baseRevision: 1, kind: "one-off.delete", payload: { id: create.payload.id } };
    enabled.apply(deletion);
    const request = { budgetId: "isolated", epoch: head.epoch, afterRevision: 0, limit: 100 };
    const disabled = openSqliteOperationJournal(filename);
    try { assert.throws(() => disabled.changes(request), { code: "UNSUPPORTED_EVENT" }); }
    finally { disabled.close(); }
    const db = new Database(filename);
    try {
      db.prepare("UPDATE cashflow_app_sync_events SET payload_json = ? WHERE operation_id = ?")
        .run(JSON.stringify({ id: randomUUID() }), deletion.operationId);
      assert.throws(() => enabled.changes(request), { code: "JOURNAL_INCOMPLETE" });
      assert.throws(() => enabled.apply(deletion), { code: "JOURNAL_INCOMPLETE" });
    } finally { db.close(); }
  } finally { enabled.close(); await rm(directory, { recursive: true, force: true }); }
});

test("opt-in PostgreSQL deletion preserves immutable history and rollback", {
  skip: postgresRuntimeTestsEnabled() ? false : "disposable PostgreSQL only"
}, async () => {
  await withDisposablePostgresDb(async ({ pool }) => {
    const journal = createPostgresOperationJournal(pool, { deletions: true });
    await journal.initialize();
    await verify(journal);
  });
});

async function verifyLateDeleteFailure(journal, installFailure, removeFailure) {
  const head = await journal.create("late-delete");
  const create = { version: 1, operationId: randomUUID(), budgetId: "late-delete", epoch: head.epoch,
    baseRevision: 0, kind: "one-off.create", payload: { id: randomUUID(), name: "Retained",
      amount: 10, currency: "PLN", type: "expense", date: "2026-10-14" } };
  const accepted = await journal.apply(create);
  const deletion = { ...create, operationId: randomUUID(), baseRevision: 1,
    kind: "one-off.delete", payload: { id: create.payload.id } };
  await installFailure();
  await assert.rejects(async () => journal.apply(deletion), /injected late deletion failure/);
  assert.deepEqual(await journal.sources(create.budgetId), [create.payload]);
  assert.equal(Number((await journal.head(create.budgetId)).revision), 1);
  assert.equal(await journal.receiptCount(create.budgetId), 1);
  assert.deepEqual(await journal.apply(create), { ...accepted, replayed: true });
  const page = await journal.changes({ budgetId: create.budgetId, epoch: head.epoch, afterRevision: 0, limit: 100 });
  assert.equal(page.changes.length, 1);
  assert.equal(page.hasMore, false);
  await removeFailure();
  // The exact failed request must succeed: neither a phantom receipt nor a
  // tombstone from the rolled-back attempt may survive.
  assert.equal((await journal.apply(deletion)).revision, 2);
  assert.equal((await journal.apply(deletion)).replayed, true);
  assert.deepEqual(await journal.sources(create.budgetId), []);
  assert.equal(await journal.receiptCount(create.budgetId), 2);
}

test("SQLite late deletion-event failure rolls back source, tombstone, receipt and head", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-delete-rollback-"));
  const filename = path.join(directory, "journal.sqlite");
  const journal = openSqliteOperationJournal(filename, { deletions: true });
  const db = new Database(filename);
  try {
    await verifyLateDeleteFailure(journal,
      () => db.exec(`CREATE TRIGGER fail_delete_event BEFORE INSERT ON cashflow_app_sync_events
        BEGIN SELECT RAISE(ABORT, 'injected late deletion failure'); END`),
      () => db.exec("DROP TRIGGER fail_delete_event"));
  } finally { db.close(); journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test("PostgreSQL late deletion-event failure rolls back the entire mutation", {
  skip: postgresRuntimeTestsEnabled() ? false : "disposable PostgreSQL only"
}, async () => {
  await withDisposablePostgresDb(async ({ pool }) => {
    const journal = createPostgresOperationJournal(pool, { deletions: true });
    await journal.initialize();
    try {
      await verifyLateDeleteFailure(journal,
        () => pool.query(`CREATE FUNCTION cashflow_fail_delete_event() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected late deletion failure'; END $$;
          CREATE TRIGGER fail_delete_event BEFORE INSERT ON cashflow_app_sync_events
          FOR EACH ROW EXECUTE FUNCTION cashflow_fail_delete_event()`),
        () => pool.query("DROP TRIGGER fail_delete_event ON cashflow_app_sync_events"));
    } finally { await pool.query("DROP FUNCTION IF EXISTS cashflow_fail_delete_event() CASCADE"); }
  });
});

test("PostgreSQL competing deletes serialize and exact retries receive one receipt", {
  skip: postgresRuntimeTestsEnabled() ? false : "disposable PostgreSQL only", timeout: 20000
}, async () => {
  await withDisposablePostgresDb(async ({ pool }) => {
    const first = createPostgresOperationJournal(pool, { deletions: true });
    const second = createPostgresOperationJournal(pool, { deletions: true });
    await first.initialize();
    const head = await first.create("delete-race");
    const create = { version: 1, operationId: randomUUID(), budgetId: "delete-race", epoch: head.epoch,
      baseRevision: 0, kind: "one-off.create", payload: { id: randomUUID(), name: "Synthetic",
        amount: 1, currency: "PLN", type: "expense", date: "2026-10-14" } };
    await first.apply(create);
    const deletion = { ...create, operationId: randomUUID(), baseRevision: 1,
      kind: "one-off.delete", payload: { id: create.payload.id } };
    let release;
    let entered;
    const gate = new Promise(resolve => { release = resolve; });
    const barrier = new Promise(resolve => { entered = resolve; });
    const write = first.apply(deletion, { afterWrite: async () => { entered(); await gate; } });
    let retry;
    let competing;
    try {
      await Promise.race([barrier, write.then(() => { throw new Error("Missing delete barrier"); })]);
      retry = second.apply(deletion);
      competing = second.apply({ ...deletion, operationId: randomUUID() }).then(
        () => { throw new Error("Competing delete unexpectedly accepted"); }, error => {
          assert.equal(error.code, "REVISION_CONFLICT");
        });
      let blocked = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND query LIKE '%cashflow_app_sync_heads%FOR UPDATE%'
          AND cardinality(pg_blocking_pids(pid)) > 0`);
        if (result.rowCount >= 2) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(blocked, "Both callers must wait for the in-flight deletion");
      release();
      const accepted = await write;
      assert.deepEqual(await retry, { ...accepted, replayed: true });
      await competing;
      assert.equal(await first.receiptCount(create.budgetId), 2);
      assert.equal(Number((await first.head(create.budgetId)).revision), 2);
      assert.deepEqual(await first.sources(create.budgetId), []);
      const page = await first.changes({ budgetId: create.budgetId, epoch: head.epoch, afterRevision: 0, limit: 100 });
      assert.deepEqual(page.changes.map(row => row.kind), ["one-off.create", "one-off.delete"]);
    } finally { release(); await Promise.allSettled([write, retry, competing]); }
  });
});

async function verifyDeletedResetFailure(journal, installFailure, removeFailure) {
  const head = await journal.create("deleted-reset");
  const create = { version: 1, operationId: randomUUID(), budgetId: "deleted-reset", epoch: head.epoch,
    baseRevision: 0, kind: "one-off.create", payload: { id: randomUUID(), name: "Synthetic",
      amount: 1, currency: "PLN", type: "expense", date: "2026-10-14" } };
  await journal.apply(create);
  const deletion = { ...create, operationId: randomUUID(), baseRevision: 1,
    kind: "one-off.delete", payload: { id: create.payload.id } };
  const accepted = await journal.apply(deletion);
  const request = { budgetId: create.budgetId, epoch: head.epoch, afterRevision: 0, limit: 100 };
  const before = await journal.changes(request);
  await installFailure();
  await assert.rejects(async () => journal.reset(create.budgetId), /injected deleted reset failure/);
  assert.equal((await journal.head(create.budgetId)).epoch, head.epoch);
  assert.equal(Number((await journal.head(create.budgetId)).revision), 2);
  assert.deepEqual(await journal.changes(request), before);
  assert.deepEqual(await journal.apply(deletion), { ...accepted, replayed: true });
  await assert.rejects(async () => journal.apply({ ...create, operationId: randomUUID(), baseRevision: 2 }),
    { code: "SOURCE_DELETED" });
  await removeFailure();
  const replacement = await journal.reset(create.budgetId);
  assert.notEqual(replacement.epoch, head.epoch);
  assert.equal(await journal.receiptCount(create.budgetId), 0);
  await assert.rejects(async () => journal.apply(deletion), { code: "RESYNC_REQUIRED" });
  // A deliberate epoch reset is the sole path permitting source-ID reuse.
  assert.equal((await journal.apply({ ...create, epoch: replacement.epoch })).revision, 1);
}

test("SQLite failed reset retains deletion tombstones, history and retry evidence", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const directory = await mkdtemp(path.join(tmpdir(), "cashflow-deleted-reset-"));
  const filename = path.join(directory, "journal.sqlite");
  const journal = openSqliteOperationJournal(filename, { deletions: true });
  const db = new Database(filename);
  try {
    await verifyDeletedResetFailure(journal,
      () => db.exec(`CREATE TRIGGER fail_deleted_reset BEFORE DELETE ON cashflow_app_sync_receipts
        BEGIN SELECT RAISE(ABORT, 'injected deleted reset failure'); END`),
      () => db.exec("DROP TRIGGER fail_deleted_reset"));
  } finally { db.close(); journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test("PostgreSQL failed reset retains deletion tombstones and immutable events", {
  skip: postgresRuntimeTestsEnabled() ? false : "disposable PostgreSQL only"
}, async () => {
  await withDisposablePostgresDb(async ({ pool }) => {
    const journal = createPostgresOperationJournal(pool, { deletions: true });
    await journal.initialize();
    try {
      await verifyDeletedResetFailure(journal,
        () => pool.query(`CREATE FUNCTION cashflow_fail_deleted_reset() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected deleted reset failure'; END $$;
          CREATE TRIGGER fail_deleted_reset BEFORE DELETE ON cashflow_app_sync_receipts
          FOR EACH ROW EXECUTE FUNCTION cashflow_fail_deleted_reset()`),
        () => pool.query("DROP TRIGGER fail_deleted_reset ON cashflow_app_sync_receipts"));
    } finally { await pool.query("DROP FUNCTION IF EXISTS cashflow_fail_deleted_reset() CASCADE"); }
  });
});