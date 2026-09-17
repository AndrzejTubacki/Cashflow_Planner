import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const dataDir = path.resolve(argument("--data-dir") || process.env.DATA_DIR || "data");
const accountId = String(argument("--account-id") || "").trim();
const dbPath = path.join(dataDir, "cashflow-global.sqlite");
const backend = String(process.env.CASHFLOW_DB_BACKEND || "sqlite").trim().toLowerCase();

if (!["", "sqlite"].includes(backend)) {
  throw new Error("operator-admin currently supports only the SQLite runtime backend");
}

if (!accountId) {
  throw new Error("Usage: node scripts/operator-admin.mjs --data-dir <path> --account-id <existing-account-id>");
}
if (!fs.existsSync(dbPath)) {
  throw new Error(`Global database not found: ${dbPath}`);
}

const db = new Database(dbPath);
db.pragma("foreign_keys = ON");
try {
  db.transaction(() => {
    const account = db.prepare(`
      SELECT id, status
      FROM accounts
      WHERE id = ?
    `).get(accountId);
    if (!account) throw new Error(`Account not found: ${accountId}`);
    if (account.status !== "active") throw new Error(`Account is not active: ${accountId}`);

    db.prepare(`
      INSERT OR IGNORE INTO account_global_roles (
        account_id, role, granted_by_account_id, created_at
      )
      VALUES (?, 'system_admin', NULL, datetime('now'))
    `).run(accountId);
    db.prepare(`
      INSERT INTO security_audit_log (
        id, actor_account_id, action, target_type, target_id, outcome,
        details_json, created_at
      )
      VALUES (?, NULL, 'operator_grant_system_admin', 'account', ?, 'success',
        '{"source":"offline_operator_command"}', datetime('now'))
    `).run(`audit_${crypto.randomUUID()}`, accountId);
  })();
} finally {
  db.close();
}

console.log(`Granted system_admin to ${accountId}`);
