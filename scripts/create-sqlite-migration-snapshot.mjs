#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { auditSqliteStorage } from "./storage-migration-audit.mjs";

const SNAPSHOT_FORMAT = "cashflow-sqlite-migration-snapshot";
const SNAPSHOT_VERSION = 1;

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dataDir: process.env.DATA_DIR || path.resolve("data"),
    outputDir: path.resolve("external-migration-snapshots"),
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
  return `Usage: npm run db:snapshot -- [--data-dir PATH] [--output-dir PATH] [--pretty]

Creates a verified SQLite migration snapshot outside DATA_DIR by default.
The snapshot contains database copies and must be treated as sensitive.`;
}

function isInsidePath(child, parent) {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

function databaseFiles(rootDir) {
  const files = [];
  const globalPath = path.join(rootDir, "cashflow-global.sqlite");
  if (fs.existsSync(globalPath) && fs.statSync(globalPath).isFile()) {
    files.push({
      kind: "global",
      sourcePath: globalPath,
      relativePath: "cashflow-global.sqlite"
    });
  }

  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return files;

  const budgetEntries = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of budgetEntries) {
    const budgetDir = path.join(rootDir, entry.name);
    const planningPath = path.join(budgetDir, "planning.sqlite");
    if (fs.existsSync(planningPath) && fs.statSync(planningPath).isFile()) {
      files.push({
        kind: "planning",
        storageKey: entry.name,
        sourcePath: planningPath,
        relativePath: path.join(entry.name, "planning.sqlite")
      });
    }

    const ledgers = fs.readdirSync(budgetDir, { withFileTypes: true })
      .filter(child => child.isFile() && /^ledger_\d{4}\.sqlite$/.test(child.name))
      .map(child => child.name)
      .sort();

    for (const fileName of ledgers) {
      files.push({
        kind: "ledger",
        storageKey: entry.name,
        ledgerYear: fileName.match(/^ledger_(\d{4})\.sqlite$/)?.[1] || null,
        sourcePath: path.join(budgetDir, fileName),
        relativePath: path.join(entry.name, fileName)
      });
    }
  }

  return files;
}

function readDatabaseInfo(dbPath) {
  const db = new Database(dbPath, {
    readonly: true,
    fileMustExist: true
  });

  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    const userVersion = db.pragma("user_version", { simple: true });
    if (integrity !== "ok") {
      throw new Error(`SQLite integrity check failed for ${path.basename(dbPath)}: ${integrity}`);
    }
    return {
      userVersion,
      sizeBytes: fs.statSync(dbPath).size
    };
  } finally {
    db.close();
  }
}

function vacuumCopy(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const sourceInfo = readDatabaseInfo(sourcePath);
  const db = new Database(sourcePath, {
    fileMustExist: true
  });

  try {
    db.prepare("VACUUM INTO ?").run(destinationPath);
  } finally {
    db.close();
  }

  const copiedInfo = readDatabaseInfo(destinationPath);
  if (copiedInfo.userVersion !== sourceInfo.userVersion) {
    throw new Error(
      `SQLite snapshot version mismatch for ${path.basename(sourcePath)}: `
        + `source=${sourceInfo.userVersion}, copy=${copiedInfo.userVersion}`
    );
  }

  return {
    sourceUserVersion: sourceInfo.userVersion,
    copiedUserVersion: copiedInfo.userVersion,
    sourceSizeBytes: sourceInfo.sizeBytes,
    copiedSizeBytes: copiedInfo.sizeBytes
  };
}

export function createSqliteMigrationSnapshot({
  dataDir = process.env.DATA_DIR || path.resolve("data"),
  outputDir = path.resolve("external-migration-snapshots"),
  now = new Date()
} = {}) {
  const rootDir = path.resolve(dataDir);
  const targetRoot = path.resolve(outputDir);

  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`DATA_DIR does not exist or is not a directory: ${rootDir}`);
  }
  if (isInsidePath(targetRoot, rootDir)) {
    throw new Error("Migration snapshot output directory must not be inside DATA_DIR");
  }

  const files = databaseFiles(rootDir);
  if (!files.length) {
    throw new Error(`No Cashflow SQLite databases found under DATA_DIR: ${rootDir}`);
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  const createdAt = now.toISOString();
  const snapshotId = `${createdAt.replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
  const finalPath = path.join(targetRoot, `cashflow_sqlite_migration_snapshot_${snapshotId}`);
  const temporaryPath = `${finalPath}.tmp`;
  const copiedFiles = [];

  try {
    fs.mkdirSync(temporaryPath, { recursive: false });

    for (const file of files) {
      const destinationPath = path.join(temporaryPath, file.relativePath);
      const copy = vacuumCopy(file.sourcePath, destinationPath);
      copiedFiles.push({
        kind: file.kind,
        storageKey: file.storageKey || null,
        ledgerYear: file.ledgerYear || null,
        relativePath: file.relativePath,
        ...copy
      });
    }

    const audit = auditSqliteStorage({
      dataDir: temporaryPath,
      includeIdentifiers: true,
      now
    });
    const manifest = {
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      status: "completed",
      createdAt,
      completedAt: new Date().toISOString(),
      sourceBackend: "sqlite",
      sourceDataDir: rootDir,
      copiedFiles,
      audit
    };

    fs.writeFileSync(
      path.join(temporaryPath, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    fs.renameSync(temporaryPath, finalPath);

    return {
      ok: true,
      format: SNAPSHOT_FORMAT,
      version: SNAPSHOT_VERSION,
      snapshotPath: finalPath,
      filesCopied: copiedFiles.length,
      budgets: audit.totals.budgets,
      planningDbs: audit.totals.planningDbs,
      ledgerDbs: audit.totals.ledgerDbs,
      confirmedRows: audit.totals.confirmedRows,
      containsSensitiveData: true
    };
  } catch (error) {
    for (const partialPath of [temporaryPath, finalPath]) {
      try {
        fs.rmSync(partialPath, { recursive: true, force: true });
      } catch {
        // Preserve the original snapshot error.
      }
    }
    throw error;
  }
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }

  const result = createSqliteMigrationSnapshot(options);
  console.log(JSON.stringify(result, null, options.pretty ? 2 : 0));
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
