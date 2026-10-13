import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const budgetServiceSource = readFileSync(
  new URL("../../src/server/cashflow-budget-service.js", import.meta.url),
  "utf8"
);
const globalServiceSource = readFileSync(
  new URL("../../src/server/cashflow-global-service.js", import.meta.url),
  "utf8"
);

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function occurrenceCount(source, value) {
  return source.split(value).length - 1;
}

test("externally dispatched async flows retain only their top-level SQLite branch", () => {
  const purgeBudgetAsync = sourceBetween(
    budgetServiceSource,
    "  async function purgeBudgetAsync",
    "  function listMembers"
  );
  const completeAuthProviderCallback = sourceBetween(
    globalServiceSource,
    "  async function completeAuthProviderCallback(providerId",
    "  function setAdminProviderIdentity"
  );
  const authenticateInternalLogin = sourceBetween(
    globalServiceSource,
    "  async function authenticateInternalLogin(input",
    "  function registerInternalAccountWithInvitationSqlite"
  );

  // Each function dispatches to SQLite once at entry; transaction callbacks must not add dead fallbacks.
  assert.equal(occurrenceCount(purgeBudgetAsync, "purgeBudget("), 1);
  assert.equal(occurrenceCount(completeAuthProviderCallback, "completeAuthProviderCallbackSqlite("), 1);
  assert.equal(occurrenceCount(authenticateInternalLogin, "authenticateInternalLoginSqlite("), 1);
});
