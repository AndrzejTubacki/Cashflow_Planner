#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.env.CASHFLOW_ENABLE_POSTGRES_TESTS !== "1") {
  fail("Refusing to run Postgres tests: set CASHFLOW_ENABLE_POSTGRES_TESTS=1 for the disposable test database.");
}

if (!String(process.env.CASHFLOW_DATABASE_URL || "").trim()) {
  fail("Refusing to run Postgres tests: CASHFLOW_DATABASE_URL is required.");
}

// Run one file at a time, not as a single multi-file `node --test` call:
// node runs separate test files concurrently by default, and every file
// here resets the *same* disposable database at the start/end of each of
// its own tests (see test/helpers/postgres-test-db.js), so two files
// racing that reset against each other corrupts both runs.
// Discover every guarded integration file, including new regressions, so a
// green test:postgres cannot silently omit them. Keep all files serial.
const testDirectory = new URL("../test/server/", import.meta.url);
const POSTGRES_TEST_FILES = readdirSync(testDirectory)
  .filter(name => name.endsWith(".test.js"))
  .filter(name => readFileSync(new URL(name, testDirectory), "utf8").includes("postgresRuntimeTestsEnabled"))
  .sort()
  .map(name => `test/server/${name}`);

async function runFile(file) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", file], {
      env: {
        ...process.env,
        CASHFLOW_POSTGRES_TEST_RUNNER: "1"
      },
      stdio: "inherit"
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${file} exited via signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${file} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

for (const file of POSTGRES_TEST_FILES) {
  try {
    await runFile(file);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
