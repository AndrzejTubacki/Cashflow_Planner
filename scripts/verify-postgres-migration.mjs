#!/usr/bin/env node

import { ENGINE_AUDIT_HOST_OPTIONS } from "../src/engine/engine-host-capabilities.js";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from 'node:util';
import { normalizeBudgetStoreSnapshot } from '../src/server/cashflow-budget-store-snapshot.js';
import { createLedgerAuditStore } from '../src/server/cashflow-ledger-audit-store.js';
import { normalizeLedgerAuditFact } from '../src/server/cashflow-ledger-correction-service.js';

import { isMainModule, parseCliArgs } from "./lib/cli.mjs";

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


function usage() {
  return `Usage: npm run db:postgres:verify -- --global-export PATH --budget-export PATH [--pretty]

Compares sensitive SQLite-to-Postgres export artifacts with row counts and retained audit evidence.
The command is read-only and does not print row values or audit contents.`;
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

/** Compare retained financial proof as well as counts. Origin semantics are a
 * calling-host policy and cannot be requested by imported artifact fields. */
export async function verifyPostgresMigration({
  budgetExportPath,
  databaseUrl = process.env.CASHFLOW_DATABASE_URL || "",
  globalExportPath,
  allowStandaloneOrigins = false,
  pgModule = null
} = {}) {
  if (!globalExportPath) throw new Error("--global-export is required");
  if (!budgetExportPath) throw new Error("--budget-export is required");
  if (!String(databaseUrl || "").trim()) {
    throw new Error("CASHFLOW_DATABASE_URL is required");
  }

  const globalExport = normalizeSqliteGlobalMetadataExport(readJson(globalExportPath));
  const artifact = readJson(budgetExportPath);
  const snapshot = artifact.format === 'cashflow-budget-store-snapshot' ? normalizeBudgetStoreSnapshot(artifact, { allowStandaloneOrigins }) : null;
  const budgetExport = snapshot?.payload || normalizeSqliteBudgetStorageExport(artifact);
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
    // Counts cannot reveal a missing original, changed review or blocked event.
    // Verify the complete chain against actual destination facts without
    // returning financial rows or historical actor identities in summaries.
    for (const budgetId of snapshot?.budgetIds || []) {
      const expected = (snapshot.ledgerAudits || []).find(audit => audit.budgetId === budgetId) || null;
      const query = async (sql, values = []) => {
        let index = 0;
        return (await client.query(sql.replace(/\?/g, () => `$${++index}`), values)).rows;
      };
      try {
        const state = await query('SELECT budget_id FROM cashflow_ledger_audit_state WHERE budget_id = ?', [budgetId]);
        const retained = state.length ? await createLedgerAuditStore({ budgetId, query, allowStandaloneOrigins,
          loadEffectiveRows: async () => (await query('SELECT *, date::text AS date, confirmed_date::text AS confirmed_date FROM confirmed_transactions WHERE budget_id = ?', [budgetId]))
            .map(row => normalizeLedgerAuditFact(row, budgetId)) }).exportSnapshot() : null;
        if (!isDeepStrictEqual(retained, expected)) {
          mismatches.push({ scope: 'ledger-audit', budgetId, reason: 'retained_evidence_differs' });
        }
      } catch {
        mismatches.push({ scope: 'ledger-audit', budgetId, reason: 'invalid_retained_evidence' });
      }
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

/** Map documented CLI names to the programmatic path options. Keep direct
 * callers' explicit paths intact and preserve verification's read-only scope. */
export async function verifyPostgresMigrationCli(options = parseArgs()) {
  if (options.help) {
    return { help: usage() };
  }
  return await verifyPostgresMigration({ ...options,
    globalExportPath: options.globalExportPath || options.globalExport,
    budgetExportPath: options.budgetExportPath || options.budgetExport });
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2), {
    string: ["--global-export","--budget-export"],
    boolean: ["--pretty"],
    defaults: {
    // The installed CLI supports the same financial format as engine 0.4.
    ...ENGINE_AUDIT_HOST_OPTIONS,
    budgetExportPath: "",
    databaseUrl: process.env.CASHFLOW_DATABASE_URL || "",
    globalExportPath: "",
    pretty: false
  }
  });
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await verifyPostgresMigrationCli(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
  if (!result.ok) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
