#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule, parseCliArgs } from "./lib/cli.mjs";

import { importSqliteGlobalMetadataToPostgres } from "../src/server/cashflow-postgres-global-import.js";
import {
  createGlobalStoreImportPlan
} from "../src/server/cashflow-global-store-import-plan.js";
import { POSTGRES_DRIVER_MISSING_CODE } from "../src/server/cashflow-postgres-global-db-service.js";


function usage() {
  return `Usage: npm run db:global:import-postgres -- --input PATH [--dry-run|--apply] [--pretty]

Validates a SQLite global metadata export and, with --apply, inserts it into a Postgres database.
Dry-run mode is the default and does not require a database connection.`;
}

async function loadPgModule() {
  try {
    return await import("pg");
  } catch (error) {
    const wrapped = new Error(
      "Postgres apply mode requires the pg package. Run dry-run validation without --apply, or install pg before applying."
    );
    wrapped.code = POSTGRES_DRIVER_MISSING_CODE;
    wrapped.cause = error;
    throw wrapped;
  }
}

async function applyWithPg({
  databaseUrl,
  payload
}) {
  if (!String(databaseUrl || "").trim()) {
    throw new Error("CASHFLOW_DATABASE_URL is required with --apply");
  }

  const pg = await loadPgModule();
  const Pool = pg.Pool || pg.default?.Pool;
  if (typeof Pool !== "function") {
    throw new Error("Postgres driver does not expose a Pool constructor");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    return await importSqliteGlobalMetadataToPostgres({
      client,
      dryRun: false,
      payload
    });
  } finally {
    client.release();
    await pool.end();
  }
}

export async function importGlobalMetadataToPostgresCli(options = parseArgs()) {
  if (options.help) {
    return { help: usage() };
  }
  if (!options.input) {
    throw new Error("--input is required");
  }

  const payload = JSON.parse(fs.readFileSync(path.resolve(options.input), "utf8"));
  if (!options.apply) {
    const plan = createGlobalStoreImportPlan(payload);
    const result = await importSqliteGlobalMetadataToPostgres({
      dryRun: true,
      payload
    });
    return {
      ...result,
      writeBatchCount: plan.writeBatches.length,
      writeBatches: plan.writeBatches.map(batch => ({
        rows: batch.rows.length,
        tableName: batch.tableName
      }))
    };
  }

  return applyWithPg({
    databaseUrl: options.databaseUrl,
    payload
  });
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2), {
    string: ["--input"],
    boolean: ["--apply","--pretty"],
    defaults: {
    apply: false,
    databaseUrl: process.env.CASHFLOW_DATABASE_URL || "",
    input: "",
    pretty: false
  }
  });

  if (options.apply) {
    console.error("\nWARNING: You are running a standalone migration script with --apply.");
    console.error("This will migrate only the global metadata. Your Postgres database may end up in a partially migrated state.");
    console.error("Please run 'npm run db:verify-postgres' immediately afterwards to verify consistency.");
    console.error("For safe, atomic migrations, use 'npm run db:migrate' instead.\n");
  }

  const result = await importGlobalMetadataToPostgresCli(options);
  if (result.help) {
    console.log(result.help);
    return;
  }
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
