import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateNextDate,
  holidaySetForCountry,
  normalizeTimezone,
  recurringOccurrencesInPeriod,
  shouldGenerateInMonth,
  todayInTimezone
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

test("income-anchored schedules land N days after the referenced income's own date", () => {
  const salary = { anchor_type: "day_of_month", anchor_day_of_month: 25 };

  assert.equal(
    calculateNextDate({
      anchor_income_id: "inc-1",
      anchor_income: salary,
      anchor_offset_days: 1
    }, 2026, 5),
    "2026-05-26"
  );

  assert.equal(
    calculateNextDate({
      anchor_income_id: "inc-1",
      anchor_income: salary,
      anchor_offset_days: 0
    }, 2026, 5),
    "2026-05-25"
  );
});

test("income-anchored schedules can cross a month boundary via their own offset", () => {
  const monthEndIncome = { anchor_type: "month_end", anchor_offset_days: 0 };

  assert.equal(
    calculateNextDate({
      anchor_income_id: "inc-1",
      anchor_income: monthEndIncome,
      anchor_offset_days: 3
    }, 2026, 4),
    "2026-05-03"
  );
});

test("income-anchored schedules apply the dependent's own business-day adjustment, not the income's", () => {
  const salary = {
    anchor_type: "day_of_month",
    anchor_day_of_month: 1,
    anchor_business_day_adjustment: "none"
  };

  assert.equal(
    calculateNextDate({
      anchor_income_id: "inc-1",
      anchor_income: salary,
      anchor_offset_days: 0,
      anchor_business_day_adjustment: "next",
      anchor_holiday_country: "PL"
    }, 2026, 5),
    "2026-05-04"
  );
});

test("income-anchored schedules with an unresolved anchor_income fall back to their own anchor_type", () => {
  // A dangling anchor_income_id (caller didn't attach anchor_income, e.g. a
  // stale reference) must never silently drop the expense.
  assert.equal(
    calculateNextDate({
      anchor_income_id: "inc-missing",
      anchor_type: "day_of_month",
      anchor_day_of_month: 10
    }, 2026, 5),
    "2026-05-10"
  );
});

