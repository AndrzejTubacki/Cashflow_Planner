import { normalizeLedgerAuditFact } from "../engine/ledger-audit-fact.js";
import { createHash, randomUUID } from "node:crypto";
import { normalizeAppOperation, appOperationFingerprint, appOperationError, normalizeAppChangesRequest, normalizeAppResultRequest } from "./cashflow-app-operation-contract.js";

/** Real-financial journal schema. Hosts initialize explicitly, never lazily from
 * an HTTP request. Source/projection callbacks must share the journal transaction. */
/** Retention rule: the change feed keeps the latest payloads; older cursors
 * re-bootstrap. Pruning runs inside accepted submissions, in bounded batches. */
export const JOURNAL_RETAINED_REVISIONS = 10000;
export const JOURNAL_PRUNE_BATCH = 500;
export function journalRetentionFloor(revision, retained = JOURNAL_RETAINED_REVISIONS) {
  return Math.max(0, revision - retained);
}

export const FINANCIAL_JOURNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS cashflow_sync_heads (
  budget_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 0),
  retained_after BIGINT NOT NULL DEFAULT 0 CHECK (retained_after >= 0));
CREATE TABLE IF NOT EXISTS cashflow_sync_operations (
  budget_id TEXT NOT NULL, epoch TEXT NOT NULL, operation_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0), fingerprint TEXT NOT NULL,
  operation_json TEXT NOT NULL, result_json TEXT NOT NULL,
  payload_pruned INTEGER NOT NULL DEFAULT 0 CHECK (payload_pruned IN (0, 1)),
  PRIMARY KEY (budget_id, epoch, operation_id),
  UNIQUE (budget_id, epoch, revision));`;

/** Restore/import fencing on the caller's existing transaction. Preserve an
 * absent head (sync never bootstrapped), but rotate all accepted history when a
 * budget with device cursors is replaced. Callers must hold the budget lock. */
export async function rotateFinancialEpoch(query, budgetId) {
  const rows = await query("SELECT epoch FROM cashflow_sync_heads WHERE budget_id = ?", [budgetId]);
  if (!rows.length) return null;
  const epoch = randomUUID();
  await query("DELETE FROM cashflow_sync_operations WHERE budget_id = ?", [budgetId]);
  await query("UPDATE cashflow_sync_heads SET epoch = ?, revision = 0, retained_after = 0 WHERE budget_id = ?", [epoch, budgetId]);
  return { epoch, revision: 0 };
}

/** Synchronous SQLite fencing for legacy multi-file recovery paths. The caller
 * chooses whether to join an existing planning transaction or commit the fence
 * before starting cross-file work; neither claims cross-file atomicity. */
export function rotateSqliteFinancialEpoch(db, budgetId) {
  const row = db.prepare("SELECT epoch FROM cashflow_sync_heads WHERE budget_id = ?").get(budgetId);
  if (!row) return null;
  const epoch = randomUUID();
  db.prepare("DELETE FROM cashflow_sync_operations WHERE budget_id = ?").run(budgetId);
  db.prepare("UPDATE cashflow_sync_heads SET epoch = ?, revision = 0, retained_after = 0 WHERE budget_id = ?").run(epoch, budgetId);
  return { epoch, revision: 0 };
}

function checkedHead(head) {
  if (!head) throw appOperationError("UNKNOWN_BUDGET");
  const revision = Number(head.revision);
  if (!Number.isSafeInteger(revision) || revision < 0
    || typeof head.epoch !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(head.epoch)) {
    throw appOperationError("JOURNAL_INCOMPLETE");
  }
  // Heads created before schema 22 have no floor column in the row object.
  const retainedAfter = head.retained_after === undefined || head.retained_after === null ? 0 : Number(head.retained_after);
  if (!Number.isSafeInteger(retainedAfter) || retainedAfter < 0 || retainedAfter > revision) throw appOperationError("JOURNAL_INCOMPLETE");
  return { epoch: head.epoch, revision, retainedAfter };
}

/** Server invalidations are not accepted by the device operation normalizer.
 * They advertise a required snapshot refresh, never a replayable source edit. */
function normalizeServerChange(input) {
  if (!input || Object.keys(input).length !== 7 || input.version !== 1
    || input.kind !== "budget.invalidate" || typeof input.operationId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.operationId)
    || !input.payload || Object.keys(input.payload).length !== 1
    || !["planner", "settings", "ledger", "projection", "pending", "fx"].includes(input.payload.reason)) {
    throw appOperationError("JOURNAL_INCOMPLETE");
  }
  normalizeAppChangesRequest({ budgetId: input.budgetId, epoch: input.epoch,
    afterRevision: input.baseRevision, limit: 1 });
  if (input.baseRevision >= Number.MAX_SAFE_INTEGER) throw appOperationError("REVISION_CONFLICT");
  return { version: 1, operationId: input.operationId, budgetId: input.budgetId,
    epoch: input.epoch, baseRevision: input.baseRevision, kind: input.kind,
    payload: { reason: input.payload.reason } };
}

function serverChangeRecord(head, budgetId, reason) {
  const current = checkedHead(head);
  const operation = normalizeServerChange({ version: 1, operationId: randomUUID(), budgetId,
    epoch: current.epoch, baseRevision: current.revision, kind: "budget.invalidate", payload: { reason } });
  const result = { version: 1, operationId: operation.operationId, budgetId,
    epoch: current.epoch, revision: current.revision + 1, sourceId: null, replayed: false };
  const fingerprint = createHash("sha256").update(JSON.stringify(operation)).digest("hex");
  return { operation, result, fingerprint };
}

const INSERT_CHANGE = "INSERT INTO cashflow_sync_operations (budget_id, epoch, operation_id, revision, fingerprint, operation_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)";
const ADVANCE_CHANGE = "UPDATE cashflow_sync_heads SET revision = ? WHERE budget_id = ? AND epoch = ? AND revision = ? RETURNING revision";
function changeValues({ operation, result, fingerprint }) {
  return [operation.budgetId, operation.epoch, operation.operationId, result.revision,
    fingerprint, JSON.stringify(operation), JSON.stringify(result)];
}

/** Append on the owning financial transaction after acquiring its budget lock.
 * Never bootstraps a head; unsynchronized budgets retain their existing behavior.
 * The caller must roll back financial writes if recording or CAS fails. */
export async function recordFinancialChange(query, budgetId, reason) {
  const head = (await query("SELECT * FROM cashflow_sync_heads WHERE budget_id = ?", [budgetId]))[0];
  if (!head) return null;
  const record = serverChangeRecord(head, budgetId, reason);
  await query(INSERT_CHANGE, changeValues(record));
  const advanced = await query(ADVANCE_CHANGE, [record.result.revision, budgetId, head.epoch, Number(head.revision)]);
  if (advanced.length !== 1 || Number(advanced[0].revision) !== record.result.revision) throw appOperationError("REVISION_CONFLICT");
  return record.result;
}

/** Legacy SQLite services must call this inside their existing planning write
 * transaction. No ledger/global file participates in this atomic boundary. */
export function recordSqliteFinancialChange(db, budgetId, reason) {
  if (!db.inTransaction) throw new Error("Financial changes require an owning transaction");
  const head = db.prepare("SELECT * FROM cashflow_sync_heads WHERE budget_id = ?").get(budgetId);
  if (!head) return null;
  const record = serverChangeRecord(head, budgetId, reason);
  db.prepare(INSERT_CHANGE).run(...changeValues(record));
  const advanced = db.prepare(ADVANCE_CHANGE).all(record.result.revision, budgetId, head.epoch, Number(head.revision));
  if (advanced.length !== 1 || Number(advanced[0].revision) !== record.result.revision) throw appOperationError("REVISION_CONFLICT");
  return record.result;
}

/** Verify stored history independently of mutable financial source rows. */
export function checkedRecord(row) {
  try {
    const stored = JSON.parse(row.operation_json);
    // Pruned rows keep identity, fingerprint and receipt; only the payload is gone.
    if (Number(row.payload_pruned) === 1) {
      const result = JSON.parse(row.result_json);
      const revision = Number(row.revision);
      if (stored?.payload !== null || stored.budgetId !== row.budget_id || stored.epoch !== row.epoch || stored.operationId !== row.operation_id
        || !result || result.revision !== revision || result.operationId !== row.operation_id || result.replayed !== false) throw new Error("Invalid history");
      return { operation: stored, result, pruned: true };
    }
    const invalidation = stored?.kind === "budget.invalidate";
    const operation = invalidation ? normalizeServerChange(stored) : normalizeAppOperation(stored);
    const result = JSON.parse(row.result_json);
    const revision = Number(row.revision);
    const fingerprint = invalidation
      ? createHash("sha256").update(JSON.stringify(operation)).digest("hex") : appOperationFingerprint(operation);
    if (fingerprint !== row.fingerprint
      || operation.budgetId !== row.budget_id || operation.epoch !== row.epoch
      || operation.operationId !== row.operation_id || operation.baseRevision + 1 !== revision
      || !result || Object.keys(result).length !== (7 + (result.pendingConversion && operation.kind === "settings.update" ? 1 : 0)
        + (result.confirmedTransaction && operation.kind === "occurrence.confirm" ? 1 : 0)) || result.version !== 1
      || result.budgetId !== operation.budgetId || result.epoch !== operation.epoch
      || result.operationId !== operation.operationId || result.revision !== revision
      || result.sourceId !== (invalidation ? null : operation.payload.id ?? null) || result.replayed !== false) throw new Error("Invalid history");
    // Older receipts omit the optional accepted fact; new confirmations retain
    // it for lost-response recovery and the change feed, even after correction.
    if (result.confirmedTransaction) {
      const fact = result.confirmedTransaction;
      if (JSON.stringify(normalizeLedgerAuditFact(fact, operation.budgetId)) !== JSON.stringify(fact)
        || fact.occurrence_key !== operation.payload.occurrenceKey
        || fact.amount !== operation.payload.amount || fact.date !== operation.payload.confirmedDate) throw new Error("Invalid confirmation receipt");
    }
    return { operation, result };
  } catch { throw appOperationError("JOURNAL_INCOMPLETE"); }
}

/** query(sql, args) uses question-mark placeholders and returns rows. PostgreSQL
 * hosts translate placeholders, lock the budget and use repeatable reads for
 * downloads. SQLite hosts use BEGIN IMMEDIATE for writes. Authorization executes
 * before receipt lookup too: a revoked device cannot replay a formerly valid grant.
 * This service never opens storage or commits independently of its host. */
export function createFinancialJournal({ query, authorize, authorizeRead = authorize, mutate, afterRecord = null,
  retainedRevisions = JOURNAL_RETAINED_REVISIONS, pruneBatch = JOURNAL_PRUNE_BATCH }) {
  if (typeof query !== "function" || typeof authorize !== "function" || typeof authorizeRead !== "function" || typeof mutate !== "function") {
    throw new Error("Financial journal requires a transaction query, authorization and mutation callback");
  }
  async function head(budgetId) {
    return checkedHead((await query("SELECT * FROM cashflow_sync_heads WHERE budget_id = ?", [budgetId]))[0]);
  }
  return {
    async bootstrap(budgetId) {
      const epoch = randomUUID();
      await query("INSERT INTO cashflow_sync_heads (budget_id, epoch, revision) VALUES (?, ?, 0) ON CONFLICT (budget_id) DO NOTHING", [budgetId, epoch]);
      return head(budgetId);
    },
    head,
    async apply(input) {
      const operation = normalizeAppOperation(input);
      await authorize(operation);
      const current = await head(operation.budgetId);
      if (current.epoch !== operation.epoch) throw appOperationError("RESYNC_REQUIRED");
      const fingerprint = appOperationFingerprint(operation);
      const prior = (await query("SELECT * FROM cashflow_sync_operations WHERE budget_id = ? AND epoch = ? AND operation_id = ?",
        [operation.budgetId, operation.epoch, operation.operationId]))[0];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw appOperationError("OPERATION_ID_REUSED");
        const { result } = checkedRecord(prior);
        if (result.revision > current.revision) throw appOperationError("JOURNAL_INCOMPLETE");
        return { ...result, replayed: true };
      }
      if (current.revision !== operation.baseRevision) throw appOperationError("REVISION_CONFLICT");
      // Host mutation performs actual domain validation/source/projection writes;
      // no journal-only shadow source is accepted as a financial mutation.
      const outcome = await mutate(operation);
      const result = { version: 1, operationId: operation.operationId, budgetId: operation.budgetId,
        epoch: operation.epoch, revision: current.revision + 1, sourceId: operation.payload.id ?? null, replayed: false,
        ...(outcome?.pendingConversion ? { pendingConversion: outcome.pendingConversion } : {}),
        ...(outcome?.confirmedTransaction ? { confirmedTransaction: outcome.confirmedTransaction } : {}) };
      await query("INSERT INTO cashflow_sync_operations (budget_id, epoch, operation_id, revision, fingerprint, operation_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [operation.budgetId, operation.epoch, operation.operationId, result.revision, fingerprint, JSON.stringify(operation), JSON.stringify(result)]);
      const advanced = await query("UPDATE cashflow_sync_heads SET revision = ? WHERE budget_id = ? AND epoch = ? AND revision = ? RETURNING revision",
        [result.revision, operation.budgetId, operation.epoch, current.revision]);
      if (advanced.length !== 1 || Number(advanced[0].revision) !== result.revision) throw appOperationError("REVISION_CONFLICT");
      await afterRecord?.(result);
      // Apply the retention rule in the same transaction once a batch has accumulated.
      const floor = journalRetentionFloor(result.revision, retainedRevisions);
      if (floor - current.retainedAfter >= pruneBatch) await this.prune(operation.budgetId, floor);
      return result;
    },
    /** Unknown-outcome recovery observes the same owning financial transaction
     * and lock as submissions. Null does not authorize a new operation ID. */
    async lookup(input) {
      const request = normalizeAppResultRequest(input);
      await authorizeRead(request);
      const current = await head(request.budgetId);
      if (current.epoch !== request.epoch) throw appOperationError("RESYNC_REQUIRED");
      const row = (await query("SELECT * FROM cashflow_sync_operations WHERE budget_id = ? AND epoch = ? AND operation_id = ?",
        [request.budgetId, request.epoch, request.operationId]))[0];
      if (!row) return null;
      const { operation, result } = checkedRecord(row);
      if (operation.budgetId !== request.budgetId || operation.epoch !== request.epoch || operation.operationId !== request.operationId
        || result.revision > current.revision) throw appOperationError("JOURNAL_INCOMPLETE");
      return result;
    },
    async changes(input) {
      const request = normalizeAppChangesRequest(input);
      await authorizeRead(request);
      const current = await head(request.budgetId);
      if (current.epoch !== request.epoch) throw appOperationError("RESYNC_REQUIRED");
      if (request.afterRevision > current.revision) throw appOperationError("INVALID_CURSOR");
      // Payloads at or below the retained floor are pruned: the device must re-bootstrap.
      if (request.afterRevision < current.retainedAfter) throw appOperationError("CURSOR_EXPIRED");
      const rows = await query("SELECT * FROM cashflow_sync_operations WHERE budget_id = ? AND epoch = ? AND revision > ? ORDER BY revision LIMIT ?",
        [request.budgetId, request.epoch, request.afterRevision, request.limit]);
      if (rows.length !== Math.min(request.limit, current.revision - request.afterRevision)) throw appOperationError("JOURNAL_INCOMPLETE");
      const changes = rows.map((row, index) => {
        const { operation, result } = checkedRecord(row);
        if (result.budgetId !== request.budgetId || result.epoch !== request.epoch
          || result.revision !== request.afterRevision + index + 1) throw appOperationError("JOURNAL_INCOMPLETE");
        return { operationId: operation.operationId, revision: result.revision, kind: operation.kind, payload: operation.payload,
          ...(result.pendingConversion ? { pendingConversion: result.pendingConversion } : {}),
          ...(result.confirmedTransaction ? { confirmedTransaction: result.confirmedTransaction } : {}) };
      });
      const nextRevision = changes.at(-1)?.revision ?? request.afterRevision;
      return { version: 1, budgetId: request.budgetId, epoch: current.epoch, headRevision: current.revision,
        nextRevision, hasMore: nextRevision < current.revision, changes };
    },
    /** Retention: prune change-feed payloads at or below [floor] (receipts and
     * fingerprints stay, so retries replay and lookups still answer). Cursors
     * below the floor then get CURSOR_EXPIRED. Callers hold the budget lock. */
    async prune(budgetId, floor) {
      const current = await head(budgetId);
      if (!Number.isSafeInteger(floor) || floor < 0 || floor > current.revision) throw appOperationError("INVALID_CURSOR");
      if (floor <= current.retainedAfter) return current;
      const rows = await query("SELECT * FROM cashflow_sync_operations WHERE budget_id = ? AND epoch = ? AND revision <= ? AND payload_pruned = 0",
        [budgetId, current.epoch, floor]);
      for (const row of rows) {
        const { operation } = checkedRecord(row);
        const stub = { version: operation.version, operationId: operation.operationId, budgetId: operation.budgetId, epoch: operation.epoch,
          baseRevision: operation.baseRevision, kind: operation.kind, payload: null };
        await query("UPDATE cashflow_sync_operations SET operation_json = ?, payload_pruned = 1 WHERE budget_id = ? AND epoch = ? AND operation_id = ?",
          [JSON.stringify(stub), budgetId, current.epoch, operation.operationId]);
      }
      await query("UPDATE cashflow_sync_heads SET retained_after = ? WHERE budget_id = ? AND epoch = ?", [floor, budgetId, current.epoch]);
      return head(budgetId);
    },
    async rotateEpoch(budgetId) {
      await head(budgetId);
      return rotateFinancialEpoch(query, budgetId);
    }
  };
}
