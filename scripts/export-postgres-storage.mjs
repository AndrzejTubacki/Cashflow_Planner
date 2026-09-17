#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPostgresBudgetStore } from "../src/server/cashflow-budget-store.js";
import { createPostgresGlobalStore } from "../src/server/cashflow-postgres-global-store.js";
import { createCashflowStorageSnapshot } from "../src/server/cashflow-storage-snapshot.js";

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    budgetIds: "",
    databaseUrl: process.env.CASHFLOW_DATABASE_URL || "",
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
    } else if (arg === "--output-dir") {
      options.outputDir = argv[index + 1] || "";
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
  return `Usage: npm run db:postgres:export -- [--budget-ids id1,id2] [--output-dir PATH] [--database-url URL] [--pretty]

Exports every account/budget/membership row plus the given budgets' planning
and ledger data from Postgres into a sensitive JSON migration artifact.
Omit --budget-ids to export every budget found in the database.
The command prints only a summary; the generated file contains real rows.`;
}

export async function exportPostgresStorage({
  budgetIds = "",
  databaseUrl = process.env.CASHFLOW_DATABASE_URL || "",
  now = new Date(),
  outputDir = path.resolve("external-database-exports")
} = {}) {
  if (!String(databaseUrl || "").trim()) {
    throw new Error("CASHFLOW_DATABASE_URL or --database-url is required");
  }

  const targetRoot = path.resolve(outputDir);
  fs.mkdirSync(targetRoot, { recursive: true });

  const budgetStore = await createPostgresBudgetStore({ databaseUrl });
  const globalStore = await createPostgresGlobalStore({ databaseUrl });
  try {
    const requestedIds = String(budgetIds || "").split(",").map(id => id.trim()).filter(Boolean);
    const resolvedBudgetIds = requestedIds.length
      ? requestedIds
      : (await globalStore.listRows("budgets")).map(row => row.id);

    const snapshot = await createCashflowStorageSnapshot({
      budgetIds: resolvedBudgetIds,
      budgetStore,
      globalStore,
      now,
      reason: "postgres_to_sqlite_migration"
    });

    const createdAt = snapshot.createdAt;
    const exportId = `${createdAt.replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
    const finalPath = path.join(targetRoot, `cashflow_postgres_storage_export_${exportId}.json`);
    const temporaryPath = `${finalPath}.tmp`;

    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      fs.renameSync(temporaryPath, finalPath);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the original write error.
      }
      throw error;
    }

    return {
      ok: true,
      budgetCount: snapshot.budgetCount,
      budgetIds: snapshot.budgetIds,
      budgetRowCounts: snapshot.budget.payload.rowCounts,
      containsSensitiveData: true,
      exportPath: finalPath,
      globalRowCounts: snapshot.global.rowCounts,
      sourceBackend: "postgres"
    };
  } finally {
    await budgetStore.close();
    await globalStore.close();
  }
}

export async function exportPostgresStorageCli(options = parseArgs()) {
  if (options.help) {
    return { help: usage() };
  }
  return await exportPostgresStorage(options);
}

async function main() {
  const options = parseArgs();
  const result = await exportPostgresStorageCli(options);
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
