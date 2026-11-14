import { requireIsoDate, requireIsoMonth } from "./cashflow-date-utils.js";

/** Same history-substitution choices the server accepts for recurring sources. */
export const PREDICTION_SUBSTITUTES = ["none", "starting_value", "average_extreme_starting_value", "median_recorded",
  "last_confirmed", "previous_year_same_month", "require_min_recorded_months"];

/** Rate sources a standalone snapshot may carry: typed by the user or fetched
 * from one of the server's providers. */
export const LOCAL_FX_SOURCES = ["manual", "nbp", "frankfurter"];

/** A usable rate for [currency] into the ledger currency, or null. */
export function localFxRate(fxSnapshot, currency, ledgerCurrency) {
  const entry = fxSnapshot?.[`${currency.toLowerCase()}/${ledgerCurrency.toLowerCase()}`];
  return Number.isFinite(entry?.rate) && entry.rate > 0 ? entry : null;
}

/** Narrow editable standalone subset; server snapshots use the broader contract.
 * `requireRates: false` validates captured audit evidence, whose currency was
 * valid when accepted even if its rate has since been removed. */
export function validateLocalPlanning(request, { requireRates = true } = {}) {
  let recordKind = 'settings';
  const invalid = (message, reason) => Object.assign(new Error(message), { recordKind, ...(reason ? { reason } : {}) });
  const settings = request.settings;
  const money = value => Number.isFinite(value) && Number.isSafeInteger(Math.round(value * 100))
    && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001;
  if (!Number.isInteger(settings.future_periods) || settings.future_periods < 1 || settings.future_periods > 24
    || ![undefined, 0, 1, false, true].includes(settings.minimum_reserve_enabled)
    || (settings.minimum_reserve_amount !== undefined && (!money(settings.minimum_reserve_amount) || settings.minimum_reserve_amount < 0))
    || (settings.fx_buffer_percent !== undefined && (!Number.isFinite(settings.fx_buffer_percent)
      || settings.fx_buffer_percent < 0 || settings.fx_buffer_percent > 100))) {
    throw invalid("Invalid standalone projection settings");
  }
  const currency = request.settings.ledger_currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw invalid("Standalone currency required");
  // Rates are explicit entries; nothing is derived or fabricated (server pair-key format).
  recordKind = 'fx-snapshot';
  const fx = request.fxSnapshot;
  if (fx !== undefined && fx !== null) {
    if (typeof fx !== "object" || Array.isArray(fx)) throw invalid("Invalid standalone exchange rates");
    for (const [key, entry] of Object.entries(fx)) {
      const match = /^([a-z]{3})\/([a-z]{3})$/.exec(key);
      if (!match || match[2] !== currency.toLowerCase()) throw invalid('Invalid standalone exchange rates', 'FX_PAIR_SCOPE_INVALID');
      if (match[1] === match[2]) throw invalid('Invalid standalone exchange rates', 'FX_IDENTITY_PAIR_NOT_FOREIGN');
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw invalid('Invalid standalone exchange rates', 'FX_ENTRY_OBJECT_REQUIRED');
      if (Object.keys(entry).some(field => !['rate', 'source', 'effectiveDate', 'fetchedAt'].includes(field))) {
        throw invalid('Invalid standalone exchange rates', 'FX_ENTRY_FIELDS_UNSUPPORTED');
      }
      if (!Number.isFinite(entry.rate) || entry.rate <= 0 || entry.rate > 1000000) throw invalid('Invalid standalone exchange rates', 'FX_RATE_OUT_OF_RANGE');
      if (!LOCAL_FX_SOURCES.includes(entry.source)) throw invalid('Invalid standalone exchange rates', 'FX_SOURCE_UNSUPPORTED');
      try { requireIsoDate(entry.effectiveDate); }
      catch (_) { throw invalid('Invalid standalone exchange rates', 'FX_EFFECTIVE_DATE_INVALID'); }
    }
  }
  const tables = request.tables;
  const ids = new Set();
  const plans = new Map();
  recordKind = 'planned_transactions';
  for (const row of tables.planned_transactions) {
    if (typeof row.id !== "string" || !row.id || ids.has(row.id)) throw invalid("Duplicate or missing standalone source identifier");
    ids.add(row.id); plans.set(row.id, row);
  }
  const usedPlans = new Set();
  const priorities = new Set();
  // Incomes are validated before expenses, so anchors can only name a real income.
  const incomes = new Set();
  for (const name of ["one_off_transactions", "recurring_incomes", "recurring_expenses", "goals", "flex_transactions"]) {
    if (name === "flex_transactions" && tables[name] === undefined) continue;
    recordKind = name;
    for (const row of tables[name]) {
      if (typeof row.id !== "string" || !row.id || ids.has(row.id)) throw invalid("Duplicate or missing standalone source identifier");
      ids.add(row.id);
      if (name === "recurring_incomes") incomes.add(row.id);
      if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 100
        || typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency) || !money(row.amount) || row.amount <= 0) {
        throw invalid("Invalid standalone source name, amount or currency");
      }
      if (row.currency !== currency && requireRates && !localFxRate(fx, row.currency, currency)) {
        throw invalid(`Add an exchange rate for ${row.currency} to ${currency} before planning in ${row.currency}`);
      }
      if (name === "one_off_transactions") {
        requireIsoDate(row.date);
        if (!["income", "expense"].includes(row.type)) throw invalid("Unsupported standalone transaction type");
      } else {
        if (![0, 1, false, true].includes(row.active)) throw invalid("Explicit standalone source activity required");
        if (name === "goals") requireIsoDate(row.due_date);
        else if (name === "flex_transactions") {
          // Allocation stays in the shared projection engine; validate only source bounds.
          const bounds = [row.min_amount, row.max_amount];
          if (![0, 1, false, true].includes(row.allow_split)
            || bounds.some(value => value != null && (!money(value) || value < 0))
            || (!row.allow_split && bounds.some(value => value != null))
            // Server rule: a minimum never exceeds a given maximum (blank maximum = no cap).
            || (row.min_amount != null && row.max_amount != null && row.min_amount > row.max_amount)) {
            throw invalid("Invalid standalone flex configuration");
          }
        }
        else if (!["fixed", name === "recurring_incomes" ? "12month_min" : "12month_max"].includes(row.prediction_strategy)
          || ![undefined, null, 0, ...PREDICTION_SUBSTITUTES].includes(row.prediction_substitute_missing)
          || (row.prediction_min_recorded_months != null && (!Number.isInteger(row.prediction_min_recorded_months)
            || row.prediction_min_recorded_months < 1 || row.prediction_min_recorded_months > 12))
          || !Number.isInteger(row.repeat_every_months)
          || row.repeat_every_months < 1 || row.repeat_every_months > 12
          || !["day_of_month", "month_end"].includes(row.anchor_type) || !Number.isInteger(row.anchor_day_of_month)
          || row.anchor_day_of_month < 1 || row.anchor_day_of_month > 31
          || (row.anchor_offset_days != null && (!Number.isInteger(row.anchor_offset_days)
            || row.anchor_offset_days < -31 || row.anchor_offset_days > 31))
          // Offsets apply to month-end dates or to an anchoring income's date.
          || (row.anchor_type === "day_of_month" && !row.anchor_income_id && ![undefined, null, 0].includes(row.anchor_offset_days))
          || !["none", "previous", "next"].includes(row.anchor_business_day_adjustment)
          || ![undefined, null, "PL", "DE"].includes(row.anchor_holiday_country)
          || ![undefined, null, ""].includes(row.anchor_income_id) && (name !== "recurring_expenses"
            || typeof row.anchor_income_id !== "string" || !incomes.has(row.anchor_income_id))
          || ![undefined, 0, false, ...(name === "recurring_incomes" ? [1, true] : [])].includes(row.period_setting)
          || (name === "recurring_expenses" && ![undefined, 0, 1, false, true].includes(row.necessary))) {
          throw invalid("Unsupported standalone recurring configuration");
        }
        if (name.startsWith("recurring_")) {
          if (row.repeat_every_months > 1 && !row.start_month_year) throw invalid("Recurring interval requires a start month");
          if (row.start_month_year != null && row.start_month_year !== "") {
            if (typeof row.start_month_year !== "string" || requireIsoMonth(row.start_month_year) !== row.start_month_year) {
              throw invalid("Invalid standalone recurring start month");
            }
          }
          // Optional inclusive last month; it may not come before the start month.
          if (row.end_month_year != null && row.end_month_year !== "") {
            if (typeof row.end_month_year !== "string" || requireIsoMonth(row.end_month_year) !== row.end_month_year
              || (row.start_month_year && row.end_month_year < row.start_month_year)) {
              throw invalid("Invalid standalone recurring end month");
            }
          }
        }
      }
      if (["recurring_expenses", "goals", "flex_transactions"].includes(name)) {
        const plan = plans.get(row.planned_transaction_id);
        const priority = plan?.[name === "goals" ? "goal_priority" : "operating_priority"];
        if (!plan || usedPlans.has(plan.id) || !Number.isInteger(priority) || priority < 1) {
          throw invalid("Missing or invalid standalone priority reference");
        }
        const priorityKey = `${name === "goals" ? "goal" : "operating"}:${priority}`;
        if (priorities.has(priorityKey)) throw invalid("Duplicate standalone priority");
        priorities.add(priorityKey);
        usedPlans.add(plan.id);
      }
    }
  }
  if (usedPlans.size !== plans.size) throw invalid("Unreferenced standalone priority record");
  // Server parity: at most one income sets budget periods, and the setting names exactly that income.
  recordKind = 'settings';
  const periodIncomes = tables.recurring_incomes.filter(row => row.period_setting === 1 || row.period_setting === true);
  const selected = settings.budget_period_income_id;
  if (periodIncomes.length > 1 || ![undefined, null, ""].includes(selected) !== (periodIncomes.length === 1)
    || (periodIncomes.length === 1 && periodIncomes[0].id !== selected)) {
    throw invalid("Invalid standalone budget period income");
  }
}
