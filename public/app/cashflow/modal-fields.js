import { escapeHtml } from "../utils.js";
import { t } from "./shared.js";

function fieldValue(item, name, fallback = "") {
  const value = item?.[name];

  if (value === undefined || value === null) return fallback;
  return String(value);
}

function checkedAttr(value, fallback = false) {
  const normalized = value === undefined || value === null ? fallback : value;
  return Number(normalized) === 1 || normalized === true || normalized === "1" ? "checked" : "";
}

function renderCurrencySelect(locale, item = {}) {
  const selected = String(item?.currency || "PLN").toUpperCase();
  const currencies = ["PLN", "EUR", "USD", "GBP", "CHF", "CZK", "SEK", "NOK", "DKK"];

  return `
    <label>
      <span>${escapeHtml(t(locale, "Waluta", "Currency"))}</span>
      <select name="currency" required>
        ${currencies.map(currency => `
          <option value="${escapeHtml(currency)}"${selected === currency ? " selected" : ""}>
            ${escapeHtml(currency)}
          </option>
        `).join("")}
      </select>
    </label>
  `;
}

function nextAvailablePriority(cashflow, entityType) {
  const priorities =
    entityType === "goal"
      ? (cashflow?.goals || []).map(item => Number(item.priority)).filter(Number.isFinite)
      : [
          ...(cashflow?.recurringExpenses || []),
          ...(cashflow?.flexTransactions || [])
        ].map(item => Number(item.priority)).filter(Number.isFinite);

  if (!priorities.length) return 1;

  const used = new Set(priorities);

  for (let i = 1; i <= priorities.length + 1; i += 1) {
    if (!used.has(i)) return i;
  }

  return Math.max(...priorities) + 1;
}

function renderHolidayCountrySelect(locale, item = {}) {
  const selected = String(item?.anchor_holiday_country || "PL").toUpperCase();

  const countries = [
    { code: "PL", label: "Poland" },
    { code: "DE", label: "Germany" }
  ];

  return `
    <label data-anchor-holiday-country-field>
      <span>${escapeHtml(t(locale, "Kraj świąt", "Holiday country"))}</span>
      <select name="anchor_holiday_country">
        ${countries.map(country => `
          <option value="${escapeHtml(country.code)}"${selected === country.code ? " selected" : ""}>
            ${escapeHtml(country.code)} - ${escapeHtml(country.label)}
          </option>
        `).join("")}
      </select>
    </label>
  `;
}

