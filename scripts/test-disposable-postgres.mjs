import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { assertDisposablePostgresUrl, disposablePostgresEnvironment, disposablePostgresReadinessArgs, disposablePostgresRunArgs, disposablePostgresRemoveArgs } from "./lib/disposable-postgres.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = process.argv.slice(2);
if (options.length > 1 || options.some(arg => arg !== "--standalone-transfers")) throw new Error("Unsupported disposable test option");
const standaloneTransfers = options.includes("--standalone-transfers");
const name = `cashflow-tests-${randomUUID()}`;
let owned = false;
let stopping = false;
let tests;

function command(args, { timeout = 30000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    // Docker stderr may contain daemon configuration. Report operation/status only.
    child.stderr.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", error => { clearTimeout(timer); reject(new Error(`Docker unavailable (${error.code || error.name})`)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) resolve({ code, output: output.trim() });
      else reject(new Error(`Docker ${args[0]} failed (status ${code})`));
    });
  });
}

async function cleanup() {
  if (owned) {
    const result = await command(disposablePostgresRemoveArgs(name), { allowFailure: true });
    if (result.code === 0) owned = false;
    else throw new Error(`Could not remove disposable container ${name}; remove it manually`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; tests?.kill(signal); });
}

try {
  // Use a known local image; never pull or alter existing containers/volumes.
  await command(["image", "inspect", "postgres:16-alpine"]);
  owned = true;
  await command(disposablePostgresRunArgs(name));
  let ready = false;
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    // The image's temporary initialization server accepts Unix-socket connections
    // before shutting down. Require TCP, used by the actual child test connection.
    const result = await command(disposablePostgresReadinessArgs(name), { allowFailure: true });
    if (result.code === 0) { ready = true; break; }
    await sleep(1000);
  }
  if (!ready || stopping) throw new Error("Disposable PostgreSQL did not become ready or was interrupted");
  const mapping = await command(["port", name, "5432/tcp"]);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping.output);
  if (!match) throw new Error("Refusing unexpected disposable port mapping");
  const env = disposablePostgresEnvironment(process.env, Number(match[1]));
  assertDisposablePostgresUrl(env.CASHFLOW_DATABASE_URL);
  console.log("Running serial PostgreSQL tests against an owned loopback-only disposable container.");
  const status = await new Promise((resolve, reject) => {
    const args = ["scripts/run-postgres-tests.mjs", ...(standaloneTransfers ? ["--standalone-transfers"] : [])];
    tests = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    tests.on("error", reject);
    tests.on("close", code => resolve(code ?? 1));
  });
  if (status !== 0 || stopping) throw new Error(`PostgreSQL tests failed or interrupted (status ${status})`);
  console.log("Disposable PostgreSQL suite passed.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
