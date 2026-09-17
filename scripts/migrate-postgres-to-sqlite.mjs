#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exportPostgresStorage } from "./export-postgres-storage.mjs";
import { importPostgresStorageToSqlite } from "./import-postgres-storage-to-sqlite.mjs";

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    budgetIds: "",
    databaseUrl: process.env.CASHFLOW_DATABASE_URL || "",
    dataDir: process.env.DATA_DIR || path.resolve("data"),
    dryRun: true,
    force: false,
    outputDir: path.resolve("external-database-exports"),
    pretty: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--budget-ids") {
      options.budgetIds = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--database-url") {
      options.databaseUrl = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--data-dir") {
      options.dataDir = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--output-dir") {
      options.outputDir = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--apply") {
      options.dryRun = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
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
  return `Usage: npm run db:migrate:postgres-to-sqlite -- --data-dir PATH [--dry-run|--apply] [--force] [--budget-ids id1,id2] [--output-dir PATH] [--database-url URL] [--pretty]

Exports account/budget/membership metadata and the given budgets' planning
and ledger data from Postgres, then writes it into fresh SQLite files under
--data-dir. Omit --budget-ids to migrate every budget found in the database.
Dry-run (the default) connects to Postgres and reports what would be
written, without touching --data-dir. Apply mode requires --data-dir to be
empty (no existing cashflow-global.sqlite) unless --force is also given.`;
}

export async function migratePostgresToSqlite({
  budgetIds = "",
  databaseUrl = process.env.CASHFLOW_DATABASE_URL || "",
  dataDir = process.env.DATA_DIR || path.resolve("data"),
  dryRun = true,
  force = false,
  outputDir = path.resolve("external-database-exports")
} = {}) {
  const exportResult = await exportPostgresStorage({
    budgetIds,
    databaseUrl,
    outputDir
  });

  const importResult = await importPostgresStorageToSqlite({
    apply: !dryRun,
    dataDir,
    force,
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
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = await migratePostgresToSqliteCli(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
