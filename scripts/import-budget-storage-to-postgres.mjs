#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  importSqliteBudgetStorageToPostgres
} from "../src/server/cashflow-postgres-budget-import.js";
import {
  createBudgetStoreImportPlan
} from "../src/server/cashflow-budget-store-import-plan.js";

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    apply: false,
    databaseUrl: process.env.CASHFLOW_DATABASE_URL || "",
    dryRun: true,
    input: "",
    pretty: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      options.input = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--database-url") {
      options.databaseUrl = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--apply") {
      options.apply = true;
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && !options.input) {
    throw new Error("--input is required");
  }

  return options;
}

function usage() {
  return `Usage: npm run db:budget:import-postgres -- --input PATH [--dry-run|--apply] [--database-url URL] [--pretty]

Validates or imports a sensitive SQLite budget-storage export into the draft Postgres schema.
Dry-run mode does not connect to Postgres. Apply mode requires a Postgres driver and database URL.`;
}

async function loadPgModule() {
  try {
    return await import("pg");
  } catch (error) {
    const next = new Error("Apply mode requires the pg package to be installed");
    next.cause = error;
    throw next;
  }
}

export async function importBudgetStorageCli(options = parseArgs()) {
  if (options.help) {
    return {
      help: usage()
    };
  }

  const payload = JSON.parse(fs.readFileSync(path.resolve(options.input), "utf8"));
  if (options.dryRun) {
    const plan = createBudgetStoreImportPlan(payload);
    const result = await importSqliteBudgetStorageToPostgres({
      dryRun: true,
      payload
    });
    return {
      ...result,
      budgetCount: plan.budgetCount,
      budgetIds: plan.budgetIds,
      writeBatchCount: plan.writeBatches.length,
      writeBatches: plan.writeBatches.map(batch => ({
        budgetId: batch.budgetId,
        ledgerYear: batch.ledgerYear || null,
        rows: batch.rows.length,
        tableName: batch.tableName,
        type: batch.type
      }))
    };
  }

  if (!String(options.databaseUrl || "").trim()) {
    throw new Error("CASHFLOW_DATABASE_URL or --database-url is required for apply mode");
  }

  const pgModule = await loadPgModule();
  const Pool = pgModule.Pool || pgModule.default?.Pool;
  if (typeof Pool !== "function") {
    throw new Error("The pg package did not expose Pool");
  }

  const pool = new Pool({
    connectionString: options.databaseUrl
  });
  const client = await pool.connect();
  try {
    return await importSqliteBudgetStorageToPostgres({
      client,
      dryRun: false,
      payload
    });
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = await importBudgetStorageCli(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    if (error.details) {
      console.error(JSON.stringify({ details: error.details }));
    }
    process.exit(1);
  });
}
