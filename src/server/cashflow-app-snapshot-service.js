import { createNodeLedgerAuditReplay } from './cashflow-ledger-audit-store.js';
import { createHash, randomUUID } from "node:crypto";
import { prepareSnapshot } from "../engine/prepare-snapshot.js";
import { todayInTimezone } from "./cashflow-date-utils.js";
import { conflict } from "./cashflow-user-utils.js";
import { validateFinancialExportAudit } from './cashflow-ledger-audit-export.js';
import { oneOffProgressWithOriginals } from '../engine/ledger-audit-progress.js';

const TABLES = ["planned_transactions", "recurring_expenses", "recurring_incomes", "flex_transactions",
  "goals", "one_off_transactions", "pending_transactions", "future_transactions", "projection_snapshots"];
const SETTINGS = ["ledger_currency", "timezone", "holiday_country", "future_periods", "minimum_reserve_enabled",
  "minimum_reserve_amount", "budget_period_income_id", "fx_buffer_percent", "necessary_underfunded_repeat_days",
  "notify_goal_impossible", "notify_necessary_underfunded", "notify_funding_shortfall", "notify_income_missing",
  "notify_pending_summary", "notify_goal_funded", "notify_fx_changed"];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Read-only preview export. No network FX refresh, projection generation, or settings secrets. */
export function createAppSnapshotService({ budgetStore, afterRead = null, allowStandaloneOrigins = false }) {
  const codec = createNodeLedgerAuditReplay({ allowStandaloneOrigins });
  function scopedRows(rows, budgetId) {
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row)
      || (Object.prototype.hasOwnProperty.call(row, "budget_id") && row.budget_id !== budgetId))) {
      // Never include a foreign ID, name, or financial value in the error.
      throw conflict("Budget storage returned invalid or incorrectly scoped rows; repair the budget before downloading");
    }
    return rows;
  }
  async function read(budgetId, reader = budgetStore) {
    const settingsRows = await reader.listPlanningRows(budgetId, "settings");
    if (!Array.isArray(settingsRows) || settingsRows.length !== 1) {
      throw conflict("Budget settings are unavailable or ambiguous; repair the budget before downloading");
    }
    const raw = settingsRows[0];
    if (raw) scopedRows(settingsRows, budgetId);
    // Preparation supports legacy defaults internally, but a device export must
    // never turn damaged settings into an apparently verified PLN budget.
    if (!raw || typeof raw.ledger_currency !== "string" || !/^[A-Z]{3}$/.test(raw.ledger_currency)) {
      throw conflict("Budget ledger currency is unavailable or invalid; repair the budget before downloading");
    }
    // Legacy web calculations deliberately normalize invalid zones. A device
    // export must preserve its stated date boundary, not silently use that fallback.
    try {
      if (typeof raw.timezone !== "string" || !raw.timezone || raw.timezone !== raw.timezone.trim()) {
        throw new Error("Missing timezone");
      }
      new Intl.DateTimeFormat("en-US", { timeZone: raw.timezone });
    } catch {
      throw conflict("Budget timezone is unavailable or invalid; repair the budget before downloading");
    }
    const settings = Object.fromEntries(SETTINGS.filter(key => raw[key] !== undefined).map(key => [key, raw[key]]));
    const tables = {};
    for (const name of TABLES) tables[name] = scopedRows(await reader.listPlanningRows(budgetId, name), budgetId);
    const confirmedRows = [];
    const years = await reader.listLedgerYears(budgetId);
    // Storage adapters return numeric years. Do not coerce malformed values or
    // read a year twice: duplicated history changes balances and funding totals.
    if (!Array.isArray(years) || years.some(year => !Number.isInteger(year) || year < 1 || year > 9999)
      || new Set(years).size !== years.length) {
      throw conflict("Budget ledger years are unavailable or invalid; repair the budget before downloading");
    }
    for (const year of [...years].sort((a, b) => a - b)) {
      confirmedRows.push(...scopedRows(await reader.listConfirmedTransactions(budgetId, { ledgerYear: year }), budgetId));
    }
    // Export only calculation-related FX metadata, never notification/backup configuration.
    const newest = [...tables.projection_snapshots].sort((a, b) => String(b.snapshot_timestamp).localeCompare(String(a.snapshot_timestamp)))[0];
    let fxSnapshot = newest?.fx_rates_used ?? null;
    if (typeof fxSnapshot === "string") fxSnapshot = JSON.parse(fxSnapshot);
    const ledgerAudit = typeof reader.exportLedgerAuditSnapshot === 'function' ? await reader.exportLedgerAuditSnapshot(budgetId) : null;
    if (ledgerAudit !== null) {
      const ledgers = {};
      for (const row of confirmedRows) (ledgers[row.ledger_year] ||= []).push(row);
      validateFinancialExportAudit(budgetId, ledgerAudit, ledgers, { allowStandaloneOrigins });
    }
    // Audit contributes to consistency/token verification but no historical
    // actors or correction contents are added to the legacy read-only response.
    return { settings, tables, confirmedRows, fxSnapshot, ...(ledgerAudit === null ? {} : { ledgerAudit }) };
  }

  return async function getAppSnapshot(budgetId) {
    const atomic = budgetStore.backend === "postgres" && typeof budgetStore.transaction === "function";
    const first = atomic ? await budgetStore.transaction(async (reader, client) => {
      // Must be the first statement after BEGIN, before any reads.
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      return read(budgetId, reader);
    }) : await read(budgetId);
    const second = atomic ? first : await read(budgetId);
    // Optional deterministic test barrier; never configured by the HTTP API.
    if (afterRead) await afterRead();
    const serialized = JSON.stringify(canonical(first));
    if (serialized !== JSON.stringify(canonical(second))) throw conflict("Budget changed while reading; retry snapshot");
    if (Buffer.byteLength(serialized, "utf8") > 10 * 1024 * 1024) throw conflict("Budget exceeds snapshot size limit");
    const replay = second.ledgerAudit?.version === 2 ? codec.replayLedgerAuditSnapshot(second.ledgerAudit, budgetId) : null;
    const ledgerOpeningBalance = replay?.opening.ledgerCurrency === second.settings.ledger_currency ? replay.opening.amount : 0;
    const snapshot = prepareSnapshot({ budgetId, revision: 0, ...second, ledgerOpeningBalance,
      today: todayInTimezone(second.settings.timezone), generationTimestamp: new Date().toISOString(),
      idSeed: randomUUID() });
    if (second.ledgerAudit) snapshot.request.oneOffProgress = [...oneOffProgressWithOriginals(second.confirmedRows, replay ? [...replay.originals.values()] : second.ledgerAudit.originals)];
    const response = { ...snapshot,
      snapshotToken: createHash("sha256").update(serialized).digest("hex"),
      consistency: atomic ? "postgres-repeatable-read" : "double-read-verified-not-atomic", revisionSemantics: "preview-only-not-server-revision",
      fxSource: "last-projection-no-refresh", writesSupported: false };
    if (Buffer.byteLength(JSON.stringify(response), "utf8") > 10 * 1024 * 1024) {
      throw conflict("Budget exceeds snapshot response size limit");
    }
    return response;
  };
}
