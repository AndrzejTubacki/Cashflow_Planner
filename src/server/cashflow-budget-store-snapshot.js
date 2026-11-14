import { confirmedRowsWithRunningBalances } from "./cashflow-ledger-balance-utils.js";
import { createNodeLedgerAuditReplay } from "./cashflow-ledger-audit-store.js";
import { normalizeLedgerAuditFact } from "./cashflow-ledger-correction-service.js";
import { validateLedgerCorrectionFact } from "./cashflow-ledger-correction-plan.js";
import { replacePlanningBatches } from "./cashflow-planning-replacement.js";
import { createBudgetStoreExport } from "./cashflow-budget-store-export.js";
import {
  normalizeSqliteBudgetStorageExport
} from "./cashflow-postgres-budget-import.js";
import {
  POSTGRES_BUDGET_PLANNING_TABLES
} from "./cashflow-postgres-budget-schema.js";

export const BUDGET_STORE_SNAPSHOT_FORMAT = "cashflow-budget-store-snapshot";
export const BUDGET_STORE_SNAPSHOT_VERSION = 2;

function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

function assertSnapshotWriter(budgetStore) {
  if (!budgetStore || typeof budgetStore !== "object") {
    throw new Error("A budget-store writer is required");
  }
  if (typeof budgetStore.replacePlanningRows !== "function") {
    throw new Error("Budget-store writer must implement replacePlanningRows");
  }
  if (typeof budgetStore.replaceConfirmedTransactionsForYear !== "function") {
    throw new Error("Budget-store writer must implement replaceConfirmedTransactionsForYear");
  }
}

function budgetIdsFromExport(exportPayload) {
  const ids = new Set();
  for (const source of exportPayload.budgetSources || []) {
    if (source?.budgetId) ids.add(String(source.budgetId));
  }
  for (const row of exportPayload.tables?.settings || []) {
    if (row?.budget_id) ids.add(String(row.budget_id));
  }
  return [...ids].sort();
}

function sourceLedgerYearsForBudget(exportPayload, budgetId) {
  const source = (exportPayload.budgetSources || [])
    .find(item => String(item?.budgetId || "") === budgetId);
  const directYears = Array.isArray(source?.ledgerYears)
    ? source.ledgerYears
    : [];
  const schemaYears = Array.isArray(source?.ledgerSchemaVersions)
    ? source.ledgerSchemaVersions.map(item => item?.year)
    : [];
  return [...new Set([...directYears, ...schemaYears]
    .map(year => Number(year))
    .filter(Number.isInteger))]
    .sort((a, b) => a - b);
}

function rowsForBudget(exportPayload, tableName, budgetId) {
  return (exportPayload.tables?.[tableName] || [])
    .filter(row => String(row.budget_id || "") === budgetId)
    .map(row => ({ ...row }));
}

function confirmedRowsForBudgetYear(exportPayload, budgetId, ledgerYear) {
  return rowsForBudget(exportPayload, "confirmed_transactions", budgetId)
    .filter(row => Number(row.ledger_year) === Number(ledgerYear));
}

function ledgerYearsFromRows(exportPayload, budgetId) {
  return [...new Set(rowsForBudget(exportPayload, "confirmed_transactions", budgetId)
    .map(row => Number(row.ledger_year))
    .filter(Number.isInteger))]
    .sort((a, b) => a - b);
}

/** Compare accepted facts rather than mutable running balances or backend
 * timestamp/year encodings. Audit replay must describe exactly this snapshot's
 * effective ledger; a valid audit from a different point in time is insufficient. */
function canonicalFacts(rows) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify([...rows].sort((a,b) => a.id.localeCompare(b.id)).map(canonical));
}

/** Version 1 contains no audit authority. Version 2 carries complete scoped
 * audit DTOs, financially replayed before any restore transaction can write. */
/** Replay complete audited facts and rebuild balances. A retained origin's
 * opening belongs only to its original ledger currency; transport totals and
 * the current settings currency never redefine that historical offset. */
