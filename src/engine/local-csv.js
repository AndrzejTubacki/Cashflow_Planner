import { requireIsoDate } from "./cashflow-date-utils.js";
import { requireSupportedCurrency } from "./cashflow-fx-provider-utils.js";
import { roundMoneyAmount } from "./cashflow-money-utils.js";
import { refreshLocalSnapshot } from "./local-confirmation.js";
import { localFxRate } from "./local-validation.js";

// Server-compatible file dialect, deliberately line-based (no multiline cells).
// No storage, network, clocks or host-specific dependencies enter this module.
function badRequest(message, details = []) { return Object.assign(new Error(message), { details }); }
const ONE_OFF_CSV_COLUMNS = ["name", "type", "amount", "currency", "date"];
const CONFIRMED_LEDGER_CSV_HEADERS = [
  "ledger_year",
  "id",
  "name",
  "type",
  "date",
  "confirmed_date",
  "currency",
  "amount",
  "ledger_currency",
  "ledger_amount",
  "fx_rate",
  "buffered_fx_rate",
  "running_balance",
  "source_recurring_expense_id",
  "source_recurring_income_id",
  "source_one_off_id",
  "source_flex_id",
  "source_goal_id",
  "occurrence_key",
  "created_at",
  "updated_at"
];
/** Quote every output cell and neutralize spreadsheet formulas like server export. */
function csvEscape(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = "'" + text;
  }
  return `"${text.replace(/"/g, "\"\"")}"`;
}

/** Server header order and historic currency/date values are preserved verbatim. */
export function confirmedLedgerRowsToCsv(rows = []) {
  const lines = [CONFIRMED_LEDGER_CSV_HEADERS.join(",")];

  for (const row of rows) {
    lines.push(CONFIRMED_LEDGER_CSV_HEADERS.map(header => {
      if (header === "running_balance") return csvEscape(row.running_balance_pln ?? row.running_balance);
      return csvEscape(row[header]);
    }).join(","));
  }

  return lines.join("\n");
}

/** Strict quotes: only a comma or end of record may follow a closing quote. */
function parseCsvLine(line, rowNumber = 1) {
  const values = [];
  let current = "";
  let inQuotes = false;
  let quoteClosed = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else if (inQuotes) {
        inQuotes = false;
        quoteClosed = true;
      } else if (current === "") {
        inQuotes = true;
        quoteClosed = false;
      } else {
        throw badRequest("CSV row has malformed quotes", [{ row: rowNumber, field: null, reason: "malformed_quotes" }]);
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      quoteClosed = false;
    } else {
      if (quoteClosed) {
        throw badRequest("CSV row has malformed quotes", [{ row: rowNumber, field: null, reason: "unexpected_character_after_quote" }]);
      }
      current += char;
    }
  }

  if (inQuotes) {
    throw badRequest("CSV row has malformed quotes", [{ row: rowNumber, field: null, reason: "unterminated_quote" }]);
  }

  values.push(current);
  return values;
}

/** Match the server file dialect, including exact columns and optional UTF-8 BOM. */
export function parseCsv(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(line => line.trim() !== "");

  if (!lines.length) {
    throw badRequest("CSV file is empty");
  }

  const headers = parseCsvLine(lines[0], 1).map(header => header.trim().toLowerCase());

  if (headers.length !== ONE_OFF_CSV_COLUMNS.length || headers.some((header, index) => header !== ONE_OFF_CSV_COLUMNS[index])) {
    const details = [];
    const missing = ONE_OFF_CSV_COLUMNS.filter(column => !headers.includes(column));
    const unexpected = headers.filter(column => !ONE_OFF_CSV_COLUMNS.includes(column));

    for (const column of missing) details.push({ row: 1, field: column, reason: "missing_column" });
    for (const column of unexpected) details.push({ row: 1, field: column, reason: "unexpected_column" });
    if (!details.length) details.push({ row: 1, field: null, reason: "columns_must_be_exactly_name_type_amount_currency_date" });

    throw badRequest("CSV columns must be exactly: name,type,amount,currency,date", details);
  }

  return lines.slice(1).map((line, index) => {
    const rowNumber = index + 2;
    const values = parseCsvLine(line, rowNumber);
    if (values.length !== headers.length) {
      throw badRequest("CSV row has the wrong number of columns", [{
        row: rowNumber,
        field: null,
        reason: "column_count_mismatch"
      }]);
    }

    const row = {};

    headers.forEach((header, valueIndex) => {
      row[header] = values[valueIndex] ?? "";
    });

    return {
      rowNumber: index + 2,
      row
    };
  });
}

