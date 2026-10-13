import assert from "node:assert/strict";
import test from "node:test";

import { invitationExpiryMs } from "../../src/server/cashflow-budget-service.js";
import { databaseTimestampMs } from "../../src/server/cashflow-global-service.js";

function withWarsawTimezone(fn) {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "Europe/Warsaw";
  try {
    fn();
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
}

test("budget invitation expiry preserves a Postgres Date instant outside UTC", () => {
  withWarsawTimezone(() => {
    const instant = new Date("2024-01-15T13:34:56.000Z");
    assert.equal(invitationExpiryMs(instant), instant.getTime());
  });
});

test("global invitation checks preserve a Postgres Date instant outside UTC", () => {
  withWarsawTimezone(() => {
    const instant = new Date("2024-01-15T13:34:56.000Z");
    assert.equal(databaseTimestampMs(instant), instant.getTime());
  });
});

test("invitation timestamp helpers retain SQLite UTC-string parsing", () => {
  const expected = Date.parse("2024-01-15T13:34:56.000Z");
  assert.equal(invitationExpiryMs("2024-01-15 13:34:56.000"), expected);
  assert.equal(databaseTimestampMs("2024-01-15 13:34:56.000"), expected);
});
