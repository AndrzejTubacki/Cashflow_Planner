#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { isMainModule, parseCliArgs } from "./lib/cli.mjs";

import { createPostgresBudgetStorageSchemaSql } from "../src/server/cashflow-postgres-budget-schema.js";
import { createPostgresGlobalSchemaSql } from "../src/server/cashflow-postgres-global-schema.js";


function usage() {
  return `Usage: npm run db:postgres:schema -- [--section all|global|budget] [--output PATH]

Prints the Postgres DDL used to initialize a fresh Cashflow database.
This does not connect to a database, apply the DDL, or enable Postgres runtime mode.`;
}

// Keep npm's `--` forwarding compatible with direct `node` invocation while
// rejecting section names that would otherwise produce an empty SQL file.
function parseArgs(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv, {
    defaults: { section: "all", output: "" },
    string: ["--section", "--output"]
  });
  if (!options.help && !["all", "global", "budget"].includes(options.section)) {
    throw new Error("--section must be one of: all, global, budget");
  }
  return options;
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

if (isMainModule(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
