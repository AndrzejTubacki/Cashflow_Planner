import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

function hasArgument(name) {
  return process.argv.includes(name);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const dataDir = path.resolve(argument("--data-dir") || process.env.DATA_DIR || "data");
const accountId = String(argument("--account-id") || "").trim();
const actorAccountId = String(argument("--actor-account-id") || "").trim();
const dbPath = path.join(dataDir, "cashflow-global.sqlite");
const backend = String(process.env.CASHFLOW_DB_BACKEND || "sqlite").trim().toLowerCase();
const isRevoke = hasArgument("--revoke");
const isYes = hasArgument("--yes");

if (!["", "sqlite"].includes(backend)) {
  throw new Error("operator-admin currently supports only the SQLite runtime backend");
}

if (!accountId) {
  throw new Error("Usage: node scripts/operator-admin.mjs --data-dir <path> --account-id <existing-account-id> [--revoke] [--actor-account-id <id>] [--yes]");
}

if (!isYes) {
  console.log(`You are about to ${isRevoke ? "REVOKE" : "GRANT"} system_admin for account: ${accountId}`);
  console.log(`Global database: ${dbPath}`);
  console.log("Run again with --yes to confirm.");
  process.exit(0);
}

if (!fs.existsSync(dbPath)) {
  throw new Error(`Global database not found: ${dbPath}`);
}

const operatorOsUser = os.userInfo().username;
const details = JSON.stringify({
  source: "offline_operator_command",
  operator_os_user: operatorOsUser
});

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

    if (actorAccountId) {
      const actor = db.prepare(`SELECT id FROM accounts WHERE id = ?`).get(actorAccountId);
      if (!actor) throw new Error(`Actor account not found: ${actorAccountId}`);
    }

    if (isRevoke) {
      const result = db.prepare(`
        DELETE FROM account_global_roles
        WHERE account_id = ? AND role = 'system_admin'
      `).run(accountId);
      
      if (result.changes === 0) {
        console.log(`Account ${accountId} did not have system_admin role.`);
        return;
      }

      db.prepare(`
        INSERT INTO security_audit_log (
          id, actor_account_id, action, target_type, target_id, outcome,
          details_json, created_at
        )
        VALUES (?, ?, 'operator_revoke_system_admin', 'account', ?, 'success',
          ?, datetime('now'))
      `).run(`audit_${crypto.randomUUID()}`, actorAccountId || null, accountId, details);

      console.log(`Revoked system_admin from ${accountId}`);
    } else {
      const existing = db.prepare(`
        SELECT 1 FROM account_global_roles WHERE account_id = ? AND role = 'system_admin'
      `).get(accountId);

      if (existing) {
        console.log(`Account ${accountId} already has system_admin role.`);
        return;
      }

      db.prepare(`
        INSERT OR IGNORE INTO account_global_roles (
          account_id, role, granted_by_account_id, created_at
        )
        VALUES (?, 'system_admin', ?, datetime('now'))
      `).run(accountId, actorAccountId || null);

      db.prepare(`
        INSERT INTO security_audit_log (
          id, actor_account_id, action, target_type, target_id, outcome,
          details_json, created_at
        )
        VALUES (?, ?, 'operator_grant_system_admin', 'account', ?, 'success',
          ?, datetime('now'))
      `).run(`audit_${crypto.randomUUID()}`, actorAccountId || null, accountId, details);

      console.log(`Granted system_admin to ${accountId}`);
    }
  })();
} finally {
  db.close();
}
