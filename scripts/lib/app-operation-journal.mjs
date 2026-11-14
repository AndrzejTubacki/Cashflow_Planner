import Database from "better-sqlite3";
import { normalizeAppDeletion, appDeletionFingerprint } from "../../src/server/cashflow-app-deletion-contract.js";
import { randomUUID } from "node:crypto";
import { normalizeAppOperation, normalizeAppChangesRequest, appOperationFingerprint, appOperationError } from "../../src/server/cashflow-app-operation-contract.js";

/** Experimental reference schema. Not used by web mutations or device routes. */
export const APP_JOURNAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cashflow_app_sync_heads (
    budget_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, revision BIGINT NOT NULL CHECK (revision >= 0));
  CREATE TABLE IF NOT EXISTS cashflow_app_sync_receipts (
    budget_id TEXT NOT NULL, epoch TEXT NOT NULL, operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, revision BIGINT NOT NULL, result_json TEXT NOT NULL,
    PRIMARY KEY (budget_id, epoch, operation_id));
  CREATE TABLE IF NOT EXISTS cashflow_app_sync_sources (
    budget_id TEXT NOT NULL, source_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY (budget_id, source_id));
  CREATE UNIQUE INDEX IF NOT EXISTS cashflow_app_sync_receipt_revision
    ON cashflow_app_sync_receipts(budget_id, epoch, revision);
  CREATE TABLE IF NOT EXISTS cashflow_app_sync_events (
    budget_id TEXT NOT NULL, epoch TEXT NOT NULL, operation_id TEXT NOT NULL,
    payload_json TEXT NOT NULL, PRIMARY KEY (budget_id, epoch, operation_id));
  CREATE TABLE IF NOT EXISTS cashflow_app_sync_tombstones (
    budget_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (budget_id, source_id));
  CREATE TABLE IF NOT EXISTS cashflow_app_sync_schema (
    id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);`;

function eventKind(payload) {
  return payload && Object.keys(payload).length === 1 && Object.hasOwn(payload, "id")
    ? "one-off.delete" : "one-off.create";
}
function normalizeMutation(input, deletions) {
  if (deletions && input?.kind === "one-off.delete") return normalizeAppDeletion(input);
  // This synthetic reference journal stores shadow one-off sources only. Real
  // planning kinds belong to the transactional financial host, never here.
  if (input?.kind !== "one-off.create") throw new Error("Unsupported operation kind for the reference journal");
  return normalizeAppOperation(input);
}
function mutationFingerprint(input) {
  return input.kind === "one-off.delete" ? appDeletionFingerprint(input) : appOperationFingerprint(input);
}

function storedResult(receipt) {
  let result;
  try { result = JSON.parse(receipt.result_json); }
  catch { throw appOperationError("JOURNAL_INCOMPLETE"); }
  const keys = ["version", "operationId", "budgetId", "epoch", "revision", "sourceId", "replayed"];
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))
    || result.version !== 1 || result.replayed !== false
    || !Number.isSafeInteger(result.revision) || result.revision < 1
    || result.revision !== Number(receipt.revision) || result.budgetId !== receipt.budget_id
    || result.epoch !== receipt.epoch || result.operationId !== receipt.operation_id
    || typeof result.sourceId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.sourceId)) {
    throw appOperationError("JOURNAL_INCOMPLETE");
  }
  return result;
}
function storedPayload(row) {
  try { return row ? JSON.parse(row.payload_json) : null; }
  catch { throw appOperationError("JOURNAL_INCOMPLETE"); }
}
function replay(receipt, fingerprint, operation, source) {
  if (receipt.fingerprint !== fingerprint) throw appOperationError("OPERATION_ID_REUSED");
  const result = storedResult(receipt);
  if (result.sourceId !== operation.payload.id || result.revision !== operation.baseRevision + 1) {
    throw appOperationError("JOURNAL_INCOMPLETE");
  }
  let storedFingerprint;
  try { storedFingerprint = mutationFingerprint({ ...operation, payload: storedPayload(source) }); }
  catch { throw appOperationError("JOURNAL_INCOMPLETE"); }
  if (storedFingerprint !== fingerprint) throw appOperationError("JOURNAL_INCOMPLETE");
  return { ...result, replayed: true };
}

function validateLegacyPayload(receipt, source) {
  const result = storedResult(receipt);
  const operation = { version: 1, operationId: result.operationId, budgetId: result.budgetId,
    epoch: result.epoch, baseRevision: result.revision - 1, kind: "one-off.create",
    payload: storedPayload(source) };
  if (!operation.payload || typeof operation.payload !== "object") throw appOperationError("JOURNAL_INCOMPLETE");
  replay(receipt, receipt.fingerprint, operation, source);
  return JSON.stringify(operation.payload);
}
function checkHead(head, op) {
  if (!head) throw appOperationError("UNKNOWN_BUDGET");
  if (head.epoch !== op.epoch) throw appOperationError("RESYNC_REQUIRED");
  if (!Number.isSafeInteger(Number(head.revision)) || Number(head.revision) < 0) {
    throw appOperationError("JOURNAL_INCOMPLETE");
  }
}
function resultFor(op) {
  return { version: 1, operationId: op.operationId, budgetId: op.budgetId, epoch: op.epoch,
    revision: op.baseRevision + 1, sourceId: op.payload.id, replayed: false };
}

function changesPage(head, request, receipts, sources, deletions) {
  checkHead(head, request);
  const revision = Number(head.revision);
  if (!Number.isSafeInteger(revision) || request.afterRevision > revision) throw appOperationError("INVALID_CURSOR");
  let nextRevision = request.afterRevision;
  const changes = receipts.map((receipt, index) => {
    const result = storedResult(receipt);
    if (Number(receipt.revision) !== request.afterRevision + index + 1 || result.revision !== Number(receipt.revision)
      || result.budgetId !== request.budgetId || result.epoch !== request.epoch || result.operationId !== receipt.operation_id) {
      throw appOperationError("JOURNAL_INCOMPLETE");
    }
    const payload = sources.get(result.operationId);
    if (!payload || payload.id !== result.sourceId) throw appOperationError("JOURNAL_INCOMPLETE");
    const kind = eventKind(payload);
    if (kind === "one-off.delete" && !deletions) throw appOperationError("UNSUPPORTED_EVENT");
    // Historical payload must agree with its accepted receipt, independently
    // of whether the current source still exists or has since changed.
    let fingerprint;
    try {
      fingerprint = mutationFingerprint({ version: 1, operationId: result.operationId,
        budgetId: request.budgetId, epoch: request.epoch, baseRevision: result.revision - 1,
        kind, payload });
    } catch { throw appOperationError("JOURNAL_INCOMPLETE"); }
    if (fingerprint !== receipt.fingerprint) throw appOperationError("JOURNAL_INCOMPLETE");
    nextRevision = result.revision;
    return { operationId: result.operationId, revision: result.revision, kind, payload };
  });
  if (changes.length !== Math.min(request.limit, revision - request.afterRevision)) throw appOperationError("JOURNAL_INCOMPLETE");
  return { version: 1, budgetId: request.budgetId, epoch: request.epoch, headRevision: revision,
    nextRevision, hasMore: nextRevision < revision, changes };
}

export function openSqliteOperationJournal(filename, { deletions = false } = {}) {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  try {
    db.transaction(() => {
      db.exec(APP_JOURNAL_SCHEMA);
      const marker = db.prepare("SELECT version FROM cashflow_app_sync_schema WHERE id = 1").get();
      if (marker && marker.version !== 1) throw appOperationError("JOURNAL_INCOMPLETE");
      if (!marker) {
        for (const receipt of db.prepare("SELECT * FROM cashflow_app_sync_receipts ORDER BY budget_id, epoch, revision").all()) {
          const result = storedResult(receipt);
          const source = db.prepare("SELECT payload_json FROM cashflow_app_sync_sources WHERE budget_id = ? AND source_id = ?")
            .get(receipt.budget_id, result.sourceId);
          const payload = validateLegacyPayload(receipt, source);
          db.prepare("INSERT INTO cashflow_app_sync_events VALUES (?, ?, ?, ?)")
            .run(receipt.budget_id, receipt.epoch, receipt.operation_id, payload);
        }
        db.prepare("INSERT INTO cashflow_app_sync_schema VALUES (1, 1)").run();
      }
    }).immediate();
  } catch (error) { db.close(); throw error; }
  const getHead = id => db.prepare("SELECT * FROM cashflow_app_sync_heads WHERE budget_id = ?").get(id);
  return {
    create(budgetId) {
      const epoch = randomUUID();
      db.prepare("INSERT INTO cashflow_app_sync_heads VALUES (?, ?, 0)").run(budgetId, epoch);
      return { epoch, revision: 0 };
    },
    head: getHead,
    sources: id => db.prepare("SELECT payload_json FROM cashflow_app_sync_sources WHERE budget_id = ? ORDER BY source_id").all(id).map(row => JSON.parse(row.payload_json)),
    receiptCount: id => db.prepare("SELECT COUNT(*) AS count FROM cashflow_app_sync_receipts WHERE budget_id = ?").get(id).count,
    changes(input) {
      const request = normalizeAppChangesRequest(input);
      return db.transaction(() => {
        const head = getHead(request.budgetId);
        checkHead(head, request);
        const receipts = db.prepare("SELECT * FROM cashflow_app_sync_receipts WHERE budget_id = ? AND epoch = ? AND revision > ? ORDER BY revision LIMIT ?")
          .all(request.budgetId, request.epoch, request.afterRevision, request.limit);
        const sources = new Map();
        for (const receipt of receipts) {
          const id = storedResult(receipt).operationId;
          const row = db.prepare("SELECT payload_json FROM cashflow_app_sync_events WHERE budget_id = ? AND epoch = ? AND operation_id = ?")
            .get(request.budgetId, request.epoch, id);
          if (row) sources.set(id, storedPayload(row));
        }
        return changesPage(head, request, receipts, sources, deletions);
      })();
    },
    apply(input, { afterWrite } = {}) {
      const op = normalizeMutation(input, deletions);
      const fingerprint = mutationFingerprint(op);
      return db.transaction(() => {
        const head = getHead(op.budgetId);
        checkHead(head, op);
        const receipt = db.prepare("SELECT * FROM cashflow_app_sync_receipts WHERE budget_id = ? AND epoch = ? AND operation_id = ?")
          .get(op.budgetId, op.epoch, op.operationId);
        if (receipt) {
          if (Number(receipt.revision) > Number(head.revision)) throw appOperationError("JOURNAL_INCOMPLETE");
          const source = db.prepare("SELECT payload_json FROM cashflow_app_sync_events WHERE budget_id = ? AND epoch = ? AND operation_id = ?")
            .get(op.budgetId, op.epoch, op.operationId);
          return replay(receipt, fingerprint, op, source);
        }
        if (Number(getHead(op.budgetId).revision) !== op.baseRevision) throw appOperationError("REVISION_CONFLICT");
        const exists = db.prepare("SELECT 1 FROM cashflow_app_sync_sources WHERE budget_id = ? AND source_id = ?").get(op.budgetId, op.payload.id);
        if (op.kind === "one-off.delete") {
          if (!exists) throw appOperationError("SOURCE_NOT_FOUND");
          db.prepare("DELETE FROM cashflow_app_sync_sources WHERE budget_id = ? AND source_id = ?").run(op.budgetId, op.payload.id);
          db.prepare("INSERT INTO cashflow_app_sync_tombstones VALUES (?, ?)").run(op.budgetId, op.payload.id);
        } else {
          if (exists) throw appOperationError("SOURCE_EXISTS");
          if (db.prepare("SELECT 1 FROM cashflow_app_sync_tombstones WHERE budget_id = ? AND source_id = ?").get(op.budgetId, op.payload.id)) throw appOperationError("SOURCE_DELETED");
          db.prepare("INSERT INTO cashflow_app_sync_sources VALUES (?, ?, ?)").run(op.budgetId, op.payload.id, JSON.stringify(op.payload));
        }
        const injected = afterWrite?.();
        if (injected && typeof injected.then === "function") throw new Error("SQLite journal hooks must be synchronous");
        const result = resultFor(op);
        db.prepare("UPDATE cashflow_app_sync_heads SET revision = ? WHERE budget_id = ?").run(result.revision, op.budgetId);
        db.prepare("INSERT INTO cashflow_app_sync_receipts VALUES (?, ?, ?, ?, ?, ?)")
          .run(op.budgetId, op.epoch, op.operationId, fingerprint, result.revision, JSON.stringify(result));
        db.prepare("INSERT INTO cashflow_app_sync_events VALUES (?, ?, ?, ?)")
          .run(op.budgetId, op.epoch, op.operationId, JSON.stringify(op.payload));
        return result;
      }).immediate();
    },
    reset(budgetId) {
      return db.transaction(() => {
        if (!getHead(budgetId)) throw appOperationError("UNKNOWN_BUDGET");
        const epoch = randomUUID();
        db.prepare("DELETE FROM cashflow_app_sync_tombstones WHERE budget_id = ?").run(budgetId);
        db.prepare("DELETE FROM cashflow_app_sync_events WHERE budget_id = ?").run(budgetId);
        db.prepare("DELETE FROM cashflow_app_sync_receipts WHERE budget_id = ?").run(budgetId);
        db.prepare("DELETE FROM cashflow_app_sync_sources WHERE budget_id = ?").run(budgetId);
        db.prepare("UPDATE cashflow_app_sync_heads SET epoch = ?, revision = 0 WHERE budget_id = ?").run(epoch, budgetId);
        return { epoch, revision: 0 };
      }).immediate();
    },
    close: () => db.close()
  };
}

export function createPostgresOperationJournal(pool, { deletions = false } = {}) {
  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try { const value = await work(client); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    } finally { client.release(); }
  }
  return {
    initialize: () => transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(73190232)");
      await client.query(APP_JOURNAL_SCHEMA);
      const marker = (await client.query("SELECT version FROM cashflow_app_sync_schema WHERE id = 1")).rows[0];
      if (marker && marker.version !== 1) throw appOperationError("JOURNAL_INCOMPLETE");
      if (!marker) {
        const receipts = (await client.query("SELECT * FROM cashflow_app_sync_receipts ORDER BY budget_id, epoch, revision")).rows;
        for (const receipt of receipts) {
          const result = storedResult(receipt);
          const source = (await client.query("SELECT payload_json FROM cashflow_app_sync_sources WHERE budget_id = $1 AND source_id = $2",
            [receipt.budget_id, result.sourceId])).rows[0];
          const payload = validateLegacyPayload(receipt, source);
          await client.query("INSERT INTO cashflow_app_sync_events VALUES ($1, $2, $3, $4)",
            [receipt.budget_id, receipt.epoch, receipt.operation_id, payload]);
        }
        await client.query("INSERT INTO cashflow_app_sync_schema VALUES (1, 1)");
      }
    }),
    async create(budgetId) {
      const epoch = randomUUID();
      await pool.query("INSERT INTO cashflow_app_sync_heads VALUES ($1, $2, 0)", [budgetId, epoch]);
      return { epoch, revision: 0 };
    },
    async head(id) { return (await pool.query("SELECT * FROM cashflow_app_sync_heads WHERE budget_id = $1", [id])).rows[0]; },
    async sources(id) { return (await pool.query("SELECT payload_json FROM cashflow_app_sync_sources WHERE budget_id = $1 ORDER BY source_id", [id])).rows.map(row => JSON.parse(row.payload_json)); },
    async receiptCount(id) { return Number((await pool.query("SELECT COUNT(*) AS count FROM cashflow_app_sync_receipts WHERE budget_id = $1", [id])).rows[0].count); },
    async changes(input) {
      const request = normalizeAppChangesRequest(input);
      return transaction(async client => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        const head = (await client.query("SELECT * FROM cashflow_app_sync_heads WHERE budget_id = $1", [request.budgetId])).rows[0];
        checkHead(head, request);
        const receipts = (await client.query("SELECT * FROM cashflow_app_sync_receipts WHERE budget_id = $1 AND epoch = $2 AND revision > $3 ORDER BY revision LIMIT $4",
          [request.budgetId, request.epoch, request.afterRevision, request.limit])).rows;
        const sources = new Map();
        for (const receipt of receipts) {
          const id = storedResult(receipt).operationId;
          const row = (await client.query("SELECT payload_json FROM cashflow_app_sync_events WHERE budget_id = $1 AND epoch = $2 AND operation_id = $3", [request.budgetId, request.epoch, id])).rows[0];
          if (row) sources.set(id, storedPayload(row));
        }
        return changesPage(head, request, receipts, sources, deletions);
      });
    },
    async apply(input, { afterWrite } = {}) {
      const op = normalizeMutation(input, deletions);
      const fingerprint = mutationFingerprint(op);
      return transaction(async client => {
        const head = (await client.query("SELECT * FROM cashflow_app_sync_heads WHERE budget_id = $1 FOR UPDATE", [op.budgetId])).rows[0];
        checkHead(head, op);
        const receipt = (await client.query("SELECT * FROM cashflow_app_sync_receipts WHERE budget_id = $1 AND epoch = $2 AND operation_id = $3",
          [op.budgetId, op.epoch, op.operationId])).rows[0];
        if (receipt) {
          if (Number(receipt.revision) > Number(head.revision)) throw appOperationError("JOURNAL_INCOMPLETE");
          const source = (await client.query("SELECT payload_json FROM cashflow_app_sync_events WHERE budget_id = $1 AND epoch = $2 AND operation_id = $3",
            [op.budgetId, op.epoch, op.operationId])).rows[0];
          return replay(receipt, fingerprint, op, source);
        }
        if (Number(head.revision) !== op.baseRevision) throw appOperationError("REVISION_CONFLICT");
        const exists = (await client.query("SELECT 1 FROM cashflow_app_sync_sources WHERE budget_id = $1 AND source_id = $2", [op.budgetId, op.payload.id])).rowCount;
        if (op.kind === "one-off.delete") {
          if (!exists) throw appOperationError("SOURCE_NOT_FOUND");
          await client.query("DELETE FROM cashflow_app_sync_sources WHERE budget_id = $1 AND source_id = $2", [op.budgetId, op.payload.id]);
          await client.query("INSERT INTO cashflow_app_sync_tombstones VALUES ($1, $2)", [op.budgetId, op.payload.id]);
        } else {
          if (exists) throw appOperationError("SOURCE_EXISTS");
          if ((await client.query("SELECT 1 FROM cashflow_app_sync_tombstones WHERE budget_id = $1 AND source_id = $2", [op.budgetId, op.payload.id])).rowCount) throw appOperationError("SOURCE_DELETED");
          await client.query("INSERT INTO cashflow_app_sync_sources VALUES ($1, $2, $3)", [op.budgetId, op.payload.id, JSON.stringify(op.payload)]);
        }
        await afterWrite?.();
        const result = resultFor(op);
        await client.query("UPDATE cashflow_app_sync_heads SET revision = $1 WHERE budget_id = $2", [result.revision, op.budgetId]);
        await client.query("INSERT INTO cashflow_app_sync_receipts VALUES ($1, $2, $3, $4, $5, $6)",
          [op.budgetId, op.epoch, op.operationId, fingerprint, result.revision, JSON.stringify(result)]);
        await client.query("INSERT INTO cashflow_app_sync_events VALUES ($1, $2, $3, $4)",
          [op.budgetId, op.epoch, op.operationId, JSON.stringify(op.payload)]);
        return result;
      });
    },
    async reset(budgetId) {
      return transaction(async client => {
        const head = await client.query("SELECT * FROM cashflow_app_sync_heads WHERE budget_id = $1 FOR UPDATE", [budgetId]);
        if (!head.rowCount) throw appOperationError("UNKNOWN_BUDGET");
        const epoch = randomUUID();
        await client.query("DELETE FROM cashflow_app_sync_tombstones WHERE budget_id = $1", [budgetId]);
        await client.query("DELETE FROM cashflow_app_sync_events WHERE budget_id = $1", [budgetId]);
        await client.query("DELETE FROM cashflow_app_sync_receipts WHERE budget_id = $1", [budgetId]);
        await client.query("DELETE FROM cashflow_app_sync_sources WHERE budget_id = $1", [budgetId]);
        await client.query("UPDATE cashflow_app_sync_heads SET epoch = $1, revision = 0 WHERE budget_id = $2", [epoch, budgetId]);
        return { epoch, revision: 0 };
      });
    }
  };
}