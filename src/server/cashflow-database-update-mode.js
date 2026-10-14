const CONNECTION_URL = /\b(?:postgres(?:ql)?|mysql|mariadb):\/\/[^\s<>'"]+/gi;
const PASSWORD_ASSIGNMENT = /\b(password|passwd|pwd)\s*(?:[=:]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

export function redactDatabaseError(value) {
  return String(value?.message || value || "The schema check failed")
    .replace(CONNECTION_URL, "[database URL removed]")
    .replace(PASSWORD_ASSIGNMENT, "$1=[removed]");
}

export function resolveDatabaseUpdateReadiness(value, { logError = () => {} } = {}) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized === "ready") return "ready";
  if (normalized === "not_ready") return "not_ready";
  logError("cashflow_db_update_readiness_invalid", { value: normalized, fallback: "ready" });
  return "ready";
}

export function databaseUpdateReadinessResponse(mode, pending = []) {
  const ready = mode === "ready";
  return {
    status: ready ? 200 : 503,
    body: { ok: ready, app: "cashflow", databaseUpdateRequired: true, pending }
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character]);
}

function pathSafeMigrationName(name) {
  const value = String(name || "");
  return /^postgres-v\d+\.\d+\.\d+\.sql$/.test(value) ? value : "invalid-migration-name";
}

export function databaseUpdateNoticeHtml({ error, pending = [], polish = false } = {}) {
  const safePending = pending.map(pathSafeMigrationName);
  const psql = safePending.map(name => `psql "$CASHFLOW_DATABASE_URL" -f scripts/migrations/${name}`).join("\n") || "npm run db:migrate";
  const title = polish ? "Baza danych wymaga aktualizacji" : "Database update needed";
  const intro = polish
    ? "Baza danych musi zostać zaktualizowana, zanim Cashflow będzie mógł działać."
    : "The database needs an update before Cashflow can run.";
  const backupFailure = Boolean(error?.databaseMigrationBackupFailed);
  const backupGuidance = backupFailure
    ? `<p><strong>${polish ? "Automatyczna kopia bezpieczeństwa nie powiodła się." : "The automatic pre-migration backup failed."}</strong> ${polish ? "Operator powinien najpierw wykonać własną kopię bazy danych, a następnie uruchomić migrację." : "An operator should back up the database before running the migration."}</p><pre>CASHFLOW_DB_MIGRATION_BACKUP=false npm run db:migrate</pre>`
    : `<p>Run where Cashflow runs, with <code>CASHFLOW_DATABASE_URL</code> pointing at a user allowed to alter the tables:</p><pre>npm run db:migrate</pre><p>Or apply each pending file with psql:</p><pre>${escapeHtml(psql)}</pre>`;
  return `<!doctype html><html lang="${polish ? "pl" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>html{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:820px;margin:8vh auto;padding:0 24px;background:#f5f7fb;color:#18202a}main{background:#fff;border:1px solid #ccd3dd;border-radius:14px;padding:28px;box-shadow:0 8px 30px #0001}code,pre{font-family:ui-monospace,monospace}pre{overflow:auto;padding:14px;border-radius:8px;background:#eef1f5}li{overflow-wrap:anywhere}@media(prefers-color-scheme:dark){body{background:#11161d;color:#edf2f7}main{background:#1a212b;border-color:#394454}pre{background:#0e1319}}</style></head><body><main><h1>${title}</h1><p>${intro}</p><p><strong>${polish ? "Powód" : "Reason"}:</strong> ${escapeHtml(redactDatabaseError(error))}</p><h2>${polish ? "Oczekujące migracje" : "Pending migrations"}</h2><ul>${safePending.map(name => `<li><code>${escapeHtml(name)}</code></li>`).join("") || `<li>${polish ? "Nie udało się ustalić" : "Could not determine"}</li>`}</ul><h2>${polish ? "Jak naprawić" : "How to fix it"}</h2>${backupGuidance}<p>Container / Kubernetes:</p><pre>docker exec &lt;container&gt; npm run db:migrate\nkubectl exec deploy/&lt;name&gt; -- npm run db:migrate</pre></main></body></html>`;
}

export function createDatabaseUpdateMiddleware({ state, recheck = async () => false } = {}) {
  return async function databaseUpdateMiddleware(req, res, next) {
    if (!state.required) return next();
    const apiRequest = req.path === "/api" || req.path.startsWith("/api/");
    if (!apiRequest && await recheck()) return next();
    if (apiRequest) {
      res.status(503).json({
        error: "The database needs an update before Cashflow can run.",
        code: "CASHFLOW_DATABASE_UPDATE_REQUIRED",
        pending: state.pending
      });
      return;
    }
    const polish = /(?:^|,)\s*pl(?:-|;|,|$)/i.test(String(req.headers["accept-language"] || ""));
    res.status(503).type("html").send(databaseUpdateNoticeHtml({ error: state.error, pending: state.pending, polish }));
  };
}