function normalizeLedgerAudits(snapshot, payload, budgetIds, replayLedgerAuditSnapshot) {
  if (snapshot.version === 1) {
    if (Object.hasOwn(snapshot, 'ledgerAudits')) throw new Error('Version-1 snapshot cannot contain ledger audits');
    return [];
  }
  const audits = snapshot.ledgerAudits;
  if (!Array.isArray(audits) || audits.length > budgetIds.length) throw new Error('Invalid snapshot ledger audits');
  const seen = new Set();
  for (const audit of audits) {
    if (!audit || !budgetIds.includes(audit.budgetId) || seen.has(audit.budgetId)) throw new Error('Duplicate or foreign snapshot ledger audit');
    seen.add(audit.budgetId);
    const replay = replayLedgerAuditSnapshot(audit, audit.budgetId);
    const actual = rowsForBudget(payload, 'confirmed_transactions', audit.budgetId)
      .map(row => validateLedgerCorrectionFact(normalizeLedgerAuditFact(row, audit.budgetId), audit.budgetId));
    if (canonicalFacts(actual) !== canonicalFacts(replay.rows)) throw new Error('Snapshot ledger differs from retained audit evidence');
    // Running totals are derived, never imported authority. Rebuild each ledger
    // currency independently from replayed facts before the host inserts rows.
    const currencies = new Set(replay.rows.map(row => row.ledger_currency));
    const calculated = [...currencies].flatMap(currency => confirmedRowsWithRunningBalances(
      replay.rows.filter(row => row.ledger_currency === currency),
      { openingBalance: replay.opening?.ledgerCurrency === currency ? replay.opening.amount : 0 }));
    if (calculated.some(row => !Number.isFinite(row.running_balance_pln)
      || !Number.isSafeInteger(Math.round(row.running_balance_pln * 100)))) {
      throw new Error('Snapshot ledger balance exceeds safe monetary precision');
    }
    const byId = new Map(calculated.map(row => [row.id, row]));
    payload.tables.confirmed_transactions = payload.tables.confirmed_transactions.map(row => {
      if (row.budget_id !== audit.budgetId) return row;
      const balanced = byId.get(row.id);
      return { ...row, ledger_amount: balanced.ledger_amount, running_balance_pln: balanced.running_balance_pln };
    });
  }
  return structuredClone(audits);
}

/** Capture planning, effective ledger and any completed audit namespace. Hosts
 * should hold their budget lock for all reads; an audit/ledger mismatch is refused
 * rather than publishing evidence assembled from different financial states.
 * Origin support must be explicitly enabled by this host and its store. */
export async function createBudgetStoreSnapshot({
  budgetIds,
  budgetStore,
  excludeBackupMetadata = false,
  allowStandaloneOrigins = false,
  now = new Date(),
  reason = "manual"
} = {}) {
  const payload = await createBudgetStoreExport({
    budgetIds,
    budgetStore,
    excludeBackupMetadata,
    now
  });

  const ledgerAudits = [];
  if (typeof budgetStore.exportLedgerAuditSnapshot === 'function') {
    for (const budgetId of budgetIdsFromExport(payload)) {
      const audit = await budgetStore.exportLedgerAuditSnapshot(budgetId);
      if (audit !== null) ledgerAudits.push(audit);
    }
  }
  const snapshot = {
    ledgerAudits,
    budgetCount: payload.budgetCount,
    budgetIds: budgetIdsFromExport(payload),
    containsSensitiveData: true,
    createdAt: nowIso(now),
    format: BUDGET_STORE_SNAPSHOT_FORMAT,
    payload,
    reason: String(reason || "manual"),
    version: BUDGET_STORE_SNAPSHOT_VERSION
  };
  normalizeBudgetStoreSnapshot(snapshot, { allowStandaloneOrigins });
  return snapshot;
}

/** Accept historical v1 and current v2, validating scoped replay and deriving
 * audited balances before a restore can write. The input object stays untouched.
 * An imported field cannot enable origin support; only the second host option can. */
export function normalizeBudgetStoreSnapshot(snapshot, { allowStandaloneOrigins = false } = {}) {
  const { replayLedgerAuditSnapshot } = createNodeLedgerAuditReplay({ allowStandaloneOrigins });
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Budget-store snapshot must be an object");
  }
  if (snapshot.format !== BUDGET_STORE_SNAPSHOT_FORMAT) {
    throw new Error("Unsupported budget-store snapshot format");
  }
  if (![1, BUDGET_STORE_SNAPSHOT_VERSION].includes(snapshot.version)) {
    throw new Error("Unsupported budget-store snapshot version");
  }

  const payload = normalizeSqliteBudgetStorageExport(snapshot.payload);
  const budgetIds = budgetIdsFromExport(payload);
  const ledgerAudits = normalizeLedgerAudits(snapshot, payload, budgetIds, replayLedgerAuditSnapshot);
  return {
    ...(snapshot.version === 1 ? {} : { ledgerAudits }),
    budgetCount: payload.budgetSources?.length || budgetIdsFromExport(payload).length,
    budgetIds: budgetIdsFromExport(payload),
    containsSensitiveData: true,
    createdAt: snapshot.createdAt || null,
    format: snapshot.format,
    payload,
    reason: snapshot.reason || "manual",
    version: snapshot.version
  };
}

/** Replace financial facts and audit on the owning transaction. PostgreSQL
 * spans all selected budgets; SQLite is atomic per independent budget file.
 * Historical snapshots replace the audit namespace with an explicit legacy gap.
 * Origin-aware normalization and the transaction-bound writer must both opt in. */
