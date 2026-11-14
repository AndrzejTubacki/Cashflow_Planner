import Database from "better-sqlite3";
import { calculateSnapshot, SNAPSHOT_VERSION } from "../../src/engine/snapshot.js";
import { ENGINE_PROTOCOL_VERSION, ENGINE_VERSION } from "../../src/engine/index.js";

/**
 * SQLite reference host for the app snapshot contract, NOT Cashflow's server schema.
 * All reference-host edits pass through compare-and-swap revisions. Native Android
 * storage must implement equivalent atomicity; this module itself requires Node.
 */
export function openAppSnapshotStore(filename) {
  const db = new Database(filename);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS app_budget_snapshots (
    budget_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    request_json TEXT NOT NULL,
    result_json TEXT
  )`);

  function conflict() {
    const error = new Error("Snapshot changed; recalculate from the latest revision");
    error.code = "STALE_SNAPSHOT";
    return error;
  }

  function read(budgetId) {
    const row = db.prepare("SELECT * FROM app_budget_snapshots WHERE budget_id = ?").get(budgetId);
    if (!row) throw new Error("Unknown reference-host budget");
    return { snapshotVersion: SNAPSHOT_VERSION, budgetId: row.budget_id,
      revision: row.revision, request: JSON.parse(row.request_json),
      result: row.result_json === null ? null : JSON.parse(row.result_json) };
  }

  // JSON round-tripping prevents undefined/functions/non-finite values being accepted
  // differently by storage and calculation. The engine rejects these before serialization.
  function validatedRequest(budgetId, request) {
    calculateSnapshot({ snapshotVersion: SNAPSHOT_VERSION, budgetId, revision: 0, request });
    return JSON.stringify(request);
  }

  function create(budgetId, request) {
    const json = validatedRequest(budgetId, request);
    db.prepare("INSERT INTO app_budget_snapshots (budget_id, revision, request_json) VALUES (?, 0, ?)").run(budgetId, json);
    return read(budgetId);
  }

  function update(budgetId, expectedRevision, request) {
    const json = validatedRequest(budgetId, request);
    return db.transaction(() => {
      const current = read(budgetId);
      if (current.revision !== expectedRevision) throw conflict();
      if (!Number.isSafeInteger(current.revision + 1)) throw new Error("Revision exhausted");
      const changed = db.prepare(`UPDATE app_budget_snapshots
        SET request_json = ?, revision = revision + 1, result_json = NULL
        WHERE budget_id = ? AND revision = ?`).run(json, budgetId, expectedRevision);
      if (changed.changes !== 1) throw conflict();
      return read(budgetId);
    }).immediate();
  }

  function apply(result) {
    if (!result || result.snapshotVersion !== SNAPSHOT_VERSION
      || result.protocolVersion !== ENGINE_PROTOCOL_VERSION || result.engineVersion !== ENGINE_VERSION
      || !Number.isSafeInteger(result.baseRevision) || result.baseRevision < 0) {
      throw new Error("Invalid or incompatible snapshot result");
    }
    return db.transaction(() => {
      const current = read(result.budgetId);
      if (current.revision !== result.baseRevision) throw conflict();
      if (!Number.isSafeInteger(current.revision + 1)) throw new Error("Revision exhausted");
      // This reference host recalculates to reject tampered or misrouted results.
      // It is not a remote trust/authentication mechanism or a production apply API.
      const expected = calculateSnapshot(current);
      if (JSON.stringify(result) !== JSON.stringify(expected)) throw new Error("Result does not match stored snapshot");
      const changed = db.prepare(`UPDATE app_budget_snapshots
        SET result_json = ?, revision = revision + 1 WHERE budget_id = ? AND revision = ?`)
        .run(JSON.stringify(result), result.budgetId, result.baseRevision);
      if (changed.changes !== 1) throw conflict();
      return read(result.budgetId);
    }).immediate();
  }

  return { create, read, update, apply, close: () => db.close() };
}