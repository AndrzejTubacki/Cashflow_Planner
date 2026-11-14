import { inProcessFetch } from './in-process-http.js';
import express from "express";
import Database from "better-sqlite3";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCashflowModule } from "../../src/cashflow.js";
import { setTodayOverrideForTests } from "../../src/server/cashflow-date-utils.js";
import { createCashflowDbService } from "../../src/server/cashflow-db-service.js";
import { createCashflowStoragePaths } from "../../src/server/cashflow-storage-utils.js";

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
  const localeDir = path.join(repoRoot, "public-legacy", "app", "cashflow", "locales");
  const userId = options.userId || "local";
  const fxSnapshot = Object.prototype.hasOwnProperty.call(options, "fxSnapshot")
    ? options.fxSnapshot
    : defaultFxSnapshot();
  const testToday = options.today || "2026-05-20";
  const previousTestToday = setTodayOverrideForTests(testToday);

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const events = [];
  const errors = [];

  const cashflow = await createCashflowModule({
    appVersion: "0.0.0-test",
    allowStandaloneOrigins: options.allowStandaloneOrigins ?? true,
    authProviderHook: options.authProviderHook || null,
    appSnapshotReadHook: options.appSnapshotReadHook || null,
    ...(options.deviceNow ? { deviceNow: options.deviceNow } : {}),
    ...(options.sessionNow ? { sessionNow: options.sessionNow } : {}),
    backupServiceHook: options.backupServiceHook || null,
    deviceMutationHook: options.deviceMutationHook || null,
    dataDir,
    ...(options.databaseConfig ? { databaseConfig: options.databaseConfig } : {}),
    envFilePath: options.envFilePath || null,
    localeDir,
    getCurrentFxSnapshot: () => fxSnapshot,
    // Allow deterministic confirmation barriers while retaining real storage/recovery.
    getFxSnapshotForDate: Object.hasOwn(options, "getFxSnapshotForDate")
      ? options.getFxSnapshotForDate : (() => fxSnapshot),
    lockService: options.lockService || null,
    fetchImpl: options.fetchImpl || fetch,
    portabilityMutationHook: options.portabilityMutationHook || null,
    recoverableMutationHook: options.recoverableMutationHook || null,
    logError: (kind, details) => errors.push({ kind, details }),
    logServerEvent: (kind, details) => events.push({ kind, details }),
    appendApiLogLine: () => {}
  });

  if (options.initializeUser !== false) {
    // Test setup explicitly creates its actor; opening financial storage alone
    // must never bootstrap an account.
    cashflow.globalStore.transaction(repo => {
      repo.accounts.insert({ id: userId, displayName: userId });
      repo.roles.insertSystemAdmin({ accountId: userId });
      repo.budgets.insert({ id: userId, displayName: userId, createdByAccountId: userId });
      repo.memberships.insertOwner({ budgetId: userId, accountId: userId });
    });
    cashflow.getSnapshot(userId);
  }

  let server = null;
  let baseUrl = null;
  let inProcessApp = null;
  let sessionCookie = "";
  const oauthCookies = new Map();
  let csrfToken = "";

  async function startServer() {
    if (server || inProcessApp) return baseUrl;

    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use(express.urlencoded({ extended: true }));
    cashflow.registerRoutes(app);
    // Opt-in transport keeps route regressions runnable without socket access.
    if (options.inProcess === true || (options.inProcess === undefined && process.env.CASHFLOW_TEST_IN_PROCESS === '1')) {
      inProcessApp = app;
      baseUrl = 'http://cashflow.test';
      return baseUrl;
    }

    server = await new Promise(resolve => {
      const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
    });

    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
    return baseUrl;
  }

  async function request(pathname, requestOptions = {}) {
    const url = `${await startServer()}${pathname}`;
    const useSession = requestOptions.useSession === true;
    const method = String(requestOptions.method || "GET").toUpperCase();
    const headers = {
      ...(requestOptions.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(useSession && sessionCookie ? { cookie: sessionCookie } : {}),
      ...(useSession && csrfToken && !["GET", "HEAD", "OPTIONS"].includes(method)
        ? { "x-cashflow-csrf-token": csrfToken }
        : {}),
      ...(requestOptions.skipUserHeader || useSession ? {} : { "x-cashflow-user-id": userId }),
      ...(pathname.startsWith("/api/auth/providers/") && oauthCookies.size ? { cookie: [useSession ? sessionCookie : "", ...oauthCookies.values()].filter(Boolean).join("; ") } : {}),
      ...(requestOptions.headers || {})
    };

    const transport = inProcessApp ? (url, options) => inProcessFetch(inProcessApp, url, options) : fetch;
    const response = await transport(url, {
      ...requestOptions,
      useSession: undefined,
      headers,
      body: requestOptions.body === undefined
        ? undefined
        : typeof requestOptions.body === "string"
          ? requestOptions.body
          : JSON.stringify(requestOptions.body)
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const body = text
      ? contentType.includes("application/json")
        ? JSON.parse(text)
        : text
      : null;
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      for (const item of setCookie.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
        const cookie = item.trim().split(';')[0];
        const name = cookie.split('=')[0];
        if (name.startsWith('cashflow_oauth_') || name.startsWith('__Host-cashflow_oauth_')) oauthCookies.set(name, cookie);
        if (name === 'cashflow_session') sessionCookie = cookie === 'cashflow_session=' ? '' : cookie;
      }
    }
    if (body?.csrfToken) csrfToken = String(body.csrfToken);

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

  // Schema 22 keeps the ledger inside planning.sqlite; use the server's year view.
  function openLedgerDb(year, targetUserId = userId) {
    return createCashflowDbService(createCashflowStoragePaths(dataDir)).openLedgerDb(targetUserId, year);
  }

  async function cleanup() {
    if (server) {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      server = null;
    }

    // The public module does not expose budgetStore. Close its full lifecycle
    // so financial pools and runtime locks cannot survive fixture teardown.
    await cashflow.close();
    await rm(runtimeRoot, { recursive: true, force: true });
    setTodayOverrideForTests(previousTestToday);
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
    session: () => ({ cookie: sessionCookie, csrfToken }),
    startServer,
    today: testToday,
    userId
  };
}

export {
  createCashflowTestHarness,
  defaultFxSnapshot,
  ledgerDbPath,
  planningDbPath
};
