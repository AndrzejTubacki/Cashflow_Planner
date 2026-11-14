#!/usr/bin/env node

import { ENGINE_AUDIT_HOST_OPTIONS } from "../src/engine/engine-host-capabilities.js";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from 'node:util';
import { readSqliteFinancialExportAudit, validateFinancialExportAudit } from '../src/server/cashflow-ledger-audit-export.js';

import { isMainModule, parseCliArgs } from "./lib/cli.mjs";

import Database from "better-sqlite3";

import { GLOBAL_SCHEMA_VERSION } from "../src/server/cashflow-global-schema.js";
import {
  LEDGER_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION
} from "../src/server/cashflow-schema.js";
import { normalizeCashflowStorageSnapshot } from "../src/server/cashflow-storage-snapshot.js";


function usage() {
  return `Usage: npm run db:sqlite:verify -- --input PATH --data-dir PATH [--pretty]

Compares a Postgres storage export artifact with row counts and schema
versions read from the SQLite files under --data-dir (ledger rows from
planning.sqlite, plus any not-yet-merged yearly ledger files). Read-only; does not
modify --data-dir.`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function countRows(db, tableName) {
  if (!tableExists(db, tableName)) return 0;
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function compareCount(mismatches, scope, table, expected, actual) {
  if (Number(expected) !== Number(actual)) {
    mismatches.push({ actual: Number(actual), expected: Number(expected), scope, table });
  }
}

function compareSchemaValue(mismatches, field, expected, actual) {
  if (Number(expected) !== Number(actual)) {
    mismatches.push({ actual: Number(actual), expected: Number(expected), field, scope: "schema" });
  }
}

/** Read-only proof/count verification. Origin-aware hosts replay the exact
 * retained origin/index/history; default callers refuse the new semantics. */
export function verifySqliteMigration({
  dataDir = process.env.DATA_DIR || path.resolve("data"),
  allowStandaloneOrigins = false,
  input = ""
} = {}) {
  if (!input) throw new Error("--input is required");

  const snapshot = normalizeCashflowStorageSnapshot(readJson(input), { allowStandaloneOrigins });
  const rootDir = path.resolve(dataDir);
  const mismatches = [];

  const globalDbPath = path.join(rootDir, "cashflow-global.sqlite");
  if (!fs.existsSync(globalDbPath)) {
    throw new Error(`Global SQLite database not found: ${globalDbPath}`);
  }
  const globalDb = new Database(globalDbPath, { readonly: true, fileMustExist: true });
  try {
    compareSchemaValue(
      mismatches,
      "globalVersion",
      GLOBAL_SCHEMA_VERSION,
      globalDb.pragma("user_version", { simple: true })
    );
    for (const [table, expected] of Object.entries(snapshot.global.rowCounts)) {
      compareCount(mismatches, "global", table, expected, countRows(globalDb, table));
    }
  } finally {
    globalDb.close();
  }

  const planningTables = Object.keys(snapshot.budget.payload.rowCounts)
    .filter(table => table !== "confirmed_transactions");
  const actualBudgetCounts = Object.fromEntries(
    [...planningTables, "confirmed_transactions"].map(table => [table, 0])
  );

  for (const budgetId of snapshot.budgetIds) {
    const budgetDir = path.join(rootDir, budgetId);

    const planningDbPath = path.join(budgetDir, "planning.sqlite");
    if (fs.existsSync(planningDbPath)) {
      const db = new Database(planningDbPath, { readonly: true, fileMustExist: true });
      try {
        compareSchemaValue(
          mismatches,
          `planningVersion:${budgetId}`,
          PLANNING_SCHEMA_VERSION,
          db.pragma("user_version", { simple: true })
        );
        for (const table of planningTables) {
          actualBudgetCounts[table] += countRows(db, table);
        }
        // Since planning schema 22 the ledger is a planning.sqlite table.
        actualBudgetCounts.confirmed_transactions += countRows(db, "ledger_transactions");
        const expected = (snapshot.budget.ledgerAudits || []).find(audit => audit.budgetId === budgetId) || null;
        try {
          const retained = readSqliteFinancialExportAudit(db, budgetId, { allowStandaloneOrigins });
          if (retained !== null) {
            const ledgers = {};
            for (const row of db.prepare('SELECT * FROM ledger_transactions').all()) {
              (ledgers[row.ledger_year] ||= []).push(row);
            }
            validateFinancialExportAudit(budgetId, retained, ledgers, { allowStandaloneOrigins });
          }
          if (!isDeepStrictEqual(retained, expected)) {
            mismatches.push({ scope: 'ledger-audit', budgetId, reason: 'retained_evidence_differs' });
          }
        } catch {
          mismatches.push({ scope: 'ledger-audit', budgetId, reason: 'invalid_retained_evidence' });
        }
      } finally {
        db.close();
      }
    }

    // Yearly files only exist for data not yet merged by the server.
    if (!fs.existsSync(budgetDir)) continue;
    for (const entry of fs.readdirSync(budgetDir)) {
      if (!/^ledger_\d{4}\.sqlite$/.test(entry)) continue;
      const db = new Database(path.join(budgetDir, entry), { readonly: true, fileMustExist: true });
      try {
        compareSchemaValue(
          mismatches,
          `ledgerVersion:${budgetId}:${entry}`,
          LEDGER_SCHEMA_VERSION,
          db.pragma("user_version", { simple: true })
        );
        actualBudgetCounts.confirmed_transactions += countRows(db, "confirmed_transactions");
      } finally {
        db.close();
      }
    }
  }

  for (const [table, expected] of Object.entries(snapshot.budget.payload.rowCounts)) {
    compareCount(mismatches, "budget", table, expected, actualBudgetCounts[table]);
  }

  return {
    budgetCount: snapshot.budgetCount,
    budgetIds: snapshot.budgetIds,
    mismatches,
    ok: mismatches.length === 0,
    targetBackend: "sqlite",
    verified: true
  };
}

export function verifySqliteMigrationCli(options = parseArgs()) {
  if (options.help) {
    return { help: usage() };
  }
  return verifySqliteMigration(options);
}

function main() {
  const options = parseCliArgs(process.argv.slice(2), {
    string: ["--input","--data-dir"],
    boolean: ["--pretty"],
    defaults: {
    // The installed CLI supports the same financial format as engine 0.4.
    ...ENGINE_AUDIT_HOST_OPTIONS,
    dataDir: process.env.DATA_DIR || path.resolve("data"),
    input: "",
    pretty: false
  }
  });
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = verifySqliteMigrationCli(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
  if (!result.ok) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main();
}
