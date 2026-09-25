#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule, parseCliArgs } from "./lib/cli.mjs";

import { createSqliteBudgetStorageExport } from "./export-sqlite-budget-storage.mjs";
import { createSqliteGlobalMetadataExport } from "./export-sqlite-global-metadata.mjs";
import { importSqliteBudgetStorageToPostgres } from "../src/server/cashflow-postgres-budget-import.js";
import { importSqliteGlobalMetadataToPostgres } from "../src/server/cashflow-postgres-global-import.js";


function usage() {
  return `Usage: npm run db:migrate:sqlite-to-postgres -- --data-dir PATH --output-dir PATH [--dry-run|--apply] [--source-is-snapshot] [--pretty]

Creates SQLite global and budget export artifacts, validates them, and optionally imports them into the draft Postgres schema.
Apply mode requires --source-is-snapshot and a Postgres database URL. Runtime Postgres mode remains disabled.`;
}

async function loadPgModule(pgModule = null) {
  if (pgModule) return pgModule;
  try {
    return await import("pg");
  } catch (error) {
    const next = new Error("Apply mode requires the pg package to be installed");
    next.cause = error;
    throw next;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function compactSummary(globalResult, budgetResult, {
  applied = false,
  dryRun = true,
  outputDir
} = {}) {
  return {
    ok: true,
    applied,
    dryRun,
    outputDir: path.resolve(outputDir),
    artifacts: {
      globalExportPath: globalResult.exportPath,
      budgetExportPath: budgetResult.exportPath
    },
    global: {
      rowCounts: globalResult.rowCounts,
      targetBackend: globalResult.targetBackend,
      targetGlobalSchemaVersion: globalResult.targetGlobalSchemaVersion
    },
    budget: {
      budgetCount: budgetResult.budgetCount,
      rowCounts: budgetResult.rowCounts,
      targetBackend: budgetResult.targetBackend,
      targetPlanningSchemaVersion: budgetResult.targetPlanningSchemaVersion,
      targetLedgerSchemaVersion: budgetResult.targetLedgerSchemaVersion
    }
  };
}

export async function migrateSqliteToPostgres({
  databaseUrl = process.env.CASHFLOW_DATABASE_URL || "",
  dataDir = process.env.DATA_DIR || path.resolve("data"),
  dryRun = true,
  outputDir = path.resolve("external-database-exports"),
  pgModule = null,
  sourceIsSnapshot = false
} = {}) {
  if (!dryRun && !sourceIsSnapshot) {
    throw new Error("Apply mode requires --source-is-snapshot. Create a stopped-app snapshot first.");
  }

  const globalResult = createSqliteGlobalMetadataExport({ dataDir, outputDir });
  const budgetResult = await createSqliteBudgetStorageExport({ dataDir, outputDir });
  const globalPayload = readJson(globalResult.exportPath);
  const budgetPayload = readJson(budgetResult.exportPath);

  const globalDryRun = await importSqliteGlobalMetadataToPostgres({
    dryRun: true,
    payload: globalPayload
  });
  const budgetDryRun = await importSqliteBudgetStorageToPostgres({
    dryRun: true,
    payload: budgetPayload
  });

  const summary = compactSummary(
    { ...globalResult, rowCounts: globalDryRun.rowCounts },
    { ...budgetResult, rowCounts: budgetDryRun.rowCounts },
    { applied: false, dryRun: true, outputDir }
  );

  if (dryRun) return summary;
  if (!String(databaseUrl || "").trim()) {
    throw new Error("CASHFLOW_DATABASE_URL is required for apply mode");
  }

  const pg = await loadPgModule(pgModule);
  const Pool = pg.Pool || pg.default?.Pool;
  if (typeof Pool !== "function") {
    throw new Error("The pg package did not expose Pool");
  }

  const pool = new Pool({
    connectionString: databaseUrl
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const globalApplied = await importSqliteGlobalMetadataToPostgres({
      client,
      dryRun: false,
      manageTransaction: false,
      payload: globalPayload
    });
    const budgetApplied = await importSqliteBudgetStorageToPostgres({
      client,
      dryRun: false,
      manageTransaction: false,
      payload: budgetPayload
    });
    await client.query("COMMIT");

    return {
      ...summary,
      applied: true,
      dryRun: false,
      inserted: {
        global: globalApplied.inserted,
        budget: budgetApplied.inserted
      }
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function migrateSqliteToPostgresCli(options = parseArgs()) {
  if (options.help) {
    return {
      help: usage()
    };
  }

  return await migrateSqliteToPostgres(options);
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2), {
    string: ["--data-dir","--output-dir"],
    boolean: ["--source-is-snapshot","--apply","--pretty"],
    defaults: {
    apply: false,
    databaseUrl: process.env.CASHFLOW_DATABASE_URL || "",
    dataDir: process.env.DATA_DIR || path.resolve("data"),
    dryRun: true,
    outputDir: path.resolve("external-database-exports"),
    pretty: false,
    sourceIsSnapshot: false
  }
  });
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = await migrateSqliteToPostgresCli(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
