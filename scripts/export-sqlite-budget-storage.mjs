#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  createSqliteBudgetStore
} from "../src/server/cashflow-budget-store.js";
import {
  createBudgetStoreExport
} from "../src/server/cashflow-budget-store-export.js";
import {
  SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
  SQLITE_BUDGET_STORAGE_EXPORT_VERSION
} from "../src/server/cashflow-postgres-budget-import.js";
import {
  POSTGRES_LEDGER_SCHEMA_VERSION,
  POSTGRES_PLANNING_SCHEMA_VERSION
} from "../src/server/cashflow-postgres-budget-schema.js";
import {
  LEDGER_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION
} from "../src/server/cashflow-schema.js";
import { normalizeUserId } from "../src/server/cashflow-user-utils.js";

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    budgetId: "",
    dataDir: process.env.DATA_DIR || path.resolve("data"),
    outputDir: path.resolve("external-database-exports"),
    pretty: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--data-dir") {
      options.dataDir = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--output-dir") {
      options.outputDir = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--budget-id") {
      options.budgetId = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.budgetId) normalizeUserId(options.budgetId);
  return options;
}

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

export async function createSqliteBudgetStorageExport({
  budgetId = "",
  dataDir = process.env.DATA_DIR || path.resolve("data"),
  outputDir = path.resolve("external-database-exports"),
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

  const normalizedBudgetId = budgetId ? normalizeUserId(budgetId) : "";
  const budgets = budgetsFromGlobalDb(rootDir)
    .filter(budget => !normalizedBudgetId || budget.id === normalizedBudgetId);
  if (normalizedBudgetId && !budgets.length) {
    throw new Error(`Budget not found: ${normalizedBudgetId}`);
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const createdAt = now.toISOString();
  const exportId = `${createdAt.replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
  const finalPath = path.join(targetRoot, `cashflow_sqlite_budget_export_${exportId}.json`);
  const temporaryPath = `${finalPath}.tmp`;
  const budgetSources = [];
  const budgetsById = new Map(budgets.map(budget => [budget.id, budget]));
  const budgetStore = createSqliteBudgetStore({
    listLedgerYears: id => {
      const budget = budgetsById.get(id);
      if (!budget) return [];
      return ledgerFilesForBudgetDir(path.join(rootDir, budget.storageKey))
        .map(file => file.year);
    },
    openLedgerDb: (id, year) => {
      const budget = budgetsById.get(id);
      if (!budget) throw new Error(`Budget not found: ${id}`);
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
      } finally {
        planningDb.close();
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

    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, finalPath);

    return {
      ok: true,
      format: SQLITE_BUDGET_STORAGE_EXPORT_FORMAT,
      version: SQLITE_BUDGET_STORAGE_EXPORT_VERSION,
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
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = await createSqliteBudgetStorageExport(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
