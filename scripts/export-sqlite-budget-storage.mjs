#!/usr/bin/env node

import { ENGINE_AUDIT_HOST_OPTIONS } from "../src/engine/engine-host-capabilities.js";

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule, parseCliArgs } from "./lib/cli.mjs";

import Database from "better-sqlite3";

import {
  createSqliteBudgetStore
} from "../src/server/cashflow-budget-store.js";
import {
  createBudgetStoreExport
} from "../src/server/cashflow-budget-store-export.js";
import {
  POSTGRES_LEDGER_SCHEMA_VERSION,
  POSTGRES_PLANNING_SCHEMA_VERSION
} from "../src/server/cashflow-postgres-budget-schema.js";
import {
  LEDGER_IN_PLANNING_SCHEMA_VERSION,
  LEDGER_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION,
  ledgerYearViewSql
} from "../src/server/cashflow-schema.js";
import { normalizeUserId } from "../src/server/cashflow-user-utils.js";
import { readSqliteFinancialExportAudit } from "../src/server/cashflow-ledger-audit-export.js";
import { BUDGET_STORE_SNAPSHOT_FORMAT, BUDGET_STORE_SNAPSHOT_VERSION,
  normalizeBudgetStoreSnapshot } from "../src/server/cashflow-budget-store-snapshot.js";


function usage() {
  return `Usage: npm run db:budget:export -- [--data-dir PATH] [--output-dir PATH] [--budget-id ID] [--pretty]

Exports SQLite budget planning and ledger rows into a sensitive JSON migration artifact.
The command prints only a summary; the generated file contains real budget rows.`;
}

