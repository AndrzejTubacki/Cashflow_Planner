import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load optional local .env defaults before resolving runtime paths; real environment variables still win.
dotenv.config({ path: path.join(__dirname, ".env") });

// Resolve runtime paths from env so Docker/Compose can mount data and logs outside the image.
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const logsDir = process.env.LOGS_DIR || path.join(__dirname, "logs");
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

function timestampWarsaw() {
  // Format operational logs in the local deployment timezone with a real offset.
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
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
    ts: timestampWarsaw(),
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
  fs.appendFileSync(path.join(logsDir, fileName), `${line}\n`);
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

let express;

try {
  ({ default: express } = await import("express"));
} catch (error) {
  logError("express_module_load_failed", error);
  throw error;
}

const app = express();

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

let createCashflowModule;

try {
  ({ createCashflowModule } = await import("./src/cashflow.js"));
} catch (error) {
  logError("cashflow_module_load_failed", error);
  throw error;
}

const cashflow = createCashflowModule({
  appVersion,
  dataDir,
  localeDir,
  getCurrentFxSnapshot: () => null,
  getFxSnapshotForDate: null,
  logError,
  logServerEvent,
  appendApiLogLine
});

// Register every /api route supplied by the domain module.
cashflow.registerRoutes(app);

app.get("/healthz", (req, res) => {
  // Minimal liveness endpoint for Docker/reverse-proxy health checks.
  res.json({ ok: true, app: "cashflow" });
});

app.get("/api/system", (req, res) => {
  // Process diagnostics used by smoke checks, UI status, and local operations.
  res.json({
    ok: true,
    app: "cashflow",
    version: appVersion,
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
cashflow.startBackgroundJobs();

try {
  // Optional private routes live in ignored local/dev.mjs and are not part of published builds.
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

app.listen(port, "0.0.0.0", () => {
  // Bind on all interfaces for container networking.
  logServerEvent("server_start", {
    port,
    dataDir,
    logsDir,
    publicDir
  });
  console.log(`Cashflow listening on ${port}`);
});
