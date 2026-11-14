import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { backupDraft, backupPermissions, stricterBackupPolicy, backupSettings, newestBackups, restoreSelectedBackup } from "../frontend-beta/src/backups.js";
import { capabilitiesFor } from "../src/server/cashflow-authorization.js";
import { setLocale } from "../frontend-beta/src/i18n.js";

const source = file => readFile(new URL(`../frontend-beta/src/${file}`, import.meta.url), "utf8");

test("backup permissions mirror actual server roles, including administrators without ownership", () => {
  for (const role of ["viewer", "editor", "manager", "owner", ""]) {
    for (const globalRoles of [[], ["system_admin"]]) {
      const result = backupPermissions({ session: { capabilities: capabilitiesFor({ budgetRole: role, globalRoles }) } });
      assert.deepEqual(result, { settings: role === "owner", create: role === "owner", restore: role === "owner" });
    }
  }
  assert.deepEqual(backupPermissions({ session: { capabilities: ["budget:backup"] } }), { settings: false, create: true, restore: false });
  assert.deepEqual(backupPermissions(null), { settings: false, create: false, restore: false });
});

test("backup drafts preserve existing intervals and convert friendly units to minutes", () => {
  for (const minutes of [1, 59, 60, 61, 120, 1440, 2880]) {
    const draft = backupDraft({ backup_interval_minutes: minutes, backup_retention_count: 7, auto_backup_enabled: 1 });
    assert.equal(backupSettings(draft, "sqlite").backup_interval_minutes, minutes);
  }
  assert.equal(backupDraft().unit, 1440);
  const draft = { enabled: true, interval: "2", unit: 60, retention: "3", location: " /allowed/path " };
  assert.deepEqual(backupSettings(draft, "sqlite"), { auto_backup_enabled: 1, backup_interval_minutes: 120, backup_retention_count: 3, backup_location: "/allowed/path" });
  for (const backend of ["postgres", ""]) assert.equal(Object.hasOwn(backupSettings(draft, backend), "backup_location"), false);
  assert.equal(backupSettings({ ...draft, location: " " }, "sqlite").backup_location, null);
  // Invalid input reaches server validation rather than silently becoming a valid default.
  assert.equal(backupSettings({ ...draft, interval: "0", retention: "0" }, "sqlite").backup_interval_minutes, 0);
});

test("backup list orders API metadata newest first without mutating its input", () => {
  const rows = [{ id: "old", createdAt: "2026-01-01T00:00:00Z" }, { id: "new", createdAt: "2026-02-01T00:00:00Z" }];
  assert.deepEqual(newestBackups(rows).map(row => row.id), ["new", "old"]);
  assert.equal(rows[0].id, "old");
});

test("restore cancellation never posts, confirmation names scope and safety backup, success refreshes", async () => {
  setLocale("en");
  const calls = [];
  const dependencies = {
    confirm: message => { calls.push(["confirm", message]); return false; },
    request: async (...args) => calls.push(["post", ...args]),
    refresh: async () => calls.push(["refresh"])
  };
  assert.equal(await restoreSelectedBackup({ id: "backup/id" }, dependencies), false);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /backup\/id.*settings, planning data, and ledger.*safety backup/s);
  dependencies.confirm = () => true;
  assert.equal(await restoreSelectedBackup({ id: "backup/id" }, dependencies), true);
  assert.deepEqual(calls.slice(1), [["post", "/api/restore/backup%2Fid", { method: "POST" }], ["refresh"]]);
});

test("restore errors propagate to the panel and never trigger a success refresh", async () => {
  let refreshed = false;
  await assert.rejects(restoreSelectedBackup({ id: "missing" }, {
    confirm: () => true, request: async () => { throw new Error("Backup not found"); }, refresh: async () => { refreshed = true; }
  }), /Backup not found/);
  assert.equal(refreshed, false);
});

test("React settings wire permission-gated backup controls, backend hints, busy states and save errors", async () => {
  const [panel, settings, page] = await Promise.all([source("BackupsPanel.jsx"), source("SettingsView.jsx"), source("SettingsPage.jsx")]);
  assert.match(panel, /if \(!visible\) return null/);
  assert.match(panel, /permissions\.restore \? apiFetch\("\/api\/backups"/);
  assert.match(panel, /permissions\.settings \?/);
  assert.match(panel, /permissions\.create \?/);
  assert.match(panel, /backend === "sqlite" \? <label/);
  assert.match(panel, /retention follows the budget count and administrator limits/);
  assert.match(panel, /disabled=\{Boolean\(busy\)\}/);
  assert.match(panel, /restoreSelectedBackup\(backup/);
  assert.match(panel, /role="alert"/);
  assert.match(settings, /backupPermissions\(snapshot\)\.settings \? backupSettings/);
  assert.match(settings, /setError\(err\.message/);
  assert.match(page, /SettingsView key=.*restoreGeneration/);
  assert.doesNotMatch(page, /JSON\.stringify\(snapshot\?\.settings\)/);
});

test("owner backup notices reflect only stricter count caps and any age limit", async () => {
  assert.deepEqual(stricterBackupPolicy({}, 10), { cap: 0, ageDays: 0 });
  assert.deepEqual(stricterBackupPolicy({ backup_max_retention_count: 20 }, 10), { cap: 0, ageDays: 0 });
  assert.deepEqual(stricterBackupPolicy({ backup_max_retention_count: 2, backup_max_age_days: 7 }, 10), { cap: 2, ageDays: 7 });
  const admin = await source("AdminView.jsx");
  for (const name of ["backup_max_retention_count", "backup_max_age_days"]) {
    assert.ok(admin.includes(name));
  }
});
