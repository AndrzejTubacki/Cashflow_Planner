#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import {
  SQLITE_GLOBAL_METADATA_EXPORT_FORMAT,
  SQLITE_GLOBAL_METADATA_EXPORT_VERSION
} from "../src/server/cashflow-postgres-global-import.js";
import {
  POSTGRES_GLOBAL_SCHEMA_VERSION,
  POSTGRES_GLOBAL_TABLES
} from "../src/server/cashflow-postgres-global-schema.js";

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dataDir: process.env.DATA_DIR || path.resolve("data"),
    outputDir: path.resolve("external-database-exports"),
    pretty: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--data-dir") {
      options.dataDir = argv[index + 1] || "";
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
  return `Usage: npm run db:global:export -- [--data-dir PATH] [--output-dir PATH] [--pretty]

Exports SQLite global metadata into a sensitive JSON migration artifact.
The command prints only a summary; the generated file contains real global rows.`;
}

function isInsidePath(child, parent) {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function rowsForTable(db, tableName) {
  if (!tableExists(db, tableName)) return [];
  return db.prepare(`SELECT * FROM ${tableName}`).all();
}

export function createSqliteGlobalMetadataExport({
  dataDir = process.env.DATA_DIR || path.resolve("data"),
  outputDir = path.resolve("external-database-exports"),
  now = new Date()
} = {}) {
  const rootDir = path.resolve(dataDir);
  const targetRoot = path.resolve(outputDir);
  const globalDbPath = path.join(rootDir, "cashflow-global.sqlite");

  if (!fs.existsSync(globalDbPath) || !fs.statSync(globalDbPath).isFile()) {
    throw new Error(`Global SQLite database not found: ${globalDbPath}`);
  }
  if (isInsidePath(targetRoot, rootDir)) {
    throw new Error("Global metadata export output directory must not be inside DATA_DIR");
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const createdAt = now.toISOString();
  const exportId = `${createdAt.replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
  const finalPath = path.join(targetRoot, `cashflow_sqlite_global_export_${exportId}.json`);
  const temporaryPath = `${finalPath}.tmp`;
  const db = new Database(globalDbPath, {
    fileMustExist: true,
    readonly: true
  });

  try {
    db.pragma("query_only = ON");
    const sqliteUserVersion = db.pragma("user_version", { simple: true });
    const tables = {};
    const rowCounts = {};

    for (const tableName of POSTGRES_GLOBAL_TABLES) {
      const rows = rowsForTable(db, tableName);
      tables[tableName] = rows;
      rowCounts[tableName] = rows.length;
    }

    const payload = {
      format: SQLITE_GLOBAL_METADATA_EXPORT_FORMAT,
      version: SQLITE_GLOBAL_METADATA_EXPORT_VERSION,
      exportedAt: createdAt,
      sourceBackend: "sqlite",
      targetBackend: "postgres",
      sourceGlobalSchemaVersion: sqliteUserVersion,
      targetGlobalSchemaVersion: POSTGRES_GLOBAL_SCHEMA_VERSION,
      containsSensitiveData: true,
      tables
    };

    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temporaryPath, finalPath);

    return {
      ok: true,
      format: SQLITE_GLOBAL_METADATA_EXPORT_FORMAT,
      version: SQLITE_GLOBAL_METADATA_EXPORT_VERSION,
      exportPath: finalPath,
      sourceGlobalSchemaVersion: sqliteUserVersion,
      targetBackend: "postgres",
      targetGlobalSchemaVersion: POSTGRES_GLOBAL_SCHEMA_VERSION,
      rowCounts,
      containsSensitiveData: true
    };
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original export error.
    }
    throw error;
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = createSqliteGlobalMetadataExport(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
