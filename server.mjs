import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { DEFAULT_TIMEZONE } from "./src/server/cashflow-constants.js";
import { normalizeTimezone } from "./src/server/cashflow-date-utils.js";
import {
  assertCashflowDatabaseUrlConfigured,
  assertCashflowDbBackendSupported,
  resolveCashflowDbConfig
} from "./src/server/cashflow-db-config.js";
import {
  createCashflowRuntimeLockService
} from "./src/server/cashflow-runtime-lock-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load optional local .env defaults before resolving runtime paths; real environment variables still win.
dotenv.config({ path: path.join(__dirname, ".env") });

// Resolve runtime paths from env so Docker/Compose can mount data and logs outside the image.
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const logsDir = process.env.LOGS_DIR || path.join(__dirname, "logs");
const logTimezone = normalizeTimezone(process.env.CASHFLOW_LOG_TIMEZONE || DEFAULT_TIMEZONE);
const jsonLimit = process.env.CASHFLOW_JSON_LIMIT || "10mb";
const mirrorLogsToStdout = enabledByEnv(process.env.CASHFLOW_MIRROR_LOGS_TO_STDOUT);
const readyzCheckDefaultBudget = enabledByEnv(process.env.CASHFLOW_READYZ_CHECK_DEFAULT_BUDGET);
const databaseConfig = resolveCashflowDbConfig(process.env);
const publicDir = path.join(__dirname, "public");
const localeDir = path.join(publicDir, "app", "cashflow", "locales");
const startedAt = new Date();

// package.json is the canonical app version; APIs expose it for UI/build diagnostics.
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const appVersion = packageJson.version || "0.0.0";

// Shared mutable process state used by optional local-only developer routes.
const runtime = {
  restartInProgress: false
};

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });

function enabledByEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function timestampForLogs() {
  // Format operational logs in the configured deployment timezone with a real offset.
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: logTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMinutes = Math.round((localAsUtc - now.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
  const offsetRemainder = String(absoluteOffset % 60).padStart(2, "0");

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${offsetHours}:${offsetRemainder}`;
}

function toLogPayload(kind, details = {}) {
  // Normalize Error objects and plain metadata into one JSON-lines log shape.
  const payload = {
    ts: timestampForLogs(),
    kind
  };

  if (details instanceof Error) {
    payload.message = details.message;
    payload.stack = details.stack;
  } else if (details && typeof details === "object") {
    Object.assign(payload, details);
  } else if (details !== undefined) {
    payload.message = String(details);
  }

  return payload;
}

function appendLog(fileName, line) {
  // Append one JSON/text line to the configured logs directory.
  const text = String(line);
  fs.appendFileSync(path.join(logsDir, fileName), `${text}\n`);
  if (mirrorLogsToStdout) {
    if (fileName === "error.log") {
      console.error(text);
    } else {
      console.log(text);
    }
  }
}

function logServerEvent(kind, details = {}) {
  // Record expected lifecycle and background-job events.
  appendLog("server-events.log", JSON.stringify(toLogPayload(kind, details)));
}

function logError(kind, details = {}) {
  // Record failures in a separate log so operational checks can scan it cheaply.
  appendLog("error.log", JSON.stringify(toLogPayload(kind, details)));
}

function appendApiLogLine(line) {
  // Preserve route-level API audit lines emitted by the Cashflow module.
  appendLog("api.log", String(line));
}

logServerEvent("server_entry", { port, dataDir, logsDir, publicDir });

try {
  assertCashflowDbBackendSupported(databaseConfig);
  assertCashflowDatabaseUrlConfigured(databaseConfig);
} catch (error) {
  logError("cashflow_database_backend_unsupported", {
    backend: databaseConfig.backend,
    databaseUrlConfigured: databaseConfig.databaseUrlConfigured,
    error: error.message
  });
  throw error;
}

let express;
let helmet;
let rateLimit;

try {
  ({ default: express } = await import("express"));
} catch (error) {
  logError("express_module_load_failed", error);
  throw error;
}

try {
  ({ default: helmet } = await import("helmet"));
} catch (error) {
  logServerEvent("optional_helmet_unavailable", { message: error.message });
  helmet = null;
}

try {
  ({ default: rateLimit } = await import("express-rate-limit"));
} catch (error) {
  logServerEvent("optional_rate_limit_unavailable", { message: error.message });
  rateLimit = null;
}

const app = express();

app.disable("x-powered-by");
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: false
  }));
}
app.use(express.json({ limit: jsonLimit }));
app.use(express.urlencoded({ extended: true }));
if (rateLimit) {
  app.use("/api/auth/internal", rateLimit({
    legacyHeaders: false,
    limit: 20,
    standardHeaders: "draft-8",
    windowMs: 15 * 60 * 1000
  }));
}

let createCashflowModule;

try {
  ({ createCashflowModule } = await import("./src/cashflow.js"));
} catch (error) {
  logError("cashflow_module_load_failed", error);
  throw error;
}

const runtimeLockRuntime = await createCashflowRuntimeLockService({
  env: process.env,
  logError,
  logServerEvent
});

let cashflow;
try {
  cashflow = await createCashflowModule({
    appVersion,
    dataDir,
    databaseConfig,
    localeDir,
    getCurrentFxSnapshot: () => null,
    getFxSnapshotForDate: null,
    lockService: runtimeLockRuntime.lockService,
    logError,
    logServerEvent,
    appendApiLogLine
  });
} catch (error) {
  logError("cashflow_module_init_failed", {
    backend: databaseConfig.backend,
    databaseUrlConfigured: databaseConfig.databaseUrlConfigured,
    error: error.message
  });
  throw error;
}

// Register every /api route supplied by the domain module.
cashflow.registerRoutes(app);

app.get("/healthz", (req, res) => {
  // Minimal liveness endpoint for Docker/reverse-proxy health checks.
  res.json({ ok: true, app: "cashflow" });
});

function checkDataDirWritable() {
  const tempPath = path.join(
    dataDir,
    `.cashflow-readyz-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  );
  fs.writeFileSync(tempPath, "ready\n", "utf8");
  fs.rmSync(tempPath, { force: true });
}

app.get("/readyz", async (req, res) => {
  // Cheap readiness check for any process manager; this is intentionally not a full data integrity scan.
  const checks = [];

  async function runCheck(name, fn) {
    try {
      const details = await fn();
      checks.push({ name, ok: true, ...(details && typeof details === "object" ? { details } : {}) });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        error: error?.message || String(error)
      });
    }
  }

  await runCheck("app_initialized", () => {
    if (!cashflow || typeof cashflow.readinessCheck !== "function") {
      throw new Error("Cashflow module is not initialized");
    }
  });
  await runCheck("data_dir_exists", () => {
    if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
      throw new Error("DATA_DIR does not exist or is not a directory");
    }
  });
  await runCheck("data_dir_writable", () => {
    checkDataDirWritable();
  });
  await runCheck("global_metadata", () => cashflow.readinessCheck({
    checkDefaultBudget: readyzCheckDefaultBudget
  }));

  const ok = checks.every(check => check.ok);
  res.status(ok ? 200 : 503).json({
    ok,
    app: "cashflow",
    checks
  });
});