function isInsidePath(child, parent) {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function openReadOnlySqlite(dbPath) {
  const db = new Database(dbPath, {
    fileMustExist: true,
    readonly: true
  });
  db.pragma("query_only = ON");
  return db;
}

function sqliteVersion(db) {
  return db.pragma("user_version", { simple: true });
}

function ledgerFilesForBudgetDir(budgetDir) {
  if (!fs.existsSync(budgetDir) || !fs.statSync(budgetDir).isDirectory()) return [];
  return fs.readdirSync(budgetDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^ledger_\d{4}\.sqlite$/.test(entry.name))
    .map(entry => ({
      fileName: entry.name,
      path: path.join(budgetDir, entry.name),
      year: Number(entry.name.match(/^ledger_(\d{4})\.sqlite$/)?.[1])
    }))
    .filter(entry => Number.isInteger(entry.year))
    .sort((a, b) => a.year - b.year);
}

/** Ledger years held inside planning.sqlite (schema 22+, merge done), or null
 * when the budget's ledger still lives in yearly files. */
function mergedLedgerYears(planningPath) {
  const db = openReadOnlySqlite(planningPath);
  try {
    if (sqliteVersion(db) < LEDGER_IN_PLANNING_SCHEMA_VERSION || !tableExists(db, "ledger_merge_state")
      || !db.prepare("SELECT 1 FROM ledger_merge_state WHERE id = 1").get()) return null;
    return db.prepare("SELECT DISTINCT ledger_year FROM ledger_transactions ORDER BY ledger_year").all()
      .map(row => Number(row.ledger_year));
  } finally {
    db.close();
  }
}

/** A read-only planning connection showing one merged ledger year as
 * confirmed_transactions; the temporary view is created before query_only. */
function openMergedLedgerYear(planningPath, year) {
  const db = new Database(planningPath, { fileMustExist: true, readonly: true });
  try {
    db.exec(ledgerYearViewSql(year));
    db.pragma("query_only = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function budgetsFromGlobalDb(rootDir) {
  const globalPath = path.join(rootDir, "cashflow-global.sqlite");
  if (!fs.existsSync(globalPath) || !fs.statSync(globalPath).isFile()) {
    throw new Error(`Global SQLite database not found: ${globalPath}`);
  }

  const db = openReadOnlySqlite(globalPath);
  try {
    if (!tableExists(db, "budgets")) {
      throw new Error("Global SQLite database does not contain budgets metadata");
    }
    return db.prepare(`
      SELECT id, storage_key, display_name, status
      FROM budgets
      WHERE status != 'deleted'
      ORDER BY id
    `).all().map(row => ({
      id: normalizeUserId(row.id),
      storageKey: normalizeUserId(row.storage_key || row.id),
      displayName: row.display_name || row.id,
      status: row.status || "active"
    }));
  } finally {
    db.close();
  }
}

/** Read-only export; an upgraded host may preserve origin proof explicitly.
 * No file field can opt this reader into an unsupported financial format. */
export async function createSqliteBudgetStorageExport({
  budgetId = "",
  dataDir = process.env.DATA_DIR || path.resolve("data"),
  outputDir = path.resolve("external-database-exports"),
  allowStandaloneOrigins = false,
  now = new Date()
} = {}) {
  const rootDir = path.resolve(dataDir);
  const targetRoot = path.resolve(outputDir);
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`DATA_DIR not found: ${rootDir}`);
  }
  if (isInsidePath(targetRoot, rootDir)) {
    throw new Error("Budget storage export output directory must not be inside DATA_DIR");
  }

  const budgets = budgetsFromGlobalDb(rootDir)
    .filter(budget => !budgetId || budget.id === budgetId);
  if (budgetId && !budgets.length) {
    throw new Error(`Budget not found: ${budgetId}`);
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const createdAt = now.toISOString();
  const exportId = `${createdAt.replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
  const finalPath = path.join(targetRoot, `cashflow_sqlite_budget_export_${exportId}.json`);
  const temporaryPath = `${finalPath}.tmp`;
  const budgetSources = [];
  const ledgerAudits = [];
  const budgetsById = new Map(budgets.map(budget => [budget.id, budget]));
  // Merged ledgers are read from planning.sqlite; yearly files only count for
  // budgets the server has not opened since the merge shipped.
  const mergedYearsById = new Map();
  const mergedYears = id => {
    if (!mergedYearsById.has(id)) {
      const planningPath = path.join(rootDir, budgetsById.get(id).storageKey, "planning.sqlite");
      mergedYearsById.set(id, fs.existsSync(planningPath) ? mergedLedgerYears(planningPath) : null);
    }
    return mergedYearsById.get(id);
  };
  const budgetStore = createSqliteBudgetStore({
    allowStandaloneOrigins,
    listLedgerYears: id => {
      const budget = budgetsById.get(id);
      if (!budget) return [];
      return mergedYears(id) ?? ledgerFilesForBudgetDir(path.join(rootDir, budget.storageKey))
        .map(file => file.year);
    },
    openLedgerDb: (id, year) => {
      const budget = budgetsById.get(id);
      if (!budget) throw new Error(`Budget not found: ${id}`);
      if (mergedYears(id)) return openMergedLedgerYear(path.join(rootDir, budget.storageKey, "planning.sqlite"), year);
      return openReadOnlySqlite(path.join(rootDir, budget.storageKey, `ledger_${year}.sqlite`));
    },
    openPlanningDb: id => {
      const budget = budgetsById.get(id);
      if (!budget) throw new Error(`Budget not found: ${id}`);
      return openReadOnlySqlite(path.join(rootDir, budget.storageKey, "planning.sqlite"));
    }
  });

  try {
    for (const budget of budgets) {
      const budgetDir = path.join(rootDir, budget.storageKey);
      const planningPath = path.join(budgetDir, "planning.sqlite");
      if (!fs.existsSync(planningPath) || !fs.statSync(planningPath).isFile()) {
        throw new Error(`Planning SQLite database not found for budget ${budget.id}`);
      }

      const budgetSource = {
        budgetId: budget.id,
        storageKey: budget.storageKey,
        displayName: budget.displayName,
        status: budget.status,
        planningSchemaVersion: null,
        ledgerSchemaVersions: []
      };

      const planningDb = openReadOnlySqlite(planningPath);
      try {
        budgetSource.planningSchemaVersion = sqliteVersion(planningDb);
        // Read the stopped snapshot without opening a write transaction or
        // seeding evidence. Retained history must never disappear in migration.
        const audit = readSqliteFinancialExportAudit(planningDb, budget.id, { allowStandaloneOrigins });
        if (audit !== null) ledgerAudits.push(audit);
      } finally {
        planningDb.close();
      }

      const merged = mergedYears(budget.id);
      if (merged) {
        // Merged rows were migrated to the current ledger schema at merge time.
        budgetSource.ledgerSchemaVersions = merged.map(year => ({ year, version: LEDGER_SCHEMA_VERSION }));
        budgetSources.push(budgetSource);
        continue;
      }
      for (const ledgerFile of ledgerFilesForBudgetDir(budgetDir)) {
        const ledgerDb = openReadOnlySqlite(ledgerFile.path);
        try {
          const ledgerSchemaVersion = sqliteVersion(ledgerDb);
          budgetSource.ledgerSchemaVersions.push({
            year: ledgerFile.year,
            version: ledgerSchemaVersion
          });
        } finally {
          ledgerDb.close();
        }
      }

      budgetSources.push(budgetSource);
    }

    const exported = await createBudgetStoreExport({
      budgetIds: budgets.map(budget => budget.id),
      budgetStore,
      now
    });
    const payload = {
      ...exported,
      sourcePlanningSchemaVersion: PLANNING_SCHEMA_VERSION,
      sourceLedgerSchemaVersion: LEDGER_SCHEMA_VERSION,
      budgetSources
    };
    // Reuse the established lossless v2 snapshot instead of extending a v1
    // artifact that older importers would silently read without its history.
    const artifact = ledgerAudits.length ? normalizeBudgetStoreSnapshot({
      format: BUDGET_STORE_SNAPSHOT_FORMAT, version: BUDGET_STORE_SNAPSHOT_VERSION,
      createdAt, reason: 'sqlite_to_postgres_migration', payload, ledgerAudits
    }, { allowStandaloneOrigins }) : payload;

    fs.writeFileSync(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, finalPath);

    return {
      ok: true,
      format: artifact.format,
      version: artifact.version,
      exportPath: finalPath,
      budgetCount: budgetSources.length,
      targetBackend: "postgres",
      targetPlanningSchemaVersion: POSTGRES_PLANNING_SCHEMA_VERSION,
      targetLedgerSchemaVersion: POSTGRES_LEDGER_SCHEMA_VERSION,
      rowCounts: exported.rowCounts,
      containsSensitiveData: true
    };
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original export error.
    }
    throw error;
  }
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2), {
    string: ["--data-dir","--output-dir","--budget-id"],
    boolean: ["--pretty"],
    defaults: {
    // The installed CLI supports the same financial format as engine 0.4.
    ...ENGINE_AUDIT_HOST_OPTIONS,
    budgetId: "",
    dataDir: process.env.DATA_DIR || path.resolve("data"),
    outputDir: path.resolve("external-database-exports"),
    pretty: false
  }
  });
  if (options.budgetId) {
    options.budgetId = normalizeUserId(options.budgetId);
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = await createSqliteBudgetStorageExport(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
