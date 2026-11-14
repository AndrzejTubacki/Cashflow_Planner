import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { disposablePostgresEnvironment, assertDisposablePostgresUrl, disposablePostgresReadinessArgs, disposablePostgresRemoveArgs, disposablePostgresRunArgs } from "../../scripts/lib/disposable-postgres.mjs";
import { requirePostgresRuntimeTestConfig } from "../helpers/postgres-test-db.js";

test("contributor PostgreSQL configuration accepts an explicitly opted-in disposable database", () => {
  const databaseUrl = "postgres://contributor:password@db.example.com:5432/contributor_test";
  assert.deepEqual(requirePostgresRuntimeTestConfig({ CASHFLOW_ENABLE_POSTGRES_TESTS: "1",
    CASHFLOW_DATABASE_URL: databaseUrl }), { databaseUrl });
  for (const env of [{}, { CASHFLOW_DATABASE_URL: databaseUrl },
    { CASHFLOW_ENABLE_POSTGRES_TESTS: "0", CASHFLOW_DATABASE_URL: databaseUrl },
    { CASHFLOW_ENABLE_POSTGRES_TESTS: "1", CASHFLOW_DATABASE_URL: " " }]) {
    assert.throws(() => requirePostgresRuntimeTestConfig(env));
  }
  assert.throws(() => assertDisposablePostgresUrl(databaseUrl));
});

test("the owned database container is bounded independently of the Docker client", () => {
  const name = "cashflow-tests-11111111-1111-4111-8111-111111111111";
  const args = disposablePostgresRunArgs(name);
  const value = flag => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "run");
  assert.equal(value("--memory"), "1g");
  assert.equal(value("--memory-swap"), value("--memory"), "container swap must stay disabled");
  assert.equal(value("--cpus"), "1");
  assert.equal(value("--pids-limit"), "256");
  assert.equal(value("--name"), name);
  assert.equal(value("--label"), "cashflow.disposable=true");
  assert.ok(args.includes("POSTGRES_PASSWORD=disposable-only") && args.includes("POSTGRES_DB=cashflow_test"));
  assert.equal(value("-p"), "127.0.0.1::5432");
  assert.ok(args.includes("--pull=never") && args.includes("--rm"));
  for (const other of ["shared-postgres", "", null, "cashflow-tests-;invalid"]) {
    assert.throws(() => disposablePostgresRunArgs(other));
  }
});

test("readiness waits for final TCP server rather than temporary initialization socket", () => {
  const name = "cashflow-tests-11111111-1111-4111-8111-111111111111";
  assert.deepEqual(disposablePostgresReadinessArgs(name), ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "cashflow_test"]);
  for (const value of ["shared-postgres", "", null, "cashflow-tests-;invalid"]) {
    assert.throws(() => disposablePostgresReadinessArgs(value));
  }
});

test("disposable PostgreSQL runner cannot inherit deployment database or lock targets", () => {
  const env = disposablePostgresEnvironment({ CASHFLOW_DATABASE_URL: "postgres://shared/production",
    CASHFLOW_RUNTIME_LOCK_DATABASE_URL: "postgres://shared/other", CASHFLOW_RUNTIME_LOCK_BACKEND: "postgres",
    PGHOST: "shared", PGPORT: "5432", PGDATABASE: "production", PGOPTIONS: "-c search_path=unsafe" }, 45678);
  const url = new URL(env.CASHFLOW_DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "45678");
  assert.equal(url.pathname, "/cashflow_test");
  assert.equal(env.CASHFLOW_RUNTIME_LOCK_DATABASE_URL, env.CASHFLOW_DATABASE_URL);
  assert.equal(env.CASHFLOW_RUNTIME_LOCK_BACKEND, "none");
  assert.equal(env.CASHFLOW_ENABLE_POSTGRES_TESTS, "1");
  assert.equal(env.PGHOST, "127.0.0.1");
  assert.equal(env.PGOPTIONS, "");
  for (const port of [0, -1, 65536, 1.5, "5432"]) assert.throws(() => disposablePostgresEnvironment({}, port));
});

test("destructive test guard refuses shared dev and arbitrary local databases before connection", () => {
  const safe = disposablePostgresEnvironment({}, 35432).CASHFLOW_DATABASE_URL;
  assert.equal(assertDisposablePostgresUrl(safe), safe);
  for (const url of ["postgres://dev:password@shared.example/cashflow_dev",
    "postgres://postgres:disposable-only@127.0.0.1:5432/cashflow_dev",
    "postgres://postgres:disposable-only@localhost:5432/cashflow_test",
    `${safe}?options=-csearch_path=public`, "invalid"]) {
    assert.throws(() => assertDisposablePostgresUrl(url));
  }
});

/** A focused fixture mode retains the same closed option set: callers cannot
 * combine modes or inject another file/command before Docker is ever invoked. */
test('targeted disposable selection refuses mixed modes and arbitrary test paths before any container work', async () => {
  for (const args of [['--standalone-transfers', '--device-contract'], ['--standalone-transfers', '--test-file', '/other/test.js']]) {
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/test-disposable-postgres.mjs', ...args]),
      error => /Unsupported disposable test option/.test(error.stderr));
  }
  await assert.rejects(promisify(execFile)(process.execPath, ['scripts/run-postgres-tests.mjs', '--test-file'],
    { env: { ...process.env, CASHFLOW_ENABLE_POSTGRES_TESTS: '0' } }),
  error => /Unsupported PostgreSQL test selection/.test(error.stderr));
});

test("cleanup removes the owned container together with its anonymous data volume", () => {
  const name = "cashflow-tests-11111111-1111-4111-8111-111111111111";
  // Without -v a forced remove leaves the Postgres data volume behind on every run.
  assert.deepEqual(disposablePostgresRemoveArgs(name), ["rm", "-f", "-v", name]);
  for (const value of ["shared-postgres", "", null, "cashflow-tests-;invalid"]) {
    assert.throws(() => disposablePostgresRemoveArgs(value));
  }
});
