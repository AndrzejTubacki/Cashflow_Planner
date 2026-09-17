#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizeSqliteBudgetStorageExport
} from "../src/server/cashflow-postgres-budget-import.js";
import {
  POSTGRES_BUDGET_TABLES,
  POSTGRES_LEDGER_SCHEMA_VERSION,
  POSTGRES_PLANNING_SCHEMA_VERSION
} from "../src/server/cashflow-postgres-budget-schema.js";
import {
  normalizeSqliteGlobalMetadataExport
} from "../src/server/cashflow-postgres-global-import.js";
import {
  POSTGRES_GLOBAL_SCHEMA_VERSION,
  POSTGRES_GLOBAL_TABLES
} from "../src/server/cashflow-postgres-global-schema.js";

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    budgetExportPath: "",
    databaseUrl: process.env.CASHFLOW_DATABASE_URL || "",
    globalExportPath: "",
    pretty: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--global-export") {
      options.globalExportPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--budget-export") {
      options.budgetExportPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--database-url") {
      options.databaseUrl = argv[index + 1] || "";
      index += 1;
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
  return `Usage: npm run db:postgres:verify -- --global-export PATH --budget-export PATH [--database-url URL] [--pretty]

Compares sensitive SQLite-to-Postgres export artifacts with row counts in a Postgres destination.
The command reads only schema versions and table counts from Postgres and does not print row values.`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function quoteIdentifier(identifier) {
  const value = String(identifier || "");
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

async function loadPgModule(pgModule = null) {
  if (pgModule) return pgModule;
  try {
    return await import("pg");
  } catch (error) {
    const wrapped = new Error("Postgres verification requires the pg package to be installed");
    wrapped.cause = error;
    throw wrapped;
  }
}

function countValue(result) {
  return Number(result?.rows?.[0]?.count || 0);
}

function compareCount(mismatches, scope, table, expected, actual) {
  if (Number(expected) !== Number(actual)) {
    mismatches.push({
      actual: Number(actual),
      expected: Number(expected),
      scope,
      table
    });
  }
}

function compareSchemaValue(mismatches, field, expected, actual) {
  if (Number(expected) !== Number(actual)) {
    mismatches.push({
      actual: Number(actual),
      expected: Number(expected),
      field,
      scope: "schema"
    });
  }
}

function budgetIdsForExport(normalizedBudgetExport) {
  const ids = new Set();
  for (const source of normalizedBudgetExport.budgetSources || []) {
    if (source?.budgetId) ids.add(String(source.budgetId));
  }
  for (const row of normalizedBudgetExport.tables.settings || []) {
    if (row?.budget_id) ids.add(String(row.budget_id));
  }
  return [...ids].sort();
}

async function postgresCounts(client, {
  budgetIds,
  budgetTables = POSTGRES_BUDGET_TABLES,
  globalTables = POSTGRES_GLOBAL_TABLES
} = {}) {
  const global = {};
  const budget = {};

  const globalVersion = await client.query(
    "SELECT version FROM cashflow_global_schema_version WHERE id = 1"
  );
  const budgetVersion = await client.query(
    "SELECT planning_version, ledger_version FROM cashflow_budget_schema_version WHERE id = 1"
  );

  for (const table of globalTables) {
    global[table] = countValue(await client.query(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`
    ));
  }

  for (const table of budgetTables) {
    if (!budgetIds.length) {
      budget[table] = 0;
      continue;
    }
    budget[table] = countValue(await client.query(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)} WHERE budget_id = ANY($1::text[])`,
      [budgetIds]
    ));
  }

  return {
    budget,
    global,
    schema: {
      globalVersion: Number(globalVersion?.rows?.[0]?.version || 0),
      ledgerVersion: Number(budgetVersion?.rows?.[0]?.ledger_version || 0),
      planningVersion: Number(budgetVersion?.rows?.[0]?.planning_version || 0)
    }
  };
}

export async function verifyPostgresMigration({
  budgetExportPath,
  databaseUrl = process.env.CASHFLOW_DATABASE_URL || "",
  globalExportPath,
  pgModule = null
} = {}) {
  if (!globalExportPath) throw new Error("--global-export is required");
  if (!budgetExportPath) throw new Error("--budget-export is required");
  if (!String(databaseUrl || "").trim()) {
    throw new Error("CASHFLOW_DATABASE_URL or --database-url is required");
  }

  const globalExport = normalizeSqliteGlobalMetadataExport(readJson(globalExportPath));
  const budgetExport = normalizeSqliteBudgetStorageExport(readJson(budgetExportPath));
  const budgetIds = budgetIdsForExport(budgetExport);

  const pg = await loadPgModule(pgModule);
  const Pool = pg.Pool || pg.default?.Pool;
  if (typeof Pool !== "function") {
    throw new Error("The pg package did not expose Pool");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  try {
    const actual = await postgresCounts(client, { budgetIds });
    const mismatches = [];

    compareSchemaValue(
      mismatches,
      "globalVersion",
      POSTGRES_GLOBAL_SCHEMA_VERSION,
      actual.schema.globalVersion
    );
    compareSchemaValue(
      mismatches,
      "planningVersion",
      POSTGRES_PLANNING_SCHEMA_VERSION,
      actual.schema.planningVersion
    );
    compareSchemaValue(
      mismatches,
      "ledgerVersion",
      POSTGRES_LEDGER_SCHEMA_VERSION,
      actual.schema.ledgerVersion
    );

    for (const table of POSTGRES_GLOBAL_TABLES) {
      compareCount(mismatches, "global", table, globalExport.rowCounts[table], actual.global[table]);
    }
    for (const table of POSTGRES_BUDGET_TABLES) {
      compareCount(mismatches, "budget", table, budgetExport.rowCounts[table], actual.budget[table]);
    }

    return {
      ok: mismatches.length === 0,
      budget: {
        budgetCount: budgetIds.length,
        rowCounts: budgetExport.rowCounts
      },
      global: {
        rowCounts: globalExport.rowCounts
      },
      mismatches,
      targetBackend: "postgres",
      verified: true
    };
  } finally {
    client.release();
    await pool.end();
  }
}

export async function verifyPostgresMigrationCli(options = parseArgs()) {
  if (options.help) {
    return { help: usage() };
  }
  return await verifyPostgresMigration(options);
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await verifyPostgresMigrationCli(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
  if (!result.ok) process.exitCode = 2;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
