#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPostgresBudgetStorageSchemaSql } from "../src/server/cashflow-postgres-budget-schema.js";
import { createPostgresGlobalSchemaSql } from "../src/server/cashflow-postgres-global-schema.js";

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    output: "",
    section: "all"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") {
      options.output = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--section") {
      options.section = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["all", "global", "budget"].includes(options.section)) {
    throw new Error("--section must be one of: all, global, budget");
  }

  return options;
}

function usage() {
  return `Usage: npm run db:postgres:schema -- [--section all|global|budget] [--output PATH]

Prints the draft Postgres DDL used for external database migration planning.
This does not connect to a database or enable Postgres runtime mode.`;
}

export function postgresSchemaSql({ section = "all" } = {}) {
  const parts = [];
  if (section === "all" || section === "global") {
    parts.push([
      "-- Cashflow global metadata schema",
      createPostgresGlobalSchemaSql({ includeTransaction: true }).trim()
    ].join("\n"));
  }
  if (section === "all" || section === "budget") {
    parts.push([
      "-- Cashflow budget planning and ledger schema",
      createPostgresBudgetStorageSchemaSql({ includeTransaction: true }).trim()
    ].join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

export function printPostgresSchemaCli(options = parseArgs()) {
  if (options.help) {
    return {
      help: usage()
    };
  }

  const sql = postgresSchemaSql({ section: options.section });
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, sql, "utf8");
    return {
      ok: true,
      outputPath,
      section: options.section
    };
  }

  return {
    sql
  };
}

async function main() {
  const result = printPostgresSchemaCli();
  if (result.help) {
    console.log(result.help);
    return;
  }
  if (result.sql) {
    process.stdout.write(result.sql);
    return;
  }
  console.log(JSON.stringify(result));
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
