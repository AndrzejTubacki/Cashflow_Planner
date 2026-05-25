import express from "express";
import Database from "better-sqlite3";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCashflowModule } from "../../src/cashflow.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function defaultFxSnapshot() {
  return {
    pln: {
      currency: "PLN",
      rate: 1,
      effectiveDate: "2026-05-25",
      source: "test"
    },
    eur: {
      currency: "EUR",
      rate: 4,
      effectiveDate: "2026-05-25",
      source: "test"
    }
  };
}

function planningDbPath(dataDir, userId) {
  return path.join(dataDir, userId, "planning.sqlite");
}

function ledgerDbPath(dataDir, userId, year) {
  return path.join(dataDir, userId, `ledger_${year}.sqlite`);
}

async function createCashflowTestHarness(options = {}) {
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "cashflow-test-"));
  const dataDir = path.join(runtimeRoot, "data");
  const logsDir = path.join(runtimeRoot, "logs");
  const localeDir = path.join(repoRoot, "public", "app", "cashflow", "locales");
  const userId = options.userId || "local";
  const fxSnapshot = options.fxSnapshot || defaultFxSnapshot();

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const events = [];
  const errors = [];

  const cashflow = createCashflowModule({
    appVersion: "0.0.0-test",
    dataDir,
    localeDir,
    getCurrentFxSnapshot: () => fxSnapshot,
    getFxSnapshotForDate: () => fxSnapshot,
    logError: (kind, details) => errors.push({ kind, details }),
    logServerEvent: (kind, details) => events.push({ kind, details }),
    appendApiLogLine: () => {}
  });

  let server = null;
  let baseUrl = null;

  async function startServer() {
    if (server) return baseUrl;

    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use(express.urlencoded({ extended: true }));
    cashflow.registerRoutes(app);

    await new Promise(resolve => {
      server = app.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    return baseUrl;
  }

  async function request(pathname, requestOptions = {}) {
    const url = `${await startServer()}${pathname}`;
    const headers = {
      "x-cashflow-user-id": userId,
      ...(requestOptions.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(requestOptions.headers || {})
    };

    const response = await fetch(url, {
      ...requestOptions,
      headers,
      body: requestOptions.body === undefined
        ? undefined
        : typeof requestOptions.body === "string"
          ? requestOptions.body
          : JSON.stringify(requestOptions.body)
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;

    return {
      response,
      body
    };
  }

  async function api(pathname, requestOptions = {}) {
    const result = await request(pathname, requestOptions);

    if (!result.response.ok) {
      throw new Error(`${requestOptions.method || "GET"} ${pathname} returned ${result.response.status}: ${JSON.stringify(result.body)}`);
    }

    return result.body;
  }

  function openPlanningDb(targetUserId = userId) {
    return new Database(planningDbPath(dataDir, targetUserId));
  }

  function openLedgerDb(year, targetUserId = userId) {
    return new Database(ledgerDbPath(dataDir, targetUserId, year));
  }

  async function cleanup() {
    if (server) {
      await new Promise(resolve => server.close(resolve));
      server = null;
    }

    await rm(runtimeRoot, { recursive: true, force: true });
  }

  return {
    api,
    baseUrl: () => baseUrl,
    cashflow,
    cleanup,
    dataDir,
    errors,
    events,
    logsDir,
    openLedgerDb,
    openPlanningDb,
    request,
    startServer,
    userId
  };
}

export {
  createCashflowTestHarness,
  defaultFxSnapshot,
  ledgerDbPath,
  planningDbPath
};