test("income-anchored schedules return null for a month the referenced income doesn't occur in", () => {
  const quarterlyIncome = {
    anchor_type: "day_of_month",
    anchor_day_of_month: 1,
    repeat_every_months: 3,
    start_month_year: "2026-01"
  };

  assert.equal(
    calculateNextDate({
      anchor_income_id: "inc-1",
      anchor_income: quarterlyIncome,
      anchor_offset_days: 2
    }, 2026, 2),
    null
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

test("todayInTimezone uses the configured calendar date at UTC rollover and DST boundaries", () => {
  assert.equal(todayInTimezone("Europe/Warsaw", new Date("2026-05-20T21:59:00Z")), "2026-05-20");
  assert.equal(todayInTimezone("Europe/Warsaw", new Date("2026-05-20T22:01:00Z")), "2026-05-21");
  assert.equal(todayInTimezone("America/New_York", new Date("2026-05-20T02:59:00Z")), "2026-05-19");
  assert.equal(todayInTimezone("America/New_York", new Date("2026-05-20T04:01:00Z")), "2026-05-20");
  assert.equal(todayInTimezone("Europe/Warsaw", new Date("2026-03-29T00:30:00Z")), "2026-03-29");
  assert.equal(todayInTimezone("Europe/Warsaw", new Date("2026-10-25T00:30:00Z")), "2026-10-25");
});

test("normalizeTimezone accepts IANA timezone names and falls back for invalid values", () => {
  assert.equal(normalizeTimezone("America/New_York"), "America/New_York");
  assert.equal(normalizeTimezone("bad/timezone"), "Europe/Warsaw");
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

test("recurringOccurrencesInPeriod includes the previous cycle at the period start", () => {
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

  assert.deepEqual(occurrences, ["2026-01-01", "2026-02-01"]);
});


test("recurrence period lookup includes shifted source months and preserves their repeat cadence", () => {
  // Test final-date ownership, including holidays, both year boundaries and
  // arbitrary offsets; eligibility still belongs to the original source month.
  const monthEnd = { anchor_type: "month_end", anchor_holiday_country: "PL" };
  const cases = [
    [{ ...monthEnd, anchor_business_day_adjustment: "next" },
      "2026-11-01", "2026-11-30", ["2026-11-02", "2026-11-30"]],
    [{ anchor_type: "day_of_month", anchor_day_of_month: 1, anchor_business_day_adjustment: "previous" },
      "2026-04-01", "2026-04-30", ["2026-04-01", "2026-04-30"]],
    [{ anchor_type: "day_of_month", anchor_day_of_month: 1, anchor_business_day_adjustment: "previous" },
      "2026-12-01", "2026-12-31", ["2026-12-01", "2026-12-31"]],
    [{ ...monthEnd, anchor_offset_days: 2 },
      "2027-01-01", "2027-01-31", ["2027-01-02"]],
    [{ ...monthEnd, anchor_business_day_adjustment: "next", repeat_every_months: 3, start_month_year: "2026-10" },
      "2026-11-01", "2027-01-31", ["2026-11-02"]],
    [{ ...monthEnd, anchor_offset_days: 62 },
      "2026-04-01", "2026-04-30", ["2026-04-03"]],
    [{ ...monthEnd, anchor_offset_days: -62 },
      "2026-01-01", "2026-01-31", ["2026-01-28"]],
    [{ anchor_income_id: "salary", anchor_income: { ...monthEnd, anchor_offset_days: 62 }, anchor_offset_days: 62 },
      "2026-06-01", "2026-06-30", ["2026-06-04"]]
  ];
  for (const [item, start, end, expected] of cases) {
    assert.deepEqual(recurringOccurrencesInPeriod(item, { start, end }), expected, JSON.stringify(item));
  }
  assert.deepEqual(recurringOccurrencesInPeriod(cases[0][0], {
    start: "2026-11-01", end: "2026-11-30"
  }, "2026-11-03"), ["2026-11-30"]);
});

test("monthly schedules honour start_month_year as a lower bound", () => {
  const rent = { repeat_every_months: 1, start_month_year: "2027-01", anchor_type: "day_of_month", anchor_day_of_month: 10 };

  assert.equal(calculateNextDate(rent, 2026, 12), null);
  assert.equal(calculateNextDate(rent, 2027, 1), "2027-01-10");
  assert.equal(calculateNextDate(rent, 2027, 2), "2027-02-10");
});

test("end_month_year is an inclusive upper bound on the month; the day comes from the anchor", () => {
  const loan = { repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 15, end_month_year: "2027-03" };

  assert.equal(calculateNextDate(loan, 2027, 3), "2027-03-15");
  assert.equal(calculateNextDate(loan, 2027, 4), null);
  assert.equal(calculateNextDate({ ...loan, anchor_type: "month_end" }, 2027, 3), "2027-03-31");
});

test("the end month bounds the source month even when an offset moves the date past it", () => {
  const bill = { repeat_every_months: 1, anchor_type: "month_end", anchor_offset_days: 2, end_month_year: "2027-03" };

  assert.equal(calculateNextDate(bill, 2027, 3), "2027-04-02");
  assert.equal(calculateNextDate(bill, 2027, 4), null);
});

test("an expense that follows an income stops when the income ends", () => {
  const salary = { id: "inc", repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 28, end_month_year: "2027-01" };
  const rent = { repeat_every_months: 1, anchor_type: "month_end", anchor_income_id: "inc", anchor_income: salary, anchor_offset_days: 1 };

  assert.equal(calculateNextDate(rent, 2027, 1), "2027-01-29");
  assert.equal(calculateNextDate(rent, 2027, 2), null);
});

test("ignoreActiveWindow keeps the start and end months out of the calculation", () => {
  const income = { repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 10, start_month_year: "2027-06", end_month_year: "2027-01" };

  assert.equal(calculateNextDate(income, 2026, 11, { ignoreActiveWindow: true }), "2026-11-10");
  assert.equal(calculateNextDate(income, 2026, 11), null);
});

test("recurringOccurrencesInPeriod skips occurrences outside the active window", () => {
  const item = { repeat_every_months: 1, anchor_type: "day_of_month", anchor_day_of_month: 5, start_month_year: "2026-12", end_month_year: "2027-01" };
  const occurrences = period => recurringOccurrencesInPeriod(item, period, "2026-10-19");

  assert.deepEqual(occurrences({ start: "2026-11-01", end: "2026-11-30" }), []);
  assert.deepEqual(occurrences({ start: "2026-12-01", end: "2026-12-31" }), ["2026-12-05"]);
  assert.deepEqual(occurrences({ start: "2027-01-01", end: "2027-01-31" }), ["2027-01-05"]);
  assert.deepEqual(occurrences({ start: "2027-02-01", end: "2027-02-28" }), []);
});

test("a period-defining income with a future start or past end still defines today's period", async () => {
  const { buildBudgetPeriods } = await import("../../src/server/cashflow-period-utils.js");
  const income = {
    id: "salary", active: 1, period_setting: 1, repeat_every_months: 1,
    anchor_type: "day_of_month", anchor_day_of_month: 10,
    start_month_year: "2027-06", end_month_year: "2026-01"
  };
  const periods = buildBudgetPeriods({ budget_period_income_id: "salary" }, [income], "2026-10-19", 2);

  assert.equal(periods[0].start, "2026-10-10");
  assert.equal(periods[0].end, "2026-11-09");
});
