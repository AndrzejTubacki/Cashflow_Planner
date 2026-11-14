/** Container controls may target only names owned by the disposable runner. */
function assertOwnedContainerName(name) {
  if (typeof name !== "string" || !/^cashflow-tests-[a-f0-9-]+$/.test(name)) throw new Error("Owned test container required");
}

/** Bound the database itself: Docker containers do not inherit the client
 * process's systemd memory scope. Equal RAM/swap limits disable container swap. */
export function disposablePostgresRunArgs(name) {
  assertOwnedContainerName(name);
  return ["run", "-d", "--rm", "--pull=never", "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "256",
    "--name", name, "--label", "cashflow.disposable=true",
    "-e", "POSTGRES_PASSWORD=disposable-only", "-e", "POSTGRES_DB=cashflow_test",
    "-p", "127.0.0.1::5432", "postgres:16-alpine"];
}

/** Wait for the final TCP server, not the temporary initialization socket. */
export function disposablePostgresReadinessArgs(name) {
  assertOwnedContainerName(name);
  return ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "cashflow_test"];
}

/** Remove the owned container together with its anonymous data volume. A forced
 * remove runs before `--rm` can clean up, so without `-v` every run leaked the
 * Postgres data volume (about 150-300 MB each). */
export function disposablePostgresRemoveArgs(name) {
  assertOwnedContainerName(name);
  return ["rm", "-f", "-v", name];
}

export function assertDisposablePostgresUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Disposable PostgreSQL URL required"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1"
    || url.pathname !== "/cashflow_test" || !url.port || [...url.searchParams.keys()].some(key => key !== "application_name") || url.hash
    || url.username !== "postgres" || url.password !== "disposable-only") {
    throw new Error("Destructive tests require the owned loopback-only cashflow_test database; use test:postgres:disposable");
  }
  return value;
}

export function disposablePostgresEnvironment(env, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid disposable PostgreSQL port");
  const url = `postgres://postgres:disposable-only@127.0.0.1:${port}/cashflow_test`;
  return {
    ...env,
    CASHFLOW_ENABLE_POSTGRES_TESTS: "1",
    CASHFLOW_DATABASE_URL: url,
    CASHFLOW_RUNTIME_LOCK_DATABASE_URL: url,
    CASHFLOW_RUNTIME_LOCK_BACKEND: "none",
    PGDATABASE: "cashflow_test",
    PGHOST: "127.0.0.1",
    PGPORT: String(port),
    PGUSER: "postgres",
    PGPASSWORD: "disposable-only",
    PGOPTIONS: ""
  };
}
