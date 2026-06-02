import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  DEFAULT_FUTURE_PERIODS,
  DEFAULT_FX_BUFFER_PERCENT,
  DEFAULT_TIMEZONE
} from "./cashflow-constants.js";
import { normalizeTimezone } from "./cashflow-date-utils.js";
import {
  normalizeFxProvider,
  normalizeSupportedCurrency
} from "./cashflow-fx-provider-utils.js";

const USER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function initPragmas(db) {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
}

function normalizeUserId(value) {
  const userId = String(value || "").trim();

  if (!USER_ID_RE.test(userId) || userId.startsWith("_")) {
    throw new Error("User ID must use 1-64 letters, numbers, underscores, or hyphens.");
  }

  return userId;
}

function normalizePermissions(value) {
  const parsed = (() => {
    if (Array.isArray(value)) return value;
    try {
      return JSON.parse(String(value || "[]"));
    } catch {
      return [];
    }
  })();
  const permissions = [...new Set(parsed.map(item => String(item || "").trim()).filter(Boolean))];
  return permissions.length ? permissions : ["admin"];
}

export function createCashflowGlobalService({
  dataDir,
  listCashflowUserIds,
  normalizeLocale = value => String(value || "en"),
  openPlanningDb
}) {
  const globalDbPath = path.join(dataDir, "cashflow-global.sqlite");

  function openGlobalDb() {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(globalDbPath);
    initPragmas(db);
    db.exec(`
      PRAGMA user_version = 1;

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT '["admin"]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_selected_at TEXT
      );

      CREATE TABLE IF NOT EXISTS global_options (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ledger_currency TEXT NOT NULL DEFAULT 'PLN',
        locale TEXT NOT NULL DEFAULT 'en',
        timezone TEXT NOT NULL DEFAULT 'Europe/Warsaw',
        future_periods INTEGER NOT NULL DEFAULT ${DEFAULT_FUTURE_PERIODS},
        fx_provider TEXT NOT NULL DEFAULT 'nbp',
        fx_buffer_percent REAL NOT NULL DEFAULT ${DEFAULT_FX_BUFFER_PERCENT},
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO global_options (id, updated_at)
      VALUES (1, datetime('now'));
    `);
    return db;
  }

  function getGlobalOptions() {
    const db = openGlobalDb();
    try {
      return db.prepare("SELECT * FROM global_options WHERE id = 1").get();
    } finally {
      db.close();
    }
  }

  function ensureUserMetadata(db, userId, displayName = "") {
    const normalizedId = normalizeUserId(userId);
    const name = String(displayName || normalizedId).trim() || normalizedId;
    db.prepare(`
      INSERT INTO users (id, display_name, permissions, created_at, updated_at)
      VALUES (?, ?, '["admin"]', datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        display_name = CASE
          WHEN excluded.display_name != excluded.id THEN excluded.display_name
          ELSE users.display_name
        END,
        permissions = COALESCE(NULLIF(users.permissions, ''), '["admin"]'),
        updated_at = datetime('now')
    `).run(normalizedId, name);
    return normalizedId;
  }

  function applyDefaultsToUser(userId, options = null) {
    const defaults = options || getGlobalOptions();
    const db = openPlanningDb(userId);
    try {
      db.prepare(`
        UPDATE settings
        SET ledger_currency = ?,
            locale = ?,
            timezone = ?,
            future_periods = ?,
            fx_provider = ?,
            fx_buffer_percent = ?,
            updated_at = datetime('now')
        WHERE id = 1
          AND setup_completed = 0
      `).run(
        normalizeSupportedCurrency(defaults?.ledger_currency || "PLN"),
        normalizeLocale(defaults?.locale || "en"),
        normalizeTimezone(defaults?.timezone || DEFAULT_TIMEZONE),
        Math.max(1, Math.min(60, Number(defaults?.future_periods) || DEFAULT_FUTURE_PERIODS)),
        normalizeFxProvider(defaults?.fx_provider || "nbp"),
        Math.max(0, Math.min(100, Number(defaults?.fx_buffer_percent) || DEFAULT_FX_BUFFER_PERCENT))
      );
    } finally {
      db.close();
    }
  }

  function listUsers() {
    const db = openGlobalDb();
    try {
      const ids = new Set(["local", ...listCashflowUserIds()]);
      db.transaction(() => {
        for (const userId of ids) {
          ensureUserMetadata(db, userId);
        }
      })();

      return db.prepare(`
        SELECT id, display_name, permissions, created_at, updated_at, last_selected_at
        FROM users
        ORDER BY COALESCE(last_selected_at, created_at) DESC, id ASC
      `).all().map(row => ({
        ...row,
        permissions: normalizePermissions(row.permissions)
      }));
    } finally {
      db.close();
    }
  }

  function createUser(input = {}) {
    const userId = normalizeUserId(input.userId || input.id);
    const displayName = String(input.displayName || input.display_name || userId).trim() || userId;
    const options = getGlobalOptions();
    const db = openGlobalDb();
    try {
      const existing = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
      if (existing) {
        throw new Error("User already exists");
      }

      db.prepare(`
        INSERT INTO users (id, display_name, permissions, created_at, updated_at, last_selected_at)
        VALUES (?, ?, '["admin"]', datetime('now'), datetime('now'), datetime('now'))
      `).run(userId, displayName);
    } finally {
      db.close();
    }

    openPlanningDb(userId).close();
    applyDefaultsToUser(userId, options);
    return resolveSession(userId);
  }

  function markUserSelected(userId) {
    const db = openGlobalDb();
    try {
      const normalizedId = ensureUserMetadata(db, userId);
      db.prepare(`
        UPDATE users
        SET last_selected_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(normalizedId);
      openPlanningDb(normalizedId).close();
      return normalizedId;
    } finally {
      db.close();
    }
  }

  function resolveSession(userId = "") {
    if (!String(userId || "").trim()) {
      return {
        authenticated: false,
        userId: "",
        displayName: "",
        permissions: []
      };
    }

    const normalizedId = markUserSelected(userId);
    const db = openGlobalDb();
    try {
      const row = db.prepare(`
        SELECT id, display_name, permissions
        FROM users
        WHERE id = ?
      `).get(normalizedId);
      return {
        authenticated: true,
        userId: row?.id || normalizedId,
        displayName: row?.display_name || normalizedId,
        permissions: normalizePermissions(row?.permissions)
      };
    } finally {
      db.close();
    }
  }

  function updateGlobalOptions(updates = {}) {
    const current = getGlobalOptions();
    const safe = {
      ledger_currency: normalizeSupportedCurrency(updates.ledger_currency, current.ledger_currency || "PLN"),
      locale: normalizeLocale(updates.locale || current.locale || "en"),
      timezone: normalizeTimezone(updates.timezone || current.timezone || DEFAULT_TIMEZONE),
      future_periods: Math.max(1, Math.min(60, Number(updates.future_periods ?? current.future_periods) || DEFAULT_FUTURE_PERIODS)),
      fx_provider: normalizeFxProvider(updates.fx_provider || current.fx_provider || "nbp"),
      fx_buffer_percent: Math.max(0, Math.min(100, Number(updates.fx_buffer_percent ?? current.fx_buffer_percent) || 0))
    };

    const db = openGlobalDb();
    try {
      db.prepare(`
        UPDATE global_options
        SET ledger_currency = ?,
            locale = ?,
            timezone = ?,
            future_periods = ?,
            fx_provider = ?,
            fx_buffer_percent = ?,
            updated_at = datetime('now')
        WHERE id = 1
      `).run(
        safe.ledger_currency,
        safe.locale,
        safe.timezone,
        safe.future_periods,
        safe.fx_provider,
        safe.fx_buffer_percent
      );
    } finally {
      db.close();
    }

    return getGlobalOptions();
  }

  return {
    createUser,
    getGlobalOptions,
    listUsers,
    resolveSession,
    updateGlobalOptions
  };
}
