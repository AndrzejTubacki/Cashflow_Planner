#!/usr/bin/env node

import { ENGINE_AUDIT_HOST_OPTIONS } from "../src/engine/engine-host-capabilities.js";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule, parseCliArgs } from "./lib/cli.mjs";

import { exportPostgresStorage } from "./export-postgres-storage.mjs";
import { importPostgresStorageToSqlite } from "./import-postgres-storage-to-sqlite.mjs";


function usage() {
  return `Usage: npm run db:migrate:postgres-to-sqlite -- --data-dir PATH [--dry-run|--apply] [--force] [--budget-ids id1,id2] [--output-dir PATH] [--pretty]

Exports account/budget/membership metadata and the given budgets' planning
and ledger data from Postgres, then writes it into fresh SQLite files under
--data-dir. Omit --budget-ids to migrate every budget found in the database.
Dry-run (the default) connects to Postgres and reports what would be
written, without touching --data-dir. Apply mode requires --data-dir to be
empty (no existing cashflow-global.sqlite) unless --force is also given.`;
}

/** Export and stage a fresh SQLite return. The host chooses supported origin
 * semantics consistently for both halves; artifacts cannot enable the policy. */
export async function migratePostgresToSqlite({
  budgetIds = "",
  databaseUrl = process.env.CASHFLOW_DATABASE_URL || "",
  dataDir = process.env.DATA_DIR || path.resolve("data"),
  dryRun = true,
  force = false,
  allowStandaloneOrigins = false,
  outputDir = path.resolve("external-database-exports")
} = {}) {
  const exportResult = await exportPostgresStorage({
    budgetIds,
    databaseUrl,
    allowStandaloneOrigins,
    outputDir
  });

  const importResult = await importPostgresStorageToSqlite({
    apply: !dryRun,
    dataDir,
    force,
    allowStandaloneOrigins,
    input: exportResult.exportPath
  });

  return {
    apply: importResult.apply,
    artifacts: {
      exportPath: exportResult.exportPath
    },
    budgetCount: exportResult.budgetCount,
    budgetIds: exportResult.budgetIds,
    dryRun: !importResult.apply,
    global: importResult.global || null,
    budget: importResult.budget || null,
    ok: exportResult.ok && importResult.ok,
    sourceBackend: "postgres",
    targetDataDir: importResult.writtenTo || importResult.wouldWriteTo
  };
}

export async function migratePostgresToSqliteCli(options = parseArgs()) {
  if (options.help) {
    return { help: usage() };
  }
  return await migratePostgresToSqlite(options);
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2), {
    string: ["--database-url","--budget-ids","--data-dir","--output-dir"],
    boolean: ["--apply","--force","--pretty"],
    defaults: {
    // The installed CLI supports the same financial format as engine 0.4.
    ...ENGINE_AUDIT_HOST_OPTIONS,
    budgetIds: "",
    databaseUrl: process.env.CASHFLOW_DATABASE_URL || "",
    dataDir: process.env.DATA_DIR || path.resolve("data"),
    dryRun: true,
    force: false,
    outputDir: path.resolve("external-database-exports"),
    pretty: false
  }
  });
  if (options.help) {
    console.log(usage());
    return;
  }
  // --apply is the documented switch; without this the run stays a dry run.
  options.dryRun = !options.apply;

  const result = await migratePostgresToSqliteCli(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
