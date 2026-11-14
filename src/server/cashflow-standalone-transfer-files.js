import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { createCashflowDbService } from './cashflow-db-service.js';
import { createCashflowStoragePaths } from './cashflow-storage-utils.js';
import { createSqliteBudgetStore } from './cashflow-budget-store.js';
import { createBudgetStoreSnapshot } from './cashflow-budget-store-snapshot.js';
import { applyProjectionGenerationPlanToBudgetStore } from './cashflow-projection-engine-service.js';
import { prepareStandaloneTransferWrite } from './cashflow-standalone-transfer-writer.js';
import { standaloneTransferDestination, standaloneTransferOutcome } from './cashflow-standalone-transfer-record.js';
import { normalizeStandaloneTransferRequest, standaloneTransferFingerprint } from './cashflow-standalone-transfer-journal.js';
import { canonicalAuditValue } from '../engine/ledger-audit-json.js';
import { PLANNING_SCHEMA_VERSION } from './cashflow-schema.js';
import { STANDALONE_TRANSFER_FILE_MARKER } from './cashflow-standalone-transfer-schema.js';
import { assertStandaloneTransferReadable } from './cashflow-standalone-transfer-readable.js';

const SEED = STANDALONE_TRANSFER_FILE_MARKER, READY = 'standalone-transfer-ready.json';
const json = value => JSON.stringify(canonicalAuditValue(value));
const conflict = () => Object.assign(new Error('Transfer storage requires recovery; retained files were not replaced'), { code: 'TRANSFER_STORAGE_CONFLICT' });

/** Private SQLite preparation is serialized by the caller's owning global
 * BEGIN IMMEDIATE through publication. Never call this adapter outside that
 * transaction. Files are not a grant: current authorization and metadata are
 * still required before a budget is visible. No network is used here. */