app.get("/api/system", (req, res) => {
  // Process diagnostics used by smoke checks, UI status, and local operations.
  res.json({
    ok: true,
    app: "cashflow",
    version: appVersion,
    databaseBackend: databaseConfig.backend,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: startedAt.toISOString(),
    now: new Date().toISOString(),
    restarting: runtime.restartInProgress
  });
});

// Serve the static browser app after API routes so /api/* never falls through to HTML.
app.use(express.static(publicDir));

app.use((req, res, next) => {
  // SPA fallback: direct navigation to app paths should return index.html.
  if (req.method !== "GET" || req.path.startsWith("/api/")) {
    next();
    return;
  }

  res.sendFile(path.join(publicDir, "index.html"));
});

// Start scheduled projection, FX, notification, and backup jobs.
const backgroundInterval = cashflow.startBackgroundJobs();

try {
  // Optional operator-owned routes live in ignored local/dev.mjs and remain outside published APIs.
  const localDev = await import("./local/dev.mjs");
  if (typeof localDev.registerLocalDevRoutes === "function") {
    localDev.registerLocalDevRoutes(app, {
      logServerEvent,
      runtime
    });
  }
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") {
    logError("local_restart_control_load_failed", error);
  }
}

const server = app.listen(port, "0.0.0.0", () => {
  // Bind on all interfaces for container networking.
  logServerEvent("server_start", {
    port,
    dataDir,
    logsDir,
    databaseBackend: databaseConfig.backend,
    publicDir
  });
  console.log(`Cashflow listening on ${port}`);
});

let shutdownStarted = false;

function closeServer() {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  runtime.restartInProgress = true;

  logServerEvent("server_shutdown_requested", { signal });
  clearInterval(backgroundInterval);

  const forceExitTimer = setTimeout(() => {
    logError("server_shutdown_timeout", { signal });
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref?.();

  try {
    await closeServer();
    await runtimeLockRuntime.close();
    clearTimeout(forceExitTimer);
    logServerEvent("server_shutdown_complete", { signal });
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    logError("server_shutdown_failed", error);
    process.exit(1);
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
