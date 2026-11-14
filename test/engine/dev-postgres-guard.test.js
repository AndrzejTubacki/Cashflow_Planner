import assert from "node:assert/strict";
import test from "node:test";
import { assertDevDatabaseUrl, assertDevDatabaseIdentity } from "../../scripts/lib/dev-postgres-guard.mjs";

test("dev guard rejects other databases and connection query overrides", async () => {
  const valid = "postgres://user:password@localhost/cashflow_dev";
  assert.equal(assertDevDatabaseUrl(valid), valid);
  for (const value of ["invalid", "postgres://host/postgres", "postgres://host/cashflow",
    "postgres://host/cashflow_dev?options=-csearch_path=other", "https://host/cashflow_dev"]) {
    assert.throws(() => assertDevDatabaseUrl(value));
  }
  await assert.rejects(() => assertDevDatabaseIdentity({ query: async () => ({ rows: [{ database: "production" }] }) }));
  await assertDevDatabaseIdentity({ query: async () => ({ rows: [{ database: "cashflow_dev" }] }) });
});