export async function restoreBudgetStoreSnapshot({
  budgetStore,
  includeExistingLedgerYears = true,
  preserveBackupMetadata = false,
  allowStandaloneOrigins = false,
  onBatch = () => {},
  beforeApply = async () => {},
  snapshot
} = {}) {
  assertSnapshotWriter(budgetStore);
  const normalized = normalizeBudgetStoreSnapshot(snapshot, { allowStandaloneOrigins });
  const payload = normalized.payload;

  const restoreWithWriter = async (writer, selectedBudgetIds = normalized.budgetIds) => {
    if ((normalized.ledgerAudits || []).length && typeof writer.replaceLedgerAuditSnapshot !== 'function') {
      throw new Error('Audit snapshot restore requires a transaction-bound audit writer');
    }
    // Same reasoning as the full-import path in
    // cashflow-budget-store-import-plan.js: ordinary mutation routes don't
    // check any runtime lock, so this transaction-scoped advisory lock is
    // what actually keeps a restore from racing a concurrent ordinary
    // mutation on the same budget from a different replica.
    if (typeof writer.lockBudgetLedger === "function") {
      for (const budgetId of selectedBudgetIds) {
        await writer.lockBudgetLedger(budgetId);
      }
    }

    // Imports can fence prepared settings before any snapshot rows are written.
    await beforeApply(writer);
    const appliedBatches = [];

    for (const budgetId of selectedBudgetIds) {
      // Epoch fencing joins the same owning transaction as this budget's
      // planning, ledger and audit replacement on both runtime backends.
      if (typeof writer.rotateSyncEpoch === "function") await writer.rotateSyncEpoch(budgetId);
      // Group SQLite planning writes so FK validation and rollback cover the
      // whole graph. Postgres continues using its surrounding transaction.
      const planningBatches = POSTGRES_BUDGET_PLANNING_TABLES
        .filter(tableName => !(preserveBackupMetadata && tableName === "backup_metadata"))
        .map(tableName => ({ tableName, rows: rowsForBudget(payload, tableName, budgetId) }));
      appliedBatches.push(...await replacePlanningBatches(writer, budgetId, planningBatches, onBatch));

      const sourceYears = new Set([
        ...sourceLedgerYearsForBudget(payload, budgetId),
        ...ledgerYearsFromRows(payload, budgetId)
      ]);
      if (includeExistingLedgerYears && typeof writer.listLedgerYears === "function") {
        for (const year of await writer.listLedgerYears(budgetId)) {
          const normalizedYear = Number(year);
          if (Number.isInteger(normalizedYear)) sourceYears.add(normalizedYear);
        }
      }

      for (const ledgerYear of [...sourceYears].sort((a, b) => a - b)) {
        const rows = confirmedRowsForBudgetYear(payload, budgetId, ledgerYear);
        await onBatch({
          budgetId,
          ledgerYear,
          rows: rows.length,
          tableName: "confirmed_transactions",
          type: "ledger"
        });
        const result = await writer.replaceConfirmedTransactionsForYear(budgetId, ledgerYear, rows);
        appliedBatches.push({
          budgetId,
          ledgerYear,
          result: { ...(result || {}) },
          rows: rows.length,
          tableName: "confirmed_transactions",
          type: "ledger"
        });
      }
      if (typeof writer.replaceLedgerAuditSnapshot === 'function') {
        const audit = (normalized.ledgerAudits || []).find(item => item.budgetId === budgetId) || null;
        const result = await writer.replaceLedgerAuditSnapshot(budgetId, audit);
        if (result.changed) {
          const batch = { budgetId, ledgerYear: null, tableName: 'ledger-audit', type: 'audit',
            rows: audit ? audit.originals.length + audit.corrections.length : 0 };
          // This late hook is inside the same transaction as audit and ledger.
          await onBatch(batch);
          appliedBatches.push({ ...batch, result });
        }
      }
    }

    return appliedBatches;
  };

  let appliedBatches;
  if (typeof budgetStore.transaction === 'function') {
    appliedBatches = await budgetStore.transaction(writer => restoreWithWriter(writer));
  } else if (budgetStore.backend === 'sqlite' && typeof budgetStore.planningTransaction === 'function') {
    appliedBatches = [];
    // SQLite budgets are independent files: each complete budget is atomic.
    // This does not claim one transaction across a multi-budget archive.
    for (const budgetId of normalized.budgetIds) {
      appliedBatches.push(...await budgetStore.planningTransaction(budgetId, writer => restoreWithWriter(writer, [budgetId])));
    }
  } else {
    appliedBatches = await restoreWithWriter(budgetStore);
  }

  return {
    appliedBatches,
    budgetCount: normalized.budgetCount,
    budgetIds: [...normalized.budgetIds],
    ok: true,
    restoredAt: nowIso(new Date()),
    sourceCreatedAt: normalized.createdAt,
    writeBatchCount: appliedBatches.length
  };
}
