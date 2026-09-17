#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCashflowDbService } from "../src/server/cashflow-db-service.js";
import { createSqliteBudgetStore } from "../src/server/cashflow-budget-store.js";
import { createSqliteGlobalStore } from "../src/server/cashflow-sqlite-global-store.js";
import {
  normalizeCashflowStorageSnapshot,
  restoreCashflowStorageSnapshot
} from "../src/server/cashflow-storage-snapshot.js";
import { createCashflowStoragePaths } from "../src/server/cashflow-storage-utils.js";

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    apply: false,
    dataDir: process.env.DATA_DIR || path.resolve("data"),
    force: false,
    input: "",
    pretty: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") {
      options.input = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--data-dir") {
      options.dataDir = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--dry-run") {
      options.apply = false;
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
  return `Usage: npm run db:postgres:import-sqlite -- --input PATH --data-dir PATH [--dry-run|--apply] [--force] [--pretty]

Validates a Postgres storage export and, with --apply, writes it into fresh
SQLite files under --data-dir. Dry-run mode is the default and does not
touch disk. --data-dir must not already contain a Cashflow global database
unless --force is also given, so this cannot silently overwrite an existing
install.`;
}

function dataDirLooksOccupied(dataDir) {
  return fs.existsSync(path.join(path.resolve(dataDir), "cashflow-global.sqlite"));
}

export async function importPostgresStorageToSqlite({
  apply = false,
  dataDir = process.env.DATA_DIR || path.resolve("data"),
  force = false,
  input = ""
} = {}) {
  if (!input) throw new Error("--input is required");

  const snapshot = normalizeCashflowStorageSnapshot(
    JSON.parse(fs.readFileSync(path.resolve(input), "utf8"))
  );

  if (!apply) {
    return {
      apply: false,
      budgetCount: snapshot.budgetCount,
      budgetIds: snapshot.budgetIds,
      ok: true,
      wouldWriteTo: path.resolve(dataDir)
    };
  }

  const resolvedDataDir = path.resolve(dataDir);
  if (!force && dataDirLooksOccupied(resolvedDataDir)) {
    throw new Error(
      `${resolvedDataDir} already has a cashflow-global.sqlite file. Refusing to overwrite an existing ` +
        "install without --force. Point --data-dir at an empty directory, or pass --force if you are " +
        "certain."
    );
  }

  const paths = createCashflowStoragePaths(resolvedDataDir);
  const dbService = createCashflowDbService({
    ledgerDbPath: paths.ledgerDbPath,
    planningDbPath: paths.planningDbPath,
    userDataDir: paths.userDataDir
  });
  const budgetStore = createSqliteBudgetStore({
    listLedgerYears: dbService.listLedgerYears,
    openLedgerDb: dbService.openLedgerDb,
    openPlanningDb: dbService.openPlanningDb
  });
  const globalStore = createSqliteGlobalStore({
    dataDir: resolvedDataDir,
    listCashflowUserIds: paths.listCashflowUserIds
  });

  const result = await restoreCashflowStorageSnapshot({
    budgetStore,
    globalStore,
    snapshot
  });

  return {
    apply: true,
    budgetCount: result.budgetCount,
    budgetIds: result.budgetIds,
    global: result.global,
    budget: result.budget,
    ok: result.ok,
    writtenTo: resolvedDataDir
  };
}

export async function importPostgresStorageToSqliteCli(options = parseArgs()) {
  if (options.help) {
    return { help: usage() };
  }
  return await importPostgresStorageToSqlite(options);
}

async function main() {
  const options = parseArgs();
  const result = await importPostgresStorageToSqliteCli(options);
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
