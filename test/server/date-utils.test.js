import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateNextDate,
  holidaySetForCountry,
  recurringOccurrencesInPeriod,
  shouldGenerateInMonth
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

test("day-of-month schedules clamp to month end", () => {
  assert.equal(
    calculateNextDate({
      anchor_type: "day_of_month",
      anchor_day_of_month: 31
    }, 2026, 2),
    "2026-02-28"
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

test("PL holiday calendar includes fixed and Easter-derived holidays", () => {
  const holidays = holidaySetForCountry("PL", 2026);

  assert.equal(holidays.has("2026-01-01"), true);
  assert.equal(holidays.has("2026-04-06"), true);
  assert.equal(holidays.has("2026-06-04"), true);
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
