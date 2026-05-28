import { CASHFLOW_TIMEZONE } from "./cashflow-constants.js";

let testTodayOverride = null;

export function setTodayWarsawOverrideForTests(dateString = null) {
  // Integration tests pin the app calendar without monkey-patching Date or changing production defaults.
  const previous = testTodayOverride;
  testTodayOverride = /^\d{4}-\d{2}-\d{2}$/.test(dateString || "") ? dateString : null;
  return previous;
}

export function shouldGenerateInMonth(item, year, month) {
  const repeatEveryMonths = Math.max(1, Math.min(12, Number(item.repeat_every_months) || 1));

  if (repeatEveryMonths === 1) return true;

  if (!item.start_month_year) return false;

  const [startYearRaw, startMonthRaw] = String(item.start_month_year).split("-");
  const startYear = Number(startYearRaw);
  const startMonth = Number(startMonthRaw);

  if (!startYear || !startMonth || startMonth < 1 || startMonth > 12) return false;

  const currentIndex = year * 12 + (month - 1);
  const startIndex = startYear * 12 + (startMonth - 1);

  if (currentIndex < startIndex) return false;

  return (currentIndex - startIndex) % repeatEveryMonths === 0;
}

export function dateStringFromUTC(date) {
  return date.toISOString().slice(0, 10);
}

export function easterSundayUtc(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

export function addDaysUtc(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function holidaySetForCountry(country, year) {
  const c = String(country || "PL").toUpperCase();
  const holidays = new Set();

  const add = (yyyyMmDd) => holidays.add(yyyyMmDd);

  if (c === "PL") {
    add(`${year}-01-01`);
    add(`${year}-01-06`);
    add(`${year}-05-01`);
    add(`${year}-05-03`);
    add(`${year}-08-15`);
    add(`${year}-11-01`);
    add(`${year}-11-11`);
    add(`${year}-12-25`);
    add(`${year}-12-26`);

    const easter = easterSundayUtc(year);
    add(dateStringFromUTC(addDaysUtc(easter, 1)));
    add(dateStringFromUTC(addDaysUtc(easter, 60)));
  }

  if (c === "DE") {
    add(`${year}-01-01`);
    add(`${year}-05-01`);
    add(`${year}-10-03`);
    add(`${year}-12-25`);
    add(`${year}-12-26`);

    const easter = easterSundayUtc(year);
    add(dateStringFromUTC(addDaysUtc(easter, -2)));
    add(dateStringFromUTC(addDaysUtc(easter, 1)));
    add(dateStringFromUTC(addDaysUtc(easter, 39)));
    add(dateStringFromUTC(addDaysUtc(easter, 50)));
  }

  return holidays;
}

export function isBusinessDay(date, country) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;

  const year = date.getUTCFullYear();
  return !holidaySetForCountry(country, year).has(dateStringFromUTC(date));
}

export function todayWarsaw(now = new Date()) {
  if (testTodayOverride) {
    return testTodayOverride;
  }

  // Accepting an injected Date keeps timezone-boundary tests deterministic while preserving runtime behavior.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CASHFLOW_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const value = (type) => parts.find(p => p.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function monthKey(dateString) {
  return String(dateString || "").slice(0, 7);
}

export function addMonths(dateString, months) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function calculateNextDate(anchor, year, month) {
  if (!shouldGenerateInMonth(anchor, year, month)) {
    return null;
  }

  let date;

  if (anchor.anchor_type === "day_of_month") {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = Math.min(Number(anchor.anchor_day_of_month) || 1, lastDay);
    date = new Date(Date.UTC(year, month - 1, day));
  } else {
    date = new Date(Date.UTC(year, month, 0));
    date.setUTCDate(date.getUTCDate() + (Number(anchor.anchor_offset_days) || 0));
  }

  const adjustment = anchor.anchor_business_day_adjustment || "none";
  const country = anchor.anchor_holiday_country || "PL";

  if (adjustment !== "none") {
    while (!isBusinessDay(date, country)) {
      if (adjustment === "previous") {
        date.setUTCDate(date.getUTCDate() - 1);
      } else if (adjustment === "next") {
        date.setUTCDate(date.getUTCDate() + 1);
      } else {
        break;
      }
    }
  }

  return dateStringFromUTC(date);
}

export function monthsOverlappingPeriod(period) {
  const months = [];
  const start = new Date(`${period.start}T00:00:00Z`);
  const end = new Date(`${period.end}T00:00:00Z`);

  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));

  while (cursor <= end) {
    months.push({
      year: cursor.getUTCFullYear(),
      month: cursor.getUTCMonth() + 1
    });

    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return months;
}

export function recurringOccurrencesInPeriod(item, period, today = null) {
  const occurrences = [];

  for (const { year, month } of monthsOverlappingPeriod(period)) {
    const date = calculateNextDate(item, year, month);

    if (!date) continue;
    if (today && date < today) continue;
    if (date < period.start || date > period.end) continue;

    occurrences.push(date);
  }

  return [...new Set(occurrences)].sort();
}