export function renderCashflowModalFields(locale, entityType, item = {}, cashflow = null) {
  const today = new Date().toISOString().slice(0, 10);

  const defaultPriority = fieldValue(
    item,
    "priority",
    String(nextAvailablePriority(cashflow, entityType))
  );

  const commonNameCurrencyAmount = `
    <label>
      <span>${escapeHtml(t(locale, "Nazwa", "Name"))}</span>
      <input name="name" value="${escapeHtml(fieldValue(item, "name"))}" required>
    </label>

    ${renderCurrencySelect(locale, item)}

    <label>
      <span>${escapeHtml(t(locale, "Kwota", "Amount"))}</span>
      <input name="amount" type="number" min="0" step="0.01" value="${escapeHtml(fieldValue(item, "amount", "0"))}" required>
    </label>
  `;

  const anchorFields = `
    <label>
      <span>${escapeHtml(t(locale, "Kotwica", "Anchor"))}</span>
      <select name="anchor_type" data-cashflow-anchor-type>
        <option value="day_of_month"${fieldValue(item, "anchor_type", "month_end") === "day_of_month" ? " selected" : ""}>
          ${escapeHtml(t(locale, "Dzień miesiąca", "Day of month"))}
        </option>
        <option value="month_end"${fieldValue(item, "anchor_type", "month_end") === "month_end" ? " selected" : ""}>
          ${escapeHtml(t(locale, "Koniec miesiąca", "Month end"))}
        </option>
      </select>
    </label>

    <label data-anchor-day-field>
      <span>${escapeHtml(t(locale, "Dzień miesiąca", "Day of month"))}</span>
      <input name="anchor_day_of_month" type="number" min="1" max="31" value="${escapeHtml(fieldValue(item, "anchor_day_of_month", "1"))}">
    </label>

    <label data-anchor-month-end-field>
      <span>${escapeHtml(t(locale, "Offset dni", "Offset days"))}</span>
      <input name="anchor_offset_days" type="number" step="1" value="${escapeHtml(fieldValue(item, "anchor_offset_days", "0"))}">
    </label>

    <label data-anchor-month-end-field>
      <span>${escapeHtml(t(locale, "Korekta dnia roboczego", "Business day adjustment"))}</span>
      <select name="anchor_business_day_adjustment">
        <option value="none"${fieldValue(item, "anchor_business_day_adjustment", "none") === "none" ? " selected" : ""}>none</option>
        <option value="previous"${fieldValue(item, "anchor_business_day_adjustment") === "previous" ? " selected" : ""}>previous</option>
        <option value="next"${fieldValue(item, "anchor_business_day_adjustment") === "next" ? " selected" : ""}>next</option>
      </select>
    </label>

    ${renderHolidayCountrySelect(locale, item)}

    <label>
      <span>${escapeHtml(t(locale, "Powtarzaj co X miesięcy", "Repeat every X months"))}</span>
      <input name="repeat_every_months" type="number" min="1" max="12" step="1" value="${escapeHtml(fieldValue(item, "repeat_every_months", "1"))}" data-repeat-every-months>
    </label>

    <label data-start-month-year-field>
      <span>${escapeHtml(t(locale, "Start YYYY-MM", "Start YYYY-MM"))}</span>
      <input name="start_month_year" placeholder="2026-05" value="${escapeHtml(fieldValue(item, "start_month_year"))}">
    </label>
  `;

  if (entityType === "recurring-expense") {
    return `
      ${commonNameCurrencyAmount}

      <label>
        <span>${escapeHtml(t(locale, "Strategia predykcji", "Prediction strategy"))}</span>
        <select name="prediction_strategy">
          <option value="fixed"${fieldValue(item, "prediction_strategy", "fixed") === "fixed" ? " selected" : ""}>fixed</option>
          <option value="12month_max"${fieldValue(item, "prediction_strategy") === "12month_max" ? " selected" : ""}>12month_max</option>
        </select>
      </label>

      <label>
        <span>${escapeHtml(t(locale, "Priorytet", "Priority"))}</span>
        <input name="priority" type="number" min="1" step="1" value="${escapeHtml(defaultPriority)}">
      </label>

      <label class="cashflow-checkbox">
        <input name="necessary" type="checkbox" value="1" ${checkedAttr(item.necessary)}>
        <span>${escapeHtml(t(locale, "Niezbędne", "Necessary"))}</span>
      </label>

      <label class="cashflow-checkbox">
        <input name="active" type="checkbox" value="1" ${checkedAttr(item.active, true)}>
        <span>${escapeHtml(t(locale, "Aktywne", "Active"))}</span>
      </label>

      ${anchorFields}
    `;
  }

  if (entityType === "recurring-income") {
    return `
      ${commonNameCurrencyAmount}

      <label>
        <span>${escapeHtml(t(locale, "Strategia predykcji", "Prediction strategy"))}</span>
        <select name="prediction_strategy">
          <option value="fixed"${fieldValue(item, "prediction_strategy", "fixed") === "fixed" ? " selected" : ""}>fixed</option>
          <option value="12month_min"${fieldValue(item, "prediction_strategy") === "12month_min" ? " selected" : ""}>12month_min</option>
        </select>
      </label>

      <label class="cashflow-checkbox">
        <input name="period_setting" type="checkbox" value="1" ${checkedAttr(item.period_setting)}>
        <span>${escapeHtml(t(locale, "Definiuje okres budżetowy", "Defines budget period"))}</span>
      </label>

      <label class="cashflow-checkbox">
        <input name="active" type="checkbox" value="1" ${checkedAttr(item.active, true)}>
        <span>${escapeHtml(t(locale, "Aktywne", "Active"))}</span>
      </label>

      ${anchorFields}
    `;
  }

  if (entityType === "one-off") {
    return `
      ${commonNameCurrencyAmount}

      <label>
        <span>${escapeHtml(t(locale, "Typ", "Type"))}</span>
        <select name="type">
          <option value="expense"${fieldValue(item, "type", "expense") === "expense" ? " selected" : ""}>expense</option>
          <option value="income"${fieldValue(item, "type") === "income" ? " selected" : ""}>income</option>
        </select>
      </label>

      <label>
        <span>${escapeHtml(t(locale, "Data", "Date"))}</span>
        <input name="date" type="date" value="${escapeHtml(fieldValue(item, "date", today))}" required>
      </label>
    `;
  }

  if (entityType === "goal") {
    return `
      ${commonNameCurrencyAmount}

      <label>
        <span>${escapeHtml(t(locale, "Priorytet", "Priority"))}</span>
        <input name="priority" type="number" min="1" step="1" value="${escapeHtml(defaultPriority)}">
      </label>

      <label>
        <span>${escapeHtml(t(locale, "Termin", "Due date"))}</span>
        <input name="due_date" type="date" value="${escapeHtml(fieldValue(item, "due_date", today))}" required>
      </label>

      <label class="cashflow-checkbox">
        <input name="active" type="checkbox" value="1" ${checkedAttr(item.active, true)}>
        <span>${escapeHtml(t(locale, "Aktywne", "Active"))}</span>
      </label>
    `;
  }

  if (entityType === "flex") {
    return `
      ${commonNameCurrencyAmount}

      <label>
        <span>${escapeHtml(t(locale, "Priorytet", "Priority"))}</span>
        <input name="priority" type="number" min="1" step="1" value="${escapeHtml(defaultPriority)}">
      </label>

      <label class="cashflow-checkbox">
        <input name="active" type="checkbox" value="1" ${checkedAttr(item.active, true)}>
        <span>${escapeHtml(t(locale, "Aktywne", "Active"))}</span>
      </label>

      <label class="cashflow-checkbox">
        <input name="allow_split" type="checkbox" value="1" ${checkedAttr(item.allow_split)} data-allow-split>
        <span>${escapeHtml(t(locale, "Można dzielić", "Allow split"))}</span>
      </label>

      <label data-flex-split-field>
        <span>${escapeHtml(t(locale, "Minimum", "Minimum"))}</span>
        <input name="min_amount" type="number" min="0" step="0.01" value="${escapeHtml(fieldValue(item, "min_amount"))}">
      </label>

      <label data-flex-split-field>
        <span>${escapeHtml(t(locale, "Maximum", "Maximum"))}</span>
        <input name="max_amount" type="number" min="0" step="0.01" value="${escapeHtml(fieldValue(item, "max_amount"))}">
      </label>
    `;
  }

  if (entityType === "pending") {
    return `
      <label>
        <span>${escapeHtml(t(locale, "Nazwa", "Name"))}</span>
        <input name="name" value="${escapeHtml(fieldValue(item, "name"))}" required>
      </label>

      <label>
        <span>${escapeHtml(t(locale, "Kwota", "Amount"))}</span>
        <input name="amount" type="number" min="0" step="0.01" value="${escapeHtml(fieldValue(item, "amount", "0"))}" required>
      </label>

      <label>
        <span>${escapeHtml(t(locale, "Data", "Date"))}</span>
        <input name="date" type="date" value="${escapeHtml(fieldValue(item, "date", today))}" required>
      </label>
    `;
  }

  return `<p>${escapeHtml(t(locale, "Nieznany typ formularza", "Unknown form type"))}</p>`;
}