/** Normalize storage-independent source fields and attach server-style locations. */
export function normalizeCsvOneOff({ rowNumber, row }, generateId) {
  const name = String(row.name || "").trim();
  const type = String(row.type || "").trim().toLowerCase();
  const details = [];
  const amountText = String(row.amount ?? "").trim();
  let amount = null;
  let currency = null;
  let date = null;

  if (!name) {
    details.push({ row: rowNumber, field: "name", reason: "required" });
  }

  if (!["income", "expense"].includes(type)) {
    details.push({ row: rowNumber, field: "type", reason: "must_be_income_or_expense" });
  }

  if (!amountText) {
    details.push({ row: rowNumber, field: "amount", reason: "required" });
  } else {
    const normalizedAmountText = amountText.replace(",", ".");
    amount = Number(normalizedAmountText);
    if (!Number.isFinite(amount)) {
      details.push({ row: rowNumber, field: "amount", reason: "must_be_numeric" });
    } else if (amount < 0) {
      details.push({ row: rowNumber, field: "amount", reason: "must_be_non_negative" });
    } else {
      amount = roundMoneyAmount(amount);
    }
  }

  try {
    currency = requireSupportedCurrency(row.currency || "", `CSV row ${rowNumber} currency`);
  } catch {
    details.push({ row: rowNumber, field: "currency", reason: "unsupported_currency" });
  }

  try {
    date = requireIsoDate(row.date || "", `CSV row ${rowNumber} date`);
  } catch {
    details.push({ row: rowNumber, field: "date", reason: "invalid_date" });
  }

  if (details.length) {
    throw badRequest(`CSV row ${rowNumber} is invalid`, details);
  }

  return {
    id: generateId("oneoff"),
    name,
    currency,
    amount,
    type,
    date
  };
}


/** Return all invalid rows for review; invalid files never produce an import. */
export function previewLocalCsv({ snapshot, csv, mode, idSeed }) {
  if (!["append", "replace"].includes(mode)) throw new Error("Invalid CSV mode");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(idSeed)) throw new Error("Invalid CSV seed");
  const timing = { today: snapshot.request.today, generationTimestamp: snapshot.request.generationTimestamp, idSeed };
  const base = refreshLocalSnapshot({ snapshot, ...timing });
  let parsed;
  try { parsed = parseCsv(csv); }
  catch (error) { return { errors: error.details.length ? error.details : [{ row: 1, field: null, reason: "empty_file" }] }; }
  const errors = [], rows = [];
  if (!parsed.length) errors.push({ row: 1, field: null, reason: "empty_file" });
  for (const record of parsed) {
    try {
      const row = normalizeCsvOneOff(record, () => `oneoff-${idSeed}-${record.rowNumber}`);
      // Native planning has narrower money/name limits than server storage.
      // Report these per row rather than silently altering an imported value.
      if (row.name.length > 100) errors.push({ row: record.rowNumber, field: "name", reason: "name_too_long" });
      if (row.amount <= 0 || !Number.isSafeInteger(Math.round(row.amount * 100)))
        errors.push({ row: record.rowNumber, field: "amount", reason: "positive_safe_amount_required" });
      if (row.currency !== base.request.settings.ledger_currency && !localFxRate(base.request.fxSnapshot, row.currency, base.request.settings.ledger_currency))
        errors.push({ row: record.rowNumber, field: "currency", reason: "missing_rate" });
      rows.push(row);
    } catch (error) { errors.push(...error.details); }
  }
  if (errors.length) return { errors };
  // Originals remain restorable after a void; effective ledger rows alone are
  // insufficient to identify sources whose history must survive replacement.
  const protectedIds = new Set([...base.localHistory, ...(base.localAudit || []).filter(e => e.kind === "payment").map(e => e.row)]
    .map(row => row.source_one_off_id).filter(Boolean));
  const existing = base.request.tables.one_off_transactions;
  const deleteOneOffIds = mode === "replace" ? existing.filter(row => !protectedIds.has(row.id)).map(row => row.id) : [];
  const deletions = new Set(deleteOneOffIds);
  const next = JSON.parse(JSON.stringify(base));
  next.request.tables.one_off_transactions = [...existing.filter(row => !deletions.has(row.id)), ...rows];
  if (!Number.isSafeInteger(next.revision + 1)) throw new Error("Revision cannot advance");
  next.revision++;
  const prepared = refreshLocalSnapshot({ snapshot: next, ...timing });
  return { errors: [], mode, imported: rows.length, rows, deleteOneOffIds,
    retained: existing.filter(row => protectedIds.has(row.id)).length, snapshot: prepared };
}

/** Rebuild effective confirmed facts; voided payments are excluded, originals
 * and correction evidence remain in JSON backup. Never relabel historic money. */
export function exportLocalLedgerCsv({ snapshot }) {
  const verified = refreshLocalSnapshot({ snapshot, today: snapshot.request.today,
    generationTimestamp: snapshot.request.generationTimestamp, idSeed: snapshot.request.idSeed });
  return confirmedLedgerRowsToCsv(verified.localHistory);
}

/** Validation errors are normal review data, not a failed engine command. */
export function localCsvJson(json) {
  try {
    const command = JSON.parse(json);
    return JSON.stringify({ ok: true, ...(command.action === "export"
      ? { csv: exportLocalLedgerCsv(command) } : { preview: previewLocalCsv(command) }) });
  } catch { return JSON.stringify({ ok: false, error: { code: "LOCAL_CSV_REJECTED" } }); }
}
