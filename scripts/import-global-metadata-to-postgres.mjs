#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { importSqliteGlobalMetadataToPostgres } from "../src/server/cashflow-postgres-global-import.js";
import {
  createGlobalStoreImportPlan
} from "../src/server/cashflow-global-store-import-plan.js";
import { POSTGRES_DRIVER_MISSING_CODE } from "../src/server/cashflow-postgres-global-db-service.js";

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    apply: false,
    databaseUrl: process.env.CASHFLOW_DATABASE_URL || "",
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
    } else if (arg === "--dry-run") {
      options.apply = false;
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
  return `Usage: npm run db:global:import-postgres -- --input PATH [--dry-run|--apply] [--database-url URL] [--pretty]

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
    throw new Error("CASHFLOW_DATABASE_URL or --database-url is required with --apply");
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
  const options = parseArgs();
  const result = await importGlobalMetadataToPostgresCli(options);
  if (result.help) {
    console.log(result.help);
    return;
  }
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
