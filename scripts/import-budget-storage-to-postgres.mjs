#!/usr/bin/env node

import { ENGINE_AUDIT_HOST_OPTIONS } from "../src/engine/engine-host-capabilities.js";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule, parseCliArgs } from "./lib/cli.mjs";

import {
  importSqliteBudgetStorageToPostgres
} from "../src/server/cashflow-postgres-budget-import.js";
import {
  createBudgetStoreImportPlan
} from "../src/server/cashflow-budget-store-import-plan.js";


function usage() {
  return `Usage: npm run db:budget:import-postgres -- --input PATH [--dry-run|--apply] [--pretty]

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

/** Validate or apply with a host-selected audit codec; payload fields cannot
 * enable support for an origin that the executing host does not understand. */
export async function importBudgetStorageCli(options = parseArgs()) {
  if (options.help) {
    return {
      help: usage()
    };
  }

  const payload = JSON.parse(fs.readFileSync(path.resolve(options.input), "utf8"));
  if (options.dryRun) {
    const result = await importSqliteBudgetStorageToPostgres({
      dryRun: true,
      allowStandaloneOrigins: options.allowStandaloneOrigins ?? false,
      payload
    });
    // Validation above includes the complete audit replay before previewing
    // the underlying planning/ledger batches of a v2 migration artifact.
    const plan = createBudgetStoreImportPlan(payload.format === 'cashflow-budget-store-snapshot' ? payload.payload : payload);
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
    throw new Error("CASHFLOW_DATABASE_URL is required for apply mode");
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
      allowStandaloneOrigins: options.allowStandaloneOrigins ?? false,
      payload
    });
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2), {
    string: ["--input"],
    boolean: ["--apply","--pretty"],
    defaults: {
    // The installed CLI supports the same financial format as engine 0.4.
    ...ENGINE_AUDIT_HOST_OPTIONS,
    apply: false,
    databaseUrl: process.env.CASHFLOW_DATABASE_URL || "",
    dryRun: true,
    input: "",
    pretty: false
  }
  });
  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.apply) {
    console.error("\nWARNING: You are running a standalone migration script with --apply.");
    console.error("This will migrate only the budget data. Your Postgres database may end up in a partially migrated state.");
    console.error("Please run 'npm run db:verify-postgres' immediately afterwards to verify consistency.");
    console.error("For safe, atomic migrations, use 'npm run db:migrate' instead.\n");
  }

  const result = await importBudgetStorageCli(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    if (error.details) {
      console.error(JSON.stringify({ details: error.details }));
    }
    process.exit(1);
  });
}
