#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { GLOBAL_TABLE_NAMES } from "../src/server/cashflow-global-schema.js";
import {
  LEDGER_TABLE_NAMES,
  PLANNING_TABLE_NAMES
} from "../src/server/cashflow-schema.js";

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dataDir: process.env.DATA_DIR || path.resolve("data"),
    includeIdentifiers: false,
    pretty: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--data-dir") {
      options.dataDir = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--include-identifiers") {
      options.includeIdentifiers = true;
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function usage() {
  return `Usage: npm run db:audit -- [--data-dir PATH] [--pretty] [--include-identifiers]

Reads existing SQLite storage and prints a migration-readiness inventory.
The default output omits budget/profile identifiers and never prints row values.`;
}

function stableHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function statSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function countTables(db, tableNames) {
  const tables = {};
  for (const tableName of tableNames) {
    if (!tableExists(db, tableName)) continue;
    tables[tableName] = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
  }
  return tables;
}

function inspectSqliteDb(dbPath, tableNames) {
  if (!fs.existsSync(dbPath)) {
    return { exists: false, sizeBytes: 0, userVersion: null, tables: {} };
  }

  const db = new Database(dbPath, {
    fileMustExist: true,
    readonly: true
  });

  try {
    db.pragma("query_only = ON");
    return {
      exists: true,
      sizeBytes: statSize(dbPath),
      walBytes: statSize(`${dbPath}-wal`),
      shmBytes: statSize(`${dbPath}-shm`),
      userVersion: db.pragma("user_version", { simple: true }),
      tables: countTables(db, tableNames)
    };
  } finally {
    db.close();
  }
}

function safeInspectSqliteDb(dbPath, tableNames) {
  try {
    return inspectSqliteDb(dbPath, tableNames);
  } catch (error) {
    return {
      exists: fs.existsSync(dbPath),
      sizeBytes: statSize(dbPath),
      userVersion: null,
      tables: {},
      error: error.message
    };
  }
}

function classifyBudgetEntry(rootDir, entry) {
  if (!entry.isDirectory()) return null;

  const budgetDir = path.join(rootDir, entry.name);
  const planningPath = path.join(budgetDir, "planning.sqlite");
  const ledgerFiles = fs.readdirSync(budgetDir, { withFileTypes: true })
    .filter(child => child.isFile() && /^ledger_\d{4}\.sqlite$/.test(child.name))
    .map(child => child.name)
    .sort();

  if (!fs.existsSync(planningPath) && !ledgerFiles.length) return null;

  return {
    storageKey: entry.name,
    planningPath,
    ledgerFiles
  };
}

function countDirectoryEntries(rootDir, name, matcher) {
  const dir = path.join(rootDir, name);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).filter(matcher).length;
}

export function auditSqliteStorage({
  dataDir = process.env.DATA_DIR || path.resolve("data"),
  includeIdentifiers = false,
  now = new Date()
} = {}) {
  const rootDir = path.resolve(dataDir);
  const exists = fs.existsSync(rootDir) && fs.statSync(rootDir).isDirectory();
  const report = {
    format: "cashflow-sqlite-storage-audit",
    version: 1,
    generatedAt: now.toISOString(),
    backend: "sqlite",
    dataDir: rootDir,
    exists,
    global: {
      path: path.join(rootDir, "cashflow-global.sqlite"),
      ...safeInspectSqliteDb(path.join(rootDir, "cashflow-global.sqlite"), GLOBAL_TABLE_NAMES)
    },
    budgets: [],
    totals: {
      budgets: 0,
      planningDbs: 0,
      ledgerDbs: 0,
      confirmedRows: 0,
      appBackupFolders: 0,
      deletedBudgetRecoveries: 0,
      globalMigrationRecoveries: 0
    }
  };

  if (!exists) return report;

  const budgetEntries = fs.readdirSync(rootDir, { withFileTypes: true })
    .map(entry => classifyBudgetEntry(rootDir, entry))
    .filter(Boolean)
    .sort((a, b) => a.storageKey.localeCompare(b.storageKey));

  report.totals.deletedBudgetRecoveries = countDirectoryEntries(
    rootDir,
    "deleted-budget-recoveries",
    entry => entry.isFile() && /^budget_.+\.json$/.test(entry.name)
  );
  report.totals.globalMigrationRecoveries = countDirectoryEntries(
    rootDir,
    "global-migration-backups",
    entry => entry.isDirectory() && /^global_migration_backup_/.test(entry.name)
  );

  budgetEntries.forEach((budget, index) => {
    const budgetDir = path.join(rootDir, budget.storageKey);
    const planning = safeInspectSqliteDb(budget.planningPath, PLANNING_TABLE_NAMES);
    const ledgers = budget.ledgerFiles.map(fileName => {
      const year = fileName.match(/^ledger_(\d{4})\.sqlite$/)?.[1] || "";
      const ledger = safeInspectSqliteDb(path.join(budgetDir, fileName), LEDGER_TABLE_NAMES);
      const confirmedRows = ledger.tables.confirmed_transactions || 0;
      report.totals.confirmedRows += confirmedRows;
      return {
        year,
        ...ledger,
        confirmedRows
      };
    });

    const budgetReport = {
      label: `budget_${index + 1}`,
      ...(includeIdentifiers ? { storageKey: budget.storageKey } : { storageKeyHash: stableHash(budget.storageKey) }),
      planning,
      ledgers,
      appBackupFolders: countDirectoryEntries(
        budgetDir,
        "backups",
        entry => entry.isDirectory() && /^backup_/.test(entry.name)
      ),
      migrationRecoveries: countDirectoryEntries(
        budgetDir,
        "backups",
        entry => entry.isDirectory() && /^migration_backup_/.test(entry.name)
      )
    };

    if (includeIdentifiers) {
      budgetReport.path = budgetDir;
    }

    report.budgets.push(budgetReport);
  });

  report.totals.budgets = report.budgets.length;
  report.totals.planningDbs = report.budgets.filter(budget => budget.planning.exists).length;
  report.totals.ledgerDbs = report.budgets.reduce((sum, budget) => sum + budget.ledgers.length, 0);
  report.totals.appBackupFolders = report.budgets.reduce((sum, budget) => sum + budget.appBackupFolders, 0);

  return report;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }

  const report = auditSqliteStorage(options);
  console.log(JSON.stringify(report, null, options.pretty ? 2 : 0));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