export function createStandaloneTransferFiles({ dataDir, readFxSnapshot }) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof readFxSnapshot !== 'function') throw new Error('Trusted transfer storage configuration required');
  const root = path.resolve(dataDir), staging = path.join(root, '.standalone-transfers');

  function directory(location) {
    try { if (!fs.lstatSync(location).isDirectory()) throw conflict(); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  function sync(location) {
    const fd = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  /** Never follow a receipt symlink or allocate memory from an unbounded file. */
  function read(location) {
    let fd;
    try { fd = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (error) { if (['ENOENT', 'ELOOP'].includes(error.code)) throw conflict(); throw error; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 32768) throw conflict();
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch { throw conflict(); }
    finally { fs.closeSync(fd); }
  }
  function write(location, value) {
    const fd = fs.openSync(location, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, json(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    sync(path.dirname(location));
  }
  /** Reuse the journal's exact binding/hash/receipt checks. A file never chooses
   * a different target, account, device, input or transfer identity. */
  function receipt(input, value) {
    try {
      return standaloneTransferOutcome({ instance_id: input.instanceId, account_id: input.accountId,
        device_id: input.deviceId, transfer_id: input.transferId, budget_id: standaloneTransferDestination(input),
        input_hash: standaloneTransferFingerprint(input), state: 'accepted', receipt_json: JSON.stringify(value), created_ms: 0 });
    } catch { throw conflict(); }
  }
  function seed(input, location) {
    const value = read(path.join(location, SEED));
    if (!value || Object.keys(value).sort().join(',') !== 'receipt,timing,version' || value.version !== 1
      || !value.timing || Object.keys(value.timing).sort().join(',') !== 'generationTimestamp,idSeed,today'
      || value.timing.idSeed !== input.transferId || typeof value.timing.today !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(value.timing.today)
      || new Date(`${value.timing.today}T00:00:00.000Z`).toISOString().slice(0, 10) !== value.timing.today
      || !Number.isFinite(Date.parse(value.timing.generationTimestamp))
      || new Date(value.timing.generationTimestamp).toISOString() !== value.timing.generationTimestamp) throw conflict();
    return { ...value, receipt: receipt(input, value.receipt) };
  }
  function locations(input) {
    const budgetId = standaloneTransferDestination(input);
    return { budgetId, stage: path.join(staging, budgetId), target: path.join(root, budgetId) };
  }
  /** FULL applies before BEGIN, including every bound ledger/planning handle.
   * The new private file has no other legitimate writer before publication. */
  function storeAt(parent) {
    const db = createCashflowDbService(createCashflowStoragePaths(parent));
    return createSqliteBudgetStore({ ...db, allowStandaloneOrigins: true, openPlanningDb: (...args) => {
      const connection = db.openPlanningDb(...args); connection.pragma('synchronous = FULL'); return connection;
    } });
  }
  async function financialHash(parent, budgetId, timing) {
    const store = storeAt(parent);
    try {
      const snapshot = await createBudgetStoreSnapshot({ budgetStore: store, budgetIds: [budgetId],
        now: new Date(timing.generationTimestamp), reason: 'standalone-transfer', allowStandaloneOrigins: true });
      return createHash('sha256').update(json(snapshot)).digest('hex');
    } finally { await store.close(); }
  }
  async function verify(parent, budgetId, value) {
    const allowed = new Set([SEED, READY, 'planning.sqlite', 'planning.sqlite-wal', 'planning.sqlite-shm']);
    if (fs.readdirSync(path.join(parent, budgetId)).some(name => !allowed.has(name))) throw conflict();
    const planningFile = path.join(parent, budgetId, 'planning.sqlite');
    if (!fs.lstatSync(planningFile).isFile()) throw conflict();
    // Verification must not migrate/recover an unrelated or altered database.
    const db = new Database(planningFile, { readonly: true, fileMustExist: true });
    try { if (db.pragma('user_version', { simple: true }) !== PLANNING_SCHEMA_VERSION) throw conflict(); }
    finally { db.close(); }
    const ready = read(path.join(parent, budgetId, READY));
    if (!ready || Object.keys(ready).sort().join(',') !== 'financialHash,version' || ready.version !== 1
      || !/^[a-f0-9]{64}$/.test(ready.financialHash)
      || await financialHash(parent, budgetId, value.timing) !== ready.financialHash) throw conflict();
  }

  return {
    /** Caller has committed a cancellation and still owns a new serialized
     * global transaction proving no budget metadata exists. Only this job's
     * unchanged private copy may be removed; unknown/altered files are retained. */
    async discardCancelled({ input: value }) {
      const input = normalizeStandaloneTransferRequest(value);
      const { budgetId, stage, target } = locations(input);
      directory(staging);
      const hasStage = directory(stage), hasTarget = directory(target);
      if (hasStage && hasTarget) throw conflict();
      if (!hasStage && !hasTarget) return;
      const location = hasTarget ? target : stage;
      const previous = seed(input, location);
      const allowed = new Set([SEED, READY, 'planning.sqlite', 'planning.sqlite-wal', 'planning.sqlite-shm']);
      if (fs.readdirSync(location).some(name => !allowed.has(name))) throw conflict();
      if (fs.existsSync(path.join(location, READY))) await verify(hasTarget ? root : staging, budgetId, previous);
      else if (hasTarget) throw conflict();
      fs.rmSync(location, { recursive: true });
      sync(hasTarget ? root : staging);
    },
    /** Only the authenticated journal calls this hook. A surviving prepared
     * seed retains the original decision time after a failed global commit. */
    async recoverReceipt({ input: value }) {
      const input = normalizeStandaloneTransferRequest(value);
      const { stage, target } = locations(input);
      directory(staging);
      const hasStage = directory(stage), hasTarget = directory(target);
      if (hasStage && hasTarget) throw conflict();
      if (!hasStage && !hasTarget) return null;
      return seed(input, hasTarget ? target : stage).receipt;
    },

    /** Prepare, verify, checkpoint and fsync before the atomic directory rename.
     * A late global failure leaves a sealed orphan for this same job to recover;
     * unknown target storage is never removed, replaced or merged. */
    async publish({ input: value, receipt: candidate, timing, prepared = null, hooks = {} }) {
      const input = normalizeStandaloneTransferRequest(value);
      const { budgetId, stage, target } = locations(input);
      directory(staging);
      const accepted = receipt(input, candidate);
      if (directory(target)) {
        const previous = seed(input, target);
        if (json(previous.receipt) !== json(accepted) || directory(stage)) throw conflict();
        await verify(root, budgetId, previous);
        return;
      }
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      if (!directory(staging)) throw conflict();
      let previous = directory(stage) ? seed(input, stage) : null;
      if (previous && json(previous.receipt) !== json(accepted)) throw conflict();
      if (previous && fs.existsSync(path.join(stage, READY))) {
        await verify(staging, budgetId, previous);
      } else {
        // Only a verified, unpublished directory belonging to this exact job
        // can be rebuilt after interrupted private financial preparation.
        if (previous) fs.rmSync(stage, { recursive: true });
        previous ??= { version: 1, receipt: accepted, timing };
        // Initialize off to the side: death before the seed is durable cannot
        // leave an unidentifiable directory at the canonical job destination.
        const temporary = fs.mkdtempSync(path.join(staging, '.prepare-'));
        write(path.join(temporary, SEED), previous);
        fs.renameSync(temporary, stage); sync(staging);
        const store = storeAt(staging);
        try {
          const plan = prepared && json(previous.timing) === json(timing) ? prepared
            : prepareStandaloneTransferWrite({ sourceJson: input.sourceJson, budgetId, readFxSnapshot, ...previous.timing });
          // The schema opener initializes only this private file.
          await store.planningTransaction(budgetId, async writer => {
            const result = await plan.write(writer);
            await applyProjectionGenerationPlanToBudgetStore({ budgetId, budgetStore: writer, plan: result.calculation.plan });
            await assertStandaloneTransferReadable({ writer, budgetId, readFxSnapshot, ...previous.timing });
          });
          await hooks.afterFinancial?.();
        } finally { await store.close(); }
        const hash = await financialHash(staging, budgetId, previous.timing);
        // Closing the last connection normally checkpoints WAL; make that
        // boundary explicit and refuse a busy/incomplete checkpoint.
        const db = new Database(path.join(stage, 'planning.sqlite'));
        try {
          db.pragma('synchronous = FULL');
          if (db.pragma('wal_checkpoint(TRUNCATE)').some(row => Number(row.busy) !== 0)) throw conflict();
        } finally { db.close(); }
        sync(path.join(stage, 'planning.sqlite'));
        write(path.join(stage, READY), { version: 1, financialHash: hash });
        await hooks.afterFilesReady?.();
      }
      // The global write lock serializes all publishers across processes. A
      // conflicting target is still refused immediately before the rename.
      if (directory(target)) throw conflict();
      fs.renameSync(stage, target); sync(staging); sync(root);
      await hooks.afterRename?.();
    }
  };
}
