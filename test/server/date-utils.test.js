import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateNextDate,
  holidaySetForCountry,
  recurringOccurrencesInPeriod,
  shouldGenerateInMonth,
  todayWarsaw
} from "../../src/server/cashflow-date-utils.js";

test("monthly schedules generate every month by default", () => {
  assert.equal(shouldGenerateInMonth({}, 2026, 5), true);
});

test("multi-month schedules start on start_month_year and repeat by interval", () => {
  const item = {
    repeat_every_months: 3,
    start_month_year: "2026-02"
  };

  assert.equal(shouldGenerateInMonth(item, 2026, 1), false);
  assert.equal(shouldGenerateInMonth(item, 2026, 2), true);
  assert.equal(shouldGenerateInMonth(item, 2026, 3), false);
  assert.equal(shouldGenerateInMonth(item, 2026, 5), true);
});

test("invalid multi-month schedule anchors do not generate", () => {
  assert.equal(shouldGenerateInMonth({ repeat_every_months: 2 }, 2026, 5), false);
  assert.equal(shouldGenerateInMonth({ repeat_every_months: 2, start_month_year: "bad" }, 2026, 5), false);
  assert.equal(shouldGenerateInMonth({ repeat_every_months: 2, start_month_year: "2026-13" }, 2026, 5), false);
});

test("repeat interval is clamped to supported bounds", () => {
  assert.equal(shouldGenerateInMonth({ repeat_every_months: 0 }, 2026, 5), true);
  assert.equal(shouldGenerateInMonth({ repeat_every_months: 99, start_month_year: "2026-01" }, 2027, 1), true);
  assert.equal(shouldGenerateInMonth({ repeat_every_months: 99, start_month_year: "2026-01" }, 2027, 2), false);
});

test("day-of-month schedules clamp to month end", () => {
  assert.equal(
    calculateNextDate({
      anchor_type: "day_of_month",
      anchor_day_of_month: 31
    }, 2026, 2),
    "2026-02-28"
  );
});

test("day-of-month schedules handle leap-year month end", () => {
  assert.equal(
    calculateNextDate({
      anchor_type: "day_of_month",
      anchor_day_of_month: 31
    }, 2028, 2),
    "2028-02-29"
  );
});

test("month-end schedules can move to previous business day", () => {
  assert.equal(
    calculateNextDate({
      anchor_type: "month_end",
      anchor_offset_days: 0,
      anchor_business_day_adjustment: "previous",
      anchor_holiday_country: "PL"
    }, 2026, 5),
    "2026-05-29"
  );
});

test("month-end offsets can cross month and year boundaries", () => {
  assert.equal(
    calculateNextDate({
      anchor_type: "month_end",
      anchor_offset_days: 2
    }, 2026, 12),
    "2027-01-02"
  );

  assert.equal(
    calculateNextDate({
      anchor_type: "month_end",
      anchor_offset_days: -31
    }, 2026, 3),
    "2026-02-28"
  );
});

test("business-day adjustment can move to next business day over weekends and holidays", () => {
  assert.equal(
    calculateNextDate({
      anchor_type: "day_of_month",
      anchor_day_of_month: 1,
      anchor_business_day_adjustment: "next",
      anchor_holiday_country: "PL"
    }, 2026, 5),
    "2026-05-04"
  );

  assert.equal(
    calculateNextDate({
      anchor_type: "day_of_month",
      anchor_day_of_month: 3,
      anchor_business_day_adjustment: "next",
      anchor_holiday_country: "DE"
    }, 2026, 10),
    "2026-10-05"
  );
});

test("PL holiday calendar includes fixed and Easter-derived holidays", () => {
  const holidays = holidaySetForCountry("PL", 2026);

  assert.equal(holidays.has("2026-01-01"), true);
  assert.equal(holidays.has("2026-04-06"), true);
  assert.equal(holidays.has("2026-06-04"), true);
});

test("DE holiday calendar includes fixed and Easter-derived holidays", () => {
  const holidays = holidaySetForCountry("DE", 2026);

  assert.equal(holidays.has("2026-01-01"), true);
  assert.equal(holidays.has("2026-04-03"), true);
  assert.equal(holidays.has("2026-05-14"), true);
});

test("todayWarsaw uses Warsaw calendar date at UTC rollover and DST boundaries", () => {
  assert.equal(todayWarsaw(new Date("2026-05-20T21:59:00Z")), "2026-05-20");
  assert.equal(todayWarsaw(new Date("2026-05-20T22:01:00Z")), "2026-05-21");
  assert.equal(todayWarsaw(new Date("2026-03-29T00:30:00Z")), "2026-03-29");
  assert.equal(todayWarsaw(new Date("2026-10-25T00:30:00Z")), "2026-10-25");
});

test("recurringOccurrencesInPeriod filters past dates and period bounds", () => {
  const occurrences = recurringOccurrencesInPeriod(
    {
      anchor_type: "day_of_month",
      anchor_day_of_month: 15,
      repeat_every_months: 1
    },
    {
      start: "2026-05-01",
      end: "2026-07-31"
    },
    "2026-06-01"
  );

  assert.deepEqual(occurrences, ["2026-06-15", "2026-07-15"]);
});

test("recurringOccurrencesInPeriod de-duplicates overlapping generated dates", () => {
  const occurrences = recurringOccurrencesInPeriod(
    {
      anchor_type: "month_end",
      anchor_offset_days: 1,
      repeat_every_months: 1
    },
    {
      start: "2026-01-01",
      end: "2026-02-01"
    }
  );

  assert.deepEqual(occurrences, ["2026-02-01"]);
});
